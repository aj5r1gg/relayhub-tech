import { jsonResponse } from "../shared.js";
import { getCdasLicenceEvidenceBundle } from "./licence-evidence-bundle.js";

const ARCHIVE_EVENT_TYPE = "cdas_licence_evidence_bundle_archived";
const ARCHIVE_RECORD_VERSION = 1;
const ARCHIVE_CONTENT_TYPE = "application/json;charset=utf-8";

function nowIso() {
  return new Date().toISOString();
}

function compactTimestamp(value = nowIso()) {
  return String(value)
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "")
    .replace("T", "T")
    .replace("Z", "Z");
}

function cleanSlug(value, fallback = "unknown") {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || fallback;
}

function randomHex(bytes = 8) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);

  return [...buffer]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomHex(8)}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

async function sha256Hex(value) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getR2Bucket(env) {
  return env.RELAYHUB_DOWNLOADS || env.RELAYHUB_DOCS || env.RELAYHUB_R2 || null;
}

async function getTableInfo(env, tableName) {
  try {
    const result = await env.RELAYHUB_DB
      .prepare(`PRAGMA table_info(${tableName})`)
      .all();

    return result.results || [];
  } catch {
    return [];
  }
}

function defaultValueForColumn(column) {
  const type = String(column.type || "").toUpperCase();

  if (type.includes("INT") || type.includes("REAL") || type.includes("NUM")) {
    return 0;
  }

  return "";
}

function setIfColumn(values, columns, name, value) {
  if (columns.has(name)) {
    values[name] = value;
  }
}

function buildArchiveObjectKey(bundle, archiveEvidence) {
  const licence = bundle.licence || {};
  const document = bundle.document || {};

  const documentId = cleanSlug(
    licence.document_id || document.id || "unknown-document"
  );

  const version = cleanSlug(
    licence.document_version || document.version || "unknown-version"
  );

  const licenceNumber = cleanSlug(
    licence.licence_number || licence.id || "unknown-licence"
  );

  const timestamp = compactTimestamp(archiveEvidence.archived_at);
  const hash = archiveEvidence.bundle_sha256;

  return [
    "docs",
    "audit",
    "cdas",
    "evidence-bundles",
    documentId,
    version,
    licenceNumber,
    `${timestamp}-${hash}.json`,
  ].join("/");
}

async function generateEvidenceBundleFromEndpoint(request, env, licenceIdOrNumber) {
  const getRequest = new Request(request.url, {
    method: "GET",
    headers: request.headers,
  });

  const response = await getCdasLicenceEvidenceBundle(
    getRequest,
    env,
    licenceIdOrNumber
  );

  let data;

  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      status: 500,
      data: {
        ok: false,
        error: "evidence_bundle_response_not_json",
        message: "Evidence bundle endpoint did not return valid JSON.",
      },
    };
  }

  if (!response.ok || !data.ok) {
    return {
      ok: false,
      status: response.status || 500,
      data,
    };
  }

  return {
    ok: true,
    status: 200,
    data,
  };
}

async function putArchiveObject(env, bundle, canonicalJson, archiveEvidence) {
  const bucket = getR2Bucket(env);

  if (!bucket) {
    return {
      archived: false,
      reason: "r2_bucket_not_configured",
      message:
        "No compatible R2 binding was found. Expected RELAYHUB_DOWNLOADS, RELAYHUB_DOCS, or RELAYHUB_R2.",
    };
  }

  const objectKey = buildArchiveObjectKey(bundle, archiveEvidence);
  const licence = bundle.licence || {};
  const document = bundle.document || {};

  await bucket.put(objectKey, canonicalJson, {
    httpMetadata: {
      contentType: ARCHIVE_CONTENT_TYPE,
    },
    customMetadata: {
      cdas_record_type: "licence_evidence_bundle_archive",
      bundle_type: String(bundle.bundle_type || ""),
      bundle_version: String(bundle.bundle_version || ""),
      bundle_sha256: String(archiveEvidence.bundle_sha256 || ""),
      licence_id: String(licence.id || ""),
      licence_number: String(licence.licence_number || ""),
      document_id: String(licence.document_id || document.id || ""),
      document_version: String(licence.document_version || document.version || ""),
      archived_at: String(archiveEvidence.archived_at || ""),
    },
  });

  return {
    archived: true,
    object_key: objectKey,
    content_type: ARCHIVE_CONTENT_TYPE,
  };
}

async function insertAdminAuditEvent(env, bundle, archiveEvidence, r2Archive) {
  const tableInfo = await getTableInfo(env, "admin_audit_events");

  if (!tableInfo.length) {
    return {
      recorded: false,
      reason: "admin_audit_events_table_unavailable",
    };
  }

  const columns = new Set(tableInfo.map((column) => column.name));
  const values = {};
  const createdAt = nowIso();

  const licence = bundle.licence || {};
  const document = bundle.document || {};
  const summary = bundle.summary || {};
  const integrity = bundle.integrity_summary || {};
  const controls = bundle.controls || {};
  const interpretation = bundle.operator_interpretation || {};

  const metadata = {
    event_type: ARCHIVE_EVENT_TYPE,
    archive_record_version: ARCHIVE_RECORD_VERSION,

    bundle_type: bundle.bundle_type,
    bundle_version: bundle.bundle_version,
    bundle_generated_at: bundle.generated_at,
    bundle_sha256: archiveEvidence.bundle_sha256,
    bundle_size_bytes: archiveEvidence.bundle_size_bytes,

    archived_to_r2: r2Archive.archived === true,
    archive_object_key: r2Archive.object_key || null,
    archive_content_type: r2Archive.content_type || null,

    licence_id: licence.id || null,
    licence_number: licence.licence_number || null,
    licence_status: licence.status || null,

    document_id: licence.document_id || document.id || null,
    document_version: licence.document_version || document.version || null,

    operator_status: interpretation.status || null,
    recommended_next_action: interpretation.recommended_next_action || null,

    download_links_total: summary.download_links?.total ?? null,
    email_events_total: summary.email_events?.total ?? null,
    download_events_total: summary.download_events?.total ?? null,
    dangerous_states_total: summary.dangerous_states?.total ?? null,

    raw_token_exposed: integrity.raw_token_exposed === true,
    token_hash_exposed: integrity.token_hash_exposed === true,
    private_r2_url_exposed: integrity.private_r2_url_exposed === true,

    bundle_read_only: controls.read_only === true,
    bundle_mutates_database: controls.mutates_database === true,
    bundle_writes_to_r2: controls.writes_to_r2 === true,
    bundle_creates_download_link: controls.creates_download_link === true,
    bundle_sends_email: controls.sends_email === true,
    bundle_serves_download: controls.serves_download === true,
  };

  const details = {
    message: "CDAS licence evidence bundle was archived to R2.",
    event_type: ARCHIVE_EVENT_TYPE,
    bundle_sha256: archiveEvidence.bundle_sha256,
    bundle_size_bytes: archiveEvidence.bundle_size_bytes,
    archive_object_key: r2Archive.object_key || null,
    archived_to_r2: r2Archive.archived === true,
    licence_number: licence.licence_number || null,
    operator_status: interpretation.status || null,
    dangerous_states_total: summary.dangerous_states?.total ?? null,
  };

  setIfColumn(values, columns, "id", makeId("aae"));
  setIfColumn(values, columns, "event_type", ARCHIVE_EVENT_TYPE);
  setIfColumn(values, columns, "type", ARCHIVE_EVENT_TYPE);
  setIfColumn(values, columns, "action", ARCHIVE_EVENT_TYPE);
  setIfColumn(values, columns, "category", "cdas");
  setIfColumn(values, columns, "status", r2Archive.archived ? "archived" : "failed");
  setIfColumn(values, columns, "success", r2Archive.archived ? 1 : 0);

  setIfColumn(values, columns, "entity_type", "document_licence");
  setIfColumn(values, columns, "entity_id", licence.id || "");
  setIfColumn(values, columns, "related_type", "licence");
  setIfColumn(values, columns, "related_id", licence.id || "");

  setIfColumn(values, columns, "licence_id", licence.id || "");
  setIfColumn(values, columns, "licence_number", licence.licence_number || "");
  setIfColumn(values, columns, "document_id", licence.document_id || document.id || "");
  setIfColumn(values, columns, "document_version", licence.document_version || document.version || "");

  setIfColumn(values, columns, "bundle_type", bundle.bundle_type || "");
  setIfColumn(values, columns, "bundle_version", bundle.bundle_version || ARCHIVE_RECORD_VERSION);
  setIfColumn(values, columns, "bundle_sha256", archiveEvidence.bundle_sha256);
  setIfColumn(values, columns, "evidence_bundle_sha256", archiveEvidence.bundle_sha256);
  setIfColumn(values, columns, "bundle_size_bytes", archiveEvidence.bundle_size_bytes);

  setIfColumn(values, columns, "object_key", r2Archive.object_key || "");
  setIfColumn(values, columns, "r2_object_key", r2Archive.object_key || "");
  setIfColumn(values, columns, "archive_object_key", r2Archive.object_key || "");

  setIfColumn(values, columns, "actor", "admin");
  setIfColumn(values, columns, "actor_type", "admin");
  setIfColumn(values, columns, "admin_user", "admin");

  setIfColumn(values, columns, "message", "CDAS licence evidence bundle was archived to R2.");
  setIfColumn(values, columns, "details", JSON.stringify(details));
  setIfColumn(values, columns, "details_json", JSON.stringify(details));
  setIfColumn(values, columns, "metadata", JSON.stringify(metadata));
  setIfColumn(values, columns, "metadata_json", JSON.stringify(metadata));

  setIfColumn(values, columns, "created_at", createdAt);
  setIfColumn(values, columns, "updated_at", createdAt);
  setIfColumn(values, columns, "event_at", createdAt);
  setIfColumn(values, columns, "occurred_at", createdAt);

  for (const column of tableInfo) {
    if (
      column.pk ||
      column.notnull !== 1 ||
      column.dflt_value !== null ||
      Object.prototype.hasOwnProperty.call(values, column.name)
    ) {
      continue;
    }

    values[column.name] = defaultValueForColumn(column);
  }

  const insertColumns = Object.keys(values);

  if (!insertColumns.length) {
    return {
      recorded: false,
      reason: "admin_audit_events_no_compatible_columns",
    };
  }

  const placeholders = insertColumns.map(() => "?").join(", ");
  const sql = `
    INSERT INTO admin_audit_events (${insertColumns.join(", ")})
    VALUES (${placeholders})
  `;

  await env.RELAYHUB_DB
    .prepare(sql)
    .bind(...insertColumns.map((column) => values[column]))
    .run();

  return {
    recorded: true,
    event_id: values.id || null,
    event_type: ARCHIVE_EVENT_TYPE,
    recorded_at: createdAt,
    table: "admin_audit_events",
  };
}

export async function archiveCdasLicenceEvidenceBundle(
  request,
  env,
  licenceIdOrNumber
) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to archive a CDAS licence evidence bundle.",
      },
      { status: 405, headers: { allow: "POST" } }
    );
  }

  if (!env.RELAYHUB_DB) {
    return jsonResponse(
      {
        ok: false,
        error: "database_not_configured",
        message: "RELAYHUB_DB binding is not configured.",
      },
      { status: 500 }
    );
  }

  const bucket = getR2Bucket(env);

  if (!bucket) {
    return jsonResponse(
      {
        ok: false,
        error: "r2_bucket_not_configured",
        message:
          "No compatible R2 binding was found. Expected RELAYHUB_DOWNLOADS, RELAYHUB_DOCS, or RELAYHUB_R2.",
      },
      { status: 500 }
    );
  }

  const bundleResult = await generateEvidenceBundleFromEndpoint(
    request,
    env,
    licenceIdOrNumber
  );

  if (!bundleResult.ok) {
    return jsonResponse(bundleResult.data, { status: bundleResult.status });
  }

  const bundle = bundleResult.data;
  const canonicalJson = stableStringify(bundle);
  const encoded = new TextEncoder().encode(canonicalJson);
  const bundleSha256 = await sha256Hex(canonicalJson);

  const archiveEvidence = {
    archive_record_version: ARCHIVE_RECORD_VERSION,
    event_type: ARCHIVE_EVENT_TYPE,
    archived_at: nowIso(),
    bundle_type: bundle.bundle_type,
    bundle_version: bundle.bundle_version,
    bundle_sha256: bundleSha256,
    bundle_size_bytes: encoded.byteLength,
    licence_id: bundle.licence?.id || null,
    licence_number: bundle.licence?.licence_number || null,
    document_id: bundle.licence?.document_id || bundle.document?.id || null,
    document_version:
      bundle.licence?.document_version || bundle.document?.version || null,
  };

  let r2Archive;

  try {
    r2Archive = await putArchiveObject(env, bundle, canonicalJson, archiveEvidence);
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: "evidence_bundle_r2_archive_failed",
        message: "CDAS licence evidence bundle could not be archived to R2.",
        archive_evidence: archiveEvidence,
        r2_archive: {
          archived: false,
          error: error.message,
        },
        controls: {
          read_only_bundle_generation: true,
          records_admin_audit_event: false,
          mutates_database: false,
          writes_to_r2: true,
          reads_from_r2: false,
          creates_download_link: false,
          generates_pdf: false,
          sends_email: false,
          serves_download: false,
          exposes_raw_token: false,
          exposes_token_hash: false,
          includes_private_r2_url: false,
          archives_evidence_bundle_json: false,
        },
      },
      { status: 500 }
    );
  }

  let auditRecord;

  try {
    auditRecord = await insertAdminAuditEvent(
      env,
      bundle,
      archiveEvidence,
      r2Archive
    );
  } catch (error) {
    auditRecord = {
      recorded: false,
      reason: "admin_audit_event_insert_failed",
      error: error.message,
    };
  }

  return jsonResponse({
    ok: true,
    archive_record_type: "cdas_licence_evidence_bundle_archive",
    archive_record_version: ARCHIVE_RECORD_VERSION,
    archived_at: archiveEvidence.archived_at,

    archive_evidence: {
      ...archiveEvidence,
      object_key: r2Archive.object_key || null,
      content_type: r2Archive.content_type || ARCHIVE_CONTENT_TYPE,
    },

    r2_archive: r2Archive,
    audit_record: auditRecord,

    bundle,

    controls: {
      read_only_bundle_generation: true,
      records_admin_audit_event: auditRecord.recorded === true,
      mutates_database: auditRecord.recorded === true,
      writes_to_r2: true,
      reads_from_r2: false,
      creates_download_link: false,
      generates_pdf: false,
      sends_email: false,
      serves_download: false,
      exposes_raw_token: false,
      exposes_token_hash: false,
      includes_private_r2_url: false,
      export_record_only: false,
      archive_record_only: false,
      archives_evidence_bundle_json: r2Archive.archived === true,
    },

    message:
      auditRecord.recorded === true
        ? "CDAS licence evidence bundle was archived to R2 and the archive event was recorded."
        : "CDAS licence evidence bundle was archived to R2, but the archive audit event could not be persisted.",
  });
}