import { jsonResponse } from "../shared.js";
import { parseStrictUploadRequest } from "./parse-multipart.js";
import { byteLength, sha256Hex } from "./hash.js";
import { requireUploadObjectKeysAbsent } from "./r2-objects.js";
import { createUploadTransaction } from "./transactions.js";
import { orchestrateUploadR2Write } from "./write-orchestrator.js";
import { getIdempotencyRecordForClientKey } from "./idempotency.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const IDEMPOTENCY_COMPLETED_STATUSES = new Set([
  "completed",
  "completed_with_warning",
]);

const IDEMPOTENCY_RECOVERY_REQUIRED_STATUSES = new Set([
  "failed_after_r2",
  "recovery_required",
]);

const IDEMPOTENCY_IN_PROGRESS_STATUSES = new Set([
  "started",
  "in_progress",
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function envEnabled(value) {
  return cleanText(value).toLowerCase() === "true";
}

function nowIso() {
  return new Date().toISOString();
}

function addHoursIso(dateIso, hours = 24) {
  const base = dateIso ? new Date(dateIso) : new Date();

  return new Date(base.getTime() + hours * 60 * 60 * 1000).toISOString();
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

function methodNotAllowed(allowed = ["GET"]) {
  return jsonResponse(
    {
      ok: false,
      error: "method_not_allowed",
      message: "Method is not allowed for this upload route.",
      allowed_methods: allowed,
    },
    405,
    {
      Allow: allowed.join(", "),
    }
  );
}

function notFound() {
  return jsonResponse(
    {
      ok: false,
      error: "upload_admin_route_not_found",
      message: "Upload admin route was not found.",
    },
    404
  );
}

function adminAuthFailed() {
  return jsonResponse(
    {
      ok: false,
      error: "admin_auth_failed",
      message: "Admin access is not available.",
    },
    401
  );
}

function buildUploadIdempotencyRecordId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `uidem_${random.replaceAll("-", "")}`;
}

function isUploadAdminAuthorized(request, env) {
  const expected = env.RELAYHUB_ADMIN_TOKEN;

  if (!expected) {
    return false;
  }

  const authHeader = request.headers.get("Authorization") || "";
  const bearerPrefix = "Bearer ";

  if (authHeader.startsWith(bearerPrefix)) {
    const supplied = authHeader.slice(bearerPrefix.length).trim();

    if (supplied && supplied === expected) {
      return true;
    }
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  return Boolean(token && token === expected);
}

function getUploadRouteSwitches(env = {}) {
  return {
    uploads_enabled: envEnabled(env.UPLOADS_ENABLED),
    cdas_uploads_enabled: envEnabled(env.CDAS_UPLOADS_ENABLED),
    upload_route_skeleton_enabled: envEnabled(env.UPLOAD_ROUTE_SKELETON_ENABLED),
    upload_route_dry_run_enabled: envEnabled(env.UPLOAD_ROUTE_DRY_RUN_ENABLED),
    upload_route_real_write_enabled: envEnabled(env.UPLOAD_ROUTE_REAL_WRITE_ENABLED),
  };
}

function getUploadRouteMode(request) {
  const url = new URL(request.url);

  const mode = cleanText(url.searchParams.get("mode"));

  const dryRun =
    mode === "dry-run" ||
    mode === "dry_run" ||
    url.searchParams.get("dry_run") === "1" ||
    url.searchParams.get("dryRun") === "1";

  const realWrite =
    mode === "real-write" ||
    mode === "real_write" ||
    mode === "write" ||
    mode === "live" ||
    url.searchParams.get("real_write") === "1" ||
    url.searchParams.get("realWrite") === "1";

  if (dryRun) {
    return {
      mode: "dry-run",
      dry_run: true,
      real_write: false,
    };
  }

  if (realWrite) {
    return {
      mode: "real-write",
      dry_run: false,
      real_write: true,
    };
  }

  return {
    mode: mode || "blocked",
    dry_run: false,
    real_write: false,
  };
}

function getRequestId(request) {
  return (
    cleanText(request.headers.get("x-request-id")) ||
    cleanText(request.headers.get("cf-ray")) ||
    cleanText(crypto.randomUUID?.()) ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  );
}

function getAdminActor(request, env) {
  return (
    cleanText(env.UPLOAD_ADMIN_ACTOR) ||
    cleanText(env.RELAYHUB_ADMIN_ACTOR) ||
    cleanText(request.headers.get("cf-access-authenticated-user-email")) ||
    cleanText(request.headers.get("x-admin-actor")) ||
    "admin"
  );
}

function safeSlug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function safeVersion(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/^v/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalisePrefix(prefix) {
  const cleanPrefix = cleanText(prefix).replaceAll("\\", "/");

  if (!cleanPrefix) {
    return "";
  }

  return cleanPrefix.endsWith("/") ? cleanPrefix : `${cleanPrefix}/`;
}

function buildNoSideEffects(realWrite = false) {
  return {
    parses_multipart: true,
    validates_prefix: true,
    previews_object_keys: true,
    calculates_hash_evidence: true,
    checks_r2_absence: true,
    recognises_real_write_intent: true,
    requires_idempotency_for_real_write: true,
    creates_upload_transaction: realWrite,
    writes_r2: realWrite,
    creates_draft_cdas_document_record: realWrite,
    publishes_document: false,
    activates_document: false,
    makes_document_requestable: false,
    generates_pdf: false,
    creates_licence: false,
    creates_download_link: false,
    sends_email: false,
  };
}

function buildSideEffectsConfirmed(overrides = {}) {
  return {
    creates_upload_transaction: false,
    writes_r2: false,
    creates_draft_cdas_document_record: false,
    public_visibility_created: false,
    publishes_document: false,
    activates_document: false,
    makes_document_requestable: false,
    makes_document_directly_downloadable: false,
    generates_pdf: false,
    creates_licence: false,
    creates_download_link: false,
    sends_email: false,
    ...overrides,
  };
}

function safeFileSummary(file) {
  if (!file) {
    return null;
  }

  return {
    name: file.name || null,
    size: file.size ?? null,
    type: file.type || null,
  };
}

function buildParsedUploadSummary(parsed) {
  const value = parsed?.value || {};

  return {
    upload_domain: "cdas_document",
    file: safeFileSummary(value.file),
    filename: value.file?.name || null,
    file_size: value.file?.size ?? null,
    file_type: value.file?.type || null,
    fields: value.fields || {},
  };
}

function buildObservedRequest(request) {
  return {
    method: request.method,
    content_type: request.headers.get("content-type") || null,
    content_length: request.headers.get("content-length") || null,
  };
}

function buildCdasUploadRouteStatus(request, env) {
  const switches = getUploadRouteSwitches(env);
  const routeMode = getUploadRouteMode(request);

  return {
    ok: true,
    route: "/api/admin/uploads/cdas-document",
    route_status: "cdas_draft_document_record_creation_gate",
    upload_domain: "cdas_document",
    dry_run_requested: routeMode.dry_run,
    real_write_requested: routeMode.real_write,
    mode: routeMode.mode,
    switches,
    side_effects: buildNoSideEffects(
      routeMode.real_write && switches.upload_route_real_write_enabled
    ),
    requirements_before_real_write: [
      "UPLOADS_ENABLED=true",
      "CDAS_UPLOADS_ENABLED=true",
      "UPLOAD_ROUTE_SKELETON_ENABLED=true",
      "UPLOAD_ROUTE_REAL_WRITE_ENABLED=true",
      "client_request_id",
      "strict multipart parser",
      "storage prefix validation",
      "object key builder",
      "hash evidence",
      "R2 no-overwrite check",
      "idempotency replay check",
      "upload transaction creation",
      "R2 write helper",
      "write orchestrator",
      "draft CDAS document row creation",
      "recovery path validation",
      "audit path validation",
      "manual release gate approval",
    ],
  };
}

function routeSkeletonDisabledResponse(request, env) {
  const status = buildCdasUploadRouteStatus(request, env);

  return jsonResponse(
    {
      ...status,
      ok: false,
      error: "upload_route_skeleton_disabled",
      message:
        "CDAS upload route skeleton is present but disabled by policy. No upload action was performed.",
    },
    423
  );
}

function dryRunDisabledResponse(request, env) {
  const status = buildCdasUploadRouteStatus(request, env);

  return jsonResponse(
    {
      ...status,
      ok: false,
      error: "upload_route_dry_run_disabled",
      message:
        "CDAS upload dry-run mode is disabled. No upload action was performed.",
    },
    423
  );
}

function uploadSystemDisabledResponse(request, env) {
  const status = buildCdasUploadRouteStatus(request, env);

  return jsonResponse(
    {
      ...status,
      ok: false,
      error: "uploads_disabled",
      message:
        "Upload handling is disabled by policy. No upload action was performed.",
    },
    423
  );
}

function cdasUploadsDisabledResponse(request, env) {
  const status = buildCdasUploadRouteStatus(request, env);

  return jsonResponse(
    {
      ...status,
      ok: false,
      error: "cdas_uploads_disabled",
      message:
        "CDAS upload handling is disabled by policy. No upload action was performed.",
    },
    423
  );
}

function dryRunRequiredResponse(request, env) {
  const status = buildCdasUploadRouteStatus(request, env);

  return jsonResponse(
    {
      ...status,
      ok: false,
      error: "upload_route_dry_run_required",
      message:
        "This route accepts dry-run or explicitly gated real-write requests only. Add ?mode=dry-run for dry-run validation.",
    },
    409
  );
}

function realWriteDisabledResponse(request, env) {
  const status = buildCdasUploadRouteStatus(request, env);

  return jsonResponse(
    {
      ...status,
      ok: false,
      accepted: false,
      error: "upload_real_write_disabled",
      message:
        "Real CDAS upload write mode is recognised but disabled by policy. No upload transaction was created, no R2 write was performed, and no document row was created.",
      validation_stage: "real_write_gate",
      side_effects_confirmed: buildSideEffectsConfirmed(),
      required_switch: "UPLOAD_ROUTE_REAL_WRITE_ENABLED=true",
    },
    423
  );
}

async function getStoragePrefixForDryRun(env, storagePrefixId) {
  const prefixId = cleanText(storagePrefixId);

  if (!prefixId) {
    return fail(
      "upload_storage_prefix_id_missing",
      "Storage prefix ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_storage_prefix_database_unavailable",
      "D1 database binding is unavailable, so storage prefix could not be validated."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       domain,
       label,
       prefix,
       status,
       description
     FROM storage_prefixes
     WHERE id = ?`
  )
    .bind(prefixId)
    .first();

  if (!row) {
    return fail(
      "upload_storage_prefix_not_found",
      "Storage prefix could not be found.",
      {
        storage_prefix_id: prefixId,
      }
    );
  }

  if (row.domain !== "cdas_document") {
    return fail(
      "upload_storage_prefix_domain_mismatch",
      "Storage prefix does not belong to the CDAS document upload domain.",
      {
        storage_prefix_id: row.id,
        expected_domain: "cdas_document",
        actual_domain: row.domain,
      }
    );
  }

  if (row.status !== "active") {
    return fail(
      "upload_storage_prefix_not_active",
      "Storage prefix is not active and cannot be used for upload.",
      {
        storage_prefix_id: row.id,
        status: row.status,
      }
    );
  }

  const prefix = normalisePrefix(row.prefix);

  if (!prefix) {
    return fail(
      "upload_storage_prefix_empty",
      "Storage prefix is empty.",
      {
        storage_prefix_id: row.id,
      }
    );
  }

  if (prefix.startsWith("/")) {
    return fail(
      "upload_storage_prefix_leading_slash",
      "Storage prefix must not begin with a slash.",
      {
        storage_prefix_id: row.id,
        prefix,
      }
    );
  }

  if (prefix.includes("//")) {
    return fail(
      "upload_storage_prefix_duplicate_separator",
      "Storage prefix must not contain duplicate path separators.",
      {
        storage_prefix_id: row.id,
        prefix,
      }
    );
  }

  if (
    prefix === ".." ||
    prefix.startsWith("../") ||
    prefix.endsWith("/..") ||
    prefix.includes("/../")
  ) {
    return fail(
      "upload_storage_prefix_path_escape",
      "Storage prefix must not contain parent-directory references.",
      {
        storage_prefix_id: row.id,
        prefix,
      }
    );
  }

  if (!prefix.startsWith("docs/originals/relayhub/")) {
    return fail(
      "upload_storage_prefix_outside_cdas_root",
      "CDAS document uploads must remain under docs/originals/relayhub/.",
      {
        storage_prefix_id: row.id,
        prefix,
      }
    );
  }

  return pass({
    id: row.id,
    domain: row.domain,
    label: row.label,
    prefix,
    status: row.status,
    description: row.description || null,
  });
}

function buildCdasDryRunObjectKeyPreview(fields, prefixRecord) {
  const slug = safeSlug(fields.slug);
  const version = safeVersion(fields.version);

  if (!slug) {
    return fail(
      "upload_object_key_slug_invalid",
      "Document slug is required before object keys can be previewed."
    );
  }

  if (!version) {
    return fail(
      "upload_object_key_version_invalid",
      "Document version is required before object keys can be previewed."
    );
  }

  const base = `${normalisePrefix(prefixRecord.prefix)}${slug}/${version}/`;

  if (base.includes("//")) {
    return fail(
      "upload_object_key_duplicate_separator",
      "Generated object key contains duplicate path separators.",
      {
        base,
      }
    );
  }

  if (
    base === ".." ||
    base.startsWith("../") ||
    base.endsWith("/..") ||
    base.includes("/../")
  ) {
    return fail(
      "upload_object_key_path_escape",
      "Generated object key contains parent-directory references.",
      {
        base,
      }
    );
  }

  return pass({
    base_prefix: base,
    source_object_key: `${base}source.pdf`,
    sha256_object_key: `${base}source.sha256`,
    metadata_object_key: `${base}metadata.json`,
    overwrite_allowed: false,
    writes_r2: false,
  });
}

function getFileExtension(filename) {
  const cleanName = cleanText(filename).toLowerCase();
  const parts = cleanName.split(".");

  if (parts.length < 2) {
    return "";
  }

  return parts.pop();
}

function safeFilename(filename) {
  const cleanName = cleanText(filename).toLowerCase();
  const extension = getFileExtension(cleanName);
  const withoutExtension = extension
    ? cleanName.slice(0, -(extension.length + 1))
    : cleanName;

  const base =
    safeSlug(withoutExtension) ||
    `upload-${Date.now().toString(36)}`;

  return extension ? `${base}.${extension}` : base;
}

function asciiFromFirstBytes(bytes, count = 8) {
  const view = new Uint8Array(bytes).slice(0, count);

  return Array.from(view)
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

function validatePdfDryRunSanity(file, bytes, sourceSize) {
  const filename = cleanText(file?.name);
  const mimeType = cleanText(file?.type);
  const extension = getFileExtension(filename);
  const firstBytes = asciiFromFirstBytes(bytes, 8);

  const checks = {
    non_empty: sourceSize > 0,
    within_size_limit: sourceSize <= MAX_UPLOAD_BYTES,
    filename_extension_pdf: extension === "pdf",
    mime_type_pdf: !mimeType || mimeType === "application/pdf",
    pdf_magic_header: firstBytes.startsWith("%PDF-"),
  };

  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  if (failedChecks.length) {
    return fail(
      "upload_pdf_sanity_failed",
      "Basic PDF sanity checks failed.",
      {
        filename,
        mime_type: mimeType || null,
        extension: extension || null,
        source_size: sourceSize,
        first_bytes_ascii: firstBytes,
        failed_checks: failedChecks,
        checks,
      }
    );
  }

  return pass({
    filename,
    mime_type: mimeType || null,
    extension,
    source_size: sourceSize,
    first_bytes_ascii: firstBytes,
    checks,
  });
}

async function buildDryRunHashEvidence(parsed) {
  const file = parsed?.value?.file;

  if (!file) {
    return fail(
      "upload_hash_file_missing",
      "File is required before hash evidence can be calculated."
    );
  }

  const bytes = await file.arrayBuffer();
  const sourceSize = byteLength(bytes);

  const sanity = validatePdfDryRunSanity(file, bytes, sourceSize);

  if (!sanity.ok) {
    return sanity;
  }

  const hash = await sha256Hex(bytes);

  if (!hash.ok) {
    return hash;
  }

  return pass({
    source_sha256: hash.value,
    source_size: sourceSize,
    file_name: file.name || null,
    file_type: file.type || null,
    pdf_sanity: sanity.value,
    sidecars_preview: {
      sha256_text: `${hash.value}\n`,
    },
    writes_r2: false,
  });
}

async function buildDryRunR2AbsenceCheck(env, objectKeyPreview) {
  const objectKeys = {
    source: objectKeyPreview.source_object_key,
    sha256: objectKeyPreview.sha256_object_key,
    metadata: objectKeyPreview.metadata_object_key,
  };

  const absence = await requireUploadObjectKeysAbsent(env, objectKeys, {
    bindingName: "DOCUMENT_BUCKET",
  });

  if (!absence.ok) {
    return fail(
      "upload_r2_absence_check_failed",
      "Dry-run R2 absence check failed. Upload would be blocked.",
      {
        reason: absence.error,
        upstream_message: absence.message,
        upstream_details: absence.details || {},
        object_keys: objectKeys,
        writes_r2: false,
      }
    );
  }

  return pass({
    absence_confirmed: true,
    safe_to_write_new_objects: true,
    checked_count: absence.value.checked_count,
    object_keys: objectKeys,
    results: absence.value.results,
    writes_r2: false,
  });
}

async function getD1TableColumns(env, tableName) {
  if (!env?.DB?.prepare) {
    return fail(
      "upload_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const safeTable = cleanText(tableName);

  if (!/^[a-zA-Z0-9_]+$/.test(safeTable)) {
    return fail(
      "upload_invalid_table_name",
      "D1 table name is invalid.",
      {
        table_name: safeTable,
      }
    );
  }

  const result = await env.DB.prepare(`PRAGMA table_info(${safeTable})`).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const columns = new Set(rows.map((row) => row.name).filter(Boolean));

  return pass(columns);
}

function buildCdasDocumentId(fields = {}) {
  return safeSlug(fields.slug);
}

function buildCdasGeneratedPrefix(fields = {}) {
  const slug = safeSlug(fields.slug);
  const version = safeVersion(fields.version);

  if (!slug || !version) {
    return null;
  }

  return `docs/generated/cdas/${slug}/${version}/`;
}

async function getExistingCdasDocumentByIdOrSlug(env, documentId, slug) {
  if (!env?.DB?.prepare) {
    return fail(
      "upload_documents_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const cleanDocumentId = cleanText(documentId);
  const cleanSlug = cleanText(slug);

  if (!cleanDocumentId || !cleanSlug) {
    return fail(
      "upload_document_identity_missing",
      "Document ID and slug are required."
    );
  }

  const row = await env.DB.prepare(
    `SELECT id, slug, title, version, status
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(cleanDocumentId, cleanSlug)
    .first();

  return pass(row || null);
}

async function preflightCdasDraftDocumentRecord(env, fields = {}) {
  const documentId = buildCdasDocumentId(fields);
  const slug = safeSlug(fields.slug);

  if (!documentId) {
    return fail(
      "upload_document_id_invalid",
      "A valid document ID could not be derived from the uploaded document slug."
    );
  }

  if (!slug) {
    return fail(
      "upload_document_slug_invalid",
      "A valid document slug is required."
    );
  }

  const existing = await getExistingCdasDocumentByIdOrSlug(
    env,
    documentId,
    slug
  );

  if (!existing.ok) {
    return existing;
  }

  if (existing.value) {
    return fail(
      "upload_document_record_already_exists",
      "A CDAS document record already exists for this document ID or slug.",
      {
        document_id: documentId,
        slug,
        existing_document: existing.value,
      }
    );
  }

  return pass({
    document_id: documentId,
    slug,
    status: "draft",
    is_listed: 0,
    requires_approval: 1,
    safe_to_create: true,
  });
}

function buildCdasDraftDocumentRow(fields, preview, uploadTransaction) {
  const eventAt = nowIso();
  const documentId = buildCdasDocumentId(fields);
  const slug = safeSlug(fields.slug);

  return {
    id: documentId,
    slug,
    title: cleanText(fields.title),
    summary: nullableText(fields.summary),
    description: nullableText(fields.description),
    version: cleanText(fields.version),
    status: "draft",
    classification: cleanText(fields.classification || "controlled"),
    access_class: cleanText(fields.access_class || "controlled_verified"),
    source_object: preview.object_key_preview.source_object_key,
    source_sha256: preview.hash_evidence.source_sha256,
    generated_prefix: buildCdasGeneratedPrefix(fields),
    licence_terms_version: cleanText(fields.licence_terms_version),
    is_listed: 0,
    allow_redownload: 1,
    max_redownloads: null,
    requires_approval: 1,
    current_version_of: null,
    supersedes_document_id: null,
    superseded_by_document_id: null,
    created_at: eventAt,
    updated_at: eventAt,
    upload_transaction_id: uploadTransaction?.id || null,
    upload_status: "source_uploaded",
  };
}

function buildCdasDraftAdminVisibilityEvidence(draftDocumentRecord, preview) {
  const document =
    draftDocumentRecord?.document ||
    draftDocumentRecord?.document_record ||
    draftDocumentRecord ||
    {};

  const documentId = cleanText(document.id);
  const slug = cleanText(document.slug);
  const status = cleanText(document.status || "draft");

  return {
    admin_visible: true,
    admin_surface: "cdas_documents_admin",
    admin_path: "/admin/cdas-documents",
    admin_filter_hint: documentId || slug || null,
    review_state: "draft_review_required",
    document_id: documentId || null,
    slug: slug || null,
    status,
    is_listed: Number(document.is_listed ?? 0),
    requires_approval: Number(document.requires_approval ?? 1),
    source_object:
      cleanText(document.source_object) ||
      preview?.object_key_preview?.source_object_key ||
      null,
    source_sha256:
      cleanText(document.source_sha256) ||
      preview?.hash_evidence?.source_sha256 ||
      null,
    public_visibility: {
      listed_publicly: false,
      requestable_publicly: false,
      downloadable_publicly: false,
      public_url_created: false,
    },
    prohibited_side_effects: {
      activated: false,
      generated_pdf_created: false,
      licence_created: false,
      download_link_created: false,
      email_sent: false,
    },
    required_admin_actions_before_release: [
      "Review uploaded source object",
      "Confirm document title, slug, version, classification, and access class",
      "Confirm licence terms version",
      "Run document evidence checks",
      "Approve or reject draft",
      "Only then proceed to a separate activation gate",
    ],
  };
}

async function insertCdasDraftDocumentRecord(env, row) {
  const columnsResult = await getD1TableColumns(env, "documents");

  if (!columnsResult.ok) {
    return columnsResult;
  }

  const availableColumns = columnsResult.value;

  const requiredColumns = [
    "id",
    "slug",
    "title",
    "version",
    "status",
    "classification",
    "access_class",
    "source_object",
    "licence_terms_version",
    "created_at",
    "updated_at",
  ];

  const missingRequired = requiredColumns.filter(
    (column) => !availableColumns.has(column)
  );

  if (missingRequired.length) {
    return fail(
      "upload_documents_schema_missing_required_columns",
      "The documents table is missing required columns for CDAS upload.",
      {
        missing_columns: missingRequired,
      }
    );
  }

  const insertableEntries = Object.entries(row).filter(([column]) =>
    availableColumns.has(column)
  );

  const columns = insertableEntries.map(([column]) => column);
  const values = insertableEntries.map(([, value]) => value);
  const placeholders = columns.map(() => "?").join(", ");

  await env.DB.prepare(
    `INSERT INTO documents (${columns.join(", ")})
     VALUES (${placeholders})`
  )
    .bind(...values)
    .run();

  return pass({
    document: Object.fromEntries(insertableEntries),
    inserted_columns: columns,
    status: "draft",
    is_listed: row.is_listed,
    requires_approval: row.requires_approval,
  });
}

async function markUploadTransactionRecoveryRequiredForDocumentRecordFailure(
  env,
  uploadTransactionId,
  failureReason,
  eventAt = nowIso()
) {
  const id = cleanText(uploadTransactionId);

  if (!id || !env?.DB?.prepare) {
    return pass({
      recorded: false,
      reason: "upload_transaction_not_available",
    });
  }

  await env.DB.prepare(
    `UPDATE upload_transactions
     SET upload_status = ?,
         recovery_status = ?,
         failure_stage = ?,
         failure_reason = ?,
         failed_at = ?
     WHERE id = ?`
  )
    .bind(
      "recovery_required",
      "required",
      "documents_row_insert",
      cleanText(failureReason),
      eventAt,
      id
    )
    .run();

  return pass({
    recorded: true,
    upload_transaction_id: id,
    upload_status: "recovery_required",
    recovery_status: "required",
    failure_stage: "documents_row_insert",
  });
}

async function buildCdasDraftDocumentRecordPreview(env, parsed, preview) {
  const fields = parsed?.value?.fields || {};

  const preflight = await preflightCdasDraftDocumentRecord(env, fields);

  if (!preflight.ok) {
    return preflight;
  }

  const row = buildCdasDraftDocumentRow(fields, preview, {
    id: "pending_upload_transaction",
  });
  
  const documentRecordPreview = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    version: row.version,
    status: row.status,
    classification: row.classification,
    access_class: row.access_class,
    source_object: row.source_object,
    source_sha256: row.source_sha256,
    generated_prefix: row.generated_prefix,
    licence_terms_version: row.licence_terms_version,
    is_listed: row.is_listed,
    requires_approval: row.requires_approval,
    allow_redownload: row.allow_redownload,
  };

  return pass({
    preflight: preflight.value,
    document_record_preview: documentRecordPreview,
    admin_visibility_preview: {
      admin_visible_after_real_write: true,
      admin_surface: "cdas_documents_admin",
      admin_path: "/admin/cdas-documents",
      admin_filter_hint: row.id,
      review_state: "draft_review_required",
      public_visibility_after_real_write: {
        listed_publicly: false,
        requestable_publicly: false,
        downloadable_publicly: false,
        public_url_created: false,
      },
      prohibited_side_effects_after_real_write: {
        activated: false,
        generated_pdf_created: false,
        licence_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    writes_d1: false,
  });
}

const VALID_CDAS_DRAFT_REVIEW_ACTIONS = new Set([
  "hold",
  "reject",
  "approve_for_activation_prep",
]);

function buildCdasUploadReviewEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `curv_${random.replaceAll("-", "")}`;
}

function normaliseReviewAction(value) {
  return cleanText(value).toLowerCase();
}

function validateCdasDraftReviewAction(action) {
  const cleanAction = normaliseReviewAction(action);

  if (!VALID_CDAS_DRAFT_REVIEW_ACTIONS.has(cleanAction)) {
    return fail(
      "upload_review_action_invalid",
      "CDAS upload review action is not recognised.",
      {
        allowed_actions: Array.from(VALID_CDAS_DRAFT_REVIEW_ACTIONS),
        received_action: cleanAction,
      }
    );
  }

  return pass(cleanAction);
}

async function readJsonBody(request) {
  try {
    return pass(await request.json());
  } catch (error) {
    return fail(
      "upload_review_json_invalid",
      "Review request body must be valid JSON.",
      {
        error: error?.message || String(error),
      }
    );
  }
}

async function getCdasDraftDocumentForReview(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "upload_review_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "upload_review_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       is_listed,
       requires_approval,
       source_object,
       source_sha256
     FROM documents
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "upload_review_document_not_found",
      "Draft document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "draft") {
    return fail(
      "upload_review_document_not_draft",
      "Only draft CDAS documents can be reviewed through this upload review gate.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.is_listed ?? 0) !== 0) {
    return fail(
      "upload_review_document_is_listed",
      "Listed documents cannot be handled through the upload draft review gate.",
      {
        document_id: row.id,
        is_listed: row.is_listed,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "upload_review_document_does_not_require_approval",
      "This document does not appear to be an approval-required upload draft.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  return pass(row);
}

function buildCdasReviewOutcome(action) {
  if (action === "hold") {
    return {
      review_state: "held",
      resulting_document_status: "draft",
      next_allowed_gate: null,
      message:
        "Draft document was placed on hold. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
    };
  }

  if (action === "reject") {
    return {
      review_state: "rejected",
      resulting_document_status: "draft",
      next_allowed_gate: null,
      message:
        "Draft document was rejected for release. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
    };
  }

  return {
    review_state: "approved_for_activation_prep",
    resulting_document_status: "draft",
    next_allowed_gate: "U3-M — CDAS Activation Preparation Gate",
    message:
      "Draft document was approved for activation preparation only. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
  };
}

async function insertCdasUploadReviewEvent(env, options = {}) {
  if (!env?.DB?.prepare) {
    return fail(
      "upload_review_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasUploadReviewEventId();

  await env.DB.prepare(
    `INSERT INTO cdas_upload_review_events (
       id,
       document_id,
       upload_transaction_id,
       review_action,
       previous_document_status,
       resulting_document_status,
       review_notes,
       admin_actor,
       request_id,
       public_visibility_created,
       licence_created,
       download_link_created,
       email_sent,
       document_activated,
       generated_pdf_created,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.documentId,
      options.uploadTransactionId || null,
      options.reviewAction,
      options.previousDocumentStatus || "draft",
      options.resultingDocumentStatus || "draft",
      nullableText(options.reviewNotes),
      nullableText(options.adminActor),
      nullableText(options.requestId),
      0,
      0,
      0,
      0,
      0,
      0,
      eventAt
    )
    .run();

  return pass({
    id,
    document_id: options.documentId,
    upload_transaction_id: options.uploadTransactionId || null,
    review_action: options.reviewAction,
    previous_document_status: options.previousDocumentStatus || "draft",
    resulting_document_status: options.resultingDocumentStatus || "draft",
    review_notes: nullableText(options.reviewNotes),
    public_visibility_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    document_activated: 0,
    generated_pdf_created: 0,
    created_at: eventAt,
  });
}

async function touchCdasDraftDocumentAfterReview(env, documentId, eventAt = nowIso()) {
  if (!env?.DB?.prepare) {
    return fail(
      "upload_review_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  await env.DB.prepare(
    `UPDATE documents
     SET updated_at = ?
     WHERE id = ?
       AND status = 'draft'
       AND COALESCE(is_listed, 0) = 0
       AND COALESCE(requires_approval, 1) = 1`
  )
    .bind(eventAt, documentId)
    .run();

  return pass({
    document_id: documentId,
    touched_at: eventAt,
  });
}

async function buildCdasDryRunPreview(env, parsed) {
  const fields = parsed?.value?.fields || {};
  const storagePrefixId = fields.storage_prefix_id;

  const prefixResult = await getStoragePrefixForDryRun(env, storagePrefixId);

  if (!prefixResult.ok) {
    return prefixResult;
  }

  const objectKeysResult = buildCdasDryRunObjectKeyPreview(
    fields,
    prefixResult.value
  );

  if (!objectKeysResult.ok) {
    return objectKeysResult;
  }

  const hashEvidence = await buildDryRunHashEvidence(parsed);

  if (!hashEvidence.ok) {
    return hashEvidence;
  }

  const r2Absence = await buildDryRunR2AbsenceCheck(env, objectKeysResult.value);

  if (!r2Absence.ok) {
    return r2Absence;
  }

  const preview = {
    storage_prefix: prefixResult.value,
    object_key_preview: objectKeysResult.value,
    hash_evidence: hashEvidence.value,
    r2_absence_check: r2Absence.value,
  };

  const draftDocumentRecord = await buildCdasDraftDocumentRecordPreview(
    env,
    parsed,
    preview
  );

  if (!draftDocumentRecord.ok) {
    return draftDocumentRecord;
  }

  return pass({
    ...preview,
    draft_document_record: draftDocumentRecord.value,
  });
}

async function parseCdasDryRunMultipart(request) {
  return parseStrictUploadRequest(request, {
    domain: "cdas_document",
    uploadDomain: "cdas_document",
    upload_domain: "cdas_document",
    maxBytes: MAX_UPLOAD_BYTES,
  });
}

function buildRealWriteObjectKeys(objectKeyPreview) {
  return {
    source: objectKeyPreview.source_object_key,
    sha256: objectKeyPreview.sha256_object_key,
    metadata: objectKeyPreview.metadata_object_key,
  };
}

function buildUploadMetadata(fields, preview, uploadTransaction) {
  return {
    upload_domain: "cdas_document",
    upload_transaction_id: uploadTransaction.id,
    title: nullableText(fields.title),
    slug: nullableText(fields.slug),
    version: nullableText(fields.version),
    summary: nullableText(fields.summary),
    classification: nullableText(fields.classification),
    access_class: nullableText(fields.access_class),
    licence_terms_version: nullableText(fields.licence_terms_version),
    storage_prefix_id: preview.storage_prefix.id,
    storage_prefix: preview.storage_prefix.prefix,
    source_sha256: preview.hash_evidence.source_sha256,
    source_size: preview.hash_evidence.source_size,
    generated_at: nowIso(),
    publication_status: "not_published",
    licence_status: "not_created",
    download_link_status: "not_created",
    email_status: "not_sent",
  };
}

async function readUploadBytesForWrite(parsed) {
  const file = parsed?.value?.file;

  if (!file) {
    return fail(
      "upload_write_file_missing",
      "File is required before real-write upload can proceed."
    );
  }

  const bytes = await file.arrayBuffer();

  return pass(bytes);
}

function getClientRequestIdFromUpload(request, parsed) {
  const fields = parsed?.value?.fields || {};

  return (
    cleanText(fields.client_request_id) ||
    cleanText(request.headers.get("x-idempotency-key")) ||
    cleanText(request.headers.get("x-client-request-id"))
  );
}

function classifyCdasIdempotencyReplay(record) {
  if (!record) {
    return pass({
      replay: false,
      action: "create_new",
    });
  }

  const status = cleanText(record.status);

  if (IDEMPOTENCY_COMPLETED_STATUSES.has(status)) {
    return pass({
      replay: true,
      action: "return_existing_result",
      idempotency_status: status,
      upload_transaction_id: record.upload_transaction_id,
      message:
        "This upload request has already completed. No new transaction, R2 write, or document row creation will be attempted.",
    });
  }

  if (IDEMPOTENCY_RECOVERY_REQUIRED_STATUSES.has(status)) {
    return fail(
      "upload_idempotency_replay_recovery_required",
      "This upload request previously reached a recovery-required state. A blind retry is blocked.",
      {
        idempotency_status: status,
        upload_transaction_id: record.upload_transaction_id,
      }
    );
  }

  if (IDEMPOTENCY_IN_PROGRESS_STATUSES.has(status)) {
    return fail(
      "upload_idempotency_replay_in_progress",
      "This upload request is already in progress. A duplicate write is blocked.",
      {
        idempotency_status: status,
        upload_transaction_id: record.upload_transaction_id,
      }
    );
  }

  return fail(
    "upload_idempotency_replay_blocked",
    "This upload request key has already been used and cannot be safely replayed by this route.",
    {
      idempotency_status: status,
      upload_transaction_id: record.upload_transaction_id,
    }
  );
}

async function prepareCdasRealWriteIdempotency(request, env, parsed) {
  const clientRequestId = getClientRequestIdFromUpload(request, parsed);

  const lookup = await getIdempotencyRecordForClientKey(env, clientRequestId);

  if (!lookup.ok) {
    return lookup;
  }

  const replay = classifyCdasIdempotencyReplay(lookup.value.record);

  if (!replay.ok) {
    return replay;
  }

  return pass({
    client_request_id: clientRequestId,
    idempotency_key_hash: lookup.value.idempotency_key_hash,
    replay: replay.value.replay,
    replay_action: replay.value.action,
    replay_record: lookup.value.record || null,
    replay_decision: replay.value,
  });
}

async function recordCdasIdempotencyReplay(env, record, eventAt = nowIso()) {
  if (!record?.id || !env?.DB?.prepare) {
    return pass({
      recorded: false,
      reason: "idempotency_replay_record_not_available",
    });
  }

  await env.DB.prepare(
    `UPDATE upload_idempotency_keys
     SET replay_count = COALESCE(replay_count, 0) + 1,
         last_replayed_at = ?,
         updated_at = ?
     WHERE id = ?`
  )
    .bind(eventAt, eventAt, record.id)
    .run();

  return pass({
    recorded: true,
    idempotency_record_id: record.id,
    replayed_at: eventAt,
  });
}

async function createCdasIdempotencyRecordForTransaction(
  env,
  idempotency,
  transaction,
  eventAt = nowIso()
) {
  if (!env?.DB?.prepare) {
    return fail(
      "upload_idempotency_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const idempotencyKeyHash = cleanText(idempotency?.idempotency_key_hash);
  const transactionId = cleanText(transaction?.id);

  if (!idempotencyKeyHash) {
    return fail(
      "upload_idempotency_hash_missing",
      "Idempotency key hash is required."
    );
  }

  if (!transactionId) {
    return fail(
      "upload_idempotency_transaction_id_missing",
      "Upload transaction ID is required for idempotency recording."
    );
  }

  const id = buildUploadIdempotencyRecordId();
  const expiresAt = addHoursIso(eventAt, 24);

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
      id,
      idempotencyKeyHash,
      transactionId,
      "cdas_document",
      "in_progress",
      eventAt,
      eventAt,
      expiresAt,
      0,
      null,
      "Created by CDAS upload real-write route before controlled R2 write and draft document row creation."
    )
    .run();

  return pass({
    id,
    idempotency_key_hash: idempotencyKeyHash,
    upload_transaction_id: transactionId,
    upload_domain: "cdas_document",
    status: "in_progress",
    created_at: eventAt,
    updated_at: eventAt,
    expires_at: expiresAt,
  });
}

async function updateCdasIdempotencyStatus(
  env,
  idempotency,
  status,
  options = {}
) {
  if (!env?.DB?.prepare) {
    return fail(
      "upload_idempotency_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const idempotencyKeyHash = cleanText(idempotency?.idempotency_key_hash);
  const eventAt = cleanText(options.eventAt || nowIso());

  if (!idempotencyKeyHash) {
    return fail(
      "upload_idempotency_hash_missing",
      "Idempotency key hash is required."
    );
  }

  await env.DB.prepare(
    `UPDATE upload_idempotency_keys
     SET status = ?,
         updated_at = ?,
         notes = COALESCE(?, notes)
     WHERE idempotency_key_hash = ?`
  )
    .bind(
      cleanText(status),
      eventAt,
      nullableText(options.notes),
      idempotencyKeyHash
    )
    .run();

  return pass({
    idempotency_key_hash: idempotencyKeyHash,
    status: cleanText(status),
    updated_at: eventAt,
  });
}

async function createCdasUploadTransaction(
  request,
  env,
  parsed,
  preview,
  idempotency
) {
  const fields = parsed?.value?.fields || {};
  const file = parsed?.value?.file;
  const objectKeys = buildRealWriteObjectKeys(preview.object_key_preview);
  const eventAt = nowIso();

  const transaction = await createUploadTransaction(env, {
    uploadDomain: "cdas_document",
    uploadStatus: "started",
    relatedRecordType: "cdas_document_upload_candidate",
    relatedRecordId: safeSlug(fields.slug),
    originalFilename: file?.name || null,
    safeFilename: safeFilename(file?.name || "source.pdf"),
    mimeType: file?.type || "application/pdf",
    fileExtension: getFileExtension(file?.name || "source.pdf") || "pdf",
    sourceSize: preview.hash_evidence.source_size,
    sourceSha256: preview.hash_evidence.source_sha256,
    selectedPrefixId: preview.storage_prefix.id,
    selectedPrefix: preview.storage_prefix.prefix,
    intendedObjectKey: objectKeys.source,
    finalObjectKey: objectKeys.source,
    startedAt: eventAt,
    recoveryStatus: "none",
    adminActor: getAdminActor(request, env),
    userAgent: request.headers.get("user-agent") || null,
    requestId: getRequestId(request),
    idempotencyKeyHash: idempotency?.idempotency_key_hash || null,
    idempotencyExpiresAt: addHoursIso(eventAt, 24),
    notes:
      "Created by CDAS upload real-write route. Source object only; draft document row may be created after R2 write. Publication, licence creation, download link creation, and email are intentionally not performed by this route.",
  });

  if (!transaction.ok) {
    return transaction;
  }

  return pass({
    transaction: transaction.value,
    object_keys: objectKeys,
    event_at: eventAt,
  });
}

async function performCdasRealWrite(request, env, parsed, preview, idempotency) {
  const bytesResult = await readUploadBytesForWrite(parsed);

  if (!bytesResult.ok) {
    return bytesResult;
  }

  const transactionResult = await createCdasUploadTransaction(
    request,
    env,
    parsed,
    preview,
    idempotency
  );

  if (!transactionResult.ok) {
    return transactionResult;
  }

  const idempotencyRecord = await createCdasIdempotencyRecordForTransaction(
    env,
    idempotency,
    transactionResult.value.transaction,
    transactionResult.value.event_at
  );

  if (!idempotencyRecord.ok) {
    return fail(
      idempotencyRecord.error,
      idempotencyRecord.message,
      {
        transaction_created: true,
        upload_transaction_id: transactionResult.value.transaction.id,
        idempotency_details: idempotencyRecord.details || {},
        recovery_required: false,
      }
    );
  }

  const fields = parsed?.value?.fields || {};
  const file = parsed?.value?.file;
  const transaction = transactionResult.value.transaction;
  const objectKeys = transactionResult.value.object_keys;

  const orchestration = await orchestrateUploadR2Write(env, request, {
    uploadTransactionId: transaction.id,
    uploadDomain: "cdas_document",
    relatedRecordType: "cdas_document_upload_candidate",
    relatedRecordId: safeSlug(fields.slug),
    storagePrefixId: preview.storage_prefix.id,
    storagePrefix: preview.storage_prefix.prefix,
    objectKeys,
    bytes: bytesResult.value,
    sourceSha256: preview.hash_evidence.source_sha256,
    sourceSize: preview.hash_evidence.source_size,
    originalFilename: file?.name || null,
    safeFilename: safeFilename(file?.name || "source.pdf"),
    mimeType: file?.type || "application/pdf",
    fileExtension: getFileExtension(file?.name || "source.pdf") || "pdf",
    eventAt: transactionResult.value.event_at,
    metadata: buildUploadMetadata(fields, preview, transaction),
    notes:
      "CDAS source uploaded through real-write route. Draft document row creation may follow. Publication, licence generation, download-link creation, and email delivery remain separate gated workflows.",
  });

  if (!orchestration.ok) {
    await updateCdasIdempotencyStatus(
      env,
      idempotency,
      orchestration.details?.recovery_required
        ? "recovery_required"
        : "failed_before_r2",
      {
        eventAt: transactionResult.value.event_at,
        notes: orchestration.message || "Upload orchestration failed.",
      }
    );

    return fail(
      orchestration.error || "upload_real_write_orchestration_failed",
      orchestration.message || "Real-write upload orchestration failed.",
      {
        upload_transaction_id: transaction.id,
        transaction_created: true,
        recovery_required: Boolean(orchestration.details?.recovery_required),
        orchestration_details: orchestration.details || {},
        warnings: orchestration.warnings || [],
      }
    );
  }

  const draftDocumentRow = buildCdasDraftDocumentRow(
    fields,
    preview,
    transaction
  );

  const draftDocumentRecord = await insertCdasDraftDocumentRecord(
    env,
    draftDocumentRow
  );

  if (!draftDocumentRecord.ok) {
    await updateCdasIdempotencyStatus(
      env,
      idempotency,
      "recovery_required",
      {
        eventAt: transactionResult.value.event_at,
        notes:
          draftDocumentRecord.message ||
          "CDAS draft document record creation failed after R2 write.",
      }
    );

    const recoveryMark =
      await markUploadTransactionRecoveryRequiredForDocumentRecordFailure(
        env,
        transaction.id,
        draftDocumentRecord.message ||
          "CDAS draft document record creation failed after R2 write.",
        transactionResult.value.event_at
      );

    return fail(
      draftDocumentRecord.error || "upload_document_record_create_failed",
      draftDocumentRecord.message ||
        "CDAS draft document record creation failed after R2 write.",
      {
        upload_transaction_id: transaction.id,
        transaction_created: true,
        r2_write_completed: true,
        recovery_required: true,
        recovery_recorded: recoveryMark.ok === true,
        recovery_details: recoveryMark.value || null,
        document_record_details: draftDocumentRecord.details || {},
      }
    );
  }

  const idempotencyCompleted = await updateCdasIdempotencyStatus(
    env,
    idempotency,
    orchestration.value?.upload_status === "completed_with_warning"
      ? "completed_with_warning"
      : "completed",
    {
      eventAt: transactionResult.value.event_at,
      notes:
        "CDAS upload real-write completed and draft document record created.",
    }
  );
  
  const adminVisibility = buildCdasDraftAdminVisibilityEvidence(
    draftDocumentRecord.value,
    preview
  );

  return pass(
    {
      upload_transaction: transaction,
      draft_document_record: draftDocumentRecord.value,
      admin_visibility: adminVisibility,
      idempotency: {
        idempotency_key_hash: idempotency.idempotency_key_hash,
        status: idempotencyCompleted.ok
          ? idempotencyCompleted.value.status
          : "completion_update_failed",
        update_recorded: idempotencyCompleted.ok === true,
      },
      orchestration: orchestration.value,
      object_keys: objectKeys,
      source_sha256: preview.hash_evidence.source_sha256,
      source_size: preview.hash_evidence.source_size,
      document_status: "draft",
      document_is_listed: 0,
      document_requires_approval: 1,
      publication_status: "not_published",
      activation_status: "not_activated",
      requestability_status: "not_requestable",
      generated_pdf_status: "not_generated",
      licence_status: "not_created",
      download_link_status: "not_created",
      email_status: "not_sent",
    },
    orchestration.warnings || []
  );
}

async function handleCdasDocumentUploadSkeleton(request, env) {
  const switches = getUploadRouteSwitches(env);
  const routeMode = getUploadRouteMode(request);

  if (request.method === "GET") {
    return jsonResponse(buildCdasUploadRouteStatus(request, env));
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

  if (!switches.upload_route_skeleton_enabled) {
    return routeSkeletonDisabledResponse(request, env);
  }

  if (routeMode.real_write && !switches.upload_route_real_write_enabled) {
    return realWriteDisabledResponse(request, env);
  }

  if (!routeMode.dry_run && !routeMode.real_write) {
    return dryRunRequiredResponse(request, env);
  }

  if (routeMode.dry_run && !switches.upload_route_dry_run_enabled) {
    return dryRunDisabledResponse(request, env);
  }

  const parsed = await parseCdasDryRunMultipart(request);

  if (!parsed.ok) {
    return jsonResponse(
      {
        ...buildCdasUploadRouteStatus(request, env),
        ok: false,
        accepted: false,
        error: parsed.error,
        message: parsed.message,
        details: parsed.details || {},
        observed_request: buildObservedRequest(request),
        validation_stage: "strict_multipart_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  let idempotency = null;

  if (routeMode.real_write) {
    const idempotencyResult = await prepareCdasRealWriteIdempotency(
      request,
      env,
      parsed
    );

    if (!idempotencyResult.ok) {
      return jsonResponse(
        {
          ...buildCdasUploadRouteStatus(request, env),
          ok: false,
          accepted: false,
          error: idempotencyResult.error,
          message: idempotencyResult.message,
          details: idempotencyResult.details || {},
          observed_request: buildObservedRequest(request),
          validation_stage: "real_write_idempotency_preflight",
          parsed_upload: buildParsedUploadSummary(parsed),
          side_effects_confirmed: buildSideEffectsConfirmed(),
        },
        idempotencyResult.error === "idempotency_key_missing" ? 400 : 409
      );
    }

    idempotency = idempotencyResult.value;

    if (
      idempotency.replay &&
      idempotency.replay_action === "return_existing_result"
    ) {
      const replayRecorded = await recordCdasIdempotencyReplay(
        env,
        idempotency.replay_record,
        nowIso()
      );

      return jsonResponse(
        {
          ...buildCdasUploadRouteStatus(request, env),
          ok: true,
          accepted: true,
          idempotent_replay: true,
          message:
            "This upload request already completed. Existing upload transaction was returned and no new R2 write or document row creation was attempted.",
          validation_stage: "real_write_idempotency_replay",
          parsed_upload: buildParsedUploadSummary(parsed),
          replay: {
            action: idempotency.replay_action,
            idempotency_status: idempotency.replay_decision.idempotency_status,
            upload_transaction_id:
              idempotency.replay_decision.upload_transaction_id,
            replay_recorded: replayRecorded.ok === true,
          },
          side_effects_confirmed: buildSideEffectsConfirmed(),
        },
        200
      );
    }
  }

  const preview = await buildCdasDryRunPreview(env, parsed);

  if (!preview.ok) {
    return jsonResponse(
      {
        ...buildCdasUploadRouteStatus(request, env),
        ok: false,
        accepted: false,
        error: preview.error,
        message: preview.message,
        details: preview.details || {},
        observed_request: buildObservedRequest(request),
        validation_stage: routeMode.real_write
          ? "real_write_preflight"
          : "dry_run_r2_absence_check",
        parsed_upload: buildParsedUploadSummary(parsed),
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  if (routeMode.real_write) {
    const realWrite = await performCdasRealWrite(
      request,
      env,
      parsed,
      preview.value,
      idempotency
    );

    if (!realWrite.ok) {
      return jsonResponse(
        {
          ...buildCdasUploadRouteStatus(request, env),
          ok: false,
          accepted: false,
          error: realWrite.error,
          message: realWrite.message,
          details: realWrite.details || {},
          observed_request: buildObservedRequest(request),
          validation_stage: "real_write_transaction_orchestrator_draft_document",
          parsed_upload: buildParsedUploadSummary(parsed),
          dry_run_preview: preview.value,
          side_effects_confirmed: buildSideEffectsConfirmed({
            creates_upload_transaction:
              realWrite.details?.transaction_created === true,
            writes_r2:
              realWrite.details?.r2_write_completed === true ||
              Boolean(realWrite.details?.orchestration_details?.r2_write),
            creates_draft_cdas_document_record: false,
          }),
          warnings: realWrite.warnings || [],
        },
        realWrite.details?.recovery_required ? 500 : 409
      );
    }

    return jsonResponse(
      {
        ...buildCdasUploadRouteStatus(request, env),
        ok: true,
        accepted: true,
        message:
          "CDAS source upload completed and a draft document record was created. The document remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
        observed_request: buildObservedRequest(request),
        validation_stage: "real_write_transaction_orchestrator_draft_document",
        parsed_upload: buildParsedUploadSummary(parsed),
        upload_result: realWrite.value,
        side_effects_confirmed: buildSideEffectsConfirmed({
          creates_upload_transaction: true,
          writes_r2: true,
          creates_draft_cdas_document_record: true,
        }),
        warnings: realWrite.warnings || [],
        next_gate:
          "U3-L should add admin review actions for approving, rejecting, or holding the uploaded draft without making it public automatically.",
      },
      201
    );
  }

  return jsonResponse(
    {
      ...buildCdasUploadRouteStatus(request, env),
      ok: true,
      accepted: true,
      message:
        "CDAS upload dry-run validation passed. Prefix, object keys, hash evidence, R2 absence, and draft document row preflight were checked. No upload action was performed.",
      observed_request: buildObservedRequest(request),
      validation_stage: "dry_run_r2_absence_and_draft_document_preflight",
      parsed_upload: buildParsedUploadSummary(parsed),
      dry_run_preview: preview.value,
      side_effects_confirmed: buildSideEffectsConfirmed(),
      next_gate:
        "U3-L should add admin review actions for approving, rejecting, or holding the uploaded draft without making it public automatically.",
    },
    200
  );
}

async function handleCdasDraftReviewAction(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/review",
      route_status: "cdas_draft_review_action_gate",
      upload_domain: "cdas_document",
      allowed_actions: Array.from(VALID_CDAS_DRAFT_REVIEW_ACTIONS),
      switches,
      policy: {
        admin_only: true,
        review_actions_enabled: envEnabled(env.CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED),
        document_must_be_draft: true,
        document_must_be_unlisted: true,
        document_must_require_approval: true,
        activates_document: false,
        publishes_document: false,
        makes_document_requestable: false,
        generates_pdf: false,
        creates_licence: false,
        creates_download_link: false,
        sends_email: false,
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

  if (!envEnabled(env.CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "upload_review_actions_disabled",
        message:
          "CDAS upload draft review actions are disabled by policy. No review action was recorded.",
        required_switch: "CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED=true",
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
        validation_stage: "review_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const actionResult = validateCdasDraftReviewAction(body.action);

  if (!actionResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: actionResult.error,
        message: actionResult.message,
        details: actionResult.details || {},
        validation_stage: "review_action_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const documentResult = await getCdasDraftDocumentForReview(
    env,
    body.document_id
  );

  if (!documentResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: documentResult.error,
        message: documentResult.message,
        details: documentResult.details || {},
        validation_stage: "review_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const action = actionResult.value;
  const document = documentResult.value;
  const outcome = buildCdasReviewOutcome(action);
  const eventAt = nowIso();

  const reviewEvent = await insertCdasUploadReviewEvent(env, {
    documentId: document.id,
    uploadTransactionId: body.upload_transaction_id || null,
    reviewAction: action,
    previousDocumentStatus: document.status,
    resultingDocumentStatus: outcome.resulting_document_status,
    reviewNotes: body.review_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    eventAt,
  });

  if (!reviewEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: reviewEvent.error,
        message: reviewEvent.message,
        details: reviewEvent.details || {},
        validation_stage: "review_event_insert",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const touched = await touchCdasDraftDocumentAfterReview(
    env,
    document.id,
    eventAt
  );

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message: outcome.message,
      route: "/api/admin/uploads/cdas-document/review",
      validation_stage: "cdas_draft_review_action",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        status: document.status,
        is_listed: Number(document.is_listed ?? 0),
        requires_approval: Number(document.requires_approval ?? 1),
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
      },
      review: {
        action,
        review_state: outcome.review_state,
        event: reviewEvent.value,
        document_touched: touched.ok === true,
        next_allowed_gate: outcome.next_allowed_gate,
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
      }),
      public_visibility: {
        listed_publicly: false,
        requestable_publicly: false,
        downloadable_publicly: false,
        public_url_created: false,
      },
      prohibited_side_effects: {
        activated: false,
        generated_pdf_created: false,
        licence_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    200
  );
}

async function handleCdasActivationPreparation(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/activation-prep",
      route_status: "cdas_activation_preparation_gate",
      upload_domain: "cdas_document",
      switches,
      policy: {
        admin_only: true,
        activation_prep_enabled: envEnabled(
          env.CDAS_UPLOAD_ACTIVATION_PREP_ENABLED
        ),
        requires_review_action: "approve_for_activation_prep",
        document_must_be_draft: true,
        document_must_be_unlisted: true,
        document_must_require_approval: true,
        creates_activation_prep_event: true,
        activates_document: false,
        publishes_document: false,
        makes_document_requestable: false,
        generates_pdf: false,
        creates_licence: false,
        creates_download_link: false,
        sends_email: false,
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

  if (!envEnabled(env.CDAS_UPLOAD_ACTIVATION_PREP_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "activation_prep_disabled",
        message:
          "CDAS upload activation preparation is disabled by policy. No activation preparation event was recorded.",
        required_switch: "CDAS_UPLOAD_ACTIVATION_PREP_ENABLED=true",
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
        validation_stage: "activation_prep_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const documentId = cleanText(body.document_id);

  const documentResult = await getCdasDraftDocumentForActivationPrep(
    env,
    documentId
  );

  if (!documentResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: documentResult.error,
        message: documentResult.message,
        details: documentResult.details || {},
        validation_stage: "activation_prep_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const reviewResult = await getLatestActivationPrepReviewEvent(
    env,
    documentId
  );

  if (!reviewResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: reviewResult.error,
        message: reviewResult.message,
        details: reviewResult.details || {},
        validation_stage: "activation_prep_review_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const existingPrep = await getExistingActivationPrepEvent(env, documentId);

  if (!existingPrep.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: existingPrep.error,
        message: existingPrep.message,
        details: existingPrep.details || {},
        validation_stage: "activation_prep_existing_check",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  if (existingPrep.value) {
    return jsonResponse(
      {
        ok: true,
        accepted: true,
        idempotent_replay: true,
        message:
          "This draft document has already been prepared for activation. No new activation preparation event was created.",
        validation_stage: "activation_prep_existing_replay",
        existing_activation_prep_event: existingPrep.value,
        side_effects_confirmed: buildSideEffectsConfirmed(),
        public_visibility: {
          listed_publicly: false,
          requestable_publicly: false,
          downloadable_publicly: false,
          public_url_created: false,
        },
        prohibited_side_effects: {
          activated: false,
          generated_pdf_created: false,
          licence_created: false,
          download_link_created: false,
          email_sent: false,
        },
      },
      200
    );
  }

  const document = documentResult.value;
  const reviewEvent = reviewResult.value;
  const eventAt = nowIso();

  const prepEvent = await insertCdasActivationPrepEvent(env, {
    documentId: document.id,
    uploadTransactionId: reviewEvent.upload_transaction_id || null,
    reviewEventId: reviewEvent.id,
    prepStatus: "prepared",
    previousDocumentStatus: document.status,
    resultingDocumentStatus: "draft",
    prepNotes: body.prep_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    sourceObject: document.source_object,
    sourceSha256: document.source_sha256,
    eventAt,
  });

  if (!prepEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: prepEvent.error,
        message: prepEvent.message,
        details: prepEvent.details || {},
        validation_stage: "activation_prep_event_insert",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const touched = await touchCdasDraftDocumentAfterActivationPrep(
    env,
    document.id,
    eventAt
  );

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message:
        "Draft document was prepared for a later activation workflow. It remains draft, unlisted, not requestable, not downloadable, not licensed, and no email was sent.",
      route: "/api/admin/uploads/cdas-document/activation-prep",
      validation_stage: "cdas_activation_preparation",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        status: document.status,
        is_listed: Number(document.is_listed ?? 0),
        requires_approval: Number(document.requires_approval ?? 1),
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
        licence_terms_version: document.licence_terms_version || null,
        classification: document.classification || null,
        access_class: document.access_class || null,
      },
      review_event: {
        id: reviewEvent.id,
        review_action: reviewEvent.review_action,
        created_at: reviewEvent.created_at,
      },
      activation_preparation: {
        event: prepEvent.value,
        document_touched: touched.ok === true,
        next_allowed_gate:
          "U3-N — CDAS Explicit Activation Gate",
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
      }),
      public_visibility: {
        listed_publicly: false,
        requestable_publicly: false,
        downloadable_publicly: false,
        public_url_created: false,
      },
      prohibited_side_effects: {
        activated: false,
        generated_pdf_created: false,
        licence_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    200
  );
}

async function handleCdasExplicitActivation(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/activate",
      route_status: "cdas_explicit_activation_gate",
      upload_domain: "cdas_document",
      switches,
      policy: {
        admin_only: true,
        explicit_activation_enabled: envEnabled(
          env.CDAS_UPLOAD_EXPLICIT_ACTIVATION_ENABLED
        ),
        requires_activation_prep_event: true,
        document_must_be_draft: true,
        document_must_be_unlisted: true,
        document_must_require_approval: true,
        changes_document_status_to_active: true,
        keeps_document_unlisted: true,
        keeps_approval_required: true,
        publishes_document: false,
        makes_document_requestable: false,
        generates_pdf: false,
        creates_licence: false,
        creates_download_link: false,
        sends_email: false,
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

  if (!envEnabled(env.CDAS_UPLOAD_EXPLICIT_ACTIVATION_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "explicit_activation_disabled",
        message:
          "CDAS upload explicit activation is disabled by policy. No document status was changed.",
        required_switch: "CDAS_UPLOAD_EXPLICIT_ACTIVATION_ENABLED=true",
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
        validation_stage: "explicit_activation_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const documentId = cleanText(body.document_id);

  const documentResult = await getCdasDraftDocumentForExplicitActivation(
    env,
    documentId
  );

  if (!documentResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: documentResult.error,
        message: documentResult.message,
        details: documentResult.details || {},
        validation_stage: "explicit_activation_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const prepResult = await getLatestActivationPrepEvent(env, documentId);

  if (!prepResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: prepResult.error,
        message: prepResult.message,
        details: prepResult.details || {},
        validation_stage: "explicit_activation_prep_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const existingActivation = await getExistingCdasActivationEvent(
    env,
    documentId
  );

  if (!existingActivation.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: existingActivation.error,
        message: existingActivation.message,
        details: existingActivation.details || {},
        validation_stage: "explicit_activation_existing_check",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  if (existingActivation.value) {
    return jsonResponse(
      {
        ok: true,
        accepted: true,
        idempotent_replay: true,
        message:
          "This document has already been explicitly activated. No new activation event was created.",
        validation_stage: "explicit_activation_existing_replay",
        existing_activation_event: existingActivation.value,
        side_effects_confirmed: buildSideEffectsConfirmed({
          activates_document: false,
        }),
        public_visibility: {
          listed_publicly: false,
          requestable_publicly: false,
          downloadable_publicly: false,
          public_url_created: false,
        },
        prohibited_side_effects: {
          generated_pdf_created: false,
          licence_created: false,
          download_link_created: false,
          email_sent: false,
        },
      },
      200
    );
  }

  const document = documentResult.value;
  const prepEvent = prepResult.value;
  const eventAt = nowIso();

  const activationUpdate = await activateCdasDraftDocumentRecord(
    env,
    document.id,
    eventAt
  );

  if (!activationUpdate.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: activationUpdate.error,
        message: activationUpdate.message,
        details: activationUpdate.details || {},
        validation_stage: "explicit_activation_document_update",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const activationEvent = await insertCdasActivationEvent(env, {
    documentId: document.id,
    uploadTransactionId: prepEvent.upload_transaction_id || null,
    reviewEventId: prepEvent.review_event_id || null,
    activationPrepEventId: prepEvent.id,
    previousDocumentStatus: document.status,
    activationNotes: body.activation_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    sourceObject: document.source_object,
    sourceSha256: document.source_sha256,
    eventAt,
  });

  if (!activationEvent.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: activationEvent.error,
        message: activationEvent.message,
        details: activationEvent.details || {},
        validation_stage: "explicit_activation_event_insert",
        side_effects_confirmed: buildSideEffectsConfirmed({
          activates_document: true,
        }),
        recovery_required: true,
        recovery_note:
          "Document status was updated to active but activation event insertion failed. Manual review is required.",
      },
      500
    );
  }

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      message:
        "CDAS document was explicitly activated. It remains unlisted, approval-required, not publicly requestable, not downloadable, not licensed, and no email was sent.",
      route: "/api/admin/uploads/cdas-document/activate",
      validation_stage: "cdas_explicit_activation",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        previous_status: document.status,
        resulting_status: "active",
        is_listed: 0,
        requires_approval: 1,
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
        licence_terms_version: document.licence_terms_version || null,
        classification: document.classification || null,
        access_class: document.access_class || null,
      },
      activation_preparation_event: {
        id: prepEvent.id,
        prep_status: prepEvent.prep_status,
        created_at: prepEvent.created_at,
      },
      activation: {
        event: activationEvent.value,
        update: activationUpdate.value,
        next_allowed_gate:
          "U3-O — CDAS Controlled Listing and Requestability Gate",
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
        activates_document: true,
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
      }),
      public_visibility: {
        listed_publicly: false,
        requestable_publicly: false,
        downloadable_publicly: false,
        public_url_created: false,
      },
      prohibited_side_effects: {
        generated_pdf_created: false,
        licence_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    200
  );
}

async function handleCdasControlledListingRequestability(request, env) {
  const switches = getUploadRouteSwitches(env);

  if (request.method === "GET") {
    return jsonResponse({
      ok: true,
      route: "/api/admin/uploads/cdas-document/listing-requestability",
      route_status: "cdas_controlled_listing_requestability_gate",
      upload_domain: "cdas_document",
      switches,
      allowed_actions: Array.from(VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS),
      policy: {
        admin_only: true,
        listing_requestability_enabled: envEnabled(
          env.CDAS_UPLOAD_LISTING_REQUESTABILITY_ENABLED
        ),
        requires_explicit_activation: true,
        document_must_be_active: true,
        requires_approval_must_remain_enabled: true,
        may_set_is_listed: true,
        may_set_requestability_status: true,
        direct_downloadable: false,
        generates_pdf: false,
        creates_licence: false,
        creates_download_link: false,
        sends_email: false,
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

  if (!envEnabled(env.CDAS_UPLOAD_LISTING_REQUESTABILITY_ENABLED)) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: "listing_requestability_disabled",
        message:
          "CDAS controlled listing/requestability is disabled by policy. No document visibility state was changed.",
        required_switch: "CDAS_UPLOAD_LISTING_REQUESTABILITY_ENABLED=true",
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
        validation_stage: "listing_requestability_json_parse",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const body = bodyResult.value || {};
  const actionResult = validateCdasListingRequestabilityAction(body.action);

  if (!actionResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: actionResult.error,
        message: actionResult.message,
        details: actionResult.details || {},
        validation_stage: "listing_requestability_action_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
  }

  const documentId = cleanText(body.document_id);
  const documentResult = await getCdasActiveDocumentForListingRequestability(
    env,
    documentId
  );

  if (!documentResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: documentResult.error,
        message: documentResult.message,
        details: documentResult.details || {},
        validation_stage: "listing_requestability_document_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const activationResult = await getLatestCdasActivationEvent(
    env,
    documentId
  );

  if (!activationResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: activationResult.error,
        message: activationResult.message,
        details: activationResult.details || {},
        validation_stage: "listing_requestability_activation_validation",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  const action = actionResult.value;
  const document = documentResult.value;
  const activationEvent = activationResult.value;
  const outcome = buildCdasListingRequestabilityOutcome(action, document);
  const eventAt = nowIso();

  const updateResult = await updateCdasDocumentListingRequestability(
    env,
    document.id,
    outcome,
    eventAt
  );

  if (!updateResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: updateResult.error,
        message: updateResult.message,
        details: updateResult.details || {},
        validation_stage: "listing_requestability_document_update",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      500
    );
  }

  const eventResult = await insertCdasListingRequestabilityEvent(env, {
    documentId: document.id,
    activationEventId: activationEvent.id,
    action,
    previousDocumentStatus: document.status,
    resultingDocumentStatus: "active",
    previousIsListed: Number(document.is_listed ?? 0),
    resultingIsListed: outcome.resulting_is_listed,
    previousRequestabilityStatus:
      document.requestability_status || "not_requestable",
    resultingRequestabilityStatus: outcome.resulting_requestability_status,
    publicVisibilityCreated: outcome.public_visibility_created,
    documentRequestable: outcome.document_requestable,
    actionNotes: body.action_notes,
    adminActor: getAdminActor(request, env),
    requestId: getRequestId(request),
    eventAt,
  });

  if (!eventResult.ok) {
    return jsonResponse(
      {
        ok: false,
        accepted: false,
        error: eventResult.error,
        message: eventResult.message,
        details: eventResult.details || {},
        validation_stage: "listing_requestability_event_insert",
        recovery_required: true,
        recovery_note:
          "Document listing/requestability state was updated but event insertion failed. Manual review is required.",
        side_effects_confirmed: buildSideEffectsConfirmed({
          public_visibility_created:
            outcome.public_visibility_created === 1,
          makes_document_requestable:
            outcome.document_requestable === 1,
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
      route: "/api/admin/uploads/cdas-document/listing-requestability",
      validation_stage: "cdas_controlled_listing_requestability",
      document: {
        id: document.id,
        slug: document.slug,
        title: document.title,
        version: document.version,
        status: "active",
        previous_is_listed: Number(document.is_listed ?? 0),
        resulting_is_listed: outcome.resulting_is_listed,
        previous_requestability_status:
          document.requestability_status || "not_requestable",
        resulting_requestability_status:
          outcome.resulting_requestability_status,
        requires_approval: 1,
        source_object: document.source_object || null,
        source_sha256: document.source_sha256 || null,
        licence_terms_version: document.licence_terms_version || null,
        classification: document.classification || null,
        access_class: document.access_class || null,
      },
      activation_event: {
        id: activationEvent.id,
        activation_status: activationEvent.activation_status,
        created_at: activationEvent.created_at,
      },
      listing_requestability: {
        event: eventResult.value,
        update: updateResult.value,
        next_allowed_gate:
          action === "enable_requestability"
            ? "U3-P — CDAS Controlled Access Request Intake Gate"
            : "U3-O remains available for later listing/requestability changes",
      },
      side_effects_confirmed: buildSideEffectsConfirmed({
        public_visibility_created:
          outcome.public_visibility_created === 1,
        makes_document_requestable:
          outcome.document_requestable === 1,
        creates_upload_transaction: false,
        writes_r2: false,
        creates_draft_cdas_document_record: false,
      }),
      public_visibility: {
        listed_publicly: outcome.resulting_is_listed === 1,
        requestable_publicly:
          outcome.resulting_requestability_status ===
          "requestable_with_approval",
        directly_downloadable_publicly: false,
        public_url_created: false,
      },
      prohibited_side_effects: {
        generated_pdf_created: false,
        licence_created: false,
        download_link_created: false,
        email_sent: false,
      },
    },
    200
  );
}

function buildCdasActivationPrepEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `cape_${random.replaceAll("-", "")}`;
}

async function getLatestActivationPrepReviewEvent(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_prep_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_action,
       previous_document_status,
       resulting_document_status,
       review_notes,
       admin_actor,
       request_id,
       public_visibility_created,
       licence_created,
       download_link_created,
       email_sent,
       document_activated,
       generated_pdf_created,
       created_at
     FROM cdas_upload_review_events
     WHERE document_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "activation_prep_review_event_missing",
      "No upload review event was found for this draft document.",
      {
        document_id: id,
      }
    );
  }

  if (row.review_action !== "approve_for_activation_prep") {
    return fail(
      "activation_prep_review_not_approved",
      "The latest upload review event does not approve this draft for activation preparation.",
      {
        document_id: id,
        latest_review_action: row.review_action,
        latest_review_event_id: row.id,
      }
    );
  }

  if (
    Number(row.public_visibility_created ?? 0) !== 0 ||
    Number(row.licence_created ?? 0) !== 0 ||
    Number(row.download_link_created ?? 0) !== 0 ||
    Number(row.email_sent ?? 0) !== 0 ||
    Number(row.document_activated ?? 0) !== 0 ||
    Number(row.generated_pdf_created ?? 0) !== 0
  ) {
    return fail(
      "activation_prep_review_event_impure",
      "The upload review event contains prohibited side effects and cannot be used for activation preparation.",
      {
        review_event_id: row.id,
        public_visibility_created: row.public_visibility_created,
        licence_created: row.licence_created,
        download_link_created: row.download_link_created,
        email_sent: row.email_sent,
        document_activated: row.document_activated,
        generated_pdf_created: row.generated_pdf_created,
      }
    );
  }

  return pass(row);
}

async function getCdasDraftDocumentForActivationPrep(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_prep_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       is_listed,
       requires_approval,
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
      "activation_prep_document_not_found",
      "Draft document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "draft") {
    return fail(
      "activation_prep_document_not_draft",
      "Only draft documents can enter activation preparation through this gate.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.is_listed ?? 0) !== 0) {
    return fail(
      "activation_prep_document_is_listed",
      "Listed documents cannot enter activation preparation through this upload gate.",
      {
        document_id: row.id,
        is_listed: row.is_listed,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "activation_prep_document_does_not_require_approval",
      "This document does not appear to be an approval-required upload draft.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  if (!cleanText(row.source_object)) {
    return fail(
      "activation_prep_source_object_missing",
      "Draft document does not have a source object.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.source_sha256)) {
    return fail(
      "activation_prep_source_sha256_missing",
      "Draft document does not have source SHA-256 evidence.",
      {
        document_id: row.id,
      }
    );
  }

  return pass(row);
}

async function getExistingActivationPrepEvent(env, documentId) {
  if (!env?.DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       prep_status,
       created_at
     FROM cdas_activation_prep_events
     WHERE document_id = ?
       AND prep_status = 'prepared'
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(cleanText(documentId))
    .first();

  return pass(row || null);
}

async function insertCdasActivationPrepEvent(env, options = {}) {
  if (!env?.DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasActivationPrepEventId();

  await env.DB.prepare(
    `INSERT INTO cdas_activation_prep_events (
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       prep_status,
       previous_document_status,
       resulting_document_status,
       prep_notes,
       admin_actor,
       request_id,
       source_object,
       source_sha256,
       public_visibility_created,
       document_activated,
       document_published,
       document_requestable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.documentId,
      options.uploadTransactionId || null,
      options.reviewEventId || null,
      options.prepStatus || "prepared",
      options.previousDocumentStatus || "draft",
      options.resultingDocumentStatus || "draft",
      nullableText(options.prepNotes),
      nullableText(options.adminActor),
      nullableText(options.requestId),
      nullableText(options.sourceObject),
      nullableText(options.sourceSha256),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      eventAt
    )
    .run();

  return pass({
    id,
    document_id: options.documentId,
    upload_transaction_id: options.uploadTransactionId || null,
    review_event_id: options.reviewEventId || null,
    prep_status: options.prepStatus || "prepared",
    previous_document_status: options.previousDocumentStatus || "draft",
    resulting_document_status: options.resultingDocumentStatus || "draft",
    source_object: options.sourceObject || null,
    source_sha256: options.sourceSha256 || null,
    public_visibility_created: 0,
    document_activated: 0,
    document_published: 0,
    document_requestable: 0,
    generated_pdf_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    created_at: eventAt,
  });
}

async function touchCdasDraftDocumentAfterActivationPrep(
  env,
  documentId,
  eventAt = nowIso()
) {
  if (!env?.DB?.prepare) {
    return fail(
      "activation_prep_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  await env.DB.prepare(
    `UPDATE documents
     SET updated_at = ?
     WHERE id = ?
       AND status = 'draft'
       AND COALESCE(is_listed, 0) = 0
       AND COALESCE(requires_approval, 1) = 1`
  )
    .bind(eventAt, documentId)
    .run();

  return pass({
    document_id: documentId,
    touched_at: eventAt,
  });
}

function buildCdasActivationEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `cact_${random.replaceAll("-", "")}`;
}

async function getLatestActivationPrepEvent(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       prep_status,
       previous_document_status,
       resulting_document_status,
       source_object,
       source_sha256,
       public_visibility_created,
       document_activated,
       document_published,
       document_requestable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     FROM cdas_activation_prep_events
     WHERE document_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "activation_prep_event_missing",
      "No activation preparation event was found for this document.",
      {
        document_id: id,
      }
    );
  }

  if (row.prep_status !== "prepared") {
    return fail(
      "activation_prep_not_prepared",
      "The latest activation preparation event does not permit activation.",
      {
        document_id: id,
        activation_prep_event_id: row.id,
        prep_status: row.prep_status,
      }
    );
  }

  if (
    Number(row.public_visibility_created ?? 0) !== 0 ||
    Number(row.document_activated ?? 0) !== 0 ||
    Number(row.document_published ?? 0) !== 0 ||
    Number(row.document_requestable ?? 0) !== 0 ||
    Number(row.generated_pdf_created ?? 0) !== 0 ||
    Number(row.licence_created ?? 0) !== 0 ||
    Number(row.download_link_created ?? 0) !== 0 ||
    Number(row.email_sent ?? 0) !== 0
  ) {
    return fail(
      "activation_prep_event_impure",
      "The activation preparation event contains prohibited side effects and cannot be used for explicit activation.",
      {
        activation_prep_event_id: row.id,
        public_visibility_created: row.public_visibility_created,
        document_activated: row.document_activated,
        document_published: row.document_published,
        document_requestable: row.document_requestable,
        generated_pdf_created: row.generated_pdf_created,
        licence_created: row.licence_created,
        download_link_created: row.download_link_created,
        email_sent: row.email_sent,
      }
    );
  }

  return pass(row);
}

async function getCdasDraftDocumentForExplicitActivation(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "activation_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       is_listed,
       requires_approval,
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
      "activation_document_not_found",
      "Draft document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "draft") {
    return fail(
      "activation_document_not_draft",
      "Only draft documents can be explicitly activated through this gate.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.is_listed ?? 0) !== 0) {
    return fail(
      "activation_document_is_listed",
      "Listed documents cannot be handled through this upload activation gate.",
      {
        document_id: row.id,
        is_listed: row.is_listed,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "activation_document_does_not_require_approval",
      "This document does not appear to be an approval-required upload draft.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  if (!cleanText(row.source_object)) {
    return fail(
      "activation_source_object_missing",
      "Draft document does not have a source object.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.source_sha256)) {
    return fail(
      "activation_source_sha256_missing",
      "Draft document does not have source SHA-256 evidence.",
      {
        document_id: row.id,
      }
    );
  }

  return pass(row);
}

async function getExistingCdasActivationEvent(env, documentId) {
  if (!env?.DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       activation_prep_event_id,
       activation_status,
       previous_document_status,
       resulting_document_status,
       source_object,
       source_sha256,
       created_at
     FROM cdas_activation_events
     WHERE document_id = ?
       AND activation_status = 'activated'
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(cleanText(documentId))
    .first();

  return pass(row || null);
}

async function insertCdasActivationEvent(env, options = {}) {
  if (!env?.DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasActivationEventId();

  await env.DB.prepare(
    `INSERT INTO cdas_activation_events (
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       activation_prep_event_id,
       activation_status,
       previous_document_status,
       resulting_document_status,
       activation_notes,
       admin_actor,
       request_id,
       source_object,
       source_sha256,
       public_visibility_created,
       document_activated,
       document_published,
       document_requestable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.documentId,
      options.uploadTransactionId || null,
      options.reviewEventId || null,
      options.activationPrepEventId || null,
      "activated",
      options.previousDocumentStatus || "draft",
      "active",
      nullableText(options.activationNotes),
      nullableText(options.adminActor),
      nullableText(options.requestId),
      nullableText(options.sourceObject),
      nullableText(options.sourceSha256),
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      eventAt
    )
    .run();

  return pass({
    id,
    document_id: options.documentId,
    upload_transaction_id: options.uploadTransactionId || null,
    review_event_id: options.reviewEventId || null,
    activation_prep_event_id: options.activationPrepEventId || null,
    activation_status: "activated",
    previous_document_status: options.previousDocumentStatus || "draft",
    resulting_document_status: "active",
    source_object: options.sourceObject || null,
    source_sha256: options.sourceSha256 || null,
    public_visibility_created: 0,
    document_activated: 1,
    document_published: 0,
    document_requestable: 0,
    generated_pdf_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    created_at: eventAt,
  });
}

async function activateCdasDraftDocumentRecord(
  env,
  documentId,
  eventAt = nowIso()
) {
  if (!env?.DB?.prepare) {
    return fail(
      "activation_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const result = await env.DB.prepare(
    `UPDATE documents
     SET status = 'active',
         updated_at = ?
     WHERE id = ?
       AND status = 'draft'
       AND COALESCE(is_listed, 0) = 0
       AND COALESCE(requires_approval, 1) = 1`
  )
    .bind(eventAt, documentId)
    .run();

  return pass({
    document_id: documentId,
    previous_status: "draft",
    resulting_status: "active",
    is_listed: 0,
    requires_approval: 1,
    updated_at: eventAt,
    changes: result?.meta?.changes ?? null,
  });
}

const VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS = new Set([
  "list_only",
  "enable_requestability",
  "disable_requestability",
  "unlist",
]);

function buildCdasListingRequestabilityEventId() {
  const random =
    crypto.randomUUID?.() ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  return `clre_${random.replaceAll("-", "")}`;
}

function normaliseListingRequestabilityAction(value) {
  return cleanText(value).toLowerCase();
}

function validateCdasListingRequestabilityAction(action) {
  const cleanAction = normaliseListingRequestabilityAction(action);

  if (!VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS.has(cleanAction)) {
    return fail(
      "listing_requestability_action_invalid",
      "CDAS listing/requestability action is not recognised.",
      {
        allowed_actions: Array.from(VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS),
        received_action: cleanAction,
      }
    );
  }

  return pass(cleanAction);
}

async function getLatestCdasActivationEvent(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "listing_requestability_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       document_id,
       upload_transaction_id,
       review_event_id,
       activation_prep_event_id,
       activation_status,
       previous_document_status,
       resulting_document_status,
       public_visibility_created,
       document_published,
       document_requestable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     FROM cdas_activation_events
     WHERE document_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(id)
    .first();

  if (!row) {
    return fail(
      "listing_requestability_activation_event_missing",
      "No explicit activation event was found for this document.",
      {
        document_id: id,
      }
    );
  }

  if (row.activation_status !== "activated") {
    return fail(
      "listing_requestability_activation_not_activated",
      "The latest activation event does not permit controlled listing or requestability.",
      {
        document_id: id,
        activation_event_id: row.id,
        activation_status: row.activation_status,
      }
    );
  }

  if (
    Number(row.public_visibility_created ?? 0) !== 0 ||
    Number(row.document_published ?? 0) !== 0 ||
    Number(row.document_requestable ?? 0) !== 0 ||
    Number(row.generated_pdf_created ?? 0) !== 0 ||
    Number(row.licence_created ?? 0) !== 0 ||
    Number(row.download_link_created ?? 0) !== 0 ||
    Number(row.email_sent ?? 0) !== 0
  ) {
    return fail(
      "listing_requestability_activation_event_impure",
      "The activation event contains prohibited side effects and cannot be used for controlled listing/requestability.",
      {
        activation_event_id: row.id,
        public_visibility_created: row.public_visibility_created,
        document_published: row.document_published,
        document_requestable: row.document_requestable,
        generated_pdf_created: row.generated_pdf_created,
        licence_created: row.licence_created,
        download_link_created: row.download_link_created,
        email_sent: row.email_sent,
      }
    );
  }

  return pass(row);
}

async function getCdasActiveDocumentForListingRequestability(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
    return fail(
      "listing_requestability_document_id_missing",
      "Document ID is required."
    );
  }

  if (!env?.DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const row = await env.DB.prepare(
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
      "listing_requestability_document_not_found",
      "Active document could not be found.",
      {
        document_id: id,
      }
    );
  }

  if (row.status !== "active") {
    return fail(
      "listing_requestability_document_not_active",
      "Only active documents can enter controlled listing/requestability.",
      {
        document_id: row.id,
        status: row.status,
      }
    );
  }

  if (Number(row.requires_approval ?? 1) !== 1) {
    return fail(
      "listing_requestability_document_does_not_require_approval",
      "Controlled requestability requires approval to remain enabled.",
      {
        document_id: row.id,
        requires_approval: row.requires_approval,
      }
    );
  }

  if (!cleanText(row.source_object)) {
    return fail(
      "listing_requestability_source_object_missing",
      "Active document does not have a source object.",
      {
        document_id: row.id,
      }
    );
  }

  if (!cleanText(row.source_sha256)) {
    return fail(
      "listing_requestability_source_sha256_missing",
      "Active document does not have source SHA-256 evidence.",
      {
        document_id: row.id,
      }
    );
  }

  return pass(row);
}

function buildCdasListingRequestabilityOutcome(action, document) {
  const currentListed = Number(document.is_listed ?? 0);
  const currentRequestability = cleanText(
    document.requestability_status || "not_requestable"
  );

  if (action === "list_only") {
    return {
      resulting_is_listed: 1,
      resulting_requestability_status: "not_requestable",
      public_visibility_created: currentListed === 1 ? 0 : 1,
      document_requestable: 0,
      message:
        "Document was listed for controlled visibility only. It is not requestable, not downloadable, not licensed, and no email was sent.",
    };
  }

  if (action === "enable_requestability") {
    return {
      resulting_is_listed: 1,
      resulting_requestability_status: "requestable_with_approval",
      public_visibility_created: currentListed === 1 ? 0 : 1,
      document_requestable:
        currentRequestability === "requestable_with_approval" ? 0 : 1,
      message:
        "Document was made requestable with approval required. It is not directly downloadable, not licensed, and no email was sent.",
    };
  }

  if (action === "disable_requestability") {
    return {
      resulting_is_listed: currentListed,
      resulting_requestability_status: "not_requestable",
      public_visibility_created: 0,
      document_requestable: 0,
      message:
        "Document requestability was disabled. Listing state was preserved. No licence, download link, generated PDF, or email was created.",
    };
  }

  return {
    resulting_is_listed: 0,
    resulting_requestability_status: "not_requestable",
    public_visibility_created: 0,
    document_requestable: 0,
    message:
      "Document was unlisted and made not requestable. No licence, download link, generated PDF, or email was created.",
  };
}

async function updateCdasDocumentListingRequestability(
  env,
  documentId,
  outcome,
  eventAt = nowIso()
) {
  if (!env?.DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  await env.DB.prepare(
    `UPDATE documents
     SET is_listed = ?,
         requestability_status = ?,
         listed_at = CASE
           WHEN ? = 1 AND COALESCE(is_listed, 0) = 0 THEN ?
           WHEN ? = 0 THEN NULL
           ELSE listed_at
         END,
         requestable_at = CASE
           WHEN ? = 'requestable_with_approval'
             AND COALESCE(requestability_status, 'not_requestable') != 'requestable_with_approval'
           THEN ?
           WHEN ? != 'requestable_with_approval' THEN NULL
           ELSE requestable_at
         END,
         updated_at = ?
     WHERE id = ?
       AND status = 'active'
       AND COALESCE(requires_approval, 1) = 1`
  )
    .bind(
      outcome.resulting_is_listed,
      outcome.resulting_requestability_status,
      outcome.resulting_is_listed,
      eventAt,
      outcome.resulting_is_listed,
      outcome.resulting_requestability_status,
      eventAt,
      outcome.resulting_requestability_status,
      eventAt,
      documentId
    )
    .run();

  return pass({
    document_id: documentId,
    resulting_is_listed: outcome.resulting_is_listed,
    resulting_requestability_status: outcome.resulting_requestability_status,
    updated_at: eventAt,
  });
}

async function insertCdasListingRequestabilityEvent(env, options = {}) {
  if (!env?.DB?.prepare) {
    return fail(
      "listing_requestability_database_unavailable",
      "D1 database binding is unavailable."
    );
  }

  const eventAt = cleanText(options.eventAt || nowIso());
  const id = buildCdasListingRequestabilityEventId();

  await env.DB.prepare(
    `INSERT INTO cdas_listing_requestability_events (
       id,
       document_id,
       activation_event_id,
       action,
       previous_document_status,
       resulting_document_status,
       previous_is_listed,
       resulting_is_listed,
       previous_requestability_status,
       resulting_requestability_status,
       requires_approval,
       action_notes,
       admin_actor,
       request_id,
       public_visibility_created,
       document_requestable,
       document_downloadable,
       generated_pdf_created,
       licence_created,
       download_link_created,
       email_sent,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.documentId,
      options.activationEventId || null,
      options.action,
      options.previousDocumentStatus || "active",
      options.resultingDocumentStatus || "active",
      Number(options.previousIsListed ?? 0),
      Number(options.resultingIsListed ?? 0),
      options.previousRequestabilityStatus || "not_requestable",
      options.resultingRequestabilityStatus || "not_requestable",
      1,
      nullableText(options.actionNotes),
      nullableText(options.adminActor),
      nullableText(options.requestId),
      Number(options.publicVisibilityCreated ?? 0),
      Number(options.documentRequestable ?? 0),
      0,
      0,
      0,
      0,
      0,
      eventAt
    )
    .run();

  return pass({
    id,
    document_id: options.documentId,
    activation_event_id: options.activationEventId || null,
    action: options.action,
    previous_document_status: options.previousDocumentStatus || "active",
    resulting_document_status: options.resultingDocumentStatus || "active",
    previous_is_listed: Number(options.previousIsListed ?? 0),
    resulting_is_listed: Number(options.resultingIsListed ?? 0),
    previous_requestability_status:
      options.previousRequestabilityStatus || "not_requestable",
    resulting_requestability_status:
      options.resultingRequestabilityStatus || "not_requestable",
    requires_approval: 1,
    public_visibility_created: Number(options.publicVisibilityCreated ?? 0),
    document_requestable: Number(options.documentRequestable ?? 0),
    document_downloadable: 0,
    generated_pdf_created: 0,
    licence_created: 0,
    download_link_created: 0,
    email_sent: 0,
    created_at: eventAt,
  });
}

export async function handleUploadAdminRequest(request, env) {
  if (!isUploadAdminAuthorized(request, env)) {
    return adminAuthFailed();
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  
  if (pathname === "/api/admin/uploads/cdas-document/listing-requestability") {
    return handleCdasControlledListingRequestability(request, env);
  }

  if (pathname === "/api/admin/uploads/cdas-document/activate") {
    return handleCdasExplicitActivation(request, env);
  }

  if (pathname === "/api/admin/uploads/cdas-document/activation-prep") {
    return handleCdasActivationPreparation(request, env);
  }

  if (pathname === "/api/admin/uploads/cdas-document/review") {
    return handleCdasDraftReviewAction(request, env);
  }

  if (pathname === "/api/admin/uploads/cdas-document") {
    return handleCdasDocumentUploadSkeleton(request, env);
  }

  return notFound();
}

export const uploadAdminRoutePolicy = {
  createsRoutes: true,
  route: "/api/admin/uploads/cdas-document",
  routeStatus: "cdas_draft_document_record_creation_gate",
  adminOnly: true,
  disabledByDefault: true,
  dryRunSupported: true,
  realWriteIntentRecognised: true,
  realWriteDisabledByDefault: true,
  realWriteImplemented: true,
  realWriteRequiresExplicitSwitch: "UPLOAD_ROUTE_REAL_WRITE_ENABLED=true",
  parsesMultipart: true,
  validatesPrefix: true,
  previewsObjectKeys: true,
  calculatesHashEvidence: true,
  checksR2Absence: true,
  createsUploadTransaction: true,
  writesR2: true,
  writesOnlyThroughOrchestrator: true,
  createsDraftCdasDocumentRecord: true,
  draftDocumentStatus: "draft",
  draftDocumentIsListed: 0,
  draftDocumentRequiresApproval: 1,
  activatesDocuments: true,
  makesDocumentsRequestable: true,
  generatesPdf: false,
  requiresIdempotencyForRealWrite: true,
  idempotencyField: "client_request_id",
  idempotencyRawKeyStored: false,
  completedReplayWritesR2: false,
  publishesDocuments: false,
  createsLicences: false,
  createsDownloadLinks: false,
  sendsEmail: false,
  exposesAdminVisibilityEvidence: true,
  adminVisibilitySurface: "cdas_documents_admin",
  adminVisibilityPath: "/admin/cdas-documents",
  publicVisibilityCreated: false,
  publicUrlCreated: false,
  adminReviewRequiredBeforeActivation: true,
  createsReviewActionRoute: true,
  reviewActionRoute: "/api/admin/uploads/cdas-document/review",
  reviewActionsRequireExplicitSwitch: "CDAS_UPLOAD_REVIEW_ACTIONS_ENABLED=true",
  validReviewActions: Array.from(VALID_CDAS_DRAFT_REVIEW_ACTIONS),
  reviewActionsActivateDocuments: false,
  reviewActionsPublishDocuments: false,
  reviewActionsGeneratePdf: false,
  reviewActionsCreateLicences: false,
  reviewActionsCreateDownloadLinks: false,
  reviewActionsSendEmail: false,
  createsActivationPrepRoute: true,
  activationPrepRoute: "/api/admin/uploads/cdas-document/activation-prep",
  activationPrepRequiresExplicitSwitch: "CDAS_UPLOAD_ACTIVATION_PREP_ENABLED=true",
  activationPrepRequiresReviewAction: "approve_for_activation_prep",
  createsActivationPrepEvent: true,
  activationPrepActivatesDocuments: false,
  activationPrepPublishesDocuments: false,
  activationPrepMakesDocumentsRequestable: false,
  activationPrepGeneratesPdf: false,
  activationPrepCreatesLicences: false,
  activationPrepCreatesDownloadLinks: false,
  activationPrepSendsEmail: false,
  createsExplicitActivationRoute: true,
  explicitActivationRoute: "/api/admin/uploads/cdas-document/activate",
  explicitActivationRequiresSwitch: "CDAS_UPLOAD_EXPLICIT_ACTIVATION_ENABLED=true",
  explicitActivationRequiresActivationPrep: true,
  explicitActivationChangesStatusToActive: true,
  explicitActivationKeepsDocumentUnlisted: true,
  explicitActivationKeepsApprovalRequired: true,
  explicitActivationCreatesLicence: false,
  explicitActivationCreatesDownloadLink: false,
  explicitActivationGeneratesPdf: false,
  explicitActivationSendsEmail: false,
  createsControlledListingRequestabilityRoute: true,
  controlledListingRequestabilityRoute:
    "/api/admin/uploads/cdas-document/listing-requestability",
  controlledListingRequestabilityRequiresSwitch:
    "CDAS_UPLOAD_LISTING_REQUESTABILITY_ENABLED=true",
  validListingRequestabilityActions:
    Array.from(VALID_CDAS_LISTING_REQUESTABILITY_ACTIONS),
  controlledListingRequiresExplicitActivation: true,
  controlledListingCanSetIsListed: true,
  controlledRequestabilityCanSetRequestableWithApproval: true,
  controlledRequestabilityKeepsApprovalRequired: true,
  controlledRequestabilityMakesDirectDownloadable: false,
  controlledRequestabilityGeneratesPdf: false,
  controlledRequestabilityCreatesLicence: false,
  controlledRequestabilityCreatesDownloadLink: false,
  controlledRequestabilitySendsEmail: false,
};