import {
  buildCdasGeneratedPdfFilename,
  buildCdasGeneratedPdfObjectKey,
} from "../../../cdas/generated-pdf-naming.js";

import {
  evaluateCdasLicenceToPdfEligibility,
} from "../../../cdas/licence-to-pdf-gate.js";

const PDF_PREPARATION_POLICY_VERSION = "U3-T";
const REQUIRED_ISSUANCE_POLICY_VERSION = "U3-S";
const REQUIRED_LICENCE_PREPARATION_POLICY_VERSION = "U3-R";
const REQUIRED_APPROVAL_POLICY_VERSION = "U3-Q";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function sameText(left, right) {
  return cleanText(left) === cleanText(right);
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 8) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);

  return Array.from(values)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function makePreparationEventId() {
  return `lic_pdf_prep_${Date.now().toString(36)}_${randomHex(8)}`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safetyPayload(overrides = {}) {
  return {
    pdf_preparation_evidence_created: false,

    r2_source_read: false,
    r2_generated_object_read: false,
    r2_generated_object_written: false,

    generated_pdf_created: false,
    licence_generated_pdf_fields_updated: false,

    download_link_created: false,
    download_link_activated: false,

    email_sent: false,
    download_served: false,

    ...overrides,
  };
}

function fail(
  error,
  message,
  status = 409,
  extra = {},
) {
  return jsonResponse(
    {
      ok: false,
      prepared: false,
      error,
      message,
      ...extra,
      safety: safetyPayload(),
    },
    status,
  );
}

function success(payload = {}) {
  return jsonResponse({
    ok: true,
    ...payload,
  });
}

async function readJsonBody(request) {
  try {
    const body = await request.json();

    return body && typeof body === "object"
      ? body
      : {};
  } catch {
    return {};
  }
}

async function first(
  env,
  sql,
  bindings = [],
) {
  return await env.RELAYHUB_DB.prepare(sql)
    .bind(...bindings)
    .first();
}

async function getAccessRequest(
  env,
  requestId,
) {
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
       request_review_status,
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
       expires_at
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getLicenceByRequestId(
  env,
  requestId,
) {
  return await first(
    env,
    `SELECT *
     FROM document_licences
     WHERE request_id = ?
     ORDER BY issued_at DESC
     LIMIT 1`,
    [requestId],
  );
}

async function countLicencesForRequest(
  env,
  requestId,
) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_licences
     WHERE request_id = ?`,
    [requestId],
  );

  return Number(row?.total || 0);
}

async function getIssueEvent(
  env,
  requestId,
) {
  return await first(
    env,
    `SELECT *
     FROM document_access_request_licence_issue_events
     WHERE request_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [requestId],
  );
}

async function countIssueEvents(
  env,
  requestId,
) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_access_request_licence_issue_events
     WHERE request_id = ?`,
    [requestId],
  );

  return Number(row?.total || 0);
}

async function getLicencePreparationEvent(
  env,
  preparationEventId,
) {
  const id = cleanText(preparationEventId);

  if (!id) {
    return null;
  }

  return await first(
    env,
    `SELECT *
     FROM document_access_request_licence_preparation_events
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

async function getReviewEvent(
  env,
  reviewEventId,
) {
  const id = cleanText(reviewEventId);

  if (!id) {
    return null;
  }

  return await first(
    env,
    `SELECT
       id,
       request_id,
       event_type,
       previous_status,
       new_status,
       actor,
       reason,
       note,
       metadata_json,
       created_at
     FROM document_access_request_review_events
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

async function getExistingPdfPreparationByLicence(
  env,
  licenceId,
) {
  const id = cleanText(licenceId);

  if (!id) {
    return null;
  }

  return await first(
    env,
    `SELECT *
     FROM document_licence_pdf_preparation_events
     WHERE licence_id = ?
     LIMIT 1`,
    [id],
  );
}

async function getExistingPdfPreparationByRequest(
  env,
  requestId,
) {
  const id = cleanText(requestId);

  if (!id) {
    return null;
  }

  return await first(
    env,
    `SELECT *
     FROM document_licence_pdf_preparation_events
     WHERE request_id = ?
     LIMIT 1`,
    [id],
  );
}

async function countDownloadLinksForLicence(
  env,
  licenceId,
) {
  const id = cleanText(licenceId);

  if (!id) {
    return 0;
  }

  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_download_links
     WHERE licence_id = ?`,
    [id],
  );

  return Number(row?.total || 0);
}

function parseJsonObject(value) {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);

    return (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    )
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  const text = cleanText(value);

  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);

    return Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function evaluateProvenance({
  accessRequest,
  licence,
  licenceCount,
  issueEvent,
  issueEventCount,
  issueMetadata,
  licencePreparation,
  reviewEvent,
  eligibility,
  downloadLinkCount,
}) {
  const blockers = [];

  if (!accessRequest) {
    blockers.push("access_request_not_found");

    return Array.from(new Set(blockers));
  }

  if (
    accessRequest.status !==
    "licence_issued"
  ) {
    blockers.push(
      "request_status_not_licence_issued",
    );
  }

  if (
    accessRequest.request_review_status !==
    "approved_for_licence_prep"
  ) {
    blockers.push(
      "request_review_status_not_approved_for_licence_prep",
    );
  }

  if (
    accessRequest.approval_policy_version !==
    REQUIRED_APPROVAL_POLICY_VERSION
  ) {
    blockers.push(
      "request_approval_policy_not_u3_q",
    );
  }

  if (
    accessRequest.denied_at ||
    accessRequest.denied_by
  ) {
    blockers.push(
      "request_has_denial_marker",
    );
  }

  if (!licence) {
    blockers.push(
      "issued_licence_missing",
    );

    return Array.from(new Set(blockers));
  }

  if (licenceCount !== 1) {
    blockers.push(
      "issued_licence_count_not_one",
    );
  }

  if (
    !sameText(
      licence.request_id,
      accessRequest.id,
    )
  ) {
    blockers.push(
      "licence_request_id_mismatch",
    );
  }

  if (
    !sameText(
      licence.document_id,
      accessRequest.document_id,
    )
  ) {
    blockers.push(
      "licence_document_id_mismatch",
    );
  }

  if (
    !sameText(
      licence.document_version,
      accessRequest.document_version,
    )
  ) {
    blockers.push(
      "licence_document_version_mismatch",
    );
  }

  if (
    licence.status !== "issued"
  ) {
    blockers.push(
      `licence_status_${licence.status || "missing"}`,
    );
  }

  if (
    licence.revoked_at ||
    licence.revoked_by
  ) {
    blockers.push(
      "licence_revoked",
    );
  }

  if (licence.superseded_by) {
    blockers.push(
      "licence_superseded",
    );
  }

  if (licence.confirmed_leak_at) {
    blockers.push(
      "licence_confirmed_leak_recorded",
    );
  }

  if (!licence.licence_number) {
    blockers.push(
      "licence_number_missing",
    );
  }

  if (!licence.source_object) {
    blockers.push(
      "licence_source_object_missing",
    );
  }

  if (!licence.source_sha256) {
    blockers.push(
      "licence_source_sha256_missing",
    );
  }

  if (!licence.rendered_licence_body) {
    blockers.push(
      "rendered_licence_body_missing",
    );
  }

  if (!licence.rendered_licence_sha256) {
    blockers.push(
      "rendered_licence_sha256_missing",
    );
  }

  if (!licence.rendered_terms_body_sha256) {
    blockers.push(
      "rendered_terms_body_sha256_missing",
    );
  }

  if (!licence.rendered_licence_at) {
    blockers.push(
      "rendered_licence_at_missing",
    );
  }

  const unresolvedPlaceholders =
    parseJsonArray(
      licence.rendered_licence_unresolved_placeholders,
    );

  if (unresolvedPlaceholders === null) {
    blockers.push(
      "rendered_licence_unresolved_placeholders_invalid",
    );
  } else if (
    unresolvedPlaceholders.length > 0
  ) {
    blockers.push(
      "rendered_licence_has_unresolved_placeholders",
    );
  }

  if (
    licence.generated_pdf_status !==
    "not_generated"
  ) {
    blockers.push(
      `generated_pdf_status_${licence.generated_pdf_status || "missing"}`,
    );
  }

  if (licence.generated_pdf_object_key) {
    blockers.push(
      "generated_pdf_object_key_already_present",
    );
  }

  if (licence.generated_pdf_filename) {
    blockers.push(
      "generated_pdf_filename_already_present",
    );
  }

  if (licence.generated_pdf_sha256) {
    blockers.push(
      "generated_pdf_sha256_already_present",
    );
  }

  if (
    licence.generated_pdf_size_bytes !== null &&
    licence.generated_pdf_size_bytes !== undefined
  ) {
    blockers.push(
      "generated_pdf_size_already_present",
    );
  }

  if (licence.generated_pdf_content_type) {
    blockers.push(
      "generated_pdf_content_type_already_present",
    );
  }

  if (licence.generated_pdf_created_at) {
    blockers.push(
      "generated_pdf_created_at_already_present",
    );
  }

  if (licence.generated_pdf_error) {
    blockers.push(
      "generated_pdf_error_present",
    );
  }

  if (!issueEvent) {
    blockers.push(
      "u3_s_issue_event_missing",
    );

    return Array.from(new Set(blockers));
  }

  if (issueEventCount !== 1) {
    blockers.push(
      "u3_s_issue_event_count_not_one",
    );
  }

  if (
    !sameText(
      issueEvent.request_id,
      accessRequest.id,
    )
  ) {
    blockers.push(
      "u3_s_issue_event_request_id_mismatch",
    );
  }

  if (
    !sameText(
      issueEvent.licence_id,
      licence.id,
    )
  ) {
    blockers.push(
      "u3_s_issue_event_licence_id_mismatch",
    );
  }

  if (
    !sameText(
      issueEvent.licence_number,
      licence.licence_number,
    )
  ) {
    blockers.push(
      "u3_s_issue_event_licence_number_mismatch",
    );
  }

  if (
    issueEvent.previous_status !==
    "approved_pending_licence"
  ) {
    blockers.push(
      "u3_s_issue_event_previous_status_invalid",
    );
  }

  if (
    issueEvent.new_status !==
    "licence_issued"
  ) {
    blockers.push(
      "u3_s_issue_event_new_status_invalid",
    );
  }

  if (!issueMetadata) {
    blockers.push(
      "u3_s_issue_metadata_invalid",
    );

    return Array.from(new Set(blockers));
  }

  if (
    issueMetadata.phase !==
    REQUIRED_ISSUANCE_POLICY_VERSION
  ) {
    blockers.push(
      "u3_s_issue_metadata_phase_invalid",
    );
  }

  if (
    issueMetadata.issuance_policy_version !==
    REQUIRED_ISSUANCE_POLICY_VERSION
  ) {
    blockers.push(
      "u3_s_issuance_policy_version_invalid",
    );
  }

  if (
    issueMetadata.preparation_policy_version !==
    REQUIRED_LICENCE_PREPARATION_POLICY_VERSION
  ) {
    blockers.push(
      "u3_s_licence_preparation_policy_version_invalid",
    );
  }

  if (
    issueMetadata.approval_policy_version !==
    REQUIRED_APPROVAL_POLICY_VERSION
  ) {
    blockers.push(
      "u3_s_approval_policy_version_invalid",
    );
  }

  if (
    issueMetadata.generated_pdf_created !==
    false
  ) {
    blockers.push(
      "u3_s_metadata_claims_pdf_created",
    );
  }

  if (
    issueMetadata.download_link_created !==
    false
  ) {
    blockers.push(
      "u3_s_metadata_claims_download_link_created",
    );
  }

  if (
    issueMetadata.email_sent !== false
  ) {
    blockers.push(
      "u3_s_metadata_claims_email_sent",
    );
  }

  if (
    issueMetadata.download_served !== false
  ) {
    blockers.push(
      "u3_s_metadata_claims_download_served",
    );
  }

  if (!licencePreparation) {
    blockers.push(
      "u3_r_preparation_event_missing",
    );

    return Array.from(new Set(blockers));
  }

  if (
    !sameText(
      licencePreparation.id,
      issueMetadata.preparation_event_id,
    )
  ) {
    blockers.push(
      "u3_r_preparation_event_id_mismatch",
    );
  }

  if (
    !sameText(
      licencePreparation.request_id,
      accessRequest.id,
    )
  ) {
    blockers.push(
      "u3_r_preparation_request_id_mismatch",
    );
  }

  if (
    !sameText(
      licencePreparation.document_id,
      licence.document_id,
    )
  ) {
    blockers.push(
      "u3_r_preparation_document_id_mismatch",
    );
  }

  if (
    !sameText(
      licencePreparation.document_version,
      licence.document_version,
    )
  ) {
    blockers.push(
      "u3_r_preparation_document_version_mismatch",
    );
  }

  if (
    licencePreparation.preparation_policy_version !==
    REQUIRED_LICENCE_PREPARATION_POLICY_VERSION
  ) {
    blockers.push(
      "u3_r_preparation_policy_version_invalid",
    );
  }

  if (
    licencePreparation.approval_policy_version !==
    REQUIRED_APPROVAL_POLICY_VERSION
  ) {
    blockers.push(
      "u3_r_approval_policy_version_invalid",
    );
  }

  if (
    !sameText(
      issueMetadata.review_event_id,
      licencePreparation.review_event_id,
    )
  ) {
    blockers.push(
      "u3_s_u3_r_review_event_id_mismatch",
    );
  }

  if (
    !sameText(
      issueMetadata.release_policy_id,
      licencePreparation.release_policy_id,
    )
  ) {
    blockers.push(
      "u3_s_u3_r_release_policy_id_mismatch",
    );
  }

  if (
    !sameText(
      issueMetadata.licence_terms_id,
      licencePreparation.licence_terms_id,
    )
  ) {
    blockers.push(
      "u3_s_u3_r_licence_terms_id_mismatch",
    );
  }

  if (
    !sameText(
      issueMetadata.licence_terms_version,
      licencePreparation.licence_terms_version,
    )
  ) {
    blockers.push(
      "u3_s_u3_r_licence_terms_version_mismatch",
    );
  }

  if (
    !sameText(
      issueMetadata.licence_terms_body_sha256,
      licencePreparation.licence_terms_body_sha256,
    )
  ) {
    blockers.push(
      "u3_s_u3_r_terms_hash_mismatch",
    );
  }

  if (
    !sameText(
      issueMetadata.source_object,
      licencePreparation.source_object,
    )
  ) {
    blockers.push(
      "u3_s_u3_r_source_object_mismatch",
    );
  }

  if (
    !sameText(
      issueMetadata.source_sha256,
      licencePreparation.source_sha256,
    )
  ) {
    blockers.push(
      "u3_s_u3_r_source_sha256_mismatch",
    );
  }

  if (
    !sameText(
      licence.source_object,
      licencePreparation.source_object,
    )
  ) {
    blockers.push(
      "licence_source_object_differs_from_u3_r",
    );
  }

  if (
    !sameText(
      licence.source_sha256,
      licencePreparation.source_sha256,
    )
  ) {
    blockers.push(
      "licence_source_sha256_differs_from_u3_r",
    );
  }

  if (
    !sameText(
      licence.licence_terms_version,
      licencePreparation.licence_terms_version,
    )
  ) {
    blockers.push(
      "licence_terms_version_differs_from_u3_r",
    );
  }

  if (
    !sameText(
      licence.rendered_terms_body_sha256,
      licencePreparation.licence_terms_body_sha256,
    )
  ) {
    blockers.push(
      "rendered_terms_hash_differs_from_u3_r",
    );
  }

  if (!reviewEvent) {
    blockers.push(
      "u3_q_review_event_missing",
    );
  } else {
    if (
      !sameText(
        reviewEvent.id,
        licencePreparation.review_event_id,
      )
    ) {
      blockers.push(
        "u3_q_review_event_id_mismatch",
      );
    }

    if (
      !sameText(
        reviewEvent.request_id,
        accessRequest.id,
      )
    ) {
      blockers.push(
        "u3_q_review_event_request_id_mismatch",
      );
    }

    if (
      reviewEvent.event_type !==
      "review_approved"
    ) {
      blockers.push(
        "u3_q_review_event_not_approved",
      );
    }

    if (
      reviewEvent.new_status !==
      "approved_pending_licence"
    ) {
      blockers.push(
        "u3_q_review_event_status_invalid",
      );
    }
  }

  if (
    !eligibility ||
    eligibility.eligible !== true
  ) {
    blockers.push(
      "licence_to_pdf_eligibility_blocked",
    );
  }

  if (
    eligibility?.request &&
    !sameText(
      eligibility.request.id,
      accessRequest.id,
    )
  ) {
    blockers.push(
      "licence_to_pdf_request_mismatch",
    );
  }

  if (
    eligibility?.document &&
    !sameText(
      eligibility.document.id,
      licence.document_id,
    )
  ) {
    blockers.push(
      "licence_to_pdf_document_id_mismatch",
    );
  }

  if (
    eligibility?.document &&
    !sameText(
      eligibility.document.version,
      licence.document_version,
    )
  ) {
    blockers.push(
      "licence_to_pdf_document_version_mismatch",
    );
  }

  if (
    eligibility?.release_policy &&
    !sameText(
      eligibility.release_policy.id,
      licencePreparation.release_policy_id,
    )
  ) {
    blockers.push(
      "current_release_policy_differs_from_u3_r",
    );
  }

  if (downloadLinkCount !== 0) {
    blockers.push(
      "download_link_already_exists_for_licence",
    );
  }

  return Array.from(new Set(blockers));
}

function preparationMatches(
  existing,
  snapshot,
) {
  if (!existing) {
    return false;
  }

  const fields = [
    "request_id",
    "licence_id",
    "licence_number",

    "document_id",
    "document_version",

    "review_event_id",
    "licence_preparation_event_id",
    "licence_issue_event_id",

    "source_object",
    "source_sha256",

    "rendered_licence_sha256",
    "rendered_terms_body_sha256",

    "planned_generated_pdf_object_key",
    "planned_generated_pdf_filename",
    "planned_generated_pdf_content_type",

    "approval_policy_version",
    "licence_preparation_policy_version",
    "licence_issuance_policy_version",
    "pdf_preparation_policy_version",
  ];

  return fields.every(
    (field) =>
      sameText(
        existing[field],
        snapshot[field],
      ),
  );
}

async function insertPdfPreparation(
  env,
  snapshot,
) {
  const id = makePreparationEventId();
  const createdAt = nowIso();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_licence_pdf_preparation_events (
       id,

       request_id,
       licence_id,
       licence_number,

       document_id,
       document_version,

       review_event_id,
       licence_preparation_event_id,
       licence_issue_event_id,

       source_object,
       source_sha256,

       rendered_licence_sha256,
       rendered_terms_body_sha256,

       planned_generated_pdf_object_key,
       planned_generated_pdf_filename,
       planned_generated_pdf_content_type,

       approval_policy_version,
       licence_preparation_policy_version,
       licence_issuance_policy_version,
       pdf_preparation_policy_version,

       actor,
       note,

       metadata_json,
       created_at
     )
     VALUES (
       ?,
       ?, ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?,
       ?, ?
     )`,
  )
    .bind(
      id,

      snapshot.request_id,
      snapshot.licence_id,
      snapshot.licence_number,

      snapshot.document_id,
      snapshot.document_version,

      snapshot.review_event_id,
      snapshot.licence_preparation_event_id,
      snapshot.licence_issue_event_id,

      snapshot.source_object,
      snapshot.source_sha256,

      snapshot.rendered_licence_sha256,
      snapshot.rendered_terms_body_sha256,

      snapshot.planned_generated_pdf_object_key,
      snapshot.planned_generated_pdf_filename,
      snapshot.planned_generated_pdf_content_type,

      snapshot.approval_policy_version,
      snapshot.licence_preparation_policy_version,
      snapshot.licence_issuance_policy_version,
      snapshot.pdf_preparation_policy_version,

      snapshot.actor,
      snapshot.note,

      JSON.stringify(snapshot.metadata || {}),
      createdAt,
    )
    .run();

  return await first(
    env,
    `SELECT *
     FROM document_licence_pdf_preparation_events
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

export async function handleCdasGeneratedPdfPreparation(
  request,
  env,
) {
  if (request.method !== "POST") {
    return fail(
      "method_not_allowed",
      "Use POST to prepare an issued CDAS licence for later explicit PDF generation.",
      405,
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "generated_pdf_preparation_database_unavailable",
      "D1 database binding is unavailable.",
      503,
    );
  }

  const body = await readJsonBody(request);

  const requestId = cleanText(
    body.request_id ||
    body.access_request_id,
  );

  if (!requestId) {
    return fail(
      "generated_pdf_preparation_request_id_missing",
      "Document access request ID is required.",
      400,
    );
  }

  const actor =
    cleanText(body.actor) ||
    cleanText(env.UPLOAD_ADMIN_ACTOR) ||
    cleanText(env.RELAYHUB_ADMIN_ACTOR) ||
    cleanText(
      request.headers.get(
        "cf-access-authenticated-user-email",
      ),
    ) ||
    cleanText(
      request.headers.get("x-admin-actor"),
    ) ||
    "admin";

  const note =
    nullableText(
      body.note ||
      body.reason,
    );

  const [
    accessRequest,
    licence,
    licenceCount,
    issueEvent,
    issueEventCount,
  ] = await Promise.all([
    getAccessRequest(
      env,
      requestId,
    ),

    getLicenceByRequestId(
      env,
      requestId,
    ),

    countLicencesForRequest(
      env,
      requestId,
    ),

    getIssueEvent(
      env,
      requestId,
    ),

    countIssueEvents(
      env,
      requestId,
    ),
  ]);

  if (!accessRequest) {
    return fail(
      "access_request_not_found",
      "Document access request was not found.",
      404,
      {
        request_id: requestId,
      },
    );
  }

  if (!licence) {
    return fail(
      "issued_licence_missing",
      "An issued U3-S licence is required before generated PDF preparation.",
      409,
      {
        request_id: requestId,
      },
    );
  }

  const issueMetadata =
    parseJsonObject(
      issueEvent?.metadata_json,
    );

  const licencePreparationId =
    cleanText(
      issueMetadata?.preparation_event_id,
    );

  const reviewEventId =
    cleanText(
      issueMetadata?.review_event_id,
    );

  const [
    licencePreparation,
    reviewEvent,
    eligibility,
    downloadLinkCount,
    existingByLicence,
    existingByRequest,
  ] = await Promise.all([
    getLicencePreparationEvent(
      env,
      licencePreparationId,
    ),

    getReviewEvent(
      env,
      reviewEventId,
    ),

    evaluateCdasLicenceToPdfEligibility(
      env,
      licence.id,
    ),

    countDownloadLinksForLicence(
      env,
      licence.id,
    ),

    getExistingPdfPreparationByLicence(
      env,
      licence.id,
    ),

    getExistingPdfPreparationByRequest(
      env,
      requestId,
    ),
  ]);

  const blockers =
    evaluateProvenance({
      accessRequest,
      licence,
      licenceCount,
      issueEvent,
      issueEventCount,
      issueMetadata,
      licencePreparation,
      reviewEvent,
      eligibility,
      downloadLinkCount,
    });

  if (blockers.length > 0) {
    return fail(
      "generated_pdf_preparation_blocked",
      "This issued licence is not eligible for generated PDF preparation.",
      409,
      {
        request_id: requestId,
        licence_id:
          licence.id,
        licence_number:
          licence.licence_number,
        blockers,
        licence_to_pdf_blockers:
          eligibility?.blockers || [],
        licence_to_pdf_warnings:
          eligibility?.warnings || [],
      },
    );
  }

  const document =
    eligibility.document;

  if (!document) {
    return fail(
      "generated_pdf_preparation_document_missing",
      "The document required for generated PDF preparation is unavailable.",
      409,
      {
        request_id: requestId,
        licence_id: licence.id,
      },
    );
  }

  const plannedObjectKey =
    buildCdasGeneratedPdfObjectKey({
      licence,
      document,
    });

  const plannedFilename =
    buildCdasGeneratedPdfFilename({
      licence,
      document,
    });

  if (!plannedObjectKey) {
    return fail(
      "planned_generated_pdf_object_key_missing",
      "The generated PDF destination object key could not be derived.",
      409,
      {
        request_id: requestId,
        licence_id: licence.id,
      },
    );
  }

  if (
    !plannedObjectKey.startsWith(
      "docs/generated/cdas/",
    )
  ) {
    return fail(
      "planned_generated_pdf_object_key_outside_cdas_prefix",
      "The planned generated PDF object key is outside the controlled CDAS generated-object prefix.",
      409,
      {
        request_id: requestId,
        licence_id: licence.id,
        planned_generated_pdf_object_key:
          plannedObjectKey,
      },
    );
  }

  if (
    !plannedObjectKey.endsWith(".pdf")
  ) {
    return fail(
      "planned_generated_pdf_object_key_not_pdf",
      "The planned generated object key is not a PDF path.",
      409,
      {
        request_id: requestId,
        licence_id: licence.id,
        planned_generated_pdf_object_key:
          plannedObjectKey,
      },
    );
  }

  if (
    !plannedFilename ||
    !plannedFilename
      .toLowerCase()
      .endsWith(".pdf")
  ) {
    return fail(
      "planned_generated_pdf_filename_invalid",
      "The planned generated PDF filename is invalid.",
      409,
      {
        request_id: requestId,
        licence_id: licence.id,
        planned_generated_pdf_filename:
          plannedFilename || null,
      },
    );
  }

  const snapshot = {
    request_id:
      accessRequest.id,

    licence_id:
      licence.id,

    licence_number:
      licence.licence_number,

    document_id:
      licence.document_id,

    document_version:
      licence.document_version,

    review_event_id:
      reviewEvent.id,

    licence_preparation_event_id:
      licencePreparation.id,

    licence_issue_event_id:
      issueEvent.id,

    source_object:
      licence.source_object,

    source_sha256:
      licence.source_sha256,

    rendered_licence_sha256:
      licence.rendered_licence_sha256,

    rendered_terms_body_sha256:
      licence.rendered_terms_body_sha256,

    planned_generated_pdf_object_key:
      plannedObjectKey,

    planned_generated_pdf_filename:
      plannedFilename,

    planned_generated_pdf_content_type:
      "application/pdf",

    approval_policy_version:
      REQUIRED_APPROVAL_POLICY_VERSION,

    licence_preparation_policy_version:
      REQUIRED_LICENCE_PREPARATION_POLICY_VERSION,

    licence_issuance_policy_version:
      REQUIRED_ISSUANCE_POLICY_VERSION,

    pdf_preparation_policy_version:
      PDF_PREPARATION_POLICY_VERSION,

    actor,
    note,

    metadata: {
      phase:
        PDF_PREPARATION_POLICY_VERSION,

      request_status:
        accessRequest.status,

      request_review_status:
        accessRequest.request_review_status,

      licence_status:
        licence.status,

      generated_pdf_status:
        licence.generated_pdf_status,

      review_event_id:
        reviewEvent.id,

      licence_preparation_event_id:
        licencePreparation.id,

      licence_issue_event_id:
        issueEvent.id,

      release_policy_id:
        licencePreparation.release_policy_id,

      licence_terms_id:
        licencePreparation.licence_terms_id,

      licence_terms_version:
        licencePreparation.licence_terms_version,

      approval_policy_version:
        REQUIRED_APPROVAL_POLICY_VERSION,

      licence_preparation_policy_version:
        REQUIRED_LICENCE_PREPARATION_POLICY_VERSION,

      licence_issuance_policy_version:
        REQUIRED_ISSUANCE_POLICY_VERSION,

      pdf_preparation_policy_version:
        PDF_PREPARATION_POLICY_VERSION,

      source_object:
        licence.source_object,

      source_sha256:
        licence.source_sha256,

      rendered_licence_sha256:
        licence.rendered_licence_sha256,

      rendered_terms_body_sha256:
        licence.rendered_terms_body_sha256,

      planned_generated_pdf_object_key:
        plannedObjectKey,

      planned_generated_pdf_filename:
        plannedFilename,

      planned_generated_pdf_content_type:
        "application/pdf",

      r2_source_read: false,
      r2_generated_object_read: false,
      r2_generated_object_written: false,

      generated_pdf_created: false,
      licence_generated_pdf_fields_updated: false,

      download_link_created: false,
      download_link_activated: false,

      email_sent: false,
      download_served: false,
    },
  };

  /*
   * The two unique indexes should ensure these resolve
   * to the same row whenever either exists.
   *
   * If they resolve to different rows, durable state
   * is contradictory and must be recovered manually.
   */
  if (
    existingByLicence &&
    existingByRequest &&
    existingByLicence.id !==
      existingByRequest.id
  ) {
    return fail(
      "u3_t_recovery_required",
      "Conflicting U3-T PDF preparation records exist for this request and licence. Manual recovery is required.",
      409,
      {
        request_id: requestId,
        licence_id: licence.id,
        existing: {
          licence_preparation_id:
            existingByLicence.id,
          request_preparation_id:
            existingByRequest.id,
        },
      },
    );
  }

  const existingPreparation =
    existingByLicence ||
    existingByRequest;

  if (existingPreparation) {
    if (
      !preparationMatches(
        existingPreparation,
        snapshot,
      )
    ) {
      return fail(
        "generated_pdf_preparation_evidence_conflict",
        "Existing U3-T PDF preparation evidence does not match the current issued licence inputs.",
        409,
        {
          request_id: requestId,
          licence_id: licence.id,
          preparation_event_id:
            existingPreparation.id,
        },
      );
    }

    return success({
      action:
        "prepare_generated_pdf",

      prepared: true,
      already_prepared: true,

      request_id:
        requestId,

      licence_id:
        licence.id,

      licence_number:
        licence.licence_number,

      preparation_event:
        existingPreparation,

      planned_generated_pdf: {
        object_key:
          existingPreparation
            .planned_generated_pdf_object_key,

        filename:
          existingPreparation
            .planned_generated_pdf_filename,

        content_type:
          existingPreparation
            .planned_generated_pdf_content_type,
      },

      next_allowed_action:
        "explicit_pdf_generation",

      safety:
        safetyPayload({
          pdf_preparation_evidence_created:
            true,
        }),

      message:
        "U3-T generated PDF preparation evidence already exists and matches the current issued licence. No PDF was generated, no R2 object was read or written, no download link was created, no email was sent, and no download was served.",
    });
  }

  let preparation;

  try {
    preparation =
      await insertPdfPreparation(
        env,
        snapshot,
      );
  } catch (error) {
    const [
      replayByLicence,
      replayByRequest,
    ] = await Promise.all([
      getExistingPdfPreparationByLicence(
        env,
        licence.id,
      ),

      getExistingPdfPreparationByRequest(
        env,
        requestId,
      ),
    ]);

    if (
      replayByLicence &&
      replayByRequest &&
      replayByLicence.id !==
        replayByRequest.id
    ) {
      return fail(
        "u3_t_recovery_required",
        "Conflicting U3-T PDF preparation state was detected after a write collision. Manual recovery is required.",
        409,
        {
          request_id: requestId,
          licence_id: licence.id,
          detail:
            error?.message ||
            String(error),
        },
      );
    }

    const replay =
      replayByLicence ||
      replayByRequest;

    if (
      replay &&
      preparationMatches(
        replay,
        snapshot,
      )
    ) {
      return success({
        action:
          "prepare_generated_pdf",

        prepared: true,
        already_prepared: true,

        request_id:
          requestId,

        licence_id:
          licence.id,

        licence_number:
          licence.licence_number,

        preparation_event:
          replay,

        planned_generated_pdf: {
          object_key:
            replay
              .planned_generated_pdf_object_key,

          filename:
            replay
              .planned_generated_pdf_filename,

          content_type:
            replay
              .planned_generated_pdf_content_type,
        },

        next_allowed_action:
          "explicit_pdf_generation",

        safety:
          safetyPayload({
            pdf_preparation_evidence_created:
              true,
          }),

        message:
          "U3-T generated PDF preparation evidence already exists and matches the current issued licence. No duplicate preparation record was created.",
      });
    }

    return fail(
      "generated_pdf_preparation_write_failed",
      "Generated PDF preparation evidence could not be persisted.",
      409,
      {
        request_id: requestId,
        licence_id: licence.id,
        detail:
          error?.message ||
          String(error),
      },
    );
  }

  const postWriteLicence =
    await getLicenceByRequestId(
      env,
      requestId,
    );

  const postWriteDownloadLinkCount =
    await countDownloadLinksForLicence(
      env,
      licence.id,
    );

  if (!postWriteLicence) {
    return fail(
      "generated_pdf_preparation_postwrite_licence_missing",
      "U3-T preparation evidence was written but the issued licence can no longer be read. Recovery is required.",
      500,
      {
        request_id: requestId,
        licence_id: licence.id,
        preparation_event_id:
          preparation?.id || null,
      },
    );
  }

  const downstreamViolations = [];

  if (
    postWriteLicence.generated_pdf_status !==
    "not_generated"
  ) {
    downstreamViolations.push(
      "generated_pdf_status_changed",
    );
  }

  if (
    postWriteLicence.generated_pdf_object_key
  ) {
    downstreamViolations.push(
      "generated_pdf_object_key_created",
    );
  }

  if (
    postWriteLicence.generated_pdf_filename
  ) {
    downstreamViolations.push(
      "generated_pdf_filename_created",
    );
  }

  if (
    postWriteLicence.generated_pdf_sha256
  ) {
    downstreamViolations.push(
      "generated_pdf_sha256_created",
    );
  }

  if (
    postWriteLicence.generated_pdf_size_bytes !==
      null &&
    postWriteLicence.generated_pdf_size_bytes !==
      undefined
  ) {
    downstreamViolations.push(
      "generated_pdf_size_created",
    );
  }

  if (
    postWriteLicence.generated_pdf_content_type
  ) {
    downstreamViolations.push(
      "generated_pdf_content_type_created",
    );
  }

  if (
    postWriteLicence.generated_pdf_created_at
  ) {
    downstreamViolations.push(
      "generated_pdf_timestamp_created",
    );
  }

  if (
    postWriteDownloadLinkCount !== 0
  ) {
    downstreamViolations.push(
      "download_link_created",
    );
  }

  if (
    downstreamViolations.length > 0
  ) {
    return fail(
      "generated_pdf_preparation_downstream_side_effect_detected",
      "Unexpected downstream state was detected immediately after U3-T preparation. Recovery is required.",
      500,
      {
        request_id: requestId,
        licence_id: licence.id,
        preparation_event_id:
          preparation?.id || null,
        violations:
          downstreamViolations,
      },
    );
  }

  return success({
    action:
      "prepare_generated_pdf",

    prepared: true,
    already_prepared: false,

    request_id:
      requestId,

    licence_id:
      licence.id,

    licence_number:
      licence.licence_number,

    preparation_event:
      preparation,

    planned_generated_pdf: {
      object_key:
        preparation
          .planned_generated_pdf_object_key,

      filename:
        preparation
          .planned_generated_pdf_filename,

      content_type:
        preparation
          .planned_generated_pdf_content_type,
    },

    next_allowed_action:
      "explicit_pdf_generation",

    safety:
      safetyPayload({
        pdf_preparation_evidence_created:
          true,
      }),

    message:
      "U3-T generated PDF preparation evidence was recorded. No source or generated R2 object was read or written, no PDF was generated, no licence generated-PDF fields were changed, no download link was created, no email was sent, and no download was served.",
  });
}