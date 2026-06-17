const VALID_UPLOAD_DOMAINS = new Set(["cdas_document", "private_file"]);

const VALID_IDEMPOTENCY_STATUSES = new Set([
  "started",
  "in_progress",
  "completed",
  "completed_with_warning",
  "failed_before_r2",
  "failed_after_r2",
  "recovery_required",
  "expired",
  "abandoned",
]);

const COMPLETED_STATUSES = new Set([
  "completed",
  "completed_with_warning",
]);

const RECOVERY_REQUIRED_STATUSES = new Set([
  "failed_after_r2",
  "recovery_required",
]);

const DEFAULT_EXPIRY_HOURS = 24;
const MIN_CLIENT_REQUEST_ID_LENGTH = 12;
const MAX_CLIENT_REQUEST_ID_LENGTH = 200;

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

function addHoursIso(dateIso, hours) {
  const base = dateIso ? new Date(dateIso) : new Date();
  const safeHours = Number.isFinite(Number(hours))
    ? Number(hours)
    : DEFAULT_EXPIRY_HOURS;

  return new Date(base.getTime() + safeHours * 60 * 60 * 1000).toISOString();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return toHex(digest);
}

export function validateClientRequestId(clientRequestId) {
  const key = cleanText(clientRequestId);

  if (!key) {
    return fail(
      "idempotency_key_missing",
      "An idempotency key is required for upload requests."
    );
  }

  if (key.length < MIN_CLIENT_REQUEST_ID_LENGTH) {
    return fail(
      "idempotency_key_too_short",
      "The idempotency key is too short.",
      {
        min_length: MIN_CLIENT_REQUEST_ID_LENGTH,
      }
    );
  }

  if (key.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
    return fail(
      "idempotency_key_too_long",
      "The idempotency key is too long.",
      {
        max_length: MAX_CLIENT_REQUEST_ID_LENGTH,
      }
    );
  }

  if (/[\x00-\x1F\x7F]/.test(key)) {
    return fail(
      "idempotency_key_control_character",
      "The idempotency key must not contain control characters."
    );
  }

  return pass(key);
}

export async function hashClientRequestId(clientRequestId) {
  const validation = validateClientRequestId(clientRequestId);

  if (!validation.ok) {
    return validation;
  }

  return pass(await sha256Hex(validation.value));
}

export function validateUploadDomain(domain) {
  const cleanDomain = cleanText(domain);

  if (!VALID_UPLOAD_DOMAINS.has(cleanDomain)) {
    return fail(
      "idempotency_invalid_upload_domain",
      "Upload domain is not recognised.",
      {
        domain: cleanDomain,
      }
    );
  }

  return pass(cleanDomain);
}

export function validateIdempotencyStatus(status) {
  const cleanStatus = cleanText(status);

  if (!VALID_IDEMPOTENCY_STATUSES.has(cleanStatus)) {
    return fail(
      "idempotency_invalid_status",
      "Idempotency status is not recognised.",
      {
        status: cleanStatus,
      }
    );
  }

  return pass(cleanStatus);
}

export function buildIdempotencyRecordId(options = {}) {
  const prefix = cleanText(options.prefix || "uidem");
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `${prefix}_${random.replaceAll("-", "")}`;
}

export async function getIdempotencyRecordByHash(env, idempotencyKeyHash) {
  const hash = cleanText(idempotencyKeyHash).toLowerCase();

  if (!hash) {
    return null;
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       idempotency_key_hash,
       upload_transaction_id,
       upload_domain,
       status,
       created_at,
       updated_at,
       expires_at,
       replay_count,
       last_replayed_at,
       notes
     FROM upload_idempotency_keys
     WHERE idempotency_key_hash = ?`
  )
    .bind(hash)
    .first();

  return row || null;
}

export async function getIdempotencyRecordForClientKey(env, clientRequestId) {
  const hashResult = await hashClientRequestId(clientRequestId);

  if (!hashResult.ok) {
    return hashResult;
  }

  const record = await getIdempotencyRecordByHash(env, hashResult.value);

  return pass({
    idempotency_key_hash: hashResult.value,
    record,
  });
}

export function classifyIdempotencyReplay(record, options = {}) {
  if (!record) {
    return pass({
      replay: false,
      action: "create_new",
      message: "No existing idempotency record was found.",
    });
  }

  const now = new Date(options.now || nowIso());
  const expiresAt = new Date(record.expires_at);

  if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) {
    return pass({
      replay: true,
      action: "expired",
      message:
        "The idempotency key exists but has expired. Existing upload evidence remains available.",
      record,
    });
  }

  if (COMPLETED_STATUSES.has(record.status)) {
    return pass({
      replay: true,
      action: "return_existing_result",
      message:
        "The upload request was repeated. The existing completed upload result should be returned.",
      record,
    });
  }

  if (record.status === "failed_before_r2") {
    return pass({
      replay: true,
      action: "allow_retry_same_transaction",
      message:
        "The previous upload failed before R2 write. A controlled retry may continue using the same transaction.",
      record,
    });
  }

  if (RECOVERY_REQUIRED_STATUSES.has(record.status)) {
    return pass({
      replay: true,
      action: "return_recovery_required",
      message:
        "The previous upload reached a recovery-required state. Do not blindly re-upload to the same object key.",
      record,
    });
  }

  if (record.status === "abandoned") {
    return pass({
      replay: true,
      action: "abandoned",
      message:
        "The idempotency record belongs to an abandoned upload and requires operator review before reuse.",
      record,
    });
  }

  if (record.status === "started" || record.status === "in_progress") {
    return pass({
      replay: true,
      action: "in_progress",
      message:
        "An upload using this idempotency key is already in progress.",
      record,
    });
  }

  return pass({
    replay: true,
    action: "manual_review",
    message:
      "The idempotency key already exists and requires operator review.",
    record,
  });
}

export async function recordIdempotencyReplay(env, idempotencyRecordId, options = {}) {
  const id = cleanText(idempotencyRecordId);

  if (!id) {
    return fail(
      "idempotency_record_id_missing",
      "Idempotency record ID is required."
    );
  }

  const replayedAt = cleanText(options.replayedAt || nowIso());

  await env.DB.prepare(
    `UPDATE upload_idempotency_keys
     SET
       replay_count = replay_count + 1,
       last_replayed_at = ?,
       updated_at = ?
     WHERE id = ?`
  )
    .bind(replayedAt, replayedAt, id)
    .run();

  return pass({
    id,
    replayed_at: replayedAt,
  });
}

export async function createIdempotencyRecord(env, options = {}) {
  const domainResult = validateUploadDomain(options.uploadDomain);

  if (!domainResult.ok) {
    return domainResult;
  }

  const statusResult = validateIdempotencyStatus(options.status || "started");

  if (!statusResult.ok) {
    return statusResult;
  }

  const hashResult = await hashClientRequestId(options.clientRequestId);

  if (!hashResult.ok) {
    return hashResult;
  }

  const uploadTransactionId = cleanText(options.uploadTransactionId);

  if (!uploadTransactionId) {
    return fail(
      "idempotency_upload_transaction_id_missing",
      "Upload transaction ID is required before creating an idempotency record."
    );
  }

  const createdAt = cleanText(options.createdAt || nowIso());
  const expiresAt = cleanText(
    options.expiresAt ||
      addHoursIso(createdAt, options.expiryHours || DEFAULT_EXPIRY_HOURS)
  );

  const record = {
    id: cleanText(options.id || buildIdempotencyRecordId()),
    idempotency_key_hash: hashResult.value,
    upload_transaction_id: uploadTransactionId,
    upload_domain: domainResult.value,
    status: statusResult.value,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: expiresAt,
    replay_count: 0,
    last_replayed_at: null,
    notes: cleanText(options.notes),
  };

  try {
    await env.DB.prepare(
      `INSERT INTO upload_idempotency_keys (
         id,
         idempotency_key_hash,
         upload_transaction_id,
         upload_domain,
         status,
         created_at,
         updated_at,
         expires_at,
         replay_count,
         last_replayed_at,
         notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        record.id,
        record.idempotency_key_hash,
        record.upload_transaction_id,
        record.upload_domain,
        record.status,
        record.created_at,
        record.updated_at,
        record.expires_at,
        record.replay_count,
        record.last_replayed_at,
        record.notes || null
      )
      .run();
  } catch (error) {
    if (String(error?.message || error).toLowerCase().includes("unique")) {
      return fail(
        "idempotency_key_already_exists",
        "This upload request has already been recorded.",
        {
          idempotency_key_hash: record.idempotency_key_hash,
        }
      );
    }

    throw error;
  }

  return pass(record);
}

export async function updateIdempotencyStatus(env, options = {}) {
  const recordId = cleanText(options.id);
  const statusResult = validateIdempotencyStatus(options.status);

  if (!recordId) {
    return fail(
      "idempotency_record_id_missing",
      "Idempotency record ID is required."
    );
  }

  if (!statusResult.ok) {
    return statusResult;
  }

  const updatedAt = cleanText(options.updatedAt || nowIso());

  await env.DB.prepare(
    `UPDATE upload_idempotency_keys
     SET
       status = ?,
       updated_at = ?
     WHERE id = ?`
  )
    .bind(statusResult.value, updatedAt, recordId)
    .run();

  return pass({
    id: recordId,
    status: statusResult.value,
    updated_at: updatedAt,
  });
}

export async function beginIdempotentUpload(env, options = {}) {
  const existingResult = await getIdempotencyRecordForClientKey(
    env,
    options.clientRequestId
  );

  if (!existingResult.ok) {
    return existingResult;
  }

  if (existingResult.value.record) {
    const replayResult = classifyIdempotencyReplay(existingResult.value.record, {
      now: options.now,
    });

    if (replayResult.ok) {
      await recordIdempotencyReplay(env, existingResult.value.record.id, {
        replayedAt: options.now,
      });
    }

    return {
      ok: true,
      value: {
        idempotency_key_hash: existingResult.value.idempotency_key_hash,
        replay: true,
        replay_decision: replayResult.value,
      },
      warnings: [],
    };
  }

  const created = await createIdempotencyRecord(env, options);

  if (!created.ok) {
    return created;
  }

  return {
    ok: true,
    value: {
      idempotency_key_hash: created.value.idempotency_key_hash,
      replay: false,
      record: created.value,
    },
    warnings: [],
  };
}

export const uploadIdempotencyPolicy = {
  defaultExpiryHours: DEFAULT_EXPIRY_HOURS,
  minClientRequestIdLength: MIN_CLIENT_REQUEST_ID_LENGTH,
  maxClientRequestIdLength: MAX_CLIENT_REQUEST_ID_LENGTH,
  validUploadDomains: Array.from(VALID_UPLOAD_DOMAINS),
  validStatuses: Array.from(VALID_IDEMPOTENCY_STATUSES),
  completedStatuses: Array.from(COMPLETED_STATUSES),
  recoveryRequiredStatuses: Array.from(RECOVERY_REQUIRED_STATUSES),
  rawClientRequestIdStored: false,
};
