import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getClientIp, jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

async function sha256HexFromText(text) {
  const encoded = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
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

function normaliseR2Key(value) {
  return cleanText(value).replace(/^\/+/, "");
}

function buildGeneratedObjectKey({ licence, document, downloadLink }) {
  const documentSlug = slugify(
    document.slug || document.id || licence.document_id || "document"
  );
  const versionSlug = slugify(
    licence.document_version || document.version || "version"
  );
  const licenceSlug = slugify(licence.licence_number || licence.id);
  const downloadSlug = slugify(downloadLink.download_reference || downloadLink.id);

  return [
    "docs",
    "generated",
    "cdas",
    documentSlug,
    versionSlug,
    `${licenceSlug}-${downloadSlug}.pdf`,
  ].join("/");
}

function buildGeneratedFilename({ licence, document, downloadLink }) {
  const title = safeFilename(
    document.title || licence.document_id || "RelayHub-Document"
  );
  const version = safeFilename(
    licence.document_version || document.version || "version"
  );
  const licenceNumber = safeFilename(licence.licence_number || licence.id);
  const downloadReference = safeFilename(
    downloadLink.download_reference || downloadLink.id
  );

  return `${title}-v${version}-${licenceNumber}-${downloadReference}.pdf`;
}

function splitText(text, maxChars = 92) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) lines.push(current);

  return lines;
}

function splitMultilineText(text, maxChars = 92) {
  const paragraphs = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  const lines = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();

    if (!trimmed) {
      lines.push("");
      continue;
    }

    lines.push(...splitText(trimmed, maxChars));
  }

  return lines;
}

function dateOnly(value) {
  const text = cleanText(value);
  return text ? text.slice(0, 10) : "—";
}

function documentDisplayName(document, licence) {
  const title = cleanText(document?.title || licence?.document_id || "Document");
  const version = cleanText(licence?.document_version || document?.version);

  if (!version) return title;
  return `${title} v${version}`;
}

function recipientEmail(licence) {
  return (
    cleanText(licence.licence_holder_email_normalised) ||
    cleanText(licence.licence_holder_email) ||
    "—"
  );
}

function recipientName(licence) {
  return (
    cleanText(licence.licence_holder_name) ||
    cleanText(licence.contact_name) ||
    recipientEmail(licence) ||
    "—"
  );
}

function licenceType(licence) {
  return (
    cleanText(licence.recipient_category) ||
    cleanText(licence.licence_terms_version) ||
    "—"
  );
}

function copyPermissionSummary(licence) {
  const terms = cleanText(licence.licence_terms_version).toLowerCase();

  if (terms.includes("free-public-distribution")) {
    return "This document may be shared complete and unmodified. Attribution must be preserved.";
  }

  return "This document is governed by the issued licence terms appended to this generated copy.";
}

function hasCompleteGeneratedPdfEvidence(licence) {
  return Boolean(
    licence &&
      licence.generated_pdf_status === "generated" &&
      licence.generated_pdf_object_key &&
      licence.generated_pdf_filename &&
      licence.generated_pdf_sha256 &&
      licence.generated_pdf_size_bytes
  );
}

function alreadyGeneratedResponse(licence) {
  return jsonResponse({
    ok: true,
    generated: false,
    already_generated: true,
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_email_normalised: licence.licence_holder_email_normalised,
    },
    generated_pdf: {
      object_key: licence.generated_pdf_object_key,
      filename: licence.generated_pdf_filename,
      sha256: licence.generated_pdf_sha256,
      size_bytes: licence.generated_pdf_size_bytes,
      content_type: licence.generated_pdf_content_type || "application/pdf",
      created_at: licence.generated_pdf_created_at,
      status: licence.generated_pdf_status,
    },
    controls: {
      reads_source_from_r2: false,
      verifies_source_sha256: false,
      stamps_pdf_pages: false,
      inserts_document_copy_information_page: false,
      appends_licence_evidence_page: false,
      appends_issued_licence_terms: false,
      writes_generated_pdf_to_r2: false,
      updates_licence_generated_pdf_fields: false,
      activates_reserved_download_link: false,
      creates_download_link: false,
      serves_download: false,
      idempotent_retry: true,
    },
    message:
      "Generated PDF already exists and licence evidence is complete. No new PDF was generated.",
  });
}

async function readOptionalJson(request) {
  const contentType = cleanText(request.headers.get("Content-Type")).toLowerCase();

  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function getLicence(env, licenceIdOrNumber) {
  const ref = cleanText(licenceIdOrNumber);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
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

async function getReservedDownloadLink(env, licenceId, body = {}) {
  const requestedId = cleanText(body.download_link_id);
  const requestedReference = cleanText(body.download_reference);

  if (requestedId || requestedReference) {
    return await env.RELAYHUB_DB.prepare(
      `SELECT *
       FROM document_download_links
       WHERE licence_id = ?
         AND status = 'pending_generation'
         AND revoked_at IS NULL
         AND used_at IS NULL
         AND superseded_at IS NULL
         AND (
           id = ?
           OR download_reference = ?
         )
       ORDER BY created_at DESC
       LIMIT 1`
    )
      .bind(licenceId, requestedId, requestedReference)
      .first();
  }

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_download_links
     WHERE licence_id = ?
       AND status = 'pending_generation'
       AND revoked_at IS NULL
       AND used_at IS NULL
       AND superseded_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(licenceId)
    .first();
}

function evaluateGenerationBlockers({ licence, document, downloadLink }) {
  const blockers = [];
  const warnings = [];

  if (!licence) {
    blockers.push("licence_not_found");
    return { blockers, warnings };
  }

  if (licence.status !== "active") {
    blockers.push("licence_not_active");
  }

  if (!licence.licence_number) {
    blockers.push("missing_licence_number");
  }

  if (!licence.document_id) {
    blockers.push("missing_document_id");
  }

  if (!licence.document_version) {
    blockers.push("missing_document_version");
  }

  if (!licence.licence_holder_name) {
    blockers.push("missing_licence_holder_name");
  }

  if (!licence.licence_holder_email_normalised && !licence.licence_holder_email) {
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

  if (!licence.source_object) {
    blockers.push("missing_licence_source_object");
  }

  if (!licence.source_sha256) {
    blockers.push("missing_licence_source_sha256");
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

  if (!downloadLink) {
    blockers.push("pending_generation_download_link_not_found");
  } else {
    if (downloadLink.status !== "pending_generation") {
      blockers.push("download_link_not_pending_generation");
    }

    if (!downloadLink.download_reference) {
      blockers.push("missing_download_reference");
    }

    if (downloadLink.licence_id !== licence.id) {
      blockers.push("download_link_licence_mismatch");
    }

    if (downloadLink.document_id !== licence.document_id) {
      blockers.push("download_link_document_mismatch");
    }

    if (downloadLink.revoked_at) {
      blockers.push("download_link_revoked");
    }

    if (downloadLink.used_at) {
      blockers.push("download_link_already_used");
    }

    if (downloadLink.superseded_at) {
      blockers.push("download_link_superseded");
    }
  }

  if (!document) {
    blockers.push("document_not_found");
  } else {
    if (document.status !== "active") {
      blockers.push("document_not_active");
    }

    if (document.version !== licence.document_version) {
      blockers.push("document_version_mismatch");
    }

    if (!document.source_object) {
      blockers.push("missing_document_source_object");
    }

    if (!document.source_sha256) {
      blockers.push("missing_document_source_sha256");
    }

    if (
      document.source_sha256 &&
      licence.source_sha256 &&
      document.source_sha256 !== licence.source_sha256
    ) {
      blockers.push("licence_source_sha256_differs_from_document_source_sha256");
    }
  }

  return { blockers, warnings };
}

async function markGenerationFailed(env, licenceId, message, downloadLinkId = null) {
  const failureMessage = String(message || "Unknown PDF generation failure").slice(
    0,
    2000
  );

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_licences
     SET
       generated_pdf_status = 'failed',
       generated_pdf_error = ?
     WHERE id = ?`
  )
    .bind(failureMessage, licenceId)
    .run();

  if (downloadLinkId) {
    await env.RELAYHUB_DB.prepare(
      `UPDATE document_download_links
       SET
         status = 'failed',
         failure_reason = ?
       WHERE id = ?
         AND status = 'pending_generation'`
    )
      .bind(failureMessage, downloadLinkId)
      .run();
  }
}

function drawFooterOnPages(pdfDoc, font, licence, downloadLink) {
  const pages = pdfDoc.getPages();

  const footerText = [
    "RelayHub licensed copy",
    `Licence: ${licence.licence_number}`,
    `Download: ${downloadLink.download_reference}`,
    `Recipient: ${recipientName(licence)}`,
    `Email: ${recipientEmail(licence)}`,
    `Issued: ${dateOnly(licence.issued_at)}`,
  ].join(" | ");

  for (const page of pages) {
    const { width } = page.getSize();

    page.drawText(footerText, {
      x: 28,
      y: 18,
      size: 6,
      font,
      color: rgb(0.25, 0.25, 0.25),
      maxWidth: width - 56,
    });
  }
}

function drawTextBlock(page, lines, options) {
  const { x, yStart, size, lineHeight, font, color, maxLines, maxWidth } = options;

  let y = yStart;
  let count = 0;

  for (const line of lines) {
    if (maxLines && count >= maxLines) break;

    page.drawText(line || " ", {
      x,
      y,
      size,
      font,
      color,
      maxWidth,
    });

    y -= lineHeight;
    count += 1;
  }

  return y;
}

function drawLabelValueRows(page, rows, fonts, startY) {
  const { regular, bold } = fonts;
  const dark = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.39, 0.47);

  let y = startY;

  for (const [label, value] of rows) {
    page.drawText(label, {
      x: 54,
      y,
      size: 10,
      font: bold,
      color: muted,
    });

    const valueLines = splitText(value || "—", 78);
    y = drawTextBlock(page, valueLines, {
      x: 210,
      yStart: y,
      size: 10,
      lineHeight: 14,
      font: regular,
      color: dark,
      maxLines: 4,
      maxWidth: 320,
    });

    y -= 9;
  }

  return y;
}

function insertDocumentCopyInformationPage({
  pdfDoc,
  fonts,
  licence,
  document,
  downloadLink,
  generatedAt,
}) {
  const insertIndex = pdfDoc.getPageCount() >= 1 ? 1 : 0;
  const page = pdfDoc.insertPage(insertIndex, [595.28, 841.89]);
  const { regular, bold } = fonts;

  const dark = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.39, 0.47);
  const blue = rgb(0.14, 0.38, 0.72);

  page.drawText("RelayHub Controlled Document Access", {
    x: 54,
    y: 780,
    size: 11,
    font: bold,
    color: blue,
  });

  page.drawText("Document Copy Information", {
    x: 54,
    y: 742,
    size: 26,
    font: bold,
    color: dark,
  });

  const rows = [
    ["Document Name", documentDisplayName(document, licence)],
    ["Generated for", recipientName(licence)],
    ["Email", recipientEmail(licence)],
    ["Download ID", downloadLink.download_reference],
    ["Licence Number", licence.licence_number],
    ["Licence Type", licenceType(licence)],
    ["Generated At", generatedAt],
    ["Licence Issued At", licence.issued_at || "—"],
  ];

  let y = drawLabelValueRows(page, rows, fonts, 690);

  const summary = copyPermissionSummary(licence);
  const summaryLines = splitText(summary, 86);

  y -= 12;

  drawTextBlock(page, summaryLines, {
    x: 54,
    yStart: y,
    size: 11,
    lineHeight: 16,
    font: regular,
    color: dark,
    maxWidth: 480,
  });

  page.drawText(
    "This page identifies the generated copy. It should remain with the document if shared or archived.",
    {
      x: 54,
      y: 72,
      size: 8,
      font: regular,
      color: muted,
      maxWidth: 480,
    }
  );
}

function addEvidencePage({
  pdfDoc,
  fonts,
  licence,
  document,
  downloadLink,
  generatedObjectKey,
  generatedFilename,
}) {
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { regular, bold } = fonts;

  const dark = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.39, 0.47);
  const blue = rgb(0.14, 0.38, 0.72);

  page.drawText("RelayHub Controlled Document Access", {
    x: 54,
    y: 780,
    size: 11,
    font: bold,
    color: blue,
  });

  page.drawText("Licence Evidence Sheet", {
    x: 54,
    y: 748,
    size: 26,
    font: bold,
    color: dark,
  });

  const summaryLines = [
    "This PDF was generated as a licensed RelayHub document copy.",
    "It records the licence and download evidence bound to this generated file.",
  ];

  drawTextBlock(page, summaryLines, {
    x: 54,
    yStart: 716,
    size: 10,
    lineHeight: 15,
    font: regular,
    color: muted,
    maxWidth: 480,
  });

  const rows = [
    ["Licence number", licence.licence_number],
    ["Download ID", downloadLink.download_reference],
    ["Download link ID", downloadLink.id],
    ["Licence ID", licence.id],
    ["Licence status", licence.status],
    ["Issued at", licence.issued_at],
    ["Licence holder", recipientName(licence)],
    ["Recipient email", recipientEmail(licence)],
    ["Document ID", licence.document_id],
    ["Document title", document.title],
    ["Document version", licence.document_version],
    ["Source object", licence.source_object],
    ["Source SHA-256", licence.source_sha256],
    ["Rendered licence SHA-256", licence.rendered_licence_sha256],
    ["Rendered terms SHA-256", licence.rendered_terms_body_sha256],
    ["Generated object key", generatedObjectKey],
    ["Generated filename", generatedFilename],
  ];

  let y = 670;

  for (const [label, value] of rows) {
    page.drawText(label, {
      x: 54,
      y,
      size: 8,
      font: bold,
      color: muted,
    });

    const valueLines = splitText(value || "—", 72);
    y = drawTextBlock(page, valueLines, {
      x: 190,
      yStart: y,
      size: 8,
      lineHeight: 11,
      font: regular,
      color: dark,
      maxLines: 5,
      maxWidth: 340,
    });

    y -= 8;

    if (y < 110) {
      break;
    }
  }

  page.drawText("Controls", {
    x: 54,
    y: 84,
    size: 10,
    font: bold,
    color: dark,
  });

  page.drawText(
    "Generated PDF was written to private R2 storage and bound to the reserved Download ID.",
    {
      x: 54,
      y: 66,
      size: 8,
      font: regular,
      color: muted,
      maxWidth: 480,
    }
  );
}

function addIssuedLicenceTermsAppendix({ pdfDoc, fonts, licence }) {
  const { regular, bold } = fonts;

  const dark = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.39, 0.47);
  const blue = rgb(0.14, 0.38, 0.72);

  const lines = splitMultilineText(licence.rendered_licence_body, 92);
  let page = null;
  let y = 0;
  let pageNumber = 0;

  function newAppendixPage() {
    pageNumber += 1;
    page = pdfDoc.addPage([595.28, 841.89]);
    y = 780;

    page.drawText("RelayHub Controlled Document Access", {
      x: 54,
      y,
      size: 11,
      font: bold,
      color: blue,
    });

    y -= 36;

    page.drawText(
      pageNumber === 1
        ? "Issued Licence and Terms"
        : `Issued Licence and Terms continued (${pageNumber})`,
      {
        x: 54,
        y,
        size: 22,
        font: bold,
        color: dark,
      }
    );

    y -= 28;

    if (pageNumber === 1) {
      const metaLines = [
        `Licence Number: ${licence.licence_number}`,
        `Licence Holder: ${recipientName(licence)}`,
        `Email: ${recipientEmail(licence)}`,
        `Terms Version: ${licence.licence_terms_version || "—"}`,
        `Rendered Licence SHA-256: ${licence.rendered_licence_sha256 || "—"}`,
        `Rendered Terms SHA-256: ${licence.rendered_terms_body_sha256 || "—"}`,
      ];

      y = drawTextBlock(page, metaLines, {
        x: 54,
        yStart: y,
        size: 8,
        lineHeight: 12,
        font: regular,
        color: muted,
        maxWidth: 480,
      });

      y -= 16;
    }
  }

  newAppendixPage();

  for (const line of lines) {
    if (y < 66) {
      newAppendixPage();
    }

    page.drawText(line || " ", {
      x: 54,
      y,
      size: 9,
      font: regular,
      color: dark,
      maxWidth: 488,
    });

    y -= line ? 12 : 8;
  }
}

async function recordDownloadEvent({
  env,
  request,
  licence,
  downloadLink,
  eventType,
  success = 1,
  failureReason = null,
}) {
  const ip = getClientIp(request);
  const ipHash = ip ? await sha256HexFromText(ip) : null;

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_download_events (
       id,
       download_id,
       licence_id,
       licence_number,
       document_id,
       document_version,
       licence_holder_name,
       organisation_name,
       licence_holder_email,
       event_type,
       event_at,
       ip_hash,
       user_agent,
       generated_object,
       source_object,
       source_sha256,
       generated_sha256,
       template_sha256,
       licence_page_template_version,
       watermark_template_version,
       footer_template_version,
       terms_template_version,
       generation_engine_version,
       terms_version,
       success,
       failure_reason
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      `dde_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 18)}`,
      downloadLink?.id || null,
      licence.id,
      licence.licence_number,
      licence.document_id,
      licence.document_version,
      licence.licence_holder_name || null,
      licence.organisation_name || null,
      recipientEmail(licence),
      eventType,
      nowIso(),
      ipHash,
      cleanText(request.headers.get("User-Agent")).slice(0, 500),
      licence.generated_pdf_object_key || null,
      licence.source_object || null,
      licence.source_sha256 || null,
      licence.generated_pdf_sha256 || null,
      licence.rendered_licence_sha256 || null,
      null,
      null,
      "cdas-footer-v2",
      licence.licence_terms_version || null,
      "cdas-pdf-lib-v2",
      licence.licence_terms_version,
      success ? 1 : 0,
      failureReason
    )
    .run();
}

async function activateReservedDownloadLink({
  env,
  downloadLink,
  generatedObjectKey,
  generatedSha256,
  generatedSizeBytes,
  generatedAt,
}) {
  const result = await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       status = 'active',
       activated_at = ?,
       generated_pdf_object_key = ?,
       generated_pdf_sha256 = ?,
       generated_pdf_size_bytes = ?,
       generated_pdf_created_at = ?,
       failure_reason = NULL
     WHERE id = ?
       AND status = 'pending_generation'
       AND revoked_at IS NULL
       AND used_at IS NULL
       AND superseded_at IS NULL`
  )
    .bind(
      generatedAt,
      generatedObjectKey,
      generatedSha256,
      generatedSizeBytes,
      generatedAt,
      downloadLink.id
    )
    .run();

  return result?.meta?.changes ?? 0;
}

export async function generateCdasLicencePdf(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to generate a CDAS licensed PDF.",
      },
      405
    );
  }

  if (!env.RELAYHUB_DOWNLOADS) {
    return jsonResponse(
      {
        ok: false,
        error: "r2_binding_missing",
        message: "R2 binding RELAYHUB_DOWNLOADS is not available to the Worker.",
      },
      500
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
      400
    );
  }

  const body = await readOptionalJson(request);
  const licence = await getLicence(env, ref);

  if (!licence) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
      },
      404
    );
  }

  if (hasCompleteGeneratedPdfEvidence(licence)) {
    return alreadyGeneratedResponse(licence);
  }

  const document = await getDocument(env, licence.document_id);
  const downloadLink = await getReservedDownloadLink(env, licence.id, body);

  const readiness = evaluateGenerationBlockers({
    licence,
    document,
    downloadLink,
  });

  if (readiness.blockers.length) {
    await markGenerationFailed(
      env,
      licence.id,
      `Generation blocked: ${readiness.blockers.join(", ")}`,
      downloadLink?.id || null
    );

    return jsonResponse(
      {
        ok: false,
        error: "generation_blocked",
        message: "Generated PDF was not created because one or more blockers were found.",
        blockers: readiness.blockers,
        warnings: readiness.warnings,
      },
      409
    );
  }

  const sourceObjectKey = normaliseR2Key(licence.source_object);
  const sourceObject = await env.RELAYHUB_DOWNLOADS.get(sourceObjectKey);

  if (!sourceObject) {
    await markGenerationFailed(
      env,
      licence.id,
      "Source object was not found in R2.",
      downloadLink.id
    );

    return jsonResponse(
      {
        ok: false,
        error: "source_object_not_found_in_r2",
        message: "The source PDF object was not found in R2.",
        source_object: sourceObjectKey,
      },
      404
    );
  }

  const sourceBytes = await sourceObject.arrayBuffer();
  const actualSourceSha256 = await sha256HexFromBytes(sourceBytes);

  if (actualSourceSha256 !== licence.source_sha256) {
    await markGenerationFailed(
      env,
      licence.id,
      "Source PDF SHA-256 did not match the licence source evidence.",
      downloadLink.id
    );

    return jsonResponse(
      {
        ok: false,
        error: "source_sha256_mismatch",
        message:
          "The current R2 source PDF does not match the source SHA-256 stored on the licence.",
        expected_source_sha256: licence.source_sha256,
        actual_source_sha256: actualSourceSha256,
      },
      409
    );
  }

  const generatedObjectKey = buildGeneratedObjectKey({
    licence,
    document,
    downloadLink,
  });
  const generatedFilename = buildGeneratedFilename({
    licence,
    document,
    downloadLink,
  });

  const existingGeneratedObject = await env.RELAYHUB_DOWNLOADS.get(generatedObjectKey);

  if (existingGeneratedObject) {
    return jsonResponse(
      {
        ok: false,
        error: "generated_pdf_object_already_exists_repair_required",
        message:
          "Generated PDF object already exists in R2, but the licence evidence record is not complete. Refusing to overwrite. Inspect and repair the database evidence record before continuing.",
        generated_object_key: generatedObjectKey,
        download_link: {
          id: downloadLink.id,
          download_reference: downloadLink.download_reference,
          status: downloadLink.status,
        },
        licence: {
          id: licence.id,
          licence_number: licence.licence_number,
          generated_pdf_status: licence.generated_pdf_status,
          generated_pdf_object_key: licence.generated_pdf_object_key,
          generated_pdf_sha256: licence.generated_pdf_sha256,
          generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
          generated_pdf_created_at: licence.generated_pdf_created_at,
        },
        controls: {
          writes_generated_pdf_to_r2: false,
          overwrites_existing_r2_object: false,
          marks_generation_failed: false,
          activates_reserved_download_link: false,
          creates_download_link: false,
          serves_download: false,
          repair_required: true,
        },
      },
      409
    );
  }

  const generatedAt = nowIso();
  let generatedBytes;

  try {
    const pdfDoc = await PDFDocument.load(sourceBytes);
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    insertDocumentCopyInformationPage({
      pdfDoc,
      fonts: { regular, bold },
      licence,
      document,
      downloadLink,
      generatedAt,
    });

    addEvidencePage({
      pdfDoc,
      fonts: { regular, bold },
      licence,
      document,
      downloadLink,
      generatedObjectKey,
      generatedFilename,
    });

    addIssuedLicenceTermsAppendix({
      pdfDoc,
      fonts: { regular, bold },
      licence,
    });

    drawFooterOnPages(pdfDoc, regular, licence, downloadLink);

    generatedBytes = await pdfDoc.save({
      useObjectStreams: false,
    });
  } catch (error) {
    await markGenerationFailed(env, licence.id, error.message, downloadLink.id);

    return jsonResponse(
      {
        ok: false,
        error: "pdf_generation_failed",
        message: "PDF generation failed.",
        details: error.message,
      },
      500
    );
  }

  const generatedSha256 = await sha256HexFromBytes(generatedBytes);

  await env.RELAYHUB_DOWNLOADS.put(generatedObjectKey, generatedBytes, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `attachment; filename="${generatedFilename}"`,
    },
    customMetadata: {
      cdas: "true",
      licence_id: licence.id,
      licence_number: licence.licence_number,
      download_link_id: downloadLink.id,
      download_reference: downloadLink.download_reference,
      document_id: licence.document_id,
      document_version: licence.document_version,
      source_sha256: licence.source_sha256,
      generated_pdf_sha256: generatedSha256,
    },
  });

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_licences
     SET
       generated_pdf_object_key = ?,
       generated_pdf_filename = ?,
       generated_pdf_sha256 = ?,
       generated_pdf_size_bytes = ?,
       generated_pdf_content_type = ?,
       generated_pdf_status = 'generated',
       generated_pdf_created_at = ?,
       generated_pdf_error = NULL
     WHERE id = ?`
  )
    .bind(
      generatedObjectKey,
      generatedFilename,
      generatedSha256,
      generatedBytes.byteLength,
      "application/pdf",
      generatedAt,
      licence.id
    )
    .run();

  const activatedCount = await activateReservedDownloadLink({
    env,
    downloadLink,
    generatedObjectKey,
    generatedSha256,
    generatedSizeBytes: generatedBytes.byteLength,
    generatedAt,
  });

  const updatedLicence = {
    ...licence,
    generated_pdf_object_key: generatedObjectKey,
    generated_pdf_filename: generatedFilename,
    generated_pdf_sha256: generatedSha256,
    generated_pdf_size_bytes: generatedBytes.byteLength,
    generated_pdf_content_type: "application/pdf",
    generated_pdf_status: "generated",
    generated_pdf_created_at: generatedAt,
    generated_pdf_error: null,
  };

  await recordDownloadEvent({
    env,
    request,
    licence: updatedLicence,
    downloadLink,
    eventType: "generated_pdf_created",
    success: 1,
    failureReason: null,
  });

  await recordDownloadEvent({
    env,
    request,
    licence: updatedLicence,
    downloadLink,
    eventType: activatedCount > 0
      ? "download_link_activated"
      : "download_link_activation_not_applied",
    success: activatedCount > 0 ? 1 : 0,
    failureReason: activatedCount > 0 ? null : "reserved_download_link_not_updated",
  });

  return jsonResponse({
    ok: true,
    generated: true,
    generated_at: generatedAt,
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_name: recipientName(licence),
      licence_holder_email_normalised: recipientEmail(licence),
      issued_at: licence.issued_at,
      licence_terms_version: licence.licence_terms_version,
      source_object: licence.source_object,
      source_sha256: licence.source_sha256,
      rendered_licence_sha256: licence.rendered_licence_sha256,
      rendered_terms_body_sha256: licence.rendered_terms_body_sha256,
    },
    download_link: {
      id: downloadLink.id,
      download_reference: downloadLink.download_reference,
      previous_status: downloadLink.status,
      status: activatedCount > 0 ? "active" : downloadLink.status,
      activated: activatedCount > 0,
      activated_at: activatedCount > 0 ? generatedAt : null,
      generated_pdf_object_key: generatedObjectKey,
      generated_pdf_sha256: generatedSha256,
      generated_pdf_size_bytes: generatedBytes.byteLength,
    },
    generated_pdf: {
      object_key: generatedObjectKey,
      filename: generatedFilename,
      sha256: generatedSha256,
      size_bytes: generatedBytes.byteLength,
      content_type: "application/pdf",
      status: "generated",
    },
    warnings: readiness.warnings,
    controls: {
      reads_source_from_r2: true,
      verifies_source_sha256: true,
      requires_reserved_download_link: true,
      embeds_download_reference: true,
      stamps_pdf_pages: true,
      footer_includes_licence_number: true,
      footer_includes_download_reference: true,
      footer_includes_recipient_name: true,
      footer_includes_recipient_email: true,
      footer_includes_issued_date: true,
      inserts_document_copy_information_page: true,
      appends_licence_evidence_page: true,
      appends_issued_licence_terms: true,
      writes_generated_pdf_to_r2: true,
      updates_licence_generated_pdf_fields: true,
      activates_reserved_download_link: activatedCount > 0,
      creates_download_link: false,
      serves_download: false,
    },
    message:
      "Generated PDF was created, stamped, given a Document Copy Information page, bound to the reserved Download ID, stored in private R2, and the reserved download link was activated.",
  });
}