import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  DOWNLOAD_ALLOWED_PREFIXES,
  DOWNLOAD_ALLOWED_EXTENSIONS,
  DIRECT_DOWNLOAD_BLOCKED_PREFIXES,
  DOCUMENT_CATALOGUE_KEY,
  DOWNLOAD_AUDIT_PREFIX,
} from "./config.js";

import {
  textResponse,
  jsonResponse,
  redirect,
} from "./shared.js";

import {
  cleanField,
  isValidEmail,
} from "./shared.js";

import {
  isAdminAuthorized,
} from "./admin.js";

export async function handleDownload(request, env, url) {
  const started = Date.now();
  const key = getDownloadKey(url.pathname);

  if (!isSafeDownloadKey(key)) {
    recordDownloadAnalytics(request, env, url, {
      key: key || "invalid",
      statusCode: 400,
      outcome: "invalid",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("Invalid or disallowed download path", 400);
  }

  const object = await env.RELAYHUB_DOWNLOADS.get(key);

  if (!object) {
    recordDownloadAnalytics(request, env, url, {
      key,
      statusCode: 404,
      outcome: "not_found",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("Download not found", 404);
  }

  recordDownloadAnalytics(request, env, url, {
    key,
    statusCode: 200,
    outcome: "success",
    contentType: object.httpMetadata?.contentType ?? "unknown",
    size: object.size,
    started,
  });

  const headers = new Headers();

  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", `attachment; filename="${safeDownloadFilename(key)}"`);

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

function recordDownloadAnalytics(request, env, url, event) {
  env.DOWNLOAD_ANALYTICS?.writeDataPoint({
    blobs: [
      event.key,
      request.headers.get("cf-ipcountry") ?? "unknown",
      url.searchParams.get("utm_source") ?? "direct",
      url.searchParams.get("utm_campaign") ?? "none",
      request.headers.get("referer") ?? "none",
      event.contentType,
      event.outcome,
      String(event.statusCode),
    ],
    doubles: [
      1,
      event.size,
      Date.now() - event.started,
      event.outcome === "success" ? 1 : 0,
      event.outcome === "success" ? 0 : 1,
    ],
    indexes: [event.key],
  });
}

function getDownloadKey(pathname) {
  const raw = pathname.replace(/^\/download\/+/, "");

  try {
    return decodeURIComponent(raw).replace(/^\/+/, "");
  } catch {
    return "";
  }
}

function isSafeDownloadKey(key) {
  if (!key) return false;
  if (key.includes("..")) return false;
  if (key.includes("\\")) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("//")) return false;

  const hasBlockedPrefix = DIRECT_DOWNLOAD_BLOCKED_PREFIXES.some((prefix) =>
    key.startsWith(prefix)
  );

  if (hasBlockedPrefix) return false;

  const hasAllowedPrefix = DOWNLOAD_ALLOWED_PREFIXES.some((prefix) =>
    key.startsWith(prefix)
  );

  const hasAllowedExtension = DOWNLOAD_ALLOWED_EXTENSIONS.some((extension) =>
    key.toLowerCase().endsWith(extension)
  );

  return hasAllowedPrefix && hasAllowedExtension;
}

function safeDownloadFilename(key) {
  const raw = key.split("/").pop() || "download";
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function handleFreeDownloadPost(request, env, url) {
  try {
    const form = await request.formData();

    const documentId = cleanField(form.get("documentId"), 200);
    const firstName = cleanField(form.get("firstName"), 120);
    const lastName = cleanField(form.get("lastName"), 120);
    const email = cleanField(form.get("email"), 320);
    const consent = cleanField(form.get("consent"), 20);

    if (!documentId || !firstName || !lastName || !isValidEmail(email) || consent !== "yes") {
      return textResponse("Missing or invalid download details.", 400);
    }

    const catalogue = await loadDocumentCatalogue(env);
    const document = catalogue[documentId];

    if (!document || !document.active || document.access !== "free") {
      return textResponse("Document not available.", 404);
    }

    if (document.requiresPayment) {
      return textResponse("This document requires payment.", 403);
    }

    const record = createFreeDownloadRecord({
      documentId: document.documentId,
      documentVersion: document.version,
      firstName,
      lastName,
      email,
    });

    const recordKey = `${DOWNLOAD_AUDIT_PREFIX}${record.downloadId}.json`;

    await env.RELAYHUB_DOWNLOADS.put(recordKey, JSON.stringify(record, null, 2), {
      httpMetadata: {
        contentType: "application/json; charset=UTF-8",
      },
    });

    return redirect(
      url,
      `/download-requested/?token=${encodeURIComponent(record.token)}&downloadId=${encodeURIComponent(record.downloadId)}`
    );
  } catch (error) {
    console.error("Free download request failed:", error);
    return textResponse("Download request failed.", 500);
  }
}

export async function handlePersonalisedDownload(request, env, url) {
  const started = Date.now();
  const token = getApiDownloadToken(url.pathname);

  if (!token) {
    return textResponse("Missing download token.", 400);
  }

  const found = await findDownloadRecordByToken(env.RELAYHUB_DOWNLOADS, token);

  if (!found) {
    recordDownloadAnalytics(request, env, url, {
      key: "personalised:not_found",
      statusCode: 404,
      outcome: "not_found",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("Download link not found.", 404);
  }

  const { key: recordKey, record } = found;

  if (isExpired(record.expiresAt)) {
    return textResponse("This download link has expired.", 410);
  }

  if (Number(record.downloadCount || 0) >= Number(record.maxDownloads || 0)) {
    return textResponse("This download link has already been used too many times.", 403);
  }

  const catalogue = await loadDocumentCatalogue(env);
  const document = catalogue[record.documentId];

  if (!document || !document.active) {
    return textResponse("Document is no longer available.", 404);
  }

  const generatedObjectKey = record.generatedObjectKey || generatedObjectKeyFor(record);
  const existingGenerated = await env.RELAYHUB_DOWNLOADS.get(generatedObjectKey);

  let pdfBody;
  let pdfSize = existingGenerated?.size || 0;

  if (existingGenerated?.body) {
    pdfBody = request.method === "HEAD" ? null : existingGenerated.body;
  } else {
    const sourcePdf = await env.RELAYHUB_DOWNLOADS.get(document.sourceObject);

    if (!sourcePdf) {
      return textResponse("Source document could not be found.", 404);
    }

    const sourcePdfBytes = await sourcePdf.arrayBuffer();
    const personalisedPdf = await personalisePdf({
      sourcePdfBytes,
      document,
      record,
    });

    await env.RELAYHUB_DOWNLOADS.put(generatedObjectKey, personalisedPdf, {
      httpMetadata: {
        contentType: "application/pdf",
      },
    });

    pdfSize = personalisedPdf.byteLength;
    pdfBody = request.method === "HEAD" ? null : uint8ArrayToArrayBuffer(personalisedPdf);
  }

  const updatedRecord = {
    ...record,
    generatedObjectKey,
    downloadCount: Number(record.downloadCount || 0) + 1,
    lastDownloadedAt: new Date().toISOString(),
  };

  await env.RELAYHUB_DOWNLOADS.put(recordKey, JSON.stringify(updatedRecord, null, 2), {
    httpMetadata: {
      contentType: "application/json; charset=UTF-8",
    },
  });

  recordDownloadAnalytics(request, env, url, {
    key: generatedObjectKey,
    statusCode: 200,
    outcome: "success",
    contentType: "application/pdf",
    size: pdfSize,
    started,
  });

  return new Response(pdfBody, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${safeDocumentFilename(document)}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function loadDocumentCatalogue(env) {
  const object = await env.RELAYHUB_DOWNLOADS.get(DOCUMENT_CATALOGUE_KEY);

  if (!object) {
    throw new Error(`Document catalogue not found at ${DOCUMENT_CATALOGUE_KEY}`);
  }

  return object.json();
}

function createFreeDownloadRecord(input) {
  const now = new Date();

  return {
    downloadId: createDownloadId(),
    token: createDownloadToken(),
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    type: "free",
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    createdAt: now.toISOString(),
    expiresAt: createExpiry(48),
    maxDownloads: 3,
    downloadCount: 0,
  };
}

function createDownloadId() {
  return `RH-DL-${new Date().getUTCFullYear()}-${randomHex(4)}`;
}

function createDownloadToken() {
  return randomToken(32);
}

function createExpiry(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function randomToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function getApiDownloadToken(pathname) {
  const raw = pathname.replace(/^\/api\/download\/+/i, "");

  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return "";
  }
}

async function findDownloadRecordByToken(bucket, token) {
  let cursor;

  do {
    const listed = await bucket.list({
      prefix: DOWNLOAD_AUDIT_PREFIX,
      cursor,
    });

    for (const object of listed.objects) {
      if (!object.key.endsWith(".json")) {
        continue;
      }

      const stored = await bucket.get(object.key);
      if (!stored) continue;

      let record;

      try {
        const text = await stored.text();

        if (!text.trim()) {
          console.warn(`Skipping empty download record: ${object.key}`);
          continue;
        }

        record = JSON.parse(text);
      } catch (error) {
        console.warn(`Skipping invalid download record: ${object.key}`, error);
        continue;
      }

      if (record.token === token) {
        return {
          key: object.key,
          record,
        };
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return null;
}

function isExpired(expiresAt) {
  return new Date(expiresAt).getTime() < Date.now();
}

function generatedObjectKeyFor(record) {
  const bucketClass = record.type === "paid" ? "paid" : "free";
  return `docs/generated/${bucketClass}/${record.downloadId}.pdf`;
}

function uint8ArrayToArrayBuffer(value) {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength
  );
}

async function personalisePdf({ sourcePdfBytes, document, record }) {
  const pdf = await PDFDocument.load(sourcePdfBytes);

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const licensedName = `${record.firstName} ${record.lastName}`.trim();

  for (const page of pages) {
    const { width } = page.getSize();

    page.drawText(`${licensedName} • ${record.downloadId}`, {
      x: 36,
      y: 18,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });

    page.drawText(document.access === "paid" ? "Redistribution prohibited" : "Free public distribution", {
      x: Math.max(36, width - 190),
      y: 18,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  }

  const secondPage = pages[1] || pages[0];

  if (secondPage) {
    const { width, height } = secondPage.getSize();
    const boxWidth = Math.min(520, width - 72);
    const boxX = 36;
    const boxY = Math.max(80, height - 330);

    secondPage.drawRectangle({
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: 250,
      borderColor: rgb(0.75, 0.75, 0.75),
      borderWidth: 1,
      color: rgb(1, 1, 1),
      opacity: 0.94,
    });

    secondPage.drawText("Document Copy Information", {
      x: boxX + 20,
      y: boxY + 220,
      size: 16,
      font: boldFont,
      color: rgb(0.05, 0.05, 0.05),
    });

    const lines = [
      `Document: ${document.title} v${document.version}`,
      `Generated for: ${licensedName}`,
      `Email: ${record.email}`,
      `Download ID: ${record.downloadId}`,
      record.orderNumber ? `Order Number: ${record.orderNumber}` : null,
      `Licence Type: ${document.licenceType}`,
      `Generated At: ${record.createdAt}`,
      "",
      document.access === "paid"
        ? "This document is licensed to the named licence holder. Redistribution is prohibited."
        : "This document may be shared complete and unmodified. Attribution must be preserved.",
    ].filter(Boolean);

    let y = boxY + 190;

    for (const line of lines) {
      secondPage.drawText(line, {
        x: boxX + 20,
        y,
        size: 10,
        font,
        color: rgb(0.08, 0.08, 0.08),
        maxWidth: boxWidth - 40,
      });

      y -= 18;
    }
  }

  pdf.setTitle(`${document.title} v${document.version}`);
  pdf.setAuthor("RelayHub");
  pdf.setSubject(`Personalised copy for ${licensedName}`);
  pdf.setKeywords([
    document.documentId,
    record.downloadId,
    record.email,
    document.licenceType,
  ]);
  pdf.setProducer("RelayHub Document Delivery System");
  pdf.setCreator("RelayHub");

  return pdf.save();
}

function safeDocumentFilename(document) {
  const base = `${document.title}-v${document.version}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");

  return `${base || "document"}.pdf`;
}

export async function handleDownloadRegistryAdminJson(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") || "100"), 1),
    500
  );

  const records = [];
  let cursor;

  do {
    const listed = await env.RELAYHUB_DOWNLOADS.list({
      prefix: DOWNLOAD_AUDIT_PREFIX,
      cursor,
    });

    for (const object of listed.objects) {
      if (!object.key.endsWith(".json")) continue;

      const stored = await env.RELAYHUB_DOWNLOADS.get(object.key);
      if (!stored) continue;

      try {
        const text = await stored.text();
        if (!text.trim()) continue;

        const record = JSON.parse(text);

        records.push({
          key: object.key,
          downloadId: record.downloadId || "",
          documentId: record.documentId || "",
          documentVersion: record.documentVersion || "",
          type: record.type || "",
          firstName: record.firstName || "",
          lastName: record.lastName || "",
          email: record.email || "",
          orderNumber: record.orderNumber || "",
          createdAt: record.createdAt || "",
          expiresAt: record.expiresAt || "",
          lastDownloadedAt: record.lastDownloadedAt || "",
          maxDownloads: Number(record.maxDownloads || 0),
          downloadCount: Number(record.downloadCount || 0),
          generatedObjectKey: record.generatedObjectKey || "",
        });
      } catch (error) {
        console.warn(`Skipping invalid download registry record: ${object.key}`, error);
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && records.length < limit);

  records.sort((a, b) => {
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });

  return jsonResponse({
    total: records.length,
    records: records.slice(0, limit),
  });
}