// U3-O — CDAS Controlled Listing and Requestability Gate
// Extracted under U3-CUT.
//
// This gate controls listing and requestability only.
// It does not create access requests, approve access, issue
// licences, generate PDFs, create download links, send email,
// or create direct-download access.

import { jsonResponse } from "../../../shared.js";

import { VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS } from "../actions.js";

import {
  buildSideEffectsConfirmed,
  cdasUploadsDisabledResponse,
  cleanText,
  envEnabled,
  fail,
  getAdminActor,
  getRequestId,
  getUploadRouteSwitches,
  methodNotAllowed,
  nowIso,
  nullableText,
  pass,
  readJsonBody,
  uploadSystemDisabledResponse,
} from "../common.js";

export async function handleCdasControlledListingRequestability(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/listing-requestability",
      route_status: "cdas_controlled_listing_requestability_gate",
      upload_domain: "cdas_document",
      switches,
      allowed_actions: Array.from(VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS),
      policy: {
        admin_only: true,
        listing_requestability_enabled: envEnabled(
          env.CDAS_UPLOAD_LISTING_REQUESTABILITY_ENABLED
        ),
        requires_explicit_activation: true,
        document_must_be_active: true,
        requires_approval_must_remain_enabled: true,
        may_set_is_listed: true,
        may_set_requestability_status: true,
        direct_downloadable: false,
        generates_pdf: false,
        creates_licence: false,
        creates_download_link: false,
        sends_email: false,
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

  if (!envEnabled(env.CDAS_UPLOAD_LISTING_REQUESTABILITY_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "listing_requestability_disabled",
        message:
          "CDAS controlled listing/requestability is disabled by policy. No document visibility state was changed.",
        required_switch: "CDAS_UPLOAD_LISTING_REQUESTABILITY_ENABLED=true",
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
        validation_stage: "listing_requestability_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const actionResult = validateCdasListingRequestabilityAction(body.action);

  if (!actionResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: actionResult.error,
        message: actionResult.message,
        details: actionResult.details || {},
        validation_stage: "listing_requestability_action_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const documentId = cleanText(body.document_id);
  const documentResult = await getCdasActiveDocumentForListingRequestability(
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
        validation_stage: "listing_requestability_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const activationResult = await getLatestCdasActivationEvent(
    env,
    documentId
  );

  if (!activationResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: activationResult.error,
        message: activationResult.message,
        details: activationResult.details || {},
        validation_stage: "listing_requestability_activation_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const action = actionResult.value;
  const document = documentResult.value;
  const activationEvent = activationResult.value;
  const outcome = buildCdasListingRequestabilityOutcome(action, document);
  const eventAt = nowIso();

  const updateResult = await updateCdasDocumentListingRequestability(
    env,
    document.id,
    outcome,
    eventAt
  );

  if (!updateResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: updateResult.error,
        message: updateResult.message,
        details: updateResult.details || {},
        validation_stage: "listing_requestability_document_update",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const eventResult = await insertCdasListingRequestabilityEvent(env, {
    documentId: document.id,
    activationEventId: activationEvent.id,
    action,
    previousDocumentStatus: document.status,
    resultingDocumentStatus: "active",
    previousIsListed: Number(document.is_listed ?? 0),
    resultingIsListed: outcome.resulting_is_listed,
    previousRequestabilityStatus:
      document.requestability_status || "not_requestable",
    resultingRequestabilityStatus: outcome.resulting_requestability_status,
    publicVisibilityCreated: outcome.public_visibility_created,
    documentRequestable: outcome.document_requestable,
    actionNotes: body.action_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    eventAt,
  });

  if (!eventResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: eventResult.error,
        message: eventResult.message,
        details: eventResult.details || {},
        validation_stage: "listing_requestability_event_insert",
        recovery_required: true,
        recovery_note:
          "Document listing/requestability state was updated but event insertion failed. Manual review is required.",
        side_effects_confirmed: buildSideEffectsConfirmed({
          public_visibility_created:
            outcome.public_visibility_created === 1,
          makes_document_requestable:
            outcome.document_requestable === 1,
        }),
      },
      500
    );
  }

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message: outcome.message,
      route: "/api/admin/uploads/cdas-document/listing-requestability",
      validation_stage: "cdas_controlled_listing_requestability",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        status: "active",
        previous_is_listed: Number(document.is_listed ?? 0),
        resulting_is_listed: outcome.resulting_is_listed,
        previous_requestability_status:
          document.requestability_status || "not_requestable",
        resulting_requestability_status:
          outcome.resulting_requestability_status,
        requires_approval: 1,
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
        licence_terms_version: document.licence_terms_version || null,
        classification: document.classification || null,
        access_class: document.access_class || null,
      },
      activation_event: {
        id: activationEvent.id,
        activation_status: activationEvent.activation_status,
        created_at: activationEvent.created_at,
      },
      listing_requestability: {
        event: eventResult.value,
        update: updateResult.value,
        next_allowed_gate:
          action === "enable_requestability"
            ? "U3-P — CDAS Controlled Access Request Intake Gate"
            : "U3-O remains available for later listing/requestability changes",
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
        public_visibility_created:
          outcome.public_visibility_created === 1,
        makes_document_requestable:
          outcome.document_requestable === 1,
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
      }),
      public_visibility: {
        listed_publicly: outcome.resulting_is_listed === 1,
        requestable_publicly:
          outcome.resulting_requestability_status ===
          "requestable_with_approval",
        directly_downloadable_publicly: false,
        public_url_created: false,
      },
      prohibited_side_effects: {
        generated_pdf_created: false,
        licence_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    200
  );
}

function buildCdasListingRequestabilityEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `clre_${random.replaceAll("-", "")}`;
}

function normaliseListingRequestabilityAction(value) {
  return cleanText(value).toLowerCase();
}

function validateCdasListingRequestabilityAction(action) {
  const cleanAction = normaliseListingRequestabilityAction(action);

  if (!VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS.has(cleanAction)) {
    return fail(
      "listing_requestability_action_invalid",
      "CDAS listing/requestability action is not recognised.",
      {
        allowed_actions: Array.from(VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS),
        received_action: cleanAction,
      }
    );
  }

  return pass(cleanAction);
}

async function getLatestCdasActivationEvent(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "listing_requestability_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       activation_prep_event_id,
       activation_status,
       previous_document_status,
       resulting_document_status,
       public_visibility_created,
       document_published,
       document_requestable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     FROM cdas_activation_events
     WHERE document_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "listing_requestability_activation_event_missing",
      "No explicit activation event was found for this document.",
      {
        document_id: id,
      }
    );
  }

  if (row.activation_status !== "activated") {
    return fail(
      "listing_requestability_activation_not_activated",
      "The latest activation event does not permit controlled listing or requestability.",
      {
        document_id: id,
        activation_event_id: row.id,
        activation_status: row.activation_status,
      }
    );
  }

  if (
    Number(row.public_visibility_created ?? 0) !== 0 ||
    Number(row.document_published ?? 0) !== 0 ||
    Number(row.document_requestable ?? 0) !== 0 ||
    Number(row.generated_pdf_created ?? 0) !== 0 ||
    Number(row.licence_created ?? 0) !== 0 ||
    Number(row.download_link_created ?? 0) !== 0 ||
    Number(row.email_sent ?? 0) !== 0
  ) {
    return fail(
      "listing_requestability_activation_event_impure",
      "The activation event contains prohibited side effects and cannot be used for controlled listing/requestability.",
      {
        activation_event_id: row.id,
        public_visibility_created: row.public_visibility_created,
        document_published: row.document_published,
        document_requestable: row.document_requestable,
        generated_pdf_created: row.generated_pdf_created,
        licence_created: row.licence_created,
        download_link_created: row.download_link_created,
        email_sent: row.email_sent,
      }
    );
  }

  return pass(row);
}

async function getCdasActiveDocumentForListingRequestability(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "listing_requestability_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
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
      "listing_requestability_document_not_found",
      "Active document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "active") {
    return fail(
      "listing_requestability_document_not_active",
      "Only active documents can enter controlled listing/requestability.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "listing_requestability_document_does_not_require_approval",
      "Controlled requestability requires approval to remain enabled.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  if (!cleanText(row.source_object)) {
    return fail(
      "listing_requestability_source_object_missing",
      "Active document does not have a source object.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.source_sha256)) {
    return fail(
      "listing_requestability_source_sha256_missing",
      "Active document does not have source SHA-256 evidence.",
      {
        document_id: row.id,
      }
    );
  }

  return pass(row);
}

function buildCdasListingRequestabilityOutcome(action, document) {
  const currentListed = Number(document.is_listed ?? 0);
  const currentRequestability = cleanText(
    document.requestability_status || "not_requestable"
  );

  if (action === "list_only") {
    return {
      resulting_is_listed: 1,
      resulting_requestability_status: "not_requestable",
      public_visibility_created: currentListed === 1 ? 0 : 1,
      document_requestable: 0,
      message:
        "Document was listed for controlled visibility only. It is not requestable, not downloadable, not licensed, and no email was sent.",
    };
  }

  if (action === "enable_requestability") {
    return {
      resulting_is_listed: 1,
      resulting_requestability_status: "requestable_with_approval",
      public_visibility_created: currentListed === 1 ? 0 : 1,
      document_requestable:
        currentRequestability === "requestable_with_approval" ? 0 : 1,
      message:
        "Document was made requestable with approval required. It is not directly downloadable, not licensed, and no email was sent.",
    };
  }

  if (action === "disable_requestability") {
    return {
      resulting_is_listed: currentListed,
      resulting_requestability_status: "not_requestable",
      public_visibility_created: 0,
      document_requestable: 0,
      message:
        "Document requestability was disabled. Listing state was preserved. No licence, download link, generated PDF, or email was created.",
    };
  }

  return {
    resulting_is_listed: 0,
    resulting_requestability_status: "not_requestable",
    public_visibility_created: 0,
    document_requestable: 0,
    message:
      "Document was unlisted and made not requestable. No licence, download link, generated PDF, or email was created.",
  };
}

async function updateCdasDocumentListingRequestability(
  env,
  documentId,
  outcome,
  eventAt = nowIso()
) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  await env.RELAYHUB_DB.prepare(
    `UPDATE documents
     SET is_listed = ?,
         requestability_status = ?,
         listed_at = CASE
           WHEN ? = 1 AND COALESCE(is_listed, 0) = 0 THEN ?
           WHEN ? = 0 THEN NULL
           ELSE listed_at
         END,
         requestable_at = CASE
           WHEN ? = 'requestable_with_approval'
             AND COALESCE(requestability_status, 'not_requestable') != 'requestable_with_approval'
           THEN ?
           WHEN ? != 'requestable_with_approval' THEN NULL
           ELSE requestable_at
         END,
         updated_at = ?
     WHERE id = ?
       AND status = 'active'
       AND COALESCE(requires_approval, 1) = 1`
  )
    .bind(
      outcome.resulting_is_listed,
      outcome.resulting_requestability_status,
      outcome.resulting_is_listed,
      eventAt,
      outcome.resulting_is_listed,
      outcome.resulting_requestability_status,
      eventAt,
      outcome.resulting_requestability_status,
      eventAt,
      documentId
    )
    .run();

  return pass({
    document_id: documentId,
    resulting_is_listed: outcome.resulting_is_listed,
    resulting_requestability_status: outcome.resulting_requestability_status,
    updated_at: eventAt,
  });
}

async function insertCdasListingRequestabilityEvent(env, options = {}) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasListingRequestabilityEventId();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO cdas_listing_requestability_events (
       id,
       document_id,
       activation_event_id,
       action,
       previous_document_status,
       resulting_document_status,
       previous_is_listed,
       resulting_is_listed,
       previous_requestability_status,
       resulting_requestability_status,
       requires_approval,
       action_notes,
       admin_actor,
       request_id,
       public_visibility_created,
       document_requestable,
       document_downloadable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.documentId,
      options.activationEventId || null,
      options.action,
      options.previousDocumentStatus || "active",
      options.resultingDocumentStatus || "active",
      Number(options.previousIsListed ?? 0),
      Number(options.resultingIsListed ?? 0),
      options.previousRequestabilityStatus || "not_requestable",
      options.resultingRequestabilityStatus || "not_requestable",
      1,
      nullableText(options.actionNotes),
      nullableText(options.adminActor),
      nullableText(options.requestId),
      Number(options.publicVisibilityCreated ?? 0),
      Number(options.documentRequestable ?? 0),
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
    document_id: options.documentId,
    activation_event_id: options.activationEventId || null,
    action: options.action,
    previous_document_status: options.previousDocumentStatus || "active",
    resulting_document_status: options.resultingDocumentStatus || "active",
    previous_is_listed: Number(options.previousIsListed ?? 0),
    resulting_is_listed: Number(options.resultingIsListed ?? 0),
    previous_requestability_status:
      options.previousRequestabilityStatus || "not_requestable",
    resulting_requestability_status:
      options.resultingRequestabilityStatus || "not_requestable",
    requires_approval: 1,
    public_visibility_created: Number(options.publicVisibilityCreated ?? 0),
    document_requestable: Number(options.documentRequestable ?? 0),
    document_downloadable: 0,
    generated_pdf_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    created_at: eventAt,
  });
}
