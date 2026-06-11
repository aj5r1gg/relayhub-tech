import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { jsonResponse } from "../shared.js";

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

async function readOptionalJson(request) {
  const contentType = cleanText(request.headers.get("Content-Type")).toLowerCase();

  if (!contentType.includes("application/json")) {
    return {};
  }

  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
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
    document?.slug || document?.id || licence.document_id || "document"
  );
  const versionSlug = slugify(
    licence.document_version || document?.version || "version"
  );
  const licenceSlug = slugify(licence.licence_number || licence.id);
  const downloadSlug = slugify(
    downloadLink?.download_reference || downloadLink?.id || "download"
  );

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
    document?.title || licence.document_id || "RelayHub-Document"
  );
  const version = safeFilename(
    licence.document_version || document?.version || "version"
  );
  const licenceNumber = safeFilename(licence.licence_number || licence.id);
  const downloadReference = safeFilename(
    downloadLink?.download_reference || downloadLink?.id || "download"
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
    `SELECT *
     FROM documents
     WHERE id = ?
     LIMIT 1`
  )
    .bind(ref)
    .first();
}

async function getPendingDownloadLink(env, { downloadLinkId, downloadReference, licenceId }) {
  const id = cleanText(downloadLinkId);
  const reference = cleanText(downloadReference);
  const lic = cleanText(licenceId);

  if (!lic || (!id && !reference)) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_download_links
     WHERE licence_id = ?
       AND status = 'pending_generation'
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND superseded_at IS NULL
       AND (id = ? OR download_reference = ?)
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(lic, id, reference)
    .first();
}

async function markGenerationFailed(env, licenceId, message, options = {}) {
  const updateLicence = options.updateLicence !== false;

  if (!updateLicence) return;

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_licences
     SET
       generated_pdf_status = 'failed',
       generated_pdf_error = ?
     WHERE id = ?`
  )
    .bind(String(message || "Unknown PDF generation failure").slice(0, 2000), licenceId)
    .run();
}

async function markDownloadLinkFailed(env, downloadLinkId, message) {
  const id = cleanText(downloadLinkId);

  if (!id) return;

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET
       status = 'failed',
       failure_reason = ?
     WHERE id = ?
       AND status = 'pending_generation'`
  )
    .bind(String(message || "Unknown PDF generation failure").slice(0, 2000), id)
    .run();
}

async function activateDownloadLinkWithGeneratedPdf(
  env,
  {
    downloadLink,
    generatedObjectKey,
    generatedSha256,
    generatedSizeBytes,
    generatedAt,
  }
) {
  await env.RELAYHUB_DB.prepare(
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
       AND used_at IS NULL
       AND revoked_at IS NULL
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
}

async function recordCdasAuditEvent(env, eventType, metadata) {
  if (!env.RELAYHUB_DB) return;

  try {
    await env.RELAYHUB_DB.prepare(
      `INSERT INTO cdas_audit_events (
         id,
         event_type,
         related_type,
         related_id,
         metadata_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `audit_${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        eventType,
        metadata?.related_type || "licence",
        metadata?.related_id || metadata?.licence_id || null,
        JSON.stringify(metadata || {}),
        nowIso()
      )
      .run();
  } catch {
    // Audit table shape is not part of this generation critical path.
  }
}

function evaluateGenerationBlockers({ licence, document }) {
  const blockers = [];
  const warnings = [];

  if (!licence) {
    blockers.push("licence_not_found");
    return { blockers, warnings };
  }

  if (licence.status !== "active") {
    blockers.push("licence_not_active");
  }

  if (!licence.licence_number) blockers.push("missing_licence_number");
  if (!licence.document_id) blockers.push("missing_document_id");
  if (!licence.document_version) blockers.push("missing_document_version");
  if (!recipientEmail(licence) || recipientEmail(licence) === "—") {
    blockers.push("missing_licence_holder_email");
  }
  if (!licence.rendered_licence_body) blockers.push("missing_rendered_licence_body");
  if (!licence.rendered_licence_sha256) blockers.push("missing_rendered_licence_sha256");
  if (!licence.rendered_terms_body_sha256) blockers.push("missing_rendered_terms_body_sha256");
  if (!licence.source_object) blockers.push("missing_licence_source_object");
  if (!licence.source_sha256) blockers.push("missing_licence_source_sha256");

  if (licence.revoked_at || licence.status === "revoked") {
    blockers.push("licence_revoked");
  }

  if (licence.confirmed_leak_at) {
    blockers.push("confirmed_leak_recorded");
  }

  if (licence.suspected_leak_at) {
    warnings.push("suspected_leak_recorded");
  }

  if (!document) {
    blockers.push("document_not_found");
  } else {
    if (document.status !== "active") blockers.push("document_not_active");
    if (document.version !== licence.document_version) blockers.push("document_version_mismatch");
    if (!document.source_object) blockers.push("missing_document_source_object");
    if (!document.source_sha256) blockers.push("missing_document_source_sha256");

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

function drawFooterOnPages(pdfDoc, font, licence, downloadLink) {
  const pages = pdfDoc.getPages();
  const footerText = [
    "RelayHub licensed copy",
    `Licence: ${licence.licence_number}`,
    `Download ID: ${downloadLink.download_reference}`,
    `Recipient: ${recipientEmail(licence)}`,
  ].join(" | ");

  for (const page of pages) {
    const { width } = page.getSize();

    page.drawText(footerText, {
      x: 36,
      y: 18,
      size: 7,
      font,
      color: rgb(0.25, 0.25, 0.25),
      maxWidth: width - 72,
    });
  }
}

function addCopyInformationPage(pdfDoc, fonts, licence, document, downloadLink) {
  const page = pdfDoc.insertPage(1, [595.28, 841.89]);
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
    y: 744,
    size: 26,
    font: bold,
    color: dark,
  });

  const intro = [
    "This is a requester-specific RelayHub document copy. The Download ID below identifies this particular generated copy and the controlled download link that delivered it.",
    "The Download ID is not a public access code. It is operational evidence used for audit, recovery, support, and misuse investigation.",
  ];

  let y = drawTextBlock(page, intro.flatMap((line) => splitText(line, 88)), {
    x: 54,
    yStart: 708,
    size: 10,
    lineHeight: 15,
    font: regular,
    color: muted,
    maxWidth: 480,
  });

  y -= 20;

  const rows = [
    ["Document", documentDisplayName(document, licence)],
    ["Licence number", licence.licence_number],
    ["Download ID", downloadLink.download_reference],
    ["Recipient", recipientName(licence)],
    ["Recipient email", recipientEmail(licence)],
    ["Issued", dateOnly(licence.issued_at)],
    ["Download link expires", dateOnly(downloadLink.expires_at)],
    ["Copy permission", copyPermissionSummary(licence)],
  ];

  for (const [label, value] of rows) {
    page.drawText(label, {
      x: 54,
      y,
      size: 8,
      font: bold,
      color: muted,
    });

    const valueLines = splitText(value, 76);
    y = drawTextBlock(page, valueLines, {
      x: 190,
      yStart: y,
      size: 10,
      lineHeight: 14,
      font: regular,
      color: dark,
      maxWidth: 350,
    });

    y -= 10;
  }

  y -= 14;

  page.drawText("Operational note", {
    x: 54,
    y,
    size: 13,
    font: bold,
    color: dark,
  });

  y -= 22;

  const note = [
    "This copy may contain visible and embedded licence evidence. Removing the licence evidence, altering the footer, or redistributing the document outside the licence terms may breach the issued licence.",
    "Retain this page when storing, forwarding, printing, or presenting the document.",
  ];

  drawTextBlock(page, note.flatMap((line) => splitText(line, 88)), {
    x: 54,
    yStart: y,
    size: 9.5,
    lineHeight: 14,
    font: regular,
    color: muted,
    maxWidth: 480,
  });
}

function addEvidencePage(pdfDoc, fonts, licence, document, downloadLink, sourceSha256) {
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

  page.drawText("Generated Copy Evidence", {
    x: 54,
    y: 744,
    size: 26,
    font: bold,
    color: dark,
  });

  const rows = [
    ["Document", documentDisplayName(document, licence)],
    ["Document ID", licence.document_id],
    ["Document version", licence.document_version],
    ["Licence number", licence.licence_number],
    ["Licence ID", licence.id],
    ["Download ID", downloadLink.download_reference],
    ["Download link ID", downloadLink.id],
    ["Recipient", recipientName(licence)],
    ["Recipient email", recipientEmail(licence)],
    ["Issued", licence.issued_at],
    ["Generated", nowIso()],
    ["Source object", normaliseR2Key(licence.source_object || document.source_object)],
    ["Source SHA-256", sourceSha256],
    ["Rendered licence SHA-256", licence.rendered_licence_sha256],
    ["Rendered terms body SHA-256", licence.rendered_terms_body_sha256],
  ];

  let y = 704;

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
      size: 8.5,
      lineHeight: 12,
      font: regular,
      color: dark,
      maxWidth: 350,
    });

    y -= 8;
  }

  page.drawText("This page is generated evidence. It is not a public verification service.", {
    x: 54,
    y: 54,
    size: 8,
    font: regular,
    color: muted,
    maxWidth: 480,
  });
}

function addIssuedLicenceAppendix(pdfDoc, fonts, licence) {
  const { regular, bold } = fonts;
  const dark = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.39, 0.47);
  const blue = rgb(0.14, 0.38, 0.72);

  const titlePage = pdfDoc.addPage([595.28, 841.89]);

  titlePage.drawText("RelayHub Controlled Document Access", {
    x: 54,
    y: 780,
    size: 11,
    font: bold,
    color: blue,
  });

  titlePage.drawText("Issued Licence Terms", {
    x: 54,
    y: 744,
    size: 26,
    font: bold,
    color: dark,
  });

  titlePage.drawText(
    "The following pages contain the exact rendered licence terms captured when this licence was issued.",
    {
      x: 54,
      y: 704,
      size: 10,
      font: regular,
      color: muted,
      maxWidth: 480,
    }
  );

  const lines = splitMultilineText(licence.rendered_licence_body || "", 96);
  let page = pdfDoc.addPage([595.28, 841.89]);
  let y = 780;

  page.drawText("Issued Licence Body", {
    x: 54,
    y,
    size: 16,
    font: bold,
    color: dark,
  });

  y -= 34;

  for (const line of lines) {
    if (y < 64) {
      page = pdfDoc.addPage([595.28, 841.89]);
      y = 780;
    }

    page.drawText(line || " ", {
      x: 54,
      y,
      size: 8.5,
      font: regular,
      color: dark,
      maxWidth: 488,
    });

    y -= line ? 12 : 8;
  }
}

async function loadSourcePdf(env, licence, document) {
  const sourceKey = normaliseR2Key(
    licence.source_object || document?.source_object || ""
  );

  if (!sourceKey) {
    throw new Error("missing_source_object_key");
  }

  const object = await env.RELAYHUB_DOWNLOADS.get(sourceKey);

  if (!object) {
    throw new Error(`source_pdf_not_found:${sourceKey}`);
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  const actualSha256 = await sha256HexFromBytes(bytes);
  const expectedSha256 = cleanText(licence.source_sha256 || document?.source_sha256);

  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error("source_pdf_sha256_mismatch");
  }

  return {
    sourceKey,
    bytes,
    actualSha256,
    contentType: object.httpMetadata?.contentType || "application/pdf",
  };
}

async function createGeneratedPdfBytes({
  sourceBytes,
  licence,
  document,
  downloadLink,
  sourceSha256,
}) {
  const pdfDoc = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
  });

  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const fonts = {
    regular,
    bold,
  };

  addCopyInformationPage(pdfDoc, fonts, licence, document, downloadLink);
  addEvidencePage(pdfDoc, fonts, licence, document, downloadLink, sourceSha256);
  addIssuedLicenceAppendix(pdfDoc, fonts, licence);
  drawFooterOnPages(pdfDoc, regular, licence, downloadLink);

  return await pdfDoc.save({
    useObjectStreams: false,
  });
}

async function putGeneratedPdf(env, objectKey, bytes, filename) {
  await env.RELAYHUB_DOWNLOADS.put(objectKey, bytes, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `attachment; filename="${filename}"`,
    },
    customMetadata: {
      relayhub_system: "cdas",
      relayhub_object_type: "generated_pdf",
      generated_at: nowIso(),
    },
  });
}

async function updateLicenceGeneratedPdfEvidence(
  env,
  {
    licence,
    generatedObjectKey,
    generatedFilename,
    generatedSha256,
    generatedSizeBytes,
    generatedAt,
  }
) {
  await env.RELAYHUB_DB.prepare(
    `UPDATE document_licences
     SET
       generated_pdf_object_key = ?,
       generated_pdf_filename = ?,
       generated_pdf_sha256 = ?,
       generated_pdf_size_bytes = ?,
       generated_pdf_content_type = 'application/pdf',
       generated_pdf_status = 'generated',
       generated_pdf_created_at = ?,
       generated_pdf_error = NULL
     WHERE id = ?`
  )
    .bind(
      generatedObjectKey,
      generatedFilename,
      generatedSha256,
      generatedSizeBytes,
      generatedAt,
      licence.id
    )
    .run();
}

function buildGenerationResponse({
  licence,
  document,
  downloadLink,
  generatedObjectKey,
  generatedFilename,
  generatedSha256,
  generatedSizeBytes,
  generatedAt,
  source,
  warnings,
  mode,
  isReissue,
}) {
  return jsonResponse({
    ok: true,
    generated: true,
    already_generated: false,
    mode,
    reissue: Boolean(isReissue),
    warnings,
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
      generated_pdf_status: "generated",
    },
    document: {
      id: document.id,
      slug: document.slug,
      title: document.title,
      version: document.version,
      source_object: document.source_object,
      source_sha256: document.source_sha256,
    },
    download_link: {
      id: downloadLink.id,
      download_reference: downloadLink.download_reference,
      status: "active",
      activated: true,
      activated_at: generatedAt,
      expires_at: downloadLink.expires_at,
      generated_pdf_object_key: generatedObjectKey,
      generated_pdf_sha256: generatedSha256,
      generated_pdf_size_bytes: generatedSizeBytes,
      generated_pdf_created_at: generatedAt,
    },
    generated_pdf: {
      object_key: generatedObjectKey,
      filename: generatedFilename,
      sha256: generatedSha256,
      size_bytes: generatedSizeBytes,
      content_type: "application/pdf",
      created_at: generatedAt,
      status: "generated",
    },
    source: {
      object_key: source.sourceKey,
      sha256: source.actualSha256,
      content_type: source.contentType,
      verified: true,
    },
    controls: {
      reads_source_from_r2: true,
      verifies_source_sha256: true,
      stamps_pdf_pages: true,
      inserts_document_copy_information_page: true,
      appends_licence_evidence_page: true,
      appends_issued_licence_terms: true,
      writes_generated_pdf_to_r2: true,
      updates_licence_generated_pdf_fields: true,
      activates_reserved_download_link: true,
      creates_download_link: false,
      serves_download: false,
      idempotent_retry: false,
      explicit_reissue_mode: Boolean(isReissue),
      overwrites_existing_r2_object: false,
    },
    message: isReissue
      ? "Reissued Download-ID-bound generated PDF was created, stored, bound to the reserved link, and activated."
      : "Download-ID-bound generated PDF was created, stored, bound to the reserved link, and activated.",
  });
}

export async function generateCdasLicencePdf(request, env, licenceIdOrNumber) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to generate a CDAS licence PDF.",
      },
      405
    );
  }

  const body = await readOptionalJson(request);
  const mode = cleanText(body.mode || "initial");
  const isReissue =
    mode === "reissue" && (body.allow_reissue === true || body.allowReissue === true);

  const licence = await getLicence(env, licenceIdOrNumber);

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

  /*
   * Normal generation remains idempotent.
   *
   * Reissue mode is the only path that may intentionally generate a new
   * Download-ID-bound copy when licence-level generated PDF evidence already
   * exists.
   */
  if (!isReissue && hasCompleteGeneratedPdfEvidence(licence)) {
    return alreadyGeneratedResponse(licence);
  }

  if (mode === "reissue" && !isReissue) {
    return jsonResponse(
      {
        ok: false,
        error: "reissue_not_explicitly_allowed",
        message:
          "Reissue mode requires allow_reissue=true. No PDF was generated.",
      },
      409
    );
  }

  const document = await getDocument(env, licence.document_id);
  const readiness = evaluateGenerationBlockers({ licence, document });

  if (readiness.blockers.length) {
    return jsonResponse(
      {
        ok: false,
        error: "generation_blocked",
        message:
          "Generated PDF could not be created because one or more validation gates failed.",
        blockers: readiness.blockers,
        warnings: readiness.warnings,
        licence: {
          id: licence.id,
          licence_number: licence.licence_number,
          status: licence.status,
          document_id: licence.document_id,
          document_version: licence.document_version,
          generated_pdf_status: licence.generated_pdf_status,
        },
        document: document
          ? {
              id: document.id,
              title: document.title,
              version: document.version,
              status: document.status,
              source_object: document.source_object,
              source_sha256: document.source_sha256,
            }
          : null,
        controls: {
          writes_generated_pdf_to_r2: false,
          updates_licence_generated_pdf_fields: false,
          activates_reserved_download_link: false,
        },
      },
      409
    );
  }

  const downloadLink = await getPendingDownloadLink(env, {
    downloadLinkId: body.download_link_id || body.downloadLinkId,
    downloadReference: body.download_reference || body.downloadReference,
    licenceId: licence.id,
  });

  if (!downloadLink) {
    return jsonResponse(
      {
        ok: false,
        error: "pending_download_link_not_found",
        message:
          "A pending_generation download link matching this licence and Download ID is required before generating a Download-ID-bound PDF.",
        controls: {
          writes_generated_pdf_to_r2: false,
          updates_licence_generated_pdf_fields: false,
          activates_reserved_download_link: false,
        },
      },
      409
    );
  }

  if (!downloadLink.download_reference) {
    await markDownloadLinkFailed(
      env,
      downloadLink.id,
      "missing_download_reference_for_pdf_generation"
    );

    return jsonResponse(
      {
        ok: false,
        error: "missing_download_reference",
        message:
          "The pending download link does not have a Download ID, so no PDF was generated.",
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

  try {
    const existingObject = await env.RELAYHUB_DOWNLOADS.head(generatedObjectKey);

    if (existingObject) {
      await markDownloadLinkFailed(
        env,
        downloadLink.id,
        "generated_object_key_already_exists"
      );

      return jsonResponse(
        {
          ok: false,
          error: "generated_object_key_already_exists",
          message:
            "The generated PDF object key already exists. Refusing to overwrite existing evidence.",
          generated_pdf: {
            object_key: generatedObjectKey,
          },
          controls: {
            overwrites_existing_r2_object: false,
            writes_generated_pdf_to_r2: false,
            activates_reserved_download_link: false,
          },
        },
        409
      );
    }

    const source = await loadSourcePdf(env, licence, document);

    const generatedBytes = await createGeneratedPdfBytes({
      sourceBytes: source.bytes,
      licence,
      document,
      downloadLink,
      sourceSha256: source.actualSha256,
    });

    const generatedSha256 = await sha256HexFromBytes(generatedBytes);
    const generatedSizeBytes = generatedBytes.byteLength;
    const generatedAt = nowIso();

    await putGeneratedPdf(
      env,
      generatedObjectKey,
      generatedBytes,
      generatedFilename
    );

    await updateLicenceGeneratedPdfEvidence(env, {
      licence,
      generatedObjectKey,
      generatedFilename,
      generatedSha256,
      generatedSizeBytes,
      generatedAt,
    });

    await activateDownloadLinkWithGeneratedPdf(env, {
      downloadLink,
      generatedObjectKey,
      generatedSha256,
      generatedSizeBytes,
      generatedAt,
    });

    await recordCdasAuditEvent(env, isReissue ? "generated_pdf_reissued" : "generated_pdf_created", {
      related_type: "licence",
      related_id: licence.id,
      licence_id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      download_link_id: downloadLink.id,
      download_reference: downloadLink.download_reference,
      generated_pdf_object_key: generatedObjectKey,
      generated_pdf_sha256: generatedSha256,
      generated_pdf_size_bytes: generatedSizeBytes,
      reissue: Boolean(isReissue),
    });

    await recordCdasAuditEvent(env, "download_link_activated", {
      related_type: "download_link",
      related_id: downloadLink.id,
      licence_id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      download_link_id: downloadLink.id,
      download_reference: downloadLink.download_reference,
      generated_pdf_object_key: generatedObjectKey,
      generated_pdf_sha256: generatedSha256,
      reissue: Boolean(isReissue),
    });

    return buildGenerationResponse({
      licence,
      document,
      downloadLink,
      generatedObjectKey,
      generatedFilename,
      generatedSha256,
      generatedSizeBytes,
      generatedAt,
      source,
      warnings: readiness.warnings,
      mode,
      isReissue,
    });
  } catch (error) {
    const message = error?.message || "unknown_pdf_generation_error";

    await markGenerationFailed(env, licence.id, message, {
      updateLicence: !isReissue,
    });

    await markDownloadLinkFailed(env, downloadLink.id, message);

    await recordCdasAuditEvent(env, isReissue ? "generated_pdf_reissue_failed" : "generated_pdf_failed", {
      related_type: "licence",
      related_id: licence.id,
      licence_id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      download_link_id: downloadLink.id,
      download_reference: downloadLink.download_reference,
      error: message,
      reissue: Boolean(isReissue),
    });

    return jsonResponse(
      {
        ok: false,
        error: "pdf_generation_failed",
        message,
        controls: {
          writes_generated_pdf_to_r2: false,
          updates_licence_generated_pdf_fields: !isReissue,
          activates_reserved_download_link: false,
          pending_download_link_marked_failed: true,
          licence_generation_status_marked_failed: !isReissue,
        },
      },
      500
    );
  }
}
