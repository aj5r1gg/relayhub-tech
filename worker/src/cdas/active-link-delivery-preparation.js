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

async function sha256HexFromText(text) {
  const encoded = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

function buildId(prefix) {
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  const suffix = [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now().toString(36)}_${suffix}`;
}

function getUserAgent(request) {
  return cleanText(request.headers.get("User-Agent")).slice(0, 500);
}

async function first(env, sql, bindings = []) {
  return await env.RELAYHUB_DB.prepare(sql)
    .bind(...bindings)
    .first();
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

function getPublicBaseUrl(env, request) {
  const configured = cleanText(env.CDAS_PUBLIC_BASE_URL).replace(/\/+$/, "");

  if (configured) return configured;

  const url = new URL(request.url);
  return url.origin.replace(/\/+$/, "");
}

function isExpired(expiresAt) {
  const text = cleanText(expiresAt);

  if (!text) return true;

  const time = Date.parse(text);

  if (!Number.isFinite(time)) return true;

  return time <= Date.now();
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function extractTokenFromLandingUrl(value) {
  const raw = cleanText(value);

  if (!raw) return "";

  /*
   * Accept either:
   * - the raw token: rh_dl_...
   * - the landing URL: https://www.relayhub.tech/document-download/rh_dl_...
   * - the API URL: https://www.relayhub.tech/api/document-download/rh_dl_...
   */
  if (raw.startsWith("rh_dl_")) {
    return raw;
  }

  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    const token = parts.at(-1) || "";
    return token.startsWith("rh_dl_") ? token : "";
  } catch {
    return "";
  }
}

function buildLandingUrl(request, env, token) {
  const baseUrl = getPublicBaseUrl(env, request);
  return `${baseUrl}/document-download/${encodeURIComponent(token)}`;
}

function buildSubject(documentTitle) {
  return `Your RelayHub download is ready: ${documentTitle}`;
}

function buildTextBody(payload) {
  return [
    "Your RelayHub download is ready",
    "",
    `Document: ${payload.document_title}`,
    `Licence: ${payload.licence_number}`,
    `Download reference: ${payload.download_reference}`,
    "",
    "Download link:",
    payload.landing_url,
    "",
    `This link expires at: ${payload.expires_at}`,
    "",
    "This controlled link is intended only for the licensed recipient. It may be single-use, time-limited, and auditable.",
    "",
    "RelayHub",
  ].join("\n");
}

function buildHtmlBody(payload) {
  const title = escapeHtml(payload.document_title);
  const licenceNumber = escapeHtml(payload.licence_number);
  const downloadReference = escapeHtml(payload.download_reference);
  const landingUrl = escapeHtml(payload.landing_url);
  const expiresAt = escapeHtml(payload.expires_at);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Your RelayHub download is ready</title>
  </head>
  <body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 8px;color:#0284c7;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">
                  RelayHub Document Access
                </p>
                <h1 style="margin:0;color:#0f172a;font-size:28px;line-height:1.15;">
                  Your download is ready
                </h1>
                <p style="margin:16px 0 0;color:#475569;font-size:16px;line-height:1.6;">
                  Your controlled RelayHub document download is ready.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Document</p>
                      <p style="margin:0;color:#0f172a;font-size:16px;font-weight:700;">${title}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Licence</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${licenceNumber}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Download reference</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${downloadReference}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Expires</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${expiresAt}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;">
                <a href="${landingUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;padding:14px 20px;">
                  Open download page
                </a>
                <p style="margin:18px 0 0;color:#64748b;font-size:14px;line-height:1.6;">
                  If the button does not work, copy and paste this link into your browser:
                </p>
                <p style="margin:8px 0 0;color:#334155;font-size:13px;line-height:1.6;word-break:break-all;">
                  ${landingUrl}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px 28px;color:#64748b;font-size:13px;line-height:1.6;">
                This controlled link is intended only for the licensed recipient. It may be single-use, time-limited, and auditable.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function getDownloadLink(env, downloadLinkIdOrReference) {
  const ref = cleanText(downloadLinkIdOrReference);

  if (!ref) return null;

  return await first(
    env,
    `SELECT *
     FROM document_download_links
     WHERE id = ?
        OR download_reference = ?
     LIMIT 1`,
    [ref, ref]
  );
}

async function getLicence(env, licenceId) {
  const id = cleanText(licenceId);

  if (!id) return null;

  return await first(
    env,
    `SELECT *
     FROM document_licences
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
}

async function getDocument(env, documentId, version) {
  const id = cleanText(documentId);
  const docVersion = cleanText(version);

  if (!id || !docVersion) return null;

  return await first(
    env,
    `SELECT *
     FROM documents
     WHERE id = ?
       AND version = ?
     LIMIT 1`,
    [id, docVersion]
  );
}

async function getGeneratedPdfHead(env, objectKey) {
  const key = cleanText(objectKey).replace(/^\/+/, "");

  if (!key) return null;

  try {
    return await env.RELAYHUB_DOWNLOADS.head(key);
  } catch {
    return null;
  }
}

async function countPriorDeliveryEvents(env, downloadId) {
  const row = await first(
    env,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN event_type = 'active_link_delivery_prepared' AND success = 1 THEN 1 ELSE 0 END) AS prepared_success,
       SUM(CASE WHEN event_type = 'active_link_delivery_email_sent' AND success = 1 THEN 1 ELSE 0 END) AS email_sent_success
     FROM document_download_events
     WHERE download_id = ?`,
    [downloadId]
  );

  return {
    total: Number(row?.total || 0),
    prepared_success: Number(row?.prepared_success || 0),
    email_sent_success: Number(row?.email_sent_success || 0),
  };
}

async function verifyTokenMatchesLink(link, suppliedLandingUrlOrToken) {
  const token = extractTokenFromLandingUrl(suppliedLandingUrlOrToken);

  if (!token) {
    return {
      ok: false,
      token: "",
      token_hash_matches: false,
      reason: "landing_url_or_token_missing_or_invalid",
    };
  }

  const tokenHash = await sha256HexFromText(token);

  return {
    ok: tokenHash === link.token_hash,
    token,
    token_hash_matches: tokenHash === link.token_hash,
    reason: tokenHash === link.token_hash ? null : "token_hash_mismatch",
  };
}

function evaluateDeliveryGate({
  link,
  licence,
  document,
  generatedPdfHead,
  priorDeliveryCounts,
  tokenVerification,
}) {
  const blockers = [];
  const warnings = [];

  if (!link) {
    blockers.push("download_link_not_found");
    return { blockers, warnings };
  }

  if (link.status !== "active") {
    blockers.push(`download_link_status_${link.status || "missing"}`);
  }

  if (!link.activated_at) {
    blockers.push("download_link_not_activated");
  }

  if (!link.expires_at) {
    blockers.push("download_link_expires_at_missing");
  } else if (isExpired(link.expires_at)) {
    blockers.push("download_link_expired");
  }

  if (link.used_at) {
    blockers.push("download_link_already_used");
  }

  if (link.revoked_at) {
    blockers.push("download_link_revoked");
  }

  if (link.superseded_at) {
    blockers.push("download_link_superseded");
  }

  if (!link.token_hash) {
    blockers.push("download_link_token_hash_missing");
  }

  if (!tokenVerification?.token_hash_matches) {
    blockers.push(tokenVerification?.reason || "token_hash_mismatch");
  }

  if (!link.generated_pdf_object_key) {
    blockers.push("generated_pdf_object_key_missing_on_link");
  }

  if (!link.generated_pdf_sha256) {
    blockers.push("generated_pdf_sha256_missing_on_link");
  }

  if (!link.generated_pdf_size_bytes || Number(link.generated_pdf_size_bytes) <= 0) {
    blockers.push("generated_pdf_size_missing_on_link");
  }

  if (!link.generated_pdf_created_at) {
    blockers.push("generated_pdf_created_at_missing_on_link");
  }

  if (!generatedPdfHead) {
    blockers.push("generated_pdf_r2_object_missing");
  } else if (
    link.generated_pdf_size_bytes &&
    Number(generatedPdfHead.size || 0) !== Number(link.generated_pdf_size_bytes)
  ) {
    blockers.push("generated_pdf_r2_size_mismatch");
  }

  if (!licence) {
    blockers.push("licence_not_found_for_download_link");
  } else {
    if (licence.status !== "issued") {
      blockers.push(`licence_status_${licence.status || "missing"}`);
    }

    if (licence.revoked_at || licence.revoked_by || licence.status === "revoked") {
      blockers.push("licence_revoked");
    }

    if (licence.superseded_by) {
      blockers.push("licence_superseded");
    }

    if (licence.confirmed_leak_at) {
      blockers.push("confirmed_leak_recorded");
    }

    if (licence.suspected_leak_at) {
      warnings.push("suspected_leak_recorded");
    }

    if (!normaliseEmail(licence.licence_holder_email_normalised || licence.licence_holder_email)) {
      blockers.push("recipient_email_missing");
    }

    if (licence.document_id !== link.document_id) {
      blockers.push("download_link_document_id_mismatch");
    }

    if (licence.generated_pdf_object_key !== link.generated_pdf_object_key) {
      blockers.push("generated_pdf_object_key_mismatch");
    }

    if (licence.generated_pdf_sha256 !== link.generated_pdf_sha256) {
      blockers.push("generated_pdf_sha256_mismatch");
    }

    if (
      Number(licence.generated_pdf_size_bytes || 0) !==
      Number(link.generated_pdf_size_bytes || 0)
    ) {
      blockers.push("generated_pdf_size_mismatch");
    }
  }

  if (!document) {
    blockers.push("document_not_found");
  } else if (document.status !== "active") {
    blockers.push(`document_status_${document.status || "missing"}`);
  }

  if (priorDeliveryCounts.email_sent_success > 0) {
    blockers.push("download_link_email_already_sent");
  }

  if (priorDeliveryCounts.prepared_success > 0) {
    warnings.push("delivery_preparation_already_recorded");
  }

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
  };
}

async function recordDownloadEvent({
  env,
  request,
  link,
  licence,
  eventType,
  success = 1,
  failureReason = null,
}) {
  try {
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
        buildId("dde"),
        link.id,
        licence.id,
        licence.licence_number,
        licence.document_id,
        licence.document_version,
        licence.licence_holder_name || null,
        licence.organisation_name || null,
        licence.licence_holder_email_normalised || licence.licence_holder_email,
        eventType,
        nowIso(),
        ipHash,
        getUserAgent(request),
        link.generated_pdf_object_key || null,
        licence.source_object || null,
        licence.source_sha256 || null,
        link.generated_pdf_sha256 || licence.generated_pdf_sha256 || null,
        licence.rendered_licence_sha256 || null,
        null,
        null,
        null,
        licence.licence_terms_version || null,
        null,
        licence.licence_terms_version || null,
        success ? 1 : 0,
        failureReason ? cleanText(failureReason).slice(0, 1000) : null
      )
      .run();
  } catch {
    // Event logging must not make delivery preparation unrecoverable.
  }
}

export async function evaluateCdasActiveLinkDeliveryEligibility(
  env,
  request,
  downloadLinkIdOrReference,
  suppliedLandingUrlOrToken = "",
) {
  const ref = cleanText(downloadLinkIdOrReference);
  const link = await getDownloadLink(env, ref);

  if (!link) {
    return {
      ok: false,
      eligible: false,
      decision: "blocked",
      download_link_id: ref,
      blockers: ["download_link_not_found"],
      warnings: [],
      safety: {
        email_sent: false,
        pdf_served: false,
        link_consumed: false,
      },
    };
  }

  const licence = await getLicence(env, link.licence_id);
  const [document, generatedPdfHead, priorDeliveryCounts, tokenVerification] =
    await Promise.all([
      licence ? getDocument(env, licence.document_id, licence.document_version) : null,
      getGeneratedPdfHead(env, link.generated_pdf_object_key),
      countPriorDeliveryEvents(env, link.id),
      verifyTokenMatchesLink(link, suppliedLandingUrlOrToken),
    ]);

  const gate = evaluateDeliveryGate({
    link,
    licence,
    document,
    generatedPdfHead,
    priorDeliveryCounts,
    tokenVerification,
  });

  const eligible = gate.blockers.length === 0;
  const token = tokenVerification.token || "";

  return {
    ok: true,
    eligible,
    decision: eligible ? "eligible_for_active_link_delivery_preparation" : "blocked",
    blockers: gate.blockers,
    warnings: gate.warnings,
    counts: {
      delivery_events_total: priorDeliveryCounts.total,
      delivery_prepared_success: priorDeliveryCounts.prepared_success,
      email_sent_success: priorDeliveryCounts.email_sent_success,
    },
    download_link: {
      id: link.id,
      download_reference: link.download_reference,
      status: link.status,
      created_at: link.created_at,
      activated_at: link.activated_at,
      expires_at: link.expires_at,
      used_at: link.used_at,
      revoked_at: link.revoked_at,
      superseded_at: link.superseded_at,
      generated_pdf_object_key: link.generated_pdf_object_key,
      generated_pdf_sha256: link.generated_pdf_sha256,
      generated_pdf_size_bytes: link.generated_pdf_size_bytes,
      generated_pdf_created_at: link.generated_pdf_created_at,
    },
    licence: licence
      ? {
          id: licence.id,
          licence_number: licence.licence_number,
          status: licence.status,
          document_id: licence.document_id,
          document_version: licence.document_version,
          licence_holder_name: licence.licence_holder_name,
          recipient_email:
            licence.licence_holder_email_normalised || licence.licence_holder_email,
        }
      : null,
    document: document
      ? {
          id: document.id,
          title: document.title,
          version: document.version,
          status: document.status,
        }
      : null,
    generated_pdf_object: generatedPdfHead
      ? {
          exists: true,
          size: generatedPdfHead.size || null,
          uploaded: generatedPdfHead.uploaded || null,
          http_etag: generatedPdfHead.httpEtag || null,
        }
      : {
          exists: false,
        },
    supplied_token: {
      provided: Boolean(token),
      token_hash_matches: Boolean(tokenVerification.token_hash_matches),
      raw_token_returned: false,
    },
    prepared_delivery: eligible
      ? {
          recipient_email:
            licence.licence_holder_email_normalised || licence.licence_holder_email,
          subject: buildSubject(document?.title || licence.document_id || "RelayHub document"),
          landing_url: buildLandingUrl(request, env, token),
          expires_at: link.expires_at,
        }
      : null,
    next_allowed_action: eligible ? "prepare_active_link_delivery_payload" : null,
    safety: {
      email_sent: false,
      pdf_served: false,
      link_consumed: false,
    },
  };
}

export async function getCdasActiveLinkDeliveryEligibility(
  request,
  env,
  downloadLinkIdOrReference,
) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to evaluate active-link delivery eligibility.",
      },
      405
    );
  }

  const url = new URL(request.url);
  const supplied =
    cleanText(url.searchParams.get("landing_url")) ||
    cleanText(url.searchParams.get("token")) ||
    cleanText(url.searchParams.get("download_url"));

  const result = await evaluateCdasActiveLinkDeliveryEligibility(
    env,
    request,
    downloadLinkIdOrReference,
    supplied
  );

  if (result.blockers?.includes("download_link_not_found")) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS download link was not found.",
        download_link_id: cleanText(downloadLinkIdOrReference),
      },
      404
    );
  }

  return jsonResponse(result);
}

export async function prepareCdasActiveLinkDelivery(
  request,
  env,
  downloadLinkIdOrReference,
) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to prepare active-link delivery.",
      },
      405
    );
  }

  const body = await readOptionalJson(request);

  const supplied =
    cleanText(body.landing_url) ||
    cleanText(body.download_url) ||
    cleanText(body.url) ||
    cleanText(body.token);

  const eligibility = await evaluateCdasActiveLinkDeliveryEligibility(
    env,
    request,
    downloadLinkIdOrReference,
    supplied
  );

  if (!eligibility.download_link) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        message: "CDAS download link was not found.",
      },
      404
    );
  }

  if (!eligibility.eligible) {
    if (eligibility.licence && eligibility.download_link) {
      await recordDownloadEvent({
        env,
        request,
        link: eligibility.download_link,
        licence: eligibility.licence,
        eventType: "active_link_delivery_preparation_blocked",
        success: 0,
        failureReason: eligibility.blockers.join(","),
      });
    }

    return jsonResponse(
      {
        ok: false,
        error: "active_link_delivery_preparation_blocked",
        message:
          "Active download-link delivery was not prepared because the delivery gate did not pass.",
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        counts: eligibility.counts,
        safety: {
          email_sent: false,
          pdf_served: false,
          link_consumed: false,
        },
      },
      409
    );
  }

  const payload = {
    recipient_email: eligibility.prepared_delivery.recipient_email,
    subject: eligibility.prepared_delivery.subject,
    landing_url: eligibility.prepared_delivery.landing_url,
    expires_at: eligibility.prepared_delivery.expires_at,
    document_title: eligibility.document?.title || eligibility.licence.document_id,
    document_id: eligibility.licence.document_id,
    document_version: eligibility.licence.document_version,
    licence_number: eligibility.licence.licence_number,
    download_reference: eligibility.download_link.download_reference,
  };

  await recordDownloadEvent({
    env,
    request,
    link: eligibility.download_link,
    licence: eligibility.licence,
    eventType: "active_link_delivery_prepared",
    success: 1,
    failureReason: cleanText(body.note || "3X-0P active-link delivery prepared"),
  });

  return jsonResponse({
    ok: true,
    prepared: true,
    emailed: false,
    served: false,
    consumed: false,
    action: "prepare_active_link_delivery",
    delivery_payload: {
      to: payload.recipient_email,
      subject: payload.subject,
      text: buildTextBody(payload),
      html: buildHtmlBody(payload),
    },
    download_link: eligibility.download_link,
    licence: eligibility.licence,
    document: eligibility.document,
    controls: {
      verifies_active_download_link: true,
      verifies_raw_token_against_stored_hash: true,
      returns_email_payload: true,
      sends_email: false,
      serves_pdf: false,
      consumes_link: false,
      exposes_token_hash: false,
      exposes_raw_r2_url: false,
    },
    next_step: {
      phase: "3X-0Q",
      action: "controlled_email_send",
      note:
        "This prepared payload may be used by the next phase to send email. This action did not send it.",
    },
    safety: {
      email_sent: false,
      pdf_served: false,
      link_consumed: false,
    },
    message:
      "Active download-link delivery payload was prepared. No email was sent and no PDF was served.",
  });
}
