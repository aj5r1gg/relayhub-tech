import { jsonResponse } from "../shared.js";
import { parseStrictUploadRequest } from "./parse-multipart.js";
import { byteLength, sha256Hex } from "./hash.js";
import { requireUploadObjectKeysAbsent } from "./r2-objects.js";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function cleanText(value) {
  return String(value ?? "").trim();
}

function envEnabled(value) {
  return cleanText(value).toLowerCase() === "true";
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

  return {
    mode: dryRun ? "dry-run" : mode || "blocked",
    dry_run: dryRun,
  };
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

function buildNoSideEffects() {
  return {
    parses_multipart: true,
    validates_prefix: true,
    previews_object_keys: true,
    calculates_hash_evidence: true,
    checks_r2_absence: true,
    creates_upload_transaction: false,
    writes_r2: false,
    publishes_document: false,
    creates_licence: false,
    creates_download_link: false,
    sends_email: false,
  };
}

function buildSideEffectsConfirmed() {
  return {
    creates_upload_transaction: false,
    writes_r2: false,
    publishes_document: false,
    creates_licence: false,
    creates_download_link: false,
    sends_email: false,
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
    route_status: "dry_run_r2_absence_check",
    upload_domain: "cdas_document",
    dry_run_requested: routeMode.dry_run,
    mode: routeMode.mode,
    switches,
    side_effects: buildNoSideEffects(),
    requirements_before_real_write: [
      "UPLOADS_ENABLED=true",
      "CDAS_UPLOADS_ENABLED=true",
      "UPLOAD_ROUTE_SKELETON_ENABLED=true",
      "UPLOAD_ROUTE_DRY_RUN_ENABLED=true",
      "future explicit real-write switch not yet implemented",
      "strict multipart parser",
      "storage prefix validation",
      "object key builder",
      "hash evidence",
      "R2 no-overwrite check",
      "upload transaction creation",
      "R2 write helper",
      "orchestrator validation gate",
      "recovery path validation",
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
        "This route only accepts dry-run requests. Add ?mode=dry-run. No upload action was performed.",
    },
    409
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

  return pass({
    storage_prefix: prefixResult.value,
    object_key_preview: objectKeysResult.value,
    hash_evidence: hashEvidence.value,
    r2_absence_check: r2Absence.value,
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

  if (!routeMode.dry_run) {
    return dryRunRequiredResponse(request, env);
  }

  if (!switches.upload_route_dry_run_enabled) {
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
        validation_stage: "strict_multipart_dry_run",
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      400
    );
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
        validation_stage: "dry_run_r2_absence_check",
        parsed_upload: buildParsedUploadSummary(parsed),
        side_effects_confirmed: buildSideEffectsConfirmed(),
      },
      409
    );
  }

  return jsonResponse(
    {
      ...buildCdasUploadRouteStatus(request, env),
      ok: true,
      accepted: true,
      message:
        "CDAS upload dry-run validation passed. Prefix, object keys, hash evidence, and R2 absence were checked. No upload action was performed.",
      observed_request: buildObservedRequest(request),
      validation_stage: "dry_run_r2_absence_check",
      parsed_upload: buildParsedUploadSummary(parsed),
      dry_run_preview: preview.value,
      side_effects_confirmed: buildSideEffectsConfirmed(),
      next_gate:
        "U3-F should create a disabled real-write route gate, still blocked unless an explicit future switch is enabled.",
    },
    200
  );
}

export async function handleUploadAdminRequest(request, env) {
  if (!isUploadAdminAuthorized(request, env)) {
    return adminAuthFailed();
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/api/admin/uploads/cdas-document") {
    return handleCdasDocumentUploadSkeleton(request, env);
  }

  return notFound();
}

export const uploadAdminRoutePolicy = {
  createsRoutes: true,
  route: "/api/admin/uploads/cdas-document",
  routeStatus: "dry_run_r2_absence_check",
  adminOnly: true,
  disabledByDefault: true,
  dryRunOnly: true,
  parsesMultipart: true,
  validatesPrefix: true,
  previewsObjectKeys: true,
  calculatesHashEvidence: true,
  checksR2Absence: true,
  createsUploadTransaction: false,
  writesR2: false,
  publishesDocuments: false,
  createsLicences: false,
  createsDownloadLinks: false,
  sendsEmail: false,
};