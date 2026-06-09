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
      { status: 405, headers: { allow: "GET" } }
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
      `(id LIKE ? OR document_id LIKE ? OR name LIKE ? OR email_normalised LIKE ? OR organisation_name LIKE ? OR recipient_category LIKE ?)`
    );

    const like = `%${q}%`;
    bindings.push(like, like, like, like, like, like);
  }

  if (documentId) {
    where.push("document_id = ?");
    bindings.push(documentId);
  }

  if (status) {
    where.push("status = ?");
    bindings.push(status);
  }

  if (accessClass) {
    where.push("access_class = ?");
    bindings.push(accessClass);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalResult = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM document_access_requests
     ${whereSql}`
  )
    .bind(...bindings)
    .first();

  const rowsResult = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       document_version,
       name,
       email_normalised,
       licence_holder_type,
       organisation_name,
       contact_name,
       contact_email,
       role_title,
       recipient_category,
       status,
       access_class,
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
       terms_acceptance_user_agent,
       user_agent,
       risk_score,
       risk_flags
     FROM document_access_requests
     ${whereSql}
     ORDER BY ${sort} ${direction}
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
      { status: 405, headers: { allow: "GET" } }
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
      { status: 400 }
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       *
     FROM document_access_requests
     WHERE id = ?
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
      { status: 404 }
    );
  }

  return jsonResponse({
    ok: true,
    request: normaliseRow(row),
  });
}