import { EmailMessage } from "cloudflare:email";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const EMAIL_FROM = "hello@relayhub.tech";
const EMAIL_TO = "moneywise69@proton.me";

const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const MIN_FORM_FILL_TIME_MS = 3000;

const DOWNLOAD_ALLOWED_PREFIXES = ["docs/"];
const DOWNLOAD_ALLOWED_EXTENSIONS = [".pdf", ".zip", ".txt", ".sha256", ".sig"];
const DIRECT_DOWNLOAD_BLOCKED_PREFIXES = [
  "docs/originals/",
  "docs/generated/",
  "docs/audit/",
  "docs/catalogue/",
  "docs/licences/",
];
const DOCUMENT_CATALOGUE_KEY = "docs/catalogue/documents.json";
const DOWNLOAD_AUDIT_PREFIX = "docs/audit/downloads/";

export default {
  async fetch(request, env) {
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
  },
};

async function handleDownload(request, env, url) {
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

async function handleFreeDownloadPost(request, env, url) {
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

async function handlePersonalisedDownload(request, env, url) {
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

async function handleDownloadRegistryAdminJson(request, env, url) {
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

async function handleEarlyAccessPost(request, env, url) {
  try {
    const form = await request.formData();

    const website = cleanField(form.get("website"), 500);

    if (website) {
      console.warn("Early access honeypot triggered.");
      return redirect(url, "/early-access?submitted=true");
    }

    if (isSubmittedTooQuickly(form)) {
      console.warn("Early access form submitted too quickly.");
      return redirect(url, "/early-access?submitted=true");
    }

    const ip = getClientIp(request);

    const turnstileValid = await verifyTurnstile(form, env, ip);

    if (!turnstileValid) {
      console.warn("Early access Turnstile validation failed.");
      return redirect(url, "/early-access?submitted=true");
    }

    const rateLimit = await checkRateLimit(env, "early-access", ip);

    if (!rateLimit.allowed) {
      console.warn("Early access rate limit triggered.");
      return redirect(url, "/early-access?error=rate-limited");
    }

    const name = cleanField(form.get("name"), 200);
    const email = cleanField(form.get("email"), 320);
    const community = cleanField(form.get("community"), 300);
    const message = cleanField(form.get("message"), 3000);
    const userAgent = cleanField(request.headers.get("User-Agent"), 500);
    const ipHash = await hashText(ip);
    const submittedAt = new Date().toISOString();
    const sourceUrl = url.toString();

    if (!isValidEmail(email)) {
      return redirect(url, "/early-access?error=invalid-email");
    }

    await storeSignup(env, {
      name,
      email,
      community,
      message,
      ipHash,
      userAgent,
    });

    const rawEmail = buildEarlyAccessEmail({
      name,
      email,
      community,
      message,
      submittedAt,
      sourceUrl,
      userAgent,
    });

    const emailMessage = new EmailMessage(EMAIL_FROM, EMAIL_TO, rawEmail);
    await env.RELAYHUB_EMAIL.send(emailMessage);

    return redirect(url, "/early-access?submitted=true");
  } catch (error) {
    console.error("Early access submission failed:", error);
    return redirect(url, "/early-access?error=submission-failed");
  }
}

async function handleContactPost(request, env, url) {
  try {
    const form = await request.formData();

    const website = cleanField(form.get("website"), 500);

    if (website) {
      console.warn("Contact honeypot triggered.");
      return redirect(url, "/contact?submitted=true");
    }

    if (isSubmittedTooQuickly(form)) {
      console.warn("Contact form submitted too quickly.");
      return redirect(url, "/contact?submitted=true");
    }

    const ip = getClientIp(request);

    const turnstileValid = await verifyTurnstile(form, env, ip);

    if (!turnstileValid) {
      console.warn("Contact Turnstile validation failed.");
      return redirect(url, "/contact?submitted=true");
    }

    const rateLimit = await checkRateLimit(env, "contact", ip);

    if (!rateLimit.allowed) {
      console.warn("Contact rate limit triggered.");
      return redirect(url, "/contact?error=rate-limited");
    }

    const name = cleanField(form.get("name"), 200);
    const email = cleanField(form.get("email"), 320);
    const topic = cleanField(form.get("topic"), 200);
    const message = cleanField(form.get("message"), 5000);
    const userAgent = cleanField(request.headers.get("User-Agent"), 500);
    const ipHash = await hashText(ip);
    const submittedAt = new Date().toISOString();
    const sourceUrl = url.toString();

    if (!isValidEmail(email)) {
      return redirect(url, "/contact?error=invalid-email");
    }

    if (!message) {
      return redirect(url, "/contact?error=submission-failed");
    }

    await storeContactMessage(env, {
      name,
      email,
      topic,
      message,
      ipHash,
      userAgent,
    });

    const rawEmail = buildContactEmail({
      name,
      email,
      topic,
      message,
      submittedAt,
      sourceUrl,
      userAgent,
    });

    const emailMessage = new EmailMessage(EMAIL_FROM, EMAIL_TO, rawEmail);
    await env.RELAYHUB_EMAIL.send(emailMessage);

    return redirect(url, "/contact?submitted=true");
  } catch (error) {
    console.error("Contact submission failed:", error);
    return redirect(url, "/contact?error=submission-failed");
  }
}

async function handleDownloadAnalyticsAdminJson(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const days = Math.min(
    Math.max(Number(url.searchParams.get("days") || "30"), 1),
    90
  );

  try {
    const queries = {
      summary: `
        SELECT
          SUM(_sample_interval * double1) AS requests,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures,
          SUM(_sample_interval * double2) AS bytes,
          AVG(double3) AS avg_duration_ms
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        FORMAT JSON
      `,

      documents: `
        SELECT
          blob1 AS document,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures,
          SUM(_sample_interval * double2) AS bytes,
          AVG(double3) AS avg_duration_ms
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY document
        ORDER BY downloads DESC, failures DESC
        LIMIT 50
        FORMAT JSON
      `,

      daily: `
        SELECT
          toStartOfDay(timestamp) AS day,
          SUM(_sample_interval * double1) AS requests,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY day
        ORDER BY day ASC
        FORMAT JSON
      `,

      countries: `
        SELECT
          blob2 AS country,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY country
        ORDER BY downloads DESC, failures DESC
        LIMIT 20
        FORMAT JSON
      `,

      sources: `
        SELECT
          blob3 AS source,
          blob4 AS campaign,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY source, campaign
        ORDER BY downloads DESC, failures DESC
        LIMIT 30
        FORMAT JSON
      `,

      referrers: `
        SELECT
          blob5 AS referrer,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY referrer
        ORDER BY downloads DESC, failures DESC
        LIMIT 20
        FORMAT JSON
      `,

      errors: `
        SELECT
          blob1 AS document,
          blob7 AS outcome,
          blob8 AS status_code,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
          AND double5 > 0
        GROUP BY document, outcome, status_code
        ORDER BY failures DESC
        LIMIT 50
        FORMAT JSON
      `,

      contentTypes: `
        SELECT
          blob6 AS content_type,
          SUM(_sample_interval * double1) AS requests,
          SUM(_sample_interval * double4) AS downloads,
          SUM(_sample_interval * double5) AS failures
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY content_type
        ORDER BY requests DESC
        LIMIT 20
        FORMAT JSON
      `,

      outcomes: `
        SELECT
          blob7 AS outcome,
          blob8 AS status_code,
          SUM(_sample_interval * double1) AS requests
        FROM relayhub_downloads
        WHERE timestamp > NOW() - INTERVAL '${days}' DAY
        GROUP BY outcome, status_code
        ORDER BY requests DESC
        FORMAT JSON
      `,
    };

    const [
      summary,
      documents,
      daily,
      countries,
      sources,
      referrers,
      errors,
      contentTypes,
      outcomes,
    ] = await Promise.all([
      queryAnalyticsEngine(env, queries.summary),
      queryAnalyticsEngine(env, queries.documents),
      queryAnalyticsEngine(env, queries.daily),
      queryAnalyticsEngine(env, queries.countries),
      queryAnalyticsEngine(env, queries.sources),
      queryAnalyticsEngine(env, queries.referrers),
      queryAnalyticsEngine(env, queries.errors),
      queryAnalyticsEngine(env, queries.contentTypes),
      queryAnalyticsEngine(env, queries.outcomes),
    ]);

    return jsonResponse({
      days,
      summary: summary[0] || {
        requests: 0,
        downloads: 0,
        failures: 0,
        bytes: 0,
        avg_duration_ms: 0,
      },
      documents,
      daily,
      countries,
      sources,
      referrers,
      errors,
      contentTypes,
      outcomes,
    });
  } catch (error) {
    console.error("Download analytics admin query failed:", error);

    return jsonResponse(
      {
        error: "Download analytics query failed",
        detail: "Check CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN.",
      },
      500
    );
  }
}

async function queryAnalyticsEngine(env, query) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ANALYTICS_TOKEN) {
    throw new Error("Analytics Engine API credentials are not configured.");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
        "content-type": "text/plain; charset=UTF-8",
      },
      body: query,
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error("Analytics Engine SQL API error:", text);
    throw new Error("Analytics Engine SQL API request failed.");
  }

  return parseAnalyticsEngineResponse(text);
}

function parseAnalyticsEngineResponse(text) {
  if (!text.trim()) {
    return [];
  }

  const parsed = JSON.parse(text);

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.data)) {
    return parsed.data;
  }

  if (Array.isArray(parsed.results)) {
    return parsed.results;
  }

  return [];
}

async function verifyTurnstile(form, env, ip) {
  const token = cleanField(form.get("cf-turnstile-response"), 4096);

  if (!env.TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY is not configured.");
    return false;
  }

  if (!token) {
    return false;
  }

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  body.append("remoteip", ip);

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body,
    }
  );

  if (!response.ok) {
    return false;
  }

  const result = await response.json();

  return result.success === true;
}

function isSubmittedTooQuickly(form) {
  const startedAt = Number(cleanField(form.get("startedAt"), 32));
  const submittedAt = Date.now();

  if (!startedAt) {
    return true;
  }

  return submittedAt - startedAt < MIN_FORM_FILL_TIME_MS;
}

async function handleNewsletterAdminJson(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildNewsletterQuery(q, 50);

  const total = await countNewsletterSignups(env, q);
  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  return jsonResponse({
    total,
    signups: result.results || [],
  });
}

async function handleNewsletterAdminCsv(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return textResponse("Unauthorized", 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildNewsletterQuery(q, 1000);

  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  const rows = result.results || [];
  const csv = buildNewsletterCsv(rows);

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=UTF-8",
      "content-disposition": 'attachment; filename="relayhub-newsletter-signups.csv"',
      "cache-control": "no-store",
    },
  });
}

async function handleContactAdminJson(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildContactQuery(q, 50);

  const total = await countContactMessages(env, q);
  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  return jsonResponse({
    total,
    messages: result.results || [],
  });
}

async function handleContactAdminCsv(request, env, url) {
  if (!isAdminAuthorized(request, env, url)) {
    return textResponse("Unauthorized", 401);
  }

  const q = cleanField(url.searchParams.get("q"), 200);
  const query = buildContactQuery(q, 1000);

  const result = await env.RELAYHUB_DB.prepare(query.sql)
    .bind(...query.bindings)
    .all();

  const rows = result.results || [];
  const csv = buildContactCsv(rows);

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=UTF-8",
      "content-disposition": 'attachment; filename="relayhub-contact-messages.csv"',
      "cache-control": "no-store",
    },
  });
}

function isAdminAuthorized(request, env, url) {
  const expectedToken = env.RELAYHUB_ADMIN_TOKEN;

  if (!expectedToken) {
    console.error("RELAYHUB_ADMIN_TOKEN is not configured.");
    return false;
  }

  const authHeader = request.headers.get("Authorization") || "";
  const bearerPrefix = "Bearer ";

  if (authHeader.startsWith(bearerPrefix)) {
    const suppliedToken = authHeader.slice(bearerPrefix.length).trim();
    return suppliedToken === expectedToken;
  }

  const queryToken = url.searchParams.get("token");

  if (queryToken) {
    return queryToken === expectedToken;
  }

  return false;
}

function buildNewsletterQuery(q, limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 1000);

  if (!q) {
    return {
      sql: `SELECT id, created_at, name, email, community, message
            FROM early_access_signups
            ORDER BY id DESC
            LIMIT ?`,
      bindings: [safeLimit],
    };
  }

  const pattern = `%${q}%`;

  return {
    sql: `SELECT id, created_at, name, email, community, message
          FROM early_access_signups
          WHERE name LIKE ?
             OR email LIKE ?
             OR community LIKE ?
             OR message LIKE ?
          ORDER BY id DESC
          LIMIT ?`,
    bindings: [pattern, pattern, pattern, pattern, safeLimit],
  };
}

function buildContactQuery(q, limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 1000);

  if (!q) {
    return {
      sql: `SELECT id, created_at, name, email, topic, message
            FROM contact_messages
            ORDER BY id DESC
            LIMIT ?`,
      bindings: [safeLimit],
    };
  }

  const pattern = `%${q}%`;

  return {
    sql: `SELECT id, created_at, name, email, topic, message
          FROM contact_messages
          WHERE name LIKE ?
             OR email LIKE ?
             OR topic LIKE ?
             OR message LIKE ?
          ORDER BY id DESC
          LIMIT ?`,
    bindings: [pattern, pattern, pattern, pattern, safeLimit],
  };
}

async function countNewsletterSignups(env, q) {
  if (!q) {
    const result = await env.RELAYHUB_DB.prepare(
      `SELECT COUNT(*) AS total FROM early_access_signups`
    ).first();

    return result?.total || 0;
  }

  const pattern = `%${q}%`;

  const result = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS total
     FROM early_access_signups
     WHERE name LIKE ?
        OR email LIKE ?
        OR community LIKE ?
        OR message LIKE ?`
  )
    .bind(pattern, pattern, pattern, pattern)
    .first();

  return result?.total || 0;
}

function buildNewsletterCsv(rows) {
  const headers = ["id", "created_at", "name", "email", "community", "message"];

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header] ?? "")).join(",")
    ),
  ];

  return `${lines.join("\r\n")}\r\n`;
}

function buildContactCsv(rows) {
  const headers = ["id", "created_at", "name", "email", "topic", "message"];

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header] ?? "")).join(",")
    ),
  ];

  return `${lines.join("\r\n")}\r\n`;
}

function csvEscape(value) {
  const text = String(value);
  const escaped = text.replace(/"/g, '""');

  return `"${escaped}"`;
}

async function storeSignup(env, signup) {
  await env.RELAYHUB_DB.prepare(
    `INSERT INTO early_access_signups
      (name, email, community, message, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      signup.name,
      signup.email,
      signup.community,
      signup.message,
      signup.ipHash,
      signup.userAgent
    )
    .run();
}

async function storeContactMessage(env, contact) {
  await env.RELAYHUB_DB.prepare(
    `INSERT INTO contact_messages
      (name, email, topic, message, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      contact.name,
      contact.email,
      contact.topic,
      contact.message,
      contact.ipHash,
      contact.userAgent
    )
    .run();
}

async function checkRateLimit(env, scope, ip) {
  const ipHash = await hashText(ip);
  const key = `${scope}:${ipHash}`;

  const current = Number((await env.RELAYHUB_RATE_LIMIT.get(key)) || "0");

  if (current >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false };
  }

  await env.RELAYHUB_RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
  });

  return { allowed: true };
}

function buildEarlyAccessEmail({
  name,
  email,
  community,
  message,
  submittedAt,
  sourceUrl,
  userAgent,
}) {
  const safeReplyTo = sanitizeHeader(email);

  return [
    `From: ${EMAIL_FROM}`,
    `To: ${EMAIL_TO}`,
    `Reply-To: ${safeReplyTo}`,
    "Subject: New RelayHub early access request",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "New RelayHub early access request",
    "",
    `Submitted at: ${submittedAt}`,
    `Source URL: ${sourceUrl}`,
    "",
    `Name: ${name || "Not provided"}`,
    `Email: ${email}`,
    `Community / organisation: ${community || "Not provided"}`,
    "",
    "Message:",
    message || "Not provided",
    "",
    "Technical context:",
    "Stored in D1: yes",
    `User agent: ${userAgent || "Not provided"}`,
    "",
  ].join("\r\n");
}

function buildContactEmail({
  name,
  email,
  topic,
  message,
  submittedAt,
  sourceUrl,
  userAgent,
}) {
  const safeReplyTo = sanitizeHeader(email);
  const safeTopic = sanitizeHeader(topic || "General enquiry");

  return [
    `From: ${EMAIL_FROM}`,
    `To: ${EMAIL_TO}`,
    `Reply-To: ${safeReplyTo}`,
    `Subject: RelayHub contact form: ${safeTopic}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "New RelayHub contact message",
    "",
    `Submitted at: ${submittedAt}`,
    `Source URL: ${sourceUrl}`,
    "",
    `Name: ${name || "Not provided"}`,
    `Email: ${email}`,
    `Topic: ${topic || "General enquiry"}`,
    "",
    "Message:",
    message || "Not provided",
    "",
    "Technical context:",
    "Stored in D1: yes",
    `User agent: ${userAgent || "Not provided"}`,
    "",
  ].join("\r\n");
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

function textResponse(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

function methodNotAllowed(allow) {
  return new Response("Method not allowed", {
    status: 405,
    headers: {
      allow,
    },
  });
}

function cleanField(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .slice(0, maxLength);
}

function sanitizeHeader(value) {
  return String(value || "")
    .replace(/[\r\n]/g, "")
    .trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function hashText(value) {
  const encoder = new TextEncoder();
  const data = encoder.encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function redirect(url, path) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: path,
    },
  });
}