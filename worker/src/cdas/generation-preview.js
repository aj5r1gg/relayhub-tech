import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeFilename(value) {
  return cleanText(value)
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function nowIso() {
  return new Date().toISOString();
}

async function getLicence(env, licenceIdOrNumber) {
  const ref = cleanText(licenceIdOrNumber);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT
       *
     FROM document_licences
     WHERE id = ? OR licence_number = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

async function getDocument(env, documentId) {
  const ref = cleanText(documentId);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       slug,
       title,
       version,
       status,
       classification,
       access_class,
       source_object,
       source_sha256,
       licence_terms_version
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

async function getAccessRequest(env, requestId) {
  const ref = cleanText(requestId);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       document_version,
       name,
       email,
       email_normalised,
       licence_holder_type,
       organisation_name,
       recipient_category,
       status,
       access_class,
       email_verified_at,
       terms_accepted_at,
       terms_version,
       requested_at
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`
  )
    .bind(ref)
    .first();
}

function buildGeneratedObjectKey({ licence, document }) {
  const documentSlug = slugify(document.slug || document.id || "document");
  const versionSlug = slugify(document.version || "version");
  const licenceSlug = slugify(licence.licence_number || licence.id);

  return [
    "docs",
    "generated",
    "cdas",
    documentSlug,
    versionSlug,
    `${licenceSlug}.pdf`,
  ].join("/");
}

function buildGeneratedFilename({ licence, document }) {
  const title = safeFilename(document.title || document.id || "RelayHub-Document");
  const version = safeFilename(document.version || "version");
  const licenceNumber = safeFilename(licence.licence_number || licence.id);

  return `${title}-v${version}-${licenceNumber}.pdf`;
}

function evaluateGenerationReadiness({ licence, document, accessRequest }) {
  const blockers = [];
  const warnings = [];

  if (!licence) {
    blockers.push("licence_not_found");
    return { ready: false, blockers, warnings };
  }

  if (licence.status !== "active") {
    blockers.push("licence_not_active");
  }

  if (!licence.licence_number) {
    blockers.push("missing_licence_number");
  }

  if (!licence.request_id) {
    blockers.push("missing_request_id");
  }

  if (!licence.document_id) {
    blockers.push("missing_document_id");
  }

  if (!licence.document_version) {
    blockers.push("missing_document_version");
  }

  if (!licence.licence_holder_email_normalised) {
    blockers.push("missing_licence_holder_email");
  }

  if (!licence.rendered_licence_body) {
    blockers.push("missing_rendered_licence_body");
  }

  if (!licence.rendered_licence_sha256) {
    blockers.push("missing_rendered_licence_sha256");
  }

  if (!licence.rendered_terms_body_sha256) {
    blockers.push("missing_rendered_terms_body_sha256");
  }

  if (!licence.rendered_licence_at) {
    blockers.push("missing_rendered_licence_at");
  }

  if (!document) {
    blockers.push("document_not_found");
  } else {
    if (document.status !== "active") {
      blockers.push("document_not_active");
    }

    if (!document.source_object) {
      blockers.push("missing_document_source_object");
    }

    if (document.version !== licence.document_version) {
      blockers.push("document_version_mismatch");
    }

    if (document.licence_terms_version !== licence.licence_terms_version) {
      warnings.push("document_terms_version_differs_from_issued_licence_terms");
    }

    if (!document.source_sha256) {
      warnings.push("document_source_sha256_missing");
    }
  }

  if (!accessRequest) {
    blockers.push("access_request_not_found");
  } else {
    if (!accessRequest.email_verified_at) {
      blockers.push("request_email_not_verified");
    }

    if (!accessRequest.terms_accepted_at) {
      blockers.push("request_terms_not_accepted");
    }

    if (accessRequest.document_version !== licence.document_version) {
      blockers.push("request_document_version_mismatch");
    }
  }

  if (licence.revoked_at || licence.status === "revoked") {
    blockers.push("licence_revoked");
  }

  if (licence.confirmed_leak_at) {
    blockers.push("confirmed_leak_recorded");
  }

  if (licence.suspected_leak_at) {
    warnings.push("suspected_leak_recorded");
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

export async function getCdasLicenceGenerationPreview(request, env, licenceIdOrNumber) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to preview CDAS licence PDF generation readiness.",
      },
      { status: 405, headers: { allow: "GET" } }
    );
  }

  const ref = cleanText(licenceIdOrNumber);

  if (!ref) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_licence_id",
        message: "Licence ID or licence number is required.",
      },
      { status: 400 }
    );
  }

  const licence = await getLicence(env, ref);

  if (!licence) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
      },
      { status: 404 }
    );
  }

  const document = await getDocument(env, licence.document_id);
  const accessRequest = await getAccessRequest(env, licence.request_id);

  const readiness = evaluateGenerationReadiness({
    licence,
    document,
    accessRequest,
  });

  const generatedObjectKey = document
    ? buildGeneratedObjectKey({ licence, document })
    : null;

  const generatedFilename = document
    ? buildGeneratedFilename({ licence, document })
    : null;

  return jsonResponse({
    ok: true,
    generated_at: nowIso(),
    mode: "preview_only",
    ready_for_generation: readiness.ready,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      status: licence.status,
      request_id: licence.request_id,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_name: licence.licence_holder_name,
      licence_holder_email_normalised: licence.licence_holder_email_normalised,
      licence_terms_version: licence.licence_terms_version,
      issued_at: licence.issued_at,
      rendered_licence_sha256: licence.rendered_licence_sha256,
      rendered_terms_body_sha256: licence.rendered_terms_body_sha256,
      rendered_licence_at: licence.rendered_licence_at,
    },
    document: document
      ? {
          id: document.id,
          slug: document.slug,
          title: document.title,
          version: document.version,
          status: document.status,
          classification: document.classification,
          access_class: document.access_class,
          source_object: document.source_object,
          source_sha256: document.source_sha256,
          licence_terms_version: document.licence_terms_version,
        }
      : null,
    access_request: accessRequest
      ? {
          id: accessRequest.id,
          status: accessRequest.status,
          email_normalised: accessRequest.email_normalised,
          email_verified_at: accessRequest.email_verified_at,
          terms_accepted_at: accessRequest.terms_accepted_at,
          requested_at: accessRequest.requested_at,
        }
      : null,
    planned_output: {
      generated_object_key: generatedObjectKey,
      generated_filename: generatedFilename,
      content_type: "application/pdf",
      disposition: "attachment",
    },
    controls: {
      writes_to_r2: false,
      generates_pdf: false,
      creates_download_link: false,
      serves_download: false,
      preview_only: true,
    },
    message: readiness.ready
      ? "Licence is ready for future generated PDF creation. This endpoint did not generate or store a PDF."
      : "Licence is not ready for generated PDF creation. Resolve blockers first.",
  });
}