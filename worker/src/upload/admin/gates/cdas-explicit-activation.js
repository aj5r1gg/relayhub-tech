// U3-N — CDAS Explicit Activation Gate
// Extracted under U3-CUT.
//
// This gate performs explicit activation only.
// Activation preserves controlled boundaries: the document
// remains unlisted and approval-required, and this gate does
// not create requestability, licences, PDFs, download links,
// email, or direct-download access.

import { jsonResponse } from "../../../shared.js";

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

export async function handleCdasExplicitActivation(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/activate",
      route_status: "cdas_explicit_activation_gate",
      upload_domain: "cdas_document",
      switches,
      policy: {
        admin_only: true,
        explicit_activation_enabled: envEnabled(
          env.CDAS_UPLOAD_EXPLICIT_ACTIVATION_ENABLED
        ),
        requires_activation_prep_event: true,
        document_must_be_draft: true,
        document_must_be_unlisted: true,
        document_must_require_approval: true,
        changes_document_status_to_active: true,
        keeps_document_unlisted: true,
        keeps_approval_required: true,
        publishes_document: false,
        makes_document_requestable: false,
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

  if (!envEnabled(env.CDAS_UPLOAD_EXPLICIT_ACTIVATION_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "explicit_activation_disabled",
        message:
          "CDAS upload explicit activation is disabled by policy. No document status was changed.",
        required_switch: "CDAS_UPLOAD_EXPLICIT_ACTIVATION_ENABLED=true",
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
        validation_stage: "explicit_activation_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const documentId = cleanText(body.document_id);

  const documentResult = await getCdasDraftDocumentForExplicitActivation(
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
        validation_stage: "explicit_activation_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const prepResult = await getLatestActivationPrepEvent(env, documentId);

  if (!prepResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: prepResult.error,
        message: prepResult.message,
        details: prepResult.details || {},
        validation_stage: "explicit_activation_prep_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const existingActivation = await getExistingCdasActivationEvent(
    env,
    documentId
  );

  if (!existingActivation.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: existingActivation.error,
        message: existingActivation.message,
        details: existingActivation.details || {},
        validation_stage: "explicit_activation_existing_check",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  if (existingActivation.value) {
    return jsonResponse(
      {
        ok: true,
        accepted: true,
        idempotent_replay: true,
        message:
          "This document has already been explicitly activated. No new activation event was created.",
        validation_stage: "explicit_activation_existing_replay",
        existing_activation_event: existingActivation.value,
        side_effects_confirmed: buildSideEffectsConfirmed({
          activates_document: false,
        }),
        public_visibility: {
          listed_publicly: false,
          requestable_publicly: false,
          downloadable_publicly: false,
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

  const document = documentResult.value;
  const prepEvent = prepResult.value;
  const eventAt = nowIso();

  const activationUpdate = await activateCdasDraftDocumentRecord(
    env,
    document.id,
    eventAt
  );

  if (!activationUpdate.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: activationUpdate.error,
        message: activationUpdate.message,
        details: activationUpdate.details || {},
        validation_stage: "explicit_activation_document_update",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const activationEvent = await insertCdasActivationEvent(env, {
    documentId: document.id,
    uploadTransactionId: prepEvent.upload_transaction_id || null,
    reviewEventId: prepEvent.review_event_id || null,
    activationPrepEventId: prepEvent.id,
    previousDocumentStatus: document.status,
    activationNotes: body.activation_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    sourceObject: document.source_object,
    sourceSha256: document.source_sha256,
    eventAt,
  });

  if (!activationEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: activationEvent.error,
        message: activationEvent.message,
        details: activationEvent.details || {},
        validation_stage: "explicit_activation_event_insert",
        side_effects_confirmed: buildSideEffectsConfirmed({
          activates_document: true,
        }),
        recovery_required: true,
        recovery_note:
          "Document status was updated to active but activation event insertion failed. Manual review is required.",
      },
      500
    );
  }

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message:
        "CDAS document was explicitly activated. It remains unlisted, approval-required, not publicly requestable, not downloadable, not licensed, and no email was sent.",
      route: "/api/admin/uploads/cdas-document/activate",
      validation_stage: "cdas_explicit_activation",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        previous_status: document.status,
        resulting_status: "active",
        is_listed: 0,
        requires_approval: 1,
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
        licence_terms_version: document.licence_terms_version || null,
        classification: document.classification || null,
        access_class: document.access_class || null,
      },
      activation_preparation_event: {
        id: prepEvent.id,
        prep_status: prepEvent.prep_status,
        created_at: prepEvent.created_at,
      },
      activation: {
        event: activationEvent.value,
        update: activationUpdate.value,
        next_allowed_gate:
          "U3-O — CDAS Controlled Listing and Requestability Gate",
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
        activates_document: true,
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
      }),
      public_visibility: {
        listed_publicly: false,
        requestable_publicly: false,
        downloadable_publicly: false,
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

function buildCdasActivationEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `cact_${random.replaceAll("-", "")}`;
}

async function getLatestActivationPrepEvent(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       prep_status,
       previous_document_status,
       resulting_document_status,
       source_object,
       source_sha256,
       public_visibility_created,
       document_activated,
       document_published,
       document_requestable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     FROM cdas_activation_prep_events
     WHERE document_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "activation_prep_event_missing",
      "No activation preparation event was found for this document.",
      {
        document_id: id,
      }
    );
  }

  if (row.prep_status !== "prepared") {
    return fail(
      "activation_prep_not_prepared",
      "The latest activation preparation event does not permit activation.",
      {
        document_id: id,
        activation_prep_event_id: row.id,
        prep_status: row.prep_status,
      }
    );
  }

  if (
    Number(row.public_visibility_created ?? 0) !== 0 ||
    Number(row.document_activated ?? 0) !== 0 ||
    Number(row.document_published ?? 0) !== 0 ||
    Number(row.document_requestable ?? 0) !== 0 ||
    Number(row.generated_pdf_created ?? 0) !== 0 ||
    Number(row.licence_created ?? 0) !== 0 ||
    Number(row.download_link_created ?? 0) !== 0 ||
    Number(row.email_sent ?? 0) !== 0
  ) {
    return fail(
      "activation_prep_event_impure",
      "The activation preparation event contains prohibited side effects and cannot be used for explicit activation.",
      {
        activation_prep_event_id: row.id,
        public_visibility_created: row.public_visibility_created,
        document_activated: row.document_activated,
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

async function getCdasDraftDocumentForExplicitActivation(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_database_unavailable",
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
      "activation_document_not_found",
      "Draft document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "draft") {
    return fail(
      "activation_document_not_draft",
      "Only draft documents can be explicitly activated through this gate.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.is_listed ?? 0) !== 0) {
    return fail(
      "activation_document_is_listed",
      "Listed documents cannot be handled through this upload activation gate.",
      {
        document_id: row.id,
        is_listed: row.is_listed,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "activation_document_does_not_require_approval",
      "This document does not appear to be an approval-required upload draft.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  if (!cleanText(row.source_object)) {
    return fail(
      "activation_source_object_missing",
      "Draft document does not have a source object.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.source_sha256)) {
    return fail(
      "activation_source_sha256_missing",
      "Draft document does not have source SHA-256 evidence.",
      {
        document_id: row.id,
      }
    );
  }

  return pass(row);
}

async function getExistingCdasActivationEvent(env, documentId) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_database_unavailable",
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
       source_object,
       source_sha256,
       created_at
     FROM cdas_activation_events
     WHERE document_id = ?
       AND activation_status = 'activated'
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(cleanText(documentId))
    .first();

  return pass(row || null);
}

async function insertCdasActivationEvent(env, options = {}) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasActivationEventId();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO cdas_activation_events (
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       activation_prep_event_id,
       activation_status,
       previous_document_status,
       resulting_document_status,
       activation_notes,
       admin_actor,
       request_id,
       source_object,
       source_sha256,
       public_visibility_created,
       document_activated,
       document_published,
       document_requestable,
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
      options.uploadTransactionId || null,
      options.reviewEventId || null,
      options.activationPrepEventId || null,
      "activated",
      options.previousDocumentStatus || "draft",
      "active",
      nullableText(options.activationNotes),
      nullableText(options.adminActor),
      nullableText(options.requestId),
      nullableText(options.sourceObject),
      nullableText(options.sourceSha256),
      0,
      1,
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
    document_id: options.documentId,
    upload_transaction_id: options.uploadTransactionId || null,
    review_event_id: options.reviewEventId || null,
    activation_prep_event_id: options.activationPrepEventId || null,
    activation_status: "activated",
    previous_document_status: options.previousDocumentStatus || "draft",
    resulting_document_status: "active",
    source_object: options.sourceObject || null,
    source_sha256: options.sourceSha256 || null,
    public_visibility_created: 0,
    document_activated: 1,
    document_published: 0,
    document_requestable: 0,
    generated_pdf_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    created_at: eventAt,
  });
}

async function activateCdasDraftDocumentRecord(
  env,
  documentId,
  eventAt = nowIso()
) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const result = await env.RELAYHUB_DB.prepare(
    `UPDATE documents
     SET status = 'active',
         updated_at = ?
     WHERE id = ?
       AND status = 'draft'
       AND COALESCE(is_listed, 0) = 0
       AND COALESCE(requires_approval, 1) = 1`
  )
    .bind(eventAt, documentId)
    .run();

  return pass({
    document_id: documentId,
    previous_status: "draft",
    resulting_status: "active",
    is_listed: 0,
    requires_approval: 1,
    updated_at: eventAt,
    changes: result?.meta?.changes ?? null,
  });
}
