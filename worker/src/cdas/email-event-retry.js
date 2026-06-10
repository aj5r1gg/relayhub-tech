import { jsonResponse } from "../shared.js";
import { sendCdasVerificationEmail, sendCdasDownloadLinkEmail } from "./email.js";
import { recordCdasEmailEvent } from "./email-events.js";
import { issueCdasDownloadLink } from "./download-link-issue.js";

const DEFAULT_VERIFICATION_EXPIRY_HOURS = 24;

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function hoursFromNowIso(hours) {
  const date = new Date();
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeVerificationToken() {
  return randomHex(32);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getVerificationExpiryHours(env) {
  const parsed = Number.parseInt(
    String(env.CDAS_VERIFICATION_EXPIRY_HOURS || ""),
    10
  );

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 168) {
    return DEFAULT_VERIFICATION_EXPIRY_HOURS;
  }

  return parsed;
}

function getPublicBaseUrl(env) {
  return (
    cleanText(env.CDAS_PUBLIC_BASE_URL) ||
    cleanText(env.RELAYHUB_PUBLIC_BASE_URL) ||
    "https://www.relayhub.tech"
  );
}

function makeVerificationUrl(env, requestId, token) {
  const base = getPublicBaseUrl(env).replace(/\/+$/, "");
  const url = new URL(`${base}/document-access/verify`);

  url.searchParams.set("request_id", requestId);
  url.searchParams.set("token", token);

  return url.toString();
}

function parseMetadata(value) {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function emailDeliveryStatusFromResult(result, prefix) {
  if (result?.sent) return `${prefix}_sent`;
  if (result?.skipped) return `${prefix}_disabled`;
  return `${prefix}_failed`;
}

function statusFromEmailResult(result) {
  if (result?.sent) return "sent";
  if (result?.skipped) return "skipped";
  return "failed";
}

function isRetryableEvent(row) {
  if (!row) return false;
  if (Number(row.retryable || 0) !== 1) return false;
  if (row.resolved_at) return false;

  return row.status === "failed" || row.status === "skipped";
}

async function getEmailEvent(env, eventId) {
  const id = cleanText(eventId);

  if (!id) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM cdas_email_events
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();
}

async function getAccessRequestForRetry(env, requestId) {
  const id = cleanText(requestId);

  if (!id) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT
       r.id,
       r.document_id,
       r.document_version,
       r.email,
       r.email_normalised,
       r.status,
       r.email_verified_at,
       r.email_delivery_status,
       d.title AS document_title
     FROM document_access_requests r
     LEFT JOIN documents d
       ON d.id = r.document_id
     WHERE r.id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();
}

async function retryVerificationEmailResend({
  env,
  originalEvent,
  metadata,
}) {
  const accessRequest = await getAccessRequestForRetry(
    env,
    originalEvent.related_id
  );

  if (!accessRequest) {
    return {
      ok: false,
      status: 404,
      error: "access_request_not_found",
      message: "Related access request was not found.",
    };
  }

  if (accessRequest.email_verified_at) {
    return {
      ok: false,
      status: 409,
      error: "access_request_already_verified",
      message: "The related access request is already email verified.",
    };
  }

  const blockedStatuses = new Set([
    "licence_issued",
    "denied",
    "expired",
    "cancelled",
  ]);

  if (blockedStatuses.has(accessRequest.status)) {
    return {
      ok: false,
      status: 409,
      error: "access_request_state_not_retryable",
      message: "Verification email cannot be retried for this access request state.",
    };
  }

  const verificationToken = makeVerificationToken();
  const verificationTokenHash = await sha256Hex(verificationToken);
  const expiresAt = hoursFromNowIso(getVerificationExpiryHours(env));
  const verificationUrl = makeVerificationUrl(
    env,
    accessRequest.id,
    verificationToken
  );

  const recipientEmail = normaliseEmail(
    originalEvent.recipient_email ||
      accessRequest.email_normalised ||
      accessRequest.email
  );

  const documentTitle =
    accessRequest.document_title || accessRequest.document_id;

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       verification_token_hash = ?,
       expires_at = ?,
       email_delivery_status = ?
     WHERE id = ?`
  )
    .bind(
      verificationTokenHash,
      expiresAt,
      "verification_email_retry_prepared",
      accessRequest.id
    )
    .run();

  let emailResult;

  try {
    emailResult = await sendCdasVerificationEmail(env, {
      requestId: accessRequest.id,
      verificationToken,
      verificationUrl,
      recipientEmail,
      documentTitle,
      documentId: accessRequest.document_id,
    });
  } catch (error) {
    emailResult = {
      ok: false,
      sent: false,
      provider: "resend",
      error: "verification_retry_exception",
      message:
        error instanceof Error
          ? error.message
          : "Verification email retry failed unexpectedly.",
    };
  }

  const emailDeliveryStatus = emailDeliveryStatusFromResult(
    emailResult,
    "verification_email_retry"
  );

  const verificationSentAt = emailResult?.sent ? nowIso() : null;

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       email_delivery_status = ?,
       verification_sent_at = COALESCE(?, verification_sent_at)
     WHERE id = ?`
  )
    .bind(emailDeliveryStatus, verificationSentAt, accessRequest.id)
    .run();

  await recordCdasEmailEvent(env, {
    relatedType: "access_request",
    relatedId: accessRequest.id,
    emailType: "verification_email_resend",
    recipientEmail,
    subject: `Verify your email for ${documentTitle}`,
    emailResult,
    metadata: {
      ...metadata,
      retry_of_event_id: originalEvent.id,
      retry_count: Number(originalEvent.retry_count || 0) + 1,
      retry_trigger: "manual_admin_retry",
      document_id: accessRequest.document_id,
      document_version: accessRequest.document_version,
      previous_email_delivery_status: accessRequest.email_delivery_status,
      expires_at: expiresAt,
    },
  });

  return {
    ok: true,
    retried: true,
    email_result: emailResult,
    email_delivery_status: emailDeliveryStatus,
    verification_sent_at: verificationSentAt,
    related: {
      type: "access_request",
      id: accessRequest.id,
    },
  };
}

async function retryDownloadLinkEmail({
  request,
  env,
  originalEvent,
  metadata,
}) {
  const issueResponse = await issueCdasDownloadLink(
    request,
    env,
    originalEvent.related_id
  );

  let issuePayload = null;

  try {
    issuePayload = await issueResponse.json();
  } catch {
    issuePayload = null;
  }

  if (!issueResponse.ok || !issuePayload?.ok) {
    return {
      ok: false,
      status: issueResponse.status || 409,
      error: issuePayload?.error || "download_link_issue_failed",
      message:
        issuePayload?.message ||
        "Download link could not be issued for retry.",
      issue_result: issuePayload,
    };
  }

  const recipientEmail = normaliseEmail(originalEvent.recipient_email);

  const documentTitle =
    metadata.document_title ||
    issuePayload.licence?.document_title ||
    issuePayload.licence?.document_id ||
    "RelayHub document";

  const landingUrl =
    issuePayload.download_link?.landing_url || issuePayload.download_link?.url;

  let emailResult;

  try {
    emailResult = await sendCdasDownloadLinkEmail(env, {
      recipientEmail,
      documentTitle,
      documentId: issuePayload.licence?.document_id,
      licenceNumber: issuePayload.licence?.licence_number,
      downloadUrl: landingUrl,
      expiresAt: issuePayload.download_link?.expires_at,
    });
  } catch (error) {
    emailResult = {
      ok: false,
      sent: false,
      provider: "resend",
      error: "download_link_retry_exception",
      message:
        error instanceof Error
          ? error.message
          : "Download link email retry failed unexpectedly.",
    };
  }

  await recordCdasEmailEvent(env, {
    relatedType: "licence",
    relatedId:
      issuePayload.licence?.id ||
      issuePayload.licence?.licence_id ||
      originalEvent.related_id,
    emailType: "download_link_email",
    recipientEmail,
    subject: `Your RelayHub download is ready: ${documentTitle}`,
    emailResult,
    metadata: {
      ...metadata,
      retry_of_event_id: originalEvent.id,
      retry_count: Number(originalEvent.retry_count || 0) + 1,
      retry_trigger: "manual_admin_retry",
      document_id: issuePayload.licence?.document_id,
      licence_number: issuePayload.licence?.licence_number,
      download_link_id: issuePayload.download_link?.id,
      download_link_expires_at: issuePayload.download_link?.expires_at,
      landing_url_emailed: true,
      raw_r2_url_exposed: false,
    },
  });

  return {
    ok: true,
    retried: true,
    email_result: emailResult,
    download_link: {
      id: issuePayload.download_link?.id,
      landing_url: landingUrl,
      expires_at: issuePayload.download_link?.expires_at,
    },
    related: {
      type: "licence",
      id:
        issuePayload.licence?.id ||
        issuePayload.licence?.licence_id ||
        originalEvent.related_id,
    },
  };
}

export async function retryCdasEmailEvent(request, env, eventId) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to retry a CDAS email event.",
      },
      405
    );
  }

  const originalEvent = await getEmailEvent(env, eventId);

  if (!originalEvent) {
    return jsonResponse(
      {
        ok: false,
        error: "email_event_not_found",
        message: "CDAS email event was not found.",
      },
      404
    );
  }

  if (!isRetryableEvent(originalEvent)) {
    return jsonResponse(
      {
        ok: false,
        error: "email_event_not_retryable",
        message:
          "Only unresolved failed or skipped email events marked retryable can be retried.",
        event: {
          id: originalEvent.id,
          status: originalEvent.status,
          retryable: Number(originalEvent.retryable || 0),
          resolved_at: originalEvent.resolved_at,
        },
      },
      409
    );
  }

  const metadata = parseMetadata(originalEvent.metadata_json);

  let result;

  if (originalEvent.email_type === "verification_email_resend") {
    result = await retryVerificationEmailResend({
      env,
      originalEvent,
      metadata,
    });
  } else if (originalEvent.email_type === "download_link_email") {
    result = await retryDownloadLinkEmail({
      request,
      env,
      originalEvent,
      metadata,
    });
  } else {
    return jsonResponse(
      {
        ok: false,
        error: "email_type_retry_not_supported",
        message:
          "Manual retry is currently supported for verification_email_resend and download_link_email events only.",
        event: {
          id: originalEvent.id,
          email_type: originalEvent.email_type,
        },
      },
      409
    );
  }

  if (!result.ok) {
    return jsonResponse(
      {
        ok: false,
        error: result.error || "email_retry_failed",
        message: result.message || "Email retry failed.",
        retry_of_event_id: originalEvent.id,
        result,
      },
      result.status || 409
    );
  }

  const retryStatus = statusFromEmailResult(result.email_result);

  if (retryStatus === "sent") {
    await env.RELAYHUB_DB.prepare(
      `UPDATE cdas_email_events
       SET
         resolved_at = ?,
         resolved_by = ?,
         resolution_note = ?
       WHERE id = ?
         AND resolved_at IS NULL`
    )
      .bind(
        nowIso(),
        "admin_retry",
        "Resolved by successful manual retry.",
        originalEvent.id
      )
      .run();
  }

  return jsonResponse({
    ok: true,
    retried: true,
    retry_of_event_id: originalEvent.id,
    original_event: {
      id: originalEvent.id,
      email_type: originalEvent.email_type,
      status: originalEvent.status,
      retry_count: originalEvent.retry_count,
    },
    retry_result: {
      status: retryStatus,
      provider: result.email_result?.provider || "resend",
      provider_message_id: result.email_result?.provider_message_id || null,
      sent: Boolean(result.email_result?.sent),
      skipped: Boolean(result.email_result?.skipped),
      error: result.email_result?.error || null,
      message: result.email_result?.message || null,
    },
    related: result.related,
    message:
      retryStatus === "sent"
        ? "Email event retry succeeded and the original event was marked resolved."
        : "Email event retry was attempted and recorded, but delivery did not succeed.",
  });
}