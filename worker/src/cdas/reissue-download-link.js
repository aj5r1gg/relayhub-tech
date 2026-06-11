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

async function getDocument(env, documentId) {
  const id = cleanText(documentId);

  if (!id) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM documents
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();
}

async function getActiveUnusedLink(env, licenceId) {
  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_download_links
     WHERE licence_id = ?
       AND status = 'active'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL
       AND datetime(expires_at) > datetime(?)
     ORDER BY activated_at DESC, created_at DESC
     LIMIT 1`
  )
    .bind(licenceId, nowIso())
    .first();
}

async function getPendingGenerationLink(env, licenceId) {
  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_download_links
     WHERE licence_id = ?
       AND status = 'pending_generation'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(licenceId)
    .first();
}

async function getPreviousLinkSummary(env, licenceId) {
  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       download_reference,
       status,
       created_at,
       activated_at,
       used_at,
       expires_at,
       revoked_at,
       superseded_at,
       failure_reason,
       generated_pdf_object_key,
       generated_pdf_sha256
     FROM document_download_links
     WHERE licence_id = ?
     ORDER BY created_at DESC
     LIMIT 10`
  )
    .bind(licenceId)
    .all();

  return rows?.results || [];
}

function hasCompleteGeneratedPdfEvidence(licence) {
  return Boolean(
    licence &&
      licence.generated_pdf_status === "generated" &&
      licence.generated_pdf_object_key &&
      licence.generated_pdf_filename &&
      licence.generated_pdf_sha256 &&
      licence.generated_pdf_size_bytes
  );
}

function evaluateReissueBlockers({
  licence,
  document,
  activeUnusedLink,
  pendingLink,
  explicitReissue,
}) {
  const blockers = [];
  const warnings = [];

  if (!explicitReissue) {
    blockers.push("explicit_reissue_confirmation_required");
  }

  if (!licence) {
    blockers.push("licence_not_found");
    return { blockers, warnings };
  }

  if (licence.status !== "active") {
    blockers.push("licence_not_active");
  }

  if (licence.revoked_at || licence.status === "revoked") {
    blockers.push("licence_revoked");
  }

  if (licence.confirmed_leak_at) {
    blockers.push("confirmed_leak_recorded");
  }

  if (licence.suspected_leak_at) {
    warnings.push("suspected_leak_recorded");
  }

  if (!hasCompleteGeneratedPdfEvidence(licence)) {
    blockers.push("licence_has_no_prior_complete_generated_pdf_evidence");
  }

  if (activeUnusedLink) {
    blockers.push("active_unused_download_link_already_exists");
  }

  if (pendingLink) {
    blockers.push("pending_generation_download_link_already_exists");
  }

  if (!document) {
    blockers.push("document_not_found");
  } else {
    if (document.status !== "active") {
      blockers.push("document_not_active");
    }

    if (document.version !== licence.document_version) {
      blockers.push("document_version_mismatch");
    }

    if (!document.source_object) {
      blockers.push("missing_document_source_object");
    }

    if (!document.source_sha256) {
      blockers.push("missing_document_source_sha256");
    }

    if (
      document.source_sha256 &&
      licence.source_sha256 &&
      document.source_sha256 !== licence.source_sha256
    ) {
      blockers.push("licence_source_sha256_differs_from_document_source_sha256");
    }
  }

  return { blockers, warnings };
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

async function callGeneratePdfForReissue({
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
      mode: "reissue",
      allow_reissue: true,
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
  licence,
  documentTitle,
  issuePayload,
  generationPayload,
  emailResult,
  workflowAction,
}) {
  await recordCdasEmailEvent(env, {
    relatedType: "licence",
    relatedId: licence.id,
    emailType: "download_link_reissue_email",
    recipientEmail:
      licence.licence_holder_email_normalised || licence.licence_holder_email,
    subject: `Your RelayHub download has been reissued: ${documentTitle}`,
    emailResult,
    metadata: {
      document_id: licence.document_id,
      licence_number: licence.licence_number,
      workflow_action: workflowAction,
      download_link_id:
        generationPayload?.download_link?.id ||
        issuePayload?.download_link?.id ||
        null,
      download_reference:
        generationPayload?.download_link?.download_reference ||
        issuePayload?.download_link?.download_reference ||
        null,
      download_link_expires_at: issuePayload?.download_link?.expires_at || null,
      generated_pdf_object_key:
        generationPayload?.generated_pdf?.object_key ||
        generationPayload?.download_link?.generated_pdf_object_key ||
        null,
      generated_pdf_sha256:
        generationPayload?.generated_pdf?.sha256 ||
        generationPayload?.download_link?.generated_pdf_sha256 ||
        null,
      landing_url_emailed: true,
      raw_r2_url_exposed: false,
      explicit_reissue: true,
    },
  });
}

export async function reissueCdasDownloadLink(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to explicitly reissue a CDAS download.",
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

  const document = await getDocument(env, licence.document_id);
  const activeUnusedLink = await getActiveUnusedLink(env, licence.id);
  const pendingLink = await getPendingGenerationLink(env, licence.id);
  const previousLinks = await getPreviousLinkSummary(env, licence.id);

  const explicitReissue =
    body.confirm_reissue === true ||
    body.confirmReissue === true ||
    cleanText(body.action) === "reissue_download";

  const readiness = evaluateReissueBlockers({
    licence,
    document,
    activeUnusedLink,
    pendingLink,
    explicitReissue,
  });

  if (readiness.blockers.length) {
    return jsonResponse(
      {
        ok: false,
        error: "reissue_blocked",
        message:
          "Download reissue was not started because one or more policy or recovery blockers were found. No new link was reserved.",
        blockers: readiness.blockers,
        warnings: readiness.warnings,
        licence: {
          id: licence.id,
          licence_number: licence.licence_number,
          status: licence.status,
          document_id: licence.document_id,
          document_version: licence.document_version,
          generated_pdf_status: licence.generated_pdf_status,
          generated_pdf_object_key: licence.generated_pdf_object_key,
          generated_pdf_sha256: licence.generated_pdf_sha256,
          generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
        },
        active_unused_link: activeUnusedLink
          ? {
              id: activeUnusedLink.id,
              download_reference: activeUnusedLink.download_reference,
              status: activeUnusedLink.status,
              expires_at: activeUnusedLink.expires_at,
            }
          : null,
        pending_generation_link: pendingLink
          ? {
              id: pendingLink.id,
              download_reference: pendingLink.download_reference,
              status: pendingLink.status,
              created_at: pendingLink.created_at,
            }
          : null,
        previous_links: previousLinks,
        controls: {
          reserved_download_link: false,
          generated_pdf: false,
          activated_download_link: false,
          sent_email: false,
          explicit_reissue_required: true,
          prevents_duplicate_active_download_links: true,
          prevents_stranded_pending_generation_links: true,
        },
      },
      409
    );
  }

  const issueResult = await callIssueDownloadLink(
    request,
    env,
    licenceIdOrNumber
  );

  const issuePayload = issueResult.payload;

  if (!issueResult.ok) {
    return jsonResponse(
      {
        ok: false,
        error: issuePayload?.error || "download_link_reservation_failed",
        message:
          issuePayload?.message ||
          "Download link could not be reserved, so reissue generation and email were not attempted.",
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
  const landingUrl = buildRecipientLandingUrlFromIssuePayload(issuePayload);

  if (!downloadLinkId || !downloadReference || !landingUrl) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_reservation_incomplete",
        message:
          "Download link reservation succeeded but did not return the fields required for reissue generation and email delivery.",
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

  const generationResult = await callGeneratePdfForReissue({
    request,
    env,
    licenceIdOrNumber,
    downloadLinkId,
    downloadReference,
  });

  const generationPayload = generationResult.payload;

  if (
    !generationResult.ok ||
    !generationPayload?.generated ||
    !generationPayload?.download_link?.activated
  ) {
    return jsonResponse(
      {
        ok: false,
        error:
          generationPayload?.error || "reissue_generated_pdf_activation_failed",
        message:
          generationPayload?.message ||
          "Download link was reserved, but the reissued generated PDF was not created and activated, so no email was sent.",
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

  const recipientEmail =
    cleanText(body.recipient_email || body.recipientEmail) ||
    cleanText(licence.licence_holder_email_normalised) ||
    cleanText(licence.licence_holder_email);

  if (!recipientEmail) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_recipient_email",
        message:
          "The reissued PDF and link were created, but no recipient email is available. Manual intervention is required.",
        issue_result: issuePayload,
        generation_result: generationPayload,
      },
      409
    );
  }

  const documentTitle =
    cleanText(document?.title) || licence.document_id || "RelayHub document";

  const emailResult = await sendCdasDownloadLinkEmail(env, {
    recipientEmail,
    documentTitle,
    documentId: licence.document_id,
    licenceNumber: licence.licence_number,
    downloadUrl: landingUrl,
    expiresAt: issuePayload?.download_link?.expires_at || null,
  });

  await recordEmailAttempt({
    env,
    licence,
    documentTitle,
    issuePayload,
    generationPayload,
    emailResult,
    workflowAction: "reissued_generated_activated_and_emailed",
  });

  return jsonResponse({
    ok: true,
    workflow_action: "reissued_generated_activated_and_emailed",
    reissued: true,
    reserved: true,
    generated: true,
    activated: true,
    emailed: Boolean(emailResult?.sent),
    warnings: readiness.warnings,
    download_link: {
      id: generationPayload.download_link.id,
      download_reference: generationPayload.download_link.download_reference,
      status: generationPayload.download_link.status,
      landing_url: landingUrl,
      expires_at: issuePayload.download_link.expires_at,
      token_visible_once: Boolean(issuePayload.download_link.token_visible_once),
      single_use: true,
      generated_pdf_object_key:
        generationPayload.download_link.generated_pdf_object_key,
      generated_pdf_sha256: generationPayload.download_link.generated_pdf_sha256,
      generated_pdf_size_bytes:
        generationPayload.download_link.generated_pdf_size_bytes,
    },
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_name: licence.licence_holder_name,
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
      previous_generated_pdf_object_key: licence.generated_pdf_object_key,
      previous_generated_pdf_sha256: licence.generated_pdf_sha256,
      generated_pdf_status: "generated",
    },
    generated_pdf: generationPayload.generated_pdf,
    previous_links: previousLinks,
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
      explicit_reissue_workflow: true,
      reserves_new_download_link: true,
      creates_new_download_id: true,
      generates_new_download_id_bound_pdf: true,
      binds_generated_pdf_to_new_download_link: true,
      activates_link_before_email: true,
      emails_only_landing_page_url: true,
      raw_r2_url_exposed: false,
      download_api_url_emailed: false,
      landing_page_url_emailed: true,
      single_use_download_preserved: true,
      stores_raw_token: false,
      overwrites_existing_r2_object: false,
    },
    message: emailResult?.sent
      ? "CDAS download was explicitly reissued, activated, and emailed."
      : emailResult?.skipped
        ? "CDAS download was explicitly reissued and activated, but email sending is disabled."
        : "CDAS download was explicitly reissued and activated, but email delivery failed.",
  });
}