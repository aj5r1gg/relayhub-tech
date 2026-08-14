// U3-L — CDAS Draft Review Gate
// Extracted under U3-CUT.
//
// This gate reviews an uploaded draft using only the
// canonical hold, reject, and approve-for-activation-prep
// actions.
// It does not activate, publish, list, make requestable,
// issue licences, generate PDFs, create download links,
// send email, or create direct-download access.

import { jsonResponse } from "../../../shared.js";

import { VALID_CDAS_DRAFT_REVIEW_ACTIONS } from "../actions.js";

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

function buildCdasUploadReviewEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `curv_${random.replaceAll("-", "")}`;
}

function normaliseReviewAction(value) {
  return cleanText(value).toLowerCase();
}

function validateCdasDraftReviewAction(action) {
  const cleanAction = normaliseReviewAction(action);

  if (!VALID_CDAS_DRAFT_REVIEW_ACTIONS.has(cleanAction)) {
    return fail(
      "upload_review_action_invalid",
      "CDAS upload review action is not recognised.",
      {
        allowed_actions: Array.from(VALID_CDAS_DRAFT_REVIEW_ACTIONS),
        received_action: cleanAction,
      }
    );
  }

  return pass(cleanAction);
}

async function getCdasDraftDocumentForReview(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "upload_review_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "upload_review_database_unavailable",
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
       source_sha256
     FROM documents
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "upload_review_document_not_found",
      "Draft document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "draft") {
    return fail(
      "upload_review_document_not_draft",
      "Only draft CDAS documents can be reviewed through this upload review gate.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.is_listed ?? 0) !== 0) {
    return fail(
      "upload_review_document_is_listed",
      "Listed documents cannot be handled through the upload draft review gate.",
      {
        document_id: row.id,
        is_listed: row.is_listed,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "upload_review_document_does_not_require_approval",
      "This document does not appear to be an approval-required upload draft.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  return pass(row);
}

function buildCdasReviewOutcome(action) {
  if (action === "hold") {
    return {
      review_state: "held",
      resulting_document_status: "draft",
      next_allowed_gate: null,
      message:
        "Draft document was placed on hold. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
    };
  }

  if (action === "reject") {
    return {
      review_state: "rejected",
      resulting_document_status: "draft",
      next_allowed_gate: null,
      message:
        "Draft document was rejected for release. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
    };
  }

  return {
    review_state: "approved_for_activation_prep",
    resulting_document_status: "draft",
    next_allowed_gate: "U3-M — CDAS Activation Preparation Gate",
    message:
      "Draft document was approved for activation preparation only. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
  };
}

async function insertCdasUploadReviewEvent(env, options = {}) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "upload_review_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasUploadReviewEventId();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO cdas_upload_review_events (
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.documentId,
      options.uploadTransactionId || null,
      options.reviewAction,
      options.previousDocumentStatus || "draft",
      options.resultingDocumentStatus || "draft",
      nullableText(options.reviewNotes),
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
    document_id: options.documentId,
    upload_transaction_id: options.uploadTransactionId || null,
    review_action: options.reviewAction,
    previous_document_status: options.previousDocumentStatus || "draft",
    resulting_document_status: options.resultingDocumentStatus || "draft",
    review_notes: nullableText(options.reviewNotes),
    public_visibility_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    document_activated: 0,
    generated_pdf_created: 0,
    created_at: eventAt,
  });
}

async function touchCdasDraftDocumentAfterReview(env, documentId, eventAt = nowIso()) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "upload_review_database_unavailable",
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

export async function handleCdasDraftReviewAction(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/review",
      route_status: "cdas_draft_review_action_gate",
      upload_domain: "cdas_document",
      allowed_actions: Array.from(VALID_CDAS_DRAFT_REVIEW_ACTIONS),
      switches,
      policy: {
        admin_only: true,
        review_actions_enabled: envEnabled(env.CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED),
        document_must_be_draft: true,
        document_must_be_unlisted: true,
        document_must_require_approval: true,
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

  if (!envEnabled(env.CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "upload_review_actions_disabled",
        message:
          "CDAS upload draft review actions are disabled by policy. No review action was recorded.",
        required_switch: "CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED=true",
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
        validation_stage: "review_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const actionResult = validateCdasDraftReviewAction(body.action);

  if (!actionResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: actionResult.error,
        message: actionResult.message,
        details: actionResult.details || {},
        validation_stage: "review_action_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const documentResult = await getCdasDraftDocumentForReview(
    env,
    body.document_id
  );

  if (!documentResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: documentResult.error,
        message: documentResult.message,
        details: documentResult.details || {},
        validation_stage: "review_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const action = actionResult.value;
  const document = documentResult.value;
  const outcome = buildCdasReviewOutcome(action);
  const eventAt = nowIso();

  const reviewEvent = await insertCdasUploadReviewEvent(env, {
    documentId: document.id,
    uploadTransactionId: body.upload_transaction_id || null,
    reviewAction: action,
    previousDocumentStatus: document.status,
    resultingDocumentStatus: outcome.resulting_document_status,
    reviewNotes: body.review_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    eventAt,
  });

  if (!reviewEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: reviewEvent.error,
        message: reviewEvent.message,
        details: reviewEvent.details || {},
        validation_stage: "review_event_insert",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const touched = await touchCdasDraftDocumentAfterReview(
    env,
    document.id,
    eventAt
  );

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message: outcome.message,
      route: "/api/admin/uploads/cdas-document/review",
      validation_stage: "cdas_draft_review_action",
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
      },
      review: {
        action,
        review_state: outcome.review_state,
        event: reviewEvent.value,
        document_touched: touched.ok === true,
        next_allowed_gate: outcome.next_allowed_gate,
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
