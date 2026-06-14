import { jsonResponse } from "../shared.js";

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
