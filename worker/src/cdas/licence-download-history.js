import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bool(value) {
  return Boolean(value);
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
  const id = cleanText(documentId);

  if (!id) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM documents
     WHERE id = ?
     LIMIT 1`
  )
    .bind(id)
    .first();
}

async function getDownloadLinks(env, licenceId) {
  const result = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       download_reference,
       licence_id,
       document_id,
       status,
       created_at,
       activated_at,
       used_at,
       expires_at,
       revoked_at,
       superseded_at,
       failure_reason,
       ip_hash,
       user_agent,
       generated_pdf_object_key,
       generated_pdf_sha256,
       generated_pdf_size_bytes,
       generated_pdf_created_at
     FROM document_download_links
     WHERE licence_id = ?
     ORDER BY created_at DESC`
  )
    .bind(licenceId)
    .all();

  return result?.results || [];
}

async function getEmailEvents(env, licence) {
  const licenceId = cleanText(licence?.id);
  const licenceNumber = cleanText(licence?.licence_number);

  if (!licenceId && !licenceNumber) return [];

  const result = await env.RELAYHUB_DB.prepare(
    `SELECT
       id,
       related_type,
       related_id,
       email_type,
       recipient_email,
       provider,
       provider_message_id,
       status,
       error,
       message,
       subject,
       created_at,
       metadata_json,
       retry_of_event_id,
       retry_count,
       retryable,
       next_retry_after,
       resolved_at,
       resolved_by,
       resolution_note
     FROM cdas_email_events
     WHERE related_id = ?
        OR metadata_json LIKE ?
     ORDER BY created_at DESC
     LIMIT 100`
  )
    .bind(licenceId, `%${licenceNumber}%`)
    .all();

  return (result?.results || []).map((row) => ({
    ...row,
    metadata: safeJsonParse(row.metadata_json, {}),
  }));
}

async function getDownloadEvents(env, licenceId) {
  const result = await env.RELAYHUB_DB.prepare(
    `SELECT
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
     FROM document_download_events
     WHERE licence_id = ?
     ORDER BY event_at DESC
     LIMIT 100`
  )
    .bind(licenceId)
    .all();

  return result?.results || [];
}

async function getAdminAuditEvents(env, licence) {
  const licenceId = cleanText(licence?.id);
  const licenceNumber = cleanText(licence?.licence_number);

  if (!licenceId && !licenceNumber) return [];

  const result = await env.RELAYHUB_DB.prepare(
    `SELECT
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
     FROM admin_audit_events
     WHERE target_id = ?
        OR before_json LIKE ?
        OR after_json LIKE ?
     ORDER BY created_at DESC
     LIMIT 100`
  )
    .bind(licenceId, `%${licenceNumber}%`, `%${licenceNumber}%`)
    .all();

  return (result?.results || []).map((row) => ({
    ...row,
    before: safeJsonParse(row.before_json, null),
    after: safeJsonParse(row.after_json, null),
  }));
}

function downloadLinkHasGeneratedEvidence(link) {
  return Boolean(
    link.generated_pdf_object_key &&
      link.generated_pdf_sha256 &&
      link.generated_pdf_size_bytes
  );
}

function isExpired(link, now = nowIso()) {
  if (!link.expires_at) return false;

  return Date.parse(link.expires_at) <= Date.parse(now);
}

function classifyLink(link) {
  if (!link) return "unknown";

  if (link.status === "active" && !link.used_at && !isExpired(link)) {
    return "active_unused";
  }

  if (link.status === "pending_generation") {
    return "pending_generation";
  }

  if (link.status === "used" || link.used_at) {
    return "used";
  }

  if (link.status === "failed") {
    return "failed";
  }

  if (link.status === "revoked" || link.revoked_at) {
    return "revoked";
  }

  if (link.status === "superseded" || link.superseded_at) {
    return "superseded";
  }

  if (isExpired(link)) {
    return "expired";
  }

  return link.status || "unknown";
}

function summariseLinks(links) {
  const summary = {
    total: links.length,
    active_unused: 0,
    pending_generation: 0,
    used: 0,
    failed: 0,
    revoked: 0,
    superseded: 0,
    expired: 0,
    with_generated_pdf_evidence: 0,
    without_generated_pdf_evidence: 0,
    latest_download_reference: null,
    latest_status: null,
  };

  for (const link of links) {
    const classification = classifyLink(link);

    if (Object.prototype.hasOwnProperty.call(summary, classification)) {
      summary[classification] += 1;
    }

    if (downloadLinkHasGeneratedEvidence(link)) {
      summary.with_generated_pdf_evidence += 1;
    } else {
      summary.without_generated_pdf_evidence += 1;
    }
  }

  if (links[0]) {
    summary.latest_download_reference = links[0].download_reference || null;
    summary.latest_status = links[0].status || null;
  }

  return summary;
}

function summariseEmailEvents(emailEvents) {
  const summary = {
    total: emailEvents.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    retryable: 0,
    latest_status: null,
    latest_provider_message_id: null,
    latest_email_type: null,
  };

  for (const event of emailEvents) {
    const status = cleanText(event.status).toLowerCase();

    if (status === "sent") summary.sent += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "skipped") summary.skipped += 1;

    if (Number(event.retryable || 0) > 0) {
      summary.retryable += 1;
    }
  }

  if (emailEvents[0]) {
    summary.latest_status = emailEvents[0].status || null;
    summary.latest_provider_message_id = emailEvents[0].provider_message_id || null;
    summary.latest_email_type = emailEvents[0].email_type || null;
  }

  return summary;
}

function findMatchingEmailEvents(link, emailEvents) {
  const linkId = cleanText(link.id);
  const downloadReference = cleanText(link.download_reference);

  return emailEvents.filter((event) => {
    const metadata = event.metadata || {};

    return (
      cleanText(metadata.download_link_id) === linkId ||
      cleanText(metadata.download_reference) === downloadReference ||
      cleanText(metadata.download_id) === linkId
    );
  });
}

function buildTimeline({ links, emailEvents, downloadEvents, adminAuditEvents }) {
  const items = [];

  for (const link of links) {
    items.push({
      type: "download_link",
      at: link.created_at,
      id: link.id,
      download_reference: link.download_reference,
      status: link.status,
      label: `Download link ${link.download_reference || link.id} created`,
      evidence: {
        generated_pdf_object_key: link.generated_pdf_object_key,
        generated_pdf_sha256: link.generated_pdf_sha256,
        generated_pdf_size_bytes: link.generated_pdf_size_bytes,
      },
    });

    if (link.activated_at) {
      items.push({
        type: "download_link_activated",
        at: link.activated_at,
        id: link.id,
        download_reference: link.download_reference,
        status: "active",
        label: `Download link ${link.download_reference || link.id} activated`,
      });
    }

    if (link.used_at) {
      items.push({
        type: "download_link_used",
        at: link.used_at,
        id: link.id,
        download_reference: link.download_reference,
        status: "used",
        label: `Download link ${link.download_reference || link.id} used`,
      });
    }

    if (link.revoked_at) {
      items.push({
        type: "download_link_revoked",
        at: link.revoked_at,
        id: link.id,
        download_reference: link.download_reference,
        status: "revoked",
        label: `Download link ${link.download_reference || link.id} revoked`,
      });
    }

    if (link.superseded_at) {
      items.push({
        type: "download_link_superseded",
        at: link.superseded_at,
        id: link.id,
        download_reference: link.download_reference,
        status: "superseded",
        label: `Download link ${link.download_reference || link.id} superseded`,
      });
    }
  }

  for (const event of emailEvents) {
    items.push({
      type: "email_event",
      at: event.created_at,
      id: event.id,
      email_type: event.email_type,
      status: event.status,
      provider_message_id: event.provider_message_id,
      label: `${event.email_type} email ${event.status}`,
    });
  }

  for (const event of downloadEvents) {
    items.push({
      type: "download_event",
      at: event.event_at,
      id: event.id,
      download_id: event.download_id,
      event_type: event.event_type,
      success: Boolean(event.success),
      label: `${event.event_type} ${event.success ? "succeeded" : "failed"}`,
    });
  }

  for (const event of adminAuditEvents) {
    items.push({
      type: "admin_audit_event",
      at: event.created_at,
      id: event.id,
      action: event.action,
      target_type: event.target_type,
      target_id: event.target_id,
      label: `Admin action: ${event.action}`,
    });
  }

  return items
    .filter((item) => item.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 200);
}

function evaluateDangerousStates({ licence, document, links, emailEvents }) {
  const states = [];
  const now = nowIso();

  if (!licence) {
    states.push({
      code: "licence_missing",
      severity: "critical",
      message: "Licence record is missing.",
    });

    return states;
  }

  if (licence.status !== "active") {
    states.push({
      code: "licence_not_active",
      severity: "warning",
      message: "Licence is not active.",
    });
  }

  if (licence.revoked_at || licence.status === "revoked") {
    states.push({
      code: "licence_revoked",
      severity: "critical",
      message: "Licence has been revoked.",
    });
  }

  if (licence.confirmed_leak_at) {
    states.push({
      code: "confirmed_leak_recorded",
      severity: "critical",
      message: "Confirmed leak is recorded for this licence.",
    });
  }

  if (licence.suspected_leak_at) {
    states.push({
      code: "suspected_leak_recorded",
      severity: "warning",
      message: "Suspected leak is recorded for this licence.",
    });
  }

  if (!document) {
    states.push({
      code: "document_missing",
      severity: "critical",
      message: "Bound document record is missing.",
    });
  } else {
    if (document.status !== "active") {
      states.push({
        code: "document_not_active",
        severity: "warning",
        message: "Bound document is not active.",
      });
    }

    if (document.version !== licence.document_version) {
      states.push({
        code: "document_version_mismatch",
        severity: "warning",
        message: "Licence document version differs from current document record.",
      });
    }

    if (
      document.source_sha256 &&
      licence.source_sha256 &&
      document.source_sha256 !== licence.source_sha256
    ) {
      states.push({
        code: "source_sha256_mismatch",
        severity: "critical",
        message: "Licence source SHA-256 differs from the bound document source SHA-256.",
      });
    }
  }

  if (
    licence.generated_pdf_status === "generated" &&
    !(
      licence.generated_pdf_object_key &&
      licence.generated_pdf_sha256 &&
      licence.generated_pdf_size_bytes
    )
  ) {
    states.push({
      code: "licence_generated_pdf_evidence_incomplete",
      severity: "critical",
      message: "Licence is marked generated but generated PDF evidence is incomplete.",
    });
  }

  for (const link of links) {
    const ageMs = Date.parse(now) - Date.parse(link.created_at || now);
    const ageMinutes = ageMs / 1000 / 60;

    if (link.status === "pending_generation" && ageMinutes > 15) {
      states.push({
        code: "stale_pending_generation_link",
        severity: "critical",
        download_link_id: link.id,
        download_reference: link.download_reference,
        message: "Download link is still pending_generation more than 15 minutes after creation.",
      });
    }

    if (
      link.status === "active" &&
      !link.used_at &&
      !downloadLinkHasGeneratedEvidence(link)
    ) {
      states.push({
        code: "active_link_without_generated_pdf_evidence",
        severity: "critical",
        download_link_id: link.id,
        download_reference: link.download_reference,
        message: "Active download link has no generated PDF evidence bound to it.",
      });
    }

    if (link.status === "used" && !link.used_at) {
      states.push({
        code: "used_link_missing_used_at",
        severity: "critical",
        download_link_id: link.id,
        download_reference: link.download_reference,
        message: "Download link status is used but used_at is missing.",
      });
    }

    if (link.status === "failed" && !link.failure_reason) {
      states.push({
        code: "failed_link_missing_failure_reason",
        severity: "warning",
        download_link_id: link.id,
        download_reference: link.download_reference,
        message: "Download link status is failed but no failure reason is recorded.",
      });
    }
  }

  const activeUnusedLinks = links.filter(
    (link) => link.status === "active" && !link.used_at && !isExpired(link)
  );

  if (activeUnusedLinks.length > 1) {
    states.push({
      code: "multiple_active_unused_links",
      severity: "warning",
      count: activeUnusedLinks.length,
      message: "More than one active unused link exists for this licence.",
    });
  }

  const failedEmailEvents = emailEvents.filter(
    (event) => cleanText(event.status).toLowerCase() === "failed"
  );

  if (failedEmailEvents.length) {
    states.push({
      code: "failed_email_events_present",
      severity: "warning",
      count: failedEmailEvents.length,
      message: "One or more failed CDAS email events are recorded for this licence.",
    });
  }

  return states;
}

function buildOperatorInterpretation({ licence, links, emailEvents, dangerousStates }) {
  const linkSummary = summariseLinks(links);
  const emailSummary = summariseEmailEvents(emailEvents);

  if (dangerousStates.some((state) => state.severity === "critical")) {
    return {
      status: "attention_required",
      message:
        "Critical evidence or operational state requires review before further operator action.",
      recommended_next_action:
        "Review dangerous_states and avoid issuing or reissuing downloads until the cause is understood.",
    };
  }

  if (linkSummary.active_unused > 0) {
    return {
      status: "active_link_available",
      message:
        "There is an active unused download link for this licence. Do not reissue unless this link is revoked, used, expired, or otherwise unavailable.",
      recommended_next_action:
        "Use the existing active link state, or revoke it deliberately before any reissue.",
    };
  }

  if (linkSummary.used > 0 && licence.generated_pdf_status === "generated") {
    return {
      status: "reissue_available",
      message:
        "This licence has generated evidence and previous used/download history. Explicit reissue is available if the recipient needs a fresh link.",
      recommended_next_action:
        "Use Reissue Download only if a new licensed copy and Download ID are operationally justified.",
    };
  }

  if (licence.generated_pdf_status !== "generated") {
    return {
      status: "initial_prepare_available",
      message:
        "This licence does not yet have generated PDF evidence. Prepare & Email is the appropriate workflow.",
      recommended_next_action:
        "Use Prepare & Email if the licence is ready for first controlled delivery.",
    };
  }

  if (emailSummary.failed > 0 && emailSummary.sent === 0) {
    return {
      status: "email_attention_required",
      message:
        "Email delivery failures are present and no successful email event was found.",
      recommended_next_action:
        "Review email events before reissuing or retrying delivery.",
    };
  }

  return {
    status: "normal",
    message: "No critical dangerous state was detected.",
    recommended_next_action:
      "Continue normal operator workflow according to licence and download-link status.",
  };
}

function enrichDownloadLinks(links, emailEvents) {
  return links.map((link) => {
    const matchingEmailEvents = findMatchingEmailEvents(link, emailEvents);

    return {
      ...link,
      classification: classifyLink(link),
      expired: isExpired(link),
      has_generated_pdf_evidence: downloadLinkHasGeneratedEvidence(link),
      matching_email_events: matchingEmailEvents.map((event) => ({
        id: event.id,
        email_type: event.email_type,
        status: event.status,
        provider: event.provider,
        provider_message_id: event.provider_message_id,
        created_at: event.created_at,
        error: event.error,
        message: event.message,
      })),
    };
  });
}

export async function getCdasLicenceDownloadHistory(request, env, licenceIdOrNumber) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to inspect CDAS licence download history.",
      },
      405
    );
  }

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

  const [document, links, emailEvents, downloadEvents, adminAuditEvents] =
    await Promise.all([
      getDocument(env, licence.document_id),
      getDownloadLinks(env, licence.id),
      getEmailEvents(env, licence),
      getDownloadEvents(env, licence.id),
      getAdminAuditEvents(env, licence),
    ]);

  const dangerousStates = evaluateDangerousStates({
    licence,
    document,
    links,
    emailEvents,
  });

  const summary = {
    links: summariseLinks(links),
    email_events: summariseEmailEvents(emailEvents),
    download_events: {
      total: downloadEvents.length,
      successful: downloadEvents.filter((event) => Number(event.success) === 1).length,
      failed: downloadEvents.filter((event) => Number(event.success) !== 1).length,
    },
    admin_audit_events: {
      total: adminAuditEvents.length,
    },
    dangerous_states: {
      total: dangerousStates.length,
      critical: dangerousStates.filter((state) => state.severity === "critical").length,
      warning: dangerousStates.filter((state) => state.severity === "warning").length,
    },
  };

  const operatorInterpretation = buildOperatorInterpretation({
    licence,
    links,
    emailEvents,
    dangerousStates,
  });

  return jsonResponse({
    ok: true,
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      status: licence.status,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_name: licence.licence_holder_name,
      organisation_name: licence.organisation_name,
      licence_holder_email_normalised:
        licence.licence_holder_email_normalised || licence.licence_holder_email,
      issued_at: licence.issued_at,
      expires_at: licence.expires_at,
      revoked_at: licence.revoked_at,
      suspected_leak_at: licence.suspected_leak_at,
      confirmed_leak_at: licence.confirmed_leak_at,
      generated_pdf_status: licence.generated_pdf_status,
      generated_pdf_object_key: licence.generated_pdf_object_key,
      generated_pdf_sha256: licence.generated_pdf_sha256,
      generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
      generated_pdf_created_at: licence.generated_pdf_created_at,
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
        }
      : null,
    summary,
    operator_interpretation: operatorInterpretation,
    dangerous_states: dangerousStates,
    download_links: enrichDownloadLinks(links, emailEvents),
    email_events: emailEvents,
    download_events: downloadEvents,
    admin_audit_events: adminAuditEvents,
    timeline: buildTimeline({
      links,
      emailEvents,
      downloadEvents,
      adminAuditEvents,
    }),
    controls: {
      read_only: true,
      mutates_database: false,
      writes_to_r2: false,
      creates_download_link: false,
      sends_email: false,
      serves_download: false,
      exposes_raw_token: false,
      exposes_token_hash: false,
      includes_private_r2_url: false,
      evidence_endpoint: true,
    },
    message: "CDAS licence download history loaded.",
  });
}