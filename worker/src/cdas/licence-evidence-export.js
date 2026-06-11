import { jsonResponse } from "../shared.js";
import {
  getCdasLicenceEvidenceBundle,
} from "./licence-evidence-bundle.js";

const EXPORT_EVENT_TYPE = "cdas_licence_evidence_bundle_export_recorded";
const EXPORT_RECORD_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

async function insertAdminAuditEvent(env, bundle, exportEvidence) {
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
    event_type: EXPORT_EVENT_TYPE,
    export_record_version: EXPORT_RECORD_VERSION,

    bundle_type: bundle.bundle_type,
    bundle_version: bundle.bundle_version,
    bundle_generated_at: bundle.generated_at,
    bundle_sha256: exportEvidence.bundle_sha256,
    bundle_size_bytes: exportEvidence.bundle_size_bytes,

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

    read_only: controls.read_only === true,
    mutates_database: controls.mutates_database === true,
    writes_to_r2: controls.writes_to_r2 === true,
    creates_download_link: controls.creates_download_link === true,
    sends_email: controls.sends_email === true,
    serves_download: controls.serves_download === true,
  };

  const details = {
    message: "CDAS licence evidence bundle export was recorded.",
    event_type: EXPORT_EVENT_TYPE,
    bundle_sha256: exportEvidence.bundle_sha256,
    bundle_size_bytes: exportEvidence.bundle_size_bytes,
    licence_number: licence.licence_number || null,
    operator_status: interpretation.status || null,
    dangerous_states_total: summary.dangerous_states?.total ?? null,
  };

  setIfColumn(values, columns, "id", makeId("aae"));
  setIfColumn(values, columns, "event_type", EXPORT_EVENT_TYPE);
  setIfColumn(values, columns, "type", EXPORT_EVENT_TYPE);
  setIfColumn(values, columns, "action", EXPORT_EVENT_TYPE);
  setIfColumn(values, columns, "category", "cdas");
  setIfColumn(values, columns, "status", "recorded");
  setIfColumn(values, columns, "success", 1);

  setIfColumn(values, columns, "entity_type", "document_licence");
  setIfColumn(values, columns, "entity_id", licence.id || "");
  setIfColumn(values, columns, "related_type", "licence");
  setIfColumn(values, columns, "related_id", licence.id || "");

  setIfColumn(values, columns, "licence_id", licence.id || "");
  setIfColumn(values, columns, "licence_number", licence.licence_number || "");
  setIfColumn(values, columns, "document_id", licence.document_id || document.id || "");
  setIfColumn(values, columns, "document_version", licence.document_version || document.version || "");

  setIfColumn(values, columns, "bundle_type", bundle.bundle_type || "");
  setIfColumn(values, columns, "bundle_version", bundle.bundle_version || EXPORT_RECORD_VERSION);
  setIfColumn(values, columns, "bundle_sha256", exportEvidence.bundle_sha256);
  setIfColumn(values, columns, "evidence_bundle_sha256", exportEvidence.bundle_sha256);
  setIfColumn(values, columns, "bundle_size_bytes", exportEvidence.bundle_size_bytes);

  setIfColumn(values, columns, "actor", "admin");
  setIfColumn(values, columns, "actor_type", "admin");
  setIfColumn(values, columns, "admin_user", "admin");

  setIfColumn(values, columns, "message", "CDAS licence evidence bundle export was recorded.");
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
    event_type: EXPORT_EVENT_TYPE,
    recorded_at: createdAt,
    table: "admin_audit_events",
  };
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

export async function recordCdasLicenceEvidenceBundleExport(
  request,
  env,
  licenceIdOrNumber
) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to record a CDAS licence evidence bundle export.",
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
  const bundleSha256 = await sha256Hex(canonicalJson);
  const bundleSizeBytes = new TextEncoder().encode(canonicalJson).byteLength;

  const exportEvidence = {
    export_record_version: EXPORT_RECORD_VERSION,
    event_type: EXPORT_EVENT_TYPE,
    recorded_at: nowIso(),
    bundle_type: bundle.bundle_type,
    bundle_version: bundle.bundle_version,
    bundle_sha256: bundleSha256,
    bundle_size_bytes: bundleSizeBytes,
    licence_id: bundle.licence?.id || null,
    licence_number: bundle.licence?.licence_number || null,
    document_id: bundle.licence?.document_id || bundle.document?.id || null,
    document_version:
      bundle.licence?.document_version || bundle.document?.version || null,
  };

  let auditRecord;

  try {
    auditRecord = await insertAdminAuditEvent(env, bundle, exportEvidence);
  } catch (error) {
    auditRecord = {
      recorded: false,
      reason: "admin_audit_event_insert_failed",
      error: error.message,
    };
  }

  return jsonResponse({
    ok: true,
    export_record_type: "cdas_licence_evidence_bundle_export_record",
    export_record_version: EXPORT_RECORD_VERSION,
    recorded_at: exportEvidence.recorded_at,

    export_evidence: exportEvidence,
    audit_record: auditRecord,

    bundle,

    controls: {
      read_only_bundle_generation: true,
      records_admin_audit_event: auditRecord.recorded === true,
      mutates_database: auditRecord.recorded === true,
      writes_to_r2: false,
      reads_from_r2: false,
      creates_download_link: false,
      generates_pdf: false,
      sends_email: false,
      serves_download: false,
      exposes_raw_token: false,
      exposes_token_hash: false,
      includes_private_r2_url: false,
      export_record_only: true,
    },

    message: auditRecord.recorded
      ? "CDAS licence evidence bundle export was recorded."
      : "CDAS licence evidence bundle was generated, but the export audit record could not be persisted.",
  });
}