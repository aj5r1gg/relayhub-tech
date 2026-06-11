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

  return [...array]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromText(text) {
  const encoded = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

function buildId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomHex(8)}`;
}

function currentYear() {
  return new Date().getUTCFullYear();
}

function buildDownloadReference() {
  return `RH-DL-${currentYear()}-${randomHex(4).toUpperCase()}`;
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

function evaluateLicenceForReservedDownloadLink(licence) {
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

  if (!licence.licence_number) {
    blockers.push("missing_licence_number");
  }

  if (!licence.document_id) {
    blockers.push("missing_document_id");
  }

  if (!licence.document_version) {
    blockers.push("missing_document_version");
  }

  if (!licence.licence_holder_name) {
    blockers.push("missing_licence_holder_name");
  }

  if (!licence.licence_holder_email_normalised && !licence.licence_holder_email) {
    blockers.push("missing_licence_holder_email");
  }

  if (!licence.licence_terms_version) {
    blockers.push("missing_licence_terms_version");
  }

  if (!licence.rendered_licence_body) {
    blockers.push("missing_rendered_licence_body");
  }

  if (!licence.rendered_licence_sha256) {
    blockers.push("missing_rendered_licence_sha256");
  }

  if (!licence.rendered_terms_body_sha256) {
    blockers.push("missing_rendered_terms_body_sha256");
  }

  if (!licence.source_object) {
    blockers.push("missing_source_object");
  }

  if (!licence.source_sha256) {
    blockers.push("missing_source_sha256");
  }

  /*
   * Generated PDF evidence is intentionally NOT required here.
   *
   * Phase 3W-G changes the workflow to:
   *
   *   reserve pending_generation download link
   *   -> generate PDF with Download ID embedded
   *   -> activate reserved link
   *
   * Therefore, generated_pdf_status/generated_pdf_object_key/generated_pdf_sha256
   * must not block reservation.
   */

  return { blockers, warnings };
}

async function downloadReferenceExists(env, reference) {
  const row = await env.RELAYHUB_DB.prepare(
    `SELECT id
     FROM document_download_links
     WHERE download_reference = ?
     LIMIT 1`
  )
    .bind(reference)
    .first();

  return Boolean(row?.id);
}

async function makeUniqueDownloadReference(env) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const reference = buildDownloadReference();

    if (!(await downloadReferenceExists(env, reference))) {
      return reference;
    }
  }

  throw new Error("Unable to allocate a unique download reference.");
}

async function supersedePreviousUnusedLinks(env, licenceId, supersededAt) {
  const result = await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       status = 'superseded',
       superseded_at = ?
     WHERE licence_id = ?
       AND status IN ('created', 'pending_generation', 'active')
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
  downloadReference = null,
  eventType,
  success = 1,
  failureReason = null,
}) {
  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;

  const failureText = failureReason
    ? cleanText(failureReason)
    : downloadReference
      ? `download_reference=${downloadReference}`
      : null;

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
      failureText
    )
    .run();
}

export async function issueCdasDownloadLink(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to reserve a CDAS download link.",
      },
      405
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

  const readiness = evaluateLicenceForReservedDownloadLink(licence);

  if (readiness.blockers.length) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_reservation_blocked",
        message:
          "Download link was not reserved because one or more blockers were found.",
        blockers: readiness.blockers,
        warnings: readiness.warnings,
        licence: {
          id: licence.id,
          licence_number: licence.licence_number,
          status: licence.status,
          document_id: licence.document_id,
          document_version: licence.document_version,
          generated_pdf_status: licence.generated_pdf_status || null,
        },
        controls: {
          reserves_download_link_record: false,
          requires_generated_pdf_before_reservation: false,
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
  const downloadReference = await makeUniqueDownloadReference(env);
  const rawToken = `rh_dl_${randomHex(32)}`;
  const tokenHash = await sha256HexFromText(rawToken);

  const landingUrl = buildRecipientLandingUrl(request, rawToken);
  const apiDownloadUrl = buildApiDownloadUrl(request, rawToken);
  const metadataUrl = buildMetadataUrl(request, rawToken);

  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;
  const userAgent = getUserAgent(request);

  const supersededCount = await supersedePreviousUnusedLinks(
    env,
    licence.id,
    createdAt
  );

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
       failure_reason,
       download_reference,
       activated_at,
       generated_pdf_object_key,
       generated_pdf_sha256,
       generated_pdf_size_bytes,
       generated_pdf_created_at
     )
     VALUES (
       ?, ?, ?, ?,
       'pending_generation',
       ?, ?,
       NULL, NULL, NULL,
       ?, ?, NULL,
       ?,
       NULL,
       NULL, NULL, NULL, NULL
     )`
  )
    .bind(
      downloadId,
      licence.id,
      licence.document_id,
      tokenHash,
      createdAt,
      expiresAt,
      ipHash,
      userAgent,
      downloadReference
    )
    .run();

  await recordDownloadEvent({
    env,
    request,
    licence,
    downloadId,
    downloadReference,
    eventType: "download_link_reserved",
    success: 1,
    failureReason: null,
  });

  return jsonResponse({
    ok: true,
    reserved: true,
    issued: false,
    download_link: {
      id: downloadId,
      download_reference: downloadReference,
      status: "pending_generation",

      /*
       * Default share URL.
       *
       * This is intentionally the recipient landing page, not the raw download
       * API endpoint. Opening this URL does not consume the link. The link is
       * consumed only when the recipient presses the final download button.
       *
       * During pending_generation, the URL must not serve a downloadable PDF.
       */
      url: landingUrl,
      landing_url: landingUrl,

      /*
       * Validation/support URLs.
       *
       * These are returned so the admin system can validate the full flow, but
       * the UI should copy/share landing_url by default only after activation.
       */
      api_download_url: apiDownloadUrl,
      metadata_url: metadataUrl,

      token_visible_once: true,
      expires_at: expiresAt,
      single_use_by_schema: true,
      active: false,
      usable: false,
    },
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_name: licence.licence_holder_name,
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
      issued_at: licence.issued_at,
      licence_terms_version: licence.licence_terms_version,
      generated_pdf_status: licence.generated_pdf_status || null,
      generated_pdf_object_key: licence.generated_pdf_object_key || null,
      generated_pdf_sha256: licence.generated_pdf_sha256 || null,
      generated_pdf_size_bytes: licence.generated_pdf_size_bytes || null,
    },
    superseded_previous_links: supersededCount,
    warnings: readiness.warnings,
    controls: {
      verifies_licence_active: true,
      verifies_licence_evidence: true,
      requires_generated_pdf_before_reservation: false,
      reserves_download_link_record: true,
      status_is_pending_generation: true,
      creates_active_download_link: false,
      stores_raw_token: false,
      stores_token_hash: true,
      returns_token_once: true,
      default_share_url_is_landing_page: true,
      landing_page_does_not_consume_link: true,
      pending_generation_link_is_not_downloadable: true,
      api_download_url_returned_for_validation: true,
      metadata_url_returned_for_validation: true,
      supersedes_previous_unused_links: true,
      writes_to_r2: false,
      serves_download: false,
      public_access: false,
    },
    next_step: {
      action: "generate_pdf_with_download_reference",
      endpoint: `/api/admin/cdas/licences/${encodeURIComponent(
        licence.id
      )}/generate-pdf`,
      required_download_link_id: downloadId,
      required_download_reference: downloadReference,
    },
    message:
      "Controlled download link was reserved in pending_generation state. It is not downloadable until the generated PDF has been created and the link has been activated.",
  });
}