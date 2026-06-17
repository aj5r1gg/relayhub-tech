import { getClientIp, jsonResponse } from "../shared.js";
import {
  evaluateCdasDownloadLinkReissueEligibility,
} from "./download-link-reissue-eligibility.js";

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

function getDb(env) {
  return env.RELAYHUB_DB || env.DB || env.DATABASE || null;
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

function buildDownloadReference() {
  return `RH-DL-${new Date().getUTCFullYear()}-${randomHex(4).toUpperCase()}`;
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

function normaliseExpiryDays(value) {
  const days = Number(value || 7);

  if (!Number.isFinite(days)) return 7;
  if (days < 1) return 1;
  if (days > 30) return 30;

  return Math.floor(days);
}

async function getOldDownloadLinkRecord(env, downloadId) {
  const db = getDb(env);

  return await db
    .prepare(
      `SELECT
         dl.*,
         lic.licence_number AS licence_number,
         lic.licence_terms_version AS licence_terms_version,
         lic.licence_holder_name AS licence_holder_name,
         lic.organisation_name AS organisation_name,
         lic.licence_holder_email AS licence_holder_email,
         lic.licence_holder_email_normalised AS licence_holder_email_normalised
       FROM document_download_links dl
       LEFT JOIN document_licences lic
         ON lic.id = dl.licence_id
       WHERE dl.id = ?
       LIMIT 1`
    )
    .bind(downloadId)
    .first();
}

async function recordReissueDownloadEvent({
  env,
  request,
  oldLink,
  eligibility,
  newDownloadId,
  eventType,
  success,
  failureReason,
}) {
  const db = getDb(env);
  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;
  const licence = eligibility.licence || {};
  const document = eligibility.document || {};
  const generatedPdf = eligibility.generated_pdf_object || {};
  const termsVersion =
    cleanText(licence.licence_terms_version) ||
    cleanText(oldLink?.licence_terms_version) ||
    cleanText(licence.terms_version) ||
    "UNKNOWN";

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      buildId("dde"),
      newDownloadId || oldLink?.id || null,
      oldLink?.licence_id || licence.id || null,
      licence.licence_number || null,
      oldLink?.document_id || licence.document_id || document.id || null,
      licence.document_version || document.version || null,
      licence.licence_holder_name || null,
      licence.organisation_name || null,
      licence.licence_holder_email_normalised ||
        licence.licence_holder_email ||
        null,
      eventType,
      nowIso(),
      ipHash,
      getUserAgent(request),
      licence.generated_pdf_object_key || oldLink?.generated_pdf_object_key || null,
      document.source_object || null,
      document.source_sha256 || null,
      licence.generated_pdf_sha256 || oldLink?.generated_pdf_sha256 || null,
      licence.rendered_licence_sha256 || null,
      null,
      null,
      null,
      termsVersion,
      null,
      termsVersion,
      success ? 1 : 0,
      cleanText(failureReason).slice(0, 1000) || null
    )
    .run();
}

export async function reissueCdasDownloadLinkFromDownloadLink(
  request,
  env,
  downloadId
) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to reissue a CDAS download link.",
      },
      405
    );
  }

  const db = getDb(env);

  if (!db) {
    return jsonResponse(
      {
        ok: false,
        error: "d1_binding_missing",
        message: "D1 database binding was not found.",
      },
      500
    );
  }

  const oldDownloadId = cleanText(downloadId);

  if (!oldDownloadId) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_download_link_id",
        message: "Download link ID is required.",
      },
      400
    );
  }

  const body = await readOptionalJson(request);
  const actor = cleanText(body.actor) || "operations-centre";
  const note = cleanText(body.note || body.reason);
  const expiresInDays = normaliseExpiryDays(body.expires_in_days);
  const createdAt = nowIso();
  const expiresAt = addDaysIso(expiresInDays);

  const eligibility = await evaluateCdasDownloadLinkReissueEligibility(
    env,
    oldDownloadId
  );

  const oldLink = await getOldDownloadLinkRecord(env, oldDownloadId);

  if (!eligibility.ok || !eligibility.eligible) {
    if (oldLink) {
      await recordReissueDownloadEvent({
        env,
        request,
        oldLink,
        eligibility,
        newDownloadId: null,
        eventType: "download_link_reissue_blocked",
        success: 0,
        failureReason:
          `blockers=${(eligibility.blockers || []).join(",") || "unknown"} | actor=${actor}`,
      });
    }

    return jsonResponse(
      {
        ok: false,
        error: "download_link_reissue_blocked",
        message:
          "Replacement download link was not created because the reissue eligibility gate did not pass.",
        eligible: false,
        decision: eligibility.decision || "blocked",
        blockers: eligibility.blockers || ["reissue_not_eligible"],
        warnings: eligibility.warnings || [],
        old_download_link: eligibility.old_download_link || null,
        licence: eligibility.licence || null,
        counts: eligibility.counts || {},
        controls: {
          creates_download_link: false,
          returns_raw_token: false,
          activates_link: false,
          sends_email: false,
          serves_download: false,
          modifies_licence: false,
          deletes_r2_object: false,
        },
      },
      409
    );
  }

  if (!oldLink) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "Original download link was not found.",
      },
      404
    );
  }

  const licence = eligibility.licence || {};
  const generatedObjectKey =
    licence.generated_pdf_object_key || oldLink.generated_pdf_object_key;
  const generatedSha256 =
    licence.generated_pdf_sha256 || oldLink.generated_pdf_sha256;
  const generatedSizeBytes =
    licence.generated_pdf_size_bytes || oldLink.generated_pdf_size_bytes;
  const generatedCreatedAt =
    licence.generated_pdf_created_at || oldLink.generated_pdf_created_at;

  if (!generatedObjectKey || !generatedSha256 || !generatedSizeBytes) {
    return jsonResponse(
      {
        ok: false,
        error: "generated_pdf_evidence_missing",
        message:
          "Replacement download link was not created because generated PDF evidence was incomplete.",
        blockers: ["generated_pdf_evidence_missing"],
        controls: {
          creates_download_link: false,
          returns_raw_token: false,
          activates_link: false,
          sends_email: false,
          serves_download: false,
          modifies_licence: false,
          deletes_r2_object: false,
        },
      },
      409
    );
  }

  const newDownloadId = buildId("ddl");
  const rawToken = `rh_dl_${randomHex(32)}`;
  const tokenHash = await sha256HexFromText(rawToken);
  const downloadReference = buildDownloadReference();

  const landingUrl = buildRecipientLandingUrl(request, rawToken);
  const apiDownloadUrl = buildApiDownloadUrl(request, rawToken);
  const metadataUrl = buildMetadataUrl(request, rawToken);

  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;
  const userAgent = getUserAgent(request);

  const failureReason = [
    `reissue_of=${oldDownloadId}`,
    oldLink.download_reference
      ? `reissue_of_reference=${oldLink.download_reference}`
      : "",
    note ? `note=${note}` : "",
    `actor=${actor}`,
  ]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 1000);

  await db
    .prepare(
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
       VALUES (?, ?, ?, ?, 'pending_activation', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
    )
    .bind(
      newDownloadId,
      oldLink.licence_id,
      oldLink.document_id || licence.document_id,
      tokenHash,
      createdAt,
      expiresAt,
      ipHash,
      userAgent,
      failureReason,
      downloadReference,
      generatedObjectKey,
      generatedSha256,
      generatedSizeBytes,
      generatedCreatedAt
    )
    .run();

  /*
   * Supersede marker only. Do not change the old link's status.
   * If the old link is revoked, it remains revoked.
   */
  let oldLinkMarkedSuperseded = false;

  if (!oldLink.superseded_at) {
    const update = await db
      .prepare(
        `UPDATE document_download_links
         SET superseded_at = ?
         WHERE id = ?
           AND used_at IS NULL
           AND superseded_at IS NULL`
      )
      .bind(createdAt, oldDownloadId)
      .run();

    oldLinkMarkedSuperseded = Number(update?.meta?.changes || 0) > 0;
  }

  await recordReissueDownloadEvent({
    env,
    request,
    oldLink,
    eligibility,
    newDownloadId,
    eventType: "download_link_reissued_pending_activation",
    success: 1,
    failureReason:
      `${failureReason} | new_reference=${downloadReference} | old_link_marked_superseded=${oldLinkMarkedSuperseded}`,
  });

  return jsonResponse({
    ok: true,
    reissued: true,
    action: "download_link_reissue",
    old_download_link: {
      id: oldLink.id,
      download_reference: oldLink.download_reference,
      status: oldLink.status,
      revoked_at: oldLink.revoked_at || null,
      used_at: oldLink.used_at || null,
      superseded_at_was_present: Boolean(oldLink.superseded_at),
      superseded_at_set: oldLinkMarkedSuperseded ? createdAt : null,
      status_changed: false,
    },
    new_download_link: {
      id: newDownloadId,
      download_reference: downloadReference,
      status: "pending_activation",
      created_at: createdAt,
      expires_at: expiresAt,
      landing_url: landingUrl,
      url: landingUrl,
      api_download_url: apiDownloadUrl,
      metadata_url: metadataUrl,
      token_visible_once: true,
      single_use_by_schema: true,
      generated_pdf_object_key: generatedObjectKey,
      generated_pdf_sha256: generatedSha256,
      generated_pdf_size_bytes: generatedSizeBytes,
    },
    licence: {
      id: licence.id || oldLink.licence_id,
      licence_number: licence.licence_number || null,
      status: licence.status || null,
      document_id: oldLink.document_id || licence.document_id || null,
      document_version: licence.document_version || null,
    },
    warnings: eligibility.warnings || [],
    controls: {
      eligibility_rechecked: true,
      creates_download_link: true,
      new_link_status: "pending_activation",
      returns_raw_token_once: true,
      stores_raw_token: false,
      stores_token_hash: true,
      old_link_status_changed: false,
      old_link_superseded_at_may_be_set: true,
      activates_link: false,
      sends_email: false,
      serves_download: false,
      modifies_licence: false,
      deletes_r2_object: false,
      writes_to_r2: false,
    },
    safety: {
      new_download_link_created: true,
      new_link_activated: false,
      email_sent: false,
      pdf_served: false,
      licence_modified: false,
      r2_object_deleted: false,
    },
    message:
      "Replacement controlled download link was created in pending_activation state. It was not activated, emailed, served, or used. Copy the landing URL now; the raw token is not stored.",
  });
}
