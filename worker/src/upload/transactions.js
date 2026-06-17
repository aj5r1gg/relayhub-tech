const VALID_UPLOAD_DOMAINS = new Set([
  "cdas_document",
  "private_file",
]);

const VALID_UPLOAD_STATUSES = new Set([
  "started",
  "validating",
  "blocked",
  "uploading",
  "r2_written",
  "hash_calculated",
  "d1_record_created",
  "sidecar_written",
  "audit_recorded",
  "completed",
  "completed_with_warning",
  "failed",
  "abandoned",
  "recovery_required",
  "recovered",
]);

const VALID_RECOVERY_STATUSES = new Set([
  "none",
  "not_required",
  "required",
  "in_progress",
  "recovered",
  "abandoned",
  "manual_review",
  "unrecoverable",
]);

const TERMINAL_UPLOAD_STATUSES = new Set([
  "completed",
  "completed_with_warning",
  "failed",
  "abandoned",
  "recovery_required",
  "recovered",
]);

const R2_WRITTEN_OR_LATER_STATUSES = new Set([
  "r2_written",
  "hash_calculated",
  "d1_record_created",
  "sidecar_written",
  "audit_recorded",
  "completed",
  "completed_with_warning",
  "recovery_required",
  "recovered",
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

function fail(error, message, details = {}) {
  return {
    ok: false,
    error,
    message,
    details,
    warnings: [],
  };
}

function pass(value, warnings = []) {
  return {
    ok: true,
    value,
    warnings,
  };
}

function nowIso() {
  return new Date().toISOString();
}

export function buildUploadTransactionId(options = {}) {
  const prefix = cleanText(options.prefix || "upl");
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `${prefix}_${random.replaceAll("-", "")}`;
}

export function validateUploadDomain(domain) {
  const cleanDomain = cleanText(domain);

  if (!VALID_UPLOAD_DOMAINS.has(cleanDomain)) {
    return fail(
      "upload_transaction_invalid_domain",
      "Upload transaction domain is not recognised.",
      { domain: cleanDomain }
    );
  }

  return pass(cleanDomain);
}

export function validateUploadStatus(status) {
  const cleanStatus = cleanText(status);

  if (!VALID_UPLOAD_STATUSES.has(cleanStatus)) {
    return fail(
      "upload_transaction_invalid_status",
      "Upload transaction status is not recognised.",
      { status: cleanStatus }
    );
  }

  return pass(cleanStatus);
}

export function validateRecoveryStatus(status) {
  const cleanStatus = cleanText(status || "none");

  if (!VALID_RECOVERY_STATUSES.has(cleanStatus)) {
    return fail(
      "upload_transaction_invalid_recovery_status",
      "Upload transaction recovery status is not recognised.",
      { recovery_status: cleanStatus }
    );
  }

  return pass(cleanStatus);
}

export function classifyUploadFailureStage(status) {
  const cleanStatus = cleanText(status);

  if (!cleanStatus) {
    return pass({
      failure_stage: null,
      recovery_status: "manual_review",
      r2_may_have_been_written: null,
    });
  }

  if (R2_WRITTEN_OR_LATER_STATUSES.has(cleanStatus)) {
    return pass({
      failure_stage: cleanStatus,
      recovery_status: "required",
      r2_may_have_been_written: true,
    });
  }

  return pass({
    failure_stage: cleanStatus,
    recovery_status: "not_required",
    r2_may_have_been_written: false,
  });
}

export function buildUploadTransactionRecord(options = {}) {
  const domainResult = validateUploadDomain(options.uploadDomain);

  if (!domainResult.ok) {
    return domainResult;
  }

  const statusResult = validateUploadStatus(options.uploadStatus || "started");

  if (!statusResult.ok) {
    return statusResult;
  }

  const recoveryResult = validateRecoveryStatus(options.recoveryStatus || "none");

  if (!recoveryResult.ok) {
    return recoveryResult;
  }

  const startedAt = cleanText(options.startedAt || nowIso());

  const record = {
    id: cleanText(options.id || buildUploadTransactionId()),

    upload_domain: domainResult.value,

    related_record_type: nullableText(options.relatedRecordType),
    related_record_id: nullableText(options.relatedRecordId),

    upload_status: statusResult.value,

    original_filename: nullableText(options.originalFilename),
    safe_filename: nullableText(options.safeFilename),
    mime_type: nullableText(options.mimeType),
    file_extension: nullableText(options.fileExtension),

    source_size: nullableNumber(options.sourceSize),
    source_sha256: nullableText(options.sourceSha256),

    selected_prefix_id: nullableText(options.selectedPrefixId),
    selected_prefix: nullableText(options.selectedPrefix),

    intended_object_key: nullableText(options.intendedObjectKey),
    final_object_key: nullableText(options.finalObjectKey),

    r2_written_at: nullableText(options.r2WrittenAt),
    r2_readback_checked_at: nullableText(options.r2ReadbackCheckedAt),
    hash_calculated_at: nullableText(options.hashCalculatedAt),
    d1_record_created_at: nullableText(options.d1RecordCreatedAt),
    sidecar_written_at: nullableText(options.sidecarWrittenAt),
    audit_recorded_at: nullableText(options.auditRecordedAt),

    started_at: startedAt,
    completed_at: nullableText(options.completedAt),
    failed_at: nullableText(options.failedAt),
    abandoned_at: nullableText(options.abandonedAt),

    recovery_status: recoveryResult.value,

    failure_stage: nullableText(options.failureStage),
    failure_reason: nullableText(options.failureReason),

    admin_actor: nullableText(options.adminActor),
    user_agent: nullableText(options.userAgent),
    ip_hash: nullableText(options.ipHash),
    request_id: nullableText(options.requestId),

    idempotency_key_hash: nullableText(options.idempotencyKeyHash),
    idempotency_expires_at: nullableText(options.idempotencyExpiresAt),

    notes: nullableText(options.notes),
  };

  return pass(record);
}

export async function createUploadTransaction(env, options = {}) {
  if (!env?.DB?.prepare) {
    return fail(
      "upload_transaction_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const recordResult = buildUploadTransactionRecord(options);

  if (!recordResult.ok) {
    return recordResult;
  }

  const record = recordResult.value;

  await env.DB.prepare(
    `INSERT INTO upload_transactions (
       id,
       upload_domain,
       related_record_type,
       related_record_id,
       upload_status,
       original_filename,
       safe_filename,
       mime_type,
       file_extension,
       source_size,
       source_sha256,
       selected_prefix_id,
       selected_prefix,
       intended_object_key,
       final_object_key,
       r2_written_at,
       r2_readback_checked_at,
       hash_calculated_at,
       d1_record_created_at,
       sidecar_written_at,
       audit_recorded_at,
       started_at,
       completed_at,
       failed_at,
       abandoned_at,
       recovery_status,
       failure_stage,
       failure_reason,
       admin_actor,
       user_agent,
       ip_hash,
       request_id,
       idempotency_key_hash,
       idempotency_expires_at,
       notes
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     )`
  )
    .bind(
      record.id,
      record.upload_domain,
      record.related_record_type,
      record.related_record_id,
      record.upload_status,
      record.original_filename,
      record.safe_filename,
      record.mime_type,
      record.file_extension,
      record.source_size,
      record.source_sha256,
      record.selected_prefix_id,
      record.selected_prefix,
      record.intended_object_key,
      record.final_object_key,
      record.r2_written_at,
      record.r2_readback_checked_at,
      record.hash_calculated_at,
      record.d1_record_created_at,
      record.sidecar_written_at,
      record.audit_recorded_at,
      record.started_at,
      record.completed_at,
      record.failed_at,
      record.abandoned_at,
      record.recovery_status,
      record.failure_stage,
      record.failure_reason,
      record.admin_actor,
      record.user_agent,
      record.ip_hash,
      record.request_id,
      record.idempotency_key_hash,
      record.idempotency_expires_at,
      record.notes
    )
    .run();

  return pass(record);
}

export async function getUploadTransactionById(env, id) {
  const cleanId = cleanText(id);

  if (!cleanId) {
    return fail(
      "upload_transaction_id_missing",
      "Upload transaction ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_transaction_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       upload_domain,
       related_record_type,
       related_record_id,
       upload_status,
       original_filename,
       safe_filename,
       mime_type,
       file_extension,
       source_size,
       source_sha256,
       selected_prefix_id,
       selected_prefix,
       intended_object_key,
       final_object_key,
       r2_written_at,
       r2_readback_checked_at,
       hash_calculated_at,
       d1_record_created_at,
       sidecar_written_at,
       audit_recorded_at,
       started_at,
       completed_at,
       failed_at,
       abandoned_at,
       recovery_status,
       failure_stage,
       failure_reason,
       admin_actor,
       user_agent,
       ip_hash,
       request_id,
       idempotency_key_hash,
       idempotency_expires_at,
       notes
     FROM upload_transactions
     WHERE id = ?`
  )
    .bind(cleanId)
    .first();

  if (!row) {
    return fail(
      "upload_transaction_not_found",
      "Upload transaction could not be found.",
      { id: cleanId }
    );
  }

  return pass(row);
}

export async function updateUploadTransactionStatus(env, options = {}) {
  const id = cleanText(options.id);
  const statusResult = validateUploadStatus(options.uploadStatus);

  if (!id) {
    return fail(
      "upload_transaction_id_missing",
      "Upload transaction ID is required."
    );
  }

  if (!statusResult.ok) {
    return statusResult;
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_transaction_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const status = statusResult.value;
  const eventAt = cleanText(options.eventAt || nowIso());

  const updates = {
    upload_status: status,
  };

  if (status === "r2_written") {
    updates.r2_written_at = eventAt;
  }

  if (status === "hash_calculated") {
    updates.hash_calculated_at = eventAt;
  }

  if (status === "d1_record_created") {
    updates.d1_record_created_at = eventAt;
  }

  if (status === "sidecar_written") {
    updates.sidecar_written_at = eventAt;
  }

  if (status === "audit_recorded") {
    updates.audit_recorded_at = eventAt;
  }

  if (status === "completed" || status === "completed_with_warning") {
    updates.completed_at = eventAt;
    updates.recovery_status = "not_required";
  }

  if (status === "abandoned") {
    updates.abandoned_at = eventAt;
    updates.recovery_status = "abandoned";
  }

  if (status === "recovery_required") {
    updates.recovery_status = "required";
  }

  if (status === "recovered") {
    updates.recovery_status = "recovered";
  }

  const setColumns = Object.keys(updates);
  const setSql = setColumns.map((column) => `${column} = ?`).join(", ");
  const values = setColumns.map((column) => updates[column]);

  await env.DB.prepare(
    `UPDATE upload_transactions
     SET ${setSql}
     WHERE id = ?`
  )
    .bind(...values, id)
    .run();

  return pass({
    id,
    upload_status: status,
    event_at: eventAt,
    updates,
  });
}

export async function attachUploadTransactionEvidence(env, options = {}) {
  const id = cleanText(options.id);

  if (!id) {
    return fail(
      "upload_transaction_id_missing",
      "Upload transaction ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_transaction_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());

  await env.DB.prepare(
    `UPDATE upload_transactions
     SET
       original_filename = COALESCE(?, original_filename),
       safe_filename = COALESCE(?, safe_filename),
       mime_type = COALESCE(?, mime_type),
       file_extension = COALESCE(?, file_extension),
       source_size = COALESCE(?, source_size),
       source_sha256 = COALESCE(?, source_sha256),
       hash_calculated_at = COALESCE(hash_calculated_at, ?),
       upload_status = CASE
         WHEN upload_status IN ('started', 'validating', 'uploading')
         THEN 'hash_calculated'
         ELSE upload_status
       END
     WHERE id = ?`
  )
    .bind(
      nullableText(options.originalFilename),
      nullableText(options.safeFilename),
      nullableText(options.mimeType),
      nullableText(options.fileExtension),
      nullableNumber(options.sourceSize),
      nullableText(options.sourceSha256),
      eventAt,
      id
    )
    .run();

  return pass({
    id,
    evidence_attached: true,
    event_at: eventAt,
  });
}

export async function attachUploadTransactionObjectKeys(env, options = {}) {
  const id = cleanText(options.id);

  if (!id) {
    return fail(
      "upload_transaction_id_missing",
      "Upload transaction ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_transaction_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  await env.DB.prepare(
    `UPDATE upload_transactions
     SET
       selected_prefix_id = COALESCE(?, selected_prefix_id),
       selected_prefix = COALESCE(?, selected_prefix),
       intended_object_key = COALESCE(?, intended_object_key),
       final_object_key = COALESCE(?, final_object_key)
     WHERE id = ?`
  )
    .bind(
      nullableText(options.selectedPrefixId),
      nullableText(options.selectedPrefix),
      nullableText(options.intendedObjectKey),
      nullableText(options.finalObjectKey),
      id
    )
    .run();

  return pass({
    id,
    object_keys_attached: true,
  });
}

export async function failUploadTransaction(env, options = {}) {
  const id = cleanText(options.id);

  if (!id) {
    return fail(
      "upload_transaction_id_missing",
      "Upload transaction ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_transaction_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const failedAt = cleanText(options.failedAt || options.eventAt || nowIso());
  const failureStage = cleanText(options.failureStage || options.currentStatus);
  const failureReason = cleanText(options.failureReason || "Upload transaction failed.");

  const classification = classifyUploadFailureStage(failureStage);

  if (!classification.ok) {
    return classification;
  }

  const recoveryStatus = cleanText(
    options.recoveryStatus || classification.value.recovery_status
  );

  const recoveryResult = validateRecoveryStatus(recoveryStatus);

  if (!recoveryResult.ok) {
    return recoveryResult;
  }

  const uploadStatus =
    recoveryResult.value === "required" || recoveryResult.value === "manual_review"
      ? "recovery_required"
      : "failed";

  await env.DB.prepare(
    `UPDATE upload_transactions
     SET
       upload_status = ?,
       failed_at = ?,
       recovery_status = ?,
       failure_stage = ?,
       failure_reason = ?
     WHERE id = ?`
  )
    .bind(
      uploadStatus,
      failedAt,
      recoveryResult.value,
      failureStage || null,
      failureReason,
      id
    )
    .run();

  return pass({
    id,
    upload_status: uploadStatus,
    failed_at: failedAt,
    recovery_status: recoveryResult.value,
    failure_stage: failureStage || null,
    failure_reason: failureReason,
    r2_may_have_been_written: classification.value.r2_may_have_been_written,
  });
}

export async function completeUploadTransaction(env, options = {}) {
  const id = cleanText(options.id);

  if (!id) {
    return fail(
      "upload_transaction_id_missing",
      "Upload transaction ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_transaction_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const completedAt = cleanText(options.completedAt || options.eventAt || nowIso());
  const hasWarnings = Array.isArray(options.warnings) && options.warnings.length > 0;
  const status = hasWarnings ? "completed_with_warning" : "completed";

  await env.DB.prepare(
    `UPDATE upload_transactions
     SET
       upload_status = ?,
       completed_at = ?,
       recovery_status = 'not_required',
       notes = COALESCE(?, notes)
     WHERE id = ?`
  )
    .bind(
      status,
      completedAt,
      options.notes ? cleanText(options.notes) : null,
      id
    )
    .run();

  return pass({
    id,
    upload_status: status,
    completed_at: completedAt,
    recovery_status: "not_required",
    warnings: options.warnings || [],
  });
}

export function isUploadTransactionTerminal(status) {
  return TERMINAL_UPLOAD_STATUSES.has(cleanText(status));
}

export const uploadTransactionPolicy = {
  validUploadDomains: Array.from(VALID_UPLOAD_DOMAINS),
  validUploadStatuses: Array.from(VALID_UPLOAD_STATUSES),
  validRecoveryStatuses: Array.from(VALID_RECOVERY_STATUSES),
  terminalUploadStatuses: Array.from(TERMINAL_UPLOAD_STATUSES),
  r2WrittenOrLaterStatuses: Array.from(R2_WRITTEN_OR_LATER_STATUSES),
  writesR2: false,
  createsRoutes: false,
  publishesDocuments: false,
  createsLicences: false,
  createsDownloadLinks: false,
  sendsEmail: false,
};
