import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function numberValue(value) {
  return Number(value || 0);
}

function boolValue(value) {
  return Number(value || 0) === 1;
}

async function first(env, sql, bindings = []) {
  return await env.RELAYHUB_DB.prepare(sql)
    .bind(...bindings)
    .first();
}

async function getLicence(env, licenceIdOrNumber) {
  const ref = cleanText(licenceIdOrNumber);

  if (!ref) return null;

  return await first(
    env,
    `SELECT *
     FROM document_licences
     WHERE id = ? OR licence_number = ?
     LIMIT 1`,
    [ref, ref],
  );
}

async function getDocument(env, documentId, version) {
  if (!documentId || !version) return null;

  return await first(
    env,
    `SELECT *
     FROM documents
     WHERE id = ?
       AND version = ?
     LIMIT 1`,
    [documentId, version],
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

async function getDownloadLinkCounts(env, licenceId) {
  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END) AS created_count,
       SUM(CASE WHEN status = 'pending_generation' THEN 1 ELSE 0 END) AS pending_generation_count,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
       SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used_count,
       SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked_count,
       SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded_count,
       SUM(CASE
         WHEN status IN ('created', 'pending_generation', 'active')
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND superseded_at IS NULL
         THEN 1 ELSE 0
       END) AS conflicting_open_count
     FROM document_download_links
     WHERE licence_id = ?`,
  )
    .bind(licenceId)
    .first();

  return {
    total: numberValue(rows?.total),
    created: numberValue(rows?.created_count),
    pending_generation: numberValue(rows?.pending_generation_count),
    active: numberValue(rows?.active_count),
    used: numberValue(rows?.used_count),
    revoked: numberValue(rows?.revoked_count),
    superseded: numberValue(rows?.superseded_count),
    conflicting_open: numberValue(rows?.conflicting_open_count),
  };
}

async function getGeneratedPdfObjectHead(env, objectKey) {
  const key = cleanText(objectKey).replace(/^\/+/, "");

  if (!key) return null;

  try {
    return await env.RELAYHUB_DOWNLOADS.head(key);
  } catch {
    return null;
  }
}

function evaluateGate({ licence, document, releasePolicy, downloadLinkCounts, generatedObjectHead }) {
  const blockers = [];
  const warnings = [];

  if (!licence) {
    blockers.push("licence_not_found");
    return { blockers, warnings };
  }

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

  if (!licence.licence_number) {
    blockers.push("licence_number_missing");
  }

  if (!licence.document_id) {
    blockers.push("licence_missing_document_id");
  }

  if (!licence.document_version) {
    blockers.push("licence_missing_document_version");
  }

  if (!licence.licence_holder_email_normalised && !licence.licence_holder_email) {
    blockers.push("licence_holder_email_missing");
  }

  if (!licence.licence_terms_version) {
    blockers.push("licence_terms_version_missing");
  }

  if (licence.generated_pdf_status !== "generated") {
    blockers.push(`generated_pdf_status_${licence.generated_pdf_status || "missing"}`);
  }

  if (licence.generated_pdf_error) {
    blockers.push("generated_pdf_error_present");
  }

  if (!licence.generated_pdf_object_key) {
    blockers.push("generated_pdf_object_key_missing");
  }

  if (!licence.generated_pdf_filename) {
    blockers.push("generated_pdf_filename_missing");
  }

  if (!licence.generated_pdf_sha256) {
    blockers.push("generated_pdf_sha256_missing");
  }

  if (!licence.generated_pdf_size_bytes || Number(licence.generated_pdf_size_bytes) <= 0) {
    blockers.push("generated_pdf_size_missing");
  }

  if (licence.generated_pdf_content_type !== "application/pdf") {
    blockers.push(`generated_pdf_content_type_${licence.generated_pdf_content_type || "missing"}`);
  }

  if (!licence.generated_pdf_created_at) {
    blockers.push("generated_pdf_created_at_missing");
  }

  if (licence.generated_pdf_object_key && !generatedObjectHead) {
    blockers.push("generated_pdf_r2_object_missing");
  }

  if (
    generatedObjectHead &&
    licence.generated_pdf_size_bytes &&
    Number(generatedObjectHead.size || 0) !== Number(licence.generated_pdf_size_bytes)
  ) {
    blockers.push("generated_pdf_r2_size_mismatch");
  }

  if (!document) {
    blockers.push("document_not_found_for_licence_version");
  } else {
    if (document.status !== "active") {
      blockers.push(`document_status_${document.status || "missing"}`);
    }

    if (document.id !== licence.document_id) {
      blockers.push("document_id_mismatch");
    }

    if (document.version !== licence.document_version) {
      blockers.push("document_version_mismatch");
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

    if (!boolValue(releasePolicy.personalised_pdf_required)) {
      warnings.push("policy_does_not_require_personalised_pdf");
    }

    if (!boolValue(releasePolicy.download_id_required)) {
      blockers.push("policy_does_not_require_download_id");
    }

    if (!boolValue(releasePolicy.single_use_link_required)) {
      blockers.push("policy_does_not_require_single_use_link");
    }

    if (!boolValue(releasePolicy.evidence_bundle_required)) {
      warnings.push("policy_does_not_require_evidence_bundle");
    }
  }

  if (downloadLinkCounts.conflicting_open > 0) {
    blockers.push("open_download_link_already_exists_for_licence");
  }

  if (downloadLinkCounts.used > 0) {
    warnings.push("used_download_link_exists_for_licence");
  }

  if (downloadLinkCounts.revoked > 0) {
    warnings.push("revoked_download_link_exists_for_licence");
  }

  if (downloadLinkCounts.superseded > 0) {
    warnings.push("superseded_download_link_exists_for_licence");
  }

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
  };
}

export async function evaluateCdasGeneratedPdfToDownloadLinkEligibility(
  env,
  licenceIdOrNumber,
) {
  const ref = cleanText(licenceIdOrNumber);
  const licence = await getLicence(env, ref);

  if (!licence) {
    return {
      ok: false,
      eligible: false,
      decision: "blocked",
      licence_id: ref,
      blockers: ["licence_not_found"],
      warnings: [],
      counts: {
        download_links_total: 0,
        conflicting_open_download_links: 0,
      },
      licence: null,
      document: null,
      release_policy: null,
      generated_pdf_object: null,
      next_allowed_action: null,
      safety: {
        download_link_created: false,
        download_link_activated: false,
        email_sent: false,
        pdf_served: false,
      },
    };
  }

  const [document, releasePolicy, downloadLinkCounts, generatedObjectHead] =
    await Promise.all([
      getDocument(env, licence.document_id, licence.document_version),
      getReleasePolicy(env, licence.document_id, licence.document_version),
      getDownloadLinkCounts(env, licence.id),
      getGeneratedPdfObjectHead(env, licence.generated_pdf_object_key),
    ]);

  const gate = evaluateGate({
    licence,
    document,
    releasePolicy,
    downloadLinkCounts,
    generatedObjectHead,
  });

  const eligible = gate.blockers.length === 0;

  return {
    ok: true,
    eligible,
    decision: eligible ? "eligible_for_download_link_creation" : "blocked",
    licence_id: licence.id,
    licence_number: licence.licence_number,
    blockers: gate.blockers,
    warnings: gate.warnings,
    counts: {
      download_links_total: downloadLinkCounts.total,
      download_links_created: downloadLinkCounts.created,
      download_links_pending_generation: downloadLinkCounts.pending_generation,
      download_links_active: downloadLinkCounts.active,
      download_links_used: downloadLinkCounts.used,
      download_links_revoked: downloadLinkCounts.revoked,
      download_links_superseded: downloadLinkCounts.superseded,
      conflicting_open_download_links: downloadLinkCounts.conflicting_open,
    },
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      status: licence.status,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
      generated_pdf_status: licence.generated_pdf_status,
      generated_pdf_object_key: licence.generated_pdf_object_key,
      generated_pdf_filename: licence.generated_pdf_filename,
      generated_pdf_sha256: licence.generated_pdf_sha256,
      generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
      generated_pdf_content_type: licence.generated_pdf_content_type,
      generated_pdf_created_at: licence.generated_pdf_created_at,
      generated_pdf_error: licence.generated_pdf_error,
    },
    document: document
      ? {
          id: document.id,
          slug: document.slug,
          title: document.title,
          version: document.version,
          status: document.status,
          classification: document.classification,
          access_class: document.access_class,
        }
      : null,
    release_policy: releasePolicy
      ? {
          id: releasePolicy.id,
          release_class: releasePolicy.release_class,
          policy_status: releasePolicy.policy_status,
          release_state: releasePolicy.release_state,
          licence_terms_status: releasePolicy.licence_terms_status,
          personalised_pdf_required: boolValue(releasePolicy.personalised_pdf_required),
          download_id_required: boolValue(releasePolicy.download_id_required),
          single_use_link_required: boolValue(releasePolicy.single_use_link_required),
          evidence_bundle_required: boolValue(releasePolicy.evidence_bundle_required),
        }
      : null,
    generated_pdf_object: generatedObjectHead
      ? {
          exists: true,
          size: generatedObjectHead.size || null,
          uploaded: generatedObjectHead.uploaded || null,
          http_etag: generatedObjectHead.httpEtag || null,
        }
      : {
          exists: false,
        },
    next_allowed_action: eligible ? "create_controlled_download_link" : null,
    safety: {
      download_link_created: false,
      download_link_activated: false,
      email_sent: false,
      pdf_served: false,
    },
  };
}

export async function getCdasGeneratedPdfToDownloadLinkEligibility(
  request,
  env,
  licenceIdOrNumber,
) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to evaluate generated-PDF-to-download-link eligibility.",
      },
      405,
    );
  }

  const result = await evaluateCdasGeneratedPdfToDownloadLinkEligibility(
    env,
    licenceIdOrNumber,
  );

  if (!result.licence) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
        licence_id: cleanText(licenceIdOrNumber),
      },
      404,
    );
  }

  return jsonResponse(result);
}
