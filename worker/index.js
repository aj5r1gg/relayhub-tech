import { EmailMessage } from "cloudflare:email";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/early-access") {
      if (request.method === "GET") {
        return new Response(
          "Early access endpoint is live. Submit the form with POST.",
          {
            status: 200,
            headers: {
              "content-type": "text/plain; charset=UTF-8",
            },
          }
        );
      }

      if (request.method === "POST") {
        return handleEarlyAccessPost(request, env, url);
      }

      return new Response("Method not allowed", {
        status: 405,
        headers: {
          allow: "GET, POST",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleEarlyAccessPost(request, env, url) {
  try {
    const form = await request.formData();

    const name = cleanField(form.get("name"), 200);
    const email = cleanField(form.get("email"), 320);
    const community = cleanField(form.get("community"), 300);
    const message = cleanField(form.get("message"), 3000);

    if (!isValidEmail(email)) {
      return redirect(url, "/early-access?error=invalid-email");
    }

    const rawEmail = buildRawEmail({
      name,
      email,
      community,
      message,
    });

    const emailMessage = new EmailMessage(
      "hello@relayhub.tech",
      "moneywise69@proton.me",
      rawEmail
    );

    await env.RELAYHUB_EMAIL.send(emailMessage);

    return redirect(url, "/early-access?submitted=true");
  } catch (error) {
    console.error("Early access email failed:", error);
    return redirect(url, "/early-access?error=email-failed");
  }
}

function buildRawEmail({ name, email, community, message }) {
  const safeReplyTo = sanitizeHeader(email);

  return [
    "From: hello@relayhub.tech",
    "To: moneywise69@proton.me",
    `Reply-To: ${safeReplyTo}`,
    "Subject: New RelayHub early access request",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "New RelayHub early access request",
    "",
    `Name: ${name || "Not provided"}`,
    `Email: ${email}`,
    `Community / organisation: ${community || "Not provided"}`,
    "",
    "Message:",
    message || "Not provided",
    "",
  ].join("\r\n");
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

function redirect(url, path) {
  return Response.redirect(`${url.origin}${path}`, 303);
}