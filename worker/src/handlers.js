import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  EMAIL_FROM,
  EMAIL_TO,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_SECONDS,
  MIN_FORM_FILL_TIME_MS,
  DOWNLOAD_ALLOWED_PREFIXES,
  DOWNLOAD_ALLOWED_EXTENSIONS,
  DIRECT_DOWNLOAD_BLOCKED_PREFIXES,
  DOCUMENT_CATALOGUE_KEY,
  DOWNLOAD_AUDIT_PREFIX,
  CDAS_VERIFICATION_TTL_SECONDS,
  CDAS_DOWNLOAD_TTL_SECONDS,
  CDAS_GENERATED_PREFIX,
  CDAS_DEFAULT_RECIPIENT_CATEGORY,
} from "./config.js";

import {
  jsonResponse,
  textResponse,
  methodNotAllowed,
} from "./shared/responses.js";

import {
  normaliseEmail,
  isValidEmail,
  getEmailDomain,
  cleanField,
  clampNumber,
  filenameFromKey,
  safeDownloadFilename,
  guessContentType,
  safeJsonParse,
  normaliseAnalyticsDay,
} from "./shared/validation.js";

import {
  randomToken,
  cryptoRandomHex,
  randomId,
  secureHash,
  sha256ArrayBuffer,
  getRequestIpHash,
} from "./shared/crypto.js";

import {
  csvResponse,
} from "./shared/csv.js";

import {
  requireAdmin,
  getAdminIdentity,
  extractAdminPathId,
} from "./services/admin-auth.js";

import {
  recordDownloadAnalytics,
} from "./services/analytics.js";

import {
  sendInternalEmail,
  sendCdasEmail,
} from "./services/email.js";

import { handleUploadAdminRequest } from "./upload/admin-routes.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/document-access/request") {
      if (request.method !== "POST") {
        return methodNotAllowed("POST");
      }

      return handleCdasRequestAccess(request, env, url);
    }

    if (url.pathname === "/api/document-access/verify") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      return handleCdasVerify(request, env, url);
    }

    if (url.pathname === "/api/document-access/download") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }

      return handleCdasDownload(request, env, url);
    }

    if (url.pathname === "/api/licence/verify") {
      if (request.method !== "GET") {
        return methodNotAllowed("GET");
      }

      return handleCdasLicenceVerify(request, env, url);
    }

    if (url.pathname === "/api/admin/documents") {
      if (request.method === "GET") {
        return handleCdasAdminDocuments(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname.startsWith("/api/admin/uploads")) {
      return handleUploadAdminRequest(request, env);
    }

    if (url.pathname === "/api/admin/document-requests") {
      if (request.method === "GET") {
        return handleCdasAdminRequests(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname === "/api/admin/document-licences") {
      if (request.method === "GET") {
        return handleCdasAdminLicences(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname.startsWith("/api/admin/document-licences/") && url.pathname.endsWith("/revoke")) {
      if (request.method === "POST") {
        return handleCdasAdminRevokeLicence(request, env, url);
      }

      return methodNotAllowed("POST");
    }

    if (url.pathname.startsWith("/api/admin/document-licences/") && url.pathname.endsWith("/reissue-link")) {
      if (request.method === "POST") {
        return handleCdasAdminReissueLink(request, env, url);
      }

      return methodNotAllowed("POST");
    }

    if (url.pathname === "/api/admin/document-downloads") {
      if (request.method === "GET") {
        return handleCdasAdminDownloads(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname === "/api/admin/licence-terms") {
      if (request.method === "GET") {
        return handleCdasAdminLicenceTerms(request, env, url);
      }

      return methodNotAllowed("GET");
    }

    if (url.pathname === "/api/admin/admin-audit") {
      if (request.method === "GET") {
        return handleCdasAdminAudit(request, env, url);
      }

      return methodNotAllowed("GET");
    }

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

// ============================================================
// CDAS v0.2 — Controlled Document Access System
// ============================================================

async function handleCdasRequestAccess(request, env, url) {
  try {
    const body = await readJson(request);

    if (!body) {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }

    const documentRef = cleanField(body.documentId || body.documentSlug || "", 200);
    const name = cleanField(body.name || "", 200);
    const email = normaliseEmail(body.email);
    const licenceHolderType = cleanField(body.licenceHolderType || "individual", 40);
    const organisationName = cleanField(body.organisationName || "", 240);
    const contactName = cleanField(body.contactName || "", 200);
    const contactEmail = normaliseEmail(body.contactEmail || email);
    const roleTitle = cleanField(body.roleTitle || "", 160);
    const recipientCategory = cleanField(body.recipientCategory || CDAS_DEFAULT_RECIPIENT_CATEGORY, 80);
    const acceptedTerms = Boolean(body.acceptedTerms);

    if (!documentRef) {
      return jsonResponse({ ok: false, error: "missing_document" }, 400);
    }

    if (!isValidEmail(email)) {
      return jsonResponse({ ok: false, error: "invalid_email" }, 400);
    }

    if (!acceptedTerms) {
      return jsonResponse({ ok: false, error: "terms_required" }, 400);
    }

    if (licenceHolderType === "individual" && !name) {
      return jsonResponse({ ok: false, error: "name_required" }, 400);
    }

    if (licenceHolderType === "organisation" && !organisationName) {
      return jsonResponse({ ok: false, error: "organisation_name_required" }, 400);
    }

    const document = await getCdasDocumentByRef(env, documentRef);

    if (!document || ["withdrawn", "disabled", "archived"].includes(document.status)) {
      return jsonResponse({ ok: false, error: "document_unavailable" }, 404);
    }

    if (!isProtectedCdasAccessClass(document.access_class)) {
      return jsonResponse({ ok: false, error: "document_not_controlled" }, 400);
    }

    const terms = await getCdasActiveTerms(env, document.licence_terms_version);

    if (!terms) {
      return jsonResponse({ ok: false, error: "terms_unavailable" }, 500);
    }

    const domain = getEmailDomain(email);
    const domainPolicy = await getCdasEmailDomainPolicy(env, domain);
    const riskFlags = [];
    let riskScore = 0;

    if (domainPolicy?.status === "blocked") {
      riskFlags.push("disposable_email");
      riskScore += 100;
      return jsonResponse({
        ok: false,
        error: "email_domain_blocked",
        message: "Temporary or disposable email addresses cannot be used for this document.",
      }, 403);
    }

    if (domainPolicy?.status === "review") {
      riskFlags.push("review_email_domain");
      riskScore += 20;
    }

    const accessRequestId = randomId("dar");
    const verificationToken = randomToken(32);
    const verificationTokenHash = await secureHash(`${env.CDAS_TOKEN_SECRET || "dev-only"}:${verificationToken}`);
    const ipHashValue = await getRequestIpHash(request, env);
    const userAgent = cleanField(request.headers.get("User-Agent"), 500);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + CDAS_VERIFICATION_TTL_SECONDS * 1000).toISOString();

    await env.RELAYHUB_DB.prepare(
      `INSERT INTO document_access_requests (
        id, document_id, document_version, name, email, email_normalised,
        licence_holder_type, organisation_name, contact_name, contact_email, role_title,
        recipient_category, status, access_class, verification_token_hash,
        email_delivery_status, requested_at, expires_at, terms_version,
        terms_accepted_at, terms_acceptance_ip_hash, terms_acceptance_user_agent,
        ip_hash, user_agent, risk_score, risk_flags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        accessRequestId,
        document.id,
        document.version,
        name || null,
        email,
        email,
        licenceHolderType,
        organisationName || null,
        contactName || null,
        contactEmail || null,
        roleTitle || null,
        recipientCategory,
        "email_pending",
        document.access_class,
        verificationTokenHash,
        "unknown",
        createdAt,
        expiresAt,
        terms.version,
        createdAt,
        ipHashValue,
        userAgent,
        ipHashValue,
        userAgent,
        riskScore,
        JSON.stringify(riskFlags)
      )
      .run();

    const verificationUrl = `${url.origin}/api/document-access/verify?requestId=${encodeURIComponent(accessRequestId)}&token=${encodeURIComponent(verificationToken)}`;
    const emailResult = await sendCdasEmail(env, {
      to: email,
      subject: "Verify your email to access your RelayHub document",
      body: buildCdasVerificationEmail({ document, verificationUrl }),
    });

    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET status = ?, verification_sent_at = ?, email_delivery_status = ?
       WHERE id = ?`
    )
      .bind(
        emailResult.ok ? "email_sent" : "email_failed",
        emailResult.ok ? new Date().toISOString() : null,
        emailResult.ok ? "sent" : emailResult.reason,
        accessRequestId
      )
      .run();

    if (!emailResult.ok) {
      return jsonResponse({
        ok: false,
        error: "email_send_failed",
        message: "We could not send the verification email. Please try again later.",
      }, 500);
    }

    return jsonResponse({
      ok: true,
      status: "email_sent",
      message: "Check your email for your verification link.",
    });
  } catch (error) {
    console.error("CDAS request access failed:", error);
    return jsonResponse({ ok: false, error: "request_failed" }, 500);
  }
}

async function handleCdasVerify(request, env, url) {
  try {
    const requestId = cleanField(url.searchParams.get("requestId"), 120);
    const token = cleanField(url.searchParams.get("token"), 500);

    if (!requestId || !token) {
      return jsonResponse({ ok: false, error: "invalid_or_expired_link" }, 400);
    }

    const suppliedHash = await secureHash(`${env.CDAS_TOKEN_SECRET || "dev-only"}:${token}`);
    const accessRequest = await env.RELAYHUB_DB.prepare(
      `SELECT * FROM document_access_requests WHERE id = ? LIMIT 1`
    ).bind(requestId).first();

    if (!accessRequest || accessRequest.verification_token_hash !== suppliedHash) {
      return jsonResponse({ ok: false, error: "invalid_or_expired_link" }, 403);
    }

    if (accessRequest.expires_at && new Date(accessRequest.expires_at).getTime() < Date.now()) {
      await env.RELAYHUB_DB.prepare(
        `UPDATE document_access_requests SET status = 'expired' WHERE id = ?`
      ).bind(requestId).run();
      return jsonResponse({ ok: false, error: "verification_link_expired" }, 410);
    }

    const document = await env.RELAYHUB_DB.prepare(
      `SELECT * FROM documents WHERE id = ? LIMIT 1`
    ).bind(accessRequest.document_id).first();

    if (!document || ["withdrawn", "disabled", "archived"].includes(document.status)) {
      return jsonResponse({ ok: false, error: "document_unavailable" }, 403);
    }

    const verifiedAt = new Date().toISOString();

    if (cdasRequiresApproval(document)) {
      await env.RELAYHUB_DB.prepare(
        `UPDATE document_access_requests
         SET status = 'pending_approval', email_verified_at = ?, verification_token_hash = NULL
         WHERE id = ?`
      ).bind(verifiedAt, requestId).run();

      return jsonResponse({
        ok: true,
        status: "pending_approval",
        message: "Your email has been verified. Your request is awaiting review.",
      });
    }

    const { licence, downloadLink, downloadToken } = await issueCdasLicenceAndDownloadLink(env, accessRequest, document);

    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET status = 'download_ready', email_verified_at = ?, verification_token_hash = NULL
       WHERE id = ?`
    ).bind(verifiedAt, requestId).run();

    return jsonResponse({
      ok: true,
      status: "download_ready",
      licenceNumber: licence.licenceNumber,
      downloadUrl: `${url.origin}/api/document-access/download?linkId=${encodeURIComponent(downloadLink.id)}&token=${encodeURIComponent(downloadToken)}`,
      message: "Your email has been verified and your licensed download is ready.",
    });
  } catch (error) {
    console.error("CDAS verification failed:", error);
    return jsonResponse({ ok: false, error: "verification_failed" }, 500);
  }
}

async function handleCdasDownload(request, env, url) {
  const started = Date.now();

  try {
    const linkId = cleanField(url.searchParams.get("linkId"), 120);
    const token = cleanField(url.searchParams.get("token"), 500);

    if (!linkId || !token) {
      return jsonResponse({ ok: false, error: "invalid_or_expired_link" }, 400);
    }

    const suppliedHash = await secureHash(`${env.CDAS_TOKEN_SECRET || "dev-only"}:${token}`);

    const link = await env.RELAYHUB_DB.prepare(
      `SELECT * FROM document_download_links WHERE id = ? LIMIT 1`
    )
      .bind(linkId)
      .first();

    if (!link || link.token_hash !== suppliedHash) {
      return jsonResponse({ ok: false, error: "invalid_or_expired_link" }, 403);
    }

    if (link.status !== "created" && link.status !== "sent") {
      return jsonResponse({ ok: false, error: "download_link_unavailable" }, 410);
    }

    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      await env.RELAYHUB_DB.prepare(
        `UPDATE document_download_links
         SET status = 'expired',
             failure_reason = 'expired'
         WHERE id = ?`
      )
        .bind(link.id)
        .run();

      return jsonResponse({ ok: false, error: "download_link_expired" }, 410);
    }

    const licence = await env.RELAYHUB_DB.prepare(
      `SELECT * FROM document_licences WHERE id = ? LIMIT 1`
    )
      .bind(link.licence_id)
      .first();

    if (!licence || licence.status !== "active") {
      await env.RELAYHUB_DB.prepare(
        `UPDATE document_download_links
         SET status = 'failed',
             failure_reason = 'licence_not_active'
         WHERE id = ?`
      )
        .bind(link.id)
        .run();

      return jsonResponse({ ok: false, error: "licence_unavailable" }, 403);
    }

    const document = await env.RELAYHUB_DB.prepare(
      `SELECT * FROM documents WHERE id = ? LIMIT 1`
    )
      .bind(link.document_id)
      .first();

    if (!document || ["withdrawn", "disabled", "archived"].includes(document.status)) {
      await env.RELAYHUB_DB.prepare(
        `UPDATE document_download_links
         SET status = 'failed',
             failure_reason = 'document_unavailable'
         WHERE id = ?`
      )
        .bind(link.id)
        .run();

      return jsonResponse({ ok: false, error: "document_unavailable" }, 403);
    }

    const sourceObject = await env.RELAYHUB_DOWNLOADS.get(document.source_object);

    if (!sourceObject) {
      const failureDownloadId = await nextCdasDownloadId(env);

      await recordCdasDownloadEvent(env, request, {
        downloadId: failureDownloadId,
        licence,
        document,
        eventType: "generation_failed",
        success: 0,
        failureReason: "source_object_missing",
        generatedObject: null,
        generatedSha256: null,
      });

      await env.RELAYHUB_DB.prepare(
        `UPDATE document_download_links
         SET status = 'failed',
             failure_reason = 'source_object_missing'
         WHERE id = ?`
      )
        .bind(link.id)
        .run();

      return jsonResponse({ ok: false, error: "document_temporarily_unavailable" }, 503);
    }

    const sourceBytes = await sourceObject.arrayBuffer();
    const sourceSha256 = await sha256ArrayBuffer(sourceBytes);
    const downloadId = await nextCdasDownloadId(env);

    const holderName = cdasLicenceDisplayName(licence);

    const personalisedBytes = await generateLicensedPdf(sourceBytes, {
      documentTitle: document.title,
      documentVersion: document.version,
      documentId: document.id,
      licenceNumber: licence.licence_number,
      downloadId,
      licenceHolderType: licence.licence_holder_type,
      licenceHolderName: holderName,
      organisationName: licence.organisation_name,
      contactName: licence.contact_name,
      verifiedEmail: licence.licence_holder_email,
      recipientCategory: licence.recipient_category,
      issuedAt: licence.issued_at,
      termsVersion: licence.licence_terms_version,
    });

    const generatedSha256 = await sha256ArrayBuffer(personalisedBytes);
    const generatedObject = `${CDAS_GENERATED_PREFIX}${document.id}/${document.version}/${licence.licence_number}/${downloadId}.pdf`;

    await env.RELAYHUB_DOWNLOADS.put(generatedObject, personalisedBytes, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `attachment; filename="${safeDownloadFilename(`${document.slug || document.id}-${document.version}-${licence.licence_number}.pdf`)}"`,
      },
      customMetadata: {
        document_id: document.id,
        document_version: document.version,
        licence_number: licence.licence_number,
        download_id: downloadId,
        generated_sha256: generatedSha256,
      },
    });

    await recordCdasDownloadEvent(env, request, {
      downloadId,
      licence,
      document,
      eventType: "downloaded",
      success: 1,
      failureReason: null,
      generatedObject,
      sourceSha256,
      generatedSha256,
    });

    await env.RELAYHUB_DB.prepare(
      `UPDATE document_download_links
       SET status = 'used',
           used_at = ?,
           ip_hash = ?,
           user_agent = ?
       WHERE id = ?`
    )
      .bind(
        new Date().toISOString(),
        await getRequestIpHash(request, env),
        cleanField(request.headers.get("User-Agent"), 500),
        link.id
      )
      .run();

    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET status = 'downloaded'
       WHERE id = ?`
    )
      .bind(licence.request_id)
      .run();

    recordDownloadAnalytics(request, env, url, {
      key: `cdas:${document.id}`,
      statusCode: 200,
      outcome: "success",
      contentType: "application/pdf",
      size: personalisedBytes.byteLength,
      started,
    });

    const headers = new Headers();
    headers.set("content-type", "application/pdf");
    headers.set("content-length", String(personalisedBytes.byteLength));
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-relayhub-licence-number", licence.licence_number);
    headers.set("x-relayhub-download-id", downloadId);
    headers.set(
      "content-disposition",
      `attachment; filename="${safeDownloadFilename(`${document.slug || document.id}-${document.version}-${licence.licence_number}.pdf`)}"`
    );

    return new Response(request.method === "HEAD" ? null : personalisedBytes, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("CDAS download failed:", error);

    recordDownloadAnalytics(request, env, url, {
      key: "cdas:download_failed",
      statusCode: 500,
      outcome: "error",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return jsonResponse({ ok: false, error: "download_failed" }, 500);
  }
}

async function handleCdasLicenceVerify(request, env, url) {
  try {
    const licenceNumber = cleanField(url.searchParams.get("licenceNumber") || url.searchParams.get("licence"), 120);

    if (!licenceNumber) {
      return jsonResponse({ ok: false, error: "missing_licence_number" }, 400);
    }

    const licence = await env.RELAYHUB_DB.prepare(
      `SELECT
        l.licence_number,
        l.status,
        l.issued_at,
        l.document_id,
        l.document_version,
        d.title,
        d.classification
       FROM document_licences l
       LEFT JOIN documents d ON d.id = l.document_id
       WHERE l.licence_number = ?
       LIMIT 1`
    )
      .bind(licenceNumber)
      .first();

    if (!licence) {
      return jsonResponse({
        ok: false,
        verified: false,
        message: "This licence could not be verified publicly.",
      }, 404);
    }

    if (["confidential", "internal_only", "restricted"].includes(licence.classification)) {
      return jsonResponse({
        ok: false,
        verified: false,
        message: "This licence could not be verified publicly.",
      }, 404);
    }

    return jsonResponse({
      ok: true,
      verified: true,
      licenceNumber: licence.licence_number,
      status: licence.status,
      document: licence.title,
      version: licence.document_version,
      issuedAt: licence.issued_at,
      message: "This is a valid RelayHub document licence.",
    });
  } catch (error) {
    console.error("CDAS licence verify failed:", error);
    return jsonResponse({ ok: false, error: "licence_verify_failed" }, 500);
  }
}

async function handleCdasAdminDocuments(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 250, 100);
  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM documents
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return jsonResponse({ ok: true, documents: rows.results || [] });
}

async function handleCdasAdminRequests(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 250, 100);
  const status = cleanField(url.searchParams.get("status"), 80);

  let query = `
    SELECT
      r.*,
      d.title AS document_title,
      d.slug AS document_slug,
      d.classification AS document_classification
    FROM document_access_requests r
    LEFT JOIN documents d ON d.id = r.document_id
  `;
  const binds = [];

  if (status) {
    query += ` WHERE r.status = ?`;
    binds.push(status);
  }

  query += ` ORDER BY r.requested_at DESC LIMIT ?`;
  binds.push(limit);

  const rows = await env.RELAYHUB_DB.prepare(query).bind(...binds).all();

  return jsonResponse({ ok: true, requests: rows.results || [] });
}

async function handleCdasAdminLicences(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 250, 100);
  const status = cleanField(url.searchParams.get("status"), 80);
  const email = normaliseEmail(url.searchParams.get("email") || "");

  let query = `
    SELECT
      l.*,
      d.title AS document_title,
      d.slug AS document_slug,
      (
        SELECT COUNT(*)
        FROM document_download_events e
        WHERE e.licence_id = l.id
          AND e.success = 1
      ) AS successful_downloads
    FROM document_licences l
    LEFT JOIN documents d ON d.id = l.document_id
  `;
  const where = [];
  const binds = [];

  if (status) {
    where.push(`l.status = ?`);
    binds.push(status);
  }

  if (email) {
    where.push(`l.licence_holder_email_normalised = ?`);
    binds.push(email);
  }

  if (where.length) {
    query += ` WHERE ${where.join(" AND ")}`;
  }

  query += ` ORDER BY l.issued_at DESC LIMIT ?`;
  binds.push(limit);

  const rows = await env.RELAYHUB_DB.prepare(query).bind(...binds).all();

  return jsonResponse({ ok: true, licences: rows.results || [] });
}

async function handleCdasAdminRevokeLicence(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const licenceId = extractAdminPathId(url.pathname, "/api/admin/document-licences/", "/revoke");

  if (!licenceId) {
    return jsonResponse({ ok: false, error: "missing_licence_id" }, 400);
  }

  const body = await readJson(request) || {};
  const reason = cleanField(body.reason || "manual_admin_revocation", 500);
  const adminIdentity = getAdminIdentity(request, env);
  const revokedAt = new Date().toISOString();

  const before = await env.RELAYHUB_DB.prepare(
    `SELECT * FROM document_licences WHERE id = ? LIMIT 1`
  )
    .bind(licenceId)
    .first();

  if (!before) {
    return jsonResponse({ ok: false, error: "licence_not_found" }, 404);
  }

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_licences
     SET status = 'revoked',
         revoked_at = ?,
         revoked_by = ?,
         revocation_reason = ?
     WHERE id = ?`
  )
    .bind(revokedAt, adminIdentity, reason, licenceId)
    .run();

  await env.RELAYHUB_DB.prepare(
    `UPDATE document_download_links
     SET status = 'revoked',
         revoked_at = ?,
         failure_reason = 'licence_revoked'
     WHERE licence_id = ?
       AND status IN ('created', 'sent')`
  )
    .bind(revokedAt, licenceId)
    .run();

  const after = await env.RELAYHUB_DB.prepare(
    `SELECT * FROM document_licences WHERE id = ? LIMIT 1`
  )
    .bind(licenceId)
    .first();

  await recordAdminAuditEvent(env, request, {
    action: "cdas.licence.revoke",
    targetType: "document_licence",
    targetId: licenceId,
    before,
    after,
    reason,
  });

  return jsonResponse({
    ok: true,
    status: "revoked",
    licence: after,
  });
}

async function handleCdasAdminReissueLink(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const licenceId = extractAdminPathId(url.pathname, "/api/admin/document-licences/", "/reissue-link");

  if (!licenceId) {
    return jsonResponse({ ok: false, error: "missing_licence_id" }, 400);
  }

  const licence = await env.RELAYHUB_DB.prepare(
    `SELECT * FROM document_licences WHERE id = ? LIMIT 1`
  )
    .bind(licenceId)
    .first();

  if (!licence || licence.status !== "active") {
    return jsonResponse({ ok: false, error: "licence_unavailable" }, 403);
  }

  const document = await env.RELAYHUB_DB.prepare(
    `SELECT * FROM documents WHERE id = ? LIMIT 1`
  )
    .bind(licence.document_id)
    .first();

  if (!document || ["withdrawn", "disabled", "archived"].includes(document.status)) {
    return jsonResponse({ ok: false, error: "document_unavailable" }, 403);
  }

  const downloadToken = randomToken(32);
  const downloadTokenHash = await secureHash(`${env.CDAS_TOKEN_SECRET || "dev-only"}:${downloadToken}`);
  const downloadLinkId = randomId("dll");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CDAS_DOWNLOAD_TTL_SECONDS * 1000).toISOString();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_download_links (
      id, licence_id, document_id, token_hash, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, 'created', ?, ?)`
  )
    .bind(downloadLinkId, licence.id, document.id, downloadTokenHash, createdAt, expiresAt)
    .run();

  await recordAdminAuditEvent(env, request, {
    action: "cdas.licence.reissue_link",
    targetType: "document_licence",
    targetId: licence.id,
    before: null,
    after: { downloadLinkId, expiresAt },
    reason: "manual_reissue",
  });

  return jsonResponse({
    ok: true,
    downloadLinkId,
    expiresAt,
    downloadUrl: `${url.origin}/api/document-access/download?linkId=${encodeURIComponent(downloadLinkId)}&token=${encodeURIComponent(downloadToken)}`,
  });
}

async function handleCdasAdminDownloads(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 250, 100);

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_download_events
     ORDER BY event_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return jsonResponse({ ok: true, downloads: rows.results || [] });
}

async function handleCdasAdminLicenceTerms(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT id, version, title, status, applies_to_access_class, effective_from, effective_to, created_at, retired_at, notes
     FROM licence_terms
     ORDER BY created_at DESC`
  )
    .all();

  return jsonResponse({ ok: true, licenceTerms: rows.results || [] });
}

async function handleCdasAdminAudit(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 250, 100);

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM admin_audit_events
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return jsonResponse({ ok: true, auditEvents: rows.results || [] });
}

async function issueCdasLicenceAndDownloadLink(env, accessRequest, document) {
  const issuedAt = new Date().toISOString();
  const licenceNumber = await nextCdasLicenceNumber(env);
  const licenceId = randomId("lic");

  const licenceHolderName =
    accessRequest.licence_holder_type === "organisation"
      ? accessRequest.organisation_name
      : accessRequest.name;

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
      issued_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  )
    .bind(
      licenceId,
      licenceNumber,
      accessRequest.id,
      accessRequest.document_id,
      accessRequest.document_version,
      accessRequest.licence_holder_type,
      licenceHolderName || null,
      accessRequest.organisation_name || null,
      accessRequest.contact_name || null,
      accessRequest.contact_email || null,
      accessRequest.email,
      accessRequest.email_normalised,
      accessRequest.recipient_category,
      accessRequest.terms_version,
      issuedAt
    )
    .run();

  const downloadToken = randomToken(32);
  const downloadTokenHash = await secureHash(`${env.CDAS_TOKEN_SECRET || "dev-only"}:${downloadToken}`);
  const downloadLinkId = randomId("dll");

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_download_links (
      id,
      licence_id,
      document_id,
      token_hash,
      status,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, 'created', ?, ?)`
  )
    .bind(
      downloadLinkId,
      licenceId,
      accessRequest.document_id,
      downloadTokenHash,
      issuedAt,
      new Date(Date.now() + CDAS_DOWNLOAD_TTL_SECONDS * 1000).toISOString()
    )
    .run();

  return {
    licence: {
      id: licenceId,
      licenceNumber,
    },
    downloadLink: {
      id: downloadLinkId,
    },
    downloadToken,
  };
}

async function recordCdasDownloadEvent(env, request, details) {
  const ipHashValue = await getRequestIpHash(request, env);
  const userAgent = cleanField(request.headers.get("User-Agent"), 500);

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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      randomId("dde"),
      details.downloadId,
      details.licence.id,
      details.licence.licence_number,
      details.document.id,
      details.document.version,
      cdasLicenceDisplayName(details.licence),
      details.licence.organisation_name || null,
      details.licence.licence_holder_email,
      details.eventType,
      new Date().toISOString(),
      ipHashValue,
      userAgent,
      details.generatedObject || null,
      details.document.source_object,
      details.sourceSha256 || details.document.source_sha256 || null,
      details.generatedSha256 || null,
      null,
      "CDAS-LICENCE-PAGE-v0.2",
      "CDAS-WATERMARK-v0.2",
      "CDAS-FOOTER-v0.2",
      "CDAS-TERMS-PAGE-v0.2",
      "CDAS-PDF-GENERATOR-v0.2",
      details.licence.licence_terms_version,
      Number(details.success),
      details.failureReason || null
    )
    .run();
}

async function recordAdminAuditEvent(env, request, details) {
  await env.RELAYHUB_DB.prepare(
    `INSERT INTO admin_audit_events (
      id,
      admin_identity,
      action,
      target_type,
      target_id,
      before_json,
      after_json,
      reason,
      created_at,
      ip_hash,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      randomId("aae"),
      getAdminIdentity(request, env),
      details.action,
      details.targetType,
      details.targetId,
      details.before ? JSON.stringify(details.before) : null,
      details.after ? JSON.stringify(details.after) : null,
      details.reason || null,
      new Date().toISOString(),
      await getRequestIpHash(request, env),
      cleanField(request.headers.get("User-Agent"), 500)
    )
    .run();
}

async function getCdasDocumentByRef(env, ref) {
  return env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

async function getCdasActiveTerms(env, version) {
  return env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM licence_terms
     WHERE version = ?
       AND status = 'active'
     LIMIT 1`
  )
    .bind(version)
    .first();
}

async function getCdasEmailDomainPolicy(env, domain) {
  if (!domain) return null;

  return env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM email_domain_policy
     WHERE domain = ?
     LIMIT 1`
  )
    .bind(domain)
    .first();
}

function isProtectedCdasAccessClass(accessClass) {
  return [
    "verified_public",
    "licensed_public",
    "controlled_verified",
    "approval_required",
    "invite_only",
    "paid_verified",
  ].includes(accessClass);
}

function cdasRequiresApproval(document) {
  return (
    Number(document.requires_approval || 0) === 1 ||
    document.access_class === "approval_required" ||
    document.classification === "restricted" ||
    document.classification === "confidential" ||
    document.classification === "internal_only"
  );
}

function cdasLicenceDisplayName(licence) {
  if (!licence) return "Unknown";

  if (licence.licence_holder_type === "organisation") {
    return licence.organisation_name || licence.licence_holder_name || licence.contact_name || "Organisation";
  }

  return licence.licence_holder_name || licence.contact_name || "Licence Holder";
}

async function nextCdasLicenceNumber(env) {
  const year = new Date().getUTCFullYear();
  const value = await incrementCdasCounter(env, `licence_${year}`);
  return `RH-LIC-${year}-${String(value).padStart(6, "0")}`;
}

async function nextCdasDownloadId(env) {
  const year = new Date().getUTCFullYear();
  const value = await incrementCdasCounter(env, `download_${year}`);
  return `RH-DL-${year}-${String(value).padStart(6, "0")}`;
}

async function incrementCdasCounter(env, counterName) {
  const now = new Date().toISOString();

  const existing = await env.RELAYHUB_DB.prepare(
    `SELECT current_value
     FROM cdas_counters
     WHERE counter_name = ?
     LIMIT 1`
  )
    .bind(counterName)
    .first();

  if (!existing) {
    await env.RELAYHUB_DB.prepare(
      `INSERT INTO cdas_counters (counter_name, current_value, updated_at)
       VALUES (?, 0, ?)`
    )
      .bind(counterName, now)
      .run();
  }

  await env.RELAYHUB_DB.prepare(
    `UPDATE cdas_counters
     SET current_value = current_value + 1,
         updated_at = ?
     WHERE counter_name = ?`
  )
    .bind(now, counterName)
    .run();

  const updated = await env.RELAYHUB_DB.prepare(
    `SELECT current_value
     FROM cdas_counters
     WHERE counter_name = ?
     LIMIT 1`
  )
    .bind(counterName)
    .first();

  return Number(updated.current_value || 0);
}

async function sendCdasEmail(env, { to, subject, body }) {
  if (!env.RELAYHUB_EMAIL) {
    console.warn("RELAYHUB_EMAIL binding is missing.");
    return { ok: false, reason: "email_binding_missing" };
  }

  try {
    const rawEmail = buildRawEmail({
      from: EMAIL_FROM,
      to,
      subject: subject || "RelayHub document access",
      body: body || "",
    });

    const message = new EmailMessage(
      EMAIL_FROM,
      to,
      rawEmail
    );

    await env.RELAYHUB_EMAIL.send(message);

    return { ok: true };
  } catch (error) {
    console.error("CDAS email send failed:", error);
    return {
      ok: false,
      reason: error?.message || "email_send_failed",
    };
  }
}

function buildCdasVerificationEmail({ document, verificationUrl }) {
  return `You requested access to ${document.title} ${document.version}.

Please verify this email address to continue:

${verificationUrl}

This link expires in 24 hours.

If you did not request this document, you can ignore this email.`;
}

async function generateLicensedPdf(sourceBytes, licence) {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pages = pdfDoc.getPages();

  for (const [index, page] of pages.entries()) {
    const { width, height } = page.getSize();

    page.drawText("RELAYHUB LICENSED COPY", {
      x: width / 2 - 210,
      y: height / 2,
      size: 38,
      font: helveticaBold,
      color: rgb(0.78, 0.82, 0.88),
      rotate: { type: "degrees", angle: -35 },
      opacity: 0.24,
    });

    page.drawText(`Licensed to: ${licence.licenceHolderName}`, {
      x: 36,
      y: 24,
      size: 7.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    page.drawText(`Licence: ${licence.licenceNumber}`, {
      x: 36,
      y: 14,
      size: 7.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    const rightText = `${licence.documentTitle} ${licence.documentVersion} | ${licence.downloadId}`;
    const rightWidth = helvetica.widthOfTextAtSize(rightText, 7.5);

    page.drawText(rightText, {
      x: Math.max(36, width - rightWidth - 36),
      y: 14,
      size: 7.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    page.drawText(`Page ${index + 1} of ${pages.length}`, {
      x: width - 88,
      y: 24,
      size: 7.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });
  }

  const licencePage = pdfDoc.insertPage(1);
  drawCdasLicencePage(licencePage, { helvetica, helveticaBold }, licence);

  const termsPage = pdfDoc.insertPage(2);
  drawCdasTermsPage(termsPage, { helvetica, helveticaBold }, licence);

  pdfDoc.setTitle(`${licence.documentTitle} ${licence.documentVersion}`);
  pdfDoc.setAuthor("RelayHub");
  pdfDoc.setSubject("Individually licensed RelayHub document");
  pdfDoc.setKeywords([
    "RelayHub",
    licence.documentId,
    licence.documentVersion,
    licence.licenceNumber,
    licence.downloadId,
    licence.termsVersion,
  ]);
  pdfDoc.setProducer("RelayHub CDAS v0.2");
  pdfDoc.setCreator("RelayHub Controlled Document Access System");

  return await pdfDoc.save();
}

function drawCdasLicencePage(page, fonts, licence) {
  const { width, height } = page.getSize();
  const { helvetica, helveticaBold } = fonts;

  page.drawText("RelayHub Individual Document Licence", {
    x: 54,
    y: height - 72,
    size: 22,
    font: helveticaBold,
    color: rgb(0.05, 0.12, 0.24),
  });

  page.drawText("This document has been individually licensed and audited.", {
    x: 54,
    y: height - 104,
    size: 11,
    font: helvetica,
    color: rgb(0.18, 0.22, 0.28),
  });

  const rows = [
    ["Licence Number", licence.licenceNumber],
    ["Download ID", licence.downloadId],
    ["Document", `${licence.documentTitle} ${licence.documentVersion}`],
    ["Document ID", licence.documentId],
    ["Licence Holder Type", licence.licenceHolderType],
    ["Licence Holder", licence.licenceHolderName],
    ["Organisation", licence.organisationName || "—"],
    ["Contact", licence.contactName || "—"],
    ["Verified Email", licence.verifiedEmail],
    ["Recipient Category", licence.recipientCategory],
    ["Issued At", licence.issuedAt],
    ["Terms Version", licence.termsVersion],
  ];

  let y = height - 150;

  for (const [label, value] of rows) {
    page.drawText(label, {
      x: 54,
      y,
      size: 10,
      font: helveticaBold,
      color: rgb(0.05, 0.12, 0.24),
    });

    page.drawText(String(value || "—"), {
      x: 190,
      y,
      size: 10,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    y -= 22;
  }

  const notice = [
    "This licence identifies the authorised recipient of this copy.",
    "The presence of a licence does not grant permission to redistribute, republish, resell,",
    "modify, remove licence markings from, or present this document as independent authority.",
    "RelayHub may revoke future access if misuse, incorrect recipient details, or policy breach is identified.",
  ];

  y -= 24;

  for (const line of notice) {
    page.drawText(line, {
      x: 54,
      y,
      size: 9,
      font: helvetica,
      color: rgb(0.25, 0.28, 0.33),
    });
    y -= 15;
  }

  page.drawText("RelayHub — Build resilient communities.", {
    x: 54,
    y: 54,
    size: 10,
    font: helveticaBold,
    color: rgb(0.05, 0.12, 0.24),
  });

  const footer = `Licence ${licence.licenceNumber} | Download ${licence.downloadId}`;
  const footerWidth = helvetica.widthOfTextAtSize(footer, 8);

  page.drawText(footer, {
    x: width - footerWidth - 54,
    y: 54,
    size: 8,
    font: helvetica,
    color: rgb(0.35, 0.38, 0.42),
  });
}

function drawCdasTermsPage(page, fonts, licence) {
  const { height } = page.getSize();
  const { helvetica, helveticaBold } = fonts;

  page.drawText("RelayHub Licence Terms", {
    x: 54,
    y: height - 72,
    size: 22,
    font: helveticaBold,
    color: rgb(0.05, 0.12, 0.24),
  });

  page.drawText(`Terms Version: ${licence.termsVersion}`, {
    x: 54,
    y: height - 104,
    size: 10,
    font: helvetica,
    color: rgb(0.18, 0.22, 0.28),
  });

  const terms = [
    "1. This document is individually licensed to the named licence holder.",
    "2. The licence holder may read and retain the document for permitted review, educational,",
    "   organisational, or evaluation purposes.",
    "3. The licence holder must not redistribute, republish, resell, modify, remove licence",
    "   markings from, or present this document as their own work or authority without written",
    "   permission from RelayHub.",
    "4. RelayHub documents may include architecture, governance, policy, validation, product,",
    "   and operational material. They should be quoted, referenced, or shared only in ways",
    "   consistent with the applicable licence and RelayHub’s published terms.",
    "5. RelayHub may revoke future access where misuse, redistribution, incorrect recipient",
    "   details, or policy breach is identified.",
    "6. Revocation blocks future access. It does not imply technical recall of already downloaded",
    "   copies and does not erase historical audit records.",
    "7. This document is not DRM-protected. The licence, watermark, metadata, and audit trail",
    "   exist to preserve attribution and accountability.",
    "",
    `Licence Number: ${licence.licenceNumber}`,
    `Download ID: ${licence.downloadId}`,
    `Licence Holder: ${licence.licenceHolderName}`,
    `Verified Email: ${licence.verifiedEmail}`,
  ];

  let y = height - 142;

  for (const line of terms) {
    page.drawText(line, {
      x: 54,
      y,
      size: 9.2,
      font: line.match(/^\d+\./) ? helveticaBold : helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    y -= 15;
  }

  page.drawText("RelayHub — Build resilient communities.", {
    x: 54,
    y: 54,
    size: 10,
    font: helveticaBold,
    color: rgb(0.05, 0.12, 0.24),
  });
}

// ============================================================
// Existing download/document workflow
// ============================================================

async function handleDownload(request, env, url) {
  const started = Date.now();
  const key = decodeURIComponent(url.pathname.replace(/^\/download\//, ""));

  if (!key || key.includes("..") || key.startsWith("/")) {
    recordDownloadAnalytics(request, env, url, {
      key,
      statusCode: 400,
      outcome: "blocked_invalid_key",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("Invalid download path.", 400);
  }

  const policy = evaluateDownloadPolicy(key);

  if (!policy.allowed) {
    recordDownloadAnalytics(request, env, url, {
      key,
      statusCode: 403,
      outcome: policy.reason,
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("This file is not available for direct download.", 403);
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

    return textResponse("File not found.", 404);
  }

  const contentType = object.httpMetadata?.contentType || guessContentType(key);
  const size = Number(object.size || 0);

  recordDownloadAnalytics(request, env, url, {
    key,
    statusCode: 200,
    outcome: "success",
    contentType,
    size,
    started,
  });

  const headers = new Headers();

  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=3600");
  headers.set("x-content-type-options", "nosniff");

  if (!headers.has("content-type")) {
    headers.set("content-type", contentType);
  }

  if (!headers.has("content-disposition")) {
    headers.set("content-disposition", `attachment; filename="${filenameFromKey(key)}"`);
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, {
    status: 200,
    headers,
  });
}

async function handleFreeDownloadPost(request, env, url) {
  const started = Date.now();
  const body = await readFormOrJson(request);

  if (!body.ok) {
    return jsonResponse({ ok: false, error: "Invalid request body." }, 400);
  }

  const data = body.data;

  const email = normaliseEmail(data.email);
  const name = cleanField(data.name || data.fullName || "", 160);
  const documentId = cleanField(data.documentId || data.document_id || data.doc || "", 120);
  const formStartedAtRaw = Number(data.formStartedAt || data.form_started_at || 0);
  const website = cleanField(data.website || data.companyWebsite || "", 300);

  if (website) {
    return jsonResponse({ ok: true, status: "ignored" });
  }

  if (formStartedAtRaw && Date.now() - formStartedAtRaw < MIN_FORM_FILL_TIME_MS) {
    return jsonResponse({ ok: false, error: "Please try again." }, 429);
  }

  if (!isValidEmail(email)) {
    return jsonResponse({ ok: false, error: "Please enter a valid email address." }, 400);
  }

  if (!name) {
    return jsonResponse({ ok: false, error: "Please enter your name." }, 400);
  }

  if (!documentId) {
    return jsonResponse({ ok: false, error: "Missing document id." }, 400);
  }

  const catalogue = await loadDocumentCatalogue(env);
  const document = catalogue.documents.find((item) => item.id === documentId);

  if (!document || document.access !== "free") {
    return jsonResponse({ ok: false, error: "Document is not available." }, 404);
  }

  const rate = await checkDownloadRateLimit(env, email, request);

  if (!rate.allowed) {
    return jsonResponse({
      ok: false,
      error: "Too many download requests. Please try again later.",
    }, 429);
  }

  const issuedAt = new Date().toISOString();
  const downloadToken = randomToken(32);
  const downloadTokenHash = await secureHash(downloadToken);
  const downloadId = `rh_${cryptoRandomHex(12)}`;
  const licenceNumber = `RH-FREE-${new Date().getUTCFullYear()}-${cryptoRandomHex(6).toUpperCase()}`;

  const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const ipHashValue = await getRequestIpHash(request, env);
  const userAgent = cleanField(request.headers.get("User-Agent"), 500);

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO download_registry (
      id,
      document_id,
      document_title,
      document_version,
      source_object,
      email,
      name,
      licence_number,
      token_hash,
      token_expires_at,
      status,
      issued_at,
      ip_hash,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      downloadId,
      document.id,
      document.title,
      document.version || "",
      document.sourceObject,
      email,
      name,
      licenceNumber,
      downloadTokenHash,
      tokenExpiresAt,
      "issued",
      issuedAt,
      ipHashValue,
      userAgent
    )
    .run();

  const downloadUrl = `${url.origin}/api/download/${encodeURIComponent(downloadToken)}`;

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO download_events (
      id,
      registry_id,
      event_type,
      event_at,
      ip_hash,
      user_agent,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      cryptoRandomHex(16),
      downloadId,
      "issued",
      issuedAt,
      ipHashValue,
      userAgent,
      JSON.stringify({ via: "free-download-form" })
    )
    .run();
      await sendInternalEmail(env, {
    subject: `RelayHub document download issued: ${document.title}`,
    body: [
      `A RelayHub document download was issued.`,
      ``,
      `Name: ${name}`,
      `Email: ${email}`,
      `Document: ${document.title}`,
      `Version: ${document.version || ""}`,
      `Licence: ${licenceNumber}`,
      `Download ID: ${downloadId}`,
      `Issued: ${issuedAt}`,
      ``,
      `Download URL: ${downloadUrl}`,
    ].join("\n"),
  });

  return jsonResponse({
    ok: true,
    downloadUrl,
    licenceNumber,
    expiresAt: tokenExpiresAt,
  });
}

async function handlePersonalisedDownload(request, env, url) {
  const started = Date.now();
  const token = decodeURIComponent(url.pathname.replace(/^\/api\/download\//, ""));

  if (!token) {
    return textResponse("Invalid download token.", 400);
  }

  const tokenHash = await secureHash(token);

  const registry = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM download_registry
     WHERE token_hash = ?
     LIMIT 1`
  )
    .bind(tokenHash)
    .first();

  if (!registry) {
    recordDownloadAnalytics(request, env, url, {
      key: "personalised:invalid-token",
      statusCode: 404,
      outcome: "invalid_token",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("This download link is invalid or has expired.", 404);
  }

  if (registry.status !== "issued") {
    recordDownloadAnalytics(request, env, url, {
      key: registry.source_object,
      statusCode: 410,
      outcome: "token_not_issued",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("This download link has already been used or is no longer available.", 410);
  }

  if (registry.token_expires_at && new Date(registry.token_expires_at).getTime() < Date.now()) {
    await env.RELAYHUB_DB.prepare(
      `UPDATE download_registry
       SET status = 'expired'
       WHERE id = ?`
    )
      .bind(registry.id)
      .run();

    recordDownloadAnalytics(request, env, url, {
      key: registry.source_object,
      statusCode: 410,
      outcome: "expired",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("This download link has expired.", 410);
  }

  const object = await env.RELAYHUB_DOWNLOADS.get(registry.source_object);

  if (!object) {
    recordDownloadAnalytics(request, env, url, {
      key: registry.source_object,
      statusCode: 404,
      outcome: "source_missing",
      contentType: "text/plain",
      size: 0,
      started,
    });

    return textResponse("The source document is not currently available.", 404);
  }

  const sourceBytes = await object.arrayBuffer();

  let outputBytes;
  let contentType = "application/pdf";

  if (registry.source_object.toLowerCase().endsWith(".pdf")) {
    outputBytes = await personaliseLegacyPdf(sourceBytes, {
      documentTitle: registry.document_title,
      documentVersion: registry.document_version,
      name: registry.name,
      email: registry.email,
      licenceNumber: registry.licence_number,
      issuedAt: registry.issued_at,
    });
  } else {
    outputBytes = sourceBytes;
    contentType = object.httpMetadata?.contentType || guessContentType(registry.source_object);
  }

  const generatedKey = `docs/generated/free/${registry.document_id}/${registry.id}.pdf`;

  if (contentType === "application/pdf") {
    await env.RELAYHUB_DOWNLOADS.put(generatedKey, outputBytes, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `attachment; filename="${safeDownloadFilename(`${registry.document_id}-${registry.licence_number}.pdf`)}"`,
      },
    });
  }

  const ipHashValue = await getRequestIpHash(request, env);
  const userAgent = cleanField(request.headers.get("User-Agent"), 500);

  await env.RELAYHUB_DB.prepare(
    `UPDATE download_registry
     SET status = 'downloaded',
         downloaded_at = ?,
         generated_object = ?
     WHERE id = ?`
  )
    .bind(new Date().toISOString(), contentType === "application/pdf" ? generatedKey : null, registry.id)
    .run();

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO download_events (
      id,
      registry_id,
      event_type,
      event_at,
      ip_hash,
      user_agent,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      cryptoRandomHex(16),
      registry.id,
      "downloaded",
      new Date().toISOString(),
      ipHashValue,
      userAgent,
      JSON.stringify({
        generatedObject: contentType === "application/pdf" ? generatedKey : null,
        contentType,
      })
    )
    .run();

  recordDownloadAnalytics(request, env, url, {
    key: registry.source_object,
    statusCode: 200,
    outcome: "success",
    contentType,
    size: outputBytes.byteLength,
    started,
  });

  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("content-length", String(outputBytes.byteLength));
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", `attachment; filename="${safeDownloadFilename(`${registry.document_id}-${registry.licence_number}.pdf`)}"`);

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(outputBytes, {
    status: 200,
    headers,
  });
}

async function handleDownloadRegistryAdminJson(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 1000, 500);

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM download_registry
     ORDER BY issued_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  const records = (rows.results || []).map((row) => {
    const nameParts = String(row.name || "").trim().split(/\s+/);
    const firstName = nameParts.shift() || "";
    const lastName = nameParts.join(" ");

    const downloaded = row.status === "downloaded" || row.downloaded_at;

    return {
      id: row.id,
      createdAt: row.issued_at,
      issuedAt: row.issued_at,
      downloadedAt: row.downloaded_at || null,

      downloadId: row.id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      documentVersion: row.document_version,
      sourceObjectKey: row.source_object,

      type: "legacy_personalised",
      firstName,
      lastName,
      name: row.name,
      email: row.email,

      licenceNumber: row.licence_number,
      status: row.status,

      tokenExpiresAt: row.token_expires_at,
      expiresAt: row.token_expires_at,

      downloadCount: downloaded ? 1 : 0,
      maxDownloads: 1,
      lastDownloadedAt: row.downloaded_at || null,

      generatedObjectKey: row.generated_object || null,

      ipHash: row.ip_hash || null,
      userAgent: row.user_agent || null,
    };
  });

  return jsonResponse({
    ok: true,

    // Shape expected by the original 1000-line admin page.
    total: records.length,
    records,

    // Backward-compatible shape used by the newer simplified page.
    downloads: rows.results || [],
  });
}

async function loadDocumentCatalogue(env) {
  const object = await env.RELAYHUB_DOWNLOADS.get(DOCUMENT_CATALOGUE_KEY);

  if (!object) {
    return { documents: [] };
  }

  try {
    return await object.json();
  } catch {
    return { documents: [] };
  }
}

function evaluateDownloadPolicy(key) {
  const lower = key.toLowerCase();

  if (!DOWNLOAD_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return { allowed: false, reason: "blocked_prefix" };
  }

  if (DIRECT_DOWNLOAD_BLOCKED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return { allowed: false, reason: "blocked_controlled_prefix" };
  }

  if (!DOWNLOAD_ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { allowed: false, reason: "blocked_extension" };
  }

  return { allowed: true };
}

async function checkDownloadRateLimit(env, email, request) {
  const now = Date.now();
  const windowStart = new Date(now - RATE_LIMIT_WINDOW_SECONDS * 1000).toISOString();
  const ipHashValue = await getRequestIpHash(request, env);

  const emailCount = await env.RELAYHUB_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM download_registry
     WHERE email = ?
       AND issued_at >= ?`
  )
    .bind(email, windowStart)
    .first();

  const ipCount = ipHashValue
    ? await env.RELAYHUB_DB.prepare(
        `SELECT COUNT(*) AS count
         FROM download_registry
         WHERE ip_hash = ?
           AND issued_at >= ?`
      )
        .bind(ipHashValue, windowStart)
        .first()
    : { count: 0 };

  return {
    allowed:
      Number(emailCount?.count || 0) < RATE_LIMIT_MAX_REQUESTS &&
      Number(ipCount?.count || 0) < RATE_LIMIT_MAX_REQUESTS,
  };
}

async function personaliseLegacyPdf(sourceBytes, details) {
  const pdfDoc = await PDFDocument.load(sourceBytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = pdfDoc.getPages();

  for (const page of pages) {
    const { width, height } = page.getSize();

    page.drawText("RELAYHUB LICENSED COPY", {
      x: width / 2 - 210,
      y: height / 2,
      size: 38,
      font: helveticaBold,
      color: rgb(0.78, 0.82, 0.88),
      rotate: { type: "degrees", angle: -35 },
      opacity: 0.24,
    });

    page.drawText(`Licensed to: ${details.name}`, {
      x: 36,
      y: 24,
      size: 7.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    page.drawText(`Licence: ${details.licenceNumber}`, {
      x: 36,
      y: 14,
      size: 7.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    const rightText = `${details.documentTitle || "RelayHub Document"} ${details.documentVersion || ""}`;
    const rightWidth = helvetica.widthOfTextAtSize(rightText, 7.5);

    page.drawText(rightText, {
      x: Math.max(36, width - rightWidth - 36),
      y: 14,
      size: 7.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });
  }

  const licencePage = pdfDoc.insertPage(1);
  const { height } = licencePage.getSize();

  licencePage.drawText("RelayHub Individual Document Licence", {
    x: 54,
    y: height - 72,
    size: 22,
    font: helveticaBold,
    color: rgb(0.05, 0.12, 0.24),
  });

  const rows = [
    ["Licence Number", details.licenceNumber],
    ["Document", `${details.documentTitle || "RelayHub Document"} ${details.documentVersion || ""}`],
    ["Licence Holder", details.name],
    ["Email", details.email],
    ["Issued At", details.issuedAt],
  ];

  let y = height - 130;

  for (const [label, value] of rows) {
    licencePage.drawText(label, {
      x: 54,
      y,
      size: 10,
      font: helveticaBold,
      color: rgb(0.05, 0.12, 0.24),
    });

    licencePage.drawText(String(value || "—"), {
      x: 190,
      y,
      size: 10,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    y -= 22;
  }

  const termsPage = pdfDoc.insertPage(2);
  drawLegacyTermsPage(termsPage, { helvetica, helveticaBold }, details);

  pdfDoc.setTitle(`${details.documentTitle || "RelayHub Document"} ${details.documentVersion || ""}`);
  pdfDoc.setAuthor("RelayHub");
  pdfDoc.setSubject("Individually licensed RelayHub document");
  pdfDoc.setKeywords(["RelayHub", details.licenceNumber, details.email]);
  pdfDoc.setProducer("RelayHub Legacy Download Personaliser");
  pdfDoc.setCreator("RelayHub Website Worker");

  return await pdfDoc.save();
}

function drawLegacyTermsPage(page, fonts, details) {
  const { height } = page.getSize();
  const { helvetica, helveticaBold } = fonts;

  page.drawText("RelayHub Licence Terms", {
    x: 54,
    y: height - 72,
    size: 22,
    font: helveticaBold,
    color: rgb(0.05, 0.12, 0.24),
  });

  const terms = [
    "This document is individually licensed to the named licence holder.",
    "The licence holder may read and retain the document for personal review, educational,",
    "organisational, or evaluation purposes as permitted by RelayHub.",
    "",
    "The licence holder must not redistribute, republish, resell, modify, remove licence markings from,",
    "or present this document as their own work or authority without written permission from RelayHub.",
    "",
    "RelayHub may revoke future access where misuse, redistribution, incorrect recipient details,",
    "or policy breach is identified.",
    "",
    `Licence Number: ${details.licenceNumber}`,
    `Licence Holder: ${details.name}`,
    `Email: ${details.email}`,
  ];

  let y = height - 122;

  for (const line of terms) {
    page.drawText(line, {
      x: 54,
      y,
      size: 9.5,
      font: helvetica,
      color: rgb(0.18, 0.22, 0.28),
    });

    y -= 16;
  }

  page.drawText("RelayHub — Build resilient communities.", {
    x: 54,
    y: 54,
    size: 10,
    font: helveticaBold,
    color: rgb(0.05, 0.12, 0.24),
  });
}

// ============================================================
// Existing early access / contact routes
// ============================================================

async function handleEarlyAccessPost(request, env) {
  const body = await readFormOrJson(request);

  if (!body.ok) {
    return jsonResponse({ ok: false, error: "Invalid request body." }, 400);
  }

  const data = body.data;
  const email = normaliseEmail(data.email);
  const name = cleanField(data.name || "", 160);
  const community = cleanField(data.community || "", 200);
  const role = cleanField(data.role || "", 160);
  const message = cleanField(data.message || "", 2000);
  const website = cleanField(data.website || "", 300);

  if (website) {
    return jsonResponse({ ok: true, status: "ignored" });
  }

  if (!isValidEmail(email)) {
    return jsonResponse({ ok: false, error: "Please enter a valid email address." }, 400);
  }

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO early_access_requests (
      id,
      name,
      email,
      community,
      role,
      message,
      created_at,
      ip_hash,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      cryptoRandomHex(16),
      name,
      email,
      community,
      role,
      message,
      new Date().toISOString(),
      await getRequestIpHash(request, env),
      cleanField(request.headers.get("User-Agent"), 500)
    )
    .run();

  const emailResult = await sendInternalEmail(env, {
    subject: "New RelayHub early access request",
    body: [
      "New early access request:",
      "",
      `Name: ${name}`,
      `Email: ${email}`,
      `Community: ${community}`,
      `Role: ${role}`,
      "",
      message,
    ].join("\n"),
  });

  return jsonResponse({
    ok: true,
    emailSent: Boolean(emailResult?.ok),
    emailReason: emailResult?.reason || null,
});
}

async function handleContactPost(request, env) {
  const body = await readFormOrJson(request);

  if (!body.ok) {
    return jsonResponse({ ok: false, error: "Invalid request body." }, 400);
  }

  const data = body.data;
  const email = normaliseEmail(data.email);
  const name = cleanField(data.name || "", 160);
  const subject = cleanField(data.subject || "", 200);
  const message = cleanField(data.message || "", 4000);
  const website = cleanField(data.website || "", 300);

  if (website) {
    return jsonResponse({ ok: true, status: "ignored" });
  }

  if (!isValidEmail(email)) {
    return jsonResponse({ ok: false, error: "Please enter a valid email address." }, 400);
  }

  await env.RELAYHUB_DB.prepare(
    `INSERT INTO contact_messages (
      name,
      email,
      subject,
      message,
      created_at,
      ip_hash,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      name,
      email,
      subject,
      message,
      new Date().toISOString(),
      await getRequestIpHash(request, env),
      cleanField(request.headers.get("User-Agent"), 500)
    )
    .run();

  const emailResult = await sendInternalEmail(env, {
    subject: `RelayHub contact: ${subject || "New message"}`,
    body: [
      "New contact form message:",
      "",
      `Name: ${name}`,
      `Email: ${email}`,
      `Subject: ${subject}`,
      "",
      message,
    ].join("\n"),
  });

  return jsonResponse({
    ok: true,
    notificationSent: Boolean(emailResult?.ok),
  });
}

async function handleNewsletterAdminJson(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 500, 100);

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM early_access_requests
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return jsonResponse({
    ok: true,
    rows: rows.results || [],
  });
}

async function handleNewsletterAdminCsv(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 5000, 1000);

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM early_access_requests
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return csvResponse(rows.results || [], "relayhub-newsletter.csv");
}

async function handleContactAdminJson(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 500, 100);

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM contact_messages
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return jsonResponse({
    ok: true,
    rows: rows.results || [],
  });
}

async function handleContactAdminCsv(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const limit = clampNumber(url.searchParams.get("limit"), 1, 5000, 1000);

  const rows = await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM contact_messages
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();

  return csvResponse(rows.results || [], "relayhub-contact.csv");
}

async function handleDownloadAnalyticsAdminJson(request, env, url) {
  const auth = requireAdmin(request, env);
  if (auth) return auth;

  const days = clampNumber(url.searchParams.get("days"), 1, 365, 30);
  const limit = clampNumber(url.searchParams.get("limit"), 1, 5000, 5000);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const eventsResult = await env.RELAYHUB_DB.prepare(
    `SELECT
       e.*,
       r.document_id,
       r.document_title,
       r.document_version,
       r.source_object,
       r.email,
       r.name,
       r.licence_number,
       r.generated_object
     FROM download_events e
     LEFT JOIN download_registry r ON r.id = e.registry_id
     WHERE e.event_at >= ?
     ORDER BY e.event_at DESC
     LIMIT ?`
  )
    .bind(since, limit)
    .all();

  const events = eventsResult.results || [];

  const summary = {
    requests: 0,
    downloads: 0,
    failures: 0,
    bytes: 0,
    avg_duration_ms: 0,
  };

  const documentMap = new Map();
  const errorMap = new Map();
  const outcomeMap = new Map();
  const contentTypeMap = new Map();
  const dailyMap = new Map();
  const countryMap = new Map();
  const sourceMap = new Map();
  const referrerMap = new Map();

  let durationTotal = 0;
  let durationCount = 0;

  for (const event of events) {
    const metadata = safeJsonParse(event.metadata) || {};

    const eventType = String(event.event_type || "unknown");
    const statusCode = Number(metadata.statusCode || metadata.status_code || 0);
    const outcome = String(metadata.outcome || eventType || "unknown");

    const documentKey =
      metadata.key ||
      metadata.document ||
      event.source_object ||
      event.document_id ||
      event.registry_id ||
      "unknown";

    const contentType =
      metadata.contentType ||
      metadata.content_type ||
      "unknown";

    const bytes = Number(metadata.size || metadata.bytes || 0);
    const durationMs = Number(metadata.durationMs || metadata.duration_ms || metadata.elapsedMs || 0);

    const country = String(metadata.country || "unknown");
    const source = String(metadata.source || metadata.utm_source || "unknown");
    const campaign = String(metadata.campaign || metadata.utm_campaign || "none");
    const referrer = String(metadata.referrer || "direct/unknown");

    const isDownload =
      eventType === "downloaded" ||
      eventType === "success" ||
      outcome === "success" ||
      statusCode === 200;

    const isFailure =
      eventType.includes("fail") ||
      eventType.includes("error") ||
      eventType === "expired" ||
      outcome.includes("fail") ||
      outcome.includes("error") ||
      (statusCode >= 400 && statusCode < 600);

    summary.requests += 1;

    if (isDownload) {
      summary.downloads += 1;
    }

    if (isFailure) {
      summary.failures += 1;
    }

    summary.bytes += bytes;

    if (durationMs > 0) {
      durationTotal += durationMs;
      durationCount += 1;
    }

    const docRow = documentMap.get(documentKey) || {
      document: documentKey,
      downloads: 0,
      failures: 0,
      bytes: 0,
      avg_duration_ms: 0,
      _durationTotal: 0,
      _durationCount: 0,
    };

    if (isDownload) docRow.downloads += 1;
    if (isFailure) docRow.failures += 1;
    docRow.bytes += bytes;

    if (durationMs > 0) {
      docRow._durationTotal += durationMs;
      docRow._durationCount += 1;
      docRow.avg_duration_ms = docRow._durationTotal / docRow._durationCount;
    }

    documentMap.set(documentKey, docRow);

    if (isFailure) {
      const errorKey = `${documentKey}|${outcome}|${statusCode || "unknown"}`;
      const errorRow = errorMap.get(errorKey) || {
        document: documentKey,
        outcome,
        status_code: statusCode || "",
        failures: 0,
      };
      errorRow.failures += 1;
      errorMap.set(errorKey, errorRow);
    }

    const outcomeKey = `${outcome}|${statusCode || "unknown"}`;
    const outcomeRow = outcomeMap.get(outcomeKey) || {
      outcome,
      status_code: statusCode || "",
      requests: 0,
    };
    outcomeRow.requests += 1;
    outcomeMap.set(outcomeKey, outcomeRow);

    const contentTypeRow = contentTypeMap.get(contentType) || {
      content_type: contentType,
      requests: 0,
      downloads: 0,
      failures: 0,
    };
    contentTypeRow.requests += 1;
    if (isDownload) contentTypeRow.downloads += 1;
    if (isFailure) contentTypeRow.failures += 1;
    contentTypeMap.set(contentType, contentTypeRow);

    const day = normaliseAnalyticsDay(event.event_at);
    const dayRow = dailyMap.get(day) || {
      day,
      requests: 0,
      downloads: 0,
      failures: 0,
    };
    dayRow.requests += 1;
    if (isDownload) dayRow.downloads += 1;
    if (isFailure) dayRow.failures += 1;
    dailyMap.set(day, dayRow);

    const countryRow = countryMap.get(country) || {
      country,
      downloads: 0,
      failures: 0,
    };
    if (isDownload) countryRow.downloads += 1;
    if (isFailure) countryRow.failures += 1;
    countryMap.set(country, countryRow);

    const sourceKey = `${source}|${campaign}`;
    const sourceRow = sourceMap.get(sourceKey) || {
      source,
      campaign,
      downloads: 0,
      failures: 0,
    };
    if (isDownload) sourceRow.downloads += 1;
    if (isFailure) sourceRow.failures += 1;
    sourceMap.set(sourceKey, sourceRow);

    const referrerRow = referrerMap.get(referrer) || {
      referrer,
      downloads: 0,
      failures: 0,
    };
    if (isDownload) referrerRow.downloads += 1;
    if (isFailure) referrerRow.failures += 1;
    referrerMap.set(referrer, referrerRow);
  }

  summary.avg_duration_ms =
    durationCount > 0 ? durationTotal / durationCount : 0;

  const documents = Array.from(documentMap.values())
    .map((row) => {
      const cleaned = { ...row };
      delete cleaned._durationTotal;
      delete cleaned._durationCount;
      return cleaned;
    })
    .sort((a, b) => Number(b.downloads || 0) - Number(a.downloads || 0));

  const response = {
    ok: true,
    days,
    summary,

    documents,
    errors: Array.from(errorMap.values())
      .sort((a, b) => Number(b.failures || 0) - Number(a.failures || 0)),

    outcomes: Array.from(outcomeMap.values())
      .sort((a, b) => Number(b.requests || 0) - Number(a.requests || 0)),

    contentTypes: Array.from(contentTypeMap.values())
      .sort((a, b) => Number(b.requests || 0) - Number(a.requests || 0)),

    daily: Array.from(dailyMap.values())
      .sort((a, b) => String(a.day).localeCompare(String(b.day))),

    countries: Array.from(countryMap.values())
      .sort((a, b) => Number(b.downloads || 0) - Number(a.downloads || 0)),

    sources: Array.from(sourceMap.values())
      .sort((a, b) => Number(b.downloads || 0) - Number(a.downloads || 0)),

    referrers: Array.from(referrerMap.values())
      .sort((a, b) => Number(b.downloads || 0) - Number(a.downloads || 0)),

    // Backward-compatible simple data for any newer/simple page.
    rows: events,
  };

  return jsonResponse(response);
}

// ============================================================
// Analytics
// ============================================================

function recordDownloadAnalytics(request, env, url, event) {
  try {
    const analytics = env.DOWNLOAD_ANALYTICS || env.RELAYHUB_ANALYTICS;

    if (!analytics) return;

    const elapsedMs = Date.now() - Number(event.started || Date.now());
    const cf = request.cf || {};

    analytics.writeDataPoint({
      blobs: [
        event.key || "",
        event.outcome || "",
        event.contentType || "",
        request.headers.get("user-agent") || "",
        cf.country || "",
        cf.asOrganization || "",
        url.pathname,
      ],
      doubles: [
        Number(event.statusCode || 0),
        Number(event.size || 0),
        Number(elapsedMs || 0),
      ],
      indexes: [
        event.key || "unknown",
      ],
    });
  } catch (error) {
    console.error("Analytics write failed:", error);
  }
}

// ============================================================
// Email helpers
// ============================================================

function buildRawEmail({ from, to, subject, body }) {
  const safeSubject = String(subject || "RelayHub notification")
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .trim();

  const safeFrom = String(from || EMAIL_FROM)
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim();

  const safeTo = String(to || EMAIL_TO)
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim();

  const plainBody = String(body || "");

  return [
    `From: RelayHub <${safeFrom}>`,
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plainBody,
  ].join("\r\n");
}

async function sendInternalEmail(env, { subject, body }) {
  if (!env.RELAYHUB_EMAIL) {
    console.warn("RELAYHUB_EMAIL binding is missing.");
    return { ok: false, reason: "email_binding_missing" };
  }

  try {
    const rawEmail = buildRawEmail({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: subject || "RelayHub notification",
      body: body || "",
    });

    const message = new EmailMessage(
      EMAIL_FROM,
      EMAIL_TO,
      rawEmail
    );

    await env.RELAYHUB_EMAIL.send(message);

    return { ok: true };
  } catch (error) {
    console.error("Internal email send failed:", error);
    return {
      ok: false,
      reason: error?.message || "email_send_failed",
    };
  }
}

// ============================================================
// Shared helpers
// ============================================================

async function readFormOrJson(request) {
  const contentType = request.headers.get("content-type") || "";

  try {
    if (contentType.includes("application/json")) {
      return {
        ok: true,
        data: await request.json(),
      };
    }

    const formData = await request.formData();
    const data = {};

    for (const [key, value] of formData.entries()) {
      data[key] = typeof value === "string" ? value : value.name;
    }

    return {
      ok: true,
      data,
    };
  } catch (error) {
    console.error("Body parse failed:", error);
    return {
      ok: false,
      data: {},
    };
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function csvResponse(rows, filename) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const headers = Array.from(
    safeRows.reduce((set, row) => {
      Object.keys(row || {}).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );

  const csv = [
    headers.join(","),
    ...safeRows.map((row) =>
      headers.map((header) => csvEscape(row?.[header])).join(",")
    ),
  ].join("\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function methodNotAllowed(methods) {
  return textResponse("Method Not Allowed", 405, {
    allow: methods,
  });
}

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function getEmailDomain(email) {
  const normalised = normaliseEmail(email);
  const parts = normalised.split("@");
  return parts.length === 2 ? parts[1] : "";
}

function cleanField(value, maxLength = 500) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function filenameFromKey(key) {
  const parts = String(key).split("/");
  return safeDownloadFilename(parts[parts.length - 1] || "download");
}

function safeDownloadFilename(filename) {
  return String(filename || "download")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

function guessContentType(key) {
  const lower = String(key).toLowerCase();

  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".sha256")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".sig")) return "application/octet-stream";

  return "application/octet-stream";
}

function randomToken(byteLength = 32) {
  return base64UrlRandom(byteLength);
}

function cryptoRandomHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomId(prefix) {
  return `${prefix}_${cryptoRandomHex(16)}`;
}

function base64UrlRandom(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function secureHash(value) {
  const encoded = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256ArrayBuffer(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function getRequestIpHash(request, env) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "";

  if (!ip) return null;

  const secret =
    env.CDAS_IP_HASH_SECRET ||
    env.IP_HASH_SECRET ||
    env.CDAS_TOKEN_SECRET ||
    "dev-only-ip-hash-secret";

  return secureHash(`${secret}:${ip}`);
}

function requireAdmin(request, env) {
  const candidates = [
    env.ADMIN_API_TOKEN,
    env.ADMIN_TOKEN,
    env.DOWNLOAD_ADMIN_TOKEN,
    env.RELAYHUB_ADMIN_TOKEN,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim());

  if (candidates.length === 0) {
    return jsonResponse({ ok: false, error: "Admin token is not configured." }, 500);
  }

  const auth = request.headers.get("authorization") || "";
  const bearerToken = auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length).trim()
    : "";

  const headerToken = (request.headers.get("x-admin-token") || "").trim();

  const supplied = bearerToken || headerToken;

  if (!supplied || !candidates.includes(supplied.trim())) {
    return jsonResponse({ ok: false, error: "Unauthorized." }, 401, {
      "www-authenticate": "Bearer",
    });
  }

  return null;
}

function getAdminIdentity(request, env) {
  const configured = env.ADMIN_IDENTITY || "relayhub-admin";
  const header = cleanField(request.headers.get("x-admin-identity"), 120);
  return header || configured;
}

function extractAdminPathId(pathname, prefix, suffix) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return "";
  return decodeURIComponent(pathname.slice(prefix.length, pathname.length - suffix.length));
}

function safeJsonParse(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normaliseAnalyticsDay(value) {
  if (!value) return "unknown";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value).slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

export {
  handleCdasRequestAccess,
  handleCdasVerify,
  handleCdasDownload,
  handleCdasLicenceVerify,

  handleCdasAdminDocuments,
  handleCdasAdminRequests,
  handleCdasAdminLicences,
  handleCdasAdminDownloads,
  handleCdasAdminLicenceTerms,
  handleCdasAdminAudit,
  handleCdasAdminRevokeLicence,
  handleCdasAdminReissueLink,

  handleDownload,
  handleFreeDownloadPost,
  handlePersonalisedDownload,
  handleDownloadRegistryAdminJson,

  handleEarlyAccessPost,
  handleContactPost,

  handleDownloadAnalyticsAdminJson,

  handleNewsletterAdminJson,
  handleNewsletterAdminCsv,
  handleContactAdminJson,
  handleContactAdminCsv,

  methodNotAllowed,
  textResponse
  };
