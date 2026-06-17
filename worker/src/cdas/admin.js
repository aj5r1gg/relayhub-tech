import { jsonResponse } from "../shared.js";
import {
  getCdasDownloadLinkRevocationEligibility,
  revokeCdasDownloadLink,
} from "./download-link-revoke.js";
import {
  getCdasDownloadLinkRevocationNoticeEligibility,
  sendCdasDownloadLinkRevocationNotice,
} from "./download-link-revocation-notice.js";
import {
  getCdasDownloadLinkReissueEligibility,
} from "./download-link-reissue-eligibility.js";
import {
  reissueCdasDownloadLinkFromDownloadLink,
} from "./download-link-reissue.js";
import {
  getCdasDownloadLinkActivationEligibility,
  activateCdasDownloadLink,
} from "./download-link-activation.js";
import { prepareCdasActiveLinkDelivery } from "./active-link-delivery-preparation.js";
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
import {
  listCdasDocumentReleasePolicies,
  getCdasDocumentReleasePolicy,
} from "./document-release-policies.js";
import { getCdasHealth } from "./health.js";
import { handleCdasOperationsJson } from "./operations.js";
import {
  getCdasReviewToLicenceEligibility,
} from "./review-to-licence-gate.js";
import {
  issueCdasReviewedRequestLicence,
} from "./issue-reviewed-licence.js";
import {
  getCdasLicenceToPdfEligibility,
} from "./licence-to-pdf-gate.js";
import {
  getCdasGeneratedPdfToDownloadLinkEligibility,
} from "./generated-pdf-to-download-link-gate.js";
import {
  handleCdasRequestIntakeEvaluation,
} from "./request-intake-policy.js";

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

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  /*
   * CDAS operational health.
   *
   * Read-only. No mutation.
   */
  if (pathname === "/api/admin/cdas/health") {
    return getCdasHealth(request, env);
  }

  if (pathname === "/api/admin/cdas/operations") {
    return handleCdasOperationsJson(request, env);
  }

    /*
   * CDAS Phase 3X-0E — request intake evaluator.
   *
   * Admin-only. Evaluation only. No request creation. No mutation.
   */
  if (pathname === "/api/admin/cdas/request-intake/evaluate") {
    return handleCdasRequestIntakeEvaluation(request, env);
  }

  /*
   * CDAS release policy registry.
   *
   * Read-only in Phase 3X-0B.
   *
   * Missing policy must evaluate as default-deny.
   */
  if (pathname === "/api/admin/cdas/release-policies") {
    return listCdasDocumentReleasePolicies(request, env);
  }

  if (pathname.startsWith("/api/admin/cdas/release-policies/")) {
    const documentIdOrSlug = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/release-policies/"
    );

    return getCdasDocumentReleasePolicy(request, env, documentIdOrSlug);
  }

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

  if (
    pathname.startsWith("/api/admin/cdas/access-requests/") &&
    pathname.endsWith("/issue-licence")
  ) {
    const requestId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/access-requests/",
      "/issue-licence"
    );

    return issueCdasReviewedRequestLicence(request, env, requestId);
  }

  if (
    pathname.startsWith("/api/admin/cdas/access-requests/") &&
    pathname.endsWith("/licence-eligibility")
  ) {
    const requestId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/access-requests/",
      "/licence-eligibility"
    );

    return getCdasReviewToLicenceEligibility(request, env, requestId);
  }

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

  if (
    pathname.startsWith("/api/admin/cdas/access-requests/") &&
    pathname.endsWith("/review")
  ) {
    const requestId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/access-requests/",
      "/review"
    );

    return reviewCdasAccessRequest(request, env, requestId);
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
   */
  /*
   * CDAS Phase 3X-0Q — controlled active-link delivery email send.
   *
   * Sends email only. No PDF serving and no link consumption.
   */
  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/send-delivery-email")
  ) {
    const downloadLinkIdOrReference = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/send-delivery-email"
    );

    return sendCdasActiveLinkDeliveryEmail(
      request,
      env,
      downloadLinkIdOrReference
    );
  }

  /*
   * CDAS Phase 3X-0P — active download-link delivery preparation.
   *
   * Prepares delivery payload only. No email and no PDF serving.
   */
  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/delivery-eligibility")
  ) {
    const downloadLinkIdOrReference = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/delivery-eligibility"
    );

    return getCdasActiveLinkDeliveryEligibility(
      request,
      env,
      downloadLinkIdOrReference
    );
  }

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/prepare-delivery")
  ) {
    const downloadLinkIdOrReference = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/prepare-delivery"
    );

    return prepareCdasActiveLinkDelivery(
      request,
      env,
      downloadLinkIdOrReference
    );
  }

  /*
   * CDAS Phase 3X-0O — controlled download-link activation gate/action.
   *
   * Activation only. No email and no PDF serving.
   */
  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/activation-eligibility")
  ) {
    const downloadLinkIdOrReference = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/activation-eligibility"
    );

    return getCdasDownloadLinkActivationEligibility(
      request,
      env,
      downloadLinkIdOrReference
    );
  }

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/activate")
  ) {
    const downloadLinkIdOrReference = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/activate"
    );

    return activateCdasDownloadLink(request, env, downloadLinkIdOrReference);
  }

  if (pathname === "/api/admin/cdas/download-links") {
    return listCdasDownloadLinks(request, env);
  }

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/revocation-eligibility")
  ) {
    const downloadId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/revocation-eligibility"
    );

    return getCdasDownloadLinkRevocationEligibility(request, env, downloadId);
  }

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/revocation-notice-eligibility")
  ) {
    const downloadId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/revocation-notice-eligibility"
    );

    return getCdasDownloadLinkRevocationNoticeEligibility(
      request,
      env,
      downloadId
    );
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

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/send-revocation-notice")
  ) {
    const downloadId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/send-revocation-notice"
    );

    return sendCdasDownloadLinkRevocationNotice(
      request,
      env,
      downloadId
    );
  }

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/reissue-eligibility")
  ) {
    const downloadId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/reissue-eligibility"
    );

    return getCdasDownloadLinkReissueEligibility(request, env, downloadId);
  }

  if (
    pathname.startsWith("/api/admin/cdas/download-links/") &&
    pathname.endsWith("/reissue")
  ) {
    const downloadId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/download-links/",
      "/reissue"
    );

    return reissueCdasDownloadLinkFromDownloadLink(
      request,
      env,
      downloadId
    );
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
   * Important:
   * Specific subroutes must appear before the generic
   * /api/admin/cdas/licences/:id route.
   */
  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/pdf-eligibility")
  ) {
    const licenceId = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/pdf-eligibility"
    );

    return getCdasLicenceToPdfEligibility(request, env, licenceId);
  }

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
    pathname.endsWith("/download-history")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/download-history"
    );

    return getCdasLicenceDownloadHistory(request, env, licenceIdOrNumber);
  }

  /*
   * CDAS licence evidence bundle R2 archive.
   *
   * Admin-only. Generates the evidence bundle server-side, calculates evidence,
   * archives the JSON bundle to R2, and records an archive audit event when possible.
   *
   * Does not create download links, generate PDFs, email anyone, serve controlled
   * documents, expose raw tokens, expose token hashes, or expose private R2 URLs.
   *
   * Important: this route must appear before /evidence-bundle/export-record
   * and /evidence-bundle.
   */
  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/evidence-bundle/archive")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/evidence-bundle/archive"
    );

    return archiveCdasLicenceEvidenceBundle(
      request,
      env,
      licenceIdOrNumber
    );
  }

  /*
   * CDAS licence evidence bundle export record.
   *
   * Admin-only. Generates the same evidence bundle server-side, calculates
   * bundle evidence, and records an export audit event when possible.
   *
   * Does not write R2, create download links, generate PDFs, email anyone,
   * serve downloads, expose raw tokens, expose token hashes, or expose private
   * R2 URLs.
   *
   * Important: this route must appear before /evidence-bundle.
   */
  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/evidence-bundle/export-record")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/evidence-bundle/export-record"
    );

    return recordCdasLicenceEvidenceBundleExport(
      request,
      env,
      licenceIdOrNumber
    );
  }

  /*
   * CDAS licence evidence bundle.
   *
   * Read-only evidence export endpoint.
   */
  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/evidence-bundle")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/evidence-bundle"
    );

    return getCdasLicenceEvidenceBundle(request, env, licenceIdOrNumber);
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
    pathname.endsWith("/reissue-download-link")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/reissue-download-link"
    );

    return reissueCdasDownloadLink(request, env, licenceIdOrNumber);
  }

  if (
    pathname.startsWith("/api/admin/cdas/licences/") &&
    pathname.endsWith("/download-link-eligibility")
  ) {
    const licenceIdOrNumber = extractTrailingRouteParam(
      pathname,
      "/api/admin/cdas/licences/",
      "/download-link-eligibility"
    );

    return getCdasGeneratedPdfToDownloadLinkEligibility(
      request,
      env,
      licenceIdOrNumber
    );
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