import { jsonResponse } from "../shared.js";
import { listCdasDocuments, getCdasDocument } from "./documents.js";
import {
  listCdasLicenceTerms,
  getCdasLicenceTerms,
} from "./terms.js";
import { importCdasDocumentsFromCatalogue } from "./import.js";
import { renderCdasDocumentLicence } from "./render.js";

function isCdasAdminAuthorized(request, env) {
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

function adminAuthFailed() {
  return jsonResponse(
    {
      ok: false,
      error: "admin_auth_failed",
      message: "Admin access is not available.",
    },
    { status: 401 }
  );
}

function notFound() {
  return jsonResponse(
    {
      ok: false,
      error: "cdas_admin_route_not_found",
      message: "CDAS admin route was not found.",
    },
    { status: 404 }
  );
}

export async function handleCdasAdminRequest(request, env) {
  if (!isCdasAdminAuthorized(request, env)) {
    return adminAuthFailed();
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/api/admin/cdas/documents/import") {
    return importCdasDocumentsFromCatalogue(request, env);
  }

  /*
   * Must appear before the generic /documents/:id route.
   */
  if (
    pathname.startsWith("/api/admin/cdas/documents/") &&
    pathname.endsWith("/rendered-licence")
  ) {
    const withoutPrefix = pathname.slice("/api/admin/cdas/documents/".length);
    const documentId = decodeURIComponent(
      withoutPrefix.slice(0, -"/rendered-licence".length)
    );

    return renderCdasDocumentLicence(request, env, documentId);
  }

  if (pathname === "/api/admin/cdas/documents") {
    return listCdasDocuments(request, env);
  }

  if (pathname.startsWith("/api/admin/cdas/documents/")) {
    const documentId = decodeURIComponent(
      pathname.slice("/api/admin/cdas/documents/".length)
    );

    return getCdasDocument(request, env, documentId);
  }

  if (pathname === "/api/admin/cdas/licence-terms") {
    return listCdasLicenceTerms(request, env);
  }

  if (pathname.startsWith("/api/admin/cdas/licence-terms/")) {
    const termsIdOrVersion = decodeURIComponent(
      pathname.slice("/api/admin/cdas/licence-terms/".length)
    );

    return getCdasLicenceTerms(request, env, termsIdOrVersion);
  }

  return notFound();
}