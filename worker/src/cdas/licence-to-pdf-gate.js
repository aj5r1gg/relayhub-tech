import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function numberValue(value) {
  return Number(value || 0);
}

async function first(env, sql, bindings = []) {
  return await env.RELAYHUB_DB.prepare(sql)
    .bind(...bindings)
    .first();
}

async function getLicence(env, licenceId) {
  return await first(
    env,
    `SELECT
       id,
       licence_number,
       request_id,
       document_id,
       document_version,
       licence_holder_type,
       licence_holder_name,
       organisation_name,
       contact_name,
       contact_email,
       licence_holder_email,
       licence_holder_email_normalised,
       recipient_category,
       licence_terms_version,
       status,
       issued_at,
       expires_at,
       revoked_at,
       revoked_by,
       revocation_reason,
       superseded_by,
       corrected_from,
       suspected_leak_at,
       confirmed_leak_at,
       notes,
       rendered_licence_body,
       rendered_licence_sha256,
       rendered_terms_body_sha256,
       rendered_licence_placeholders,
       rendered_licence_unresolved_placeholders,
       rendered_licence_at,
       source_object,
       source_sha256,
       generated_pdf_object_key,
       generated_pdf_filename,
       generated_pdf_sha256,
       generated_pdf_size_bytes,
       generated_pdf_content_type,
       generated_pdf_status,
       generated_pdf_created_at,
       generated_pdf_error
     FROM document_licences
     WHERE id = ?
     LIMIT 1`,
    [licenceId],
  );
}

async function getRequest(env, requestId) {
  if (!requestId) return null;

  return await first(
    env,
    `SELECT
       id,
       document_id,
       document_version,
       name,
       email,
       email_normalised,
       status,
       email_verified_at,
       terms_version,
       terms_accepted_at,
       approved_at,
       approved_by,
       approval_role,
       approval_policy_version
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
       licence_terms_version
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
       release_state,
       licence_terms_id,
       licence_terms_version,
       licence_terms_status,
       watermark_required,
       personalised_pdf_required,
       download_id_required,
       single_use_link_required,
       evidence_bundle_required,
       source_hash_required
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

async function countDownloadLinksForLicence(env, licenceId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_download_links
     WHERE licence_id = ?`,
    [licenceId],
  );

  return numberValue(row?.total);
}

function boolValue(value) {
  return Number(value || 0) === 1;
}

function evaluatePdfGate({
  licence,
  accessRequest,
  document,
  releasePolicy,
  downloadLinkCount,
}) {
  const blockers = [];
  const warnings = [];

  if (!licence) {
    blockers.push("licence_not_found");
    return { blockers, warnings };
  }

  if (licence.status !== "issued") {
    blockers.push(`licence_status_${licence.status || "missing"}`);
  }

  if (licence.revoked_at || licence.revoked_by) {
    blockers.push("licence_revoked");
  }

  if (licence.superseded_by) {
    blockers.push("licence_superseded");
  }

  if (!licence.licence_number) {
    blockers.push("licence_number_missing");
  }

  if (!licence.request_id) {
    warnings.push("licence_missing_request_id");
  }

  if (!licence.document_id) {
    blockers.push("licence_missing_document_id");
  }

  if (!licence.document_version) {
    blockers.push("licence_missing_document_version");
  }

  if (!licence.licence_holder_name) {
    blockers.push("licence_holder_name_missing");
  }

  if (!licence.licence_holder_email) {
    blockers.push("licence_holder_email_missing");
  }

  if (!licence.licence_terms_version) {
    blockers.push("licence_terms_version_missing");
  }

  if (!licence.source_object) {
    blockers.push("licence_missing_source_object");
  }

  if (!licence.source_sha256) {
    blockers.push("licence_missing_source_sha256");
  }

  if (licence.generated_pdf_object_key || licence.generated_pdf_sha256) {
    blockers.push("generated_pdf_already_exists");
  }

  if (
    licence.generated_pdf_status &&
    !["not_generated", "failed", "pending"].includes(licence.generated_pdf_status)
  ) {
    blockers.push(`generated_pdf_status_${licence.generated_pdf_status}`);
  }

  if (downloadLinkCount > 0) {
    blockers.push("download_link_already_exists_for_licence");
  }

  if (!accessRequest) {
    warnings.push("access_request_not_found_for_licence");
  } else {
    if (accessRequest.status !== "licence_issued") {
      warnings.push(`access_request_status_${accessRequest.status || "missing"}`);
    }

    if (accessRequest.document_id !== licence.document_id) {
      blockers.push("request_document_id_mismatch");
    }

    if (accessRequest.document_version !== licence.document_version) {
      blockers.push("request_document_version_mismatch");
    }

    if (!accessRequest.email_verified_at) {
      blockers.push("request_email_not_verified");
    }

    if (!accessRequest.terms_accepted_at) {
      blockers.push("request_terms_not_accepted");
    }
  }

  if (!document) {
    blockers.push("document_not_found_for_licence_version");
  } else {
    if (document.status !== "active") {
      blockers.push("document_not_active");
    }

    if (document.source_object !== licence.source_object) {
      blockers.push("document_source_object_mismatch");
    }

    if (document.source_sha256 !== licence.source_sha256) {
      blockers.push("document_source_sha256_mismatch");
    }

    if (!document.licence_terms_version) {
      blockers.push("document_missing_licence_terms_version");
    }

    if (document.licence_terms_version !== licence.licence_terms_version) {
      warnings.push("licence_terms_version_differs_from_document_current_terms");
    }
  }

  if (!releasePolicy) {
    blockers.push("release_policy_missing");
  } else {
    if (releasePolicy.policy_status !== "active") {
      blockers.push(`release_policy_status_${releasePolicy.policy_status || "missing"}`);
    }

    if (releasePolicy.licence_terms_status !== "active") {
      blockers.push(`licence_terms_status_${releasePolicy.licence_terms_status || "missing"}`);
    }

    if (!boolValue(releasePolicy.personalised_pdf_required)) {
      warnings.push("policy_does_not_require_personalised_pdf");
    }

    if (boolValue(releasePolicy.source_hash_required) && !licence.source_sha256) {
      blockers.push("policy_requires_source_hash");
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

export async function evaluateCdasLicenceToPdfEligibility(env, licenceId) {
  const id = cleanText(licenceId);
  const licence = await getLicence(env, id);

  if (!licence) {
    return {
      ok: false,
      eligible: false,
      decision: "blocked",
      licence_id: id,
      blockers: ["licence_not_found"],
      warnings: [],
      counts: {
        download_links_for_licence: 0,
      },
      licence: null,
      request: null,
      document: null,
      release_policy: null,
      next_allowed_action: null,
      safety: {
        generated_pdf_created: false,
        download_link_created: false,
        email_sent: false,
      },
    };
  }

  const [accessRequest, document, releasePolicy, downloadLinkCount] =
    await Promise.all([
      getRequest(env, licence.request_id),
      getDocument(env, licence.document_id, licence.document_version),
      getReleasePolicy(env, licence.document_id, licence.document_version),
      countDownloadLinksForLicence(env, id),
    ]);

  const gate = evaluatePdfGate({
    licence,
    accessRequest,
    document,
    releasePolicy,
    downloadLinkCount,
  });

  const eligible = gate.blockers.length === 0;

  return {
    ok: true,
    eligible,
    decision: eligible ? "eligible_for_pdf_generation" : "blocked",
    licence_id: id,
    licence_number: licence.licence_number,
    blockers: gate.blockers,
    warnings: gate.warnings,
    counts: {
      download_links_for_licence: downloadLinkCount,
    },
    licence,
    request: accessRequest || null,
    document: document || null,
    release_policy: releasePolicy || null,
    next_allowed_action: eligible ? "generate_personalised_pdf" : null,
    safety: {
      generated_pdf_created: false,
      download_link_created: false,
      email_sent: false,
    },
  };
}

export async function getCdasLicenceToPdfEligibility(request, env, licenceId) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to evaluate licence-to-PDF eligibility.",
      },
      405,
    );
  }

  const result = await evaluateCdasLicenceToPdfEligibility(env, licenceId);

  if (!result.licence) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
        licence_id: cleanText(licenceId),
      },
      404,
    );
  }

  return jsonResponse(result);
}
