import {
  requireUploadObjectKeysAbsent,
  getR2ObjectHead,
  validateR2ObjectKey,
} from "./r2-objects.js";

import {
  byteLength,
  sha256Hex,
  buildSha256Sidecar,
} from "./hash.js";

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

function getR2Bucket(env = {}, options = {}) {
  const explicitBinding = options.bucket;

  if (explicitBinding && typeof explicitBinding.put === "function") {
    return explicitBinding;
  }

  const candidateNames = [
    options.bindingName,
    "R2",
    "BUCKET",
    "DOCUMENTS",
    "DOCUMENT_BUCKET",
    "RELAYHUB_BUCKET",
    "RELAYHUB_DOCUMENTS",
    "PRIVATE_FILES",
  ]
    .map(cleanText)
    .filter(Boolean);

  for (const name of candidateNames) {
    const bucket = env[name];

    if (bucket && typeof bucket.put === "function") {
      return bucket;
    }
  }

  return null;
}

function stringifyJson(value) {
  return JSON.stringify(value ?? {}, null, 2) + "\n";
}

function validateSha256Hex(hash) {
  const cleanHash = cleanText(hash).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(cleanHash)) {
    return fail(
      "r2_write_invalid_sha256",
      "Source SHA-256 must be a 64-character lowercase hexadecimal string.",
      {
        source_sha256: hash,
      }
    );
  }

  return pass(cleanHash);
}

function normaliseUploadObjectKeys(objectKeys = {}) {
  const source = cleanText(objectKeys.source || objectKeys.source_object_key);
  const sha256 = cleanText(objectKeys.sha256 || objectKeys.sha256_object_key);
  const metadata = cleanText(objectKeys.metadata || objectKeys.metadata_object_key);

  return {
    source,
    sha256,
    metadata,
  };
}

export function validateR2WriteInputs(options = {}) {
  const objectKeys = normaliseUploadObjectKeys(options.objectKeys || options);

  const sourceKeyResult = validateR2ObjectKey(objectKeys.source);
  if (!sourceKeyResult.ok) {
    return sourceKeyResult;
  }

  const sha256KeyResult = validateR2ObjectKey(objectKeys.sha256);
  if (!sha256KeyResult.ok) {
    return sha256KeyResult;
  }

  const metadataKeyResult = validateR2ObjectKey(objectKeys.metadata);
  if (!metadataKeyResult.ok) {
    return metadataKeyResult;
  }

  const bytes = options.bytes;

  if (!bytes) {
    return fail(
      "r2_write_source_bytes_missing",
      "Source bytes are required before writing to R2."
    );
  }

  const size = byteLength(bytes);

  if (size <= 0) {
    return fail(
      "r2_write_source_bytes_empty",
      "Source bytes are empty.",
      { source_size: size }
    );
  }

  const hashResult = validateSha256Hex(options.sourceSha256);

  if (!hashResult.ok) {
    return hashResult;
  }

  const expectedSize =
    options.sourceSize === undefined || options.sourceSize === null
      ? size
      : Number(options.sourceSize);

  if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
    return fail(
      "r2_write_invalid_source_size",
      "Source size must be a positive number.",
      {
        source_size: options.sourceSize,
      }
    );
  }

  if (expectedSize !== size) {
    return fail(
      "r2_write_source_size_mismatch",
      "Source byte length does not match recorded source size.",
      {
        recorded_source_size: expectedSize,
        actual_source_size: size,
      }
    );
  }

  return pass({
    object_keys: {
      source: sourceKeyResult.value,
      sha256: sha256KeyResult.value,
      metadata: metadataKeyResult.value,
    },
    bytes,
    source_size: size,
    source_sha256: hashResult.value,
  });
}

export async function verifyR2WriteHash(options = {}) {
  const bytes = options.bytes;
  const expectedSha256 = cleanText(options.sourceSha256).toLowerCase();

  const hashResult = await sha256Hex(bytes);

  if (!hashResult.ok) {
    return hashResult;
  }

  if (hashResult.value !== expectedSha256) {
    return fail(
      "r2_write_source_hash_mismatch",
      "Source bytes do not match the recorded SHA-256.",
      {
        recorded_source_sha256: expectedSha256,
        actual_source_sha256: hashResult.value,
      }
    );
  }

  return pass({
    source_sha256: hashResult.value,
    source_size: byteLength(bytes),
    hash_verified: true,
  });
}

export function buildUploadMetadataObject(options = {}) {
  const objectKeys = normaliseUploadObjectKeys(options.objectKeys || options);
  const writtenAt = cleanText(options.writtenAt || nowIso());

  return {
    schema: "relayhub.upload.r2-object-metadata.v1",
    upload_domain: cleanText(options.uploadDomain),
    upload_transaction_id: cleanText(options.uploadTransactionId),
    related_record_type: cleanText(options.relatedRecordType),
    related_record_id: cleanText(options.relatedRecordId),
    storage_prefix_id: cleanText(options.storagePrefixId),
    storage_prefix: cleanText(options.storagePrefix),
    source_object_key: objectKeys.source,
    sha256_object_key: objectKeys.sha256,
    metadata_object_key: objectKeys.metadata,
    source_sha256: cleanText(options.sourceSha256).toLowerCase(),
    source_size:
      options.sourceSize === undefined || options.sourceSize === null
        ? null
        : Number(options.sourceSize),
    original_filename: cleanText(options.originalFilename),
    mime_type: cleanText(options.mimeType || "application/pdf"),
    file_extension: cleanText(options.fileExtension || "pdf"),
    written_at: writtenAt,
    writes_r2: true,
    overwrites_allowed: false,
    generated_by: "RelayHub Controlled Upload Facility",
    notes: cleanText(options.notes),
  };
}

export function buildR2PutOptions(options = {}) {
  const metadata = options.metadata || {};

  return {
    httpMetadata: {
      contentType: cleanText(options.contentType || "application/pdf"),
    },
    customMetadata: {
      upload_transaction_id: cleanText(metadata.upload_transaction_id),
      upload_domain: cleanText(metadata.upload_domain),
      source_sha256: cleanText(metadata.source_sha256),
      source_size: String(metadata.source_size ?? ""),
      original_filename: cleanText(metadata.original_filename),
      written_by: "relayhub-controlled-upload",
    },
  };
}

export async function putR2Object(env = {}, objectKey, value, options = {}) {
  const keyResult = validateR2ObjectKey(objectKey);

  if (!keyResult.ok) {
    return keyResult;
  }

  const bucket = getR2Bucket(env, options);

  if (!bucket) {
    return fail(
      "r2_write_bucket_unavailable",
      "R2 bucket binding is unavailable.",
      {
        binding_name: cleanText(options.bindingName) || null,
      }
    );
  }

  try {
    const putResult = await bucket.put(
      keyResult.value,
      value,
      options.putOptions || {}
    );

    return pass({
      object_key: keyResult.value,
      put_result: putResult || null,
      written: true,
    });
  } catch (error) {
    return fail(
      "r2_put_failed",
      "R2 object write failed.",
      {
        object_key: keyResult.value,
        reason: error?.message || String(error),
      }
    );
  }
}

export async function verifyR2ObjectReadable(env = {}, objectKey, options = {}) {
  const headResult = await getR2ObjectHead(env, objectKey, options);

  if (!headResult.ok) {
    return fail(
      "r2_write_readback_failed",
      "R2 object readback verification failed.",
      {
        object_key: cleanText(objectKey),
        reason: headResult.error,
        upstream_message: headResult.message,
        upstream_details: headResult.details || {},
      }
    );
  }

  if (!headResult.value.exists) {
    return fail(
      "r2_write_readback_missing",
      "R2 object was written but could not be confirmed by readback.",
      {
        object_key: cleanText(objectKey),
      }
    );
  }

  return pass({
    object_key: headResult.value.object_key,
    readback_confirmed: true,
    head: headResult.value.head,
  });
}

export async function writeUploadObjectsToR2(env = {}, options = {}) {
  const inputResult = validateR2WriteInputs(options);

  if (!inputResult.ok) {
    return inputResult;
  }

  const verifiedHash = await verifyR2WriteHash({
    bytes: inputResult.value.bytes,
    sourceSha256: inputResult.value.source_sha256,
  });

  if (!verifiedHash.ok) {
    return verifiedHash;
  }

  const objectKeys = inputResult.value.object_keys;

  const absenceResult = await requireUploadObjectKeysAbsent(
    env,
    objectKeys,
    options
  );

  if (!absenceResult.ok) {
    return fail(
      "r2_write_absence_check_failed",
      "R2 write blocked because one or more target objects are not confirmed absent.",
      {
        reason: absenceResult.error,
        upstream_message: absenceResult.message,
        upstream_details: absenceResult.details || {},
      }
    );
  }

  const writtenAt = cleanText(options.writtenAt || nowIso());

  const metadataObject = buildUploadMetadataObject({
    ...options,
    objectKeys,
    sourceSha256: inputResult.value.source_sha256,
    sourceSize: inputResult.value.source_size,
    writtenAt,
  });

  const sha256Sidecar = buildSha256Sidecar(inputResult.value.source_sha256);

  if (!sha256Sidecar.ok) {
    return sha256Sidecar;
  }

  const sourcePut = await putR2Object(
    env,
    objectKeys.source,
    inputResult.value.bytes,
    {
      ...options,
      putOptions: buildR2PutOptions({
        contentType: options.mimeType || "application/pdf",
        metadata: metadataObject,
      }),
    }
  );

  if (!sourcePut.ok) {
    return fail(
      "r2_write_source_failed",
      "Source object write failed.",
      {
        source_object_key: objectKeys.source,
        reason: sourcePut.error,
        upstream_message: sourcePut.message,
        upstream_details: sourcePut.details || {},
      }
    );
  }

  const sidecarPut = await putR2Object(
    env,
    objectKeys.sha256,
    sha256Sidecar.value,
    {
      ...options,
      putOptions: {
        httpMetadata: {
          contentType: "text/plain; charset=utf-8",
        },
        customMetadata: {
          upload_transaction_id: cleanText(options.uploadTransactionId),
          upload_domain: cleanText(options.uploadDomain),
          source_sha256: inputResult.value.source_sha256,
          written_by: "relayhub-controlled-upload",
        },
      },
    }
  );

  if (!sidecarPut.ok) {
    return fail(
      "r2_write_sha256_sidecar_failed",
      "SHA-256 sidecar write failed after source object write. Recovery is required.",
      {
        source_object_key: objectKeys.source,
        sha256_object_key: objectKeys.sha256,
        reason: sidecarPut.error,
        upstream_message: sidecarPut.message,
        upstream_details: sidecarPut.details || {},
        recovery_required: true,
      }
    );
  }

  const metadataPut = await putR2Object(
    env,
    objectKeys.metadata,
    stringifyJson(metadataObject),
    {
      ...options,
      putOptions: {
        httpMetadata: {
          contentType: "application/json; charset=utf-8",
        },
        customMetadata: {
          upload_transaction_id: cleanText(options.uploadTransactionId),
          upload_domain: cleanText(options.uploadDomain),
          source_sha256: inputResult.value.source_sha256,
          written_by: "relayhub-controlled-upload",
        },
      },
    }
  );

  if (!metadataPut.ok) {
    return fail(
      "r2_write_metadata_sidecar_failed",
      "Metadata sidecar write failed after source object write. Recovery is required.",
      {
        source_object_key: objectKeys.source,
        sha256_object_key: objectKeys.sha256,
        metadata_object_key: objectKeys.metadata,
        reason: metadataPut.error,
        upstream_message: metadataPut.message,
        upstream_details: metadataPut.details || {},
        recovery_required: true,
      }
    );
  }

  const readbacks = [];

  for (const key of Object.values(objectKeys)) {
    const readback = await verifyR2ObjectReadable(env, key, options);

    readbacks.push(readback);

    if (!readback.ok) {
      return fail(
        "r2_write_readback_verification_failed",
        "One or more written R2 objects could not be verified by readback. Recovery is required.",
        {
          object_key: key,
          recovery_required: true,
          reason: readback.error,
          upstream_message: readback.message,
          upstream_details: readback.details || {},
        }
      );
    }
  }

  return pass({
    written: true,
    written_at: writtenAt,
    source_object_key: objectKeys.source,
    sha256_object_key: objectKeys.sha256,
    metadata_object_key: objectKeys.metadata,
    source_sha256: inputResult.value.source_sha256,
    source_size: inputResult.value.source_size,
    readback_confirmed: true,
    readbacks: readbacks.map((result) => result.value),
    recovery_required: false,
  });
}

export const uploadR2WritePolicy = {
  writesR2: true,
  createsRoutes: false,
  overwritesAllowed: false,
  requiresAbsenceBeforeWrite: true,
  verifiesHashBeforeWrite: true,
  writesSourceObject: true,
  writesSha256Sidecar: true,
  writesMetadataSidecar: true,
  verifiesReadbackAfterWrite: true,
  publishesDocuments: false,
  createsLicences: false,
  createsDownloadLinks: false,
  sendsEmail: false,
};
