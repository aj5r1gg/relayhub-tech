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

export async function routeRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/download/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }

    return handleDownload(request, env, url);
  }

  if (url.pathname === "/api/free-download") {
    if (request.method === "GET") {
      return textResponse("Free download endpoint is live. Submit the form with POST.");
    }

    if (request.method === "POST") {
      return handleFreeDownloadPost(request, env, url);
    }

    return methodNotAllowed("GET, POST");
  }

  if (url.pathname.startsWith("/api/download/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }

    return handlePersonalisedDownload(request, env, url);
  }

  if (url.pathname === "/api/admin/download-registry") {
    if (request.method === "GET") {
      return handleDownloadRegistryAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (url.pathname === "/api/early-access") {
    if (request.method === "GET") {
      return textResponse("Early access endpoint is live. Submit the form with POST.");
    }

    if (request.method === "POST") {
      return handleEarlyAccessPost(request, env, url);
    }

    return methodNotAllowed("GET, POST");
  }

  if (url.pathname === "/api/contact") {
    if (request.method === "GET") {
      return textResponse("Contact endpoint is live. Submit the form with POST.");
    }

    if (request.method === "POST") {
      return handleContactPost(request, env, url);
    }

    return methodNotAllowed("GET, POST");
  }

  if (url.pathname === "/api/admin/newsletter") {
    if (request.method === "GET") {
      return handleNewsletterAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (url.pathname === "/api/admin/newsletter.csv") {
    if (request.method === "GET") {
      return handleNewsletterAdminCsv(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (url.pathname === "/api/admin/contact") {
    if (request.method === "GET") {
      return handleContactAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (url.pathname === "/api/admin/contact.csv") {
    if (request.method === "GET") {
      return handleContactAdminCsv(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  if (url.pathname === "/api/admin/downloads") {
    if (request.method === "GET") {
      return handleDownloadAnalyticsAdminJson(request, env, url);
    }

    return methodNotAllowed("GET");
  }

  return env.ASSETS.fetch(request);
}