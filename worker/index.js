import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/early-access") {
      if (request.method === "GET") {
        return new Response("Early access endpoint is live. Submit the form with POST.", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

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

      return Response.redirect(`${url.origin}/early-access?submitted=true`, 303);
    }

    return env.ASSETS.fetch(request);
  },
};