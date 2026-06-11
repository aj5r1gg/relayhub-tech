import { jsonResponse } from "../shared.js";
import { issueCdasDownloadLink } from "./download-link-issue.js";
import { generateCdasLicencePdf } from "./generate-pdf.js";
import { sendCdasDownloadLinkEmail } from "./email.js";
import { recordCdasEmailEvent } from "./email-events.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

async function getLicence(env, licenceIdOrNumber) {
  const ref = cleanText(licenceIdOrNumber);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_licences
     WHERE id = ? OR licence_number = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
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

async function getLatestActiveDownloadLink(env, licenceId) {
  const id = cleanText(licenceId);

  if (!id) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       download_reference,
       licence_id,
       document_id,
       status,
       created_at,
       activated_at,
       expires_at,
       used_at,
       revoked_at,
       superseded_at,
       generated_pdf_object_key,
       generated_pdf_sha256,
       generated_pdf_size_bytes,
       generated_pdf_created_at
     FROM document_download_links
     WHERE licence_id = ?
       AND status = 'active'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL
       AND datetime(expires_at) > datetime(?)
       AND generated_pdf_object_key IS NOT NULL
       AND generated_pdf_sha256 IS NOT NULL
       AND generated_pdf_size_bytes IS NOT NULL
     ORDER BY activated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(id, nowIso())
    .first();
}

async function callIssueDownloadLink(request, env, licenceIdOrNumber) {
  const response = await issueCdasDownloadLink(request, env, licenceIdOrNumber);

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    ok: response.ok && Boolean(payload?.ok),
    status: response.status || 500,
    payload,
  };
}

async function callGeneratePdfForReservedLink({
  request,
  env,
  licenceIdOrNumber,
  downloadLinkId,
  downloadReference,
}) {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");

  const generationRequest = new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      download_link_id: downloadLinkId,
      download_reference: downloadReference,
    }),
  });

  const response = await generateCdasLicencePdf(
    generationRequest,
    env,
    licenceIdOrNumber
  );

  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    ok: response.ok && Boolean(payload?.ok),
    status: response.status || 500,
    payload,
  };
}

function buildRecipientLandingUrlFromIssuePayload(issuePayload) {
  return (
    issuePayload?.download_link?.landing_url ||
    issuePayload?.download_link?.url ||
    ""
  );
}

async function recordEmailAttempt({
  env,
  relatedId,
  recipientEmail,
  documentTitle,
  issuePayload = null,
  generationPayload = null,
  activeLink = null,
  emailResult,
}) {
  await recordCdasEmailEvent(env, {
    relatedType: "licence",
    relatedId,
    emailType: "download_link_email",
    recipientEmail,
    subject: `Your RelayHub download is ready: ${documentTitle}`,
    emailResult,
    metadata: {
      document_id:
        issuePayload?.licence?.document_id ||
        generationPayload?.licence?.document_id ||
        activeLink?.document_id ||
        null,
      licence_number:
        issuePayload?.licence?.licence_number ||
        generationPayload?.licence?.licence_number ||
        null,
      download_link_id:
        issuePayload?.download_link?.id ||
        generationPayload?.download_link?.id ||
        activeLink?.id ||
        null,
      download_reference:
        issuePayload?.download_link?.download_reference ||
        generationPayload?.download_link?.download_reference ||
        activeLink?.download_reference ||
        null,
      download_link_expires_at:
        issuePayload?.download_link?.expires_at ||
        activeLink?.expires_at ||
        null,
      landing_url_emailed: true,
      raw_r2_url_exposed: false,
      orchestrated_workflow: true,
    },
  });
}

export async function emailCdasDownloadLink(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to prepare and email a CDAS download link.",
      },
      405
    );
  }

  const body = await readJsonBody(request);
  const licence = await getLicence(env, licenceIdOrNumber);

  if (!licence) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
      },
      404
    );
  }

  /*
   * Safety rule:
   *
   * If an active, unused, generated-PDF-bound link already exists, email that.
   * Do not reserve another Download ID unnecessarily.
   */
  const existingActiveLink = await getLatestActiveDownloadLink(env, licence.id);

  let issuePayload = null;
  let generationPayload = null;
  let landingUrl = "";
  let activeLink = existingActiveLink;
  let workflowAction = "emailed_existing_active_link";

  if (existingActiveLink) {
    /*
     * We cannot reconstruct the raw token from D1 because only the hash is stored.
     * Therefore, existing active links can only be emailed if the caller provides
     * a landing_url explicitly. This preserves the no-raw-token-at-rest rule.
     */
    landingUrl = cleanText(body.landing_url || body.download_url || body.url);

    if (!landingUrl) {
      return jsonResponse(
        {
          ok: false,
          error: "active_download_link_exists_but_raw_token_unavailable",
          message:
            "An active download link already exists, but the raw token is not stored and no landing_url was provided. Reserve/generate a new licence workflow or provide the one-time landing URL from the original issue response.",
          active_download_link: {
            id: existingActiveLink.id,
            download_reference: existingActiveLink.download_reference,
            status: existingActiveLink.status,
            activated_at: existingActiveLink.activated_at,
            expires_at: existingActiveLink.expires_at,
          },
          controls: {
            stores_raw_token: false,
            can_reconstruct_landing_url: false,
            sends_email: false,
            raw_r2_url_exposed: false,
          },
        },
        409
      );
    }
  } else {
    /*
     * Normal operator workflow:
     *
     * 1. reserve pending_generation link
     * 2. generate PDF using that Download ID
     * 3. activate reserved link
     * 4. email landing URL
     */
    const issueResult = await callIssueDownloadLink(
      request,
      env,
      licenceIdOrNumber
    );

    issuePayload = issueResult.payload;

    if (!issueResult.ok) {
      return jsonResponse(
        {
          ok: false,
          error: issuePayload?.error || "download_link_reservation_failed",
          message:
            issuePayload?.message ||
            "Download link could not be reserved, so no email was sent.",
          issue_result: issuePayload,
          controls: {
            reserved_download_link: false,
            generated_pdf: false,
            activated_download_link: false,
            sent_email: false,
          },
        },
        issueResult.status || 409
      );
    }

    const downloadLinkId = issuePayload?.download_link?.id;
    const downloadReference = issuePayload?.download_link?.download_reference;

    landingUrl = buildRecipientLandingUrlFromIssuePayload(issuePayload);

    if (!downloadLinkId || !downloadReference || !landingUrl) {
      return jsonResponse(
        {
          ok: false,
          error: "download_link_reservation_incomplete",
          message:
            "Download link reservation succeeded but did not return the fields required for PDF generation and email delivery.",
          issue_result: issuePayload,
          controls: {
            reserved_download_link: true,
            generated_pdf: false,
            activated_download_link: false,
            sent_email: false,
          },
        },
        500
      );
    }

    const generationResult = await callGeneratePdfForReservedLink({
      request,
      env,
      licenceIdOrNumber,
      downloadLinkId,
      downloadReference,
    });

    generationPayload = generationResult.payload;

    if (
      !generationResult.ok ||
      !generationPayload?.generated ||
      !generationPayload?.download_link?.activated
    ) {
      return jsonResponse(
        {
          ok: false,
          error: generationPayload?.error || "generated_pdf_activation_failed",
          message:
            generationPayload?.message ||
            "Download link was reserved, but the generated PDF was not created and activated, so no email was sent.",
          issue_result: issuePayload,
          generation_result: generationPayload,
          controls: {
            reserved_download_link: true,
            generated_pdf: Boolean(generationPayload?.generated),
            activated_download_link: Boolean(
              generationPayload?.download_link?.activated
            ),
            sent_email: false,
            raw_r2_url_exposed: false,
          },
        },
        generationResult.status || 409
      );
    }

    activeLink = {
      id: generationPayload.download_link.id,
      download_reference: generationPayload.download_link.download_reference,
      status: generationPayload.download_link.status,
      activated_at: generationPayload.download_link.activated_at,
      expires_at: issuePayload.download_link.expires_at,
      generated_pdf_object_key:
        generationPayload.download_link.generated_pdf_object_key,
      generated_pdf_sha256: generationPayload.download_link.generated_pdf_sha256,
      generated_pdf_size_bytes:
        generationPayload.download_link.generated_pdf_size_bytes,
    };

    workflowAction = "reserved_generated_activated_and_emailed";
  }

  const recipientEmail =
    cleanText(body.recipient_email || body.recipientEmail) ||
    cleanText(licence.licence_holder_email_normalised) ||
    cleanText(licence.licence_holder_email);

  if (!recipientEmail) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_recipient_email",
        message: "No recipient email is available for this licence.",
      },
      409
    );
  }

  const documentTitle =
    cleanText(body.document_title || body.documentTitle) ||
    (await getDocumentTitle(env, licence.document_id)) ||
    licence.document_id ||
    "RelayHub document";

  const emailResult = await sendCdasDownloadLinkEmail(env, {
    recipientEmail,
    documentTitle,
    documentId: licence.document_id,
    licenceNumber: licence.licence_number,
    downloadUrl: landingUrl,
    expiresAt:
      issuePayload?.download_link?.expires_at ||
      activeLink?.expires_at ||
      licence.expires_at ||
      null,
  });

  await recordEmailAttempt({
    env,
    relatedId: licence.id || licenceIdOrNumber,
    recipientEmail,
    documentTitle,
    issuePayload,
    generationPayload,
    activeLink,
    emailResult,
  });

  return jsonResponse({
    ok: true,
    workflow_action: workflowAction,
    reserved: Boolean(issuePayload?.reserved),
    generated: Boolean(generationPayload?.generated),
    activated: Boolean(generationPayload?.download_link?.activated || activeLink),
    emailed: Boolean(emailResult?.sent),
    download_link: {
      id:
        issuePayload?.download_link?.id ||
        generationPayload?.download_link?.id ||
        activeLink?.id ||
        null,
      download_reference:
        issuePayload?.download_link?.download_reference ||
        generationPayload?.download_link?.download_reference ||
        activeLink?.download_reference ||
        null,
      status:
        generationPayload?.download_link?.status ||
        activeLink?.status ||
        issuePayload?.download_link?.status ||
        null,
      landing_url: landingUrl,
      expires_at:
        issuePayload?.download_link?.expires_at ||
        activeLink?.expires_at ||
        null,
      token_visible_once: Boolean(issuePayload?.download_link?.token_visible_once),
      single_use: true,
    },
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_name: licence.licence_holder_name,
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
      generated_pdf_status:
        generationPayload?.generated_pdf?.status ||
        licence.generated_pdf_status ||
        null,
    },
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
      full_operator_workflow: true,
      reserves_download_link_when_needed: true,
      generates_pdf_before_email: true,
      activates_link_before_email: true,
      emails_only_landing_page_url: true,
      raw_r2_url_exposed: false,
      download_api_url_emailed: false,
      landing_page_url_emailed: true,
      single_use_download_preserved: true,
      stores_raw_token: false,
      can_reconstruct_previous_raw_token: false,
    },
    message: emailResult?.sent
      ? "CDAS download was prepared, activated, and emailed."
      : emailResult?.skipped
        ? "CDAS download was prepared and activated, but email sending is disabled."
        : "CDAS download was prepared and activated, but email delivery failed.",
  });
}