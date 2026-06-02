import { EmailMessage } from "cloudflare:email";

const EMAIL_FROM = "hello@relayhub.tech";
const EMAIL_TO = "moneywise69@proton.me";

const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const MIN_FORM_FILL_TIME_MS = 3000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    return env.ASSETS.fetch(request);
  },
};

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