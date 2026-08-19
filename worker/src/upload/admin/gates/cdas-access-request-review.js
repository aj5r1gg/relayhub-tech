// U3-Q — CDAS Controlled Access Request Review Gate
// Extracted under U3-CUT.
// This module does NOT implement U3-R licence preparation.

import { jsonResponse } from "../../../shared.js";

import {
  buildSideEffectsConfirmed,
  cdasUploadsDisabledResponse,
  cleanText,
  envEnabled,
  fail,
  getAdminActor,
  getUploadRouteSwitches,
  methodNotAllowed,
  nowIso,
  nullableText,
  pass,
  readJsonBody,
  uploadSystemDisabledResponse,
} from "../common.js";
import {
  VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS,
} from "../actions.js";

export async function handleCdasControlledAccessRequestReview(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/access-request/review",
      route_status: "cdas_controlled_access_request_review_gate",
      upload_domain: "cdas_document",
      switches,
      allowed_actions: Array.from(
        VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS
      ),
      policy: {
        admin_only: true,
        public_route: false,
        access_request_review_enabled: envEnabled(
          env.CDAS_UPLOAD_ACCESS_REQUEST_REVIEW_ENABLED
        ),
        target_table: "document_access_requests",
        event_table: "document_access_request_review_events",
        may_hold_request: true,
        may_reject_request: true,
        may_approve_for_licence_prep: true,
        approval_state: "approved_pending_licence",
        approval_review_state: "approved_for_licence_prep",
        approves_for_next_gate_only: true,
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

  if (!envEnabled(env.CDAS_UPLOAD_ACCESS_REQUEST_REVIEW_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "access_request_review_disabled",
        message:
          "CDAS controlled access request review is disabled by policy. No request review state was changed.",
        required_switch: "CDAS_UPLOAD_ACCESS_REQUEST_REVIEW_ENABLED=true",
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
        validation_stage: "access_request_review_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const actionResult = validateAccessRequestReviewAction(body.action);

  if (!actionResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: actionResult.error,
        message: actionResult.message,
        details: actionResult.details || {},
        validation_stage: "access_request_review_action_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const action = actionResult.value;
  const requestId = cleanText(body.request_id);

  const requestResult = await getDocumentAccessRequestForControlledReview(
    env,
    requestId
  );

  if (!requestResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: requestResult.error,
        message: requestResult.message,
        details: requestResult.details || {},
        validation_stage: "access_request_review_request_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const accessRequest = requestResult.value;

  const documentResult = await getDocumentForAccessRequestReview(
    env,
    accessRequest.document_id
  );

  if (!documentResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: documentResult.error,
        message: documentResult.message,
        details: documentResult.details || {},
        validation_stage: "access_request_review_document_lookup",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const document = documentResult.value;

  if (action === "approve_for_licence_prep") {
    const eligibilityResult =
      validateDocumentStillEligibleForApproval(document);

    if (!eligibilityResult.ok) {
      return jsonResponse(
        {
          ok: false,
          accepted: false,
          error: eligibilityResult.error,
          message: eligibilityResult.message,
          details: eligibilityResult.details || {},
          validation_stage:
            "access_request_review_approval_eligibility",
          side_effects_confirmed: buildSideEffectsConfirmed(),
        },
        409
      );
    }
  }

  const eventAt = nowIso();
  const actor = getAdminActor(request, env);
  const outcome = buildAccessRequestReviewOutcome(
    action,
    accessRequest
  );

  const updateResult = await updateDocumentAccessRequestReviewState(env, {
    requestId: accessRequest.id,
    action,
    outcome,
    actor,
    reason: body.reason,
    note: body.note,
    eventAt,
  });

  if (!updateResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: updateResult.error,
        message: updateResult.message,
        details: updateResult.details || {},
        validation_stage: "access_request_review_update",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const reviewEvent = await insertDocumentAccessRequestReviewEvent(env, {
    requestId: accessRequest.id,
    eventType: outcome.event_type,
    previousStatus: outcome.previous_status,
    newStatus: outcome.new_status,
    actor,
    reason: body.reason,
    note: body.note,
    eventAt,
    metadata: {
      gate: "U3-Q",
      route: "/api/admin/uploads/cdas-document/access-request/review",
      action,
      request_review_status: outcome.request_review_status,
      document_id: accessRequest.document_id,
      document_version: accessRequest.document_version,
      requester_email: accessRequest.email_normalised,
      intake_source: accessRequest.intake_source || null,
      intake_event_id: accessRequest.intake_event_id || null,
      document_status: document.status,
      document_is_listed: Number(document.is_listed ?? 0),
      document_requestability_status:
        document.requestability_status || "not_requestable",
      document_requires_approval: Number(
        document.requires_approval ?? 1
      ),
      licence_created: false,
      generated_pdf_created: false,
      download_link_created: false,
      email_sent: false,
      direct_download_created: false,
    },
  });

  if (!reviewEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: reviewEvent.error,
        message: reviewEvent.message,
        details: reviewEvent.details || {},
        validation_stage: "access_request_review_event_insert",
        recovery_required: true,
        recovery_note:
          "document_access_requests review state was updated but review event insertion failed. Manual review is required.",
        request_update: updateResult.value,
        side_effects_confirmed: buildSideEffectsConfirmed({
          reviews_document_access_request: true,
          approves_access_request:
            action === "approve_for_licence_prep",
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
      route: "/api/admin/uploads/cdas-document/access-request/review",
      validation_stage: "cdas_controlled_access_request_review",
      action,
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        status: document.status,
        is_listed: Number(document.is_listed ?? 0),
        requestability_status:
          document.requestability_status || "not_requestable",
        requires_approval: Number(document.requires_approval ?? 1),
      },
      document_access_request: {
        id: accessRequest.id,
        document_id: accessRequest.document_id,
        previous_status: outcome.previous_status,
        new_status: outcome.new_status,
        request_review_status: outcome.request_review_status,
        requester_email: accessRequest.email_normalised,
        document_version: accessRequest.document_version,
        access_class: accessRequest.access_class,
        terms_version: accessRequest.terms_version,
      },
      review_update: updateResult.value,
      review_event: reviewEvent.value,
      side_effects_confirmed: buildSideEffectsConfirmed({
        reviews_document_access_request: true,
        approves_access_request:
          action === "approve_for_licence_prep",
        approves_access:
          action === "approve_for_licence_prep",
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
        creates_document_access_request: false,
      }),
      prohibited_side_effects: {
        licence_created: false,
        generated_pdf_created: false,
        download_link_created: false,
        email_sent: false,
        direct_download_created: false,
      },
      next_allowed_gate:
        action === "approve_for_licence_prep"
          ? "U3-R — CDAS Licence Preparation Gate"
          : "U3-Q remains available while the request remains reviewable",
    },
    200
  );
}

function buildDocumentAccessRequestReviewEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `darre_${random.replaceAll("-", "")}`;
}

function normaliseAccessRequestReviewAction(value) {
  return cleanText(value).toLowerCase();
}

function validateAccessRequestReviewAction(action) {
  const cleanAction = normaliseAccessRequestReviewAction(action);

  if (!VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS.has(cleanAction)) {
    return fail(
      "access_request_review_action_invalid",
      "CDAS access request review action is not recognised.",
      {
        allowed_actions: Array.from(
          VALID_CDAS_ACCESS_REQUEST_REVIEW_ACTIONS
        ),
        received_action: cleanAction,
      }
    );
  }

  return pass(cleanAction);
}

function buildAccessRequestReviewOutcome(action, requestRow) {
  const previousStatus = cleanText(
    requestRow.status || "pending_approval"
  );

  if (action === "hold") {
    return {
      event_type: "held",
      previous_status: previousStatus,
      new_status: "pending_approval",
      request_review_status: "review_hold",
      approved_at: null,
      approved_by: null,
      approval_role: null,
      approval_policy_version: null,
      denied_at: null,
      denied_by: null,
      denial_reason: null,
      message:
        "Document access request was placed on review hold. No access was approved, no licence was issued, no PDF was generated, no download link was created, and no email was sent.",
    };
  }

  if (action === "reject") {
    return {
      event_type: "rejected",
      previous_status: previousStatus,
      new_status: "denied",
      request_review_status: "rejected",
      approved_at: null,
      approved_by: null,
      approval_role: null,
      approval_policy_version: null,
      denied_at: nowIso(),
      denied_by: null,
      denial_reason: null,
      message:
        "Document access request was rejected. No licence was issued, no PDF was generated, no download link was created, and no email was sent.",
    };
  }

  return {
    event_type: "review_approved",
    previous_status: previousStatus,
    new_status: "approved_pending_licence",
    request_review_status: "approved_for_licence_prep",
    approved_at: nowIso(),
    approved_by: null,
    approval_role: "cdas_upload_gate",
    approval_policy_version: "U3-Q",
    denied_at: null,
    denied_by: null,
    denial_reason: null,
    message:
      "Document access request was approved for licence preparation only. No licence was issued, no PDF was generated, no download link was created, and no email was sent.",
  };
}

async function getDocumentAccessRequestForControlledReview(env, requestId) {
  const id = cleanText(requestId);

  if (!id) {
    return fail(
      "access_request_review_request_id_missing",
      "Document access request ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_review_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.RELAYHUB_DB.prepare(
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
       requested_at,
       approved_at,
       approved_by,
       approval_role,
       approval_policy_version,
       approval_note,
       denied_at,
       denied_by,
       denial_reason,
       terms_version,
       risk_score,
       risk_flags,
       intake_source,
       request_review_status,
       requestability_status_at_intake,
       intake_event_id
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "access_request_review_request_not_found",
      "Document access request could not be found.",
      {
        request_id: id,
      }
    );
  }

  if (
    cleanText(row.status) !== "pending_approval" &&
    cleanText(row.status) !== "approved_pending_licence"
  ) {
    return fail(
      "access_request_review_status_not_reviewable",
      "Document access request is not in a reviewable state for this gate.",
      {
        request_id: row.id,
        status: row.status,
        request_review_status: row.request_review_status,
      }
    );
  }

  if (
    cleanText(row.request_review_status || "pending_review") !==
      "pending_review" &&
    cleanText(row.request_review_status || "pending_review") !==
      "review_hold"
  ) {
    return fail(
      "access_request_review_already_finalised",
      "Document access request review has already reached a final state.",
      {
        request_id: row.id,
        status: row.status,
        request_review_status: row.request_review_status,
      }
    );
  }

  return pass(row);
}

async function getDocumentForAccessRequestReview(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "access_request_review_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_review_database_unavailable",
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
      "access_request_review_document_not_found",
      "Document could not be found for access request review.",
      {
        document_id: id,
      }
    );
  }

  return pass(row);
}

function validateDocumentStillEligibleForApproval(documentRow) {
  if (documentRow.status !== "active") {
    return fail(
      "access_request_review_document_not_active",
      "Document must remain active before the request can be approved for licence preparation.",
      {
        document_id: documentRow.id,
        status: documentRow.status,
      }
    );
  }

  if (Number(documentRow.is_listed ?? 0) !== 1) {
    return fail(
      "access_request_review_document_not_listed",
      "Document must remain listed before the request can be approved for licence preparation.",
      {
        document_id: documentRow.id,
        is_listed: documentRow.is_listed,
      }
    );
  }

  if (
    cleanText(documentRow.requestability_status || "not_requestable") !==
    "requestable_with_approval"
  ) {
    return fail(
      "access_request_review_document_not_requestable",
      "Document must remain requestable with approval before the request can be approved for licence preparation.",
      {
        document_id: documentRow.id,
        requestability_status:
          documentRow.requestability_status || "not_requestable",
      }
    );
  }

  if (Number(documentRow.requires_approval ?? 1) !== 1) {
    return fail(
      "access_request_review_document_does_not_require_approval",
      "Document must retain requires_approval = 1 before approval.",
      {
        document_id: documentRow.id,
        requires_approval: documentRow.requires_approval,
      }
    );
  }

  if (!cleanText(documentRow.source_object)) {
    return fail(
      "access_request_review_source_object_missing",
      "Document source object is missing.",
      {
        document_id: documentRow.id,
      }
    );
  }

  if (!cleanText(documentRow.source_sha256)) {
    return fail(
      "access_request_review_source_sha256_missing",
      "Document source SHA-256 evidence is missing.",
      {
        document_id: documentRow.id,
      }
    );
  }

  if (!cleanText(documentRow.licence_terms_version)) {
    return fail(
      "access_request_review_terms_version_missing",
      "Document licence terms version is missing.",
      {
        document_id: documentRow.id,
      }
    );
  }

  return pass(true);
}

async function updateDocumentAccessRequestReviewState(
  env,
  options = {}
) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_review_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const action = cleanText(options.action);
  const outcome = options.outcome || {};
  const actor = nullableText(options.actor);
  const note = nullableText(options.note);
  const reason = nullableText(options.reason);

  if (action === "hold") {
    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET status = ?,
           request_review_status = ?,
           approval_note = ?
       WHERE id = ?`
    )
      .bind(
        outcome.new_status,
        outcome.request_review_status,
        note,
        options.requestId
      )
      .run();
  } else if (action === "reject") {
    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET status = ?,
           request_review_status = ?,
           denied_at = ?,
           denied_by = ?,
           denial_reason = ?,
           approval_note = ?
       WHERE id = ?`
    )
      .bind(
        outcome.new_status,
        outcome.request_review_status,
        eventAt,
        actor,
        reason || note,
        note,
        options.requestId
      )
      .run();
  } else {
    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET status = ?,
           request_review_status = ?,
           approved_at = ?,
           approved_by = ?,
           approval_role = ?,
           approval_policy_version = ?,
           approval_note = ?
       WHERE id = ?`
    )
      .bind(
        outcome.new_status,
        outcome.request_review_status,
        eventAt,
        actor,
        outcome.approval_role || "cdas_upload_gate",
        outcome.approval_policy_version || "U3-Q",
        note,
        options.requestId
      )
      .run();
  }

  return pass({
    request_id: options.requestId,
    action,
    previous_status: outcome.previous_status,
    new_status: outcome.new_status,
    request_review_status: outcome.request_review_status,
    updated_at: eventAt,
  });
}

async function insertDocumentAccessRequestReviewEvent(env, options = {}) {
  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "access_request_review_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const id = options.id || buildDocumentAccessRequestReviewEventId();
  const eventAt = cleanText(options.eventAt || nowIso());

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_access_request_review_events (
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.requestId,
      options.eventType,
      options.previousStatus || null,
      options.newStatus || null,
      nullableText(options.actor),
      nullableText(options.reason),
      nullableText(options.note),
      JSON.stringify(options.metadata || {}),
      eventAt
    )
    .run();

  return pass({
    id,
    request_id: options.requestId,
    event_type: options.eventType,
    previous_status: options.previousStatus || null,
    new_status: options.newStatus || null,
    actor: nullableText(options.actor),
    reason: nullableText(options.reason),
    note: nullableText(options.note),
    metadata: options.metadata || {},
    created_at: eventAt,
  });
}
