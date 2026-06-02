import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

export async function onRequestPost({ request, env }) {
  const form = await request.formData();

  const name = String(form.get("name") || "").trim();
  const email = String(form.get("email") || "").trim();
  const interest = String(form.get("interest") || "").trim();
  const product = String(form.get("product") || "").trim();
  const location = String(form.get("location") || "").trim();
  const testing = String(form.get("testing") || "").trim();
  const message = String(form.get("message") || "").trim();

  if (!name || !email) {
    return new Response("Name and email are required.", { status: 400 });
  }

  const msg = createMimeMessage();

  msg.setSender({
    name: "RelayHub Website",
    addr: "hello@relayhub.tech",
  });

  msg.setRecipient("hello@relayhub.tech");
  msg.setSubject(`RelayHub early access: ${name}`);

  msg.addMessage({
    contentType: "text/plain",
    data: `
New RelayHub early access registration

Name: ${name}
Email: ${email}
Interest: ${interest}
Product: ${product}
Location: ${location}
Testing: ${testing}

Message:
${message}
    `.trim(),
  });

  const emailMessage = new EmailMessage(
    "hello@relayhub.tech",
    "hello@relayhub.tech",
    msg.asRaw(),
  );

  await env.RELAYHUB_EMAIL.send(emailMessage);

  return Response.redirect(new URL("/early-access?submitted=true", request.url), 303);
}