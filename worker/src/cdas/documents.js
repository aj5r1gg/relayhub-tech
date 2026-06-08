import { jsonResponse, methodNotAllowed } from "../shared.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const DOCUMENT_SORT_COLUMNS = new Set([
  "title",
  "slug",
  "version",
  "status",
  "classification",
  "access_class",
  "created_at",
  "updated_at",
]);

function clampLimit(value) {
  const parsed = Number.parseInt(value || "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(value) {
  const parsed = Number.parseInt(value || "", 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function parseSort(value) {
  if (!value) {
    return "updated_at";
  }

  return DOCUMENT_SORT_COLUMNS.has(value) ? value : "updated_at";
}

function parseDirection(value) {
  return String(value || "").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function normaliseFilter(value) {
  const text = String(value || "").trim();
  return text.length > 0 ? text : null;
}

function buildDocumentWhere(url) {
  const clauses = [];
  const params = [];

  const q = normaliseFilter(url.searchParams.get("q"));
  const status = normaliseFilter(url.searchParams.get("status"));
  const classification = normaliseFilter(url.searchParams.get("classification"));
  const accessClass = normaliseFilter(url.searchParams.get("access_class"));
  const listed = normaliseFilter(url.searchParams.get("listed"));

  if (q) {
    clauses.push(
      `(title LIKE ? OR slug LIKE ? OR version LIKE ? OR source_object LIKE ?)`
    );
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (status) {
    clauses.push(`status = ?`);
    params.push(status);
  }

  if (classification) {
    clauses.push(`classification = ?`);
    params.push(classification);
  }

  if (accessClass) {
    clauses.push(`access_class = ?`);
    params.push(accessClass);
  }

  if (listed === "1" || listed === "true") {
    clauses.push(`is_listed = 1`);
  }

  if (listed === "0" || listed === "false") {
    clauses.push(`is_listed = 0`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
    filters: {
      q,
      status,
      classification,
      access_class: accessClass,
      listed,
    },
  };
}

export async function listCdasDocuments(request, env) {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const url = new URL(request.url);

  const limit = clampLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));
  const sort = parseSort(url.searchParams.get("sort"));
  const direction = parseDirection(url.searchParams.get("direction"));

  const { whereSql, params, filters } = buildDocumentWhere(url);

  const totalRow = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total FROM documents ${whereSql}`
  )
    .bind(...params)
    .first();

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       classification,
       access_class,
       source_object,
       source_sha256,
       generated_prefix,
       licence_terms_version,
       is_listed,
       allow_redownload,
       max_redownloads,
       requires_approval,
       current_version_of,
       supersedes_document_id,
       superseded_by_document_id,
       created_at,
       updated_at
     FROM documents
     ${whereSql}
     ORDER BY ${sort} ${direction}
     LIMIT ?
     OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all();

  return jsonResponse({
    ok: true,
    total: totalRow?.total || 0,
    limit,
    offset,
    sort,
    direction: direction.toLowerCase(),
    filters,
    rows: rows.results || [],
  });
}

export async function getCdasDocument(request, env, documentId) {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
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
       source_sha256,
       generated_prefix,
       licence_terms_version,
       is_listed,
       allow_redownload,
       max_redownloads,
       requires_approval,
       current_version_of,
       supersedes_document_id,
       superseded_by_document_id,
       created_at,
       updated_at
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(documentId, documentId)
    .first();

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "document_not_found",
        message: "CDAS document was not found.",
      },
      { status: 404 }
    );
  }

  return jsonResponse({
    ok: true,
    document: row,
  });
}