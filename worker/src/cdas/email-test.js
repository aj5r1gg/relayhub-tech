import { jsonResponse } from "../shared.js";
import { sendCdasVerificationEmail } from "./email.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

async function readJsonBody(request) {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return {};
  }

  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export async function sendCdasVerificationEmailTest(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to send a CDAS verification email test.",
      },
      405
    );
  }

  const body = await readJsonBody(request);

  const recipientEmail = cleanText(body.recipient_email || body.email);
  const documentTitle = cleanText(body.document_title || "RelayHub Overview");
  const documentId = cleanText(body.document_id || "relayhub-overview");

  if (!recipientEmail) {
    return jsonResponse(
      {
        ok: false,
        error: "recipient_email_missing",
        message: "recipient_email is required.",
      },
      400
    );
  }

  const result = await sendCdasVerificationEmail(env, {
    recipientEmail,
    documentTitle,
    documentId,
    requestId: "test-request-id",
    verificationToken: "test-verification-token",
    verificationUrl:
      "https://www.relayhub.tech/document-access/verify?request_id=test-request-id&token=test-verification-token",
  });

  return jsonResponse(
    {
      ok: result.ok,
      test_only: true,
      email_enabled: String(env.CDAS_EMAIL_ENABLED || "").toLowerCase() === "true",
      provider: "resend",
      result,
      controls: {
        mutates_cdas_workflow: false,
        creates_access_request: false,
        verifies_email: false,
        issues_licence: false,
        creates_download_link: false,
        sends_real_email_only_when_enabled: true,
      },
    },
    result.ok ? 200 : 502
  );
}