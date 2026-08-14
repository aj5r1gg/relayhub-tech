// U3-M — CDAS Activation Preparation Gate
// Extracted under U3-CUT.
//
// This gate prepares an already-approved draft document
// for later explicit activation.
// It does not activate, list, make requestable, create access
// requests, issue licences, generate PDFs, create download
// links, send email, or create direct-download access.

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

export async function handleCdasActivationPreparation(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/activation-prep",
      route_status: "cdas_activation_preparation_gate",
      upload_domain: "cdas_document",
      switches,
      policy: {
        admin_only: true,
        activation_prep_enabled: envEnabled(
          env.CDAS_UPLOAD_ACTIVATION_PREP_ENABLED
        ),
        requires_review_action: "approve_for_activation_prep",
        document_must_be_draft: true,
        document_must_be_unlisted: true,
        document_must_require_approval: true,
        creates_activation_prep_event: true,
        activates_document: false,
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

  if (!envEnabled(env.CDAS_UPLOAD_ACTIVATION_PREP_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "activation_prep_disabled",
        message:
          "CDAS upload activation preparation is disabled by policy. No activation preparation event was recorded.",
        required_switch: "CDAS_UPLOAD_ACTIVATION_PREP_ENABLED=true",
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
        validation_stage: "activation_prep_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const documentId = cleanText(body.document_id);

  const documentResult = await getCdasDraftDocumentForActivationPrep(
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
        validation_stage: "activation_prep_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const reviewResult = await getLatestActivationPrepReviewEvent(
    env,
    documentId
  );

  if (!reviewResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: reviewResult.error,
        message: reviewResult.message,
        details: reviewResult.details || {},
        validation_stage: "activation_prep_review_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const existingPrep = await getExistingActivationPrepEvent(env, documentId);

  if (!existingPrep.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: existingPrep.error,
        message: existingPrep.message,
        details: existingPrep.details || {},
        validation_stage: "activation_prep_existing_check",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  if (existingPrep.value) {
    return jsonResponse(
      {
        ok: true,
        accepted: true,
        idempotent_replay: true,
        message:
          "This draft document has already been prepared for activation. No new activation preparation event was created.",
        validation_stage: "activation_prep_existing_replay",
        existing_activation_prep_event: existingPrep.value,
        side_effects_confirmed: buildSideEffectsConfirmed(),
        public_visibility: {
          listed_publicly: false,
          requestable_publicly: false,
          downloadable_publicly: false,
          public_url_created: false,
        },
        prohibited_side_effects: {
          activated: false,
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
  const reviewEvent = reviewResult.value;
  const eventAt = nowIso();

  const prepEvent = await insertCdasActivationPrepEvent(env, {
    documentId: document.id,
    uploadTransactionId: reviewEvent.upload_transaction_id || null,
    reviewEventId: reviewEvent.id,
    prepStatus: "prepared",
    previousDocumentStatus: document.status,
    resultingDocumentStatus: "draft",
    prepNotes: body.prep_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    sourceObject: document.source_object,
    sourceSha256: document.source_sha256,
    eventAt,
  });

  if (!prepEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: prepEvent.error,
        message: prepEvent.message,
        details: prepEvent.details || {},
        validation_stage: "activation_prep_event_insert",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const touched = await touchCdasDraftDocumentAfterActivationPrep(
    env,
    document.id,
    eventAt
  );

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message:
        "Draft document was prepared for a later activation workflow. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
      route: "/api/admin/uploads/cdas-document/activation-prep",
      validation_stage: "cdas_activation_preparation",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        status: document.status,
        is_listed: Number(document.is_listed ?? 0),
        requires_approval: Number(document.requires_approval ?? 1),
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
        licence_terms_version: document.licence_terms_version || null,
        classification: document.classification || null,
        access_class: document.access_class || null,
      },
      review_event: {
        id: reviewEvent.id,
        review_action: reviewEvent.review_action,
        created_at: reviewEvent.created_at,
      },
      activation_preparation: {
        event: prepEvent.value,
        document_touched: touched.ok === true,
        next_allowed_gate:
          "U3-N — CDAS Explicit Activation Gate",
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
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
        activated: false,
        generated_pdf_created: false,
        licence_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    200
  );
}

function buildCdasActivationPrepEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `cape_${random.replaceAll("-", "")}`;
}

async function getLatestActivationPrepReviewEvent(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_prep_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_action,
       previous_document_status,
       resulting_document_status,
       review_notes,
       admin_actor,
       request_id,
       public_visibility_created,
       licence_created,
       download_link_created,
       email_sent,
       document_activated,
       generated_pdf_created,
       created_at
     FROM cdas_upload_review_events
     WHERE document_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "activation_prep_review_event_missing",
      "No upload review event was found for this draft document.",
      {
        document_id: id,
      }
    );
  }

  if (row.review_action !== "approve_for_activation_prep") {
    return fail(
      "activation_prep_review_not_approved",
      "The latest upload review event does not approve this draft for activation preparation.",
      {
        document_id: id,
        latest_review_action: row.review_action,
        latest_review_event_id: row.id,
      }
    );
  }

  if (
    Number(row.public_visibility_created ?? 0) !== 0 ||
    Number(row.licence_created ?? 0) !== 0 ||
    Number(row.download_link_created ?? 0) !== 0 ||
    Number(row.email_sent ?? 0) !== 0 ||
    Number(row.document_activated ?? 0) !== 0 ||
    Number(row.generated_pdf_created ?? 0) !== 0
  ) {
    return fail(
      "activation_prep_review_event_impure",
      "The upload review event contains prohibited side effects and cannot be used for activation preparation.",
      {
        review_event_id: row.id,
        public_visibility_created: row.public_visibility_created,
        licence_created: row.licence_created,
        download_link_created: row.download_link_created,
        email_sent: row.email_sent,
        document_activated: row.document_activated,
        generated_pdf_created: row.generated_pdf_created,
      }
    );
  }

  return pass(row);
}

async function getCdasDraftDocumentForActivationPrep(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_prep_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
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
      "activation_prep_document_not_found",
      "Draft document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "draft") {
    return fail(
      "activation_prep_document_not_draft",
      "Only draft documents can enter activation preparation through this gate.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.is_listed ?? 0) !== 0) {
    return fail(
      "activation_prep_document_is_listed",
      "Listed documents cannot enter activation preparation through this upload gate.",
      {
        document_id: row.id,
        is_listed: row.is_listed,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "activation_prep_document_does_not_require_approval",
      "This document does not appear to be an approval-required upload draft.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  if (!cleanText(row.source_object)) {
    return fail(
      "activation_prep_source_object_missing",
      "Draft document does not have a source object.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.source_sha256)) {
    return fail(
      "activation_prep_source_sha256_missing",
      "Draft document does not have source SHA-256 evidence.",
      {
        document_id: row.id,
      }
    );
  }

  return pass(row);
}

async function getExistingActivationPrepEvent(env, documentId) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
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
       created_at
     FROM cdas_activation_prep_events
     WHERE document_id = ?
       AND prep_status = 'prepared'
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(cleanText(documentId))
    .first();

  return pass(row || null);
}

async function insertCdasActivationPrepEvent(env, options = {}) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasActivationPrepEventId();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO cdas_activation_prep_events (
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       prep_status,
       previous_document_status,
       resulting_document_status,
       prep_notes,
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.documentId,
      options.uploadTransactionId || null,
      options.reviewEventId || null,
      options.prepStatus || "prepared",
      options.previousDocumentStatus || "draft",
      options.resultingDocumentStatus || "draft",
      nullableText(options.prepNotes),
      nullableText(options.adminActor),
      nullableText(options.requestId),
      nullableText(options.sourceObject),
      nullableText(options.sourceSha256),
      0,
      0,
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
    prep_status: options.prepStatus || "prepared",
    previous_document_status: options.previousDocumentStatus || "draft",
    resulting_document_status: options.resultingDocumentStatus || "draft",
    source_object: options.sourceObject || null,
    source_sha256: options.sourceSha256 || null,
    public_visibility_created: 0,
    document_activated: 0,
    document_published: 0,
    document_requestable: 0,
    generated_pdf_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    created_at: eventAt,
  });
}

async function touchCdasDraftDocumentAfterActivationPrep(
  env,
  documentId,
  eventAt = nowIso()
) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  await env.RELAYHUB_DB.prepare(
    `UPDATE documents
     SET updated_at = ?
     WHERE id = ?
       AND status = 'draft'
       AND COALESCE(is_listed, 0) = 0
       AND COALESCE(requires_approval, 1) = 1`
  )
    .bind(eventAt, documentId)
    .run();

  return pass({
    document_id: documentId,
    touched_at: eventAt,
  });
}
