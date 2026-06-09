import { jsonResponse } from "../shared.js";

const DEFAULT_INVITATION_EXPIRY_HOURS = 24;
const MAX_INVITATION_EXPIRY_HOURS = 24 * 365;
const MAX_INVITATION_USES = 10000;

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

function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeInvitationId() {
  return `inv_${Date.now().toString(36)}_${randomHex(8)}`;
}

function makeAuditId() {
  return `audit_${Date.now().toString(36)}_${randomHex(8)}`;
}

function makeInvitationToken() {
  return `rh_inv_${randomHex(32)}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    request.headers.get("X-Real-IP") ||
    ""
  );
}

function getPublicBaseUrl(env) {
  return (
    cleanText(env.CDAS_PUBLIC_BASE_URL) ||
    cleanText(env.RELAYHUB_PUBLIC_BASE_URL) ||
    "https://www.relayhub.tech"
  );
}

function makeInvitationUrl(env, token) {
  const base = getPublicBaseUrl(env).replace(/\/+$/, "");
  return `${base}/access/${encodeURIComponent(token)}`;
}

async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function parsePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parseInvitationType(value) {
  const type = cleanText(value || "public").toLowerCase();

  const allowed = new Set([
    "public",
    "named",
    "partner",
    "purchase",
    "admin",
  ]);

  return allowed.has(type) ? type : "public";
}

async function getDocument(env, documentRef) {
  const ref = cleanText(documentRef);

  if (!ref) {
    return null;
  }

  return await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       classification,
       access_class,
       licence_terms_version
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

function validateDocumentForInvitation(document) {
  if (!document) {
    return {
      ok: false,
      status: 404,
      error: "document_not_found",
      message: "The requested document was not found.",
    };
  }

  if (document.status === "disabled" || document.access_class === "disabled") {
    return {
      ok: false,
      status: 409,
      error: "document_access_disabled",
      message: "Invitations cannot be issued for a disabled document.",
    };
  }

  if (document.status === "withdrawn") {
    return {
      ok: false,
      status: 409,
      error: "document_withdrawn",
      message: "Invitations cannot be issued for a withdrawn document.",
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

async function recordAdminAuditEvent({
  request,
  env,
  action,
  targetType,
  targetId,
  beforeJson = null,
  afterJson = null,
  reason = null,
  adminIdentity = "admin",
}) {
  try {
    const clientIp = getClientIp(request);
    const ipHash = clientIp ? await sha256Hex(clientIp) : null;
    const userAgent = request.headers.get("user-agent") || "";

    await env.RELAYHUB_DB.prepare(
      `INSERT INTO admin_audit_events (
         id,
         admin_identity,
         action,
         target_type,
         target_id,
         before_json,
         after_json,
         reason,
         created_at,
         ip_hash,
         user_agent
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        makeAuditId(),
        adminIdentity,
        action,
        targetType,
        targetId,
        beforeJson ? JSON.stringify(beforeJson) : null,
        afterJson ? JSON.stringify(afterJson) : null,
        reason,
        nowIso(),
        ipHash,
        userAgent
      )
      .run();
  } catch {
    /*
     * Audit logging must not break the admin action response.
     * The primary invitation record remains the source of truth.
     */
  }
}

function publicInvitationRow(row) {
  return {
    id: row.id,
    document_id: row.document_id,
    document_version: row.document_version,
    invitation_type: row.invitation_type,
    status: row.status,
    recipient_email: row.recipient_email,
    recipient_name: row.recipient_name,
    max_uses: row.max_uses,
    use_count: row.use_count,
    created_at: row.created_at,
    created_by: row.created_by,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by,
    revocation_reason: row.revocation_reason,
    superseded_at: row.superseded_at,
    superseded_by: row.superseded_by,
    notes: row.notes,
    metadata_json: row.metadata_json,
    document_title: row.document_title,
    document_slug: row.document_slug,
    document_status: row.document_status,
    classification: row.classification,
    access_class: row.access_class,
  };
}

export async function createCdasAccessInvitation(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to create an access invitation.",
      },
      405
    );
  }

  const body = await readJsonBody(request);

  const documentRef = cleanText(
    body.document_id || body.documentId || body.document || body.slug
  );

  const document = await getDocument(env, documentRef);
  const validation = validateDocumentForInvitation(document);

  if (!validation.ok) {
    return jsonResponse(
      {
        ok: false,
        error: validation.error,
        message: validation.message,
      },
      validation.status
    );
  }

  const invitationType = parseInvitationType(
    body.invitation_type || body.invitationType
  );

  const recipientEmail = normaliseEmail(
    body.recipient_email || body.recipientEmail || ""
  );

  const recipientName = cleanText(
    body.recipient_name || body.recipientName || ""
  );

  if ((invitationType === "named" || invitationType === "purchase") && !recipientEmail) {
    return jsonResponse(
      {
        ok: false,
        error: "recipient_email_required",
        message: "A recipient email is required for named or purchase invitations.",
      },
      400
    );
  }

  if (recipientEmail && !isValidEmail(recipientEmail)) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_recipient_email",
        message: "Recipient email must be a valid email address.",
      },
      400
    );
  }

  const maxUses = parsePositiveInteger(
    body.max_uses || body.maxUses,
    1,
    MAX_INVITATION_USES
  );

  const expiresAt = cleanText(body.expires_at || body.expiresAt) ||
    hoursFromNowIso(
      parsePositiveInteger(
        body.expires_in_hours || body.expiresInHours,
        DEFAULT_INVITATION_EXPIRY_HOURS,
        MAX_INVITATION_EXPIRY_HOURS
      )
    );

  const createdBy = cleanText(body.created_by || body.createdBy) || "admin";
  const notes = cleanText(body.notes || "");
  const metadataJson =
    body.metadata_json !== undefined
      ? cleanText(body.metadata_json)
      : body.metadata !== undefined
        ? JSON.stringify(body.metadata)
        : null;

  const invitationId = makeInvitationId();
  const token = makeInvitationToken();
  const tokenHash = await sha256Hex(token);
  const createdAt = nowIso();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_access_invitations (
       id,
       token_hash,
       document_id,
       document_version,
       invitation_type,
       status,
       recipient_email,
       recipient_name,
       max_uses,
       use_count,
       created_at,
       created_by,
       expires_at,
       last_used_at,
       revoked_at,
       revoked_by,
       revocation_reason,
       superseded_at,
       superseded_by,
       notes,
       metadata_json
     )
     VALUES (
       ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, ?, ?, ?, NULL,
       NULL, NULL, NULL, NULL, NULL, ?, ?
     )`
  )
    .bind(
      invitationId,
      tokenHash,
      document.id,
      document.version,
      invitationType,
      recipientEmail || null,
      recipientName || null,
      maxUses,
      createdAt,
      createdBy,
      expiresAt,
      notes || null,
      metadataJson
    )
    .run();

  await recordAdminAuditEvent({
    request,
    env,
    action: "invitation_created",
    targetType: "document_access_invitation",
    targetId: invitationId,
    afterJson: {
      id: invitationId,
      document_id: document.id,
      document_version: document.version,
      invitation_type: invitationType,
      status: "active",
      recipient_email: recipientEmail || null,
      recipient_name: recipientName || null,
      max_uses: maxUses,
      expires_at: expiresAt,
      created_by: createdBy,
    },
    reason: notes || null,
    adminIdentity: createdBy,
  });

  return jsonResponse(
    {
      ok: true,
      invitation: {
        id: invitationId,
        document_id: document.id,
        document_title: document.title,
        document_version: document.version,
        invitation_type: invitationType,
        status: "active",
        recipient_email: recipientEmail || null,
        recipient_name: recipientName || null,
        max_uses: maxUses,
        use_count: 0,
        created_at: createdAt,
        created_by: createdBy,
        expires_at: expiresAt,
        notes: notes || null,
      },
      /*
       * Raw token is returned once at creation time only.
       * It is not stored in D1.
       */
      token,
      invitation_url: makeInvitationUrl(env, token),
    },
    201
  );
}

export async function listCdasAccessInvitations(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to list access invitations.",
      },
      405
    );
  }

  const url = new URL(request.url);
  const status = cleanText(url.searchParams.get("status"));
  const documentId = cleanText(url.searchParams.get("document_id"));
  const limit = parsePositiveInteger(url.searchParams.get("limit"), 50, 200);

  const conditions = [];
  const bindings = [];

  if (status) {
    conditions.push("i.status = ?");
    bindings.push(status);
  }

  if (documentId) {
    conditions.push("i.document_id = ?");
    bindings.push(documentId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const results = await env.RELAYHUB_DB.prepare(
    `SELECT
       i.*,
       d.title AS document_title,
       d.slug AS document_slug,
       d.status AS document_status,
       d.classification,
       d.access_class
     FROM document_access_invitations i
     LEFT JOIN documents d
       ON d.id = i.document_id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ?`
  )
    .bind(...bindings, limit)
    .all();

  return jsonResponse({
    ok: true,
    invitations: (results.results || []).map(publicInvitationRow),
  });
}

export async function getCdasAccessInvitation(request, env, invitationId) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to inspect an access invitation.",
      },
      405
    );
  }

  const id = cleanText(invitationId);

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       i.*,
       d.title AS document_title,
       d.slug AS document_slug,
       d.status AS document_status,
       d.classification,
       d.access_class
     FROM document_access_invitations i
     LEFT JOIN documents d
       ON d.id = i.document_id
     WHERE i.id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "invitation_not_found",
        message: "Access invitation was not found.",
      },
      404
    );
  }

  return jsonResponse({
    ok: true,
    invitation: publicInvitationRow(row),
  });
}