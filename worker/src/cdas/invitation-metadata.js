import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function nowIso() {
  return new Date().toISOString();
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;

  const expiry = Date.parse(expiresAt);

  if (!Number.isFinite(expiry)) {
    return true;
  }

  return expiry <= Date.now();
}

function unavailableResponse() {
  return jsonResponse(
    {
      ok: false,
      error: "invitation_unavailable",
      message: "This invitation is invalid, expired, or no longer available.",
    },
    404
  );
}

function safeDocumentStatus(documentStatus, accessClass) {
  if (documentStatus !== "active") return false;
  if (accessClass === "disabled") return false;

  return true;
}

function makeRecipientRequirement(invitation) {
  const type = invitation.invitation_type;

  if (type === "named" || type === "purchase") {
    return {
      recipient_locked: true,
      recipient_email_required: true,
      recipient_name_required: false,
    };
  }

  return {
    recipient_locked: false,
    recipient_email_required: true,
    recipient_name_required: true,
  };
}

export async function handleCdasAccessInvitationMetadata(request, env, token) {
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

  const rawToken = cleanText(token);

  if (!rawToken || !rawToken.startsWith("rh_inv_")) {
    return unavailableResponse();
  }

  const tokenHash = await sha256Hex(rawToken);

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       i.id,
       i.document_id,
       i.document_version,
       i.invitation_type,
       i.status,
       i.recipient_email,
       i.recipient_name,
       i.max_uses,
       i.use_count,
       i.created_at,
       i.expires_at,
       i.last_used_at,
       i.revoked_at,
       i.superseded_at,
       i.notes,
       d.slug AS document_slug,
       d.title AS document_title,
       d.status AS document_status,
       d.classification,
       d.access_class,
       d.licence_terms_version,
       d.is_listed,
       d.requires_approval
     FROM document_access_invitations i
     LEFT JOIN documents d
       ON d.id = i.document_id
     WHERE i.token_hash = ?
     LIMIT 1`
  )
    .bind(tokenHash)
    .first();

  if (!row) {
    return unavailableResponse();
  }

  if (row.status !== "active") {
    return unavailableResponse();
  }

  if (row.revoked_at || row.superseded_at) {
    return unavailableResponse();
  }

  if (isExpired(row.expires_at)) {
    return unavailableResponse();
  }

  if (Number(row.use_count || 0) >= Number(row.max_uses || 0)) {
    return unavailableResponse();
  }

  if (!safeDocumentStatus(row.document_status, row.access_class)) {
    return unavailableResponse();
  }

  if (!row.licence_terms_version) {
    return unavailableResponse();
  }

  const recipient = makeRecipientRequirement(row);

  return jsonResponse({
    ok: true,
    invitation: {
      id: row.id,
      invitation_type: row.invitation_type,
      status: row.status,
      created_at: row.created_at,
      expires_at: row.expires_at,
      max_uses: row.max_uses,
      use_count: row.use_count,
      remaining_uses: Math.max(
        0,
        Number(row.max_uses || 0) - Number(row.use_count || 0)
      ),
      checked_at: nowIso(),
    },
    document: {
      id: row.document_id,
      slug: row.document_slug,
      title: row.document_title,
      version: row.document_version,
      classification: row.classification,
      access_class: row.access_class,
      licence_terms_version: row.licence_terms_version,
      requires_approval: Number(row.requires_approval) === 1,
    },
    recipient,
    next_step: {
      action: "complete_document_access_request",
      endpoint: "/api/document-access/request",
      method: "POST",
    },
  });
}