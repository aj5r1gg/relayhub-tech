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

function getR2Bucket(env = {}, options = {}) {
  const explicitBinding = options.bucket;

  if (explicitBinding && typeof explicitBinding.head === "function") {
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

    if (bucket && typeof bucket.head === "function") {
      return bucket;
    }
  }

  return null;
}

export function validateR2ObjectKey(objectKey) {
  const key = cleanText(objectKey).replaceAll("\\", "/");

  if (!key) {
    return fail(
      "r2_object_key_missing",
      "R2 object key is required."
    );
  }

  if (key.startsWith("/")) {
    return fail(
      "r2_object_key_leading_slash",
      "R2 object key must not begin with a slash.",
      { object_key: key }
    );
  }

  if (key.endsWith("/")) {
    return fail(
      "r2_object_key_folder_path",
      "R2 object key must refer to an object, not a folder.",
      { object_key: key }
    );
  }

  if (key.includes("//")) {
    return fail(
      "r2_object_key_duplicate_separator",
      "R2 object key must not contain duplicate path separators.",
      { object_key: key }
    );
  }

  if (
    key === ".." ||
    key.startsWith("../") ||
    key.endsWith("/..") ||
    key.includes("/../")
  ) {
    return fail(
      "r2_object_key_path_escape",
      "R2 object key must not contain parent-directory references.",
      { object_key: key }
    );
  }

  if (/[\x00-\x1F\x7F]/.test(key)) {
    return fail(
      "r2_object_key_control_character",
      "R2 object key must not contain control characters.",
      { object_key: key }
    );
  }

  return pass(key);
}

export async function getR2ObjectHead(env = {}, objectKey, options = {}) {
  const keyResult = validateR2ObjectKey(objectKey);

  if (!keyResult.ok) {
    return keyResult;
  }

  const bucket = getR2Bucket(env, options);

  if (!bucket) {
    return fail(
      "r2_bucket_unavailable",
      "R2 bucket binding is unavailable.",
      {
        binding_name: cleanText(options.bindingName) || null,
      }
    );
  }

  try {
    const head = await bucket.head(keyResult.value);

    if (!head) {
      return pass({
        object_key: keyResult.value,
        exists: false,
        head: null,
      });
    }

    return pass({
      object_key: keyResult.value,
      exists: true,
      head: {
        key: head.key || keyResult.value,
        size: head.size ?? null,
        etag: head.etag || null,
        uploaded: head.uploaded ? new Date(head.uploaded).toISOString() : null,
        http_etag: head.httpEtag || null,
        checksums: head.checksums || null,
        custom_metadata: head.customMetadata || null,
        version: head.version || null,
      },
    });
  } catch (error) {
    return fail(
      "r2_head_failed",
      "R2 object existence check failed. Upload must fail closed.",
      {
        object_key: keyResult.value,
        reason: error?.message || String(error),
      }
    );
  }
}

export async function requireR2ObjectAbsent(env = {}, objectKey, options = {}) {
  const headResult = await getR2ObjectHead(env, objectKey, options);

  if (!headResult.ok) {
    return {
      ok: false,
      error: "r2_object_absence_unconfirmed",
      message:
        "R2 object absence could not be confirmed. Upload must fail closed.",
      details: {
        object_key: cleanText(objectKey),
        reason: headResult.error,
        upstream_message: headResult.message,
        upstream_details: headResult.details || {},
      },
      warnings: headResult.warnings || [],
    };
  }

  if (headResult.value.exists) {
    return fail(
      "r2_object_already_exists",
      "R2 object already exists. Upload must not overwrite it.",
      {
        object_key: headResult.value.object_key,
        head: headResult.value.head,
      }
    );
  }

  return pass({
    object_key: headResult.value.object_key,
    exists: false,
    absence_confirmed: true,
    safe_to_write_new_object: true,
  });
}

export async function requireR2ObjectsAbsent(env = {}, objectKeys = [], options = {}) {
  if (!Array.isArray(objectKeys) || objectKeys.length === 0) {
    return fail(
      "r2_object_keys_missing",
      "At least one R2 object key is required."
    );
  }

  const results = [];
  const blocked = [];

  for (const key of objectKeys) {
    const result = await requireR2ObjectAbsent(env, key, options);

    results.push({
      object_key: cleanText(key),
      result,
    });

    if (!result.ok) {
      blocked.push({
        object_key: cleanText(key),
        error: result.error,
        message: result.message,
        details: result.details || {},
      });
    }
  }

  if (blocked.length) {
    return fail(
      "r2_object_absence_check_failed",
      "One or more R2 object keys are not safe for a new write.",
      {
        blocked,
        results,
      }
    );
  }

  return pass({
    absence_confirmed: true,
    safe_to_write_new_objects: true,
    checked_count: results.length,
    results,
  });
}

export async function requireUploadObjectKeysAbsent(env = {}, objectKeySet = {}, options = {}) {
  const keys = [];

  if (typeof objectKeySet === "string") {
    keys.push(objectKeySet);
  } else {
    for (const value of Object.values(objectKeySet || {})) {
      if (typeof value === "string" && cleanText(value)) {
        keys.push(value);
      }
    }
  }

  const uniqueKeys = [...new Set(keys.map(cleanText).filter(Boolean))];

  if (!uniqueKeys.length) {
    return fail(
      "upload_object_keys_missing",
      "Upload object keys are required before R2 absence can be checked."
    );
  }

  return requireR2ObjectsAbsent(env, uniqueKeys, options);
}

export async function classifyR2ObjectWriteReadiness(env = {}, objectKeySet = {}, options = {}) {
  const absenceResult = await requireUploadObjectKeysAbsent(
    env,
    objectKeySet,
    options
  );

  if (!absenceResult.ok) {
    return pass({
      ready_to_write: false,
      decision: "blocked",
      reason: absenceResult.error,
      message: absenceResult.message,
      details: absenceResult.details || {},
    });
  }

  return pass({
    ready_to_write: true,
    decision: "allow_new_write",
    message: "All target R2 object keys are confirmed absent.",
    details: absenceResult.value,
  });
}

export const uploadR2ObjectPolicy = {
  writesR2: false,
  overwritesAllowed: false,
  failClosedWhenUncertain: true,
  requiresAbsenceBeforeWrite: true,
  validatesObjectKeys: true,
  defaultCandidateBindingNames: [
    "R2",
    "BUCKET",
    "DOCUMENTS",
    "DOCUMENT_BUCKET",
    "RELAYHUB_BUCKET",
    "RELAYHUB_DOCUMENTS",
    "PRIVATE_FILES",
  ],
};
