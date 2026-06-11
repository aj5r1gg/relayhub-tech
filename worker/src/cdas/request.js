import { sendCdasVerificationEmail } from "./email.js";
import { recordCdasEmailEvent } from "./email-events.js";
import { evaluateCdasRequestIntakePolicy } from "./request-intake-policy.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

const DEFAULT_VERIFICATION_EXPIRY_HOURS = 24;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function isValidEmail(value) {
  const email = normaliseEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function nowIso() {
  return new Date().toISOString();
}

function hoursFromNowIso(hours) {
  const date = new Date();
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function isExpiredIso(expiresAt) {
  if (!expiresAt) return false;

  const expiry = Date.parse(expiresAt);

  return !Number.isFinite(expiry) || expiry <= Date.now();
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

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    request.headers.get("X-Real-IP") ||
    ""
  );
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeRequestId() {
  return `dar_${Date.now().toString(36)}_${randomHex(8)}`;
}

function makeVerificationToken() {
  return randomHex(32);
}

function shouldExposeDebugVerificationToken(env) {
  return String(env.CDAS_DEBUG_RETURN_VERIFICATION_TOKEN || "")
    .trim()
    .toLowerCase() === "true";
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

async function readRequestBody(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    const body = {};

    for (const [key, value] of formData.entries()) {
      body[key] = typeof value === "string" ? value : value.name;
    }

    return body;
  }

  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function boolFromBody(value) {
  if (value === true) return true;
  if (value === false) return false;

  const text = cleanText(value).toLowerCase();

  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function getBodyValue(body, ...keys) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) {
      return body[key];
    }
  }

  return "";
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function getUseCaseFromBody(body) {
  return cleanText(
    getBodyValue(
      body,
      "use_case",
      "useCase",
      "access_reason",
      "accessReason",
      "purpose",
      "intended_use",
      "intendedUse"
    )
  );
}

function getOrganisationNameFromBody(body) {
  return cleanText(
    getBodyValue(body, "organisation_name", "organisationName", "organisation")
  );
}

function getRoleTitleFromBody(body) {
  return cleanText(getBodyValue(body, "role_title", "roleTitle"));
}

function getRecipientCategoryFromBody(body) {
  return (
    cleanText(getBodyValue(body, "recipient_category", "recipientCategory")) ||
    "unknown"
  );
}

function makePolicyBlockedResponse({ document, evaluation }) {
  return {
    ok: false,
    error: "request_blocked_by_policy",
    message:
      evaluation?.public_message ||
      "This document access request cannot be accepted at this time.",
    document: document
      ? {
          id: document.id,
          title: document.title,
          version: document.version,
        }
      : null,
    decision: evaluation?.decision || "hard_block",
    next_state: evaluation?.next_state || "not_created",
  };
}

async function getDocument(env, documentRef) {
  const ref = cleanText(documentRef);

  if (!ref) {
    return null;
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       classification,
       access_class,
       source_object,
       licence_terms_version,
       is_listed,
       requires_approval
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();

  return row || null;
}

function isDocumentRequestable(document) {
  if (!document) {
    return {
      ok: false,
      status: 404,
      error: "document_not_found",
      message: "The requested document was not found.",
    };
  }

  if (document.status !== "active") {
    return {
      ok: false,
      status: 409,
      error: "document_not_active",
      message: "This document is not currently available for access requests.",
    };
  }

  if (Number(document.is_listed) !== 1) {
    return {
      ok: false,
      status: 409,
      error: "document_not_listed",
      message: "This document is not currently listed for public access requests.",
    };
  }

  if (document.access_class === "disabled") {
    return {
      ok: false,
      status: 409,
      error: "document_access_disabled",
      message: "Access requests are disabled for this document.",
    };
  }

  if (!document.licence_terms_version) {
    return {
      ok: false,
      status: 409,
      error: "document_missing_terms",
      message: "This document does not have a licence terms version assigned.",
    };
  }

  return { ok: true };
}

function determineRequestStatus(document) {
  if (
    document.access_class === "approval_required" ||
    document.access_class === "invite_only" ||
    Number(document.requires_approval) === 1
  ) {
    return "approval_pending";
  }

  return "email_pending";
}

function calculateRisk({ email, body, document, request }) {
  const flags = [];
  let score = 0;

  const userAgent = request.headers.get("user-agent") || "";

  if (!userAgent) {
    score += 5;
    flags.push("missing_user_agent");
  }

  if (email.endsWith(".ru") || email.endsWith(".cn")) {
    score += 5;
    flags.push("higher_review_tld");
  }

  const organisationName = getOrganisationNameFromBody(body);

  if (
    document.access_class === "paid_verified" &&
    !cleanText(getBodyValue(body, "order_number", "orderNumber"))
  ) {
    score += 5;
    flags.push("paid_request_without_order_number");
  }

  if (
    document.access_class === "approval_required" &&
    !organisationName &&
    cleanText(getBodyValue(body, "licence_holder_type", "licenceHolderType")) ===
      "organisation"
  ) {
    score += 5;
    flags.push("organisation_request_without_organisation_name");
  }

  return {
    score,
    flags,
  };
}

async function getAccessInvitationForRequest(env, token) {
  const rawToken = cleanText(token);

  if (!rawToken) {
    return {
      ok: true,
      invitation: null,
    };
  }

  if (!rawToken.startsWith("rh_inv_")) {
    return {
      ok: false,
      status: 400,
      error: "invalid_invitation_token",
      message: "The invitation token is not valid.",
    };
  }

  const tokenHash = await sha256Hex(rawToken);

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_access_invitations
     WHERE token_hash = ?
     LIMIT 1`
  )
    .bind(tokenHash)
    .first();

  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "invitation_unavailable",
      message: "This invitation is invalid, expired, or no longer available.",
    };
  }

  if (row.status !== "active" || row.revoked_at || row.superseded_at) {
    return {
      ok: false,
      status: 404,
      error: "invitation_unavailable",
      message: "This invitation is invalid, expired, or no longer available.",
    };
  }

  if (isExpiredIso(row.expires_at)) {
    return {
      ok: false,
      status: 404,
      error: "invitation_unavailable",
      message: "This invitation is invalid, expired, or no longer available.",
    };
  }

  if (Number(row.use_count || 0) >= Number(row.max_uses || 0)) {
    return {
      ok: false,
      status: 404,
      error: "invitation_unavailable",
      message: "This invitation is invalid, expired, or no longer available.",
    };
  }

  return {
    ok: true,
    invitation: row,
  };
}

function validateInvitationAgainstRequest({
  invitation,
  document,
  emailNormalised,
}) {
  if (!invitation) {
    return { ok: true };
  }

  if (invitation.document_id !== document.id) {
    return {
      ok: false,
      status: 409,
      error: "invitation_document_mismatch",
      message: "This invitation is not valid for the selected document.",
    };
  }

  if (invitation.document_version !== document.version) {
    return {
      ok: false,
      status: 409,
      error: "invitation_document_version_mismatch",
      message: "This invitation is not valid for this document version.",
    };
  }

  const invitationType = cleanText(invitation.invitation_type).toLowerCase();

  if (
    (invitationType === "named" || invitationType === "purchase") &&
    invitation.recipient_email &&
    normaliseEmail(invitation.recipient_email) !== emailNormalised
  ) {
    return {
      ok: false,
      status: 403,
      error: "invitation_recipient_mismatch",
      message: "This invitation is restricted to a different recipient email.",
    };
  }

  return { ok: true };
}

async function consumeAccessInvitation(env, invitationId) {
  if (!invitationId) {
    return null;
  }

  const consumedAt = nowIso();

  const result = await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_invitations
     SET
       use_count = use_count + 1,
       last_used_at = ?,
       status = CASE
         WHEN use_count + 1 >= max_uses THEN 'used'
         ELSE status
       END
     WHERE id = ?
       AND status = 'active'
       AND revoked_at IS NULL
       AND superseded_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND use_count < max_uses`
  )
    .bind(consumedAt, invitationId, consumedAt)
    .run();

  return {
    consumed_at: consumedAt,
    changes: result?.meta?.changes ?? 0,
  };
}

async function insertAccessRequest({
  env,
  requestId,
  document,
  body,
  request,
  email,
  emailNormalised,
  status,
  ipHash,
  termsAccepted,
  risk,
  intakeEvaluation,
  verificationTokenHash,
  verificationExpiresAt,
  invitation,
  invitationUse,
}) {
  const timestamp = nowIso();

  const name = cleanText(getBodyValue(body, "name", "full_name", "fullName"));
  const licenceHolderType =
    cleanText(getBodyValue(body, "licence_holder_type", "licenceHolderType")) ||
    "individual";

  const organisationName = getOrganisationNameFromBody(body);

  const contactName =
    cleanText(getBodyValue(body, "contact_name", "contactName")) || name;

  const contactEmail =
    normaliseEmail(getBodyValue(body, "contact_email", "contactEmail")) ||
    emailNormalised;

  const roleTitle = cleanText(getBodyValue(body, "role_title", "roleTitle"));

  const recipientCategory = getRecipientCategoryFromBody(body);

  const userAgent = request.headers.get("user-agent") || "";

  const termsAcceptedAt = termsAccepted ? timestamp : null;
  const termsAcceptanceIpHash = termsAccepted ? ipHash : null;
  const termsAcceptanceUserAgent = termsAccepted ? userAgent : null;

  const emailDeliveryStatus = "verification_token_generated_email_not_sent";

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_access_requests (
       id,
       document_id,
       document_version,
       name,
       email,
       email_normalised,
       licence_holder_type,
       organisation_name,
       contact_name,
       contact_email,
       role_title,
       recipient_category,
       status,
       access_class,
       verification_token_hash,
       verification_sent_at,
       email_verified_at,
       email_delivery_status,
       requested_at,
       expires_at,
       approved_at,
       approved_by,
       approval_role,
       approval_policy_version,
       approval_note,
       denied_at,
       denied_by,
       denial_reason,
       terms_version,
       terms_accepted_at,
       terms_acceptance_ip_hash,
       terms_acceptance_user_agent,
       ip_hash,
       user_agent,
       risk_score,
       risk_flags,
       invitation_id,
       invitation_used_at
     )
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, NULL, NULL, ?,
       ?, ?,
       NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?
     )`
  )
    .bind(
      requestId,
      document.id,
      document.version,
      name || null,
      email,
      emailNormalised,
      licenceHolderType,
      organisationName || null,
      contactName || null,
      contactEmail || null,
      roleTitle || null,
      recipientCategory,
      status,
      document.access_class,
      verificationTokenHash,
      emailDeliveryStatus,
      timestamp,
      verificationExpiresAt,
      document.licence_terms_version,
      termsAcceptedAt,
      termsAcceptanceIpHash,
      termsAcceptanceUserAgent,
      ipHash,
      userAgent,
      risk.score,
      JSON.stringify(risk.flags),
      invitation?.id || null,
      invitationUse?.consumed_at || null
    )
    .run();

  return {
    requested_at: timestamp,
    terms_accepted_at: termsAcceptedAt,
    expires_at: verificationExpiresAt,
    email_delivery_status: emailDeliveryStatus,
    invitation_id: invitation?.id || null,
    invitation_used_at: invitationUse?.consumed_at || null,
  };
}

function getEmailDeliveryStatus(emailResult) {
  if (emailResult?.sent) {
    return "verification_email_sent";
  }

  if (emailResult?.skipped) {
    return "verification_email_disabled";
  }

  return "verification_email_failed";
}

async function updateVerificationEmailDelivery({
  env,
  requestId,
  emailResult,
}) {
  const emailDeliveryStatus = getEmailDeliveryStatus(emailResult);
  const verificationSentAt = emailResult?.sent ? nowIso() : null;

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       email_delivery_status = ?,
       verification_sent_at = COALESCE(?, verification_sent_at)
     WHERE id = ?`
  )
    .bind(emailDeliveryStatus, verificationSentAt, requestId)
    .run();

  return {
    email_delivery_status: emailDeliveryStatus,
    verification_sent_at: verificationSentAt,
  };
}

async function safelySendVerificationEmail({
  env,
  requestId,
  verificationToken,
  verificationUrl,
  recipientEmail,
  document,
}) {
  try {
    const result = await sendCdasVerificationEmail(env, {
      requestId,
      verificationToken,
      verificationUrl,
      recipientEmail,
      documentTitle: document.title,
      documentId: document.id,
    });

    const recorded = await updateVerificationEmailDelivery({
      env,
      requestId,
      emailResult: result,
    });

    return {
      ok: true,
      result,
      recorded,
    };
  } catch (error) {
    const result = {
      ok: false,
      sent: false,
      provider: "resend",
      error: "verification_email_exception",
      message:
        error instanceof Error
          ? error.message
          : "Verification email delivery failed unexpectedly.",
    };

    const recorded = await updateVerificationEmailDelivery({
      env,
      requestId,
      emailResult: result,
    });

    return {
      ok: false,
      result,
      recorded,
    };
    
    await recordCdasEmailEvent(env, {
      relatedType: "access_request",
      relatedId: requestId,
      emailType: "verification_email",
      recipientEmail: emailNormalised,
      subject: `Verify your email for ${document.title}`,
      emailResult: emailDelivery.result,
      metadata: {
        document_id: document.id,
        document_version: document.version,
        request_status: status,
      },
    });
  }
}

export async function handleDocumentAccessRequest(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to request access to a document.",
      },
      405
    );
  }

  let body;

  try {
    body = await readRequestBody(request);
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_request_body",
        message: "The request body could not be read.",
      },
      400
    );
  }

  const documentRef = cleanText(
    getBodyValue(body, "document_id", "documentId", "document", "slug")
  );

  const invitationToken = cleanText(
    getBodyValue(body, "invitation_token", "invitationToken")
  );

  const email = cleanText(getBodyValue(body, "email", "recipient_email"));
  const emailNormalised = normaliseEmail(email);
  const name = cleanText(getBodyValue(body, "name", "full_name", "fullName"));
  const termsAccepted = boolFromBody(
    getBodyValue(body, "terms_accepted", "termsAccepted")
  );

  if (!documentRef) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_document_id",
        message: "A document_id is required.",
      },
      400
    );
  }

  if (!name) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_name",
        message: "A name is required.",
      },
      400
    );
  }

  if (!isValidEmail(emailNormalised)) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_email",
        message: "A valid email address is required.",
      },
      400
    );
  }

  const document = await getDocument(env, documentRef);
  const requestable = isDocumentRequestable(document);

  if (!requestable.ok) {
    return jsonResponse(
      {
        ok: false,
        error: requestable.error,
        message: requestable.message,
      },
      requestable.status
    );
  }

  let invitation = null;

  if (invitationToken) {
    const invitationLookup = await getAccessInvitationForRequest(
      env,
      invitationToken
    );

    if (!invitationLookup.ok) {
      return jsonResponse(
        {
          ok: false,
          error: invitationLookup.error,
          message: invitationLookup.message,
        },
        invitationLookup.status
      );
    }

    invitation = invitationLookup.invitation;

    const invitationValidation = validateInvitationAgainstRequest({
      invitation,
      document,
      emailNormalised,
    });

    if (!invitationValidation.ok) {
      return jsonResponse(
        {
          ok: false,
          error: invitationValidation.error,
          message: invitationValidation.message,
        },
        invitationValidation.status
      );
    }
  }

  if (!termsAccepted) {
    return jsonResponse(
      {
        ok: false,
        error: "terms_not_accepted",
        message:
          "The current licence terms must be accepted before an access request can be recorded.",
        document: {
          id: document.id,
          title: document.title,
          version: document.version,
          licence_terms_version: document.licence_terms_version,
        },
      },
      400
    );
  }

  const clientIp = getClientIp(request);
  const ipHash = clientIp ? await sha256Hex(clientIp) : null;
  const userAgent = request.headers.get("user-agent") || "";

  const intakeEvaluation = await evaluateCdasRequestIntakePolicy(env, {
    document_id: document.id,
    document_version: document.version,
    name,
    email: emailNormalised,
    organisation_name: getOrganisationNameFromBody(body),
    role_title: getRoleTitleFromBody(body),
    recipient_category: getRecipientCategoryFromBody(body),
    use_case: getUseCaseFromBody(body),
    ip_hash: ipHash,
    user_agent: userAgent,
  });

  if (!intakeEvaluation.allowed) {
    return jsonResponse(
      makePolicyBlockedResponse({
        document,
        evaluation: intakeEvaluation,
      }),
      403
    );
  }

  let invitationUse = null;

  if (invitation) {
    invitationUse = await consumeAccessInvitation(env, invitation.id);

    if (!invitationUse || invitationUse.changes < 1) {
      return jsonResponse(
        {
          ok: false,
          error: "invitation_consumption_failed",
          message:
            "The invitation could not be consumed. It may have expired or already been used.",
        },
        409
      );
    }
  }

  const requestId = makeRequestId();
  const verificationToken = makeVerificationToken();
  const verificationTokenHash = await sha256Hex(verificationToken);
  const verificationExpiresAt = hoursFromNowIso(getVerificationExpiryHours(env));
  const verificationUrl = makeVerificationUrl(env, requestId, verificationToken);

  const status = intakeEvaluation.next_state || determineRequestStatus(document);
  const baselineRisk = calculateRisk({
    email: emailNormalised,
    body,
    document,
    request,
  });

  const policyRiskFlags = uniqueStrings([
    ...(intakeEvaluation.risk_flags || []).map((flag) => `policy_${flag}`),
    ...(intakeEvaluation.warnings || []).map((flag) => `policy_warning_${flag}`),
    ...(intakeEvaluation.manual_review_reasons || []).map(
      (flag) => `manual_review_${flag}`
    ),
  ]);

  const risk = {
    score: baselineRisk.score + policyRiskFlags.length,
    flags: uniqueStrings([...baselineRisk.flags, ...policyRiskFlags]),
  };

  const inserted = await insertAccessRequest({
    env,
    requestId,
    document,
    body,
    request,
    email,
    emailNormalised,
    status,
    ipHash,
    termsAccepted,
    risk,
    intakeEvaluation,
    verificationTokenHash,
    verificationExpiresAt,
    invitation,
    invitationUse,
  });

  const emailDelivery = await safelySendVerificationEmail({
    env,
    requestId,
    verificationToken,
    verificationUrl,
    recipientEmail: emailNormalised,
    document,
  });

  const responsePayload = {
    ok: true,
    request_id: requestId,
    document_id: document.id,
    document_title: document.title,
    document_version: document.version,
    access_class: document.access_class,
    classification: document.classification,
    status,
    request_intake_decision: intakeEvaluation.decision,
    request_intake_next_state: intakeEvaluation.next_state,
    request_intake_policy_id:
      intakeEvaluation.request_intake_policy?.id || null,
    terms_version: document.licence_terms_version,
    terms_accepted_at: inserted.terms_accepted_at,
    requested_at: inserted.requested_at,
    expires_at: inserted.expires_at,
    invitation_id: inserted.invitation_id,
    invitation_used_at: inserted.invitation_used_at,
    email_delivery_status:
      emailDelivery.recorded?.email_delivery_status ||
      inserted.email_delivery_status,
    verification_sent_at: emailDelivery.recorded?.verification_sent_at || null,
    risk_score: risk.score,
    risk_flags: risk.flags,
    message: emailDelivery.result?.sent
      ? "Document access request was recorded for manual review. A verification email has been sent."
      : emailDelivery.result?.skipped
        ? "Document access request was recorded for manual review. Verification email sending is currently disabled."
        : "Document access request was recorded for manual review, but the verification email could not be sent. The request has been preserved for follow-up.",
  };

  /*
   * Development-only escape hatch.
   *
   * Do not enable this in normal production use. It exists only so the
   * verification flow can be tested without relying on inbox delivery.
   */
  if (shouldExposeDebugVerificationToken(env)) {
    responsePayload.debug_verification = {
      token: verificationToken,
      verification_url: verificationUrl,
    };
  }

  return jsonResponse(responsePayload, 201);
}