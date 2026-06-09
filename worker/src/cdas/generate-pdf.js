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

function buildGeneratedObjectKey({ licence, document }) {
  const documentSlug = slugify(
    document.slug || document.id || licence.document_id || "document"
  );
  const versionSlug = slugify(
    licence.document_version || document.version || "version"
  );
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
  const title = safeFilename(
    document.title || licence.document_id || "RelayHub-Document"
  );
  const version = safeFilename(
    licence.document_version || document.version || "version"
  );
  const licenceNumber = safeFilename(licence.licence_number || licence.id);

  return `${title}-v${version}-${licenceNumber}.pdf`;
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
      appends_licence_evidence_page: false,
      writes_generated_pdf_to_r2: false,
      updates_licence_generated_pdf_fields: false,
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

  if (!licence.licence_number) {
    blockers.push("missing_licence_number");
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

function drawFooterOnPages(pdfDoc, font, licence) {
  const pages = pdfDoc.getPages();

  const footerText = [
    "RelayHub licensed copy",
    `Licence: ${licence.licence_number}`,
    `Recipient: ${licence.licence_holder_email_normalised}`,
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

function drawTextBlock(page, lines, options) {
  const {
    x,
    yStart,
    size,
    lineHeight,
    font,
    color,
    maxLines,
  } = options;

  let y = yStart;
  let count = 0;

  for (const line of lines) {
    if (maxLines && count >= maxLines) break;

    page.drawText(line, {
      x,
      y,
      size,
      font,
      color,
    });

    y -= lineHeight;
    count += 1;
  }

  return y;
}

function addEvidencePage(pdfDoc, fonts, licence, document, generatedObjectKey, generatedFilename) {
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
    "It is not proof of identity, payment, or endorsement. It records the licence evidence bound to this generated file.",
  ];

  drawTextBlock(page, summaryLines, {
    x: 54,
    yStart: 716,
    size: 10,
    lineHeight: 15,
    font: regular,
    color: muted,
  });

  const rows = [
    ["Licence number", licence.licence_number],
    ["Licence ID", licence.id],
    ["Licence status", licence.status],
    ["Issued at", licence.issued_at],
    ["Licence holder", licence.licence_holder_name],
    ["Recipient email", licence.licence_holder_email_normalised],
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
    "Generated PDF was written to private R2 storage. No public download link was created by this operation.",
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

  const readiness = evaluateGenerationBlockers({
    licence,
    document,
  });

  if (readiness.blockers.length) {
    await markGenerationFailed(
      env,
      licence.id,
      `Generation blocked: ${readiness.blockers.join(", ")}`
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
    await markGenerationFailed(env, licence.id, "Source object was not found in R2.");

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
      "Source PDF SHA-256 did not match the licence source evidence."
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

  const generatedObjectKey = buildGeneratedObjectKey({ licence, document });
  const generatedFilename = buildGeneratedFilename({ licence, document });

  const existingGeneratedObject = await env.RELAYHUB_DOWNLOADS.get(generatedObjectKey);

  if (existingGeneratedObject) {
    return jsonResponse(
      {
        ok: false,
        error: "generated_pdf_object_already_exists_repair_required",
        message:
          "Generated PDF object already exists in R2, but the licence evidence record is not complete. Refusing to overwrite. Inspect and repair the database evidence record before continuing.",
        generated_object_key: generatedObjectKey,
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
          creates_download_link: false,
          serves_download: false,
          repair_required: true,
        },
      },
      409
    );
  }

  let generatedBytes;

  try {
    const pdfDoc = await PDFDocument.load(sourceBytes);
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    drawFooterOnPages(pdfDoc, regular, licence);

    addEvidencePage(
      pdfDoc,
      { regular, bold },
      licence,
      document,
      generatedObjectKey,
      generatedFilename
    );

    generatedBytes = await pdfDoc.save({
      useObjectStreams: false,
    });
  } catch (error) {
    await markGenerationFailed(env, licence.id, error.message);

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
  const generatedAt = nowIso();

  await env.RELAYHUB_DOWNLOADS.put(generatedObjectKey, generatedBytes, {
    httpMetadata: {
      contentType: "application/pdf",
      contentDisposition: `attachment; filename="${generatedFilename}"`,
    },
    customMetadata: {
      cdas: "true",
      licence_id: licence.id,
      licence_number: licence.licence_number,
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

  return jsonResponse({
    ok: true,
    generated: true,
    generated_at: generatedAt,
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_email_normalised: licence.licence_holder_email_normalised,
      source_object: licence.source_object,
      source_sha256: licence.source_sha256,
      rendered_licence_sha256: licence.rendered_licence_sha256,
      rendered_terms_body_sha256: licence.rendered_terms_body_sha256,
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
      stamps_pdf_pages: true,
      appends_licence_evidence_page: true,
      writes_generated_pdf_to_r2: true,
      updates_licence_generated_pdf_fields: true,
      creates_download_link: false,
      serves_download: false,
    },
    message:
      "Generated PDF was created and stored in private R2. No public download link was created.",
  });
}