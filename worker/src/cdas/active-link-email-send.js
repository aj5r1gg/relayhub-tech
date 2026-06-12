import { getClientIp, jsonResponse } from "../shared.js";
import { sendCdasDownloadLinkEmail } from "./email.js";
import {
  evaluateCdasActiveLinkDeliveryEligibility,
} from "./active-link-delivery-preparation.js";

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

function getUserAgent(request) {
  return cleanText(request.headers.get("User-Agent")).slice(0, 500);
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
    [ref, ref]
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
    [id]
  );
}

async function countSuccessfulEmailSends(env, downloadId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_download_events
     WHERE download_id = ?
       AND event_type = 'active_link_delivery_email_sent'
       AND success = 1`,
    [downloadId]
  );

  return Number(row?.total || 0);
}

async function recordDownloadEvent({
  env,
  request,
  link,
  licence,
  eventType,
  success = 1,
  failureReason = null,
  provider = null,
  providerMessageId = null,
}) {
  try {
    const ip = getClientIp(request);
    const ipHash = ip ? await sha256HexFromText(ip) : null;

    const failureParts = [];

    if (failureReason) failureParts.push(cleanText(failureReason));
    if (provider) failureParts.push(`provider=${cleanText(provider)}`);
    if (providerMessageId) failureParts.push(`provider_message_id=${cleanText(providerMessageId)}`);

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
        link.id,
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
        link.generated_pdf_object_key || licence.generated_pdf_object_key || null,
        licence.source_object || null,
        licence.source_sha256 || null,
        link.generated_pdf_sha256 || licence.generated_pdf_sha256 || null,
        licence.rendered_licence_sha256 || null,
        null,
        null,
        null,
        licence.licence_terms_version || null,
        null,
        licence.licence_terms_version || null,
        success ? 1 : 0,
        failureParts.length ? failureParts.join(" | ").slice(0, 1000) : null
      )
      .run();
  } catch {
    /*
     * Do not make the email action unrecoverable because the audit insert failed.
     * The email provider result is still returned to the operator.
     */
  }
}

export async function sendCdasActiveLinkDeliveryEmail(
  request,
  env,
  downloadLinkIdOrReference,
) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to send a controlled active-link delivery email.",
      },
      405
    );
  }

  const body = await readOptionalJson(request);

  const supplied =
    cleanText(body.landing_url) ||
    cleanText(body.download_url) ||
    cleanText(body.url) ||
    cleanText(body.token);

  const eligibility = await evaluateCdasActiveLinkDeliveryEligibility(
    env,
    request,
    downloadLinkIdOrReference,
    supplied
  );

  if (!eligibility.download_link) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS download link was not found.",
      },
      404
    );
  }

  if (!eligibility.eligible) {
    const link = await getDownloadLink(env, downloadLinkIdOrReference);
    const licence = link ? await getLicence(env, link.licence_id) : null;

    if (link && licence) {
      await recordDownloadEvent({
        env,
        request,
        link,
        licence,
        eventType: "active_link_delivery_email_blocked",
        success: 0,
        failureReason: eligibility.blockers.join(","),
      });
    }

    return jsonResponse(
      {
        ok: false,
        error: "active_link_delivery_email_blocked",
        message:
          "Active download-link email was not sent because the delivery gate did not pass.",
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        counts: eligibility.counts,
        safety: {
          email_sent: false,
          pdf_served: false,
          link_consumed: false,
        },
      },
      409
    );
  }

  const link = await getDownloadLink(env, eligibility.download_link.id);
  const licence = link ? await getLicence(env, link.licence_id) : null;

  if (!link || !licence) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_or_licence_missing_after_gate",
        message:
          "The download link or licence could not be reloaded after the delivery gate passed.",
        safety: {
          email_sent: false,
          pdf_served: false,
          link_consumed: false,
        },
      },
      409
    );
  }

  /*
   * Race guard. The 0P gate already blocks prior successful email sends, but we
   * re-check immediately before sending so repeat requests do not silently resend.
   */
  const successfulEmailSends = await countSuccessfulEmailSends(env, link.id);

  if (successfulEmailSends > 0) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_email_already_sent",
        message:
          "A successful active-link delivery email has already been recorded for this download link.",
        download_link: {
          id: link.id,
          download_reference: link.download_reference,
          status: link.status,
        },
        safety: {
          email_sent: false,
          pdf_served: false,
          link_consumed: false,
        },
      },
      409
    );
  }

  const prepared = eligibility.prepared_delivery;

  const emailResult = await sendCdasDownloadLinkEmail(env, {
    recipientEmail: prepared.recipient_email,
    documentTitle: eligibility.document?.title || licence.document_id,
    documentId: licence.document_id,
    licenceNumber: licence.licence_number,
    downloadUrl: prepared.landing_url,
    expiresAt: link.expires_at,
  });

  const sent = Boolean(emailResult?.ok && emailResult?.sent);
  const skipped = Boolean(emailResult?.ok && emailResult?.skipped);

  await recordDownloadEvent({
    env,
    request,
    link,
    licence,
    eventType: sent
      ? "active_link_delivery_email_sent"
      : skipped
        ? "active_link_delivery_email_skipped"
        : "active_link_delivery_email_failed",
    success: sent ? 1 : 0,
    failureReason:
      sent
        ? cleanText(body.note || "3X-0Q controlled email sent")
        : emailResult?.message || emailResult?.error || "email_not_sent",
    provider: emailResult?.provider || null,
    providerMessageId: emailResult?.provider_message_id || null,
  });

  if (!emailResult?.ok || !sent) {
    return jsonResponse(
      {
        ok: false,
        error: skipped ? "cdas_email_disabled" : emailResult?.error || "email_send_failed",
        message:
          emailResult?.message ||
          "The active download-link email was not sent.",
        email_result: {
          ok: Boolean(emailResult?.ok),
          sent,
          skipped,
          provider: emailResult?.provider || null,
          status: emailResult?.status || null,
          error: emailResult?.error || null,
          provider_message_id: emailResult?.provider_message_id || null,
        },
        controls: {
          verified_active_download_link: true,
          verified_raw_token_against_stored_hash: true,
          sent_email: false,
          served_pdf: false,
          consumed_link: false,
          exposed_raw_r2_url: false,
        },
        safety: {
          email_sent: false,
          pdf_served: false,
          link_consumed: false,
        },
      },
      skipped ? 409 : 502
    );
  }

  return jsonResponse({
    ok: true,
    sent: true,
    emailed: true,
    served: false,
    consumed: false,
    action: "send_active_link_delivery_email",
    email_result: {
      provider: emailResult.provider || "resend",
      status: emailResult.status || null,
      provider_message_id: emailResult.provider_message_id || null,
    },
    download_link: {
      id: link.id,
      download_reference: link.download_reference,
      status: link.status,
      activated_at: link.activated_at,
      expires_at: link.expires_at,
      used_at: link.used_at,
      revoked_at: link.revoked_at,
      superseded_at: link.superseded_at,
    },
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      recipient_email:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
    },
    controls: {
      verified_active_download_link: true,
      verified_raw_token_against_stored_hash: true,
      used_existing_email_provider_path: true,
      recorded_download_event: true,
      sends_email: true,
      serves_pdf: false,
      consumes_link: false,
      exposes_token_hash: false,
      exposes_raw_r2_url: false,
    },
    next_step: {
      phase: "3X-0R",
      action: "public_download_consumption_gate_action",
      note:
        "The link has been emailed but not consumed. The public download endpoint must enforce single-use consumption separately.",
    },
    safety: {
      email_sent: true,
      pdf_served: false,
      link_consumed: false,
    },
    message:
      "Controlled active-link delivery email was sent. No PDF was served and the link was not consumed.",
  });
}
