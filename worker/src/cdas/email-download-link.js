import { jsonResponse } from "../shared.js";
import { issueCdasDownloadLink } from "./download-link-issue.js";
import { sendCdasDownloadLinkEmail } from "./email.js";
import { recordCdasEmailEvent } from "./email-events.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

async function getDocumentTitle(env, documentId) {
  const id = cleanText(documentId);

  if (!id) return "";

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT title
     FROM documents
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  return cleanText(row?.title);
}

export async function emailCdasDownloadLink(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to email a CDAS download link.",
      },
      405
    );
  }

  const body = await readJsonBody(request);

  const issueResponse = await issueCdasDownloadLink(
    request,
    env,
    licenceIdOrNumber
  );

  let issuePayload = null;

  try {
    issuePayload = await issueResponse.json();
  } catch {
    issuePayload = null;
  }

  if (!issueResponse.ok || !issuePayload?.ok) {
    return jsonResponse(
      {
        ok: false,
        error: issuePayload?.error || "download_link_issue_failed",
        message:
          issuePayload?.message ||
          "Download link could not be issued, so no email was sent.",
        issue_result: issuePayload,
      },
      issueResponse.status || 409
    );
  }

  const recipientEmail =
    cleanText(body.recipient_email || body.recipientEmail) ||
    cleanText(issuePayload.licence?.licence_holder_email_normalised);

  const documentTitle =
    cleanText(body.document_title || body.documentTitle) ||
    (await getDocumentTitle(env, issuePayload.licence?.document_id)) ||
    issuePayload.licence?.document_id ||
    "RelayHub document";

  const landingUrl =
    issuePayload.download_link?.landing_url || issuePayload.download_link?.url;

  const emailResult = await sendCdasDownloadLinkEmail(env, {
    recipientEmail,
    documentTitle,
    documentId: issuePayload.licence?.document_id,
    licenceNumber: issuePayload.licence?.licence_number,
    downloadUrl: landingUrl,
    expiresAt: issuePayload.download_link?.expires_at,
  });

  await recordCdasEmailEvent(env, {
    relatedType: "licence",
    relatedId:
      issuePayload.licence?.id ||
      issuePayload.licence?.licence_id ||
      licenceIdOrNumber,
    emailType: "download_link_email",
    recipientEmail,
    subject: `Your RelayHub download is ready: ${documentTitle}`,
    emailResult,
    metadata: {
      document_id: issuePayload.licence?.document_id,
      licence_number: issuePayload.licence?.licence_number,
      download_link_id: issuePayload.download_link?.id,
      download_link_expires_at: issuePayload.download_link?.expires_at,
      landing_url_emailed: true,
      raw_r2_url_exposed: false,
    },
  });

  return jsonResponse({
    ok: true,
    issued: true,
    emailed: Boolean(emailResult?.sent),
    download_link: {
      id: issuePayload.download_link?.id,
      status: issuePayload.download_link?.status,
      landing_url: landingUrl,
      expires_at: issuePayload.download_link?.expires_at,
      token_visible_once: issuePayload.download_link?.token_visible_once,
    },
    licence: issuePayload.licence,
    email_result: {
      ok: emailResult.ok,
      sent: emailResult.sent,
      skipped: emailResult.skipped || false,
      provider: emailResult.provider || "resend",
      provider_message_id: emailResult.provider_message_id || null,
      error: emailResult.error || null,
      message: emailResult.message || null,
    },
    controls: {
      raw_r2_url_exposed: false,
      download_api_url_emailed: false,
      landing_page_url_emailed: true,
      single_use_download_preserved: true,
      issuing_download_link_supersedes_previous_unused_links: true,
    },
    message: emailResult?.sent
      ? "Controlled download link was issued and emailed."
      : emailResult?.skipped
        ? "Controlled download link was issued, but email sending is disabled."
        : "Controlled download link was issued, but email delivery failed.",
  });
}