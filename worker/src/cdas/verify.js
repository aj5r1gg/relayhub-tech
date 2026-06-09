import { issueLicenceForVerifiedRequest } from "./licence-issue.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

function getBodyValue(body, ...keys) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) {
      return body[key];
    }
  }

  return "";
}

async function getAccessRequest(env, requestId) {
  const id = cleanText(requestId);

  if (!id) {
    return null;
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       document_version,
       name,
       email,
       email_normalised,
       licence_holder_type,
       organisation_name,
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
       denied_at,
       terms_version
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  return row || null;
}

function isExpired(expiresAt) {
  if (!expiresAt) {
    return true;
  }

  const expiry = new Date(expiresAt);

  if (Number.isNaN(expiry.getTime())) {
    return true;
  }

  return expiry.getTime() < Date.now();
}

function nextVerifiedStatus(row) {
  if (
    row.access_class === "approval_required" ||
    row.access_class === "invite_only" ||
    row.status === "approval_pending"
  ) {
    return "approval_pending";
  }

  return "email_verified";
}

function canVerifyStatus(row) {
  if (!row) {
    return false;
  }

  if (row.denied_at) {
    return false;
  }

  if (row.status === "denied" || row.status === "cancelled") {
    return false;
  }

  if (row.email_verified_at) {
    return true;
  }

  return row.status === "email_pending" || row.status === "approval_pending";
}

async function getExistingLicenceByRequestId(env, requestId) {
  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       licence_number,
       request_id,
       document_id,
       document_version,
       licence_holder_email_normalised,
       status,
       issued_at
     FROM document_licences
     WHERE request_id = ?
     LIMIT 1`
  )
    .bind(requestId)
    .first();

  return row || null;
}

export async function handleDocumentAccessVerify(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to verify a document access request.",
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
        message: "The verification request body could not be read.",
      },
      400
    );
  }

  const requestId = cleanText(
    getBodyValue(body, "request_id", "requestId", "id")
  );

  const token = cleanText(
    getBodyValue(body, "token", "verification_token", "verificationToken")
  );

  if (!requestId) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_request_id",
        message: "A request_id is required.",
      },
      400
    );
  }

  if (!token) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_token",
        message: "A verification token is required.",
      },
      400
    );
  }

  const row = await getAccessRequest(env, requestId);

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "request_not_found",
        message: "The access request could not be found.",
      },
      404
    );
  }

  if (!canVerifyStatus(row)) {
    return jsonResponse(
      {
        ok: false,
        error: "request_not_verifiable",
        message: "This access request is not in a verifiable state.",
        request: {
          id: row.id,
          status: row.status,
          document_id: row.document_id,
        },
      },
      409
    );
  }

  if (row.email_verified_at) {
    const existingLicence = await getExistingLicenceByRequestId(env, row.id);

    return jsonResponse({
      ok: true,
      already_verified: true,
      request_id: row.id,
      document_id: row.document_id,
      document_version: row.document_version,
      email_normalised: row.email_normalised,
      status: row.status,
      email_verified_at: row.email_verified_at,
      licence: existingLicence || null,
      licence_issued: Boolean(existingLicence),
      message: existingLicence
        ? "This email address was already verified and a licence record already exists."
        : "This email address was already verified for the access request.",
    });
  }

  if (!row.verification_token_hash) {
    return jsonResponse(
      {
        ok: false,
        error: "verification_token_not_available",
        message: "This access request does not currently have a verification token.",
      },
      409
    );
  }

  if (isExpired(row.expires_at)) {
    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET
         status = CASE
           WHEN status IN ('email_pending', 'approval_pending') THEN 'expired'
           ELSE status
         END,
         verification_token_hash = NULL
       WHERE id = ?`
    )
      .bind(row.id)
      .run();

    return jsonResponse(
      {
        ok: false,
        error: "verification_token_expired",
        message: "The verification token has expired.",
        request_id: row.id,
        expired_at: row.expires_at,
      },
      410
    );
  }

  const suppliedHash = await sha256Hex(token);

  if (suppliedHash !== row.verification_token_hash) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_verification_token",
        message: "The verification token is invalid.",
      },
      401
    );
  }

  const verifiedAt = nowIso();
  const nextStatus = nextVerifiedStatus(row);

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       email_verified_at = ?,
       status = ?,
       verification_token_hash = NULL,
       email_delivery_status = CASE
         WHEN email_delivery_status IS NULL THEN 'verified'
         ELSE email_delivery_status || ';verified'
       END
     WHERE id = ?`
  )
    .bind(verifiedAt, nextStatus, row.id)
    .run();

  let licenceIssue = {
    ok: false,
    issued: false,
    skipped: true,
    reason: "approval_required_or_not_eligible",
  };

  if (nextStatus === "email_verified") {
    licenceIssue = await issueLicenceForVerifiedRequest(env, row.id);
  }

  const finalStatus = licenceIssue?.issued || licenceIssue?.already_issued
    ? "licence_issued"
    : nextStatus;

  return jsonResponse({
    ok: true,
    request_id: row.id,
    document_id: row.document_id,
    document_version: row.document_version,
    email_normalised: row.email_normalised,
    previous_status: row.status,
    status: finalStatus,
    email_verified_at: verifiedAt,
    licence_issued: Boolean(licenceIssue?.issued || licenceIssue?.already_issued),
    licence: licenceIssue?.licence || null,
    licence_issue_result: {
      ok: Boolean(licenceIssue?.ok),
      issued: Boolean(licenceIssue?.issued),
      already_issued: Boolean(licenceIssue?.already_issued),
      skipped: Boolean(licenceIssue?.skipped),
      error: licenceIssue?.error || null,
      message: licenceIssue?.message || null,
    },
    message:
      "Email verification succeeded. Licence record creation has been attempted. PDF generation and download issuance are not active yet.",
  });
}