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

async function sha256HexFromBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
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

function normaliseR2Key(value) {
  return cleanText(value).replace(/^\/+/, "");
}

function getUserAgent(request) {
  return cleanText(request.headers.get("User-Agent")).slice(0, 500);
}

function safeAttachmentFilename(value) {
  const fallback = "RelayHub-controlled-document.pdf";

  const cleaned = cleanText(value)
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);

  return cleaned || fallback;
}

function unavailableResponse() {
  return jsonResponse(
    {
      ok: false,
      error: "download_unavailable",
      message:
        "This controlled download link is unavailable, expired, already used, revoked, or invalid.",
    },
    404
  );
}

async function getDownloadRecord(env, tokenHash) {
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
       lic.issued_at AS issued_at,
       lic.expires_at AS licence_expires_at,
       lic.revoked_at AS licence_revoked_at,
       lic.superseded_by AS superseded_by,
       lic.corrected_from AS corrected_from,
       lic.suspected_leak_at AS suspected_leak_at,
       lic.confirmed_leak_at AS confirmed_leak_at,

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
       lic.generated_pdf_created_at AS generated_pdf_created_at,
       lic.generated_pdf_error AS generated_pdf_error
     FROM document_download_links dl
     JOIN document_licences lic
       ON lic.id = dl.licence_id
     WHERE dl.token_hash = ?
     LIMIT 1`
  )
    .bind(tokenHash)
    .first();
}

function evaluateDownload(record, now) {
  const blockers = [];
  const warnings = [];

  if (!record) {
    blockers.push("download_link_not_found");
    return { blockers, warnings };
  }

  if (record.link_status !== "created") {
    blockers.push("download_link_status_not_created");
  }

  if (record.link_used_at) {
    blockers.push("download_link_already_used");
  }

  if (record.link_revoked_at) {
    blockers.push("download_link_revoked");
  }

  if (record.link_superseded_at) {
    blockers.push("download_link_superseded");
  }

  if (!record.link_expires_at) {
    blockers.push("download_link_missing_expiry");
  } else if (new Date(record.link_expires_at).getTime() <= now.getTime()) {
    blockers.push("download_link_expired");
  }

  if (record.licence_status !== "active") {
    blockers.push("licence_not_active");
  }

  if (record.licence_revoked_at || record.licence_status === "revoked") {
    blockers.push("licence_revoked");
  }

  if (record.confirmed_leak_at) {
    blockers.push("confirmed_leak_recorded");
  }

  if (record.suspected_leak_at) {
    warnings.push("suspected_leak_recorded");
  }

  if (record.generated_pdf_status !== "generated") {
    blockers.push("generated_pdf_status_not_generated");
  }

  if (!record.generated_pdf_object_key) {
    blockers.push("missing_generated_pdf_object_key");
  }

  if (!record.generated_pdf_sha256) {
    blockers.push("missing_generated_pdf_sha256");
  }

  if (!record.generated_pdf_size_bytes) {
    blockers.push("missing_generated_pdf_size_bytes");
  }

  if (record.generated_pdf_error) {
    blockers.push("generated_pdf_error_present");
  }

  return { blockers, warnings };
}

function denialEventTypeFromBlockers(blockers) {
  const values = Array.isArray(blockers) ? blockers : [];

  if (values.includes("download_link_already_used")) {
    return "download_replay_denied";
  }

  if (values.includes("download_link_expired")) {
    return "download_expired";
  }

  if (values.includes("download_link_revoked")) {
    return "download_revoked";
  }

  if (values.includes("download_link_superseded")) {
    return "download_superseded";
  }

  return "download_denied";
}

function shouldMutateFailureReasonForBlockers(blockers) {
  const values = Array.isArray(blockers) ? blockers : [];

  const lifecycleDenials = new Set([
    "download_link_status_not_created",
    "download_link_already_used",
    "download_link_revoked",
    "download_link_superseded",
    "download_link_expired",
  ]);

  return !values.some((value) => lifecycleDenials.has(value));
}

async function recordDownloadEvent({
  env,
  request,
  record,
  eventType,
  success,
  failureReason = null,
}) {
  if (!record) {
    return;
  }

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
      record.licence_number,
      record.document_id,
      record.document_version,
      record.licence_holder_name || null,
      record.organisation_name || null,
      record.licence_holder_email_normalised || record.licence_holder_email,
      eventType,
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
      record.licence_terms_version,
      success ? 1 : 0,
      failureReason
    )
    .run();
}

async function safeRecordDownloadEvent(options) {
  try {
    await recordDownloadEvent(options);
    return { ok: true };
  } catch (error) {
    console.error("CDAS download event logging failed", {
      eventType: options?.eventType,
      downloadId: options?.record?.download_id,
      error: error?.message || String(error),
    });

    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

async function updateLinkFailureReason(env, record, request, reason) {
  if (!record) {
    return;
  }

  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       failure_reason = ?,
       ip_hash = COALESCE(ip_hash, ?),
       user_agent = COALESCE(user_agent, ?)
     WHERE id = ?
       AND status = 'created'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL`
  )
    .bind(
      String(reason || "download_failed").slice(0, 500),
      ipHash,
      getUserAgent(request),
      record.download_id
    )
    .run();
}

async function handleDeniedDownload(env, record, request, blockers) {
  const reason = (Array.isArray(blockers) ? blockers : ["download_denied"])
    .join(", ")
    .slice(0, 500);

  if (shouldMutateFailureReasonForBlockers(blockers)) {
    try {
      await updateLinkFailureReason(env, record, request, reason);
    } catch (error) {
      console.error("CDAS download failure mutation failed", {
        downloadId: record?.download_id,
        reason,
        error: error?.message || String(error),
      });
    }
  }

  await safeRecordDownloadEvent({
    env,
    request,
    record,
    eventType: denialEventTypeFromBlockers(blockers),
    success: 0,
    failureReason: reason,
  });

  return unavailableResponse();
}

async function markPreConsumptionFailure(env, record, request, reason) {
  const failureReason = String(reason || "download_failed").slice(0, 500);

  try {
    await updateLinkFailureReason(env, record, request, failureReason);
  } catch (error) {
    console.error("CDAS pre-consumption failure mutation failed", {
      downloadId: record?.download_id,
      failureReason,
      error: error?.message || String(error),
    });
  }

  await safeRecordDownloadEvent({
    env,
    request,
    record,
    eventType: "download_failed",
    success: 0,
    failureReason,
  });
}

async function markDownloadUsed(env, record, request, usedAt) {
  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;

  const result = await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       status = 'used',
       used_at = ?,
       ip_hash = COALESCE(ip_hash, ?),
       user_agent = COALESCE(user_agent, ?),
       failure_reason = NULL
     WHERE id = ?
       AND status = 'created'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL
       AND datetime(expires_at) > datetime(?)`
  )
    .bind(
      usedAt,
      ipHash,
      getUserAgent(request),
      record.download_id,
      usedAt
    )
    .run();

  return result?.meta?.changes === 1;
}

export async function handleCdasDocumentDownload(request, env, token) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to download a controlled document.",
      },
      405
    );
  }

  if (!env.RELAYHUB_DOWNLOADS) {
    return jsonResponse(
      {
        ok: false,
        error: "r2_binding_missing",
        message: "R2 binding RELAYHUB_DOWNLOADS is not available to the Worker.",
      },
      500
    );
  }

  const rawToken = cleanText(token);

  if (!rawToken || rawToken.length < 32) {
    return unavailableResponse();
  }

  const tokenHash = await sha256HexFromText(rawToken);
  const record = await getDownloadRecord(env, tokenHash);

  if (!record) {
    return unavailableResponse();
  }

  const readiness = evaluateDownload(record, new Date());

  if (readiness.blockers.length) {
    return handleDeniedDownload(env, record, request, readiness.blockers);
  }

  const objectKey = normaliseR2Key(record.generated_pdf_object_key);
  const r2Object = await env.RELAYHUB_DOWNLOADS.get(objectKey);

  if (!r2Object) {
    await markPreConsumptionFailure(
      env,
      record,
      request,
      "generated_pdf_object_not_found_in_r2"
    );

    return unavailableResponse();
  }

  const bytes = await r2Object.arrayBuffer();
  const actualSize = r2Object.size ?? bytes.byteLength;
  const actualSha256 = await sha256HexFromBytes(bytes);

  if (actualSha256 !== record.generated_pdf_sha256) {
    await markPreConsumptionFailure(
      env,
      record,
      request,
      "generated_pdf_sha256_mismatch"
    );

    return unavailableResponse();
  }

  if (Number(actualSize) !== Number(record.generated_pdf_size_bytes)) {
    await markPreConsumptionFailure(
      env,
      record,
      request,
      "generated_pdf_size_mismatch"
    );

    return unavailableResponse();
  }

  const usedAt = nowIso();
  const markedUsed = await markDownloadUsed(env, record, request, usedAt);

  if (!markedUsed) {
    await safeRecordDownloadEvent({
      env,
      request,
      record,
      eventType: "download_concurrent_denied",
      success: 0,
      failureReason: "download_link_concurrent_or_already_consumed",
    });

    return unavailableResponse();
  }

  await safeRecordDownloadEvent({
    env,
    request,
    record,
    eventType: "document_downloaded",
    success: 1,
    failureReason: null,
  });

  const filename = safeAttachmentFilename(
    record.generated_pdf_filename ||
      `${record.document_id}-${record.licence_number}.pdf`
  );

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-RelayHub-CDAS": "controlled-download",
      "X-RelayHub-Licence": record.licence_number,
    },
  });
}