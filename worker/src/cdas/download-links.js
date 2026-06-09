import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function parseLimit(value, fallback = 100) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 1), 250);
}

function parseOffset(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(parsed, 0);
}

function normaliseStatus(value) {
  const clean = cleanText(value).toLowerCase();

  const allowed = new Set([
    "created",
    "used",
    "revoked",
    "superseded",
    "expired",
    "failed",
  ]);

  return allowed.has(clean) ? clean : "";
}

function buildListFilters(url) {
  const where = [];
  const bindings = [];

  const q = cleanText(url.searchParams.get("q"));
  const licenceId = cleanText(url.searchParams.get("licence_id"));
  const documentId = cleanText(url.searchParams.get("document_id"));
  const status = normaliseStatus(url.searchParams.get("status"));

  if (q) {
    where.push(
      `(
        dl.id LIKE ?
        OR dl.licence_id LIKE ?
        OR dl.document_id LIKE ?
        OR lic.licence_number LIKE ?
        OR lic.licence_holder_email_normalised LIKE ?
        OR lic.licence_holder_email LIKE ?
        OR lic.licence_holder_name LIKE ?
        OR lic.organisation_name LIKE ?
      )`
    );

    const like = `%${q}%`;

    bindings.push(
      like,
      like,
      like,
      like,
      like,
      like,
      like,
      like
    );
  }

  if (licenceId) {
    where.push(`dl.licence_id = ?`);
    bindings.push(licenceId);
  }

  if (documentId) {
    where.push(`dl.document_id = ?`);
    bindings.push(documentId);
  }

  if (status) {
    where.push(`dl.status = ?`);
    bindings.push(status);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    bindings,
  };
}

function linkSummary(row) {
  return {
    id: row.id,
    licence_id: row.licence_id,
    licence_number: row.licence_number,
    document_id: row.document_id,
    document_version: row.document_version,
    recipient_email:
      row.licence_holder_email_normalised ||
      row.licence_holder_email ||
      null,
    licence_holder_name: row.licence_holder_name || null,
    organisation_name: row.organisation_name || null,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    used_at: row.used_at,
    revoked_at: row.revoked_at,
    superseded_at: row.superseded_at,
    failure_reason: row.failure_reason,
    token_hash_present: Boolean(row.token_hash),
    token_hash_length: row.token_hash ? String(row.token_hash).length : 0,
  };
}

async function listEventCounts(env, linkIds) {
  if (!linkIds.length) {
    return new Map();
  }

  const placeholders = linkIds.map(() => "?").join(", ");

  const result = await env.RELAYHUB_DB.prepare(
    `SELECT
       download_id,
       COUNT(*) AS event_count,
       SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failure_count,
       MAX(event_at) AS last_event_at
     FROM document_download_events
     WHERE download_id IN (${placeholders})
     GROUP BY download_id`
  )
    .bind(...linkIds)
    .all();

  const map = new Map();

  for (const row of result.results || []) {
    map.set(row.download_id, {
      event_count: Number(row.event_count || 0),
      success_count: Number(row.success_count || 0),
      failure_count: Number(row.failure_count || 0),
      last_event_at: row.last_event_at || null,
    });
  }

  return map;
}

export async function listCdasDownloadLinks(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to list CDAS download links.",
      },
      405
    );
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));

  const filters = buildListFilters(url);

  const countRow = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM document_download_links dl
     LEFT JOIN document_licences lic
       ON lic.id = dl.licence_id
     ${filters.whereSql}`
  )
    .bind(...filters.bindings)
    .first();

  const rowsResult = await env.RELAYHUB_DB.prepare(
    `SELECT
       dl.id,
       dl.licence_id,
       dl.document_id,
       dl.token_hash,
       dl.status,
       dl.created_at,
       dl.expires_at,
       dl.used_at,
       dl.revoked_at,
       dl.superseded_at,
       dl.failure_reason,

       lic.licence_number,
       lic.document_version,
       lic.licence_holder_name,
       lic.organisation_name,
       lic.licence_holder_email,
       lic.licence_holder_email_normalised
     FROM document_download_links dl
     LEFT JOIN document_licences lic
       ON lic.id = dl.licence_id
     ${filters.whereSql}
     ORDER BY dl.created_at DESC
     LIMIT ?
     OFFSET ?`
  )
    .bind(...filters.bindings, limit, offset)
    .all();

  const rows = (rowsResult.results || []).map(linkSummary);
  const eventCounts = await listEventCounts(
    env,
    rows.map((row) => row.id)
  );

  return jsonResponse({
    ok: true,
    rows: rows.map((row) => ({
      ...row,
      events: eventCounts.get(row.id) || {
        event_count: 0,
        success_count: 0,
        failure_count: 0,
        last_event_at: null,
      },
    })),
    total: Number(countRow?.total || 0),
    limit,
    offset,
    controls: {
      raw_token_returned: false,
      token_hash_returned: false,
      token_hash_presence_only: true,
      serves_download: false,
      public_access: false,
      mutates_database: false,
      registry_view_only: true,
    },
  });
}

export async function getCdasDownloadLink(request, env, downloadId) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to inspect a CDAS download link.",
      },
      405
    );
  }

  const id = cleanText(downloadId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_download_link_id",
        message: "Download link ID is required.",
      },
      400
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       dl.id,
       dl.licence_id,
       dl.document_id,
       dl.token_hash,
       dl.status,
       dl.created_at,
       dl.expires_at,
       dl.used_at,
       dl.revoked_at,
       dl.superseded_at,
       dl.ip_hash,
       dl.user_agent,
       dl.failure_reason,

       lic.licence_number,
       lic.document_version,
       lic.licence_holder_name,
       lic.organisation_name,
       lic.licence_holder_email,
       lic.licence_holder_email_normalised,
       lic.status AS licence_status,
       lic.generated_pdf_status,
       lic.generated_pdf_object_key,
       lic.generated_pdf_sha256,
       lic.generated_pdf_size_bytes,
       lic.generated_pdf_content_type,
       lic.generated_pdf_created_at
     FROM document_download_links dl
     LEFT JOIN document_licences lic
       ON lic.id = dl.licence_id
     WHERE dl.id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS download link was not found.",
      },
      404
    );
  }

  const eventsResult = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       download_id,
       licence_id,
       licence_number,
       document_id,
       document_version,
       licence_holder_name,
       organisation_name,
       licence_holder_email,
       event_type,
       event_at,
       ip_hash,
       user_agent,
       generated_object,
       source_object,
       source_sha256,
       generated_sha256,
       template_sha256,
       terms_version,
       success,
       failure_reason
     FROM document_download_events
     WHERE download_id = ?
     ORDER BY event_at ASC`
  )
    .bind(id)
    .all();

  return jsonResponse({
    ok: true,
    download_link: {
      ...linkSummary(row),
      ip_hash_present: Boolean(row.ip_hash),
      user_agent_present: Boolean(row.user_agent),
      licence_status: row.licence_status || null,
      generated_pdf: {
        status: row.generated_pdf_status || null,
        object_key: row.generated_pdf_object_key || null,
        sha256: row.generated_pdf_sha256 || null,
        size_bytes: row.generated_pdf_size_bytes || null,
        content_type: row.generated_pdf_content_type || null,
        created_at: row.generated_pdf_created_at || null,
      },
    },
    events: (eventsResult.results || []).map((event) => ({
      id: event.id,
      download_id: event.download_id,
      licence_id: event.licence_id,
      licence_number: event.licence_number,
      document_id: event.document_id,
      document_version: event.document_version,
      licence_holder_name: event.licence_holder_name,
      organisation_name: event.organisation_name,
      licence_holder_email: event.licence_holder_email,
      event_type: event.event_type,
      event_at: event.event_at,
      ip_hash_present: Boolean(event.ip_hash),
      user_agent_present: Boolean(event.user_agent),
      generated_object: event.generated_object,
      source_object: event.source_object,
      source_sha256: event.source_sha256,
      generated_sha256: event.generated_sha256,
      template_sha256: event.template_sha256,
      terms_version: event.terms_version,
      success: Number(event.success || 0) === 1,
      failure_reason: event.failure_reason,
    })),
    controls: {
      raw_token_returned: false,
      token_hash_returned: false,
      token_hash_presence_only: true,
      serves_download: false,
      public_access: false,
      mutates_database: false,
      audit_view_only: true,
    },
  });
}