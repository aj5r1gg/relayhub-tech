import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { jsonResponse } from "../shared.js";
import { evaluateCdasLicenceToPdfEligibility } from "./licence-to-pdf-gate.js";

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

function recipientEmail(licence) {
  return (
    cleanText(licence?.licence_holder_email_normalised) ||
    cleanText(licence?.licence_holder_email) ||
    cleanText(licence?.contact_email) ||
    "—"
  );
}

function recipientName(licence) {
  return (
    cleanText(licence?.licence_holder_name) ||
    cleanText(licence?.contact_name) ||
    recipientEmail(licence) ||
    "—"
  );
}

function documentDisplayName(document, licence) {
  const title = cleanText(document?.title || licence?.document_id || "Document");
  const version = cleanText(licence?.document_version || document?.version);

  if (!version) return title;
  return `${title} v${version}`;
}

function copyPermissionSummary(licence) {
  const terms = cleanText(licence?.licence_terms_version).toLowerCase();

  if (terms.includes("free-public-distribution")) {
    return "This document may be shared complete and unmodified. Attribution must be preserved.";
  }

  return "This document is governed by the issued licence terms for this recipient.";
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

function buildGeneratedObjectKey({ licence, document }) {
  const documentSlug = slugify(document?.slug || document?.id || licence.document_id || "document");
  const versionSlug = slugify(licence.document_version || document?.version || "version");
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
  const title = safeFilename(document?.title || licence.document_id || "RelayHub-Document");
  const version = safeFilename(licence.document_version || document?.version || "version");
  const licenceNumber = safeFilename(licence.licence_number || licence.id);

  return `${title}-v${version}-${licenceNumber}.pdf`;
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

async function getDocument(env, documentId, version) {
  const id = cleanText(documentId);
  const ver = cleanText(version);

  if (!id || !ver) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM documents
     WHERE id = ?
       AND version = ?
     LIMIT 1`
  )
    .bind(id, ver)
    .first();
}

async function markGenerationFailed(env, licenceId, message) {
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

function drawFooterOnPages(pdfDoc, font, licence) {
  const pages = pdfDoc.getPages();
  const footerText = [
    "RelayHub licensed copy",
    `Licence: ${licence.licence_number}`,
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

function addCopyInformationPage(pdfDoc, fonts, licence, document) {
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
    "This is a recipient-specific RelayHub document copy. The licence number below identifies the issued licence associated with this generated copy.",
    "This copy is not a public access code or public download link. It is operational evidence used for audit, recovery, support, and misuse investigation.",
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
    ["Licence ID", licence.id],
    ["Recipient", recipientName(licence)],
    ["Recipient email", recipientEmail(licence)],
    ["Issued", dateOnly(licence.issued_at)],
    ["Licence terms version", licence.licence_terms_version || "—"],
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

    const valueLines = splitText(value || "—", 76);
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
    "This copy may contain visible and embedded licence evidence. Removing licence evidence, altering the footer, or redistributing the document outside the licence terms may breach the issued licence.",
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

function addEvidencePage(pdfDoc, fonts, licence, document, sourceSha256, generatedAt) {
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
    ["Recipient", recipientName(licence)],
    ["Recipient email", recipientEmail(licence)],
    ["Issued", licence.issued_at],
    ["Generated", generatedAt],
    ["Source object", normaliseR2Key(licence.source_object || document.source_object)],
    ["Source SHA-256", sourceSha256],
    ["Rendered licence SHA-256", licence.rendered_licence_sha256 || "not recorded"],
    ["Rendered terms body SHA-256", licence.rendered_terms_body_sha256 || "not recorded"],
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
  const body = cleanText(licence.rendered_licence_body);

  if (!body) return false;

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
    "The following pages contain the rendered licence terms captured when this licence was issued.",
    {
      x: 54,
      y: 704,
      size: 10,
      font: regular,
      color: muted,
      maxWidth: 480,
    }
  );

  const lines = splitMultilineText(body, 96);
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

  return true;
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
  sourceSha256,
  generatedAt,
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

  addCopyInformationPage(pdfDoc, fonts, licence, document);
  addEvidencePage(pdfDoc, fonts, licence, document, sourceSha256, generatedAt);
  const appendedLicenceTerms = addIssuedLicenceAppendix(pdfDoc, fonts, licence);
  drawFooterOnPages(pdfDoc, regular, licence);

  const bytes = await pdfDoc.save({
    useObjectStreams: false,
  });

  return {
    bytes,
    appendedLicenceTerms,
  };
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
      relayhub_generation_stage: "licence_bound_no_download_link",
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
     WHERE id = ?
       AND generated_pdf_object_key IS NULL`
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
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
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
      creates_download_link: false,
      activates_download_link: false,
      sends_email: false,
      serves_download: false,
      idempotent_retry: true,
    },
    safety: {
      generated_pdf_created: false,
      download_link_created: false,
      download_link_activated: false,
      email_sent: false,
    },
    message:
      "Generated PDF already exists and licence evidence is complete. No new PDF was generated.",
  });
}

function buildGenerationResponse({
  licence,
  document,
  generatedObjectKey,
  generatedFilename,
  generatedSha256,
  generatedSizeBytes,
  generatedAt,
  source,
  warnings,
  appendedLicenceTerms,
}) {
  return jsonResponse({
    ok: true,
    generated: true,
    already_generated: false,
    action: "generate_personalised_pdf",
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
    warnings,
    controls: {
      reads_source_from_r2: true,
      verifies_source_sha256: true,
      stamps_pdf_pages: true,
      inserts_document_copy_information_page: true,
      appends_licence_evidence_page: true,
      appends_issued_licence_terms: Boolean(appendedLicenceTerms),
      writes_generated_pdf_to_r2: true,
      updates_licence_generated_pdf_fields: true,
      creates_download_link: false,
      activates_download_link: false,
      sends_email: false,
      serves_download: false,
      overwrites_existing_r2_object: false,
    },
    safety: {
      generated_pdf_created: true,
      download_link_created: false,
      download_link_activated: false,
      email_sent: false,
    },
    message:
      "Licence-bound personalised PDF was generated and recorded. No download link was created or activated, and no email was sent.",
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

  if (hasCompleteGeneratedPdfEvidence(licence)) {
    return alreadyGeneratedResponse(licence);
  }

  const eligibility = await evaluateCdasLicenceToPdfEligibility(env, licence.id);

  if (!eligibility.eligible) {
    return jsonResponse(
      {
        ok: false,
        error: "pdf_generation_blocked",
        message:
          "Personalised PDF could not be generated because the licence-to-PDF gate did not pass.",
        licence_id: licence.id,
        licence_number: licence.licence_number,
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        counts: eligibility.counts,
        safety: {
          generated_pdf_created: false,
          download_link_created: false,
          download_link_activated: false,
          email_sent: false,
        },
      },
      409
    );
  }

  const document = await getDocument(env, licence.document_id, licence.document_version);

  if (!document) {
    return jsonResponse(
      {
        ok: false,
        error: "document_not_found",
        message: "Document for this licence and version was not found.",
        safety: {
          generated_pdf_created: false,
          download_link_created: false,
          download_link_activated: false,
          email_sent: false,
        },
      },
      409
    );
  }

  const generatedObjectKey = buildGeneratedObjectKey({
    licence,
    document,
  });
  const generatedFilename = buildGeneratedFilename({
    licence,
    document,
  });

  try {
    const existingObject = await env.RELAYHUB_DOWNLOADS.head(generatedObjectKey);

    if (existingObject) {
      await markGenerationFailed(env, licence.id, "generated_object_key_already_exists");

      return jsonResponse(
        {
          ok: false,
          error: "generated_object_key_already_exists",
          message:
            "The generated PDF object key already exists. Refusing to overwrite existing evidence.",
          generated_pdf: {
            object_key: generatedObjectKey,
          },
          safety: {
            generated_pdf_created: false,
            download_link_created: false,
            download_link_activated: false,
            email_sent: false,
          },
          controls: {
            overwrites_existing_r2_object: false,
            writes_generated_pdf_to_r2: false,
            creates_download_link: false,
            activates_download_link: false,
            sends_email: false,
          },
        },
        409
      );
    }

    const source = await loadSourcePdf(env, licence, document);
    const generatedAt = nowIso();

    const generated = await createGeneratedPdfBytes({
      sourceBytes: source.bytes,
      licence,
      document,
      sourceSha256: source.actualSha256,
      generatedAt,
    });

    const generatedSha256 = await sha256HexFromBytes(generated.bytes);
    const generatedSizeBytes = generated.bytes.byteLength;

    await putGeneratedPdf(
      env,
      generatedObjectKey,
      generated.bytes,
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

    await recordCdasAuditEvent(env, "generated_pdf_created", {
      related_type: "licence",
      related_id: licence.id,
      licence_id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      generated_pdf_object_key: generatedObjectKey,
      generated_pdf_sha256: generatedSha256,
      generated_pdf_size_bytes: generatedSizeBytes,
      actor: cleanText(body.actor || "admin"),
      note: cleanText(body.note || ""),
      stage: "3X-0L-B",
      creates_download_link: false,
      activates_download_link: false,
      sends_email: false,
    });

    return buildGenerationResponse({
      licence,
      document,
      generatedObjectKey,
      generatedFilename,
      generatedSha256,
      generatedSizeBytes,
      generatedAt,
      source,
      warnings: eligibility.warnings || [],
      appendedLicenceTerms: generated.appendedLicenceTerms,
    });
  } catch (error) {
    const message = error?.message || "unknown_pdf_generation_error";

    await markGenerationFailed(env, licence.id, message);

    await recordCdasAuditEvent(env, "generated_pdf_failed", {
      related_type: "licence",
      related_id: licence.id,
      licence_id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      error: message,
      actor: cleanText(body.actor || "admin"),
      note: cleanText(body.note || ""),
      stage: "3X-0L-B",
    });

    return jsonResponse(
      {
        ok: false,
        error: "pdf_generation_failed",
        message,
        safety: {
          generated_pdf_created: false,
          download_link_created: false,
          download_link_activated: false,
          email_sent: false,
        },
        controls: {
          writes_generated_pdf_to_r2: false,
          updates_licence_generated_pdf_fields: true,
          creates_download_link: false,
          activates_download_link: false,
          sends_email: false,
          serves_download: false,
        },
      },
      500
    );
  }
}
