import { jsonResponse } from "../shared.js";

const ALLOWED_SORT_FIELDS = new Set([
  "requested_at",
  "status",
  "document_id",
  "email_normalised",
  "access_class",
  "risk_score",
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function normaliseDirection(value) {
  return cleanText(value).toLowerCase() === "asc" ? "asc" : "desc";
}

function normaliseSort(value) {
  const sort = cleanText(value);

  if (ALLOWED_SORT_FIELDS.has(sort)) {
    return sort;
  }

  return "requested_at";
}

function parseRiskFlags(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normaliseRow(row) {
  return {
    ...row,
    risk_flags: parseRiskFlags(row.risk_flags),
  };
}

export async function listCdasAccessRequests(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to list CDAS access requests.",
      },
      405
    );
  }

  const url = new URL(request.url);

  const q = cleanText(url.searchParams.get("q"));
  const documentId = cleanText(url.searchParams.get("document_id"));
  const status = cleanText(url.searchParams.get("status"));
  const accessClass = cleanText(url.searchParams.get("access_class"));
  const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 200);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0, 100000);
  const sort = normaliseSort(url.searchParams.get("sort"));
  const direction = normaliseDirection(url.searchParams.get("direction"));

  const where = [];
  const bindings = [];

  if (q) {
    where.push(
      `(r.id LIKE ? OR r.document_id LIKE ? OR r.name LIKE ? OR r.email_normalised LIKE ? OR r.organisation_name LIKE ? OR r.recipient_category LIKE ? OR r.invitation_id LIKE ?)`
    );

    const like = `%${q}%`;
    bindings.push(like, like, like, like, like, like, like);
  }

  if (documentId) {
    where.push("r.document_id = ?");
    bindings.push(documentId);
  }

  if (status) {
    where.push("r.status = ?");
    bindings.push(status);
  }

  if (accessClass) {
    where.push("r.access_class = ?");
    bindings.push(accessClass);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalResult = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM document_access_requests r
     ${whereSql}`
  )
    .bind(...bindings)
    .first();

  const rowsResult = await env.RELAYHUB_DB.prepare(
    `SELECT
       r.id,
       r.document_id,
       r.document_version,
       r.name,
       r.email_normalised,
       r.licence_holder_type,
       r.organisation_name,
       r.contact_name,
       r.contact_email,
       r.role_title,
       r.recipient_category,
       r.status,
       r.access_class,
       r.verification_sent_at,
       r.email_verified_at,
       r.email_delivery_status,
       r.requested_at,
       r.expires_at,
       r.approved_at,
       r.approved_by,
       r.approval_role,
       r.approval_policy_version,
       r.approval_note,
       r.denied_at,
       r.denied_by,
       r.denial_reason,
       r.terms_version,
       r.terms_accepted_at,
       r.terms_acceptance_user_agent,
       r.user_agent,
       r.risk_score,
       r.risk_flags,
       r.invitation_id,
       r.invitation_used_at,
       i.invitation_type,
       i.status AS invitation_status,
       i.max_uses AS invitation_max_uses,
       i.use_count AS invitation_use_count,
       i.created_at AS invitation_created_at,
       i.created_by AS invitation_created_by,
       i.expires_at AS invitation_expires_at,
       i.last_used_at AS invitation_last_used_at,
       i.revoked_at AS invitation_revoked_at,
       i.revoked_by AS invitation_revoked_by,
       i.revocation_reason AS invitation_revocation_reason,
       i.notes AS invitation_notes
     FROM document_access_requests r
     LEFT JOIN document_access_invitations i
       ON i.id = r.invitation_id
     ${whereSql}
     ORDER BY r.${sort} ${direction}
     LIMIT ?
     OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all();

  return jsonResponse({
    ok: true,
    total: Number(totalResult?.total || 0),
    limit,
    offset,
    sort,
    direction,
    filters: {
      q: q || null,
      document_id: documentId || null,
      status: status || null,
      access_class: accessClass || null,
    },
    rows: Array.isArray(rowsResult?.results)
      ? rowsResult.results.map(normaliseRow)
      : [],
  });
}

export async function getCdasAccessRequest(request, env, requestId) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to read a CDAS access request.",
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
       r.*,
       i.invitation_type,
       i.status AS invitation_status,
       i.max_uses AS invitation_max_uses,
       i.use_count AS invitation_use_count,
       i.created_at AS invitation_created_at,
       i.created_by AS invitation_created_by,
       i.expires_at AS invitation_expires_at,
       i.last_used_at AS invitation_last_used_at,
       i.revoked_at AS invitation_revoked_at,
       i.revoked_by AS invitation_revoked_by,
       i.revocation_reason AS invitation_revocation_reason,
       i.notes AS invitation_notes
     FROM document_access_requests r
     LEFT JOIN document_access_invitations i
       ON i.id = r.invitation_id
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

  return jsonResponse({
    ok: true,
    request: normaliseRow(row),
  });
}