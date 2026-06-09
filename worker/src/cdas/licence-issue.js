function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 8) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeLicenceId() {
  return `lic_${Date.now().toString(36)}_${randomHex(8)}`;
}

function padSequence(value) {
  return String(value).padStart(6, "0");
}

function currentYear() {
  return new Date().getUTCFullYear();
}

function currentYearText() {
  return String(currentYear());
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extractPlaceholders(text) {
  const matches = String(text || "").match(/\{\{[A-Z0-9_]+\}\}/g) || [];
  return Array.from(new Set(matches)).sort();
}

function defaultOfficialWebsite(env) {
  return cleanText(env.RELAYHUB_OFFICIAL_WEBSITE) || "https://www.relayhub.tech";
}

function defaultContactEmail(env) {
  return cleanText(env.RELAYHUB_CONTACT_EMAIL) || "contact@relayhub.tech";
}

function defaultCopyrightHolder(env) {
  return cleanText(env.RELAYHUB_COPYRIGHT_HOLDER) || "RelayHub";
}

function renderTemplate(templateBody, values) {
  let rendered = String(templateBody || "");

  for (const [placeholder, value] of Object.entries(values)) {
    if (value === undefined || value === null) {
      continue;
    }

    rendered = rendered.split(placeholder).join(String(value));
  }

  return rendered;
}

async function nextLicenceNumber(env) {
  const year = currentYear();
  const prefix = `RH-LIC-${year}-`;

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT licence_number
     FROM document_licences
     WHERE licence_number LIKE ?
     ORDER BY licence_number DESC
     LIMIT 1`
  )
    .bind(`${prefix}%`)
    .first();

  if (!row?.licence_number) {
    return `${prefix}${padSequence(1)}`;
  }

  const previous = String(row.licence_number).replace(prefix, "");
  const parsed = Number.parseInt(previous, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return `${prefix}${padSequence(1)}`;
  }

  return `${prefix}${padSequence(parsed + 1)}`;
}

async function getAccessRequestForLicenceIssue(env, requestId) {
  const id = cleanText(requestId);

  if (!id) {
    return null;
  }

  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       document_id,
       document_version,
       name,
       email,
       email_normalised,
       licence_holder_type,
       organisation_name,
       contact_name,
       contact_email,
       role_title,
       recipient_category,
       status,
       access_class,
       email_verified_at,
       approved_at,
       denied_at,
       terms_version,
       terms_accepted_at
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();

  return row || null;
}

async function getDocumentForLicenceIssue(env, documentId) {
  const id = cleanText(documentId);

  if (!id) {
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
       source_sha256,
       licence_terms_version
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(id, id)
    .first();

  return row || null;
}

async function getLicenceTermsForIssue(env, termsVersion) {
  const version = cleanText(termsVersion);

  if (!version) {
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
    .bind(version, version)
    .first();

  return row || null;
}

async function getExistingLicenceByRequestId(env, requestId) {
  const row = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       licence_number,
       request_id,
       document_id,
       document_version,
       licence_holder_email_normalised,
       status,
       issued_at,
       rendered_licence_sha256,
       rendered_terms_body_sha256,
       rendered_licence_at,
       source_object,
       source_sha256,
       generated_pdf_status,
       generated_pdf_object_key,
       generated_pdf_sha256
     FROM document_licences
     WHERE request_id = ?
     LIMIT 1`
  )
    .bind(requestId)
    .first();

  return row || null;
}

function canIssueLicence(row) {
  if (!row) {
    return {
      ok: false,
      error: "request_not_found",
      message: "The access request could not be found.",
    };
  }

  if (row.denied_at || row.status === "denied" || row.status === "cancelled") {
    return {
      ok: false,
      error: "request_not_licensable",
      message: "This access request is not eligible for licence issue.",
    };
  }

  if (!row.email_verified_at) {
    return {
      ok: false,
      error: "email_not_verified",
      message: "The request email must be verified before a licence can be issued.",
    };
  }

  if (!row.terms_accepted_at) {
    return {
      ok: false,
      error: "terms_not_accepted",
      message: "The request terms must be accepted before a licence can be issued.",
    };
  }

  if (
    row.access_class === "approval_required" ||
    row.access_class === "invite_only" ||
    row.status === "approval_pending"
  ) {
    if (!row.approved_at) {
      return {
        ok: false,
        error: "approval_required",
        message: "This request requires approval before a licence can be issued.",
      };
    }
  }

  if (
    row.status !== "email_verified" &&
    row.status !== "approved" &&
    row.status !== "licence_issued"
  ) {
    return {
      ok: false,
      error: "invalid_request_status",
      message: "This access request is not in a licence-issuable state.",
    };
  }

  return { ok: true };
}

function licenceHolderName(row) {
  if (row.licence_holder_type === "organisation") {
    return cleanText(row.organisation_name) || cleanText(row.name);
  }

  return cleanText(row.name);
}

function contactName(row) {
  return cleanText(row.contact_name) || cleanText(row.name);
}

function contactEmail(row) {
  return cleanText(row.contact_email) || cleanText(row.email);
}

function organisationNameForLicence(row) {
  const organisation = cleanText(row.organisation_name);

  if (organisation) {
    return organisation;
  }

  if (row.licence_holder_type === "organisation") {
    return "Organisation name not supplied";
  }

  return "Not applicable";
}

function buildIssuedLicenceRenderValues({
  env,
  requestRow,
  document,
  licenceNumber,
  issuedAt,
}) {
  return {
    "{{DOCUMENT_TITLE}}": document.title,
    "{{DOCUMENT_VERSION}}": document.version,
    "{{YEAR}}": currentYearText(),
    "{{COPYRIGHT_HOLDER}}": defaultCopyrightHolder(env),
    "{{OFFICIAL_WEBSITE}}": defaultOfficialWebsite(env),
    "{{CONTACT_EMAIL}}": defaultContactEmail(env),

    "{{LICENSED_NAME}}":
      licenceHolderName(requestRow) ||
      contactName(requestRow) ||
      requestRow.email_normalised ||
      requestRow.email ||
      "Unknown recipient",
    "{{LICENSED_EMAIL}}": requestRow.email_normalised || requestRow.email,
    "{{LICENSED_ORGANISATION}}": organisationNameForLicence(requestRow),
    "{{LICENCE_NUMBER}}": licenceNumber,
    "{{DOWNLOAD_ID}}": "Not issued yet",
    "{{ORDER_NUMBER}}": "Not applicable",
    "{{LICENCE_DATE}}": issuedAt.slice(0, 10),
  };
}

async function renderIssuedLicenceEvidence({
  env,
  requestRow,
  document,
  terms,
  licenceNumber,
  issuedAt,
}) {
  if (!terms || !terms.body) {
    return {
      ok: false,
      error: "licence_terms_not_found",
      message: "The assigned licence terms could not be found.",
    };
  }

  if (terms.status !== "active") {
    return {
      ok: false,
      error: "licence_terms_not_active",
      message: "The assigned licence terms are not active.",
    };
  }

  const templatePlaceholders = extractPlaceholders(terms.body);
  const values = buildIssuedLicenceRenderValues({
    env,
    requestRow,
    document,
    licenceNumber,
    issuedAt,
  });

  const renderedBody = renderTemplate(terms.body, values);
  const unresolvedPlaceholders = extractPlaceholders(renderedBody);

  if (unresolvedPlaceholders.length) {
    return {
      ok: false,
      error: "rendered_licence_has_unresolved_placeholders",
      message:
        "The issued licence could not be created because rendered licence terms still contain unresolved placeholders.",
      unresolved_placeholders: unresolvedPlaceholders,
      template_placeholders: templatePlaceholders,
    };
  }

  return {
    ok: true,
    rendered_body: renderedBody,
    rendered_sha256: await sha256Hex(renderedBody),
    terms_body_sha256: terms.body_sha256 || await sha256Hex(terms.body),
    template_placeholders: templatePlaceholders,
    unresolved_placeholders: unresolvedPlaceholders,
    rendered_at: issuedAt,
  };
}

function sourceEvidenceWarnings(document) {
  const warnings = [];

  if (!document.source_object) {
    warnings.push("document_source_object_missing");
  }

  if (!document.source_sha256) {
    warnings.push("document_source_sha256_missing");
  }

  return warnings;
}

export async function issueLicenceForVerifiedRequest(env, requestId) {
  const row = await getAccessRequestForLicenceIssue(env, requestId);

  const eligibility = canIssueLicence(row);

  if (!eligibility.ok) {
    return {
      ok: false,
      issued: false,
      error: eligibility.error,
      message: eligibility.message,
      request: row
        ? {
            id: row.id,
            status: row.status,
            access_class: row.access_class,
          }
        : null,
    };
  }

  const existing = await getExistingLicenceByRequestId(env, row.id);

  if (existing) {
    return {
      ok: true,
      issued: false,
      already_issued: true,
      licence: existing,
      message: "A licence has already been issued for this access request.",
    };
  }

  const document = await getDocumentForLicenceIssue(env, row.document_id);

  if (!document) {
    return {
      ok: false,
      issued: false,
      error: "document_not_found",
      message: "The document for this access request could not be found.",
    };
  }

  if (document.status !== "active") {
    return {
      ok: false,
      issued: false,
      error: "document_not_active",
      message: "The document is not currently active.",
      document: {
        id: document.id,
        status: document.status,
      },
    };
  }

  if (document.version !== row.document_version) {
    return {
      ok: false,
      issued: false,
      error: "document_version_mismatch",
      message:
        "The access request document version does not match the current document record.",
      request_version: row.document_version,
      document_version: document.version,
    };
  }

  const terms = await getLicenceTermsForIssue(env, row.terms_version);

  if (!terms) {
    return {
      ok: false,
      issued: false,
      error: "licence_terms_not_found",
      message: "The licence terms for this access request could not be found.",
    };
  }

  const issuedAt = nowIso();
  const licenceId = makeLicenceId();
  const licenceNumber = await nextLicenceNumber(env);

  const evidence = await renderIssuedLicenceEvidence({
    env,
    requestRow: row,
    document,
    terms,
    licenceNumber,
    issuedAt,
  });

  if (!evidence.ok) {
    return {
      ok: false,
      issued: false,
      error: evidence.error,
      message: evidence.message,
      unresolved_placeholders: evidence.unresolved_placeholders || [],
      template_placeholders: evidence.template_placeholders || [],
    };
  }

  const warnings = sourceEvidenceWarnings(document);

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_licences (
       id,
       licence_number,
       request_id,
       document_id,
       document_version,
       licence_holder_type,
       licence_holder_name,
       organisation_name,
       contact_name,
       contact_email,
       licence_holder_email,
       licence_holder_email_normalised,
       recipient_category,
       licence_terms_version,
       status,
       issued_at,
       expires_at,
       revoked_at,
       revoked_by,
       revocation_reason,
       superseded_by,
       corrected_from,
       suspected_leak_at,
       confirmed_leak_at,
       notes,
       rendered_licence_body,
       rendered_licence_sha256,
       rendered_terms_body_sha256,
       rendered_licence_placeholders,
       rendered_licence_unresolved_placeholders,
       rendered_licence_at,
       source_object,
       source_sha256,
       generated_pdf_object_key,
       generated_pdf_filename,
       generated_pdf_sha256,
       generated_pdf_size_bytes,
       generated_pdf_content_type,
       generated_pdf_status,
       generated_pdf_created_at,
       generated_pdf_error
     )
     VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       ?, ?, ?, ?, ?, ?,
       ?, ?,
       NULL, NULL, NULL, NULL, NULL,
       ?, NULL, NULL
     )`
  )
    .bind(
      licenceId,
      licenceNumber,
      row.id,
      row.document_id,
      row.document_version,
      row.licence_holder_type || "individual",
      licenceHolderName(row) || null,
      cleanText(row.organisation_name) || null,
      contactName(row) || null,
      contactEmail(row) || null,
      row.email,
      row.email_normalised,
      row.recipient_category || "unknown",
      row.terms_version,
      "active",
      issuedAt,
      evidence.rendered_body,
      evidence.rendered_sha256,
      evidence.terms_body_sha256,
      JSON.stringify(evidence.template_placeholders),
      JSON.stringify(evidence.unresolved_placeholders),
      evidence.rendered_at,
      cleanText(document.source_object) || null,
      cleanText(document.source_sha256) || null,
      "not_generated"
    )
    .run();

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_access_requests
     SET status = 'licence_issued'
     WHERE id = ?
       AND status IN ('email_verified', 'approved', 'licence_issued')`
  )
    .bind(row.id)
    .run();

  return {
    ok: true,
    issued: true,
    already_issued: false,
    warnings,
    licence: {
      id: licenceId,
      licence_number: licenceNumber,
      request_id: row.id,
      document_id: row.document_id,
      document_version: row.document_version,
      licence_holder_email_normalised: row.email_normalised,
      status: "active",
      issued_at: issuedAt,
      rendered_licence_sha256: evidence.rendered_sha256,
      rendered_terms_body_sha256: evidence.terms_body_sha256,
      rendered_licence_at: evidence.rendered_at,
      source_object: cleanText(document.source_object) || null,
      source_sha256: cleanText(document.source_sha256) || null,
      generated_pdf_status: "not_generated",
      generated_pdf_object_key: null,
      generated_pdf_sha256: null,
    },
    controls: {
      creates_licence_record: true,
      captures_rendered_licence_evidence: true,
      captures_source_evidence: true,
      generates_pdf: false,
      writes_generated_pdf_to_r2: false,
      creates_download_link: false,
      serves_download: false,
    },
    message:
      "Licence record, rendered licence evidence, and source document evidence were created. PDF generation and download-link issuing are not active yet.",
  };
}