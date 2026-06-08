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

function defaultOfficialWebsite(env) {
  return cleanText(env.RELAYHUB_OFFICIAL_WEBSITE) || "https://www.relayhub.tech";
}

function defaultContactEmail(env) {
  return cleanText(env.RELAYHUB_CONTACT_EMAIL) || "hello@relayhub.tech";
}

function defaultCopyrightHolder(env) {
  return cleanText(env.RELAYHUB_COPYRIGHT_HOLDER) || "RelayHub";
}

function currentYear() {
  return String(new Date().getUTCFullYear());
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

function buildRenderValues({ env, url, document }) {
  const params = url.searchParams;

  return {
    "{{DOCUMENT_TITLE}}": cleanText(params.get("document_title")) || document.title,
    "{{DOCUMENT_VERSION}}": cleanText(params.get("document_version")) || document.version,
    "{{YEAR}}": cleanText(params.get("year")) || currentYear(),
    "{{COPYRIGHT_HOLDER}}":
      cleanText(params.get("copyright_holder")) || defaultCopyrightHolder(env),
    "{{OFFICIAL_WEBSITE}}":
      cleanText(params.get("official_website")) || defaultOfficialWebsite(env),
    "{{CONTACT_EMAIL}}":
      cleanText(params.get("contact_email")) || defaultContactEmail(env),

    "{{LICENSED_NAME}}": cleanText(params.get("licensed_name")),
    "{{LICENSED_EMAIL}}": cleanText(params.get("licensed_email")),
    "{{LICENSED_ORGANISATION}}": cleanText(params.get("licensed_organisation")),
    "{{LICENCE_NUMBER}}": cleanText(params.get("licence_number")),
    "{{DOWNLOAD_ID}}": cleanText(params.get("download_id")),
    "{{ORDER_NUMBER}}": cleanText(params.get("order_number")),
    "{{LICENCE_DATE}}": cleanText(params.get("licence_date")) || new Date().toISOString(),
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

async function getDocument(env, documentIdOrSlug) {
  const result = await env.RELAYHUB_DB.prepare(
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
       created_at,
       updated_at
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(documentIdOrSlug, documentIdOrSlug)
    .first();

  return result || null;
}

async function getLicenceTerms(env, versionOrId) {
  const result = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       version,
       title,
       body,
       body_sha256,
       status,
       applies_to_access_class,
       effective_from,
       effective_to,
       created_at,
       retired_at,
       notes
     FROM licence_terms
     WHERE version = ? OR id = ?
     LIMIT 1`
  )
    .bind(versionOrId, versionOrId)
    .first();

  return result || null;
}

export async function renderCdasDocumentLicence(request, env, documentIdOrSlug) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to preview a rendered CDAS licence.",
      },
      405
    );
  }

  const document = await getDocument(env, documentIdOrSlug);

  if (!document) {
    return jsonResponse(
      {
        ok: false,
        error: "document_not_found",
        message: "CDAS document record was not found.",
      },
      404
    );
  }

  if (!document.licence_terms_version) {
    return jsonResponse(
      {
        ok: false,
        error: "document_has_no_licence_terms_version",
        message: "This document does not reference a licence terms version.",
        document,
      },
      409
    );
  }

  const terms = await getLicenceTerms(env, document.licence_terms_version);

  if (!terms) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_terms_not_found",
        message: "Referenced licence terms record was not found.",
        document,
      },
      404
    );
  }

  if (!terms.body) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_terms_body_missing",
        message: "Referenced licence terms record has no body text.",
        document,
        terms: {
          id: terms.id,
          version: terms.version,
          title: terms.title,
          status: terms.status,
        },
      },
      409
    );
  }

  const url = new URL(request.url);
  const template_placeholders = extractPlaceholders(terms.body);
  const values = buildRenderValues({ env, url, document });
  const rendered_body = renderTemplate(terms.body, values);
  const unresolved_placeholders = extractPlaceholders(rendered_body);
  const rendered_sha256 = await sha256Hex(rendered_body);

  return jsonResponse({
    ok: true,
    document,
    terms: {
      id: terms.id,
      version: terms.version,
      title: terms.title,
      status: terms.status,
      applies_to_access_class: terms.applies_to_access_class,
      body_sha256: terms.body_sha256,
      effective_from: terms.effective_from,
      effective_to: terms.effective_to,
      created_at: terms.created_at,
      retired_at: terms.retired_at,
      notes: terms.notes,
    },
    template_placeholders,
    render_values: values,
    unresolved_placeholders,
    rendered_sha256,
    rendered_body,
  });
}