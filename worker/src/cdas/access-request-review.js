import { jsonResponse, methodNotAllowed } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function makeReviewEventId() {
  return `dar_rev_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function getAccessRequest(env, requestId) {
  return env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`
  )
    .bind(requestId)
    .first();
}

async function countLicencesForRequest(env, requestId) {
  const row = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM document_licences
     WHERE request_id = ?`
  )
    .bind(requestId)
    .first();

  return Number(row?.total || 0);
}

async function countDownloadLinksForRequest(env, requestId) {
  const row = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM document_download_links dl
     INNER JOIN document_licences l
       ON l.id = dl.licence_id
     WHERE l.request_id = ?`
  )
    .bind(requestId)
    .first();

  return Number(row?.total || 0);
}

async function recordReviewEvent(env, {
  requestId,
  eventType,
  previousStatus,
  newStatus,
  actor,
  reason,
  note,
  metadata,
}) {
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
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      makeReviewEventId(),
      requestId,
      eventType,
      previousStatus || null,
      newStatus || null,
      actor || null,
      reason || null,
      note || null,
      JSON.stringify(metadata || {}),
      nowIso()
    )
    .run();
}

function blocked(message, extra = {}, status = 409) {
  return jsonResponse(
    {
      ok: false,
      error: extra.error || "review_action_blocked",
      message,
      ...extra,
    },
    status
  );
}

function normaliseAction(value) {
  const action = cleanText(value).toLowerCase();

  if (["hold", "held", "on_hold"].includes(action)) return "hold";
  if (["reject", "rejected", "deny", "denied"].includes(action)) return "reject";
  if (
    [
      "approve_review",
      "review_approve",
      "review_approved",
      "approve-for-review",
      "approve_for_licence",
    ].includes(action)
  ) {
    return "approve_review";
  }
  if (["note", "add_note", "note_added"].includes(action)) return "note";

  return action;
}

function isReviewableStatus(status) {
  return [
    "pending_review",
    "email_pending",
    "approval_pending",
    "on_hold",
  ].includes(cleanText(status));
}

async function applyHold({ env, accessRequest, actor, reason, note, licenceCount, downloadLinkCount }) {
  if (!isReviewableStatus(accessRequest.status)) {
    return blocked("Only reviewable requests can be placed on hold.", {
      request_id: accessRequest.id,
      current_status: accessRequest.status,
    });
  }

  if (licenceCount > 0 || downloadLinkCount > 0) {
    return blocked("This request already has downstream records and cannot be held by this control.", {
      request_id: accessRequest.id,
      licence_count: licenceCount,
      download_link_count: downloadLinkCount,
    });
  }

  const previousStatus = accessRequest.status;
  const newStatus = "on_hold";
  const timestamp = nowIso();

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       status = ?,
       approval_note = ?,
       approval_policy_version = ?
     WHERE id = ?`
  )
    .bind(
      newStatus,
      note || reason || "Placed on hold during manual review.",
      "3X-0H",
      accessRequest.id
    )
    .run();

  await recordReviewEvent(env, {
    requestId: accessRequest.id,
    eventType: "held",
    previousStatus,
    newStatus,
    actor,
    reason,
    note,
    metadata: {
      phase: "3X-0H",
      reviewed_at: timestamp,
      licence_count: licenceCount,
      download_link_count: downloadLinkCount,
    },
  });

  return jsonResponse({
    ok: true,
    action: "hold",
    request_id: accessRequest.id,
    previous_status: previousStatus,
    new_status: newStatus,
    licence_count: licenceCount,
    download_link_count: downloadLinkCount,
  });
}

async function applyReject({ env, accessRequest, actor, reason, note, licenceCount, downloadLinkCount }) {
  if (!isReviewableStatus(accessRequest.status)) {
    return blocked("Only reviewable requests can be rejected by this control.", {
      request_id: accessRequest.id,
      current_status: accessRequest.status,
    });
  }

  if (licenceCount > 0 || downloadLinkCount > 0) {
    return blocked("This request already has downstream records and cannot be rejected by this control.", {
      request_id: accessRequest.id,
      licence_count: licenceCount,
      download_link_count: downloadLinkCount,
    });
  }

  const previousStatus = accessRequest.status;
  const newStatus = "rejected";
  const timestamp = nowIso();

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       status = ?,
       denied_at = ?,
       denied_by = ?,
       denial_reason = ?
     WHERE id = ?`
  )
    .bind(
      newStatus,
      timestamp,
      actor || "admin",
      reason || note || "Rejected during manual review.",
      accessRequest.id
    )
    .run();

  await recordReviewEvent(env, {
    requestId: accessRequest.id,
    eventType: "rejected",
    previousStatus,
    newStatus,
    actor,
    reason,
    note,
    metadata: {
      phase: "3X-0H",
      reviewed_at: timestamp,
      licence_count: licenceCount,
      download_link_count: downloadLinkCount,
    },
  });

  return jsonResponse({
    ok: true,
    action: "reject",
    request_id: accessRequest.id,
    previous_status: previousStatus,
    new_status: newStatus,
    licence_count: licenceCount,
    download_link_count: downloadLinkCount,
  });
}

async function applyApproveReview({ env, accessRequest, actor, reason, note, licenceCount, downloadLinkCount }) {
  if (!isReviewableStatus(accessRequest.status)) {
    return blocked("Only reviewable requests can be approved for the next manual step.", {
      request_id: accessRequest.id,
      current_status: accessRequest.status,
    });
  }

  if (licenceCount > 0 || downloadLinkCount > 0) {
    return blocked("This request already has downstream records and cannot be approved by this control.", {
      request_id: accessRequest.id,
      licence_count: licenceCount,
      download_link_count: downloadLinkCount,
    });
  }

  if (!accessRequest.email_verified_at) {
    return blocked("Email verification is required before this request can be approved for the next manual step.", {
      error: "email_not_verified",
      request_id: accessRequest.id,
      current_status: accessRequest.status,
    });
  }

  if (!accessRequest.terms_accepted_at) {
    return blocked("Accepted licence terms are required before this request can be approved for the next manual step.", {
      error: "terms_not_accepted",
      request_id: accessRequest.id,
      current_status: accessRequest.status,
    });
  }

  const previousStatus = accessRequest.status;
  const newStatus = "review_approved";
  const timestamp = nowIso();

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET
       status = ?,
       approved_at = ?,
       approved_by = ?,
       approval_role = ?,
       approval_policy_version = ?,
       approval_note = ?
     WHERE id = ?`
  )
    .bind(
      newStatus,
      timestamp,
      actor || "admin",
      "manual_review",
      "3X-0H",
      note || reason || "Approved during manual review. Licence issue remains a separate manual step.",
      accessRequest.id
    )
    .run();

  await recordReviewEvent(env, {
    requestId: accessRequest.id,
    eventType: "review_approved",
    previousStatus,
    newStatus,
    actor,
    reason,
    note,
    metadata: {
      phase: "3X-0H",
      reviewed_at: timestamp,
      licence_count: licenceCount,
      download_link_count: downloadLinkCount,
      automatic_licence_issue: 0,
      automatic_download_link_issue: 0,
    },
  });

  return jsonResponse({
    ok: true,
    action: "approve_review",
    request_id: accessRequest.id,
    previous_status: previousStatus,
    new_status: newStatus,
    licence_count: licenceCount,
    download_link_count: downloadLinkCount,
    next_manual_step: "issue_licence",
  });
}

async function applyNote({ env, accessRequest, actor, reason, note, licenceCount, downloadLinkCount }) {
  await recordReviewEvent(env, {
    requestId: accessRequest.id,
    eventType: "note_added",
    previousStatus: accessRequest.status,
    newStatus: accessRequest.status,
    actor,
    reason,
    note,
    metadata: {
      phase: "3X-0H",
      licence_count: licenceCount,
      download_link_count: downloadLinkCount,
    },
  });

  return jsonResponse({
    ok: true,
    action: "note",
    request_id: accessRequest.id,
    previous_status: accessRequest.status,
    new_status: accessRequest.status,
    licence_count: licenceCount,
    download_link_count: downloadLinkCount,
  });
}

export async function reviewCdasAccessRequest(request, env, requestId) {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const cleanRequestId = cleanText(requestId);

  if (!cleanRequestId) {
    return jsonResponse(
      {
        ok: false,
        error: "request_id_required",
        message: "Request ID is required.",
      },
      400
    );
  }

  const body = await readJsonBody(request);

  if (!body || typeof body !== "object") {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_json_body",
        message: "Expected a JSON request body.",
      },
      400
    );
  }

  const action = normaliseAction(body.action);
  const actor = cleanText(body.actor) || "admin";
  const reason = cleanText(body.reason);
  const note = cleanText(body.note);

  if (!["hold", "reject", "approve_review", "note"].includes(action)) {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_review_action",
        message: "Action must be one of: hold, reject, approve_review, note.",
      },
      400
    );
  }

  const accessRequest = await getAccessRequest(env, cleanRequestId);

  if (!accessRequest) {
    return jsonResponse(
      {
        ok: false,
        error: "access_request_not_found",
        message: "Access request was not found.",
      },
      404
    );
  }

  const licenceCount = await countLicencesForRequest(env, cleanRequestId);
  const downloadLinkCount = await countDownloadLinksForRequest(env, cleanRequestId);

  if (action === "hold") {
    return applyHold({
      env,
      accessRequest,
      actor,
      reason,
      note,
      licenceCount,
      downloadLinkCount,
    });
  }

  if (action === "reject") {
    return applyReject({
      env,
      accessRequest,
      actor,
      reason,
      note,
      licenceCount,
      downloadLinkCount,
    });
  }

  if (action === "approve_review") {
    return applyApproveReview({
      env,
      accessRequest,
      actor,
      reason,
      note,
      licenceCount,
      downloadLinkCount,
    });
  }

  return applyNote({
    env,
    accessRequest,
    actor,
    reason,
    note,
    licenceCount,
    downloadLinkCount,
  });
}