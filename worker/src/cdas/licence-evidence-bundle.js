import { jsonResponse } from "../shared.js";

const BUNDLE_TYPE = "cdas_licence_evidence_bundle";
const BUNDLE_VERSION = 1;

const REDACTED_FIELDS = new Set([
  "token",
  "raw_token",
  "download_token",
  "token_hash",
  "ip_address",
  "ip_hash",
  "user_agent",
]);

const SAFE_TABLE_NAMES = new Set([
  "documents",
  "document_licences",
  "document_download_links",
  "cdas_email_events",
  "document_download_events",
  "admin_audit_events",
]);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (isObject(value) || Array.isArray(value)) {
    return value;
  }

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function redactRow(row) {
  if (!row || typeof row !== "object") {
    return row;
  }

  const clean = {};

  for (const [key, value] of Object.entries(row)) {
    if (REDACTED_FIELDS.has(key)) {
      continue;
    }

    if (key === "metadata" || key === "metadata_json" || key === "details") {
      clean[key] = safeJsonParse(value, value);
      continue;
    }

    clean[key] = value;
  }

  return clean;
}

function redactRows(rows) {
  return Array.isArray(rows) ? rows.map(redactRow) : [];
}

async function getTableColumns(env, tableName) {
  if (!SAFE_TABLE_NAMES.has(tableName)) {
    return new Set();
  }

  try {
    const result = await env.RELAYHUB_DB
      .prepare(`PRAGMA table_info(${tableName})`)
      .all();

    return new Set((result.results || []).map((row) => row.name));
  } catch {
    return new Set();
  }
}

function buildWhereFromAvailableColumns(columns, candidates) {
  const where = [];
  const bindings = [];

  for (const candidate of candidates) {
    if (!candidate || !columns.has(candidate.column)) {
      continue;
    }

    where.push(candidate.sql);
    bindings.push(...candidate.bindings);
  }

  return {
    where,
    bindings,
  };
}

function buildSafeOrderBy(columns, direction = "ASC") {
  const cleanDirection =
    String(direction || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";

  const preferredColumns = [
    "created_at",
    "event_at",
    "occurred_at",
    "issued_at",
    "updated_at",
    "sent_at",
    "used_at",
    "activated_at",
    "id",
  ];

  for (const column of preferredColumns) {
    if (columns.has(column)) {
      return `ORDER BY ${column} ${cleanDirection}`;
    }
  }

  return "";
}

async function selectOptionalRows(env, tableName, candidates, orderDirection = "ASC") {
  const columns = await getTableColumns(env, tableName);

  if (!columns.size) {
    return {
      table: tableName,
      available: false,
      rows: [],
      columns: [],
    };
  }

  const built = buildWhereFromAvailableColumns(columns, candidates);

  if (!built.where.length) {
    return {
      table: tableName,
      available: true,
      rows: [],
      columns: [...columns],
    };
  }

  const safeOrderBy = buildSafeOrderBy(columns, orderDirection);

  const sql = `
    SELECT *
    FROM ${tableName}
    WHERE ${built.where.join(" OR ")}
    ${safeOrderBy}
  `;

  const result = await env.RELAYHUB_DB
    .prepare(sql)
    .bind(...built.bindings)
    .all();

  return {
    table: tableName,
    available: true,
    rows: result.results || [],
    columns: [...columns],
  };
}

async function getLicence(env, licenceIdOrNumber) {
  const clean = cleanText(licenceIdOrNumber);

  if (!clean) {
    return null;
  }

  return await env.RELAYHUB_DB
    .prepare(
      `
        SELECT *
        FROM document_licences
        WHERE id = ? OR licence_number = ?
        LIMIT 1
      `
    )
    .bind(clean, clean)
    .first();
}

async function getDocument(env, licence) {
  if (!licence?.document_id) {
    return null;
  }

  const columns = await getTableColumns(env, "documents");

  if (!columns.size) {
    return null;
  }

  const idColumn = columns.has("id")
    ? "id"
    : columns.has("document_id")
      ? "document_id"
      : null;

  if (!idColumn) {
    return null;
  }

  const documentVersion = cleanText(licence.document_version);

  if (documentVersion && columns.has("version")) {
    const versioned = await env.RELAYHUB_DB
      .prepare(
        `
          SELECT *
          FROM documents
          WHERE ${idColumn} = ? AND version = ?
          LIMIT 1
        `
      )
      .bind(licence.document_id, documentVersion)
      .first();

    if (versioned) {
      return versioned;
    }
  }

  const orderParts = [];

  if (columns.has("updated_at")) {
    orderParts.push("updated_at DESC");
  }

  if (columns.has("created_at")) {
    orderParts.push("created_at DESC");
  }

  if (columns.has("issued_at")) {
    orderParts.push("issued_at DESC");
  }

  const orderBy = orderParts.length ? `ORDER BY ${orderParts.join(", ")}` : "";

  return await env.RELAYHUB_DB
    .prepare(
      `
        SELECT *
        FROM documents
        WHERE ${idColumn} = ?
        ${orderBy}
        LIMIT 1
      `
    )
    .bind(licence.document_id)
    .first();
}

function linkHasGeneratedPdfEvidence(link) {
  return Boolean(
    link?.generated_pdf_object_key &&
      link?.generated_pdf_sha256 &&
      link?.generated_pdf_size_bytes
  );
}

function licenceHasRenderedEvidence(licence) {
  return Boolean(
    licence?.rendered_licence_body &&
      licence?.rendered_licence_sha256 &&
      licence?.rendered_terms_body_sha256
  );
}

function licenceHasGeneratedPdfEvidence(licence) {
  return Boolean(
    licence?.generated_pdf_object_key &&
      licence?.generated_pdf_sha256 &&
      licence?.generated_pdf_size_bytes &&
      licence?.generated_pdf_status === "generated"
  );
}

function classifyLink(link) {
  const status = cleanText(link?.status).toLowerCase();
  const expiresAt = link?.expires_at ? new Date(link.expires_at) : null;
  const expired =
    expiresAt instanceof Date &&
    !Number.isNaN(expiresAt.getTime()) &&
    expiresAt.getTime() < Date.now();

  if (status === "active" && !link.used_at && !expired) {
    return "active_unused";
  }

  if (status === "pending_generation") {
    return "pending_generation";
  }

  if (status === "used" || link.used_at) {
    return "used";
  }

  if (status === "failed") {
    return "failed";
  }

  if (status === "revoked") {
    return "revoked";
  }

  if (status === "expired" || expired) {
    return "expired";
  }

  if (status === "superseded") {
    return "superseded";
  }

  return status || "unknown";
}

function getEventTime(event) {
  return (
    event?.created_at ||
    event?.event_at ||
    event?.occurred_at ||
    event?.issued_at ||
    event?.updated_at ||
    event?.sent_at ||
    null
  );
}

async function getDownloadLinks(env, licence) {
  const result = await selectOptionalRows(
    env,
    "document_download_links",
    [
      {
        column: "licence_id",
        sql: "licence_id = ?",
        bindings: [licence.id],
      },
      {
        column: "document_id",
        sql: "document_id = ?",
        bindings: [licence.document_id],
      },
    ],
    "ASC"
  );

  const rows = (result.rows || []).filter((row) => {
    if (row.licence_id && row.licence_id === licence.id) {
      return true;
    }

    return false;
  });

  return rows.map((row) => {
    const clean = redactRow(row);

    return {
      ...clean,
      classification: classifyLink(row),
      has_generated_pdf_evidence: linkHasGeneratedPdfEvidence(row),
    };
  });
}

async function getEmailEvents(env, licence, downloadLinks) {
  const downloadReferences = downloadLinks
    .map((link) => link.download_reference)
    .filter(Boolean);

  const downloadLinkIds = downloadLinks.map((link) => link.id).filter(Boolean);

  const metadataNeedles = [
    licence.id,
    licence.licence_number,
    licence.request_id,
    ...downloadReferences,
    ...downloadLinkIds,
  ]
    .filter(Boolean)
    .map((value) => `%${value}%`);

  const candidates = [
    {
      column: "related_id",
      sql: "related_id = ?",
      bindings: [licence.id],
    },
    {
      column: "related_id",
      sql: "related_id = ?",
      bindings: [licence.licence_number],
    },
    {
      column: "licence_id",
      sql: "licence_id = ?",
      bindings: [licence.id],
    },
    {
      column: "licence_number",
      sql: "licence_number = ?",
      bindings: [licence.licence_number],
    },
    {
      column: "request_id",
      sql: "request_id = ?",
      bindings: [licence.request_id],
    },
    ...metadataNeedles.map((needle) => ({
      column: "metadata",
      sql: "metadata LIKE ?",
      bindings: [needle],
    })),
    ...metadataNeedles.map((needle) => ({
      column: "metadata_json",
      sql: "metadata_json LIKE ?",
      bindings: [needle],
    })),
    ...metadataNeedles.map((needle) => ({
      column: "details",
      sql: "details LIKE ?",
      bindings: [needle],
    })),
  ];

  const result = await selectOptionalRows(
    env,
    "cdas_email_events",
    candidates,
    "ASC"
  );

  const rows = redactRows(result.rows || []);

  return rows.filter((event) => {
    if (event.related_type === "licence" && event.related_id === licence.id) {
      return true;
    }

    if (event.related_id && event.related_id === licence.licence_number) {
      return true;
    }

    if (event.licence_id && event.licence_id === licence.id) {
      return true;
    }

    if (event.licence_number && event.licence_number === licence.licence_number) {
      return true;
    }

    if (event.request_id && event.request_id === licence.request_id) {
      return true;
    }

    const metadata = isObject(event.metadata)
      ? event.metadata
      : safeJsonParse(event.metadata, {});

    const metadataJson = isObject(event.metadata_json)
      ? event.metadata_json
      : safeJsonParse(event.metadata_json, {});

    const combinedMetadata = {
      ...metadata,
      ...metadataJson,
    };

    if (combinedMetadata.licence_id === licence.id) {
      return true;
    }

    if (combinedMetadata.licence_number === licence.licence_number) {
      return true;
    }

    if (combinedMetadata.request_id === licence.request_id) {
      return true;
    }

    if (
      combinedMetadata.download_reference &&
      downloadReferences.includes(combinedMetadata.download_reference)
    ) {
      return true;
    }

    if (
      combinedMetadata.download_link_id &&
      downloadLinkIds.includes(combinedMetadata.download_link_id)
    ) {
      return true;
    }

    return false;
  });
}

async function getDownloadEvents(env, licence, downloadLinks) {
  const downloadReferences = downloadLinks
    .map((link) => link.download_reference)
    .filter(Boolean);

  const downloadLinkIds = downloadLinks.map((link) => link.id).filter(Boolean);

  const candidates = [
    {
      column: "licence_id",
      sql: "licence_id = ?",
      bindings: [licence.id],
    },
    {
      column: "licence_number",
      sql: "licence_number = ?",
      bindings: [licence.licence_number],
    },
    ...downloadReferences.map((reference) => ({
      column: "download_reference",
      sql: "download_reference = ?",
      bindings: [reference],
    })),
    ...downloadLinkIds.map((downloadLinkId) => ({
      column: "download_link_id",
      sql: "download_link_id = ?",
      bindings: [downloadLinkId],
    })),
    ...downloadLinkIds.map((downloadLinkId) => ({
      column: "download_id",
      sql: "download_id = ?",
      bindings: [downloadLinkId],
    })),
  ];

  const result = await selectOptionalRows(
    env,
    "document_download_events",
    candidates,
    "ASC"
  );

  const rows = redactRows(result.rows || []);

  return rows.filter((event) => {
    if (event.licence_id && event.licence_id === licence.id) {
      return true;
    }

    if (event.licence_number && event.licence_number === licence.licence_number) {
      return true;
    }

    if (
      event.download_reference &&
      downloadReferences.includes(event.download_reference)
    ) {
      return true;
    }

    if (event.download_link_id && downloadLinkIds.includes(event.download_link_id)) {
      return true;
    }

    if (event.download_id && downloadLinkIds.includes(event.download_id)) {
      return true;
    }

    return false;
  });
}

async function getAdminAuditEvents(env, licence, downloadLinks) {
  const downloadReferences = downloadLinks
    .map((link) => link.download_reference)
    .filter(Boolean);

  const downloadLinkIds = downloadLinks.map((link) => link.id).filter(Boolean);

  const detailNeedles = [
    licence.id,
    licence.licence_number,
    ...downloadReferences,
    ...downloadLinkIds,
  ]
    .filter(Boolean)
    .map((value) => `%${value}%`);

  const candidates = [
    {
      column: "entity_id",
      sql: "entity_id = ?",
      bindings: [licence.id],
    },
    {
      column: "licence_id",
      sql: "licence_id = ?",
      bindings: [licence.id],
    },
    {
      column: "licence_number",
      sql: "licence_number = ?",
      bindings: [licence.licence_number],
    },
    ...detailNeedles.map((needle) => ({
      column: "details",
      sql: "details LIKE ?",
      bindings: [needle],
    })),
    ...detailNeedles.map((needle) => ({
      column: "metadata",
      sql: "metadata LIKE ?",
      bindings: [needle],
    })),
  ];

  const result = await selectOptionalRows(
    env,
    "admin_audit_events",
    candidates,
    "ASC"
  );

  return redactRows(result.rows || []);
}

function summariseDownloadLinks(downloadLinks) {
  const summary = {
    total: downloadLinks.length,
    active_unused: 0,
    pending_generation: 0,
    used: 0,
    failed: 0,
    revoked: 0,
    expired: 0,
    superseded: 0,
    with_generated_pdf_evidence: 0,
    without_generated_pdf_evidence: 0,
    latest_download_reference: null,
  };

  for (const link of downloadLinks) {
    const classification = link.classification || classifyLink(link);

    if (Object.prototype.hasOwnProperty.call(summary, classification)) {
      summary[classification] += 1;
    }

    if (link.has_generated_pdf_evidence) {
      summary.with_generated_pdf_evidence += 1;
    } else {
      summary.without_generated_pdf_evidence += 1;
    }

    if (link.download_reference) {
      summary.latest_download_reference = link.download_reference;
    }
  }

  return summary;
}

function summariseEmailEvents(emailEvents) {
  const summary = {
    total: emailEvents.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    retryable: 0,
    latest_status: null,
    latest_provider_message_id: null,
  };

  for (const event of emailEvents) {
    const status = cleanText(event.status).toLowerCase();

    if (status === "sent") {
      summary.sent += 1;
    } else if (status === "failed") {
      summary.failed += 1;
    } else if (status === "skipped") {
      summary.skipped += 1;
    } else if (status) {
      summary.pending += 1;
    }

    if (Number(event.retryable || 0) > 0) {
      summary.retryable += 1;
    }

    summary.latest_status = event.status || summary.latest_status;
    summary.latest_provider_message_id =
      event.provider_message_id || summary.latest_provider_message_id;
  }

  return summary;
}

function summariseDownloadEvents(downloadEvents) {
  const summary = {
    total: downloadEvents.length,
    successful: 0,
    failed: 0,
  };

  for (const event of downloadEvents) {
    const success = event.success;

    if (success === true || success === 1 || success === "1") {
      summary.successful += 1;
      continue;
    }

    if (success === false || success === 0 || success === "0") {
      summary.failed += 1;
    }
  }

  return summary;
}

function summariseDangerousStates(dangerousStates) {
  return {
    total: dangerousStates.length,
    critical: dangerousStates.filter((state) => state.severity === "critical")
      .length,
    warning: dangerousStates.filter((state) => state.severity === "warning")
      .length,
  };
}

function metadataBoolean(event, key) {
  const metadata = isObject(event?.metadata)
    ? event.metadata
    : safeJsonParse(event?.metadata, {});

  const metadataJson = isObject(event?.metadata_json)
    ? event.metadata_json
    : safeJsonParse(event?.metadata_json, {});

  const combinedMetadata = {
    ...metadata,
    ...metadataJson,
  };

  return (
    combinedMetadata[key] === true ||
    combinedMetadata[key] === 1 ||
    combinedMetadata[key] === "1" ||
    combinedMetadata[key] === "true"
  );
}

function evaluateDangerousStates({
  licence,
  downloadLinks,
  emailEvents,
  integritySummary,
}) {
  const states = [];

  const activeUnusedLinks = downloadLinks.filter(
    (link) => link.classification === "active_unused"
  );

  const pendingGenerationLinks = downloadLinks.filter(
    (link) => link.classification === "pending_generation"
  );

  const usedLinksWithoutGeneratedEvidence = downloadLinks.filter(
    (link) => link.classification === "used" && !link.has_generated_pdf_evidence
  );

  if (activeUnusedLinks.length > 1) {
    states.push({
      severity: "critical",
      code: "multiple_active_unused_download_links",
      message:
        "More than one active unused download link exists for this licence.",
      count: activeUnusedLinks.length,
    });
  }

  if (pendingGenerationLinks.length > 0) {
    states.push({
      severity: "warning",
      code: "pending_generation_links_present",
      message:
        "One or more download links are still pending generation and should be reviewed.",
      count: pendingGenerationLinks.length,
    });
  }

  if (usedLinksWithoutGeneratedEvidence.length > 0) {
    states.push({
      severity: "warning",
      code: "used_links_missing_generated_pdf_evidence",
      message:
        "One or more used links do not have generated PDF evidence attached.",
      count: usedLinksWithoutGeneratedEvidence.length,
    });
  }

  if (!integritySummary.licence_evidence_captured) {
    states.push({
      severity: "warning",
      code: "licence_rendered_evidence_missing",
      message:
        "The licence does not contain a complete rendered licence evidence body and hash set.",
    });
  }

  if (
    licence.status === "active" &&
    downloadLinks.length > 0 &&
    !integritySummary.any_download_link_has_generated_pdf_evidence
  ) {
    states.push({
      severity: "warning",
      code: "download_links_missing_generated_pdf_evidence",
      message:
        "Download links exist, but none contain generated PDF object, hash, and size evidence.",
    });
  }

  const rawR2UrlExposed = emailEvents.some((event) =>
    metadataBoolean(event, "raw_r2_url_exposed")
  );

  const downloadApiUrlEmailed = emailEvents.some((event) =>
    metadataBoolean(event, "download_api_url_emailed")
  );

  if (rawR2UrlExposed) {
    states.push({
      severity: "critical",
      code: "raw_r2_url_exposed_in_email_metadata",
      message:
        "Email metadata reports that a raw R2 URL may have been exposed.",
    });
  }

  if (downloadApiUrlEmailed) {
    states.push({
      severity: "warning",
      code: "download_api_url_emailed",
      message:
        "Email metadata reports that a direct download API URL was emailed instead of only the recipient landing page.",
    });
  }

  return states;
}

function buildIntegritySummary({
  licence,
  document,
  downloadLinks,
  emailEvents,
  dangerousStates,
}) {
  const linksWithEvidence = downloadLinks.filter((link) =>
    linkHasGeneratedPdfEvidence(link)
  );

  const linkDownloadReferences = new Set(
    downloadLinks.map((link) => link.download_reference).filter(Boolean)
  );

  const sentEmailEvents = emailEvents.filter(
    (event) => cleanText(event.status).toLowerCase() === "sent"
  );

  const sentEmailsMatchedToDownloadLinks = sentEmailEvents.filter((event) => {
    const metadata = isObject(event.metadata)
      ? event.metadata
      : safeJsonParse(event.metadata, {});

    const metadataJson = isObject(event.metadata_json)
      ? event.metadata_json
      : safeJsonParse(event.metadata_json, {});

    const combinedMetadata = {
      ...metadata,
      ...metadataJson,
    };

    const reference = combinedMetadata.download_reference;

    return reference && linkDownloadReferences.has(reference);
  });

  const allSentEmailsMatchDownloadLinks =
    sentEmailEvents.length === 0 ||
    sentEmailsMatchedToDownloadLinks.length === sentEmailEvents.length;

  return {
    licence_evidence_captured: licenceHasRenderedEvidence(licence),
    generated_pdf_evidence_present: licenceHasGeneratedPdfEvidence(licence),
    document_record_present: Boolean(document),

    download_links_total: downloadLinks.length,
    download_links_with_generated_pdf_evidence: linksWithEvidence.length,
    download_links_without_generated_pdf_evidence:
      downloadLinks.length - linksWithEvidence.length,
    any_download_link_has_generated_pdf_evidence: linksWithEvidence.length > 0,
    all_download_links_have_generated_pdf_evidence:
      downloadLinks.length > 0 && linksWithEvidence.length === downloadLinks.length,

    email_events_total: emailEvents.length,
    sent_email_events_total: sentEmailEvents.length,
    sent_email_events_matched_to_download_links:
      sentEmailsMatchedToDownloadLinks.length,
    email_events_match_download_links: allSentEmailsMatchDownloadLinks,

    dangerous_states_present: dangerousStates.length > 0,
    dangerous_states_total: dangerousStates.length,

    raw_token_exposed: false,
    token_hash_exposed: false,
    private_r2_url_exposed: false,
    private_r2_object_keys_included: true,
    bundle_is_read_only: true,
  };
}

function buildTimeline({
  licence,
  downloadLinks,
  emailEvents,
  downloadEvents,
  adminAuditEvents,
}) {
  const timeline = [];

  if (licence.issued_at) {
    timeline.push({
      at: licence.issued_at,
      type: "licence_issued",
      label: "Licence issued",
      licence_id: licence.id,
      licence_number: licence.licence_number,
    });
  }

  if (licence.generated_pdf_created_at) {
    timeline.push({
      at: licence.generated_pdf_created_at,
      type: "licence_generated_pdf_created",
      label: "Licence generated PDF evidence recorded",
      licence_id: licence.id,
      licence_number: licence.licence_number,
      generated_pdf_sha256: licence.generated_pdf_sha256,
    });
  }

  for (const link of downloadLinks) {
    if (link.created_at) {
      timeline.push({
        at: link.created_at,
        type: "download_link_created",
        label: "Download link created",
        download_link_id: link.id,
        download_reference: link.download_reference,
        status: link.status,
      });
    }

    if (link.activated_at) {
      timeline.push({
        at: link.activated_at,
        type: "download_link_activated",
        label: "Download link activated",
        download_link_id: link.id,
        download_reference: link.download_reference,
        status: link.status,
      });
    }

    if (link.generated_pdf_created_at) {
      timeline.push({
        at: link.generated_pdf_created_at,
        type: "download_link_generated_pdf_bound",
        label: "Generated PDF bound to download link",
        download_link_id: link.id,
        download_reference: link.download_reference,
        generated_pdf_sha256: link.generated_pdf_sha256,
      });
    }

    if (link.used_at) {
      timeline.push({
        at: link.used_at,
        type: "download_link_used",
        label: "Download link used",
        download_link_id: link.id,
        download_reference: link.download_reference,
        status: link.status,
      });
    }

    if (link.revoked_at) {
      timeline.push({
        at: link.revoked_at,
        type: "download_link_revoked",
        label: "Download link revoked",
        download_link_id: link.id,
        download_reference: link.download_reference,
        status: link.status,
      });
    }

    if (link.superseded_at) {
      timeline.push({
        at: link.superseded_at,
        type: "download_link_superseded",
        label: "Download link superseded",
        download_link_id: link.id,
        download_reference: link.download_reference,
        status: link.status,
      });
    }
  }

  for (const event of emailEvents) {
    timeline.push({
      at: getEventTime(event),
      type: "email_event",
      label: `Email event: ${event.email_type || "unknown"}`,
      status: event.status,
      provider: event.provider,
      provider_message_id: event.provider_message_id,
      recipient_email: event.recipient_email,
    });
  }

  for (const event of downloadEvents) {
    timeline.push({
      at: getEventTime(event),
      type: "download_event",
      label: event.event_type || event.type || "Download event",
      status: event.status,
      success: event.success,
      download_reference: event.download_reference,
      download_link_id: event.download_link_id || event.download_id,
    });
  }

  for (const event of adminAuditEvents) {
    timeline.push({
      at: getEventTime(event),
      type: "admin_audit_event",
      label: event.action || event.event_type || event.type || "Admin audit event",
      status: event.status,
      entity_id: event.entity_id,
    });
  }

  return timeline
    .filter((item) => item.at)
    .sort((a, b) => {
      const left = new Date(a.at).getTime();
      const right = new Date(b.at).getTime();

      if (Number.isNaN(left) && Number.isNaN(right)) return 0;
      if (Number.isNaN(left)) return 1;
      if (Number.isNaN(right)) return -1;

      return left - right;
    });
}

function buildOperatorInterpretation({
  licence,
  downloadLinkSummary,
  dangerousStates,
}) {
  const criticalCount = dangerousStates.filter(
    (state) => state.severity === "critical"
  ).length;

  const warningCount = dangerousStates.filter(
    (state) => state.severity === "warning"
  ).length;

  if (criticalCount > 0) {
    return {
      status: "operator_review_required",
      severity: "critical",
      message:
        "Critical evidence states are present. Review before issuing or reissuing another controlled download.",
      recommended_next_action: "review_evidence_before_operator_action",
    };
  }

  if (warningCount > 0) {
    return {
      status: "operator_review_recommended",
      severity: "warning",
      message:
        "Warning evidence states are present. The bundle is readable, but the operator should review the evidence.",
      recommended_next_action: "review_warning_states",
    };
  }

  if (downloadLinkSummary.active_unused > 0) {
    return {
      status: "active_download_available",
      severity: "info",
      message:
        "An active unused controlled download link exists for this licence.",
      recommended_next_action:
        "do_not_reissue_unless_current_link_is_revoked_or_expires",
    };
  }

  if (licence.status === "active") {
    return {
      status: "reissue_available",
      severity: "safe",
      message:
        "No dangerous states were found and no active unused link is present. Reissue can be considered if operationally justified.",
      recommended_next_action: "operator_may_reissue_if_needed",
    };
  }

  return {
    status: "licence_not_active",
    severity: "info",
    message:
      "The licence is not active. Controlled download action should remain blocked unless policy allows otherwise.",
    recommended_next_action: "do_not_issue_download_without_policy_review",
  };
}

export async function getCdasLicenceEvidenceBundle(
  request,
  env,
  licenceIdOrNumber
) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to export a CDAS licence evidence bundle.",
      },
      { status: 405, headers: { allow: "GET" } }
    );
  }

  if (!env.RELAYHUB_DB) {
    return jsonResponse(
      {
        ok: false,
        error: "database_not_configured",
        message: "RELAYHUB_DB binding is not configured.",
      },
      { status: 500 }
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
      { status: 404 }
    );
  }

  const document = await getDocument(env, licence);
  const downloadLinks = await getDownloadLinks(env, licence);
  const emailEvents = await getEmailEvents(env, licence, downloadLinks);
  const downloadEvents = await getDownloadEvents(env, licence, downloadLinks);
  const adminAuditEvents = await getAdminAuditEvents(
    env,
    licence,
    downloadLinks
  );

  const downloadLinkSummary = summariseDownloadLinks(downloadLinks);
  const emailEventSummary = summariseEmailEvents(emailEvents);
  const downloadEventSummary = summariseDownloadEvents(downloadEvents);

  const preliminaryIntegritySummary = {
    licence_evidence_captured: licenceHasRenderedEvidence(licence),
    any_download_link_has_generated_pdf_evidence: downloadLinks.some((link) =>
      linkHasGeneratedPdfEvidence(link)
    ),
  };

  const dangerousStates = evaluateDangerousStates({
    licence,
    downloadLinks,
    emailEvents,
    integritySummary: preliminaryIntegritySummary,
  });

  const integritySummary = buildIntegritySummary({
    licence,
    document,
    downloadLinks,
    emailEvents,
    dangerousStates,
  });

  const dangerousStateSummary = summariseDangerousStates(dangerousStates);

  const operatorInterpretation = buildOperatorInterpretation({
    licence,
    downloadLinkSummary,
    dangerousStates,
  });

  const timeline = buildTimeline({
    licence,
    downloadLinks,
    emailEvents,
    downloadEvents,
    adminAuditEvents,
  });

  return jsonResponse({
    ok: true,
    bundle_type: BUNDLE_TYPE,
    bundle_version: BUNDLE_VERSION,
    generated_at: nowIso(),

    licence: redactRow(licence),
    document: redactRow(document),

    generated_pdf_evidence: {
      licence_generated_pdf_status: licence.generated_pdf_status || null,
      licence_generated_pdf_object_key: licence.generated_pdf_object_key || null,
      licence_generated_pdf_filename: licence.generated_pdf_filename || null,
      licence_generated_pdf_sha256: licence.generated_pdf_sha256 || null,
      licence_generated_pdf_size_bytes:
        licence.generated_pdf_size_bytes || null,
      licence_generated_pdf_content_type:
        licence.generated_pdf_content_type || null,
      licence_generated_pdf_created_at:
        licence.generated_pdf_created_at || null,
      licence_generated_pdf_error: licence.generated_pdf_error || null,
      download_link_generated_pdf_evidence: downloadLinks.map((link) => ({
        download_link_id: link.id,
        download_reference: link.download_reference,
        status: link.status,
        classification: link.classification,
        generated_pdf_object_key: link.generated_pdf_object_key || null,
        generated_pdf_sha256: link.generated_pdf_sha256 || null,
        generated_pdf_size_bytes: link.generated_pdf_size_bytes || null,
        generated_pdf_created_at: link.generated_pdf_created_at || null,
        has_generated_pdf_evidence: link.has_generated_pdf_evidence,
      })),
    },

    summary: {
      download_links: downloadLinkSummary,
      email_events: emailEventSummary,
      download_events: downloadEventSummary,
      admin_audit_events: {
        total: adminAuditEvents.length,
      },
      dangerous_states: dangerousStateSummary,
      timeline: {
        total: timeline.length,
      },
    },

    operator_interpretation: operatorInterpretation,
    dangerous_states: dangerousStates,
    integrity_summary: integritySummary,

    download_links: downloadLinks,
    email_events: emailEvents,
    download_events: downloadEvents,
    admin_audit_events: adminAuditEvents,
    timeline,

    controls: {
      read_only: true,
      mutates_database: false,
      writes_to_r2: false,
      reads_from_r2: false,
      creates_download_link: false,
      generates_pdf: false,
      sends_email: false,
      serves_download: false,
      exposes_raw_token: false,
      exposes_token_hash: false,
      includes_private_r2_url: false,
      includes_private_r2_object_keys: true,
      evidence_bundle: true,
    },

    message: "CDAS licence evidence bundle exported.",
  });
}