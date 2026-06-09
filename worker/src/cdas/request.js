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
  return cleanText(env.RELAYHUB_PUBLIC_BASE_URL) || "https://www.relayhub.tech";
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

  const organisationName = cleanText(
    getBodyValue(body, "organisation_name", "organisationName", "organisation")
  );

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
  verificationTokenHash,
  verificationExpiresAt,
}) {
  const timestamp = nowIso();

  const name = cleanText(getBodyValue(body, "name", "full_name", "fullName"));
  const licenceHolderType =
    cleanText(getBodyValue(body, "licence_holder_type", "licenceHolderType")) ||
    "individual";

  const organisationName = cleanText(
    getBodyValue(body, "organisation_name", "organisationName", "organisation")
  );

  const contactName =
    cleanText(getBodyValue(body, "contact_name", "contactName")) || name;

  const contactEmail =
    normaliseEmail(getBodyValue(body, "contact_email", "contactEmail")) ||
    emailNormalised;

  const roleTitle = cleanText(getBodyValue(body, "role_title", "roleTitle"));

  const recipientCategory =
    cleanText(getBodyValue(body, "recipient_category", "recipientCategory")) ||
    "unknown";

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
       risk_flags
     )
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, NULL, NULL, ?,
       ?, ?,
       NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL,
       ?, ?, ?, ?,
       ?, ?, ?, ?
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
      JSON.stringify(risk.flags)
    )
    .run();

  return {
    requested_at: timestamp,
    terms_accepted_at: termsAcceptedAt,
    expires_at: verificationExpiresAt,
    email_delivery_status: emailDeliveryStatus,
  };
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
  const requestId = makeRequestId();
  const verificationToken = makeVerificationToken();
  const verificationTokenHash = await sha256Hex(verificationToken);
  const verificationExpiresAt = hoursFromNowIso(getVerificationExpiryHours(env));

  const status = determineRequestStatus(document);
  const risk = calculateRisk({
    email: emailNormalised,
    body,
    document,
    request,
  });

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
    verificationTokenHash,
    verificationExpiresAt,
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
    terms_version: document.licence_terms_version,
    terms_accepted_at: inserted.terms_accepted_at,
    requested_at: inserted.requested_at,
    expires_at: inserted.expires_at,
    email_delivery_status: inserted.email_delivery_status,
    risk_score: risk.score,
    risk_flags: risk.flags,
    message:
      "Document access request was recorded. A verification token was generated, but email sending and download issuance are not active yet.",
  };

  /*
   * Development-only escape hatch.
   *
   * Do not enable this in normal production use. It exists only so the next
   * verification phase can be tested before email delivery is connected.
   */
  if (shouldExposeDebugVerificationToken(env)) {
    responsePayload.debug_verification = {
      token: verificationToken,
      verification_url: makeVerificationUrl(env, requestId, verificationToken),
    };
  }

  return jsonResponse(responsePayload, 201);
}