import { jsonResponse } from "../shared.js";
import { uploadAdminRoutePolicy } from "./admin/policy.js";
import { handleCdasDocumentUploadSkeleton } from "./admin/gates/cdas-document-upload.js";
import { handleCdasDraftReviewAction } from "./admin/gates/cdas-draft-review.js";
import { handleCdasActivationPreparation } from "./admin/gates/cdas-activation-preparation.js";
import { handleCdasExplicitActivation } from "./admin/gates/cdas-explicit-activation.js";
import { handleCdasControlledListingRequestability } from "./admin/gates/cdas-listing-requestability.js";
import { handleCdasControlledAccessRequestIntake } from "./admin/gates/cdas-access-request-intake.js";
import { handleCdasControlledAccessRequestReview } from "./admin/gates/cdas-access-request-review.js";
import { handleCdasLicencePreparation } from "./admin/gates/cdas-licence-preparation.js";

export { uploadAdminRoutePolicy };




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


export async function handleUploadAdminRequest(request, env) {
  if (!isUploadAdminAuthorized(request, env)) {
    return adminAuthFailed();
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (
    pathname ===
    "/api/admin/uploads/cdas-document/access-request/licence-preparation"
  ) {
    return handleCdasLicencePreparation(request, env);
  }

  if (pathname === "/api/admin/uploads/cdas-document/access-request/review") {
    return handleCdasControlledAccessRequestReview(request, env);
  }

  if (pathname === "/api/admin/uploads/cdas-document/access-request") {
    return handleCdasControlledAccessRequestIntake(request, env);
  }

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