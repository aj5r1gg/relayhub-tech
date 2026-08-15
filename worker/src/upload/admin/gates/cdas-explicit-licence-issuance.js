const ISSUANCE_POLICY_VERSION = "U3-S";
const REQUIRED_PREPARATION_POLICY_VERSION = "U3-R";
const REQUIRED_APPROVAL_POLICY_VERSION = "U3-Q";

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

function randomHex(bytes = 8) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeLicenceId() {
  return `lic_${Date.now().toString(36)}_${randomHex(8)}`;
}

function makeIssueEventId() {
  return `dar_lic_issue_${Date.now().toString(36)}_${randomHex(8)}`;
}

function padSequence(value) {
  return String(value).padStart(6, "0");
}

function currentYear(date = new Date()) {
  return date.getUTCFullYear();
}

function currentYearText(date = new Date()) {
  return String(currentYear(date));
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
    licence_created: false,
    licence_issue_event_created: false,
    generated_pdf_created: false,
    download_link_created: false,
    email_sent: false,
    download_served: false,
    ...overrides,
  };
}

function fail(error, message, status = 409, extra = {}) {
  return jsonResponse(
    {
      ok: false,
      issued: false,
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
    return await request.json();
  } catch {
    return {};
  }
}

async function first(env, sql, bindings = []) {
  return await env.RELAYHUB_DB.prepare(sql)
    .bind(...bindings)
    .first();
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extractPlaceholders(text) {
  const matches =
    String(text || "").match(/\{\{[A-Z0-9_]+\}\}/g) || [];

  return Array.from(new Set(matches)).sort();
}

function renderTemplate(templateBody, values) {
  let rendered = String(templateBody || "");

  for (const [placeholder, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }

    rendered = rendered
      .split(placeholder)
      .join(String(value));
  }

  return rendered;
}

function defaultOfficialWebsite(env) {
  return (
    cleanText(env.RELAYHUB_OFFICIAL_WEBSITE) ||
    "https://www.relayhub.tech"
  );
}

function defaultContactEmail(env) {
  return (
    cleanText(env.RELAYHUB_CONTACT_EMAIL) ||
    "contact@relayhub.tech"
  );
}

function defaultCopyrightHolder(env) {
  return (
    cleanText(env.RELAYHUB_COPYRIGHT_HOLDER) ||
    "RelayHub"
  );
}

async function nextLicenceNumber(env, issuedAt = new Date()) {
  const year = currentYear(issuedAt);
  const prefix = `RH-LIC-${year}-`;

  const row = await first(
    env,
    `SELECT licence_number
     FROM document_licences
     WHERE licence_number LIKE ?
     ORDER BY licence_number DESC
     LIMIT 1`,
    [`${prefix}%`],
  );

  if (!row?.licence_number) {
    return `${prefix}${padSequence(1)}`;
  }

  const previous = String(row.licence_number)
    .replace(prefix, "");

  const parsed = Number.parseInt(previous, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return `${prefix}${padSequence(1)}`;
  }

  return `${prefix}${padSequence(parsed + 1)}`;
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
       denial_reason
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getPreparation(env, requestId) {
  return await first(
    env,
    `SELECT *
     FROM document_access_request_licence_preparation_events
     WHERE request_id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getReviewEvent(env, reviewEventId) {
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

async function getDocument(
  env,
  documentId,
  documentVersion,
) {
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
    [documentId, documentVersion],
  );
}

async function getReleasePolicy(
  env,
  releasePolicyId,
  documentId,
  documentVersion,
) {
  const id = cleanText(releasePolicyId);

  if (!id) {
    return null;
  }

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
     WHERE id = ?
       AND document_id = ?
       AND document_version = ?
     LIMIT 1`,
    [
      id,
      documentId,
      documentVersion,
    ],
  );
}

async function getLicenceTerms(
  env,
  licenceTermsId,
  licenceTermsVersion,
) {
  const id = cleanText(licenceTermsId);
  const version = cleanText(licenceTermsVersion);

  if (!id || !version) {
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
     WHERE id = ?
       AND version = ?
     LIMIT 1`,
    [id, version],
  );
}

async function getExistingLicence(env, requestId) {
  return await first(
    env,
    `SELECT *
     FROM document_licences
     WHERE request_id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getIssueEvent(env, requestId) {
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

async function countDownloadLinks(env, licenceId) {
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

function deriveCurrentLicenceHolder(accessRequest) {
  const organisationName =
    cleanText(accessRequest.organisation_name);

  const requestName =
    cleanText(accessRequest.name);

  const email =
    cleanText(accessRequest.email);

  const normalisedEmail =
    cleanText(accessRequest.email_normalised);

  const licenceHolderType =
    cleanText(accessRequest.licence_holder_type) ||
    (organisationName ? "organisation" : "individual");

  const licenceHolderName =
    organisationName ||
    requestName ||
    normalisedEmail ||
    email;

  const contactName =
    cleanText(accessRequest.contact_name) ||
    requestName ||
    null;

  const contactEmail =
    cleanText(accessRequest.contact_email) ||
    email ||
    null;

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

function sameText(left, right) {
  return cleanText(left) === cleanText(right);
}

function evaluateIssuance({
  accessRequest,
  preparation,
  reviewEvent,
  document,
  releasePolicy,
  licenceTerms,
  currentTermsBodySha256,
}) {
  const blockers = [];

  if (!accessRequest) {
    blockers.push("access_request_not_found");
    return blockers;
  }

  if (
    accessRequest.status !==
    "approved_pending_licence"
  ) {
    blockers.push(
      "request_status_not_approved_pending_licence",
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
    blockers.push("request_has_denial_marker");
  }

  if (!preparation) {
    blockers.push(
      "licence_preparation_evidence_missing",
    );

    return Array.from(new Set(blockers));
  }

  if (
    preparation.preparation_policy_version !==
    REQUIRED_PREPARATION_POLICY_VERSION
  ) {
    blockers.push(
      "preparation_policy_version_not_u3_r",
    );
  }

  if (
    preparation.approval_policy_version !==
    REQUIRED_APPROVAL_POLICY_VERSION
  ) {
    blockers.push(
      "preparation_approval_policy_version_not_u3_q",
    );
  }

  if (
    !sameText(
      preparation.request_id,
      accessRequest.id,
    )
  ) {
    blockers.push("preparation_request_id_mismatch");
  }

  if (
    !sameText(
      preparation.document_id,
      accessRequest.document_id,
    )
  ) {
    blockers.push("preparation_document_id_mismatch");
  }

  if (
    !sameText(
      preparation.document_version,
      accessRequest.document_version,
    )
  ) {
    blockers.push(
      "preparation_document_version_mismatch",
    );
  }

  if (
    !sameText(
      preparation.request_terms_version,
      accessRequest.terms_version,
    )
  ) {
    blockers.push(
      "request_terms_changed_after_preparation",
    );
  }

  if (
    !sameText(
      preparation.terms_accepted_at,
      accessRequest.terms_accepted_at,
    )
  ) {
    blockers.push(
      "terms_acceptance_changed_after_preparation",
    );
  }

  if (
    !sameText(
      preparation.approved_at,
      accessRequest.approved_at,
    )
  ) {
    blockers.push(
      "approval_timestamp_changed_after_preparation",
    );
  }

  if (
    !sameText(
      preparation.approved_by,
      accessRequest.approved_by,
    )
  ) {
    blockers.push(
      "approver_changed_after_preparation",
    );
  }

  if (
    !sameText(
      preparation.approval_role,
      accessRequest.approval_role,
    )
  ) {
    blockers.push(
      "approval_role_changed_after_preparation",
    );
  }

  if (
    !sameText(
      preparation.approval_policy_version,
      accessRequest.approval_policy_version,
    )
  ) {
    blockers.push(
      "approval_policy_changed_after_preparation",
    );
  }

  const holder =
    deriveCurrentLicenceHolder(accessRequest);

  const holderFields = [
    "licence_holder_type",
    "licence_holder_name",
    "organisation_name",
    "contact_name",
    "contact_email",
    "licence_holder_email",
    "licence_holder_email_normalised",
    "recipient_category",
  ];

  for (const field of holderFields) {
    if (
      !sameText(
        preparation[field],
        holder[field],
      )
    ) {
      blockers.push(
        `licence_holder_${field}_changed_after_preparation`,
      );
    }
  }

  if (!reviewEvent) {
    blockers.push(
      "qualifying_u3_q_review_event_missing",
    );
  } else {
    if (
      !sameText(
        reviewEvent.id,
        preparation.review_event_id,
      )
    ) {
      blockers.push(
        "review_event_id_mismatch",
      );
    }

    if (
      !sameText(
        reviewEvent.request_id,
        accessRequest.id,
      )
    ) {
      blockers.push(
        "review_event_request_id_mismatch",
      );
    }

    if (reviewEvent.event_type !== "review_approved") {
      blockers.push(
        "review_event_not_approved",
      );
    }

    if (
      reviewEvent.new_status !==
      "approved_pending_licence"
    ) {
      blockers.push(
        "review_event_status_not_approved_pending_licence",
      );
    }
  }

  if (!document) {
    blockers.push(
      "document_not_found_for_prepared_version",
    );
  } else {
    if (document.status !== "active") {
      blockers.push("document_not_active");
    }

    if (Number(document.is_listed || 0) !== 1) {
      blockers.push("document_not_listed");
    }

    if (
      Number(document.requires_approval || 0) !== 1
    ) {
      blockers.push(
        "document_no_longer_requires_approval",
      );
    }

    if (
      document.requestability_status !==
      "requestable_with_approval"
    ) {
      blockers.push(
        "document_not_requestable_with_approval",
      );
    }

    if (
      !sameText(
        document.source_object,
        preparation.source_object,
      )
    ) {
      blockers.push(
        "document_source_object_changed_after_preparation",
      );
    }

    if (
      !sameText(
        document.source_sha256,
        preparation.source_sha256,
      )
    ) {
      blockers.push(
        "document_source_sha256_changed_after_preparation",
      );
    }

    if (
      !sameText(
        document.licence_terms_version,
        preparation.licence_terms_version,
      )
    ) {
      blockers.push(
        "document_licence_terms_changed_after_preparation",
      );
    }
  }

  if (!releasePolicy) {
    blockers.push(
      "prepared_release_policy_missing",
    );
  } else {
    if (
      !sameText(
        releasePolicy.id,
        preparation.release_policy_id,
      )
    ) {
      blockers.push(
        "release_policy_id_mismatch",
      );
    }

    if (releasePolicy.policy_status !== "active") {
      blockers.push(
        `release_policy_status_${releasePolicy.policy_status || "missing"}`,
      );
    }

    if (
      releasePolicy.release_state !== "request_open"
    ) {
      blockers.push(
        `release_state_${releasePolicy.release_state || "missing"}`,
      );
    }

    if (
      releasePolicy.licence_terms_status !== "active"
    ) {
      blockers.push(
        `licence_terms_status_${releasePolicy.licence_terms_status || "missing"}`,
      );
    }

    if (
      Number(releasePolicy.approval_required || 0) !== 1
    ) {
      blockers.push(
        "release_policy_no_longer_requires_approval",
      );
    }

    if (
      Number(
        releasePolicy.public_download_enabled || 0,
      ) === 1
    ) {
      blockers.push(
        "release_policy_public_download_enabled",
      );
    }

    if (
      !sameText(
        releasePolicy.licence_terms_id,
        preparation.licence_terms_id,
      )
    ) {
      blockers.push(
        "release_policy_licence_terms_id_changed",
      );
    }

    if (
      !sameText(
        releasePolicy.licence_terms_version,
        preparation.licence_terms_version,
      )
    ) {
      blockers.push(
        "release_policy_licence_terms_version_changed",
      );
    }
  }

  if (!licenceTerms) {
    blockers.push(
      "prepared_licence_terms_missing",
    );
  } else {
    if (licenceTerms.status !== "active") {
      blockers.push(
        "prepared_licence_terms_not_active",
      );
    }

    if (!cleanText(licenceTerms.body)) {
      blockers.push(
        "prepared_licence_terms_body_missing",
      );
    }

    if (
      !sameText(
        licenceTerms.id,
        preparation.licence_terms_id,
      )
    ) {
      blockers.push(
        "licence_terms_id_changed_after_preparation",
      );
    }

    if (
      !sameText(
        licenceTerms.version,
        preparation.licence_terms_version,
      )
    ) {
      blockers.push(
        "licence_terms_version_changed_after_preparation",
      );
    }

    if (
      !sameText(
        currentTermsBodySha256,
        preparation.licence_terms_body_sha256,
      )
    ) {
      blockers.push(
        "licence_terms_body_changed_after_preparation",
      );
    }
  }

  return Array.from(new Set(blockers));
}

function buildRenderValues({
  env,
  preparation,
  document,
  licenceNumber,
  issuedAt,
}) {
  return {
    "{{DOCUMENT_TITLE}}":
      cleanText(document.title) ||
      cleanText(document.slug) ||
      preparation.document_id,

    "{{DOCUMENT_VERSION}}":
      preparation.document_version,

    "{{YEAR}}":
      currentYearText(new Date(issuedAt)),

    "{{COPYRIGHT_HOLDER}}":
      defaultCopyrightHolder(env),

    "{{OFFICIAL_WEBSITE}}":
      defaultOfficialWebsite(env),

    "{{CONTACT_EMAIL}}":
      defaultContactEmail(env),

    "{{LICENSED_NAME}}":
      preparation.licence_holder_name,

    "{{LICENSED_EMAIL}}":
      preparation.licence_holder_email_normalised ||
      preparation.licence_holder_email,

    "{{LICENSED_ORGANISATION}}":
      cleanText(preparation.organisation_name) ||
      (preparation.licence_holder_type === "organisation"
        ? "Organisation name not supplied"
        : "Not applicable"),

    "{{LICENCE_NUMBER}}":
      licenceNumber,

    "{{DOWNLOAD_ID}}":
      "Not issued yet",

    "{{ORDER_NUMBER}}":
      "Not applicable",

    "{{LICENCE_DATE}}":
      issuedAt.slice(0, 10),
  };
}

async function renderIssuedLicenceEvidence({
  env,
  preparation,
  document,
  licenceTerms,
  licenceNumber,
  issuedAt,
}) {
  const templateBody =
    cleanText(licenceTerms?.body);

  if (!templateBody) {
    return {
      ok: false,
      error:
        "prepared_licence_terms_body_missing",
      message:
        "The prepared licence terms body is unavailable.",
    };
  }

  const templatePlaceholders =
    extractPlaceholders(templateBody);

  const renderedBody = renderTemplate(
    templateBody,
    buildRenderValues({
      env,
      preparation,
      document,
      licenceNumber,
      issuedAt,
    }),
  );

  const unresolvedPlaceholders =
    extractPlaceholders(renderedBody);

  if (unresolvedPlaceholders.length > 0) {
    return {
      ok: false,
      error:
        "rendered_licence_has_unresolved_placeholders",
      message:
        "Explicit licence issuance was blocked because the rendered licence still contains unresolved placeholders.",
      template_placeholders:
        templatePlaceholders,
      unresolved_placeholders:
        unresolvedPlaceholders,
    };
  }

  return {
    ok: true,
    rendered_body: renderedBody,
    rendered_sha256:
      await sha256Hex(renderedBody),
    terms_body_sha256:
      await sha256Hex(templateBody),
    template_placeholders:
      templatePlaceholders,
    unresolved_placeholders: [],
    rendered_at: issuedAt,
  };
}

function replayMatches({
  accessRequest,
  preparation,
  licence,
  issueEvent,
}) {
  if (
    !accessRequest ||
    !preparation ||
    !licence ||
    !issueEvent
  ) {
    return false;
  }

  if (accessRequest.status !== "licence_issued") {
    return false;
  }

  if (
    !sameText(
      accessRequest.request_review_status,
      "approved_for_licence_prep",
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.request_id,
      preparation.request_id,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.document_id,
      preparation.document_id,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.document_version,
      preparation.document_version,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.licence_holder_email_normalised,
      preparation.licence_holder_email_normalised,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.licence_terms_version,
      preparation.licence_terms_version,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.rendered_terms_body_sha256,
      preparation.licence_terms_body_sha256,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.source_object,
      preparation.source_object,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      licence.source_sha256,
      preparation.source_sha256,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      issueEvent.request_id,
      preparation.request_id,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      issueEvent.licence_id,
      licence.id,
    )
  ) {
    return false;
  }

  if (
    !sameText(
      issueEvent.licence_number,
      licence.licence_number,
    )
  ) {
    return false;
  }

  if (
    issueEvent.previous_status !==
    "approved_pending_licence"
  ) {
    return false;
  }

  if (
    issueEvent.new_status !==
    "licence_issued"
  ) {
    return false;
  }

  return true;
}

async function returnExistingIssuanceIfComplete(
  env,
  requestId,
  preparation,
) {
  const [
    accessRequest,
    licence,
    issueEvent,
  ] = await Promise.all([
    getAccessRequest(env, requestId),
    getExistingLicence(env, requestId),
    getIssueEvent(env, requestId),
  ]);

  if (
    !licence &&
    !issueEvent &&
    accessRequest?.status !== "licence_issued"
  ) {
    return null;
  }

  if (
    replayMatches({
      accessRequest,
      preparation,
      licence,
      issueEvent,
    })
  ) {
    const downloadLinkCount =
      await countDownloadLinks(
        env,
        licence.id,
      );

    if (downloadLinkCount !== 0) {
      return fail(
        "u3_s_downstream_state_already_exists",
        "The existing issued licence already has downstream download-link state and cannot be treated as a pure U3-S replay.",
        409,
        {
          request_id: requestId,
          licence_id: licence.id,
          download_link_count:
            downloadLinkCount,
        },
      );
    }

    return success({
      action:
        "explicit_licence_issue",
      issued: true,
      already_issued: true,
      request_id: requestId,
      previous_status:
        "approved_pending_licence",
      new_status:
        "licence_issued",
      request_review_status:
        accessRequest.request_review_status,
      licence,
      issue_event: issueEvent,
      next_allowed_action:
        "generated_pdf_preparation",
      safety: safetyPayload({
        licence_created: true,
        licence_issue_event_created: true,
      }),
      message:
        "The U3-S licence was already issued from the same preparation evidence. Replay created no duplicate licence or issue event.",
    });
  }

  return fail(
    "u3_s_recovery_required",
    "Existing licence, issue-event, or request state is incomplete or does not match the U3-R preparation evidence. Manual recovery is required before issuance may continue.",
    409,
    {
      request_id: requestId,
      existing: {
        request_status:
          accessRequest?.status || null,
        licence_id:
          licence?.id || null,
        issue_event_id:
          issueEvent?.id || null,
      },
    },
  );
}

function isLicenceNumberCollision(error) {
  const message = String(
    error?.message || error || "",
  ).toLowerCase();

  return (
    message.includes("unique") &&
    message.includes("licence_number")
  );
}

export async function handleCdasExplicitLicenceIssuance(
  request,
  env,
) {
  if (request.method !== "POST") {
    return fail(
      "method_not_allowed",
      "Use POST to explicitly issue a licence from proven U3-R preparation evidence.",
      405,
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "explicit_licence_issue_database_unavailable",
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
      "explicit_licence_issue_request_id_missing",
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
    nullableText(body.note || body.reason);

  const preparation =
    await getPreparation(env, requestId);

  if (!preparation) {
    return fail(
      "licence_preparation_evidence_missing",
      "U3-R licence preparation evidence is required before explicit licence issuance.",
      409,
      {
        request_id: requestId,
      },
    );
  }

  const existingReplay =
    await returnExistingIssuanceIfComplete(
      env,
      requestId,
      preparation,
    );

  if (existingReplay) {
    return existingReplay;
  }

  const accessRequest =
    await getAccessRequest(
      env,
      requestId,
    );

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

  const [
    reviewEvent,
    document,
    releasePolicy,
    licenceTerms,
  ] = await Promise.all([
    getReviewEvent(
      env,
      preparation.review_event_id,
    ),

    getDocument(
      env,
      preparation.document_id,
      preparation.document_version,
    ),

    getReleasePolicy(
      env,
      preparation.release_policy_id,
      preparation.document_id,
      preparation.document_version,
    ),

    getLicenceTerms(
      env,
      preparation.licence_terms_id,
      preparation.licence_terms_version,
    ),
  ]);

  const currentTermsBodySha256 =
    licenceTerms?.body
      ? await sha256Hex(licenceTerms.body)
      : "";

  const blockers = evaluateIssuance({
    accessRequest,
    preparation,
    reviewEvent,
    document,
    releasePolicy,
    licenceTerms,
    currentTermsBodySha256,
  });

  if (blockers.length > 0) {
    return fail(
      "explicit_licence_issue_blocked",
      "This access request is not eligible for explicit licence issuance.",
      409,
      {
        request_id: requestId,
        blockers,
      },
    );
  }

  const existingDownloadLinkCount =
    await countDownloadLinks(
      env,
      null,
    );

  if (existingDownloadLinkCount > 0) {
    return fail(
      "unexpected_downstream_state",
      "Unexpected downstream download-link state exists before explicit licence issuance.",
      409,
      {
        request_id: requestId,
      },
    );
  }

  const issuedAt = nowIso();

  for (
    let attempt = 1;
    attempt <= 4;
    attempt += 1
  ) {
    const licenceId = makeLicenceId();
    const issueEventId = makeIssueEventId();

    const licenceNumber =
      await nextLicenceNumber(
        env,
        new Date(issuedAt),
      );

    const evidence =
      await renderIssuedLicenceEvidence({
        env,
        preparation,
        document,
        licenceTerms,
        licenceNumber,
        issuedAt,
      });

    if (!evidence.ok) {
      return fail(
        evidence.error,
        evidence.message,
        409,
        {
          request_id: requestId,
          template_placeholders:
            evidence.template_placeholders ||
            [],
          unresolved_placeholders:
            evidence.unresolved_placeholders ||
            [],
        },
      );
    }

    if (
      !sameText(
        evidence.terms_body_sha256,
        preparation.licence_terms_body_sha256,
      )
    ) {
      return fail(
        "rendered_terms_hash_does_not_match_preparation",
        "The licence terms used for rendering no longer match the frozen U3-R terms evidence.",
        409,
        {
          request_id: requestId,
        },
      );
    }

    const metadata = {
      phase: ISSUANCE_POLICY_VERSION,
      preparation_event_id:
        preparation.id,
      review_event_id:
        preparation.review_event_id,
      release_policy_id:
        preparation.release_policy_id,
      licence_terms_id:
        preparation.licence_terms_id,
      licence_terms_version:
        preparation.licence_terms_version,
      licence_terms_body_sha256:
        preparation.licence_terms_body_sha256,
      source_object:
        preparation.source_object,
      source_sha256:
        preparation.source_sha256,
      approval_policy_version:
        preparation.approval_policy_version,
      preparation_policy_version:
        preparation.preparation_policy_version,
      issuance_policy_version:
        ISSUANCE_POLICY_VERSION,
      generated_pdf_created: false,
      download_link_created: false,
      email_sent: false,
      download_served: false,
    };

    const updateRequestStatement =
      env.RELAYHUB_DB.prepare(
        `UPDATE document_access_requests
         SET status = 'licence_issued'
         WHERE id = ?
           AND status = 'approved_pending_licence'
           AND request_review_status = 'approved_for_licence_prep'
           AND approval_policy_version = 'U3-Q'`,
      ).bind(requestId);

    /*
     * document_id is sourced from the just-transitioned
     * request inside the same batch. If the guarded request
     * transition did not occur, the scalar subquery returns
     * NULL and the NOT NULL document_id constraint aborts
     * the whole batch.
     */
    const insertLicenceStatement =
      env.RELAYHUB_DB.prepare(
        `INSERT INTO document_licences (
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
         )
         VALUES (
           ?,
           ?,
           ?,
           (
             SELECT document_id
             FROM document_access_requests
             WHERE id = ?
               AND status = 'licence_issued'
               AND request_review_status =
                   'approved_for_licence_prep'
             LIMIT 1
           ),
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           'issued',
           ?,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           NULL,
           NULL,
           NULL,
           NULL,
           NULL,
           'not_generated',
           NULL,
           NULL
         )`,
      ).bind(
        licenceId,
        licenceNumber,
        requestId,
        requestId,
        preparation.document_version,
        preparation.licence_holder_type,
        preparation.licence_holder_name,
        nullableText(
          preparation.organisation_name,
        ),
        nullableText(
          preparation.contact_name,
        ),
        nullableText(
          preparation.contact_email,
        ),
        preparation.licence_holder_email,
        preparation.licence_holder_email_normalised,
        cleanText(
          preparation.recipient_category,
        ) || "unknown",
        preparation.licence_terms_version,
        issuedAt,
        note,
        evidence.rendered_body,
        evidence.rendered_sha256,
        evidence.terms_body_sha256,
        JSON.stringify(
          evidence.template_placeholders,
        ),
        JSON.stringify(
          evidence.unresolved_placeholders,
        ),
        evidence.rendered_at,
        preparation.source_object,
        preparation.source_sha256,
      );

    /*
     * request_id is also derived from the transitioned
     * request. This gives the final batch statement another
     * fail-closed guard against an invalid transition.
     */
    const insertIssueEventStatement =
      env.RELAYHUB_DB.prepare(
        `INSERT INTO document_access_request_licence_issue_events (
           id,
           request_id,
           licence_id,
           licence_number,
           previous_status,
           new_status,
           actor,
           note,
           metadata_json,
           created_at
         )
         VALUES (
           ?,
           (
             SELECT id
             FROM document_access_requests
             WHERE id = ?
               AND status = 'licence_issued'
               AND request_review_status =
                   'approved_for_licence_prep'
             LIMIT 1
           ),
           ?,
           ?,
           'approved_pending_licence',
           'licence_issued',
           ?,
           ?,
           ?,
           ?
         )`,
      ).bind(
        issueEventId,
        requestId,
        licenceId,
        licenceNumber,
        actor,
        note,
        JSON.stringify(metadata),
        issuedAt,
      );

    try {
      await env.RELAYHUB_DB.batch([
        updateRequestStatement,
        insertLicenceStatement,
        insertIssueEventStatement,
      ]);
    } catch (error) {
      const replay =
        await returnExistingIssuanceIfComplete(
          env,
          requestId,
          preparation,
        );

      if (replay) {
        return replay;
      }

      if (
        isLicenceNumberCollision(error) &&
        attempt < 4
      ) {
        continue;
      }

      return fail(
        "explicit_licence_issue_write_failed",
        "Explicit licence issuance could not be completed. The issuance batch was not accepted.",
        409,
        {
          request_id: requestId,
          attempt,
          detail:
            error?.message ||
            String(error),
        },
      );
    }

    const [
      issuedRequest,
      licence,
      issueEvent,
    ] = await Promise.all([
      getAccessRequest(
        env,
        requestId,
      ),
      getExistingLicence(
        env,
        requestId,
      ),
      getIssueEvent(
        env,
        requestId,
      ),
    ]);

    if (
      !replayMatches({
        accessRequest: issuedRequest,
        preparation,
        licence,
        issueEvent,
      })
    ) {
      return fail(
        "explicit_licence_issue_postwrite_verification_failed",
        "Licence issuance writes completed but the resulting durable state does not match the U3-R preparation evidence. Recovery is required.",
        500,
        {
          request_id: requestId,
          licence_id:
            licence?.id || null,
          issue_event_id:
            issueEvent?.id || null,
        },
      );
    }

    const downloadLinkCount =
      await countDownloadLinks(
        env,
        licence.id,
      );

    if (downloadLinkCount !== 0) {
      return fail(
        "explicit_licence_issue_downstream_side_effect_detected",
        "A downstream download link unexpectedly exists immediately after U3-S issuance.",
        500,
        {
          request_id: requestId,
          licence_id: licence.id,
          download_link_count:
            downloadLinkCount,
        },
      );
    }

    return success({
      action:
        "explicit_licence_issue",
      issued: true,
      already_issued: false,
      request_id: requestId,
      previous_status:
        "approved_pending_licence",
      new_status:
        "licence_issued",
      request_review_status:
        issuedRequest.request_review_status,
      licence,
      issue_event: issueEvent,
      next_allowed_action:
        "generated_pdf_preparation",
      safety: safetyPayload({
        licence_created: true,
        licence_issue_event_created: true,
      }),
      message:
        "The licence was explicitly issued from proven U3-R preparation evidence. No PDF was generated, no download link was created, no email was sent, and no download was served.",
    });
  }

  return fail(
    "explicit_licence_issue_number_allocation_exhausted",
    "A unique licence number could not be allocated after repeated attempts.",
    409,
    {
      request_id: requestId,
    },
  );
}
