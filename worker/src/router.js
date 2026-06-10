import {
  textResponse,
  methodNotAllowed,
} from "./shared.js";

import {
  handleDownload,
  handleFreeDownloadPost,
  handlePersonalisedDownload,
  handleDownloadRegistryAdminJson,
} from "./downloads.js";

import {
  handleEarlyAccessPost,
  handleContactPost,
} from "./forms.js";

import {
  handleNewsletterAdminJson,
  handleNewsletterAdminCsv,
  handleContactAdminJson,
  handleContactAdminCsv,
  handleDownloadAnalyticsAdminJson,
} from "./admin.js";

import {
  handleCdasAdminRequest,
} from "./cdas/admin.js";

import {
  handleDocumentAccessRequest,
} from "./cdas/request.js";

import {
  handlePublicRenderedLicencePreview,
} from "./cdas/public-render.js";

import {
  handleDocumentAccessVerify,
} from "./cdas/verify.js";

import {
  handleCdasDocumentDownload,
} from "./cdas/download.js";

import {
  handleCdasDocumentDownloadMetadata,
} from "./cdas/download-metadata.js";

import {
  handleCdasAccessInvitationMetadata,
} from "./cdas/invitation-metadata.js";

export async function routeRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname.startsWith("/download/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }

    return handleDownload(request, env, url);
  }

  if (pathname === "/api/free-download") {
    if (request.method === "GET") {
      return textResponse("Free download endpoint is live. Submit the form with POST.");
    }

    if (request.method === "POST") {
      return handleFreeDownloadPost(request, env, url);
    }

    return methodNotAllowed("GET, POST");
  }

  if (pathname.startsWith("/api/download/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }

    return handlePersonalisedDownload(request, env, url);
  }

  if (pathname === "/api/admin/download-registry") {
    if (request.method === "GET") {
      return handleDownloadRegistryAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (pathname === "/api/early-access") {
    if (request.method === "GET") {
      return textResponse("Early access endpoint is live. Submit the form with POST.");
    }

    if (request.method === "POST") {
      return handleEarlyAccessPost(request, env, url);
    }

    return methodNotAllowed("GET, POST");
  }

  if (pathname === "/api/contact") {
    if (request.method === "GET") {
      return textResponse("Contact endpoint is live. Submit the form with POST.");
    }

    if (request.method === "POST") {
      return handleContactPost(request, env);
    }

    return methodNotAllowed("GET, POST");
  }

  /*
   * CDAS Phase 3D — public rendered licence preview.
   */
  if (pathname === "/api/document-access/rendered-licence") {
    if (request.method === "POST") {
      return handlePublicRenderedLicencePreview(request, env);
    }

    return methodNotAllowed("POST");
  }

  if (pathname === "/api/document-access/verify") {
    if (request.method === "POST") {
      return handleDocumentAccessVerify(request, env);
    }

    return methodNotAllowed("POST");
  }

  /*
   * CDAS Phase 3A / 3Y-B5 — public access request intake.
   */
  if (pathname === "/api/document-access/request") {
    if (request.method === "POST") {
      return handleDocumentAccessRequest(request, env);
    }

    return methodNotAllowed("POST");
  }

  /*
   * CDAS Phase 3Y-B6-D — public access invitation metadata.
   *
   * This route checks an invitation token and returns safe display metadata
   * for the access invitation landing page.
   *
   * It does not consume the invitation or mutate the database.
   */
  if (pathname.startsWith("/api/access-invitation/")) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    const token = decodeURIComponent(
      pathname.slice("/api/access-invitation/".length)
    );

    return handleCdasAccessInvitationMetadata(request, env, token);
  }

  /*
   * CDAS Phase 3X-A — public controlled download metadata.
   */
  if (pathname.startsWith("/api/document-download-metadata/")) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    const token = decodeURIComponent(
      pathname.slice("/api/document-download-metadata/".length)
    );

    return handleCdasDocumentDownloadMetadata(request, env, token);
  }

  /*
   * CDAS Phase 3T — controlled public document download.
   */
  if (pathname.startsWith("/api/document-download/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }

    const token = decodeURIComponent(
      pathname.slice("/api/document-download/".length)
    );

    return handleCdasDocumentDownload(request, env, token);
  }

  /*
   * CDAS admin routes.
   */
  if (
    pathname === "/api/admin/cdas/documents" ||
    pathname.startsWith("/api/admin/cdas/documents/") ||
    pathname === "/api/admin/cdas/licence-terms" ||
    pathname.startsWith("/api/admin/cdas/licence-terms/") ||
    pathname === "/api/admin/cdas/access-requests" ||
    pathname.startsWith("/api/admin/cdas/access-requests/") ||
    pathname === "/api/admin/cdas/licences" ||
    pathname.startsWith("/api/admin/cdas/licences/") ||
    pathname === "/api/admin/cdas/download-links" ||
    pathname.startsWith("/api/admin/cdas/download-links/") ||
    pathname === "/api/admin/cdas/invitations" ||
    pathname.startsWith("/api/admin/cdas/invitations/") ||
    pathname === "/api/admin/cdas/email/test-verification"
  ) {
    return handleCdasAdminRequest(request, env);
  }

  if (pathname === "/api/admin/newsletter") {
    if (request.method === "GET") {
      return handleNewsletterAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (pathname === "/api/admin/newsletter.csv") {
    if (request.method === "GET") {
      return handleNewsletterAdminCsv(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (pathname === "/api/admin/contact") {
    if (request.method === "GET") {
      return handleContactAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (pathname === "/api/admin/contact.csv") {
    if (request.method === "GET") {
      return handleContactAdminCsv(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (pathname === "/api/admin/downloads") {
    if (request.method === "GET") {
      return handleDownloadAnalyticsAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  /*
   * CDAS Phase 3Y-B6-E — public access invitation landing page.
   *
   * Astro static output cannot pre-render arbitrary invitation token paths.
   * This rewrites /access/rh_inv_... to the static /access/ page while
   * preserving the browser URL. The page JavaScript reads the token from
   * window.location.pathname.
   *
   * This route does not consume the invitation or mutate the database.
   */
  if (pathname.startsWith("/access/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }

    const landingUrl = new URL("/access/", url.origin);

    const landingRequest = new Request(landingUrl.toString(), {
      method: request.method,
      headers: request.headers,
    });

    return env.ASSETS.fetch(landingRequest);
  }

  /*
   * CDAS Phase 3X-B — public recipient download landing page.
   */
  if (pathname.startsWith("/document-download/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }

    const landingUrl = new URL("/document-download/", url.origin);

    const landingRequest = new Request(landingUrl.toString(), {
      method: request.method,
      headers: request.headers,
    });

    return env.ASSETS.fetch(landingRequest);
  }

  return env.ASSETS.fetch(request);
}