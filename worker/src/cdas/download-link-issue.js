import { getClientIp, jsonResponse } from "../shared.js";
import {
  evaluateCdasGeneratedPdfToDownloadLinkEligibility,
} from "./generated-pdf-to-download-link-gate.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : 7;
  const boundedDays = Math.max(1, Math.min(30, Math.floor(safeDays)));

  const date = new Date();
  date.setUTCDate(date.getUTCDate() + boundedDays);
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
  try {
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
  } catch {
    /*
     * Download-link creation must not fail merely because the legacy event table
     * is unavailable or has drifted. The link record itself remains the source
     * of truth for this phase.
     */
  }
}

export async function issueCdasDownloadLink(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to create a controlled CDAS download link.",
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

  const body = await readOptionalJson(request);
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

  const eligibility = await evaluateCdasGeneratedPdfToDownloadLinkEligibility(
    env,
    licence.id
  );

  if (!eligibility.eligible) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_creation_blocked",
        message:
          "Controlled download link was not created because the generated-PDF-to-download-link gate did not pass.",
        licence_id: licence.id,
        licence_number: licence.licence_number,
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        counts: eligibility.counts,
        safety: {
          download_link_created: false,
          download_link_activated: false,
          email_sent: false,
          pdf_served: false,
        },
      },
      409
    );
  }

  const createdAt = nowIso();
  const expiresAt = addDaysIso(body.expires_in_days ?? 7);
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

  /*
   * Phase 3X-0N creates the link record only.
   *
   * It intentionally uses pending_activation rather than created or active,
   * because the current public download handlers treat created/active as
   * downloadable states. Activation belongs to a later validation-gated phase.
   */
  const linkStatus = "pending_activation";

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
       ?,
       ?, ?,
       NULL, NULL, NULL,
       ?, ?, NULL,
       ?,
       NULL,
       ?, ?, ?, ?
     )`
  )
    .bind(
      downloadId,
      licence.id,
      licence.document_id,
      tokenHash,
      linkStatus,
      createdAt,
      expiresAt,
      ipHash,
      userAgent,
      downloadReference,
      licence.generated_pdf_object_key,
      licence.generated_pdf_sha256,
      licence.generated_pdf_size_bytes,
      licence.generated_pdf_created_at
    )
    .run();

  await recordDownloadEvent({
    env,
    request,
    licence,
    downloadId,
    downloadReference,
    eventType: "download_link_created_pending_activation",
    success: 1,
    failureReason: cleanText(body.note || "3X-0N controlled link creation"),
  });

  return jsonResponse({
    ok: true,
    created: true,
    activated: false,
    emailed: false,
    served: false,
    action: "create_controlled_download_link",
    download_link: {
      id: downloadId,
      download_reference: downloadReference,
      status: linkStatus,
      url: landingUrl,
      landing_url: landingUrl,
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
      generated_pdf_status: licence.generated_pdf_status,
      generated_pdf_object_key: licence.generated_pdf_object_key,
      generated_pdf_sha256: licence.generated_pdf_sha256,
      generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
      generated_pdf_created_at: licence.generated_pdf_created_at,
    },
    warnings: eligibility.warnings || [],
    controls: {
      evaluates_generated_pdf_to_download_link_gate: true,
      creates_download_link_record: true,
      copies_generated_pdf_evidence_to_link: true,
      status_is_pending_activation: true,
      creates_active_download_link: false,
      activates_download_link: false,
      stores_raw_token: false,
      stores_token_hash: true,
      returns_token_once: true,
      default_share_url_is_landing_page: true,
      landing_page_does_not_consume_link: true,
      pending_activation_link_is_not_downloadable: true,
      writes_to_r2: false,
      sends_email: false,
      serves_download: false,
      public_access: false,
    },
    next_step: {
      action: "activate_controlled_download_link",
      phase: "3X-0O",
      required_download_link_id: downloadId,
      required_download_reference: downloadReference,
    },
    safety: {
      download_link_created: true,
      download_link_activated: false,
      email_sent: false,
      pdf_served: false,
    },
    message:
      "Controlled download link record was created in pending_activation state. It is not active, not emailed, and not downloadable yet.",
  });
}
