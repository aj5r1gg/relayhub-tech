const ADMIN_AUDIT_TABLE = "admin_audit_events";

const DEFAULT_ADMIN_ACTOR = "admin";

const IP_HASH_SECRET_NAMES = [
  "UPLOAD_IP_HASH_SECRET",
  "ADMIN_AUDIT_IP_HASH_SECRET",
  "IP_HASH_SECRET",
  "AUDIT_IP_HASH_SECRET",
];

const ACCESS_EMAIL_HEADERS = [
  "cf-access-authenticated-user-email",
  "x-authenticated-user-email",
  "x-admin-email",
];

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

function buildAuditEventId(prefix = "uae") {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `${prefix}_${random.replaceAll("-", "")}`;
}

function getHeader(request, name) {
  if (!request?.headers?.get) {
    return "";
  }

  return cleanText(request.headers.get(name));
}

function getFirstHeader(request, names) {
  for (const name of names) {
    const value = getHeader(request, name);

    if (value) {
      return value;
    }
  }

  return "";
}

export function resolveUploadAdminActor(request, env = {}, options = {}) {
  const explicitActor = cleanText(options.adminActor);

  if (explicitActor) {
    return pass({
      admin_actor: explicitActor,
      source: "explicit",
      raw_token_stored: false,
    });
  }

  const configuredActor = cleanText(
    env.UPLOAD_ADMIN_ACTOR ||
      env.ADMIN_ACTOR_LABEL ||
      env.ADMIN_IDENTITY_LABEL
  );

  if (configuredActor) {
    return pass({
      admin_actor: configuredActor,
      source: "environment_label",
      raw_token_stored: false,
    });
  }

  const accessEmail = getFirstHeader(request, ACCESS_EMAIL_HEADERS);

  if (accessEmail) {
    return pass({
      admin_actor: accessEmail,
      source: "authenticated_header",
      raw_token_stored: false,
    });
  }

  return pass(
    {
      admin_actor: DEFAULT_ADMIN_ACTOR,
      source: "fallback",
      raw_token_stored: false,
    },
    [
      {
        code: "admin_actor_fallback_used",
        message:
          "No named admin identity was available. Used the interim fallback admin actor label.",
      },
    ]
  );
}

export function resolveUploadUserAgent(request) {
  return cleanText(getHeader(request, "user-agent"));
}

export function resolveUploadRequestId(request, options = {}) {
  return cleanText(
    options.requestId ||
      getHeader(request, "cf-ray") ||
      getHeader(request, "x-request-id")
  );
}

function getIpHashSecret(env = {}) {
  for (const name of IP_HASH_SECRET_NAMES) {
    const value = cleanText(env[name]);

    if (value) {
      return {
        name,
        value,
      };
    }
  }

  return null;
}

export function resolveRawIp(request) {
  return cleanText(
    getHeader(request, "cf-connecting-ip") ||
      getHeader(request, "x-forwarded-for").split(",")[0]
  );
}

export async function hashUploadIp(request, env = {}) {
  const rawIp = resolveRawIp(request);

  if (!rawIp) {
    return pass(
      {
        ip_hash: null,
        raw_ip_stored: false,
        hash_secret_present: Boolean(getIpHashSecret(env)),
      },
      [
        {
          code: "ip_address_unavailable",
          message: "No request IP address was available for hashing.",
        },
      ]
    );
  }

  const secret = getIpHashSecret(env);

  if (!secret) {
    return pass(
      {
        ip_hash: null,
        raw_ip_stored: false,
        hash_secret_present: false,
      },
      [
        {
          code: "ip_hash_secret_missing",
          message:
            "No IP hash secret is configured. Raw IP was not stored and no IP hash was recorded.",
        },
      ]
    );
  }

  return pass({
    ip_hash: await sha256Hex(`${secret.value}:${rawIp}`),
    raw_ip_stored: false,
    hash_secret_present: true,
    hash_secret_name: secret.name,
  });
}

export async function getTableColumns(env, tableName) {
  const table = cleanText(tableName);

  if (!table) {
    return fail(
      "audit_table_name_missing",
      "Audit table name is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "audit_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  try {
    const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const columns = (result.results || [])
      .map((row) => cleanText(row.name))
      .filter(Boolean);

    return pass(columns);
  } catch (error) {
    return fail(
      "audit_table_info_failed",
      "Audit table schema could not be inspected.",
      {
        table,
        reason: error?.message || String(error),
      }
    );
  }
}

function setIfColumn(values, columns, column, value) {
  if (columns.has(column)) {
    values[column] = value;
  }
}

function stringifyJson(value) {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      serialization_error: true,
    });
  }
}

export function buildUploadAuditDetails(event = {}) {
  return {
    upload_domain: cleanText(event.uploadDomain),
    upload_transaction_id: cleanText(event.uploadTransactionId),
    related_record_type: cleanText(event.relatedRecordType),
    related_record_id: cleanText(event.relatedRecordId),
    storage_prefix_id: cleanText(event.storagePrefixId),
    storage_prefix: cleanText(event.storagePrefix),
    object_key: cleanText(event.objectKey),
    source_sha256: cleanText(event.sourceSha256),
    source_size:
      event.sourceSize === undefined || event.sourceSize === null
        ? null
        : Number(event.sourceSize),
    failure_stage: cleanText(event.failureStage),
    recovery_required: Boolean(event.recoveryRequired),
    warnings: Array.isArray(event.warnings) ? event.warnings : [],
    metadata: event.metadata || null,
  };
}

export async function buildUploadAuditEvent(request, env = {}, event = {}) {
  const eventType = cleanText(event.eventType || event.event_type);
  const action = cleanText(event.action || eventType);

  if (!eventType && !action) {
    return fail(
      "upload_audit_event_type_missing",
      "Upload audit event type is required."
    );
  }

  const actorResult = resolveUploadAdminActor(request, env, {
    adminActor: event.adminActor,
  });

  const ipHashResult = await hashUploadIp(request, env);

  const warnings = [
    ...(actorResult.warnings || []),
    ...(ipHashResult.warnings || []),
    ...(Array.isArray(event.warnings) ? event.warnings : []),
  ];

  const createdAt = cleanText(event.createdAt || event.eventAt || nowIso());
  const success = event.success === undefined ? true : Boolean(event.success);

  const details = {
    ...buildUploadAuditDetails(event),
    request_id: resolveUploadRequestId(request, event),
    raw_admin_token_stored: false,
    raw_ip_stored: false,
  };

  return pass(
    {
      id: cleanText(event.id || buildAuditEventId()),
      event_type: eventType || action,
      action: action || eventType,
      target_type: cleanText(event.targetType || event.relatedRecordType || "upload"),
      target_id: cleanText(event.targetId || event.relatedRecordId || event.uploadTransactionId),
      success,
      failure_reason: cleanText(event.failureReason),
      admin_identity: actorResult.value.admin_actor,
      admin_actor: actorResult.value.admin_actor,
      user_agent: resolveUploadUserAgent(request),
      ip_hash: ipHashResult.value.ip_hash,
      details,
      details_json: stringifyJson(details),
      metadata_json: stringifyJson(event.metadata || details),
      created_at: createdAt,
      event_at: createdAt,
      request_id: details.request_id,
      warnings,
    },
    warnings
  );
}

export async function writeUploadAdminAuditEvent(env, request, event = {}) {
  const built = await buildUploadAuditEvent(request, env, event);

  if (!built.ok) {
    return built;
  }

  const columnsResult = await getTableColumns(env, ADMIN_AUDIT_TABLE);

  if (!columnsResult.ok) {
    return {
      ok: true,
      value: {
        recorded: false,
        reason: columnsResult.error,
        message: columnsResult.message,
        audit_event: built.value,
      },
      warnings: [
        ...(built.warnings || []),
        {
          code: "admin_audit_event_not_recorded",
          message:
            "Upload audit event was built but could not be recorded because the admin audit table could not be inspected.",
          details: columnsResult.details,
        },
      ],
    };
  }

  const columns = new Set(columnsResult.value);

  if (!columns.size) {
    return {
      ok: true,
      value: {
        recorded: false,
        reason: "admin_audit_events_no_columns",
        audit_event: built.value,
      },
      warnings: [
        ...(built.warnings || []),
        {
          code: "admin_audit_event_not_recorded",
          message:
            "Upload audit event was built but not recorded because admin_audit_events has no visible columns.",
        },
      ],
    };
  }

  const values = {};

  setIfColumn(values, columns, "id", built.value.id);
  setIfColumn(values, columns, "event_type", built.value.event_type);
  setIfColumn(values, columns, "action", built.value.action);
  setIfColumn(values, columns, "target_type", built.value.target_type);
  setIfColumn(values, columns, "target_id", built.value.target_id);
  setIfColumn(values, columns, "success", built.value.success ? 1 : 0);
  setIfColumn(values, columns, "failure_reason", built.value.failure_reason || null);
  setIfColumn(values, columns, "admin_identity", built.value.admin_identity);
  setIfColumn(values, columns, "admin_actor", built.value.admin_actor);
  setIfColumn(values, columns, "user_agent", built.value.user_agent || null);
  setIfColumn(values, columns, "ip_hash", built.value.ip_hash || null);
  setIfColumn(values, columns, "details_json", built.value.details_json);
  setIfColumn(values, columns, "metadata_json", built.value.metadata_json);
  setIfColumn(values, columns, "request_id", built.value.request_id || null);
  setIfColumn(values, columns, "created_at", built.value.created_at);
  setIfColumn(values, columns, "event_at", built.value.event_at);

  const insertColumns = Object.keys(values);

  if (!insertColumns.length) {
    return {
      ok: true,
      value: {
        recorded: false,
        reason: "admin_audit_events_no_compatible_columns",
        audit_event: built.value,
      },
      warnings: [
        ...(built.warnings || []),
        {
          code: "admin_audit_event_not_recorded",
          message:
            "Upload audit event was built but not recorded because admin_audit_events has no compatible columns.",
        },
      ],
    };
  }

  const placeholders = insertColumns.map(() => "?").join(", ");
  const boundValues = insertColumns.map((column) => values[column]);

  try {
    await env.DB.prepare(
      `INSERT INTO ${ADMIN_AUDIT_TABLE} (${insertColumns.join(", ")})
       VALUES (${placeholders})`
    )
      .bind(...boundValues)
      .run();
  } catch (error) {
    return {
      ok: true,
      value: {
        recorded: false,
        reason: "admin_audit_event_insert_failed",
        audit_event: built.value,
      },
      warnings: [
        ...(built.warnings || []),
        {
          code: "admin_audit_event_insert_failed",
          message:
            "Upload audit event was built but could not be inserted into admin_audit_events.",
          details: {
            reason: error?.message || String(error),
          },
        },
      ],
    };
  }

  return {
    ok: true,
    value: {
      recorded: true,
      table: ADMIN_AUDIT_TABLE,
      audit_event_id: built.value.id,
      event_type: built.value.event_type,
      action: built.value.action,
      target_type: built.value.target_type,
      target_id: built.value.target_id,
      raw_admin_token_stored: false,
      raw_ip_stored: false,
    },
    warnings: built.warnings || [],
  };
}

export const uploadAuditPolicy = {
  auditTable: ADMIN_AUDIT_TABLE,
  rawAdminTokenStored: false,
  rawIpStored: false,
  adminActorFallback: DEFAULT_ADMIN_ACTOR,
  ipHashSecretNames: [...IP_HASH_SECRET_NAMES],
  accessEmailHeaders: [...ACCESS_EMAIL_HEADERS],
};
