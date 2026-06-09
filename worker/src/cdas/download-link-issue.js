import { getClientIp, jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes = 32) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return [...array].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function normaliseR2Key(value) {
  return cleanText(value).replace(/^\/+/, "");
}

function buildId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomHex(8)}`;
}

function getUserAgent(request) {
  return cleanText(request.headers.get("User-Agent")).slice(0, 500);
}

function buildRecipientLandingUrl(request, token) {
  const url = new URL(request.url);
  return `${url.origin}/document-download/${encodeURIComponent(token)}`;
}

function buildApiDownloadUrl(request, token) {
  const url = new URL(request.url);
  return `${url.origin}/api/document-download/${encodeURIComponent(token)}`;
}

function buildMetadataUrl(request, token) {
  const url = new URL(request.url);
  return `${url.origin}/api/document-download-metadata/${encodeURIComponent(token)}`;
}

async function getLicence(env, licenceIdOrNumber) {
  const ref = cleanText(licenceIdOrNumber);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_licences
     WHERE id = ? OR licence_number = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

function evaluateLicenceForDownloadLink(licence) {
  const blockers = [];
  const warnings = [];

  if (!licence) {
    blockers.push("licence_not_found");
    return { blockers, warnings };
  }

  if (licence.status !== "active") {
    blockers.push("licence_not_active");
  }

  if (licence.revoked_at || licence.status === "revoked") {
    blockers.push("licence_revoked");
  }

  if (licence.confirmed_leak_at) {
    blockers.push("confirmed_leak_recorded");
  }

  if (licence.suspected_leak_at) {
    warnings.push("suspected_leak_recorded");
  }

  if (licence.generated_pdf_status !== "generated") {
    blockers.push("generated_pdf_status_not_generated");
  }

  if (!licence.generated_pdf_object_key) {
    blockers.push("missing_generated_pdf_object_key");
  }

  if (!licence.generated_pdf_filename) {
    blockers.push("missing_generated_pdf_filename");
  }

  if (!licence.generated_pdf_sha256) {
    blockers.push("missing_generated_pdf_sha256");
  }

  if (!licence.generated_pdf_size_bytes) {
    blockers.push("missing_generated_pdf_size_bytes");
  }

  if (!licence.licence_number) {
    blockers.push("missing_licence_number");
  }

  if (!licence.document_id) {
    blockers.push("missing_document_id");
  }

  if (!licence.document_version) {
    blockers.push("missing_document_version");
  }

  if (!licence.licence_holder_email_normalised && !licence.licence_holder_email) {
    blockers.push("missing_licence_holder_email");
  }

  if (!licence.licence_terms_version) {
    blockers.push("missing_licence_terms_version");
  }

  return { blockers, warnings };
}

async function verifyGeneratedPdfEvidence(env, licence) {
  const objectKey = normaliseR2Key(licence.generated_pdf_object_key);

  const r2Object = await env.RELAYHUB_DOWNLOADS.get(objectKey);

  if (!r2Object) {
    return {
      ok: false,
      blockers: ["generated_pdf_object_not_found_in_r2"],
      warnings: [],
      r2: null,
    };
  }

  const bytes = await r2Object.arrayBuffer();
  const actualSize = r2Object.size ?? bytes.byteLength;
  const actualSha256 = await sha256HexFromBytes(bytes);

  const blockers = [];
  const warnings = [];

  if (actualSha256 !== licence.generated_pdf_sha256) {
    blockers.push("generated_pdf_sha256_mismatch");
  }

  if (Number(actualSize) !== Number(licence.generated_pdf_size_bytes)) {
    blockers.push("generated_pdf_size_mismatch");
  }

  const contentType =
    r2Object.httpMetadata?.contentType ||
    licence.generated_pdf_content_type ||
    "application/pdf";

  if (contentType !== "application/pdf") {
    warnings.push("generated_pdf_content_type_not_application_pdf");
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    r2: {
      key: objectKey,
      size: actualSize,
      calculated_sha256: actualSha256,
      uploaded: r2Object.uploaded ? r2Object.uploaded.toISOString() : null,
      http_etag: r2Object.httpEtag ?? null,
      content_type: contentType,
    },
  };
}

async function supersedePreviousLinks(env, licenceId, supersededAt) {
  const result = await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       status = 'superseded',
       superseded_at = ?
     WHERE licence_id = ?
       AND status = 'created'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL`
  )
    .bind(supersededAt, licenceId)
    .run();

  return result?.meta?.changes ?? 0;
}

async function recordDownloadEvent({
  env,
  request,
  licence,
  downloadId,
  eventType,
  success = 1,
  failureReason = null,
}) {
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
      downloadId,
      licence.id,
      licence.licence_number,
      licence.document_id,
      licence.document_version,
      licence.licence_holder_name || null,
      licence.organisation_name || null,
      licence.licence_holder_email_normalised || licence.licence_holder_email,
      eventType,
      nowIso(),
      ipHash,
      getUserAgent(request),
      licence.generated_pdf_object_key || null,
      licence.source_object || null,
      licence.source_sha256 || null,
      licence.generated_pdf_sha256 || null,
      licence.rendered_licence_sha256 || null,
      null,
      null,
      null,
      licence.licence_terms_version || null,
      null,
      licence.licence_terms_version,
      success ? 1 : 0,
      failureReason
    )
    .run();
}

export async function issueCdasDownloadLink(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to issue a CDAS download link.",
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

  const ref = cleanText(licenceIdOrNumber);

  if (!ref) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_licence_id",
        message: "Licence ID or licence number is required.",
      },
      400
    );
  }

  const licence = await getLicence(env, ref);

  if (!licence) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
      },
      404
    );
  }

  const readiness = evaluateLicenceForDownloadLink(licence);

  if (readiness.blockers.length) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_issuance_blocked",
        message: "Download link was not issued because one or more blockers were found.",
        blockers: readiness.blockers,
        warnings: readiness.warnings,
        licence: {
          id: licence.id,
          licence_number: licence.licence_number,
          status: licence.status,
          generated_pdf_status: licence.generated_pdf_status,
        },
        controls: {
          creates_download_link_record: false,
          stores_raw_token: false,
          writes_to_r2: false,
          serves_download: false,
          public_access: false,
        },
      },
      409
    );
  }

  const evidence = await verifyGeneratedPdfEvidence(env, licence);

  if (!evidence.ok) {
    return jsonResponse(
      {
        ok: false,
        error: "generated_pdf_evidence_check_failed",
        message:
          "Download link was not issued because the generated PDF evidence check failed.",
        blockers: evidence.blockers,
        warnings: [...readiness.warnings, ...evidence.warnings],
        controls: {
          creates_download_link_record: false,
          stores_raw_token: false,
          writes_to_r2: false,
          serves_download: false,
          public_access: false,
        },
      },
      409
    );
  }

  const createdAt = nowIso();
  const expiresAt = addDaysIso(7);
  const downloadId = buildId("ddl");
  const rawToken = `rh_dl_${randomHex(32)}`;
  const tokenHash = await sha256HexFromText(rawToken);

  const landingUrl = buildRecipientLandingUrl(request, rawToken);
  const apiDownloadUrl = buildApiDownloadUrl(request, rawToken);
  const metadataUrl = buildMetadataUrl(request, rawToken);

  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;
  const userAgent = getUserAgent(request);

  const supersededCount = await supersedePreviousLinks(env, licence.id, createdAt);

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_download_links (
       id,
       licence_id,
       document_id,
       token_hash,
       status,
       created_at,
       expires_at,
       used_at,
       revoked_at,
       superseded_at,
       ip_hash,
       user_agent,
       failure_reason
     )
     VALUES (?, ?, ?, ?, 'created', ?, ?, NULL, NULL, NULL, ?, ?, NULL)`
  )
    .bind(
      downloadId,
      licence.id,
      licence.document_id,
      tokenHash,
      createdAt,
      expiresAt,
      ipHash,
      userAgent
    )
    .run();

  await recordDownloadEvent({
    env,
    request,
    licence,
    downloadId,
    eventType: "download_link_issued",
    success: 1,
    failureReason: null,
  });

  return jsonResponse({
    ok: true,
    issued: true,
    download_link: {
      id: downloadId,
      status: "created",

      /*
       * Default share URL.
       *
       * This is intentionally the recipient landing page, not the raw download
       * API endpoint. Opening this URL does not consume the link. The link is
       * consumed only when the recipient presses the final download button.
       */
      url: landingUrl,
      landing_url: landingUrl,

      /*
       * Validation/support URLs.
       *
       * These are returned so the admin system can validate the full flow, but
       * the UI should copy/share landing_url by default.
       */
      api_download_url: apiDownloadUrl,
      metadata_url: metadataUrl,

      token_visible_once: true,
      expires_at: expiresAt,
      single_use_by_schema: true,
    },
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
      generated_pdf_object_key: licence.generated_pdf_object_key,
      generated_pdf_sha256: licence.generated_pdf_sha256,
      generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
    },
    generated_pdf_evidence: {
      object_exists: true,
      evidence_matches: true,
      r2_size: evidence.r2.size,
      d1_size: licence.generated_pdf_size_bytes,
      r2_calculated_sha256: evidence.r2.calculated_sha256,
      d1_sha256: licence.generated_pdf_sha256,
      r2_uploaded: evidence.r2.uploaded,
      r2_http_etag: evidence.r2.http_etag,
    },
    superseded_previous_links: supersededCount,
    warnings: [...readiness.warnings, ...evidence.warnings],
    controls: {
      verifies_licence_active: true,
      verifies_generated_pdf_evidence: true,
      creates_download_link_record: true,
      stores_raw_token: false,
      stores_token_hash: true,
      returns_token_once: true,
      default_share_url_is_landing_page: true,
      landing_page_does_not_consume_link: true,
      api_download_url_returned_for_validation: true,
      metadata_url_returned_for_validation: true,
      supersedes_previous_unused_links: true,
      writes_to_r2: false,
      serves_download: false,
      public_access: false,
    },
    message:
      "Controlled download link record was issued. The default share URL is the recipient landing page. The token is shown only in this response.",
  });
}