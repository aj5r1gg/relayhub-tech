import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function numberValue(value) {
  return Number(value || 0);
}

function boolValue(value) {
  return Number(value || 0) === 1;
}

async function first(env, sql, bindings = []) {
  return await env.RELAYHUB_DB.prepare(sql)
    .bind(...bindings)
    .first();
}

async function getAccessRequest(env, requestId) {
  return await first(
    env,
    `SELECT
       id,
       document_id,
       document_version,
       name,
       email,
       email_normalised,
       licence_holder_type,
       organisation_name,
       contact_name,
       contact_email,
       role_title,
       recipient_category,
       status,
       access_class,
       email_verified_at,
       terms_version,
       terms_accepted_at,
       approved_at,
       approved_by,
       approval_role,
       approval_policy_version,
       approval_note,
       denied_at,
       denied_by,
       denial_reason,
       requested_at,
       expires_at,
       risk_score,
       risk_flags
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getDocument(env, documentId, version) {
  return await first(
    env,
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       classification,
       access_class,
       source_object,
       source_sha256,
       licence_terms_version,
       is_listed,
       requires_approval
     FROM documents
     WHERE id = ?
       AND version = ?
     LIMIT 1`,
    [documentId, version],
  );
}

async function getReleasePolicy(env, documentId, version) {
  return await first(
    env,
    `SELECT
       id,
       document_id,
       document_version,
       release_class,
       policy_status,
       public_visibility,
       access_mode,
       release_state,
       licence_terms_id,
       licence_terms_version,
       licence_terms_status,
       request_intake_policy_id,
       listed_publicly,
       request_button_enabled,
       public_download_enabled,
       approval_required,
       email_verification_required,
       manual_review_required,
       payment_required,
       watermark_required,
       personalised_pdf_required,
       download_id_required,
       single_use_link_required,
       evidence_bundle_required,
       source_hash_required,
       effective_from,
       effective_until
     FROM document_release_policies
     WHERE document_id = ?
       AND document_version = ?
     ORDER BY
       CASE policy_status
         WHEN 'active' THEN 0
         WHEN 'approved' THEN 1
         WHEN 'pending_review' THEN 2
         WHEN 'draft' THEN 3
         ELSE 4
       END,
       updated_at DESC
     LIMIT 1`,
    [documentId, version],
  );
}

async function getLatestReviewEvent(env, requestId) {
  return await first(
    env,
    `SELECT
       event_type,
       previous_status,
       new_status,
       actor,
       reason,
       note,
       created_at
     FROM document_access_request_review_events
     WHERE request_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [requestId],
  );
}

async function countExistingLicences(env, requestId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_licences
     WHERE request_id = ?`,
    [requestId],
  );

  return numberValue(row?.total);
}

async function countDownloadLinksForRequest(env, requestId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_download_links dl
     INNER JOIN document_licences l
       ON l.id = dl.licence_id
     WHERE l.request_id = ?`,
    [requestId],
  );

  return numberValue(row?.total);
}

function evaluateGate({
  accessRequest,
  document,
  releasePolicy,
  existingLicenceCount,
  downstreamDownloadLinkCount,
}) {
  const blockers = [];
  const warnings = [];

  if (!accessRequest) {
    blockers.push("access_request_not_found");
    return { blockers, warnings };
  }

  if (accessRequest.status !== "review_approved") {
    blockers.push("status_not_review_approved");
  }

  if (!accessRequest.email_verified_at) {
    blockers.push("email_not_verified");
  }

  if (!accessRequest.terms_accepted_at) {
    blockers.push("terms_not_accepted");
  }

  if (accessRequest.denied_at || accessRequest.denied_by) {
    blockers.push("request_has_denial_marker");
  }

  if (existingLicenceCount > 0) {
    blockers.push("licence_already_exists_for_request");
  }

  if (downstreamDownloadLinkCount > 0) {
    blockers.push("download_link_already_exists_for_request");
  }

  if (!document) {
    blockers.push("document_not_found_for_request_version");
  } else {
    if (document.status !== "active") blockers.push("document_not_active");
    if (document.version !== accessRequest.document_version) blockers.push("document_version_mismatch");
    if (!document.licence_terms_version) blockers.push("document_missing_licence_terms_version");
    if (!document.source_object) blockers.push("document_missing_source_object");
    if (!document.source_sha256) blockers.push("document_missing_source_sha256");
  }

  if (!releasePolicy) {
    blockers.push("release_policy_missing");
  } else {
    if (releasePolicy.policy_status !== "active") {
      blockers.push(`release_policy_status_${releasePolicy.policy_status || "missing"}`);
    }

    if (releasePolicy.release_state !== "request_open") {
      blockers.push(`release_state_${releasePolicy.release_state || "missing"}`);
    }

    if (releasePolicy.licence_terms_status !== "active") {
      blockers.push(`licence_terms_status_${releasePolicy.licence_terms_status || "missing"}`);
    }

    if (boolValue(releasePolicy.email_verification_required) && !accessRequest.email_verified_at) {
      blockers.push("policy_requires_verified_email");
    }

    if (boolValue(releasePolicy.approval_required) && accessRequest.status !== "review_approved") {
      blockers.push("policy_requires_review_approval");
    }

    if (boolValue(releasePolicy.source_hash_required) && !document?.source_sha256) {
      blockers.push("policy_requires_source_hash");
    }

    if (!boolValue(releasePolicy.personalised_pdf_required)) {
      warnings.push("policy_does_not_require_personalised_pdf");
    }

    if (!boolValue(releasePolicy.download_id_required)) {
      warnings.push("policy_does_not_require_download_id");
    }

    if (!boolValue(releasePolicy.single_use_link_required)) {
      warnings.push("policy_does_not_require_single_use_link");
    }
  }

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
  };
}

export async function evaluateCdasReviewToLicenceEligibility(env, requestId) {
  const id = cleanText(requestId);
  const accessRequest = await getAccessRequest(env, id);

  if (!accessRequest) {
    return {
      ok: false,
      eligible: false,
      decision: "blocked",
      request_id: id,
      blockers: ["access_request_not_found"],
      warnings: [],
      request: null,
      document: null,
      release_policy: null,
      latest_review_event: null,
      counts: {
        existing_licences_for_request: 0,
        downstream_download_links_for_request: 0,
      },
      safety: {
        licence_created: false,
        generated_pdf_created: false,
        download_link_created: false,
        email_sent: false,
      },
    };
  }

  const [document, releasePolicy, latestReviewEvent, existingLicenceCount, downstreamDownloadLinkCount] =
    await Promise.all([
      getDocument(env, accessRequest.document_id, accessRequest.document_version),
      getReleasePolicy(env, accessRequest.document_id, accessRequest.document_version),
      getLatestReviewEvent(env, id),
      countExistingLicences(env, id),
      countDownloadLinksForRequest(env, id),
    ]);

  const gate = evaluateGate({
    accessRequest,
    document,
    releasePolicy,
    existingLicenceCount,
    downstreamDownloadLinkCount,
  });

  const eligible = gate.blockers.length === 0;

  return {
    ok: true,
    eligible,
    decision: eligible ? "eligible_for_licence_issue" : "blocked",
    request_id: id,
    blockers: gate.blockers,
    warnings: gate.warnings,
    counts: {
      existing_licences_for_request: existingLicenceCount,
      downstream_download_links_for_request: downstreamDownloadLinkCount,
    },
    request: accessRequest,
    document: document || null,
    release_policy: releasePolicy || null,
    latest_review_event: latestReviewEvent || null,
    next_allowed_action: eligible ? "issue_licence" : null,
    safety: {
      licence_created: false,
      generated_pdf_created: false,
      download_link_created: false,
      email_sent: false,
    },
  };
}

export async function getCdasReviewToLicenceEligibility(request, env, requestId) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to evaluate review-to-licence eligibility.",
      },
      405,
    );
  }

  const result = await evaluateCdasReviewToLicenceEligibility(env, requestId);

  if (!result.request) {
    return jsonResponse(
      {
        ok: false,
        error: "access_request_not_found",
        message: "CDAS access request was not found.",
        request_id: cleanText(requestId),
      },
      404,
    );
  }

  return jsonResponse(result);
}
