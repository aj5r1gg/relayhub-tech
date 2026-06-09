import { jsonResponse } from "../shared.js";

const ALLOWED_SORT_FIELDS = new Set([
  "issued_at",
  "licence_number",
  "document_id",
  "licence_holder_email_normalised",
  "status",
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

  return "issued_at";
}

export async function listCdasLicences(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to list CDAS licences.",
      },
      { status: 405, headers: { allow: "GET" } }
    );
  }

  const url = new URL(request.url);

  const q = cleanText(url.searchParams.get("q"));
  const documentId = cleanText(url.searchParams.get("document_id"));
  const status = cleanText(url.searchParams.get("status"));
  const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 200);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0, 100000);
  const sort = normaliseSort(url.searchParams.get("sort"));
  const direction = normaliseDirection(url.searchParams.get("direction"));

  const where = [];
  const bindings = [];

  if (q) {
    where.push(
      `(id LIKE ? OR licence_number LIKE ? OR request_id LIKE ? OR document_id LIKE ? OR licence_holder_name LIKE ? OR organisation_name LIKE ? OR licence_holder_email_normalised LIKE ?)`
    );

    const like = `%${q}%`;
    bindings.push(like, like, like, like, like, like, like);
  }

  if (documentId) {
    where.push("document_id = ?");
    bindings.push(documentId);
  }

  if (status) {
    where.push("status = ?");
    bindings.push(status);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalResult = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM document_licences
     ${whereSql}`
  )
    .bind(...bindings)
    .first();

  const rowsResult = await env.RELAYHUB_DB.prepare(
    `SELECT
      id,
      licence_number,
      request_id,
      document_id,
      document_version,
      licence_holder_type,
      licence_holder_name,
      organisation_name,
      contact_name,
      contact_email,
      licence_holder_email,
      licence_holder_email_normalised,
      recipient_category,
      licence_terms_version,
      status,
      issued_at,
      expires_at,
      revoked_at,
      revoked_by,
      revocation_reason,
      superseded_by,
      corrected_from,
      suspected_leak_at,
      confirmed_leak_at,
      notes,
      rendered_licence_sha256,
      rendered_terms_body_sha256,
      rendered_licence_at
    FROM document_licences
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
    },
    rows: Array.isArray(rowsResult?.results) ? rowsResult.results : [],
  });
}

export async function getCdasLicence(request, env, licenceIdOrNumber) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to read a CDAS licence.",
      },
      { status: 405, headers: { allow: "GET" } }
    );
  }

  const ref = cleanText(licenceIdOrNumber);

  if (!ref) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_licence_id",
        message: "Licence ID or licence number is required.",
      },
      { status: 400 }
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       *
     FROM document_licences
     WHERE id = ? OR licence_number = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
      },
      { status: 404 }
    );
  }

  return jsonResponse({
    ok: true,
    licence: row,
  });
}