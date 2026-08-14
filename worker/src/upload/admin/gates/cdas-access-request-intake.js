// U3-P — CDAS Controlled Access Request Intake Gate
// Extracted under U3-CUT.
//
// This gate creates a pending controlled access request and
// intake evidence only. It does not review or approve requests,
// issue licences, generate PDFs, create download links, send
// email, or create direct-download access.

import { jsonResponse } from "../../../shared.js";

import {
  buildSideEffectsConfirmed,
  cdasUploadsDisabledResponse,
  cleanText,
  envEnabled,
  fail,
  getAdminActor,
  getD1TableColumns,
  getRequestId,
  getUploadRouteSwitches,
  methodNotAllowed,
  nowIso,
  nullableText,
  pass,
  readJsonBody,
  uploadSystemDisabledResponse,
} from "../common.js";

export async function handleCdasControlledAccessRequestIntake(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/access-request",
      route_status: "cdas_controlled_access_request_intake_gate",
      upload_domain: "cdas_document",
      switches,
      policy: {
        admin_only: true,
        public_route: false,
        access_request_intake_enabled: envEnabled(
          env.CDAS_UPLOAD_ACCESS_REQUEST_INTAKE_ENABLED
        ),
        target_table: "document_access_requests",
        requires_requestable_with_approval: true,
        document_must_be_active: true,
        document_must_be_listed: true,
        requires_approval_must_remain_enabled: true,
        creates_document_access_request: true,
        request_status: "pending_approval",
        request_review_status: "pending_review",
        approves_access: false,
        creates_licence: false,
        generates_pdf: false,
        creates_download_link: false,
        sends_email: false,
        direct_downloadable: false,
      },
    });
  }

  if (request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }

  if (!switches.uploads_enabled) {
    return uploadSystemDisabledResponse(request, env);
  }

  if (!switches.cdas_uploads_enabled) {
    return cdasUploadsDisabledResponse(request, env);
  }

  if (!envEnabled(env.CDAS_UPLOAD_ACCESS_REQUEST_INTAKE_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "access_request_intake_disabled",
        message:
          "CDAS controlled access request intake is disabled by policy. No access request was created.",
        required_switch: "CDAS_UPLOAD_ACCESS_REQUEST_INTAKE_ENABLED=true",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      423
    );
  }

  const bodyResult = await readJsonBody(request);

  if (!bodyResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: bodyResult.error,
        message: bodyResult.message,
        details: bodyResult.details || {},
        validation_stage: "access_request_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const emailResult = validateRequesterEmail(body.requester_email);

  if (!emailResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: emailResult.error,
        message: emailResult.message,
        details: emailResult.details || {},
        validation_stage: "access_request_email_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const documentId = cleanText(body.document_id);
  const requesterEmail = emailResult.value;

  const documentResult = await getCdasDocumentForControlledAccessRequest(
    env,
    documentId
  );

  if (!documentResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: documentResult.error,
        message: documentResult.message,
        details: documentResult.details || {},
        validation_stage: "access_request_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const listingEventResult =
    await getLatestListingRequestabilityEventForAccessRequest(
      env,
      documentId
    );

  if (!listingEventResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: listingEventResult.error,
        message: listingEventResult.message,
        details: listingEventResult.details || {},
        validation_stage: "access_request_listing_requestability_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const duplicateResult = await getExistingPendingDocumentAccessRequest(
    env,
    documentId,
    requesterEmail
  );

  if (!duplicateResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: duplicateResult.error,
        message: duplicateResult.message,
        details: duplicateResult.details || {},
        validation_stage: "access_request_duplicate_check",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  if (duplicateResult.value) {
    const duplicateEvent = await insertControlledAccessRequestIntakeEvent(
      env,
      {
        accessRequestId: duplicateResult.value.id,
        documentId,
        listingRequestabilityEventId: listingEventResult.value.id,
        requesterName: body.requester_name,
        requesterEmail,
        requesterOrganisation: body.requester_organisation,
        requesterReason: body.requester_reason,
        intakeStatus: "duplicate_blocked",
        requestStatus: duplicateResult.value.status || "pending_approval",
        requestReviewStatus:
          duplicateResult.value.request_review_status || "pending_review",
        documentStatus: "active",
        documentIsListed: 1,
        documentRequestabilityStatus: "requestable_with_approval",
        documentRequiresApproval: 1,
        adminActor: getAdminActor(request, env),
        requestId: getRequestId(request),
        eventAt: nowIso(),
      }
    );

    return jsonResponse(
      {
        ok: true,
        accepted: false,
        duplicate_blocked: true,
        message:
          "A pending document access request already exists for this requester and document. No duplicate request was created.",
        validation_stage: "access_request_duplicate_blocked",
        existing_document_access_request: duplicateResult.value,
        duplicate_event_recorded: duplicateEvent.ok === true,
        side_effects_confirmed: buildSideEffectsConfirmed({
          creates_document_access_request: false,
          approves_access: false,
        }),
        prohibited_side_effects: {
          access_approved: false,
          licence_created: false,
          generated_pdf_created: false,
          download_link_created: false,
          email_sent: false,
          direct_download_created: false,
        },
      },
      200
    );
  }

  const eventAt = nowIso();
  const accessRequestId = buildCdasControlledAccessRequestId();
  const intakeEventId = buildCdasAccessRequestIntakeEventId();
  const document = documentResult.value;
  const listingEvent = listingEventResult.value;

  const accessRequest = await insertControlledDocumentAccessRequest(env, {
    id: accessRequestId,
    intakeEventId,
    documentId: document.id,
    documentVersion: document.version,
    requesterName: body.requester_name,
    requesterEmail,
    requesterOrganisation: body.requester_organisation,
    requesterReason: body.requester_reason,
    licenceHolderType: body.licence_holder_type || "individual",
    contactName: body.contact_name || body.requester_name,
    contactEmail: body.contact_email || requesterEmail,
    roleTitle: body.role_title,
    recipientCategory: body.recipient_category || "unknown",
    accessClass: document.access_class,
    termsVersion: document.licence_terms_version,
    userAgent: request.headers.get("user-agent") || null,
    eventAt,
  });

  if (!accessRequest.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: accessRequest.error,
        message: accessRequest.message,
        details: accessRequest.details || {},
        validation_stage: "document_access_request_insert",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const intakeEvent = await insertControlledAccessRequestIntakeEvent(env, {
    id: intakeEventId,
    accessRequestId,
    documentId: document.id,
    listingRequestabilityEventId: listingEvent.id,
    requesterName: body.requester_name,
    requesterEmail,
    requesterOrganisation: body.requester_organisation,
    requesterReason: body.requester_reason,
    intakeStatus: "received",
    requestStatus: "pending_approval",
    requestReviewStatus: "pending_review",
    documentStatus: document.status,
    documentIsListed: Number(document.is_listed ?? 1),
    documentRequestabilityStatus:
      document.requestability_status || "requestable_with_approval",
    documentRequiresApproval: Number(document.requires_approval ?? 1),
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    eventAt,
  });

  if (!intakeEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: intakeEvent.error,
        message: intakeEvent.message,
        details: intakeEvent.details || {},
        validation_stage: "access_request_intake_event_insert",
        recovery_required: true,
        recovery_note:
          "document_access_requests row was created but intake event insertion failed. Manual review is required.",
        document_access_request: accessRequest.value,
        side_effects_confirmed: buildSideEffectsConfirmed({
          creates_document_access_request: true,
          approves_access: false,
        }),
      },
      500
    );
  }

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message:
        "Controlled document access request was received and marked pending review. No access was approved, no licence was issued, no PDF was generated, no download link was created, and no email was sent.",
      route: "/api/admin/uploads/cdas-document/access-request",
      validation_stage: "cdas_controlled_access_request_intake",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        status: document.status,
        is_listed: Number(document.is_listed ?? 1),
        requestability_status:
          document.requestability_status || "requestable_with_approval",
        requires_approval: Number(document.requires_approval ?? 1),
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
      },
      requester: {
        name: nullableText(body.requester_name),
        email: requesterEmail,
        organisation: nullableText(body.requester_organisation),
        licence_holder_type: normaliseLicenceHolderType(
          body.licence_holder_type || "individual"
        ),
        recipient_category: normaliseRecipientCategory(
          body.recipient_category || "unknown"
        ),
      },
      document_access_request: accessRequest.value,
      intake_event: intakeEvent.value,
      listing_requestability_event: {
        id: listingEvent.id,
        action: listingEvent.action,
        created_at: listingEvent.created_at,
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
        creates_document_access_request: true,
        approves_access: false,
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
      }),
      public_visibility: {
        listed_publicly: true,
        requestable_publicly: true,
        directly_downloadable_publicly: false,
        public_url_created: false,
      },
      prohibited_side_effects: {
        access_approved: false,
        licence_created: false,
        generated_pdf_created: false,
        download_link_created: false,
        email_sent: false,
        direct_download_created: false,
      },
      next_allowed_gate:
        "U3-Q — CDAS Controlled Access Request Review Gate",
    },
    201
  );
}

function buildCdasControlledAccessRequestId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `dar_${random.replaceAll("-", "")}`;
}

function buildCdasAccessRequestIntakeEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `caire_${random.replaceAll("-", "")}`;
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function validateRequesterEmail(email) {
  const cleanEmail = normaliseEmail(email);

  if (!cleanEmail) {
    return fail(
      "access_request_email_missing",
      "Requester email is required."
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return fail(
      "access_request_email_invalid",
      "Requester email is not valid.",
      {
        requester_email: cleanEmail,
      }
    );
  }

  return pass(cleanEmail);
}

function normaliseLicenceHolderType(value) {
  const cleanValue = cleanText(value || "individual").toLowerCase();

  if (
    cleanValue === "individual" ||
    cleanValue === "organisation" ||
    cleanValue === "community" ||
    cleanValue === "partner" ||
    cleanValue === "internal"
  ) {
    return cleanValue;
  }

  return "individual";
}

function normaliseRecipientCategory(value) {
  const cleanValue = cleanText(value || "unknown").toLowerCase();

  if (!cleanValue) {
    return "unknown";
  }

  return cleanValue
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

async function getCdasDocumentForControlledAccessRequest(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "access_request_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       is_listed,
       requires_approval,
       requestability_status,
       source_object,
       source_sha256,
       licence_terms_version,
       classification,
       access_class
     FROM documents
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "access_request_document_not_found",
      "Document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "active") {
    return fail(
      "access_request_document_not_active",
      "Only active documents can accept controlled access requests.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.is_listed ?? 0) !== 1) {
    return fail(
      "access_request_document_not_listed",
      "Document must be listed before it can accept controlled access requests.",
      {
        document_id: row.id,
        is_listed: row.is_listed,
      }
    );
  }

  if (
    cleanText(row.requestability_status || "not_requestable") !==
    "requestable_with_approval"
  ) {
    return fail(
      "access_request_document_not_requestable",
      "Document is not currently requestable with approval.",
      {
        document_id: row.id,
        requestability_status:
          row.requestability_status || "not_requestable",
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "access_request_document_does_not_require_approval",
      "Controlled access request intake requires approval to remain enabled.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  if (!cleanText(row.source_object)) {
    return fail(
      "access_request_source_object_missing",
      "Document does not have a source object.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.source_sha256)) {
    return fail(
      "access_request_source_sha256_missing",
      "Document does not have source SHA-256 evidence.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.version)) {
    return fail(
      "access_request_document_version_missing",
      "Document version is required before access request intake.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.licence_terms_version)) {
    return fail(
      "access_request_terms_version_missing",
      "Licence terms version is required before access request intake.",
      {
        document_id: row.id,
      }
    );
  }

  return pass(row);
}

async function getLatestListingRequestabilityEventForAccessRequest(
  env,
  documentId
) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       action,
       resulting_is_listed,
       resulting_requestability_status,
       requires_approval,
       document_requestable,
       document_downloadable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     FROM cdas_listing_requestability_events
     WHERE document_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(cleanText(documentId))
    .first();

  if (!row) {
    return fail(
      "access_request_listing_requestability_event_missing",
      "No controlled listing/requestability event was found for this document.",
      {
        document_id: cleanText(documentId),
      }
    );
  }

  if (row.resulting_requestability_status !== "requestable_with_approval") {
    return fail(
      "access_request_latest_event_not_requestable",
      "The latest controlled listing/requestability event does not permit access request intake.",
      {
        document_id: cleanText(documentId),
        event_id: row.id,
        resulting_requestability_status:
          row.resulting_requestability_status,
      }
    );
  }

  if (
    Number(row.resulting_is_listed ?? 0) !== 1 ||
    Number(row.requires_approval ?? 1) !== 1 ||
    Number(row.document_requestable ?? 0) !== 1
  ) {
    return fail(
      "access_request_listing_requestability_event_not_eligible",
      "The latest controlled listing/requestability event is not eligible for access request intake.",
      {
        event_id: row.id,
        resulting_is_listed: row.resulting_is_listed,
        requires_approval: row.requires_approval,
        document_requestable: row.document_requestable,
      }
    );
  }

  if (
    Number(row.document_downloadable ?? 0) !== 0 ||
    Number(row.generated_pdf_created ?? 0) !== 0 ||
    Number(row.licence_created ?? 0) !== 0 ||
    Number(row.download_link_created ?? 0) !== 0 ||
    Number(row.email_sent ?? 0) !== 0
  ) {
    return fail(
      "access_request_listing_requestability_event_impure",
      "The listing/requestability event contains prohibited side effects and cannot be used for access request intake.",
      {
        event_id: row.id,
        document_downloadable: row.document_downloadable,
        generated_pdf_created: row.generated_pdf_created,
        licence_created: row.licence_created,
        download_link_created: row.download_link_created,
        email_sent: row.email_sent,
      }
    );
  }

  return pass(row);
}

async function getExistingPendingDocumentAccessRequest(
  env,
  documentId,
  requesterEmail
) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       document_version,
       email,
       email_normalised,
       status,
       request_review_status,
       requested_at
     FROM document_access_requests
     WHERE document_id = ?
       AND email_normalised = ?
       AND COALESCE(request_review_status, 'pending_review') = 'pending_review'
       AND status NOT IN ('denied', 'cancelled', 'expired', 'closed')
     ORDER BY requested_at DESC
     LIMIT 1`
  )
    .bind(cleanText(documentId), normaliseEmail(requesterEmail))
    .first();

  return pass(row || null);
}

async function insertControlledDocumentAccessRequest(env, options = {}) {
  const columnsResult = await getD1TableColumns(
    env,
    "document_access_requests"
  );

  if (!columnsResult.ok) {
    return columnsResult;
  }

  const availableColumns = columnsResult.value;
  const eventAt = cleanText(options.eventAt || nowIso());
  const email = normaliseEmail(options.requesterEmail);

  const row = {
    id: options.id,
    document_id: options.documentId,
    document_version: cleanText(options.documentVersion),
    name: nullableText(options.requesterName),
    email,
    email_normalised: email,
    licence_holder_type: normaliseLicenceHolderType(
      options.licenceHolderType
    ),
    organisation_name: nullableText(options.requesterOrganisation),
    contact_name: nullableText(options.contactName || options.requesterName),
    contact_email: nullableText(options.contactEmail || email),
    role_title: nullableText(options.roleTitle),
    recipient_category: normaliseRecipientCategory(options.recipientCategory),
    status: "pending_approval",
    access_class: cleanText(options.accessClass || "approval_required"),
    verification_token_hash: null,
    verification_sent_at: null,
    email_verified_at: null,
    email_delivery_status: null,
    requested_at: eventAt,
    expires_at: null,
    approved_at: null,
    approved_by: null,
    approval_role: null,
    approval_policy_version: null,
    approval_note: null,
    denied_at: null,
    denied_by: null,
    denial_reason: null,
    terms_version: cleanText(options.termsVersion),
    terms_accepted_at: null,
    terms_acceptance_ip_hash: null,
    terms_acceptance_user_agent: null,
    ip_hash: nullableText(options.ipHash),
    user_agent: nullableText(options.userAgent),
    risk_score: 0,
    risk_flags: null,
    invitation_id: null,
    invitation_used_at: null,
    intake_source: "controlled_upload_requestability",
    request_review_status: "pending_review",
    requestability_status_at_intake: "requestable_with_approval",
    intake_event_id: options.intakeEventId || null,
  };

  const requiredColumns = [
    "id",
    "document_id",
    "document_version",
    "email",
    "email_normalised",
    "licence_holder_type",
    "recipient_category",
    "status",
    "access_class",
    "requested_at",
    "terms_version",
  ];

  const missingRequired = requiredColumns.filter(
    (column) => !availableColumns.has(column)
  );

  if (missingRequired.length) {
    return fail(
      "document_access_requests_schema_missing_required_columns",
      "The document_access_requests table is missing required columns.",
      {
        missing_columns: missingRequired,
      }
    );
  }

  if (!row.document_version) {
    return fail(
      "access_request_document_version_missing",
      "Document version is required for document_access_requests."
    );
  }

  if (!row.terms_version) {
    return fail(
      "access_request_terms_version_missing",
      "Terms version is required for document_access_requests."
    );
  }

  const insertableEntries = Object.entries(row).filter(([column]) =>
    availableColumns.has(column)
  );

  const columns = insertableEntries.map(([column]) => column);
  const values = insertableEntries.map(([, value]) => value);
  const placeholders = columns.map(() => "?").join(", ");

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_access_requests (${columns.join(", ")})
     VALUES (${placeholders})`
  )
    .bind(...values)
    .run();

  return pass({
    document_access_request: Object.fromEntries(insertableEntries),
    inserted_columns: columns,
  });
}

async function insertControlledAccessRequestIntakeEvent(env, options = {}) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const id = options.id || buildCdasAccessRequestIntakeEventId();
  const eventAt = cleanText(options.eventAt || nowIso());

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO cdas_controlled_access_request_intake_events (
       id,
       access_request_id,
       document_id,
       listing_requestability_event_id,
       requester_name,
       requester_email,
       requester_organisation,
       requester_reason,
       intake_status,
       document_status,
       document_is_listed,
       document_requestability_status,
       document_requires_approval,
       request_status,
       request_review_status,
       admin_actor,
       request_id,
       licence_created,
       generated_pdf_created,
       download_link_created,
       email_sent,
       access_approved,
       direct_download_created,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.accessRequestId,
      options.documentId,
      options.listingRequestabilityEventId || null,
      nullableText(options.requesterName),
      normaliseEmail(options.requesterEmail),
      nullableText(options.requesterOrganisation),
      nullableText(options.requesterReason),
      options.intakeStatus || "received",
      options.documentStatus || "active",
      Number(options.documentIsListed ?? 1),
      options.documentRequestabilityStatus ||
        "requestable_with_approval",
      Number(options.documentRequiresApproval ?? 1),
      options.requestStatus || "pending_approval",
      options.requestReviewStatus || "pending_review",
      nullableText(options.adminActor),
      nullableText(options.requestId),
      0,
      0,
      0,
      0,
      0,
      0,
      eventAt
    )
    .run();

  return pass({
    id,
    access_request_id: options.accessRequestId,
    document_id: options.documentId,
    listing_requestability_event_id:
      options.listingRequestabilityEventId || null,
    requester_email: normaliseEmail(options.requesterEmail),
    intake_status: options.intakeStatus || "received",
    request_status: options.requestStatus || "pending_approval",
    request_review_status:
      options.requestReviewStatus || "pending_review",
    licence_created: 0,
    generated_pdf_created: 0,
    download_link_created: 0,
    email_sent: 0,
    access_approved: 0,
    direct_download_created: 0,
    created_at: eventAt,
  });
}
