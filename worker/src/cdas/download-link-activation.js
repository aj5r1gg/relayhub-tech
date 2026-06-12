import { getClientIp, jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromText(text) {
  const encoded = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

function buildId(prefix) {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  const suffix = [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now().toString(36)}_${suffix}`;
}

async function first(env, sql, bindings = []) {
  return await env.RELAYHUB_DB.prepare(sql)
    .bind(...bindings)
    .first();
}

async function readOptionalJson(request) {
  const contentType = cleanText(request.headers.get("Content-Type")).toLowerCase();

  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function getUserAgent(request) {
  return cleanText(request.headers.get("User-Agent")).slice(0, 500);
}

async function getDownloadLink(env, downloadLinkIdOrReference) {
  const ref = cleanText(downloadLinkIdOrReference);

  if (!ref) return null;

  return await first(
    env,
    `SELECT *
     FROM document_download_links
     WHERE id = ?
        OR download_reference = ?
     LIMIT 1`,
    [ref, ref],
  );
}

async function getLicence(env, licenceId) {
  const id = cleanText(licenceId);

  if (!id) return null;

  return await first(
    env,
    `SELECT *
     FROM document_licences
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

async function getReleasePolicy(env, documentId, version) {
  if (!documentId || !version) return null;

  return await first(
    env,
    `SELECT *
     FROM document_release_policies
     WHERE document_id = ?
       AND document_version = ?
     ORDER BY
       CASE policy_status
         WHEN 'active' THEN 0
         WHEN 'approved' THEN 1
         WHEN 'pending_review' THEN 2
         WHEN 'draft' THEN 3
         ELSE 4
       END,
       updated_at DESC
     LIMIT 1`,
    [documentId, version],
  );
}

async function getGeneratedPdfHead(env, objectKey) {
  const key = cleanText(objectKey).replace(/^\/+/, "");

  if (!key) return null;

  try {
    return await env.RELAYHUB_DOWNLOADS.head(key);
  } catch {
    return null;
  }
}

function isExpired(expiresAt) {
  const text = cleanText(expiresAt);

  if (!text) return true;

  const time = Date.parse(text);

  if (!Number.isFinite(time)) return true;

  return time <= Date.now();
}

function boolValue(value) {
  return Number(value || 0) === 1;
}

function evaluateActivationGate({ link, licence, releasePolicy, generatedPdfHead }) {
  const blockers = [];
  const warnings = [];

  if (!link) {
    blockers.push("download_link_not_found");
    return { blockers, warnings };
  }

  if (link.status !== "pending_activation") {
    blockers.push(`download_link_status_${link.status || "missing"}`);
  }

  if (!link.id) {
    blockers.push("download_link_id_missing");
  }

  if (!link.licence_id) {
    blockers.push("download_link_missing_licence_id");
  }

  if (!link.document_id) {
    blockers.push("download_link_missing_document_id");
  }

  if (!link.token_hash) {
    blockers.push("download_link_token_hash_missing");
  }

  if (!link.download_reference) {
    blockers.push("download_reference_missing");
  }

  if (!link.created_at) {
    blockers.push("download_link_created_at_missing");
  }

  if (!link.expires_at) {
    blockers.push("download_link_expires_at_missing");
  } else if (isExpired(link.expires_at)) {
    blockers.push("download_link_expired");
  }

  if (link.activated_at) {
    blockers.push("download_link_already_activated");
  }

  if (link.used_at) {
    blockers.push("download_link_already_used");
  }

  if (link.revoked_at) {
    blockers.push("download_link_revoked");
  }

  if (link.superseded_at) {
    blockers.push("download_link_superseded");
  }

  if (!link.generated_pdf_object_key) {
    blockers.push("download_link_missing_generated_pdf_object_key");
  }

  if (!link.generated_pdf_sha256) {
    blockers.push("download_link_missing_generated_pdf_sha256");
  }

  if (!link.generated_pdf_size_bytes || Number(link.generated_pdf_size_bytes) <= 0) {
    blockers.push("download_link_missing_generated_pdf_size");
  }

  if (!link.generated_pdf_created_at) {
    blockers.push("download_link_missing_generated_pdf_created_at");
  }

  if (!licence) {
    blockers.push("licence_not_found_for_download_link");
  } else {
    if (licence.status !== "issued") {
      blockers.push(`licence_status_${licence.status || "missing"}`);
    }

    if (licence.revoked_at || licence.revoked_by || licence.status === "revoked") {
      blockers.push("licence_revoked");
    }

    if (licence.superseded_by) {
      blockers.push("licence_superseded");
    }

    if (licence.confirmed_leak_at) {
      blockers.push("confirmed_leak_recorded");
    }

    if (licence.suspected_leak_at) {
      warnings.push("suspected_leak_recorded");
    }

    if (licence.document_id !== link.document_id) {
      blockers.push("download_link_document_id_mismatch");
    }

    if (licence.generated_pdf_status !== "generated") {
      blockers.push(`licence_generated_pdf_status_${licence.generated_pdf_status || "missing"}`);
    }

    if (licence.generated_pdf_error) {
      blockers.push("licence_generated_pdf_error_present");
    }

    if (!licence.generated_pdf_object_key) {
      blockers.push("licence_missing_generated_pdf_object_key");
    }

    if (!licence.generated_pdf_sha256) {
      blockers.push("licence_missing_generated_pdf_sha256");
    }

    if (!licence.generated_pdf_size_bytes || Number(licence.generated_pdf_size_bytes) <= 0) {
      blockers.push("licence_missing_generated_pdf_size");
    }

    if (!licence.generated_pdf_created_at) {
      blockers.push("licence_missing_generated_pdf_created_at");
    }

    if (licence.generated_pdf_object_key !== link.generated_pdf_object_key) {
      blockers.push("generated_pdf_object_key_mismatch");
    }

    if (licence.generated_pdf_sha256 !== link.generated_pdf_sha256) {
      blockers.push("generated_pdf_sha256_mismatch");
    }

    if (
      Number(licence.generated_pdf_size_bytes || 0) !==
      Number(link.generated_pdf_size_bytes || 0)
    ) {
      blockers.push("generated_pdf_size_mismatch");
    }

    if (licence.generated_pdf_created_at !== link.generated_pdf_created_at) {
      warnings.push("generated_pdf_created_at_differs_between_link_and_licence");
    }
  }

  if (!releasePolicy) {
    blockers.push("release_policy_missing");
  } else {
    if (releasePolicy.policy_status !== "active") {
      blockers.push(`release_policy_status_${releasePolicy.policy_status || "missing"}`);
    }

    if (releasePolicy.licence_terms_status !== "active") {
      blockers.push(`licence_terms_status_${releasePolicy.licence_terms_status || "missing"}`);
    }

    if (!boolValue(releasePolicy.download_id_required)) {
      blockers.push("policy_does_not_require_download_id");
    }

    if (!boolValue(releasePolicy.single_use_link_required)) {
      blockers.push("policy_does_not_require_single_use_link");
    }
  }

  if (link.generated_pdf_object_key && !generatedPdfHead) {
    blockers.push("generated_pdf_r2_object_missing");
  }

  if (
    generatedPdfHead &&
    link.generated_pdf_size_bytes &&
    Number(generatedPdfHead.size || 0) !== Number(link.generated_pdf_size_bytes)
  ) {
    blockers.push("generated_pdf_r2_size_mismatch");
  }

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
  };
}

async function recordDownloadEvent({
  env,
  request,
  link,
  licence,
  eventType,
  success = 1,
  failureReason = null,
}) {
  try {
    const ip = getClientIp(request);
    const ipHash = ip ? await sha256HexFromText(ip) : null;

    await env.RELAYHUB_DB.prepare(
      `INSERT INTO document_download_events (
         id,
         download_id,
         licence_id,
         licence_number,
         document_id,
         document_version,
         licence_holder_name,
         organisation_name,
         licence_holder_email,
         event_type,
         event_at,
         ip_hash,
         user_agent,
         generated_object,
         source_object,
         source_sha256,
         generated_sha256,
         template_sha256,
         licence_page_template_version,
         watermark_template_version,
         footer_template_version,
         terms_template_version,
         generation_engine_version,
         terms_version,
         success,
         failure_reason
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        buildId("dde"),
        link?.id || null,
        licence?.id || link?.licence_id || null,
        licence?.licence_number || null,
        licence?.document_id || link?.document_id || null,
        licence?.document_version || null,
        licence?.licence_holder_name || null,
        licence?.organisation_name || null,
        licence?.licence_holder_email_normalised || licence?.licence_holder_email || null,
        eventType,
        nowIso(),
        ipHash,
        getUserAgent(request),
        link?.generated_pdf_object_key || licence?.generated_pdf_object_key || null,
        licence?.source_object || null,
        licence?.source_sha256 || null,
        link?.generated_pdf_sha256 || licence?.generated_pdf_sha256 || null,
        licence?.rendered_licence_sha256 || null,
        null,
        null,
        null,
        licence?.licence_terms_version || null,
        null,
        licence?.licence_terms_version || null,
        success ? 1 : 0,
        failureReason ? cleanText(failureReason).slice(0, 1000) : null
      )
      .run();
  } catch {
    // Event logging must not make activation unrecoverable.
  }
}

export async function evaluateCdasDownloadLinkActivationEligibility(
  env,
  downloadLinkIdOrReference,
) {
  const ref = cleanText(downloadLinkIdOrReference);
  const link = await getDownloadLink(env, ref);

  if (!link) {
    return {
      ok: false,
      eligible: false,
      decision: "blocked",
      download_link_id: ref,
      blockers: ["download_link_not_found"],
      warnings: [],
      download_link: null,
      licence: null,
      release_policy: null,
      generated_pdf_object: null,
      next_allowed_action: null,
      safety: {
        download_link_activated: false,
        email_sent: false,
        pdf_served: false,
      },
    };
  }

  const licence = await getLicence(env, link.licence_id);
  const releasePolicy = licence
    ? await getReleasePolicy(env, licence.document_id, licence.document_version)
    : null;
  const generatedPdfHead = await getGeneratedPdfHead(env, link.generated_pdf_object_key);

  const gate = evaluateActivationGate({
    link,
    licence,
    releasePolicy,
    generatedPdfHead,
  });

  const eligible = gate.blockers.length === 0;

  return {
    ok: true,
    eligible,
    decision: eligible ? "eligible_for_download_link_activation" : "blocked",
    download_link_id: link.id,
    download_reference: link.download_reference,
    blockers: gate.blockers,
    warnings: gate.warnings,
    download_link: {
      id: link.id,
      licence_id: link.licence_id,
      document_id: link.document_id,
      status: link.status,
      created_at: link.created_at,
      expires_at: link.expires_at,
      used_at: link.used_at,
      revoked_at: link.revoked_at,
      superseded_at: link.superseded_at,
      activated_at: link.activated_at,
      download_reference: link.download_reference,
      generated_pdf_object_key: link.generated_pdf_object_key,
      generated_pdf_sha256: link.generated_pdf_sha256,
      generated_pdf_size_bytes: link.generated_pdf_size_bytes,
      generated_pdf_created_at: link.generated_pdf_created_at,
    },
    licence: licence
      ? {
          id: licence.id,
          licence_number: licence.licence_number,
          status: licence.status,
          document_id: licence.document_id,
          document_version: licence.document_version,
          licence_holder_name: licence.licence_holder_name || null,
          organisation_name: licence.organisation_name || null,
          licence_holder_email:
            licence.licence_holder_email_normalised || licence.licence_holder_email,
          licence_holder_email_normalised:
            licence.licence_holder_email_normalised || licence.licence_holder_email,
          licence_terms_version: licence.licence_terms_version,
          source_object: licence.source_object || null,
          source_sha256: licence.source_sha256 || null,
          rendered_licence_sha256: licence.rendered_licence_sha256 || null,
          generated_pdf_status: licence.generated_pdf_status,
          generated_pdf_object_key: licence.generated_pdf_object_key,
          generated_pdf_sha256: licence.generated_pdf_sha256,
          generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
          generated_pdf_created_at: licence.generated_pdf_created_at,
        }
      : null,
    release_policy: releasePolicy
      ? {
          id: releasePolicy.id,
          policy_status: releasePolicy.policy_status,
          release_state: releasePolicy.release_state,
          licence_terms_status: releasePolicy.licence_terms_status,
          download_id_required: boolValue(releasePolicy.download_id_required),
          single_use_link_required: boolValue(releasePolicy.single_use_link_required),
        }
      : null,
    generated_pdf_object: generatedPdfHead
      ? {
          exists: true,
          size: generatedPdfHead.size || null,
          uploaded: generatedPdfHead.uploaded || null,
          http_etag: generatedPdfHead.httpEtag || null,
        }
      : {
          exists: false,
        },
    next_allowed_action: eligible ? "activate_controlled_download_link" : null,
    safety: {
      download_link_activated: false,
      email_sent: false,
      pdf_served: false,
    },
  };
}

export async function getCdasDownloadLinkActivationEligibility(
  request,
  env,
  downloadLinkIdOrReference,
) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to evaluate download-link activation eligibility.",
      },
      405,
    );
  }

  const result = await evaluateCdasDownloadLinkActivationEligibility(
    env,
    downloadLinkIdOrReference,
  );

  if (!result.download_link) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS download link was not found.",
        download_link_id: cleanText(downloadLinkIdOrReference),
      },
      404,
    );
  }

  return jsonResponse(result);
}

export async function activateCdasDownloadLink(request, env, downloadLinkIdOrReference) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to activate a controlled CDAS download link.",
      },
      405,
    );
  }

  const body = await readOptionalJson(request);

  const eligibility = await evaluateCdasDownloadLinkActivationEligibility(
    env,
    downloadLinkIdOrReference,
  );

  if (!eligibility.download_link) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS download link was not found.",
      },
      404,
    );
  }

  if (!eligibility.eligible) {
    await recordDownloadEvent({
      env,
      request,
      link: eligibility.download_link,
      licence: eligibility.licence,
      eventType: "download_link_activation_blocked",
      success: 0,
      failureReason: eligibility.blockers.join(","),
    });

    return jsonResponse(
      {
        ok: false,
        error: "download_link_activation_blocked",
        message:
          "Controlled download link was not activated because the activation gate did not pass.",
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        download_link: eligibility.download_link,
        safety: {
          download_link_activated: false,
          email_sent: false,
          pdf_served: false,
        },
      },
      409,
    );
  }

  const activatedAt = nowIso();

  const result = await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       status = 'active',
       activated_at = ?
     WHERE id = ?
       AND status = 'pending_activation'
       AND activated_at IS NULL
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL`
  )
    .bind(activatedAt, eligibility.download_link.id)
    .run();

  const changed = Number(result?.meta?.changes || result?.changes || 0);

  if (changed !== 1) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_activation_race_or_state_change",
        message:
          "The download link was not activated because its state changed during activation.",
        safety: {
          download_link_activated: false,
          email_sent: false,
          pdf_served: false,
        },
      },
      409,
    );
  }

  await recordDownloadEvent({
    env,
    request,
    link: eligibility.download_link,
    licence: eligibility.licence,
    eventType: "download_link_activated",
    success: 1,
    failureReason: cleanText(body.note || "3X-0O controlled activation"),
  });

  return jsonResponse({
    ok: true,
    activated: true,
    emailed: false,
    served: false,
    action: "activate_controlled_download_link",
    download_link: {
      id: eligibility.download_link.id,
      download_reference: eligibility.download_link.download_reference,
      status: "active",
      previous_status: eligibility.download_link.status,
      created_at: eligibility.download_link.created_at,
      expires_at: eligibility.download_link.expires_at,
      activated_at: activatedAt,
      generated_pdf_object_key: eligibility.download_link.generated_pdf_object_key,
      generated_pdf_sha256: eligibility.download_link.generated_pdf_sha256,
      generated_pdf_size_bytes: eligibility.download_link.generated_pdf_size_bytes,
      generated_pdf_created_at: eligibility.download_link.generated_pdf_created_at,
    },
    licence: eligibility.licence,
    warnings: eligibility.warnings,
    controls: {
      evaluates_activation_gate: true,
      activates_existing_download_link_record: true,
      creates_download_link: false,
      changes_status_to_active: true,
      sets_activated_at: true,
      copies_generated_pdf_evidence: false,
      writes_to_r2: false,
      sends_email: false,
      serves_pdf: false,
      exposes_raw_token: false,
    },
    next_step: {
      action: "email_or_manual_share_active_link",
      phase: "3X-0P",
      note:
        "The link is now active but has not been emailed by this action. Treat the raw token from creation as sensitive because it is only shown once.",
    },
    safety: {
      download_link_created: false,
      download_link_activated: true,
      email_sent: false,
      pdf_served: false,
    },
    message:
      "Controlled download link was activated. No email was sent and no PDF was served by this action.",
  });
}
