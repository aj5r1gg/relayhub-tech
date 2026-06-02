import { EmailMessage } from "cloudflare:email";

const EMAIL_FROM = "hello@relayhub.tech";
const EMAIL_TO = "moneywise69@proton.me";

const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/early-access") {
      if (request.method === "GET") {
        return textResponse(
          "Early access endpoint is live. Submit the form with POST."
        );
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

    const ip = getClientIp(request);
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

    const ip = getClientIp(request);
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

function textResponse(message) {
  return new Response(message, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
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