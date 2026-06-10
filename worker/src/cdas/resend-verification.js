import { jsonResponse } from "../shared.js";
import { sendCdasVerificationEmail } from "./email.js";
import { recordCdasEmailEvent } from "./email-events.js";

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

function emailDeliveryStatusFromResult(result) {
  if (result?.sent) return "verification_email_resent";
  if (result?.skipped) return "verification_email_resend_disabled";
  return "verification_email_resend_failed";
}

function isResendAllowed(row) {
  if (!row) return false;
  if (row.email_verified_at) return false;

  const blockedStatuses = new Set([
    "licence_issued",
    "denied",
    "expired",
    "cancelled",
  ]);

  return !blockedStatuses.has(row.status);
}

export async function resendCdasAccessRequestVerification(
  request,
  env,
  requestId
) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to resend a verification email.",
      },
      405
    );
  }

  const id = cleanText(requestId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_request_id",
        message: "Access request ID is required.",
      },
      400
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       r.id,
       r.document_id,
       r.document_version,
       r.email,
       r.email_normalised,
       r.status,
       r.email_verified_at,
       r.email_delivery_status,
       r.expires_at,
       d.title AS document_title
     FROM document_access_requests r
     LEFT JOIN documents d
       ON d.id = r.document_id
     WHERE r.id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "access_request_not_found",
        message: "CDAS access request was not found.",
      },
      404
    );
  }

  if (!isResendAllowed(row)) {
    return jsonResponse(
      {
        ok: false,
        error: "verification_resend_not_allowed",
        message:
          "Verification email cannot be resent for this access request state.",
        request: {
          id: row.id,
          status: row.status,
          email_verified_at: row.email_verified_at,
          email_delivery_status: row.email_delivery_status,
        },
      },
      409
    );
  }

  const previousEmailDeliveryStatus = row.email_delivery_status;
  const verificationToken = makeVerificationToken();
  const verificationTokenHash = await sha256Hex(verificationToken);
  const expiresAt = hoursFromNowIso(getVerificationExpiryHours(env));
  const verificationUrl = makeVerificationUrl(env, row.id, verificationToken);
  const recipientEmail = normaliseEmail(row.email_normalised || row.email);
  const documentTitle = row.document_title || row.document_id;

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
      "verification_email_resend_prepared",
      row.id
    )
    .run();

  let emailResult;

  try {
    emailResult = await sendCdasVerificationEmail(env, {
      requestId: row.id,
      verificationToken,
      verificationUrl,
      recipientEmail,
      documentTitle,
      documentId: row.document_id,
    });
  } catch (error) {
    emailResult = {
      ok: false,
      sent: false,
      provider: "resend",
      error: "verification_resend_exception",
      message:
        error instanceof Error
          ? error.message
          : "Verification resend failed unexpectedly.",
    };
  }

  const emailDeliveryStatus = emailDeliveryStatusFromResult(emailResult);
  const verificationSentAt = emailResult?.sent ? nowIso() : null;

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       email_delivery_status = ?,
       verification_sent_at = COALESCE(?, verification_sent_at)
     WHERE id = ?`
  )
    .bind(emailDeliveryStatus, verificationSentAt, row.id)
    .run();

  await recordCdasEmailEvent(env, {
    relatedType: "access_request",
    relatedId: row.id,
    emailType: "verification_email_resend",
    recipientEmail,
    subject: `Verify your email for ${documentTitle}`,
    emailResult,
    metadata: {
      document_id: row.document_id,
      document_version: row.document_version,
      previous_email_delivery_status: previousEmailDeliveryStatus,
      expires_at: expiresAt,
    },
  });

  return jsonResponse({
    ok: true,
    request_id: row.id,
    document_id: row.document_id,
    recipient_email: recipientEmail,
    expires_at: expiresAt,
    verification_sent_at: verificationSentAt,
    email_delivery_status: emailDeliveryStatus,
    email_result: {
      ok: emailResult.ok,
      sent: emailResult.sent,
      skipped: emailResult.skipped || false,
      provider: emailResult.provider || "resend",
      provider_message_id: emailResult.provider_message_id || null,
      error: emailResult.error || null,
      message: emailResult.message || null,
    },
    message: emailResult?.sent
      ? "Verification email resent."
      : emailResult?.skipped
        ? "Verification resend prepared, but email sending is disabled."
        : "Verification resend was prepared, but email delivery failed.",
  });
}