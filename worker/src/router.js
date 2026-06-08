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
      return handleContactPost(request, env, url);
    }

    return methodNotAllowed("GET, POST");
  }

  /*
   * CDAS Phase 3A — public access request intake.
   *
   * This route records an access request only.
   *
   * It does not:
   * - verify email,
   * - issue a licence,
   * - generate a PDF,
   * - create a download link,
   * - serve a controlled download.
   */
  if (pathname === "/api/document-access/request") {
    if (request.method === "POST") {
      return handleDocumentAccessRequest(request, env);
    }

    return methodNotAllowed("POST");
  }

  /*
   * CDAS admin routes.
   */
  if (
    pathname === "/api/admin/cdas/documents" ||
    pathname.startsWith("/api/admin/cdas/documents/") ||
    pathname === "/api/admin/cdas/licence-terms" ||
    pathname.startsWith("/api/admin/cdas/licence-terms/")
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

  return env.ASSETS.fetch(request);
}