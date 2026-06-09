const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function currentYear() {
  return String(new Date().getUTCFullYear());
}

function defaultOfficialWebsite(env) {
  return cleanText(env.RELAYHUB_OFFICIAL_WEBSITE) || "https://www.relayhub.tech";
}

function defaultContactEmail(env) {
  return cleanText(env.RELAYHUB_CONTACT_EMAIL) || "hello@relayhub.tech";
}

function defaultCopyrightHolder(env) {
  return cleanText(env.RELAYHUB_COPYRIGHT_HOLDER) || "RelayHub";
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extractPlaceholders(text) {
  const matches = text.match(/\{\{[A-Z0-9_]+\}\}/g) || [];
  return Array.from(new Set(matches)).sort();
}

async function readRequestBody(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    const body = {};

    for (const [key, value] of formData.entries()) {
      body[key] = typeof value === "string" ? value : value.name;
    }

    return body;
  }

  return {};
}

function getBodyValue(body, ...keys) {
  for (const key of keys) {
    if (body[key] !== undefined && body[key] !== null) {
      return body[key];
    }
  }

  return "";
}

async function getDocument(env, documentRef) {
  const ref = cleanText(documentRef);

  if (!ref) {
    return null;
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       classification,
       access_class,
       source_object,
       licence_terms_version,
       is_listed
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();

  return row || null;
}

async function getLicenceTerms(env, versionOrId) {
  const ref = cleanText(versionOrId);

  if (!ref) {
    return null;
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       version,
       title,
       body,
       body_sha256,
       status,
       applies_to_access_class
     FROM licence_terms
     WHERE version = ? OR id = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();

  return row || null;
}

function isPublicPreviewAllowed(document) {
  if (!document) {
    return {
      ok: false,
      status: 404,
      error: "document_not_found",
      message: "The requested document was not found.",
    };
  }

  if (document.status !== "active") {
    return {
      ok: false,
      status: 409,
      error: "document_not_active",
      message: "This document is not currently active.",
    };
  }

  if (Number(document.is_listed) !== 1) {
    return {
      ok: false,
      status: 409,
      error: "document_not_listed",
      message: "This document is not currently listed for public access.",
    };
  }

  if (document.access_class === "disabled") {
    return {
      ok: false,
      status: 409,
      error: "document_access_disabled",
      message: "Access is disabled for this document.",
    };
  }

  if (!document.licence_terms_version) {
    return {
      ok: false,
      status: 409,
      error: "document_missing_terms",
      message: "This document does not have licence terms assigned.",
    };
  }

  return { ok: true };
}

function buildRenderValues({ env, body, document }) {
  const name = cleanText(getBodyValue(body, "name", "licensed_name", "licensedName"));
  const email = normaliseEmail(
    getBodyValue(body, "email", "licensed_email", "licensedEmail")
  );

  const organisation = cleanText(
    getBodyValue(
      body,
      "organisation_name",
      "organisationName",
      "licensed_organisation",
      "licensedOrganisation"
    )
  );

  return {
    "{{DOCUMENT_TITLE}}": document.title,
    "{{DOCUMENT_VERSION}}": document.version,
    "{{YEAR}}": cleanText(getBodyValue(body, "year")) || currentYear(),
    "{{COPYRIGHT_HOLDER}}":
      cleanText(getBodyValue(body, "copyright_holder", "copyrightHolder")) ||
      defaultCopyrightHolder(env),
    "{{OFFICIAL_WEBSITE}}":
      cleanText(getBodyValue(body, "official_website", "officialWebsite")) ||
      defaultOfficialWebsite(env),
    "{{CONTACT_EMAIL}}":
      cleanText(getBodyValue(body, "contact_email", "contactEmail")) ||
      defaultContactEmail(env),

    "{{LICENSED_NAME}}": name,
    "{{LICENSED_EMAIL}}": email,
    "{{LICENSED_ORGANISATION}}": organisation,
    "{{LICENCE_NUMBER}}": cleanText(
      getBodyValue(body, "licence_number", "licenceNumber")
    ),
    "{{DOWNLOAD_ID}}": cleanText(getBodyValue(body, "download_id", "downloadId")),
    "{{ORDER_NUMBER}}": cleanText(getBodyValue(body, "order_number", "orderNumber")),
    "{{LICENCE_DATE}}":
      cleanText(getBodyValue(body, "licence_date", "licenceDate")) ||
      new Date().toISOString().slice(0, 10),
  };
}

function renderTemplate(templateBody, values) {
  let rendered = templateBody;

  for (const [placeholder, value] of Object.entries(values)) {
    if (!value) {
      continue;
    }

    rendered = rendered.split(placeholder).join(value);
  }

  return rendered;
}

export async function handlePublicRenderedLicencePreview(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to preview rendered licence terms.",
      },
      405
    );
  }

  let body;

  try {
    body = await readRequestBody(request);
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_request_body",
        message: "The request body could not be read.",
      },
      400
    );
  }

  const documentRef = cleanText(
    getBodyValue(body, "document_id", "documentId", "document", "slug")
  );

  if (!documentRef) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_document_id",
        message: "A document_id is required.",
      },
      400
    );
  }

  const document = await getDocument(env, documentRef);
  const allowed = isPublicPreviewAllowed(document);

  if (!allowed.ok) {
    return jsonResponse(
      {
        ok: false,
        error: allowed.error,
        message: allowed.message,
      },
      allowed.status
    );
  }

  const terms = await getLicenceTerms(env, document.licence_terms_version);

  if (!terms || !terms.body) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_terms_not_found",
        message: "The assigned licence terms could not be found.",
      },
      404
    );
  }

  const templatePlaceholders = extractPlaceholders(terms.body);
  const renderValues = buildRenderValues({ env, body, document });
  const renderedBody = renderTemplate(terms.body, renderValues);
  const unresolvedPlaceholders = extractPlaceholders(renderedBody);
  const renderedSha256 = await sha256Hex(renderedBody);

  return jsonResponse({
    ok: true,
    document: {
      id: document.id,
      slug: document.slug,
      title: document.title,
      version: document.version,
      classification: document.classification,
      access_class: document.access_class,
    },
    terms: {
      id: terms.id,
      version: terms.version,
      title: terms.title,
      status: terms.status,
      applies_to_access_class: terms.applies_to_access_class,
      body_sha256: terms.body_sha256,
    },
    template_placeholders: templatePlaceholders,
    unresolved_placeholders: unresolvedPlaceholders,
    rendered_sha256: renderedSha256,
    rendered_body: renderedBody,
  });
}