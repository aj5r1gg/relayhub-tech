import { jsonResponse } from "../shared.js";
import { listCdasDocuments, getCdasDocument } from "./documents.js";
import {
  listCdasLicenceTerms,
  getCdasLicenceTerms,
} from "./terms.js";
import { importCdasDocumentsFromCatalogue } from "./import.js";
import { renderCdasDocumentLicence } from "./render.js";
import {
  listCdasAccessRequests,
  getCdasAccessRequest,
} from "./access-requests.js";
import {
  resendCdasAccessRequestVerification,
} from "./resend-verification.js";
import {
  listCdasLicences,
  getCdasLicence,
} from "./licences.js";
import {
  getCdasLicenceGenerationPreview,
} from "./generation-preview.js";
import {
  captureCdasDocumentSourceSha256,
} from "./source-hash.js";
import {
  generateCdasLicencePdf,
} from "./generate-pdf.js";
import {
  inspectCdasGeneratedPdf,
} from "./generated-pdf.js";
import {
  issueCdasDownloadLink,
} from "./download-link-issue.js";
import {
  emailCdasDownloadLink,
} from "./email-download-link.js";
import {
  listCdasDownloadLinks,
  getCdasDownloadLink,
} from "./download-links.js";
import {
  revokeCdasDownloadLink,
} from "./download-link-revoke.js";
import {
  sendCdasVerificationEmailTest,
} from "./email-test.js";
import {
  createCdasAccessInvitation,
  listCdasAccessInvitations,
  getCdasAccessInvitation,
  revokeCdasAccessInvitation,
} from "./invitations.js";
import {
  listCdasEmailEvents,
  getCdasEmailEvent,
  retryCdasEmailEvent,
} from "./email-events-admin.js";
import { getCdasHealth } from "./health.js";

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
    401
  );
}

function notFound() {
  return jsonResponse(
    {
      ok: false,
      error: "cdas_admin_route_not_found",
      message: "CDAS admin route was not found.",
    },
    404
  );
}

function extractTrailingRouteParam(pathname, prefix, suffix = "") {
  let value = pathname.slice(prefix.length);

  if (suffix && value.endsWith(suffix)) {
    value = value.slice(0, -suffix.length);
  }

  return decodeURIComponent(value);
}

export async function handleCdasAdminRequest(request, env) {
  if (!isCdasAdminAuthorized(request, env)) {
    return adminAuthFailed();
  }

    /*
   * CDAS operational health.
   *
   * Read-only. No mutation.
   */
  if (pathname === "/api/admin/cdas/health") {
    return getCdasHealth(request, env);
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  /*
   * CDAS email event audit registry.
   *
   * Read-only list/detail, plus manual retry for failed retryable events.
   *
   * Important: /email-events/:id/retry must appear before the generic
   * /email-events/:id route.
   */
  if (pathname === "/api/admin/cdas/email-events") {
    return listCdasEmailEvents(request, env);
  }

  if (
    pathname.startsWith("/api/admin/cdas/email-events/") &&
    pathname.endsWith("/retry")
  ) {
    const emailEventId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/email-events/",
      "/retry"
    );

    return retryCdasEmailEvent(request, env, emailEventId);
  }

  if (pathname.startsWith("/api/admin/cdas/email-events/")) {
    const emailEventId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/email-events/"
    );

    return getCdasEmailEvent(request, env, emailEventId);
  }

  /*
   * CDAS email test endpoint.
   *
   * Admin-only. Does not mutate CDAS workflow records.
   */
  if (pathname === "/api/admin/cdas/email/test-verification") {
    return sendCdasVerificationEmailTest(request, env);
  }

  /*
   * CDAS document catalogue import.
   */
  if (pathname === "/api/admin/cdas/documents/import") {
    return importCdasDocumentsFromCatalogue(request, env);
  }

  /*
   * CDAS access invitation registry.
   *
   * Invitation tokens start controlled access workflows.
   * They are not verification tokens and they are not download tokens.
   *
   * Important: special invitation subroutes must appear before the generic
   * /invitations/:id route.
   *
   * Raw invitation tokens are returned only at creation time by the POST
   * create handler.
   */
  if (pathname === "/api/admin/cdas/invitations") {
    if (request.method === "POST") {
      return createCdasAccessInvitation(request, env);
    }

    return listCdasAccessInvitations(request, env);
  }

  if (
    pathname.startsWith("/api/admin/cdas/invitations/") &&
    pathname.endsWith("/revoke")
  ) {
    const invitationId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/invitations/",
      "/revoke"
    );

    return revokeCdasAccessInvitation(request, env, invitationId);
  }

  if (pathname.startsWith("/api/admin/cdas/invitations/")) {
    const invitationId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/invitations/"
    );

    return getCdasAccessInvitation(request, env, invitationId);
  }

  /*
   * CDAS access request registry.
   */
  if (pathname === "/api/admin/cdas/access-requests") {
    return listCdasAccessRequests(request, env);
  }

  /*
   * Manual verification-email resend.
   *
   * This route generates a fresh verification token/hash for an existing
   * unverified access request, then sends a new verification email.
   *
   * Important: this special route must appear before the generic
   * /access-requests/:id route, otherwise the generic detail handler will
   * swallow it.
   */
  if (
    pathname.startsWith("/api/admin/cdas/access-requests/") &&
    pathname.endsWith("/resend-verification")
  ) {
    const requestId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/access-requests/",
      "/resend-verification"
    );

    return resendCdasAccessRequestVerification(request, env, requestId);
  }

  if (pathname.startsWith("/api/admin/cdas/access-requests/")) {
    const requestId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/access-requests/"
    );

    return getCdasAccessRequest(request, env, requestId);
  }

  /*
   * CDAS controlled download-link registry.
   *
   * Important: the special revoke route must appear before the generic
   * /download-links/:id route, otherwise the generic detail handler will
   * swallow it.
   *
   * These endpoints never return raw tokens. They expose only token-hash
   * presence and audit metadata.
   */
  if (pathname === "/api/admin/cdas/download-links") {
    return listCdasDownloadLinks(request, env);
  }

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/revoke")
  ) {
    const downloadId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/revoke"
    );

    return revokeCdasDownloadLink(request, env, downloadId);
  }

  if (pathname.startsWith("/api/admin/cdas/download-links/")) {
    const downloadId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/"
    );

    return getCdasDownloadLink(request, env, downloadId);
  }

  /*
   * CDAS issued licence registry.
   *
   * Important: special licence subroutes must appear before the generic
   * /licences/:id route, otherwise the generic licence detail route will
   * swallow them.
   */
  if (pathname === "/api/admin/cdas/licences") {
    return listCdasLicences(request, env);
  }

  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/generation-preview")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/generation-preview"
    );

    return getCdasLicenceGenerationPreview(request, env, licenceIdOrNumber);
  }

  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/generate-pdf")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/generate-pdf"
    );

    return generateCdasLicencePdf(request, env, licenceIdOrNumber);
  }

  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/generated-pdf")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/generated-pdf"
    );

    return inspectCdasGeneratedPdf(request, env, licenceIdOrNumber);
  }

  /*
   * CDAS email controlled download-link delivery.
   *
   * Important: this route must appear before /issue-download-link and before
   * the generic /licences/:id route.
   */
  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/email-download-link")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/email-download-link"
    );

    return emailCdasDownloadLink(request, env, licenceIdOrNumber);
  }

  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/issue-download-link")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/issue-download-link"
    );

    return issueCdasDownloadLink(request, env, licenceIdOrNumber);
  }

  if (pathname.startsWith("/api/admin/cdas/licences/")) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/"
    );

    return getCdasLicence(request, env, licenceIdOrNumber);
  }

  /*
   * CDAS document rendered licence preview.
   *
   * Important: special document subroutes must appear before the generic
   * /documents/:id route.
   */
  if (
    pathname.startsWith("/api/admin/cdas/documents/") &&
    pathname.endsWith("/rendered-licence")
  ) {
    const documentId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/documents/",
      "/rendered-licence"
    );

    return renderCdasDocumentLicence(request, env, documentId);
  }

  /*
   * CDAS document source SHA-256 capture.
   *
   * This reads the private R2 source object, hashes it, and stores the
   * result in documents.source_sha256. It does not generate a PDF, write
   * to R2, create a download link, or serve the document.
   */
  if (
    pathname.startsWith("/api/admin/cdas/documents/") &&
    pathname.endsWith("/capture-source-sha256")
  ) {
    const documentId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/documents/",
      "/capture-source-sha256"
    );

    return captureCdasDocumentSourceSha256(request, env, documentId);
  }

  /*
   * CDAS document registry.
   */
  if (pathname === "/api/admin/cdas/documents") {
    return listCdasDocuments(request, env);
  }

  if (pathname.startsWith("/api/admin/cdas/documents/")) {
    const documentId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/documents/"
    );

    return getCdasDocument(request, env, documentId);
  }

  /*
   * CDAS licence terms registry.
   */
  if (pathname === "/api/admin/cdas/licence-terms") {
    return listCdasLicenceTerms(request, env);
  }

  if (pathname.startsWith("/api/admin/cdas/licence-terms/")) {
    const termsIdOrVersion = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licence-terms/"
    );

    return getCdasLicenceTerms(request, env, termsIdOrVersion);
  }

  return notFound();
}