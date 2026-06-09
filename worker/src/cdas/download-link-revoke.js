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

async function getDownloadLinkForRevocation(env, downloadId) {
  return await env.RELAYHUB_DB.prepare(
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

       lic.generated_pdf_status AS generated_pdf_status,
       lic.generated_pdf_object_key AS generated_pdf_object_key,
       lic.generated_pdf_filename AS generated_pdf_filename,
       lic.generated_pdf_sha256 AS generated_pdf_sha256,
       lic.generated_pdf_size_bytes AS generated_pdf_size_bytes,
       lic.generated_pdf_content_type AS generated_pdf_content_type,
       lic.generated_pdf_created_at AS generated_pdf_created_at
     FROM document_download_links dl
     LEFT JOIN document_licences lic
       ON lic.id = dl.licence_id
     WHERE dl.id = ?
     LIMIT 1`
  )
    .bind(downloadId)
    .first();
}

async function recordRevocationEvent(env, request, record, reason) {
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
      record.generated_pdf_object_key || null,
      record.source_object || null,
      record.source_sha256 || null,
      record.generated_pdf_sha256 || null,
      record.rendered_licence_sha256 || null,
      null,
      null,
      null,
      record.licence_terms_version || null,
      null,
      record.licence_terms_version || "unknown",
      1,
      reason || null
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

export async function revokeCdasDownloadLink(request, env, downloadId) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to revoke a CDAS controlled download link.",
      },
      405
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
      400
    );
  }

  const body = await readJsonBody(request);
  const reason = cleanText(body.reason || "Admin revoked controlled download link.").slice(
    0,
    500
  );

  const record = await getDownloadLinkForRevocation(env, id);

  if (!record) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS controlled download link was not found.",
      },
      404
    );
  }

  if (record.link_status === "revoked" || record.link_revoked_at) {
    return jsonResponse({
      ok: true,
      revoked: false,
      already_revoked: true,
      download_link: {
        id: record.download_id,
        status: record.link_status,
        revoked_at: record.link_revoked_at,
        used_at: record.link_used_at,
        superseded_at: record.link_superseded_at,
        failure_reason: record.link_failure_reason,
        token_hash_present: Boolean(record.token_hash),
      },
      controls: {
        raw_token_returned: false,
        token_hash_returned: false,
        token_hash_presence_only: true,
        mutates_database: false,
        idempotent_retry: true,
      },
      message: "Controlled download link was already revoked.",
    });
  }

  if (record.link_status === "used" || record.link_used_at) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_already_used",
        message:
          "This controlled download link has already been used and cannot be revoked retroactively.",
        download_link: {
          id: record.download_id,
          status: record.link_status,
          used_at: record.link_used_at,
          revoked_at: record.link_revoked_at,
          superseded_at: record.link_superseded_at,
          failure_reason: record.link_failure_reason,
          token_hash_present: Boolean(record.token_hash),
        },
        controls: {
          raw_token_returned: false,
          token_hash_returned: false,
          token_hash_presence_only: true,
          mutates_database: false,
          used_links_not_mutated: true,
        },
      },
      409
    );
  }

  if (record.link_status === "superseded" || record.link_superseded_at) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_superseded",
        message:
          "This controlled download link has already been superseded and was not revoked.",
        download_link: {
          id: record.download_id,
          status: record.link_status,
          used_at: record.link_used_at,
          revoked_at: record.link_revoked_at,
          superseded_at: record.link_superseded_at,
          failure_reason: record.link_failure_reason,
          token_hash_present: Boolean(record.token_hash),
        },
        controls: {
          raw_token_returned: false,
          token_hash_returned: false,
          token_hash_presence_only: true,
          mutates_database: false,
          superseded_links_not_mutated: true,
        },
      },
      409
    );
  }

  const revokedAt = nowIso();

  const updateResult = await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       status = 'revoked',
       revoked_at = ?,
       failure_reason = ?
     WHERE id = ?
       AND status = 'created'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL`
  )
    .bind(revokedAt, reason, record.download_id)
    .run();

  if (updateResult?.meta?.changes !== 1) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_revocation_race_lost",
        message:
          "The controlled download link was not revoked because its state changed before the update completed.",
        controls: {
          raw_token_returned: false,
          token_hash_returned: false,
          token_hash_presence_only: true,
          mutates_database: false,
          atomic_update_required: true,
        },
      },
      409
    );
  }

  const eventRecorded = await safeRecordRevocationEvent(
    env,
    request,
    record,
    reason
  );

  return jsonResponse({
    ok: true,
    revoked: true,
    download_link: {
      id: record.download_id,
      licence_id: record.licence_id,
      licence_number: record.licence_number,
      document_id: record.document_id,
      document_version: record.document_version,
      status: "revoked",
      created_at: record.link_created_at,
      expires_at: record.link_expires_at,
      revoked_at: revokedAt,
      used_at: null,
      superseded_at: null,
      failure_reason: reason,
      token_hash_present: Boolean(record.token_hash),
    },
    event_recorded: eventRecorded,
    controls: {
      raw_token_returned: false,
      token_hash_returned: false,
      token_hash_presence_only: true,
      mutates_database: true,
      used_links_not_mutated: true,
      superseded_links_not_mutated: true,
      public_access: false,
      serves_download: false,
      revocation_only: true,
    },
    message: "Controlled download link was revoked.",
  });
}