import { getClientIp, jsonResponse } from "../shared.js";
import {
  sendCdasDownloadLinkRevocationNoticeEmail,
} from "./email.js";

const NOTICE_EMAIL_TYPE = "download_link_revocation_notice";

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function getDb(env) {
  return env.RELAYHUB_DB || env.DB || env.DATABASE || null;
}

function isEmailEnabled(env) {
  return cleanText(env.CDAS_EMAIL_ENABLED).toLowerCase() === "true";
}

async function getRevokedDownloadLinkNoticeRecord(env, downloadId) {
  const db = getDb(env);

  if (!db) {
    throw new Error("D1 database binding was not found.");
  }

  return await db
    .prepare(
      `
        SELECT
          dl.id AS download_id,
          dl.licence_id AS link_licence_id,
          dl.document_id AS link_document_id,
          dl.status AS link_status,
          dl.created_at AS link_created_at,
          dl.expires_at AS link_expires_at,
          dl.used_at AS link_used_at,
          dl.revoked_at AS link_revoked_at,
          dl.superseded_at AS link_superseded_at,
          dl.failure_reason AS link_failure_reason,
          dl.download_reference AS download_reference,
          dl.activated_at AS link_activated_at,
          dl.generated_pdf_object_key AS link_generated_pdf_object_key,
          dl.generated_pdf_sha256 AS link_generated_pdf_sha256,
          dl.generated_pdf_size_bytes AS link_generated_pdf_size_bytes,
          dl.generated_pdf_created_at AS link_generated_pdf_created_at,

          lic.id AS licence_id,
          lic.licence_number AS licence_number,
          lic.request_id AS request_id,
          lic.document_id AS document_id,
          lic.document_version AS document_version,
          lic.licence_terms_version AS licence_terms_version,
          lic.status AS licence_status,
          lic.revoked_at AS licence_revoked_at,
          lic.licence_holder_name AS licence_holder_name,
          lic.organisation_name AS organisation_name,
          lic.licence_holder_email AS licence_holder_email,
          lic.licence_holder_email_normalised AS licence_holder_email_normalised,
          lic.generated_pdf_status AS licence_generated_pdf_status,
          lic.generated_pdf_object_key AS licence_generated_pdf_object_key,
          lic.generated_pdf_sha256 AS licence_generated_pdf_sha256,
          lic.generated_pdf_size_bytes AS licence_generated_pdf_size_bytes,
          lic.generated_pdf_created_at AS licence_generated_pdf_created_at,

          (
            SELECT COUNT(*)
            FROM cdas_email_events e
            WHERE e.related_type = 'download_link'
              AND e.related_id = dl.id
              AND e.email_type = ?
              AND e.status = 'sent'
          ) AS prior_successful_notice_count,

          (
            SELECT MAX(e.created_at)
            FROM cdas_email_events e
            WHERE e.related_type = 'download_link'
              AND e.related_id = dl.id
              AND e.email_type = ?
              AND e.status = 'sent'
          ) AS prior_successful_notice_at,

          (
            SELECT COUNT(*)
            FROM cdas_email_events e
            WHERE e.related_type = 'download_link'
              AND e.related_id = dl.id
              AND e.email_type = ?
              AND e.status IN ('failed', 'blocked', 'bounced', 'complained')
              AND e.resolved_at IS NULL
          ) AS unresolved_notice_failure_count

        FROM document_download_links dl
        LEFT JOIN document_licences lic
          ON lic.id = dl.licence_id
        WHERE dl.id = ?
        LIMIT 1
      `,
    )
    .bind(NOTICE_EMAIL_TYPE, NOTICE_EMAIL_TYPE, NOTICE_EMAIL_TYPE, downloadId)
    .first();
}

function publicDownloadLink(record) {
  if (!record) return null;

  return {
    id: record.download_id,
    licence_id: record.licence_id,
    licence_number: record.licence_number,
    document_id: record.document_id || record.link_document_id,
    document_version: record.document_version,
    download_reference: record.download_reference,
    status: record.link_status,
    created_at: record.link_created_at,
    expires_at: record.link_expires_at,
    activated_at: record.link_activated_at,
    used_at: record.link_used_at,
    revoked_at: record.link_revoked_at,
    superseded_at: record.link_superseded_at,
    failure_reason: record.link_failure_reason,
    generated_pdf: {
      object_key_present: Boolean(
        record.link_generated_pdf_object_key ||
          record.licence_generated_pdf_object_key,
      ),
      sha256_present: Boolean(
        record.link_generated_pdf_sha256 ||
          record.licence_generated_pdf_sha256,
      ),
      size_bytes:
        record.link_generated_pdf_size_bytes ||
        record.licence_generated_pdf_size_bytes ||
        null,
      created_at:
        record.link_generated_pdf_created_at ||
        record.licence_generated_pdf_created_at ||
        null,
    },
  };
}

function publicLicence(record) {
  if (!record) return null;

  return {
    id: record.licence_id,
    licence_number: record.licence_number,
    document_id: record.document_id || record.link_document_id,
    document_version: record.document_version,
    status: record.licence_status,
    revoked_at: record.licence_revoked_at,
    holder_name: record.licence_holder_name,
    organisation_name: record.organisation_name,
    recipient_email:
      normaliseEmail(record.licence_holder_email_normalised) ||
      normaliseEmail(record.licence_holder_email),
    terms_version: record.licence_terms_version,
  };
}

function buildEligibility(record, env) {
  const blockers = [];
  const warnings = [];

  if (!record) {
    return {
      eligible: false,
      decision: "blocked",
      blockers: ["download_link_not_found"],
      warnings,
    };
  }

  const linkStatus = cleanText(record.link_status).toLowerCase();
  const recipientEmail =
    normaliseEmail(record.licence_holder_email_normalised) ||
    normaliseEmail(record.licence_holder_email);

  if (!record.licence_id) {
    blockers.push("missing_related_licence");
  }

  if (!record.licence_number) {
    blockers.push("missing_licence_number");
  }

  if (!record.licence_terms_version) {
    blockers.push("missing_licence_terms_version");
  }

  if (!recipientEmail) {
    blockers.push("missing_recipient_email");
  }

  if (linkStatus !== "revoked" && !record.link_revoked_at) {
    blockers.push("download_link_not_revoked");
  }

  if (record.link_superseded_at || linkStatus === "superseded") {
    warnings.push("download_link_superseded");
  }

  if (record.licence_revoked_at || record.licence_status === "revoked") {
    warnings.push("licence_itself_is_revoked");
  }

  if (Number(record.prior_successful_notice_count || 0) > 0) {
    blockers.push("revocation_notice_already_sent");
  }

  if (Number(record.unresolved_notice_failure_count || 0) > 0) {
    warnings.push("unresolved_prior_revocation_notice_failure");
  }

  if (!isEmailEnabled(env)) {
    blockers.push("cdas_email_disabled");
  }

  if (!cleanText(env.RESEND_API_KEY)) {
    blockers.push("email_provider_api_key_missing");
  }

  if (!cleanText(env.CDAS_EMAIL_FROM)) {
    warnings.push("cdas_email_from_not_configured");
  }

  return {
    eligible: blockers.length === 0,
    decision:
      blockers.length === 0
        ? "eligible_for_revocation_notice"
        : "blocked",
    blockers,
    warnings,
  };
}

export async function getCdasDownloadLinkRevocationNoticeEligibility(
  request,
  env,
  downloadId,
) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message:
          "Use GET to check CDAS download-link revocation notice eligibility.",
      },
      405,
    );
  }

  const id = cleanText(downloadId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_download_link_id",
        message: "Download link ID is required.",
      },
      400,
    );
  }

  const record = await getRevokedDownloadLinkNoticeRecord(env, id);

  if (!record) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        eligible: false,
        decision: "blocked",
        blockers: ["download_link_not_found"],
        controls: {
          mutates_database: false,
          sends_email: false,
          reissues_link: false,
          serves_download: false,
          modifies_licence: false,
        },
      },
      404,
    );
  }

  const eligibility = buildEligibility(record, env);
  const recipientEmail =
    normaliseEmail(record.licence_holder_email_normalised) ||
    normaliseEmail(record.licence_holder_email);

  return jsonResponse({
    ok: true,
    action: "download_link_revocation_notice_eligibility",
    eligible: eligibility.eligible,
    decision: eligibility.decision,
    blockers: eligibility.blockers,
    warnings: eligibility.warnings,
    download_link: publicDownloadLink(record),
    licence: publicLicence(record),
    notice: {
      notice_type: NOTICE_EMAIL_TYPE,
      already_sent: Number(record.prior_successful_notice_count || 0) > 0,
      prior_successful_notice_count: Number(
        record.prior_successful_notice_count || 0,
      ),
      prior_successful_notice_at: record.prior_successful_notice_at || null,
      unresolved_failure_count: Number(
        record.unresolved_notice_failure_count || 0,
      ),
      recipient_email: recipientEmail,
      subject_intent:
        "Controlled download link revoked — licence status unchanged unless separately revoked",
      wording_rule:
        "Notice must state that the controlled download link was revoked or disabled. It must not state that the licence was revoked unless the licence itself is revoked.",
    },
    controls: {
      mutates_database: false,
      sends_email: false,
      reissues_link: false,
      activates_link: false,
      serves_download: false,
      modifies_licence: false,
      deletes_r2_object: false,
      raw_token_returned: false,
      token_hash_returned: false,
      notification_only_eligibility: true,
    },
  });
}
function nowIso() {
  return new Date().toISOString();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromText(text) {
  const encoded = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

function buildId(prefix) {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  const suffix = [...array]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `${prefix}_${Date.now().toString(36)}_${suffix}`;
}

function getUserAgent(request) {
  return cleanText(request.headers.get("User-Agent")).slice(0, 500);
}

async function readOptionalJson(request) {
  const contentType = cleanText(request.headers.get("Content-Type")).toLowerCase();

  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

async function recordRevocationNoticeEmailEvent({
  env,
  record,
  subject,
  status,
  provider,
  providerMessageId,
  error,
  message,
  metadata,
}) {
  const db = getDb(env);
  const createdAt = nowIso();
  const sent = status === "sent";

  await db
    .prepare(
      `INSERT INTO cdas_email_events (
         id,
         email_type,
         related_type,
         related_id,
         status,
         recipient_email,
         subject,
         retryable,
         retry_count,
         created_at,
         resolved_at,
         provider,
         provider_message_id,
         error,
         message,
         metadata_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      buildId("cee"),
      NOTICE_EMAIL_TYPE,
      "download_link",
      record.download_id,
      status,
      normaliseEmail(record.licence_holder_email_normalised) ||
        normaliseEmail(record.licence_holder_email),
      subject,
      sent ? 0 : 1,
      0,
      createdAt,
      sent ? createdAt : null,
      provider || null,
      providerMessageId || null,
      error || null,
      message || null,
      JSON.stringify(metadata || {}),
    )
    .run();
}

async function recordRevocationNoticeDownloadEvent({
  env,
  request,
  record,
  eventType,
  success,
  failureReason,
  provider,
  providerMessageId,
}) {
  try {
    const ip = getClientIp(request);
    const ipHash = ip ? await sha256HexFromText(ip) : null;

    const failureParts = [];

    if (failureReason) failureParts.push(cleanText(failureReason));
    if (provider) failureParts.push(`provider=${cleanText(provider)}`);
    if (providerMessageId) {
      failureParts.push(`provider_message_id=${cleanText(providerMessageId)}`);
    }

    await getDb(env)
      .prepare(
        `INSERT INTO document_download_events (
           id,
           download_id,
           licence_id,
           licence_number,
           document_id,
           document_version,
           licence_holder_name,
           organisation_name,
           licence_holder_email,
           event_type,
           event_at,
           ip_hash,
           user_agent,
           generated_object,
           source_object,
           source_sha256,
           generated_sha256,
           template_sha256,
           licence_page_template_version,
           watermark_template_version,
           footer_template_version,
           terms_template_version,
           generation_engine_version,
           terms_version,
           success,
           failure_reason
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        buildId("dde"),
        record.download_id,
        record.licence_id,
        record.licence_number,
        record.document_id || record.link_document_id,
        record.document_version,
        record.licence_holder_name || null,
        record.organisation_name || null,
        normaliseEmail(record.licence_holder_email_normalised) ||
          normaliseEmail(record.licence_holder_email),
        eventType,
        nowIso(),
        ipHash,
        getUserAgent(request),
        record.link_generated_pdf_object_key ||
          record.licence_generated_pdf_object_key ||
          null,
        null,
        null,
        record.link_generated_pdf_sha256 ||
          record.licence_generated_pdf_sha256 ||
          null,
        null,
        null,
        null,
        null,
        record.licence_terms_version || null,
        null,
        record.licence_terms_version || null,
        success ? 1 : 0,
        failureParts.length ? failureParts.join(" | ").slice(0, 1000) : null,
      )
      .run();
  } catch {
    /*
     * The provider result and cdas_email_events record remain the primary proof
     * for this email action. Do not turn a successful email into a hard failure
     * because the secondary download-event audit insert failed.
     */
  }
}

function buildRevocationNoticeSubject(record) {
  const documentLabel = cleanText(record.document_id || record.link_document_id) ||
    "RelayHub document";

  return `Controlled download link revoked: ${documentLabel}`;
}

export async function sendCdasDownloadLinkRevocationNotice(
  request,
  env,
  downloadId,
) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message:
          "Use POST to send a CDAS download-link revocation notice.",
      },
      405,
    );
  }

  const id = cleanText(downloadId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_download_link_id",
        message: "Download link ID is required.",
      },
      400,
    );
  }

  const body = await readOptionalJson(request);
  const actor = cleanText(body.actor) || "operations-centre";
  const note = cleanText(body.note || body.reason);

  const record = await getRevokedDownloadLinkNoticeRecord(env, id);

  if (!record) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS download link was not found.",
        controls: {
          sends_email: false,
          reissues_link: false,
          activates_link: false,
          serves_download: false,
          modifies_licence: false,
          deletes_r2_object: false,
        },
      },
      404,
    );
  }

  const eligibility = buildEligibility(record, env);

  if (!eligibility.eligible) {
    await recordRevocationNoticeDownloadEvent({
      env,
      request,
      record,
      eventType: "download_link_revocation_notice_blocked",
      success: 0,
      failureReason: eligibility.blockers.join(","),
    });

    return jsonResponse(
      {
        ok: false,
        error: "download_link_revocation_notice_blocked",
        message:
          "Revocation notice was not sent because the eligibility gate did not pass.",
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        download_link: publicDownloadLink(record),
        licence: publicLicence(record),
        controls: {
          sends_email: false,
          reissues_link: false,
          activates_link: false,
          serves_download: false,
          modifies_licence: false,
          deletes_r2_object: false,
          raw_token_returned: false,
          token_hash_returned: false,
        },
      },
      409,
    );
  }

  /*
   * Race guard. The eligibility query already checks this, but re-check the
   * freshly loaded record immediately before sending so repeat requests do not
   * silently resend a revocation notice.
   */
  if (Number(record.prior_successful_notice_count || 0) > 0) {
    return jsonResponse(
      {
        ok: false,
        error: "revocation_notice_already_sent",
        message:
          "A successful revocation notice has already been recorded for this download link.",
        download_link: publicDownloadLink(record),
        licence: publicLicence(record),
        controls: {
          sends_email: false,
          reissues_link: false,
          activates_link: false,
          serves_download: false,
          modifies_licence: false,
          deletes_r2_object: false,
        },
      },
      409,
    );
  }

  const recipientEmail =
    normaliseEmail(record.licence_holder_email_normalised) ||
    normaliseEmail(record.licence_holder_email);

  const subject = buildRevocationNoticeSubject(record);

  const emailResult = await sendCdasDownloadLinkRevocationNoticeEmail(env, {
    recipientEmail,
    documentTitle: record.document_id || record.link_document_id,
    documentId: record.document_id || record.link_document_id,
    licenceNumber: record.licence_number,
    downloadReference: record.download_reference,
    reason:
      note ||
      record.link_failure_reason ||
      "Controlled download link revoked by RelayHub.",
  });

  const sent = Boolean(emailResult?.ok && emailResult?.sent);
  const skipped = Boolean(emailResult?.ok && emailResult?.skipped);

  await recordRevocationNoticeEmailEvent({
    env,
    record,
    subject,
    status: sent ? "sent" : skipped ? "blocked" : "failed",
    provider: emailResult?.provider || "resend",
    providerMessageId: emailResult?.provider_message_id || null,
    error: sent ? null : emailResult?.error || (skipped ? "cdas_email_disabled" : "email_send_failed"),
    message:
      sent
        ? "Download-link revocation notice sent."
        : emailResult?.message || "Download-link revocation notice was not sent.",
    metadata: {
      phase: "3X-0T-C2",
      actor,
      note,
      download_reference: record.download_reference,
      licence_number: record.licence_number,
      licence_status: record.licence_status,
      licence_revoked_at: record.licence_revoked_at || null,
      link_status: record.link_status,
      link_revoked_at: record.link_revoked_at || null,
      wording_rule:
        "This notice is about link revocation only. It must not claim the licence was revoked unless the licence itself is revoked.",
    },
  });

  await recordRevocationNoticeDownloadEvent({
    env,
    request,
    record,
    eventType: sent
      ? "download_link_revocation_notice_sent"
      : skipped
        ? "download_link_revocation_notice_blocked"
        : "download_link_revocation_notice_failed",
    success: sent ? 1 : 0,
    failureReason:
      sent
        ? cleanText(note || "3X-0T-C2 revocation notice sent")
        : emailResult?.message || emailResult?.error || "email_not_sent",
    provider: emailResult?.provider || null,
    providerMessageId: emailResult?.provider_message_id || null,
  });

  if (!emailResult?.ok || !sent) {
    return jsonResponse(
      {
        ok: false,
        error: skipped ? "cdas_email_disabled" : emailResult?.error || "email_send_failed",
        message:
          emailResult?.message ||
          "The download-link revocation notice was not sent.",
        email_result: {
          ok: Boolean(emailResult?.ok),
          sent,
          skipped,
          provider: emailResult?.provider || null,
          status: emailResult?.status || null,
          error: emailResult?.error || null,
          provider_message_id: emailResult?.provider_message_id || null,
        },
        download_link: publicDownloadLink(record),
        licence: publicLicence(record),
        controls: {
          sends_email: false,
          reissues_link: false,
          activates_link: false,
          serves_download: false,
          modifies_licence: false,
          deletes_r2_object: false,
          raw_token_returned: false,
          token_hash_returned: false,
        },
      },
      skipped ? 409 : 502,
    );
  }

  return jsonResponse({
    ok: true,
    sent: true,
    emailed: true,
    action: "send_download_link_revocation_notice",
    email_result: {
      provider: emailResult.provider || "resend",
      status: emailResult.status || null,
      provider_message_id: emailResult.provider_message_id || null,
    },
    download_link: publicDownloadLink(record),
    licence: publicLicence(record),
    notice: {
      notice_type: NOTICE_EMAIL_TYPE,
      recipient_email: recipientEmail,
      subject,
      wording_rule:
        "Notice states that the controlled download link was revoked or disabled. It does not state that the licence was revoked unless the licence itself is revoked.",
    },
    controls: {
      verified_revoked_download_link: true,
      sent_email: true,
      sends_email: true,
      reissues_link: false,
      activates_link: false,
      serves_download: false,
      modifies_licence: false,
      deletes_r2_object: false,
      raw_token_returned: false,
      token_hash_returned: false,
      exposes_raw_r2_url: false,
    },
    safety: {
      email_sent: true,
      link_reissued: false,
      link_activated: false,
      pdf_served: false,
      link_consumed: false,
      licence_modified: false,
    },
    message:
      "Download-link revocation notice was sent. No link was reissued, no link was activated, no PDF was served, and the licence was not modified.",
  });
}
