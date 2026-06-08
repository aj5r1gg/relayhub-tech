import {
  textResponse,
  jsonResponse,
  cleanField,
} from "./shared.js";

export async function handleDownloadAnalyticsAdminJson(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const days = Math.min(
    Math.max(Number(url.searchParams.get("days") || "30"), 1),
    90
  );

  try {
    const queries = {
      summary: `
        SELECT
          SUM(_sample_interval * double1) AS requests,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures,
          SUM(_sample_interval * double2) AS bytes,
          AVG(double3) AS avg_duration_ms
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        FORMAT JSON
      `,

      documents: `
        SELECT
          blob1 AS document,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures,
          SUM(_sample_interval * double2) AS bytes,
          AVG(double3) AS avg_duration_ms
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY document
        ORDER BY downloads DESC, failures DESC
        LIMIT 50
        FORMAT JSON
      `,

      daily: `
        SELECT
          toStartOfDay(timestamp) AS day,
          SUM(_sample_interval * double1) AS requests,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON
      `,

      countries: `
        SELECT
          blob2 AS country,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY country
        ORDER BY downloads DESC, failures DESC
        LIMIT 20
        FORMAT JSON
      `,

      sources: `
        SELECT
          blob3 AS source,
          blob4 AS campaign,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY source, campaign
        ORDER BY downloads DESC, failures DESC
        LIMIT 30
        FORMAT JSON
      `,

      referrers: `
        SELECT
          blob5 AS referrer,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY referrer
        ORDER BY downloads DESC, failures DESC
        LIMIT 20
        FORMAT JSON
      `,

      errors: `
        SELECT
          blob1 AS document,
          blob7 AS outcome,
          blob8 AS status_code,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
          AND double5 > 0
        GROUP BY document, outcome, status_code
        ORDER BY failures DESC
        LIMIT 50
        FORMAT JSON
      `,

      contentTypes: `
        SELECT
          blob6 AS content_type,
          SUM(_sample_interval * double1) AS requests,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY content_type
        ORDER BY requests DESC
        LIMIT 20
        FORMAT JSON
      `,

      outcomes: `
        SELECT
          blob7 AS outcome,
          blob8 AS status_code,
          SUM(_sample_interval * double1) AS requests
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY outcome, status_code
        ORDER BY requests DESC
        FORMAT JSON
      `,
    };

    const [
      summary,
      documents,
      daily,
      countries,
      sources,
      referrers,
      errors,
      contentTypes,
      outcomes,
    ] = await Promise.all([
      queryAnalyticsEngine(env, queries.summary),
      queryAnalyticsEngine(env, queries.documents),
      queryAnalyticsEngine(env, queries.daily),
      queryAnalyticsEngine(env, queries.countries),
      queryAnalyticsEngine(env, queries.sources),
      queryAnalyticsEngine(env, queries.referrers),
      queryAnalyticsEngine(env, queries.errors),
      queryAnalyticsEngine(env, queries.contentTypes),
      queryAnalyticsEngine(env, queries.outcomes),
    ]);

    return jsonResponse({
      days,
      summary: summary[0] || {
        requests: 0,
        downloads: 0,
        failures: 0,
        bytes: 0,
        avg_duration_ms: 0,
      },
      documents,
      daily,
      countries,
      sources,
      referrers,
      errors,
      contentTypes,
      outcomes,
    });
  } catch (error) {
    console.error("Download analytics admin query failed:", error);

    return jsonResponse(
      {
        error: "Download analytics query failed",
        detail: "Check CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN.",
      },
      500
    );
  }
}

async function queryAnalyticsEngine(env, query) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ANALYTICS_TOKEN) {
    throw new Error("Analytics Engine API credentials are not configured.");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
        "content-type": "text/plain; charset=UTF-8",
      },
      body: query,
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error("Analytics Engine SQL API error:", text);
    throw new Error("Analytics Engine SQL API request failed.");
  }

  return parseAnalyticsEngineResponse(text);
}

function parseAnalyticsEngineResponse(text) {
  if (!text.trim()) {
    return [];
  }

  const parsed = JSON.parse(text);

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.data)) {
    return parsed.data;
  }

  if (Array.isArray(parsed.results)) {
    return parsed.results;
  }

  return [];
}

export async function handleNewsletterAdminJson(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildNewsletterQuery(q, 50);

  const total = await countNewsletterSignups(env, q);
  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  return jsonResponse({
    total,
    signups: result.results || [],
  });
}

export async function handleNewsletterAdminCsv(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return textResponse("Unauthorized", 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildNewsletterQuery(q, 1000);

  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  const rows = result.results || [];
  const csv = buildNewsletterCsv(rows);

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=UTF-8",
      "content-disposition": 'attachment; filename="relayhub-newsletter-signups.csv"',
      "cache-control": "no-store",
    },
  });
}

export async function handleContactAdminJson(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildContactQuery(q, 50);

  const total = await countContactMessages(env, q);
  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  return jsonResponse({
    total,
    messages: result.results || [],
  });
}

export async function handleContactAdminCsv(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return textResponse("Unauthorized", 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildContactQuery(q, 1000);

  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  const rows = result.results || [];
  const csv = buildContactCsv(rows);

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=UTF-8",
      "content-disposition": 'attachment; filename="relayhub-contact-messages.csv"',
      "cache-control": "no-store",
    },
  });
}

export function isAdminAuthorized(request, env, url) {
  const expectedToken = env.RELAYHUB_ADMIN_TOKEN;

  if (!expectedToken) {
    console.error("RELAYHUB_ADMIN_TOKEN is not configured.");
    return false;
  }

  const authHeader = request.headers.get("Authorization") || "";
  const bearerPrefix = "Bearer ";

  if (authHeader.startsWith(bearerPrefix)) {
    const suppliedToken = authHeader.slice(bearerPrefix.length).trim();
    return suppliedToken === expectedToken;
  }

  const queryToken = url.searchParams.get("token");

  if (queryToken) {
    return queryToken === expectedToken;
  }

  return false;
}

function buildNewsletterQuery(q, limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 1000);

  if (!q) {
    return {
      sql: `SELECT id, created_at, name, email, community, message
            FROM early_access_signups
            ORDER BY id DESC
            LIMIT ?`,
      bindings: [safeLimit],
    };
  }

  const pattern = `%${q}%`;

  return {
    sql: `SELECT id, created_at, name, email, community, message
          FROM early_access_signups
          WHERE name LIKE ?
             OR email LIKE ?
             OR community LIKE ?
             OR message LIKE ?
          ORDER BY id DESC
          LIMIT ?`,
    bindings: [pattern, pattern, pattern, pattern, safeLimit],
  };
}

function buildContactQuery(q, limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 1000);

  if (!q) {
    return {
      sql: `SELECT id, created_at, name, email, topic, message
            FROM contact_messages
            ORDER BY id DESC
            LIMIT ?`,
      bindings: [safeLimit],
    };
  }

  const pattern = `%${q}%`;

  return {
    sql: `SELECT id, created_at, name, email, topic, message
          FROM contact_messages
          WHERE name LIKE ?
             OR email LIKE ?
             OR topic LIKE ?
             OR message LIKE ?
          ORDER BY id DESC
          LIMIT ?`,
    bindings: [pattern, pattern, pattern, pattern, safeLimit],
  };
}

async function countNewsletterSignups(env, q) {
  if (!q) {
    const result = await env.RELAYHUB_DB.prepare(
      `SELECT COUNT(*) AS total FROM early_access_signups`
    ).first();

    return result?.total || 0;
  }

  const pattern = `%${q}%`;

  const result = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM early_access_signups
     WHERE name LIKE ?
        OR email LIKE ?
        OR community LIKE ?
        OR message LIKE ?`
  )
    .bind(pattern, pattern, pattern, pattern)
    .first();

  return result?.total || 0;
}

async function countContactMessages(env, q) {
  if (!q) {
    const result = await env.RELAYHUB_DB.prepare(
      `SELECT COUNT(*) AS total FROM contact_messages`
    ).first();

    return result?.total || 0;
  }

  const pattern = `%${q}%`;

  const result = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM contact_messages
     WHERE name LIKE ?
        OR email LIKE ?
        OR topic LIKE ?
        OR message LIKE ?`
  )
    .bind(pattern, pattern, pattern, pattern)
    .first();

  return result?.total || 0;
}

function buildNewsletterCsv(rows) {
  const headers = ["id", "created_at", "name", "email", "community", "message"];

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header] ?? "")).join(",")
    ),
  ];

  return `${lines.join("\r\n")}\r\n`;
}

function buildContactCsv(rows) {
  const headers = ["id", "created_at", "name", "email", "topic", "message"];

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header] ?? "")).join(",")
    ),
  ];

  return `${lines.join("\r\n")}\r\n`;
}

function csvEscape(value) {
  const text = String(value);
  const escaped = text.replace(/"/g, '""');

  return `"${escaped}"`;
}