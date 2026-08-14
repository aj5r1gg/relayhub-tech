// U3-CUT shared admin route dependencies.
// Mechanically extracted from admin-routes.js.
// No business behaviour is intentionally changed.

import { jsonResponse } from "../../shared.js";

export function cleanText(value) {
  return String(value ?? "").trim();
}

export function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

export function envEnabled(value) {
  return cleanText(value).toLowerCase() === "true";
}

export function nowIso() {
  return new Date().toISOString();
}

export function fail(error, message, details = {}) {
  return {
    ok: false,
    error,
    message,
    details,
    warnings: [],
  };
}

export function pass(value, warnings = []) {
  return {
    ok: true,
    value,
    warnings,
  };
}

export function methodNotAllowed(allowed = ["GET"]) {
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

export function getUploadRouteSwitches(env = {}) {
  return {
    uploads_enabled: envEnabled(env.UPLOADS_ENABLED),
    cdas_uploads_enabled: envEnabled(env.CDAS_UPLOADS_ENABLED),
    upload_route_skeleton_enabled: envEnabled(env.UPLOAD_ROUTE_SKELETON_ENABLED),
    upload_route_dry_run_enabled: envEnabled(env.UPLOAD_ROUTE_DRY_RUN_ENABLED),
    upload_route_real_write_enabled: envEnabled(env.UPLOAD_ROUTE_REAL_WRITE_ENABLED),
  };
}

export function getUploadRouteMode(request) {
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

export function getAdminActor(request, env) {
  return (
    cleanText(env.UPLOAD_ADMIN_ACTOR) ||
    cleanText(env.RELAYHUB_ADMIN_ACTOR) ||
    cleanText(request.headers.get("cf-access-authenticated-user-email")) ||
    cleanText(request.headers.get("x-admin-actor")) ||
    "admin"
  );
}

export function buildNoSideEffects(realWrite = false) {
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

export function buildSideEffectsConfirmed(overrides = {}) {
  return {
    creates_upload_transaction: false,
    writes_r2: false,
    creates_draft_cdas_document_record: false,
    creates_document_access_request: false,
    creates_access_request: false,
    reviews_document_access_request: false,
    approves_access_request: false,
    approves_access: false,
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

export function buildCdasUploadRouteStatus(request, env) {
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

export function uploadSystemDisabledResponse(request, env) {
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

export function cdasUploadsDisabledResponse(request, env) {
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

export async function readJsonBody(request) {
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

export function getRequestId(request) {
  return (
    cleanText(request.headers.get("x-request-id")) ||
    cleanText(request.headers.get("cf-ray")) ||
    cleanText(crypto.randomUUID?.()) ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
  );
}

export async function getD1TableColumns(env, tableName) {
  if (!env?.RELAYHUB_DB?.prepare) {
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

  const result = await env.RELAYHUB_DB.prepare(`PRAGMA table_info(${safeTable})`).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const columns = new Set(rows.map((row) => row.name).filter(Boolean));

  return pass(columns);
}
