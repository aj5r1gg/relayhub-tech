import { jsonResponse, methodNotAllowed } from "../shared.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const TERMS_SORT_COLUMNS = new Set([
  "version",
  "title",
  "status",
  "effective_from",
  "effective_to",
  "created_at",
  "retired_at",
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
    return "created_at";
  }

  return TERMS_SORT_COLUMNS.has(value) ? value : "created_at";
}

function parseDirection(value) {
  return String(value || "").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function normaliseFilter(value) {
  const text = String(value || "").trim();
  return text.length > 0 ? text : null;
}

function buildTermsWhere(url) {
  const clauses = [];
  const params = [];

  const q = normaliseFilter(url.searchParams.get("q"));
  const status = normaliseFilter(url.searchParams.get("status"));
  const accessClass = normaliseFilter(url.searchParams.get("access_class"));

  if (q) {
    clauses.push(`(version LIKE ? OR title LIKE ? OR body LIKE ? OR notes LIKE ?)`);
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (status) {
    clauses.push(`status = ?`);
    params.push(status);
  }

  if (accessClass) {
    clauses.push(
      `(applies_to_access_class = ? OR applies_to_access_class IS NULL OR applies_to_access_class = '')`
    );
    params.push(accessClass);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
    filters: {
      q,
      status,
      access_class: accessClass,
    },
  };
}

function summariseTermsRow(row) {
  const body = row.body || "";

  return {
    ...row,
    body_preview: body.length > 280 ? `${body.slice(0, 280)}…` : body,
    body_length: body.length,
  };
}

export async function listCdasLicenceTerms(request, env) {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const url = new URL(request.url);

  const includeBody = url.searchParams.get("include_body") === "1";
  const limit = clampLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));
  const sort = parseSort(url.searchParams.get("sort"));
  const direction = parseDirection(url.searchParams.get("direction"));

  const { whereSql, params, filters } = buildTermsWhere(url);

  const totalRow = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total FROM licence_terms ${whereSql}`
  )
    .bind(...params)
    .first();

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       version,
       title,
       body,
       body_sha256,
       status,
       applies_to_access_class,
       effective_from,
       effective_to,
       created_at,
       retired_at,
       notes
     FROM licence_terms
     ${whereSql}
     ORDER BY ${sort} ${direction}
     LIMIT ?
     OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all();

  const mappedRows = (rows.results || []).map((row) => {
    if (includeBody) {
      return row;
    }

    const summary = summariseTermsRow(row);
    delete summary.body;
    return summary;
  });

  return jsonResponse({
    ok: true,
    total: totalRow?.total || 0,
    limit,
    offset,
    sort,
    direction: direction.toLowerCase(),
    filters,
    include_body: includeBody,
    rows: mappedRows,
  });
}

export async function getCdasLicenceTerms(request, env, termsIdOrVersion) {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       version,
       title,
       body,
       body_sha256,
       status,
       applies_to_access_class,
       effective_from,
       effective_to,
       created_at,
       retired_at,
       notes
     FROM licence_terms
     WHERE id = ? OR version = ?
     LIMIT 1`
  )
    .bind(termsIdOrVersion, termsIdOrVersion)
    .first();

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_terms_not_found",
        message: "CDAS licence terms were not found.",
      },
      { status: 404 }
    );
  }

  return jsonResponse({
    ok: true,
    terms: row,
  });
}