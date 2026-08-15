const PREPARATION_POLICY_VERSION = "U3-R";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(bytes = 8) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);

  return Array.from(values)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function buildPreparationEventId() {
  return `dar_lic_prep_${Date.now().toString(36)}_${randomToken(8)}`;
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

function fail(error, message, status = 409, extra = {}) {
  return jsonResponse(
    {
      ok: false,
      error,
      message,
      ...extra,
      safety: {
        licence_created: false,
        licence_issue_event_created: false,
        generated_pdf_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    status
  );
}

function success(payload = {}) {
  return jsonResponse({
    ok: true,
    ...payload,
    safety: {
      licence_created: false,
      licence_issue_event_created: false,
      generated_pdf_created: false,
      download_link_created: false,
      email_sent: false,
    },
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    [requestId]
  );
}

async function getDocument(env, documentId, documentVersion) {
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
       requires_approval,
       requestability_status,
       listed_at,
       requestable_at
     FROM documents
     WHERE id = ?
       AND version = ?
     LIMIT 1`,
    [documentId, documentVersion]
  );
}

async function getReleasePolicy(env, documentId, documentVersion) {
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
    [documentId, documentVersion]
  );
}

async function getLicenceTerms(env, termsVersion) {
  const version = cleanText(termsVersion);

  if (!version) {
    return null;
  }

  return await first(
    env,
    `SELECT
       id,
       version,
       title,
       body,
       body_sha256,
       status,
       applies_to_access_class,
       effective_from,
       effective_to
     FROM licence_terms
     WHERE version = ?
        OR id = ?
     LIMIT 1`,
    [version, version]
  );
}

async function getQualifyingReviewEvent(env, requestId) {
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
     WHERE request_id = ?
       AND event_type = 'review_approved'
       AND new_status = 'approved_pending_licence'
     ORDER BY created_at DESC
     LIMIT 1`,
    [requestId]
  );
}

async function getExistingPreparation(env, requestId) {
  return await first(
    env,
    `SELECT *
     FROM document_access_request_licence_preparation_events
     WHERE request_id = ?
     LIMIT 1`,
    [requestId]
  );
}

async function countExistingLicences(env, requestId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_licences
     WHERE request_id = ?`,
    [requestId]
  );

  return Number(row?.total || 0);
}

async function countLicenceIssueEvents(env, requestId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_access_request_licence_issue_events
     WHERE request_id = ?`,
    [requestId]
  );

  return Number(row?.total || 0);
}

async function countDownloadLinks(env, requestId) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS total
     FROM document_download_links dl
     INNER JOIN document_licences lic
       ON lic.id = dl.licence_id
     WHERE lic.request_id = ?`,
    [requestId]
  );

  return Number(row?.total || 0);
}

function deriveLicenceHolder(accessRequest) {
  const organisationName = cleanText(accessRequest.organisation_name);
  const requestName = cleanText(accessRequest.name);
  const email = cleanText(accessRequest.email);
  const normalisedEmail = cleanText(accessRequest.email_normalised);
  const contactName =
    cleanText(accessRequest.contact_name) ||
    requestName ||
    null;
  const contactEmail =
    cleanText(accessRequest.contact_email) ||
    email ||
    null;

  const licenceHolderType =
    cleanText(accessRequest.licence_holder_type) ||
    (organisationName ? "organisation" : "individual");

  const licenceHolderName =
    organisationName ||
    requestName ||
    normalisedEmail ||
    email;

  return {
    licence_holder_type: licenceHolderType,
    licence_holder_name: licenceHolderName,
    organisation_name: organisationName || null,
    contact_name: contactName,
    contact_email: contactEmail,
    licence_holder_email: email,
    licence_holder_email_normalised: normalisedEmail,
    recipient_category:
      cleanText(accessRequest.recipient_category) || null,
  };
}

function evaluatePreparation({
  accessRequest,
  document,
  releasePolicy,
  licenceTerms,
  reviewEvent,
  existingLicenceCount,
  licenceIssueEventCount,
  downloadLinkCount,
}) {
  const blockers = [];
  const warnings = [];

  if (!accessRequest) {
    blockers.push("access_request_not_found");
    return { blockers, warnings };
  }

  if (accessRequest.status !== "approved_pending_licence") {
    blockers.push("request_status_not_approved_pending_licence");
  }

  if (
    accessRequest.request_review_status !==
    "approved_for_licence_prep"
  ) {
    blockers.push("request_review_status_not_approved_for_licence_prep");
  }

  if (!accessRequest.approved_at) {
    blockers.push("request_approval_timestamp_missing");
  }

  if (accessRequest.approval_policy_version !== "U3-Q") {
    blockers.push("request_approval_policy_not_u3_q");
  }

  if (!accessRequest.terms_version) {
    blockers.push("request_terms_version_missing");
  }

  if (!accessRequest.terms_accepted_at) {
    blockers.push("request_terms_acceptance_missing");
  }

  if (accessRequest.denied_at || accessRequest.denied_by) {
    blockers.push("request_has_denial_marker");
  }

  if (!reviewEvent) {
    blockers.push("qualifying_u3_q_review_event_missing");
  }

  if (!document) {
    blockers.push("document_not_found_for_request_version");
  } else {
    if (document.status !== "active") {
      blockers.push("document_not_active");
    }

    if (Number(document.is_listed || 0) !== 1) {
      blockers.push("document_not_listed");
    }

    if (Number(document.requires_approval || 0) !== 1) {
      blockers.push("document_no_longer_requires_approval");
    }

    if (document.requestability_status !== "requestable_with_approval") {
      blockers.push("document_not_requestable_with_approval");
    }

    if (!document.source_object) {
      blockers.push("document_source_object_missing");
    }

    if (!document.source_sha256) {
      blockers.push("document_source_sha256_missing");
    }

    if (!document.licence_terms_version) {
      blockers.push("document_licence_terms_version_missing");
    }
  }

  if (!releasePolicy) {
    blockers.push("release_policy_missing");
  } else {
    if (releasePolicy.policy_status !== "active") {
      blockers.push(
        `release_policy_status_${releasePolicy.policy_status || "missing"}`
      );
    }

    if (releasePolicy.release_state !== "request_open") {
      blockers.push(
        `release_state_${releasePolicy.release_state || "missing"}`
      );
    }

    if (releasePolicy.licence_terms_status !== "active") {
      blockers.push(
        `licence_terms_status_${releasePolicy.licence_terms_status || "missing"}`
      );
    }

    if (Number(releasePolicy.approval_required || 0) !== 1) {
      blockers.push("release_policy_no_longer_requires_approval");
    }

    if (Number(releasePolicy.public_download_enabled || 0) === 1) {
      blockers.push("release_policy_public_download_enabled");
    }
  }

  if (!licenceTerms) {
    blockers.push("accepted_licence_terms_not_found");
  } else {
    if (licenceTerms.status !== "active") {
      blockers.push("accepted_licence_terms_not_active");
    }

    if (!cleanText(licenceTerms.body)) {
      blockers.push("accepted_licence_terms_body_missing");
    }

    if (
      cleanText(accessRequest.terms_version) &&
      licenceTerms.version !== accessRequest.terms_version
    ) {
      blockers.push("accepted_licence_terms_version_mismatch");
    }

    if (
      document?.licence_terms_version &&
      document.licence_terms_version !== accessRequest.terms_version
    ) {
      blockers.push("document_terms_changed_since_request");
    }

    if (
      releasePolicy?.licence_terms_version &&
      releasePolicy.licence_terms_version !== accessRequest.terms_version
    ) {
      blockers.push("release_policy_terms_changed_since_request");
    }
  }

  if (existingLicenceCount > 0) {
    blockers.push("licence_already_exists_for_request");
  }

  if (licenceIssueEventCount > 0) {
    blockers.push("licence_issue_event_already_exists_for_request");
  }

  if (downloadLinkCount > 0) {
    blockers.push("download_link_already_exists_for_request");
  }

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
  };
}

function preparationMatches(existing, snapshot) {
  if (!existing) {
    return false;
  }

  const fields = [
    "request_id",
    "document_id",
    "document_version",
    "review_event_id",
    "release_policy_id",
    "licence_terms_id",
    "licence_terms_version",
    "licence_terms_body_sha256",
    "source_object",
    "source_sha256",
    "licence_holder_type",
    "licence_holder_name",
    "organisation_name",
    "contact_name",
    "contact_email",
    "licence_holder_email",
    "licence_holder_email_normalised",
    "recipient_category",
    "request_terms_version",
    "terms_accepted_at",
    "approved_at",
    "approved_by",
    "approval_role",
    "approval_policy_version",
  ];

  return fields.every(
    (field) =>
      cleanText(existing[field]) === cleanText(snapshot[field])
  );
}

async function insertPreparation(env, snapshot) {
  const id = buildPreparationEventId();
  const createdAt = nowIso();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_access_request_licence_preparation_events (
       id,
       request_id,
       document_id,
       document_version,
       review_event_id,
       release_policy_id,
       licence_terms_id,
       licence_terms_version,
       licence_terms_body_sha256,
       source_object,
       source_sha256,
       licence_holder_type,
       licence_holder_name,
       organisation_name,
       contact_name,
       contact_email,
       licence_holder_email,
       licence_holder_email_normalised,
       recipient_category,
       request_terms_version,
       terms_accepted_at,
       approved_at,
       approved_by,
       approval_role,
       approval_policy_version,
       actor,
       note,
       preparation_policy_version,
       metadata_json,
       created_at
     )
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`
  )
    .bind(
      id,
      snapshot.request_id,
      snapshot.document_id,
      snapshot.document_version,
      snapshot.review_event_id,
      snapshot.release_policy_id,
      snapshot.licence_terms_id,
      snapshot.licence_terms_version,
      snapshot.licence_terms_body_sha256,
      snapshot.source_object,
      snapshot.source_sha256,
      snapshot.licence_holder_type,
      snapshot.licence_holder_name,
      snapshot.organisation_name,
      snapshot.contact_name,
      snapshot.contact_email,
      snapshot.licence_holder_email,
      snapshot.licence_holder_email_normalised,
      snapshot.recipient_category,
      snapshot.request_terms_version,
      snapshot.terms_accepted_at,
      snapshot.approved_at,
      snapshot.approved_by,
      snapshot.approval_role,
      snapshot.approval_policy_version,
      snapshot.actor,
      snapshot.note,
      PREPARATION_POLICY_VERSION,
      JSON.stringify(snapshot.metadata || {}),
      createdAt
    )
    .run();

  return await first(
    env,
    `SELECT *
     FROM document_access_request_licence_preparation_events
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
}

export async function handleCdasLicencePreparation(request, env) {
  if (request.method !== "POST") {
    return fail(
      "method_not_allowed",
      "Use POST to prepare an approved CDAS access request for later licence issuance.",
      405
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "licence_preparation_database_unavailable",
      "D1 database binding is unavailable.",
      503
    );
  }

  const body = await readJsonBody(request);
  const requestId = cleanText(
    body.request_id ||
    body.access_request_id
  );

  if (!requestId) {
    return fail(
      "licence_preparation_request_id_missing",
      "Document access request ID is required.",
      400
    );
  }

  const actor =
    cleanText(body.actor) ||
    cleanText(env.UPLOAD_ADMIN_ACTOR) ||
    cleanText(env.RELAYHUB_ADMIN_ACTOR) ||
    cleanText(request.headers.get("cf-access-authenticated-user-email")) ||
    cleanText(request.headers.get("x-admin-actor")) ||
    "admin";

  const note = nullableText(body.note || body.reason);

  const accessRequest = await getAccessRequest(env, requestId);

  if (!accessRequest) {
    return fail(
      "access_request_not_found",
      "Document access request was not found.",
      404,
      { request_id: requestId }
    );
  }

  const [
    document,
    releasePolicy,
    reviewEvent,
    existingPreparation,
    existingLicenceCount,
    licenceIssueEventCount,
    downloadLinkCount,
  ] = await Promise.all([
    getDocument(
      env,
      accessRequest.document_id,
      accessRequest.document_version
    ),
    getReleasePolicy(
      env,
      accessRequest.document_id,
      accessRequest.document_version
    ),
    getQualifyingReviewEvent(env, requestId),
    getExistingPreparation(env, requestId),
    countExistingLicences(env, requestId),
    countLicenceIssueEvents(env, requestId),
    countDownloadLinks(env, requestId),
  ]);

  const licenceTerms = await getLicenceTerms(
    env,
    accessRequest.terms_version
  );

  const gate = evaluatePreparation({
    accessRequest,
    document,
    releasePolicy,
    licenceTerms,
    reviewEvent,
    existingLicenceCount,
    licenceIssueEventCount,
    downloadLinkCount,
  });

  if (gate.blockers.length > 0) {
    return fail(
      "licence_preparation_blocked",
      "This access request is not eligible for licence preparation.",
      409,
      {
        request_id: requestId,
        blockers: gate.blockers,
        warnings: gate.warnings,
      }
    );
  }

  const holder = deriveLicenceHolder(accessRequest);

  if (!holder.licence_holder_name) {
    return fail(
      "licence_holder_name_missing",
      "Licence holder name could not be derived from the approved request.",
      409,
      { request_id: requestId }
    );
  }

  if (!holder.licence_holder_email) {
    return fail(
      "licence_holder_email_missing",
      "Licence holder email is missing from the approved request.",
      409,
      { request_id: requestId }
    );
  }

  if (!holder.licence_holder_email_normalised) {
    return fail(
      "licence_holder_email_normalised_missing",
      "Normalised licence holder email is missing from the approved request.",
      409,
      { request_id: requestId }
    );
  }

  const termsBodySha256 =
    cleanText(licenceTerms.body_sha256) ||
    await sha256Hex(licenceTerms.body);

  const snapshot = {
    request_id: accessRequest.id,
    document_id: accessRequest.document_id,
    document_version: accessRequest.document_version,

    review_event_id: reviewEvent.id,

    release_policy_id: nullableText(releasePolicy.id),

    licence_terms_id: licenceTerms.id,
    licence_terms_version: licenceTerms.version,
    licence_terms_body_sha256: termsBodySha256,

    source_object: document.source_object,
    source_sha256: document.source_sha256,

    ...holder,

    request_terms_version: accessRequest.terms_version,
    terms_accepted_at: accessRequest.terms_accepted_at,

    approved_at: accessRequest.approved_at,
    approved_by: nullableText(accessRequest.approved_by),
    approval_role: nullableText(accessRequest.approval_role),
    approval_policy_version: accessRequest.approval_policy_version,

    actor,
    note,

    metadata: {
      phase: PREPARATION_POLICY_VERSION,
      request_status: accessRequest.status,
      request_review_status: accessRequest.request_review_status,
      document_status: document.status,
      document_requestability_status: document.requestability_status,
      release_policy_status: releasePolicy.policy_status,
      release_state: releasePolicy.release_state,
      licence_terms_status: licenceTerms.status,
    },
  };

  if (existingPreparation) {
    if (!preparationMatches(existingPreparation, snapshot)) {
      return fail(
        "licence_preparation_evidence_conflict",
        "Existing U3-R preparation evidence does not match the current approved inputs.",
        409,
        {
          request_id: requestId,
          preparation_event_id: existingPreparation.id,
        }
      );
    }

    return success({
      action: "prepare_licence",
      request_id: requestId,
      prepared: true,
      already_prepared: true,
      preparation_event: existingPreparation,
      next_allowed_action: "explicit_licence_issue",
      message:
        "Licence preparation evidence already exists and matches the current approved inputs. No licence was issued.",
    });
  }

  let preparation;

  try {
    preparation = await insertPreparation(env, snapshot);
  } catch (error) {
    const message = error?.message || String(error);

    const replay = await getExistingPreparation(env, requestId);

    if (replay && preparationMatches(replay, snapshot)) {
      return success({
        action: "prepare_licence",
        request_id: requestId,
        prepared: true,
        already_prepared: true,
        preparation_event: replay,
        next_allowed_action: "explicit_licence_issue",
        message:
          "Licence preparation evidence already exists and matches the current approved inputs. No licence was issued.",
      });
    }

    return fail(
      "licence_preparation_write_failed",
      "Licence preparation evidence could not be persisted.",
      409,
      {
        request_id: requestId,
        detail: message,
      }
    );
  }

  return success({
    action: "prepare_licence",
    request_id: requestId,
    prepared: true,
    already_prepared: false,
    preparation_event: preparation,
    next_allowed_action: "explicit_licence_issue",
    message:
      "Licence preparation evidence was recorded. No licence was issued, no PDF was generated, no download link was created, and no email was sent.",
  });
}
