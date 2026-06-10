import { jsonResponse } from "../shared.js";
import { retryCdasEmailEvent } from "./email-event-retry.js";

const ALLOWED_SORT_FIELDS = new Set([
  "created_at",
  "email_type",
  "status",
  "related_type",
  "recipient_email",
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

function normaliseSort(value) {
  const sort = cleanText(value);

  if (ALLOWED_SORT_FIELDS.has(sort)) {
    return sort;
  }

  return "created_at";
}

function normaliseDirection(value) {
  return cleanText(value).toLowerCase() === "asc" ? "asc" : "desc";
}

function parseMetadata(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normaliseRow(row) {
  return {
    ...row,
    metadata: parseMetadata(row.metadata_json),
    retryable: Number(row.retryable || 0),
    retry_count: Number(row.retry_count || 0),
  };
}

export async function listCdasEmailEvents(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to list CDAS email events.",
      },
      405
    );
  }

  const url = new URL(request.url);

  const q = cleanText(url.searchParams.get("q"));
  const relatedType = cleanText(url.searchParams.get("related_type"));
  const relatedId = cleanText(url.searchParams.get("related_id"));
  const emailType = cleanText(url.searchParams.get("email_type"));
  const status = cleanText(url.searchParams.get("status"));
  const recipientEmail = cleanText(
    url.searchParams.get("recipient_email")
  ).toLowerCase();
  const retryable = cleanText(url.searchParams.get("retryable"));

  const limit = parsePositiveInt(url.searchParams.get("limit"), 50, 200);
  const offset = parsePositiveInt(url.searchParams.get("offset"), 0, 100000);
  const sort = normaliseSort(url.searchParams.get("sort"));
  const direction = normaliseDirection(url.searchParams.get("direction"));

  const where = [];
  const bindings = [];

  if (q) {
    where.push(
      `(id LIKE ? OR related_id LIKE ? OR recipient_email LIKE ? OR provider_message_id LIKE ? OR subject LIKE ?)`
    );

    const like = `%${q}%`;
    bindings.push(like, like, like, like, like);
  }

  if (relatedType) {
    where.push("related_type = ?");
    bindings.push(relatedType);
  }

  if (relatedId) {
    where.push("related_id = ?");
    bindings.push(relatedId);
  }

  if (emailType) {
    where.push("email_type = ?");
    bindings.push(emailType);
  }

  if (status) {
    where.push("status = ?");
    bindings.push(status);
  }

  if (recipientEmail) {
    where.push("recipient_email = ?");
    bindings.push(recipientEmail);
  }

  if (retryable === "0" || retryable === "1") {
    where.push("retryable = ?");
    bindings.push(Number(retryable));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM cdas_email_events
     ${whereSql}`
  )
    .bind(...bindings)
    .first();

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM cdas_email_events
     ${whereSql}
     ORDER BY ${sort} ${direction}
     LIMIT ?
     OFFSET ?`
  )
    .bind(...bindings, limit, offset)
    .all();

  return jsonResponse({
    ok: true,
    total: Number(total?.total || 0),
    limit,
    offset,
    sort,
    direction,
    filters: {
      q: q || null,
      related_type: relatedType || null,
      related_id: relatedId || null,
      email_type: emailType || null,
      status: status || null,
      recipient_email: recipientEmail || null,
      retryable: retryable || null,
    },
    rows: Array.isArray(rows?.results)
      ? rows.results.map(normaliseRow)
      : [],
  });
}

export async function getCdasEmailEvent(request, env, eventId) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to inspect a CDAS email event.",
      },
      405
    );
  }

  const id = cleanText(eventId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_email_event_id",
        message: "Email event ID is required.",
      },
      400
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM cdas_email_events
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return jsonResponse(
      {
        ok: false,
        error: "email_event_not_found",
        message: "CDAS email event was not found.",
      },
      404
    );
  }

  return jsonResponse({
    ok: true,
    event: normaliseRow(row),
  });
}

export { retryCdasEmailEvent };