import { getClientIp, jsonResponse } from "../shared.js";

const REVOCABLE_LINK_STATUSES = new Set([
  "created",
  "pending_generation",
  "pending_activation",
  "sent",
  "active",
]);

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
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  const random = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function getUserAgent(request) {
  return cleanText(request.headers.get("User-Agent")).slice(0, 500);
}

async function readJsonBody(request) {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return {};
  }

  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function getDb(env) {
  return env.RELAYHUB_DB || env.DB || env.DATABASE || null;
}

async function getDownloadLinkForRevocation(env, downloadId) {
  const db = getDb(env);

  if (!db) {
    throw new Error("D1 database binding was not found.");
  }

  return await db
    .prepare(
      `SELECT
         dl.id AS download_id,
         dl.licence_id AS link_licence_id,
         dl.document_id AS link_document_id,
         dl.token_hash AS token_hash,
         dl.status AS link_status,
         dl.created_at AS link_created_at,
         dl.expires_at AS link_expires_at,
         dl.used_at AS link_used_at,
         dl.revoked_at AS link_revoked_at,
         dl.superseded_at AS link_superseded_at,
         dl.failure_reason AS link_failure_reason,
         dl.download_reference AS download_reference,
         dl.activated_at AS link_activated_at,
         dl.generated_pdf_object_key AS link_generated_pdf_object_key,
         dl.generated_pdf_sha256 AS link_generated_pdf_sha256,
         dl.generated_pdf_size_bytes AS link_generated_pdf_size_bytes,
         dl.generated_pdf_created_at AS link_generated_pdf_created_at,

         lic.id AS licence_id,
         lic.licence_number AS licence_number,
         lic.request_id AS request_id,
         lic.document_id AS document_id,
         lic.document_version AS document_version,
         lic.licence_terms_version AS licence_terms_version,
         lic.status AS licence_status,

         lic.licence_holder_name AS licence_holder_name,
         lic.organisation_name AS organisation_name,
         lic.licence_holder_email AS licence_holder_email,
         lic.licence_holder_email_normalised AS licence_holder_email_normalised,

         lic.source_object AS source_object,
         lic.source_sha256 AS source_sha256,
         lic.rendered_licence_sha256 AS rendered_licence_sha256,
         lic.rendered_terms_body_sha256 AS rendered_terms_body_sha256,

         lic.generated_pdf_status AS licence_generated_pdf_status,
         lic.generated_pdf_object_key AS licence_generated_pdf_object_key,
         lic.generated_pdf_filename AS generated_pdf_filename,
         lic.generated_pdf_sha256 AS licence_generated_pdf_sha256,
         lic.generated_pdf_size_bytes AS licence_generated_pdf_size_bytes,
         lic.generated_pdf_content_type AS generated_pdf_content_type,
         lic.generated_pdf_created_at AS licence_generated_pdf_created_at
       FROM document_download_links dl
       LEFT JOIN document_licences lic
         ON lic.id = dl.licence_id
       WHERE dl.id = ?
       LIMIT 1`,
    )
    .bind(downloadId)
    .first();
}

function buildRevocationEligibility(record) {
  const blockers = [];
  const warnings = [];

  if (!record) {
    return {
      eligible: false,
      decision: "blocked",
      blockers: ["download_link_not_found"],
      warnings,
    };
  }

  const linkStatus = cleanText(record.link_status).toLowerCase();

  if (!record.licence_id) {
    blockers.push("missing_related_licence");
  }

  if (!record.licence_number) {
    blockers.push("missing_licence_number");
  }

  if (!record.licence_terms_version) {
    blockers.push("missing_licence_terms_version");
  }

  if (record.link_used_at || linkStatus === "used") {
    blockers.push("download_link_already_used");
  }

  if (record.link_revoked_at || linkStatus === "revoked") {
    blockers.push("download_link_already_revoked");
  }

  if (record.link_superseded_at || linkStatus === "superseded") {
    blockers.push("download_link_already_superseded");
  }

  if (!REVOCABLE_LINK_STATUSES.has(linkStatus)) {
    blockers.push(`download_link_status_${linkStatus || "unknown"}_not_revocable`);
  }

  const generatedPdfObject =
    record.link_generated_pdf_object_key ||
    record.licence_generated_pdf_object_key ||
    "";

  const generatedPdfSha256 =
    record.link_generated_pdf_sha256 ||
    record.licence_generated_pdf_sha256 ||
    "";

  if (!generatedPdfObject) {
    blockers.push("missing_generated_pdf_object_key");
  }

  if (!generatedPdfSha256) {
    blockers.push("missing_generated_pdf_sha256");
  }

  if (linkStatus === "created" || linkStatus === "pending_generation") {
    warnings.push("legacy_or_pre_activation_link_state");
  }

  return {
    eligible: blockers.length === 0,
    decision: blockers.length === 0
      ? "eligible_for_download_link_revocation"
      : "blocked",
    blockers,
    warnings,
  };
}

function publicRecord(record) {
  if (!record) return null;

  return {
    id: record.download_id,
    licence_id: record.licence_id,
    licence_number: record.licence_number,
    document_id: record.document_id || record.link_document_id,
    document_version: record.document_version,
    download_reference: record.download_reference,
    status: record.link_status,
    created_at: record.link_created_at,
    expires_at: record.link_expires_at,
    activated_at: record.link_activated_at,
    used_at: record.link_used_at,
    revoked_at: record.link_revoked_at,
    superseded_at: record.link_superseded_at,
    failure_reason: record.link_failure_reason,
    token_hash_present: Boolean(record.token_hash),
    generated_pdf: {
      object_key_present: Boolean(
        record.link_generated_pdf_object_key ||
          record.licence_generated_pdf_object_key,
      ),
      sha256_present: Boolean(
        record.link_generated_pdf_sha256 ||
          record.licence_generated_pdf_sha256,
      ),
      size_bytes:
        record.link_generated_pdf_size_bytes ||
        record.licence_generated_pdf_size_bytes ||
        null,
      created_at:
        record.link_generated_pdf_created_at ||
        record.licence_generated_pdf_created_at ||
        null,
    },
  };
}

async function recordRevocationEvent(env, request, record, reason) {
  const db = getDb(env);
  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;

  const generatedObject =
    record.link_generated_pdf_object_key ||
    record.licence_generated_pdf_object_key ||
    null;

  const generatedSha256 =
    record.link_generated_pdf_sha256 ||
    record.licence_generated_pdf_sha256 ||
    null;

  await db
    .prepare(
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      buildId("dde"),
      record.download_id,
      record.licence_id,
      record.licence_number || "unknown",
      record.document_id || record.link_document_id || "unknown",
      record.document_version || "unknown",
      record.licence_holder_name || null,
      record.organisation_name || null,
      record.licence_holder_email_normalised ||
        record.licence_holder_email ||
        "unknown",
      "download_link_revoked",
      nowIso(),
      ipHash,
      getUserAgent(request),
      generatedObject,
      record.source_object || null,
      record.source_sha256 || null,
      generatedSha256,
      record.rendered_licence_sha256 || null,
      null,
      null,
      null,
      record.licence_terms_version || null,
      null,
      record.licence_terms_version || "unknown",
      1,
      reason || null,
    )
    .run();
}

async function safeRecordRevocationEvent(env, request, record, reason) {
  try {
    await recordRevocationEvent(env, request, record, reason);
    return true;
  } catch (error) {
    console.error("CDAS revocation event logging failed", {
      downloadId: record?.download_id,
      error: error?.message || String(error),
    });

    return false;
  }
}

export async function getCdasDownloadLinkRevocationEligibility(
  request,
  env,
  downloadId,
) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to check CDAS download-link revocation eligibility.",
      },
      405,
    );
  }

  const id = cleanText(downloadId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_download_link_id",
        message: "Download link ID is required.",
      },
      400,
    );
  }

  const record = await getDownloadLinkForRevocation(env, id);

  if (!record) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        eligible: false,
        decision: "blocked",
        blockers: ["download_link_not_found"],
      },
      404,
    );
  }

  const eligibility = buildRevocationEligibility(record);

  return jsonResponse({
    ok: true,
    action: "download_link_revocation_eligibility",
    eligible: eligibility.eligible,
    decision: eligibility.decision,
    blockers: eligibility.blockers,
    warnings: eligibility.warnings,
    download_link: publicRecord(record),
    controls: {
      raw_token_returned: false,
      token_hash_returned: false,
      token_hash_presence_only: true,
      mutates_database: false,
      revokes_link: false,
      serves_download: false,
      sends_email: false,
      reissues_link: false,
      deletes_r2_object: false,
      modifies_licence: false,
    },
  });
}

export async function revokeCdasDownloadLink(request, env, downloadId) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to revoke a CDAS controlled download link.",
      },
      405,
    );
  }

  const id = cleanText(downloadId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_download_link_id",
        message: "Download link ID is required.",
      },
      400,
    );
  }

  const body = await readJsonBody(request);
  const actor = cleanText(body.actor || body.revoked_by || "operations-centre").slice(
    0,
    120,
  );

  const reason = cleanText(
    body.reason ||
      body.revocation_reason ||
      "Operations Centre revoked controlled download link.",
  ).slice(0, 500);

  const record = await getDownloadLinkForRevocation(env, id);

  if (!record) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS controlled download link was not found.",
      },
      404,
    );
  }

  const eligibility = buildRevocationEligibility(record);

  if (!eligibility.eligible) {
    const alreadyRevoked = eligibility.blockers.includes(
      "download_link_already_revoked",
    );

    return jsonResponse(
      {
        ok: alreadyRevoked,
        revoked: false,
        already_revoked: alreadyRevoked,
        error: alreadyRevoked ? undefined : "download_link_revocation_blocked",
        message: alreadyRevoked
          ? "Controlled download link was already revoked."
          : "Controlled download link is not eligible for revocation.",
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        download_link: publicRecord(record),
        controls: {
          raw_token_returned: false,
          token_hash_returned: false,
          token_hash_presence_only: true,
          mutates_database: false,
          revokes_link: false,
          serves_download: false,
          sends_email: false,
          reissues_link: false,
          deletes_r2_object: false,
          modifies_licence: false,
          used_links_not_mutated: true,
          superseded_links_not_mutated: true,
          idempotent_retry: alreadyRevoked,
        },
      },
      alreadyRevoked ? 200 : 409,
    );
  }

  const db = getDb(env);
  const revokedAt = nowIso();
  const storedReason = `${reason} | actor=${actor}`;

  const updateResult = await db
    .prepare(
      `UPDATE document_download_links
       SET
         status = 'revoked',
         revoked_at = ?,
         failure_reason = ?
       WHERE id = ?
         AND status IN ('created', 'pending_generation', 'pending_activation', 'sent', 'active')
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND superseded_at IS NULL`,
    )
    .bind(revokedAt, storedReason, record.download_id)
    .run();

  if (updateResult?.meta?.changes !== 1) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_revocation_race_lost",
        message:
          "The controlled download link was not revoked because its state changed before the update completed.",
        download_link: publicRecord(record),
        controls: {
          raw_token_returned: false,
          token_hash_returned: false,
          token_hash_presence_only: true,
          mutates_database: false,
          atomic_update_required: true,
          used_links_not_mutated: true,
          superseded_links_not_mutated: true,
        },
      },
      409,
    );
  }

  const eventRecorded = await safeRecordRevocationEvent(
    env,
    request,
    record,
    storedReason,
  );

  return jsonResponse({
    ok: true,
    revoked: true,
    action: "download_link_revoked",
    download_link: {
      ...publicRecord(record),
      status: "revoked",
      revoked_at: revokedAt,
      failure_reason: storedReason,
    },
    event_recorded: eventRecorded,
    controls: {
      raw_token_returned: false,
      token_hash_returned: false,
      token_hash_presence_only: true,
      mutates_database: true,
      revokes_link: true,
      serves_download: false,
      sends_email: false,
      reissues_link: false,
      deletes_r2_object: false,
      modifies_licence: false,
      used_links_not_mutated: true,
      superseded_links_not_mutated: true,
      revocation_only: true,
    },
    message: "Controlled download link was revoked.",
  });
}
