import {
  attachUploadTransactionEvidence,
  attachUploadTransactionObjectKeys,
  completeUploadTransaction,
  failUploadTransaction,
  updateUploadTransactionStatus,
} from "./transactions.js";

import {
  writeUploadObjectsToR2,
} from "./r2-write.js";

import {
  writeUploadAdminAuditEvent,
} from "./audit.js";

function cleanText(value) {
  return String(value ?? "").trim();
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

function normaliseObjectKeys(objectKeys = {}) {
  return {
    source: cleanText(objectKeys.source || objectKeys.source_object_key),
    sha256: cleanText(objectKeys.sha256 || objectKeys.sha256_object_key),
    metadata: cleanText(objectKeys.metadata || objectKeys.metadata_object_key),
  };
}

function stageFailureStage(stage, fallback = "uploading") {
  const cleanStage = cleanText(stage);

  if (cleanStage) {
    return cleanStage;
  }

  return fallback;
}

function shouldAttemptAudit(env, request, options = {}) {
  if (options.audit === false || options.skipAudit === true) {
    return false;
  }

  return Boolean(env?.DB?.prepare && request);
}

async function safeAudit(env, request, event = {}) {
  if (!shouldAttemptAudit(env, request, event)) {
    return pass({
      recorded: false,
      reason: "audit_skipped",
    });
  }

  const auditResult = await writeUploadAdminAuditEvent(env, request, event);

  if (!auditResult.ok) {
    return auditResult;
  }

  return auditResult;
}

export function validateUploadWriteOrchestrationInputs(options = {}) {
  const uploadTransactionId = cleanText(options.uploadTransactionId);
  const uploadDomain = cleanText(options.uploadDomain);
  const objectKeys = normaliseObjectKeys(options.objectKeys || {});

  if (!uploadTransactionId) {
    return fail(
      "upload_orchestrator_transaction_id_missing",
      "Upload transaction ID is required."
    );
  }

  if (!uploadDomain) {
    return fail(
      "upload_orchestrator_domain_missing",
      "Upload domain is required."
    );
  }

  if (!objectKeys.source || !objectKeys.sha256 || !objectKeys.metadata) {
    return fail(
      "upload_orchestrator_object_keys_missing",
      "Source, SHA-256 sidecar, and metadata object keys are required.",
      { object_keys: objectKeys }
    );
  }

  if (!options.bytes) {
    return fail(
      "upload_orchestrator_source_bytes_missing",
      "Source bytes are required."
    );
  }

  if (!cleanText(options.sourceSha256)) {
    return fail(
      "upload_orchestrator_source_sha256_missing",
      "Source SHA-256 is required."
    );
  }

  if (options.sourceSize === undefined || options.sourceSize === null) {
    return fail(
      "upload_orchestrator_source_size_missing",
      "Source size is required."
    );
  }

  return pass({
    upload_transaction_id: uploadTransactionId,
    upload_domain: uploadDomain,
    object_keys: objectKeys,
  });
}

export function buildUploadWriteAuditEvent(eventType, options = {}) {
  const objectKeys = normaliseObjectKeys(options.objectKeys || {});
  const success = options.success === undefined ? true : Boolean(options.success);

  return {
    eventType: cleanText(eventType),
    uploadDomain: cleanText(options.uploadDomain),
    uploadTransactionId: cleanText(options.uploadTransactionId),
    relatedRecordType: cleanText(options.relatedRecordType),
    relatedRecordId: cleanText(options.relatedRecordId),
    storagePrefixId: cleanText(options.storagePrefixId),
    storagePrefix: cleanText(options.storagePrefix),
    objectKey: objectKeys.source,
    sourceSha256: cleanText(options.sourceSha256),
    sourceSize: options.sourceSize,
    targetType: "upload_transaction",
    targetId: cleanText(options.uploadTransactionId),
    success,
    failureStage: cleanText(options.failureStage),
    failureReason: cleanText(options.failureReason),
    recoveryRequired: Boolean(options.recoveryRequired),
    metadata: options.metadata || null,
    warnings: options.warnings || [],
    createdAt: cleanText(options.eventAt || nowIso()),
  };
}

export async function orchestrateUploadR2Write(env = {}, request, options = {}) {
  const inputResult = validateUploadWriteOrchestrationInputs(options);

  if (!inputResult.ok) {
    return inputResult;
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const objectKeys = inputResult.value.object_keys;
  const uploadTransactionId = inputResult.value.upload_transaction_id;

  const stageResults = [];

  async function runStage(stage, fn) {
    const result = await fn();
    stageResults.push({
      stage,
      ok: result?.ok === true,
      result,
    });

    return result;
  }

  const validatingStatus = await runStage("transaction_validating", () =>
    updateUploadTransactionStatus(env, {
      id: uploadTransactionId,
      uploadStatus: "validating",
      eventAt,
    })
  );

  if (!validatingStatus.ok) {
    return validatingStatus;
  }

  const objectKeyAttachment = await runStage("transaction_object_keys_attached", () =>
    attachUploadTransactionObjectKeys(env, {
      id: uploadTransactionId,
      selectedPrefixId: options.storagePrefixId,
      selectedPrefix: options.storagePrefix,
      intendedObjectKey: objectKeys.source,
      finalObjectKey: objectKeys.source,
    })
  );

  if (!objectKeyAttachment.ok) {
    return objectKeyAttachment;
  }

  const evidenceAttachment = await runStage("transaction_evidence_attached", () =>
    attachUploadTransactionEvidence(env, {
      id: uploadTransactionId,
      originalFilename: options.originalFilename,
      safeFilename: options.safeFilename,
      mimeType: options.mimeType || "application/pdf",
      fileExtension: options.fileExtension || "pdf",
      sourceSize: options.sourceSize,
      sourceSha256: options.sourceSha256,
      eventAt,
    })
  );

  if (!evidenceAttachment.ok) {
    return evidenceAttachment;
  }

  const uploadingStatus = await runStage("transaction_uploading", () =>
    updateUploadTransactionStatus(env, {
      id: uploadTransactionId,
      uploadStatus: "uploading",
      eventAt,
    })
  );

  if (!uploadingStatus.ok) {
    return uploadingStatus;
  }

  const writeResult = await runStage("r2_write", () =>
    writeUploadObjectsToR2(env, {
      ...options,
      objectKeys,
      writtenAt: eventAt,
    })
  );

  if (!writeResult.ok) {
    const recoveryRequired = Boolean(writeResult.details?.recovery_required);
    const failureStage = recoveryRequired
      ? "r2_written"
      : stageFailureStage(options.failureStage, "uploading");

    const failedTransaction = await runStage("transaction_failed", () =>
      failUploadTransaction(env, {
        id: uploadTransactionId,
        eventAt,
        currentStatus: failureStage,
        failureStage,
        failureReason: writeResult.message,
        recoveryStatus: recoveryRequired ? "required" : undefined,
      })
    );

    const auditResult = await safeAudit(
      env,
      request,
      buildUploadWriteAuditEvent("upload_r2_write_failed", {
        ...options,
        objectKeys,
        success: false,
        failureStage,
        failureReason: writeResult.message,
        recoveryRequired,
        eventAt,
        metadata: {
          write_error: writeResult.error,
          write_details: writeResult.details || {},
          failed_transaction: failedTransaction.ok ? failedTransaction.value : null,
        },
      })
    );

    return {
      ok: false,
      error: "upload_r2_write_orchestration_failed",
      message: "Upload R2 write orchestration failed.",
      details: {
        upload_transaction_id: uploadTransactionId,
        failure_stage: failureStage,
        recovery_required: recoveryRequired,
        write_error: writeResult.error,
        write_message: writeResult.message,
        write_details: writeResult.details || {},
        transaction_failure_recorded: failedTransaction.ok === true,
        audit_recorded: auditResult.value?.recorded === true,
        audit_result: auditResult,
        stage_results: stageResults,
      },
      warnings: auditResult.warnings || [],
    };
  }

  const r2WrittenStatus = await runStage("transaction_r2_written", () =>
    updateUploadTransactionStatus(env, {
      id: uploadTransactionId,
      uploadStatus: "r2_written",
      eventAt,
    })
  );

  if (!r2WrittenStatus.ok) {
    return r2WrittenStatus;
  }

  const sidecarWrittenStatus = await runStage("transaction_sidecar_written", () =>
    updateUploadTransactionStatus(env, {
      id: uploadTransactionId,
      uploadStatus: "sidecar_written",
      eventAt,
    })
  );

  if (!sidecarWrittenStatus.ok) {
    return sidecarWrittenStatus;
  }

  const completeResult = await runStage("transaction_completed", () =>
    completeUploadTransaction(env, {
      id: uploadTransactionId,
      eventAt,
      warnings: writeResult.warnings || [],
      notes: options.notes,
    })
  );

  if (!completeResult.ok) {
    return completeResult;
  }

  const auditResult = await runStage("audit_recorded", () =>
    safeAudit(
      env,
      request,
      buildUploadWriteAuditEvent("upload_r2_write_completed", {
        ...options,
        objectKeys,
        success: true,
        recoveryRequired: false,
        eventAt,
        metadata: {
          r2_write: writeResult.value,
          completed_transaction: completeResult.value,
        },
      })
    )
  );

  if (auditResult.ok && auditResult.value?.recorded === true) {
    await runStage("transaction_audit_recorded", () =>
      updateUploadTransactionStatus(env, {
        id: uploadTransactionId,
        uploadStatus: "audit_recorded",
        eventAt,
      })
    );
  }

  return pass(
    {
      upload_transaction_id: uploadTransactionId,
      upload_status: completeResult.value.upload_status,
      recovery_required: false,
      r2_write: writeResult.value,
      audit_recorded: auditResult.value?.recorded === true,
      audit_result: auditResult,
      stage_results: stageResults,
    },
    [
      ...(writeResult.warnings || []),
      ...(auditResult.warnings || []),
    ]
  );
}

export const uploadWriteOrchestratorPolicy = {
  createsRoutes: false,
  writesR2: true,
  writesOnlyThroughR2WriteHelper: true,
  updatesUploadTransactions: true,
  recordsAuditEvents: true,
  overwritesAllowed: false,
  recoveryRequiredOnPartialR2Failure: true,
  publishesDocuments: false,
  createsLicences: false,
  createsDownloadLinks: false,
  sendsEmail: false,
};
