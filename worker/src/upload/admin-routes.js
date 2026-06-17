import { jsonResponse } from "../shared.js";
import { parseStrictUploadRequest } from "./parse-multipart.js";

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

function buildNoSideEffects() {
  return {
    parses_multipart: true,
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
    route_status: "dry_run_multipart_validation",
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
      "upload transaction creation",
      "R2 no-overwrite check",
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

  const parsed = await parseStrictUploadRequest(request, {
    domain: "cdas_document",
    uploadDomain: "cdas_document",
    upload_domain: "cdas_document",
    maxBytes: 10 * 1024 * 1024,
  });

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

  return jsonResponse(
    {
      ...buildCdasUploadRouteStatus(request, env),
      ok: true,
      accepted: true,
      message:
        "CDAS upload dry-run multipart validation passed. No upload action was performed.",
      observed_request: buildObservedRequest(request),
      validation_stage: "strict_multipart_dry_run",
      parsed_upload: buildParsedUploadSummary(parsed),
      side_effects_confirmed: buildSideEffectsConfirmed(),
      next_gate:
        "U3-C should add dry-run prefix validation and object-key preview without R2 writes.",
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
  routeStatus: "dry_run_multipart_validation",
  adminOnly: true,
  disabledByDefault: true,
  dryRunOnly: true,
  parsesMultipart: true,
  createsUploadTransaction: false,
  writesR2: false,
  publishesDocuments: false,
  createsLicences: false,
  createsDownloadLinks: false,
  sendsEmail: false,
};