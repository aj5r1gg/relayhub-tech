import { EmailMessage } from "cloudflare:email";

const EMAIL_FROM = "hello@relayhub.tech";
const EMAIL_TO = "moneywise69@proton.me";

const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const MIN_FORM_FILL_TIME_MS = 3000;

const DOWNLOAD_ALLOWED_PREFIXES = ["docs/"];
const DOWNLOAD_ALLOWED_EXTENSIONS = [".pdf", ".zip", ".txt", ".sha256", ".sig"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/download/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }

      return handleDownload(request, env, url);
    }

    if (url.pathname === "/api/early-access") {
      if (request.method === "GET") {
        return textResponse("Early access endpoint is live. Submit the form with POST.");
      }

      if (request.method === "POST") {
        return handleEarlyAccessPost(request, env, url);
      }

      return methodNotAllowed("GET, POST");
    }

    if (url.pathname === "/api/contact") {
      if (request.method === "GET") {
        return textResponse("Contact endpoint is live. Submit the form with POST.");
      }

      if (request.method === "POST") {
        return handleContactPost(request, env, url);
      }

      return methodNotAllowed("GET, POST");
    }

    if (url.pathname === "/api/admin/newsletter") {
      if (request.method === "GET") {
        return handleNewsletterAdminJson(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname === "/api/admin/newsletter.csv") {
      if (request.method === "GET") {
        return handleNewsletterAdminCsv(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname === "/api/admin/contact") {
      if (request.method === "GET") {
        return handleContactAdminJson(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname === "/api/admin/contact.csv") {
      if (request.method === "GET") {
        return handleContactAdminCsv(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname === "/api/admin/downloads") {
      if (request.method === "GET") {
        return handleDownloadAnalyticsAdminJson(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleDownload(request, env, url) {
  const started = Date.now();
  const key = getDownloadKey(url.pathname);

  if (!isSafeDownloadKey(key)) {
    recordDownloadAnalytics(request, env, url, {
      key: key || "invalid",
      statusCode: 400,
      outcome: "invalid",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("Invalid or disallowed download path", 400);
  }

  const object = await env.RELAYHUB_DOWNLOADS.get(key);

  if (!object) {
    recordDownloadAnalytics(request, env, url, {
      key,
      statusCode: 404,
      outcome: "not_found",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("Download not found", 404);
  }

  recordDownloadAnalytics(request, env, url, {
    key,
    statusCode: 200,
    outcome: "success",
    contentType: object.httpMetadata?.contentType ?? "unknown",
    size: object.size,
    started,
  });

  const headers = new Headers();

  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", `attachment; filename="${safeDownloadFilename(key)}"`);

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

function recordDownloadAnalytics(request, env, url, event) {
  env.DOWNLOAD_ANALYTICS?.writeDataPoint({
    blobs: [
      event.key,
      request.headers.get("cf-ipcountry") ?? "unknown",
      url.searchParams.get("utm_source") ?? "direct",
      url.searchParams.get("utm_campaign") ?? "none",
      request.headers.get("referer") ?? "none",
      event.contentType,
      event.outcome,
      String(event.statusCode),
    ],
    doubles: [
      1,
      event.size,
      Date.now() - event.started,
      event.outcome === "success" ? 1 : 0,
      event.outcome === "success" ? 0 : 1,
    ],
    indexes: [event.key],
  });
}

function getDownloadKey(pathname) {
  const raw = pathname.replace(/^\/download\/+/, "");

  try {
    return decodeURIComponent(raw).replace(/^\/+/, "");
  } catch {
    return "";
  }
}

function isSafeDownloadKey(key) {
  if (!key) return false;
  if (key.includes("..")) return false;
  if (key.includes("\\")) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("//")) return false;

  const hasAllowedPrefix = DOWNLOAD_ALLOWED_PREFIXES.some((prefix) =>
    key.startsWith(prefix)
  );

  const hasAllowedExtension = DOWNLOAD_ALLOWED_EXTENSIONS.some((extension) =>
    key.toLowerCase().endsWith(extension)
  );

  return hasAllowedPrefix && hasAllowedExtension;
}

function safeDownloadFilename(key) {
  const raw = key.split("/").pop() || "download";
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function handleEarlyAccessPost(request, env, url) {
  try {
    const form = await request.formData();

    const website = cleanField(form.get("website"), 500);

    if (website) {
      console.warn("Early access honeypot triggered.");
      return redirect(url, "/early-access?submitted=true");
    }

    if (isSubmittedTooQuickly(form)) {
      console.warn("Early access form submitted too quickly.");
      return redirect(url, "/early-access?submitted=true");
    }

    const ip = getClientIp(request);

    const turnstileValid = await verifyTurnstile(form, env, ip);

    if (!turnstileValid) {
      console.warn("Early access Turnstile validation failed.");
      return redirect(url, "/early-access?submitted=true");
    }

    const rateLimit = await checkRateLimit(env, "early-access", ip);

    if (!rateLimit.allowed) {
      console.warn("Early access rate limit triggered.");
      return redirect(url, "/early-access?error=rate-limited");
    }

    const name = cleanField(form.get("name"), 200);
    const email = cleanField(form.get("email"), 320);
    const community = cleanField(form.get("community"), 300);
    const message = cleanField(form.get("message"), 3000);
    const userAgent = cleanField(request.headers.get("User-Agent"), 500);
    const ipHash = await hashText(ip);
    const submittedAt = new Date().toISOString();
    const sourceUrl = url.toString();

    if (!isValidEmail(email)) {
      return redirect(url, "/early-access?error=invalid-email");
    }

    await storeSignup(env, {
      name,
      email,
      community,
      message,
      ipHash,
      userAgent,
    });

    const rawEmail = buildEarlyAccessEmail({
      name,
      email,
      community,
      message,
      submittedAt,
      sourceUrl,
      userAgent,
    });

    const emailMessage = new EmailMessage(EMAIL_FROM, EMAIL_TO, rawEmail);
    await env.RELAYHUB_EMAIL.send(emailMessage);

    return redirect(url, "/early-access?submitted=true");
  } catch (error) {
    console.error("Early access submission failed:", error);
    return redirect(url, "/early-access?error=submission-failed");
  }
}

async function handleContactPost(request, env, url) {
  try {
    const form = await request.formData();

    const website = cleanField(form.get("website"), 500);

    if (website) {
      console.warn("Contact honeypot triggered.");
      return redirect(url, "/contact?submitted=true");
    }

    if (isSubmittedTooQuickly(form)) {
      console.warn("Contact form submitted too quickly.");
      return redirect(url, "/contact?submitted=true");
    }

    const ip = getClientIp(request);

    const turnstileValid = await verifyTurnstile(form, env, ip);

    if (!turnstileValid) {
      console.warn("Contact Turnstile validation failed.");
      return redirect(url, "/contact?submitted=true");
    }

    const rateLimit = await checkRateLimit(env, "contact", ip);

    if (!rateLimit.allowed) {
      console.warn("Contact rate limit triggered.");
      return redirect(url, "/contact?error=rate-limited");
    }

    const name = cleanField(form.get("name"), 200);
    const email = cleanField(form.get("email"), 320);
    const topic = cleanField(form.get("topic"), 200);
    const message = cleanField(form.get("message"), 5000);
    const userAgent = cleanField(request.headers.get("User-Agent"), 500);
    const ipHash = await hashText(ip);
    const submittedAt = new Date().toISOString();
    const sourceUrl = url.toString();

    if (!isValidEmail(email)) {
      return redirect(url, "/contact?error=invalid-email");
    }

    if (!message) {
      return redirect(url, "/contact?error=submission-failed");
    }

    await storeContactMessage(env, {
      name,
      email,
      topic,
      message,
      ipHash,
      userAgent,
    });

    const rawEmail = buildContactEmail({
      name,
      email,
      topic,
      message,
      submittedAt,
      sourceUrl,
      userAgent,
    });

    const emailMessage = new EmailMessage(EMAIL_FROM, EMAIL_TO, rawEmail);
    await env.RELAYHUB_EMAIL.send(emailMessage);

    return redirect(url, "/contact?submitted=true");
  } catch (error) {
    console.error("Contact submission failed:", error);
    return redirect(url, "/contact?error=submission-failed");
  }
}

async function handleDownloadAnalyticsAdminJson(request, env, url) {
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

async function verifyTurnstile(form, env, ip) {
  const token = cleanField(form.get("cf-turnstile-response"), 4096);

  if (!env.TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY is not configured.");
    return false;
  }

  if (!token) {
    return false;
  }

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  body.append("remoteip", ip);

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body,
    }
  );

  if (!response.ok) {
    return false;
  }

  const result = await response.json();

  return result.success === true;
}

function isSubmittedTooQuickly(form) {
  const startedAt = Number(cleanField(form.get("startedAt"), 32));
  const submittedAt = Date.now();

  if (!startedAt) {
    return true;
  }

  return submittedAt - startedAt < MIN_FORM_FILL_TIME_MS;
}

async function handleNewsletterAdminJson(request, env, url) {
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

async function handleNewsletterAdminCsv(request, env, url) {
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

async function handleContactAdminJson(request, env, url) {
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

async function handleContactAdminCsv(request, env, url) {
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

function isAdminAuthorized(request, env, url) {
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

async function storeSignup(env, signup) {
  await env.RELAYHUB_DB.prepare(
    `INSERT INTO early_access_signups
      (name, email, community, message, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      signup.name,
      signup.email,
      signup.community,
      signup.message,
      signup.ipHash,
      signup.userAgent
    )
    .run();
}

async function storeContactMessage(env, contact) {
  await env.RELAYHUB_DB.prepare(
    `INSERT INTO contact_messages
      (name, email, topic, message, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      contact.name,
      contact.email,
      contact.topic,
      contact.message,
      contact.ipHash,
      contact.userAgent
    )
    .run();
}

async function checkRateLimit(env, scope, ip) {
  const ipHash = await hashText(ip);
  const key = `${scope}:${ipHash}`;

  const current = Number((await env.RELAYHUB_RATE_LIMIT.get(key)) || "0");

  if (current >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false };
  }

  await env.RELAYHUB_RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });

  return { allowed: true };
}

function buildEarlyAccessEmail({
  name,
  email,
  community,
  message,
  submittedAt,
  sourceUrl,
  userAgent,
}) {
  const safeReplyTo = sanitizeHeader(email);

  return [
    `From: ${EMAIL_FROM}`,
    `To: ${EMAIL_TO}`,
    `Reply-To: ${safeReplyTo}`,
    "Subject: New RelayHub early access request",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "New RelayHub early access request",
    "",
    `Submitted at: ${submittedAt}`,
    `Source URL: ${sourceUrl}`,
    "",
    `Name: ${name || "Not provided"}`,
    `Email: ${email}`,
    `Community / organisation: ${community || "Not provided"}`,
    "",
    "Message:",
    message || "Not provided",
    "",
    "Technical context:",
    "Stored in D1: yes",
    `User agent: ${userAgent || "Not provided"}`,
    "",
  ].join("\r\n");
}

function buildContactEmail({
  name,
  email,
  topic,
  message,
  submittedAt,
  sourceUrl,
  userAgent,
}) {
  const safeReplyTo = sanitizeHeader(email);
  const safeTopic = sanitizeHeader(topic || "General enquiry");

  return [
    `From: ${EMAIL_FROM}`,
    `To: ${EMAIL_TO}`,
    `Reply-To: ${safeReplyTo}`,
    `Subject: RelayHub contact form: ${safeTopic}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "New RelayHub contact message",
    "",
    `Submitted at: ${submittedAt}`,
    `Source URL: ${sourceUrl}`,
    "",
    `Name: ${name || "Not provided"}`,
    `Email: ${email}`,
    `Topic: ${topic || "General enquiry"}`,
    "",
    "Message:",
    message || "Not provided",
    "",
    "Technical context:",
    "Stored in D1: yes",
    `User agent: ${userAgent || "Not provided"}`,
    "",
  ].join("\r\n");
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

function methodNotAllowed(allow) {
  return new Response("Method not allowed", {
    status: 405,
    headers: {
      allow,
    },
  });
}

function cleanField(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, maxLength);
}

function sanitizeHeader(value) {
  return String(value || "")
    .replace(/[\r\n]/g, "")
    .trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function hashText(value) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function redirect(url, path) {
  return Response.redirect(`${url.origin}${path}`, 303);
}