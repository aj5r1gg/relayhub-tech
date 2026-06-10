import { jsonResponse } from "../shared.js";

const REQUIRED_TABLES = [
  "documents",
  "document_access_requests",
  "document_access_invitations",
  "document_licences",
  "document_download_links",
  "document_download_events",
  "cdas_email_events",
];

const REQUIRED_COLUMNS = {
  documents: [
    "id",
    "status",
    "source_object",
    "source_sha256",
    "licence_terms_version",
  ],
  document_access_requests: [
    "id",
    "status",
    "email_verified_at",
    "requested_at",
  ],
  document_access_invitations: [
    "id",
    "status",
    "expires_at",
    "use_count",
    "max_uses",
  ],
  document_licences: [
    "id",
    "document_id",
    "licence_number",
    "generated_pdf_object_key",
    "generated_pdf_sha256",
    "issued_at",
  ],
  document_download_links: [
    "id",
    "licence_id",
    "status",
    "expires_at",
    "used_at",
    "revoked_at",
  ],
  document_download_events: [
    "id",
    "download_id",
    "licence_id",
    "event_type",
    "event_at",
    "success",
  ],
  cdas_email_events: [
    "id",
    "related_type",
    "related_id",
    "email_type",
    "status",
    "retryable",
    "resolved_at",
    "created_at",
  ],
};

function cleanText(value) {
  return String(value ?? "").trim();
}

async function safeFirst(env, sql, bindings = []) {
  try {
    return await env.RELAYHUB_DB.prepare(sql).bind(...bindings).first();
  } catch (error) {
    return {
      __health_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function safeAll(env, sql, bindings = []) {
  try {
    const result = await env.RELAYHUB_DB.prepare(sql).bind(...bindings).all();
    return Array.isArray(result?.results) ? result.results : [];
  } catch {
    return [];
  }
}

async function count(env, sql, bindings = []) {
  const row = await safeFirst(env, sql, bindings);
  return Number(row?.total || 0);
}

async function latest(env, sql, bindings = []) {
  const row = await safeFirst(env, sql, bindings);
  return row?.latest_at || null;
}

async function tableExists(env, tableName) {
  const row = await safeFirst(
    env,
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
     LIMIT 1`,
    [tableName]
  );

  return row?.name === tableName;
}

async function getTableColumns(env, tableName) {
  const rows = await safeAll(env, `PRAGMA table_info(${tableName})`);
  return rows.map((row) => row.name).filter(Boolean);
}

async function getSchemaHealth(env) {
  const tables = {};
  const missingTables = [];
  const missingColumns = {};

  for (const tableName of REQUIRED_TABLES) {
    const exists = await tableExists(env, tableName);

    if (!exists) {
      tables[tableName] = { exists: false };
      missingTables.push(tableName);
      continue;
    }

    const columns = await getTableColumns(env, tableName);
    const required = REQUIRED_COLUMNS[tableName] || [];
    const missing = required.filter((column) => !columns.includes(column));

    tables[tableName] = {
      exists: true,
      columns_checked: required.length,
      missing_columns: missing,
    };

    if (missing.length) {
      missingColumns[tableName] = missing;
    }
  }

  return {
    ok: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missing_tables: missingTables,
    missing_columns: missingColumns,
    tables,
  };
}

function configHealth(env) {
  return {
    email_enabled: cleanText(env.CDAS_EMAIL_ENABLED).toLowerCase() === "true",
    email_provider: cleanText(env.CDAS_EMAIL_PROVIDER) || null,
    public_base_url_set: Boolean(cleanText(env.CDAS_PUBLIC_BASE_URL)),
    resend_config_present: Boolean(env.RESEND_API_KEY),
    email_from_set: Boolean(cleanText(env.CDAS_EMAIL_FROM)),
    email_reply_to_set: Boolean(cleanText(env.CDAS_EMAIL_REPLY_TO)),
    admin_token_configured: Boolean(env.RELAYHUB_ADMIN_TOKEN),
  };
}

export async function getCdasHealth(request, env) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to inspect CDAS health.",
      },
      405
    );
  }

  const [
    schema,

    documentsTotal,
    activeDocuments,
    accessRequestsTotal,
    licencesTotal,
    downloadLinksTotal,
    emailEventsTotal,

    failedUnresolvedEmailEvents,
    retryableUnresolvedEmailEvents,

    pendingEmailVerificationRequests,
    verifiedUnlicensedRequests,
    licencesMissingGeneratedPdfs,
    generatedPdfsWithoutDownloadLinks,

    expiredActiveInvitations,
    expiredActiveDownloadLinks,
    usedDownloadLinksStillActive,
    revokedDownloadLinksTotal,

    downloadLinksWithoutLicence,
    downloadEventsWithoutLicence,
    emailEventsWithoutRelatedRecord,

    latestEmailEventAt,
    latestDownloadEventAt,
    latestAccessRequestAt,
    latestLicenceIssuedAt,
    latestPdfGeneratedAt,
    latestInvitationCreatedAt,
  ] = await Promise.all([
    getSchemaHealth(env),

    count(env, "SELECT COUNT(*) AS total FROM documents"),
    count(env, "SELECT COUNT(*) AS total FROM documents WHERE status = 'active'"),
    count(env, "SELECT COUNT(*) AS total FROM document_access_requests"),
    count(env, "SELECT COUNT(*) AS total FROM document_licences"),
    count(env, "SELECT COUNT(*) AS total FROM document_download_links"),
    count(env, "SELECT COUNT(*) AS total FROM cdas_email_events"),

    count(
      env,
      `SELECT COUNT(*) AS total
       FROM cdas_email_events
       WHERE status = 'failed'
         AND resolved_at IS NULL`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM cdas_email_events
       WHERE retryable = 1
         AND resolved_at IS NULL`
    ),

    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_access_requests
       WHERE email_verified_at IS NULL
         AND status NOT IN ('licence_issued', 'denied', 'expired', 'cancelled')`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_access_requests
       WHERE email_verified_at IS NOT NULL
         AND status NOT IN ('licence_issued', 'denied', 'expired', 'cancelled')`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_licences
       WHERE generated_pdf_object_key IS NULL
          OR generated_pdf_sha256 IS NULL`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_licences l
       WHERE l.generated_pdf_object_key IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM document_download_links dl
           WHERE dl.licence_id = l.id
         )`
    ),

    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_access_invitations
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at < datetime('now')`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_download_links
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at < datetime('now')`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_download_links
       WHERE status = 'active'
         AND used_at IS NOT NULL`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_download_links
       WHERE revoked_at IS NOT NULL
          OR status = 'revoked'`
    ),

    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_download_links dl
       LEFT JOIN document_licences l
         ON l.id = dl.licence_id
       WHERE l.id IS NULL`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM document_download_events e
       LEFT JOIN document_licences l
         ON l.id = e.licence_id
       WHERE l.id IS NULL`
    ),
    count(
      env,
      `SELECT COUNT(*) AS total
       FROM cdas_email_events e
       WHERE
         (
           e.related_type = 'access_request'
           AND NOT EXISTS (
             SELECT 1
             FROM document_access_requests r
             WHERE r.id = e.related_id
           )
         )
         OR
         (
           e.related_type = 'licence'
           AND NOT EXISTS (
             SELECT 1
             FROM document_licences l
             WHERE l.id = e.related_id
           )
         )`
    ),

    latest(env, "SELECT MAX(created_at) AS latest_at FROM cdas_email_events"),
    latest(env, "SELECT MAX(event_at) AS latest_at FROM document_download_events"),
    latest(env, "SELECT MAX(requested_at) AS latest_at FROM document_access_requests"),
    latest(env, "SELECT MAX(issued_at) AS latest_at FROM document_licences"),
    latest(
      env,
      "SELECT MAX(generated_pdf_created_at) AS latest_at FROM document_licences"
    ),
    latest(env, "SELECT MAX(created_at) AS latest_at FROM document_access_invitations"),
  ]);

  const config = configHealth(env);
  const warnings = [];
  const notices = [];

  if (!schema.ok) warnings.push("schema_health_failed");
  if (!config.admin_token_configured) warnings.push("admin_token_missing");
  if (!config.public_base_url_set) warnings.push("public_base_url_missing");
  if (config.email_enabled && !config.resend_config_present) {
    warnings.push("resend_api_key_missing");
  }
  if (config.email_enabled && !config.email_from_set) {
    warnings.push("email_from_missing");
  }

  if (activeDocuments < 1) warnings.push("no_active_documents");
  if (failedUnresolvedEmailEvents > 0) {
    warnings.push("unresolved_failed_email_events");
  }
  if (retryableUnresolvedEmailEvents > 0) {
    warnings.push("unresolved_retryable_email_events");
  }

  if (pendingEmailVerificationRequests > 0) {
    notices.push("pending_email_verification_requests");
  }
  if (verifiedUnlicensedRequests > 0) warnings.push("verified_unlicensed_requests");
  if (licencesMissingGeneratedPdfs > 0) warnings.push("licences_missing_generated_pdfs");
  if (generatedPdfsWithoutDownloadLinks > 0) {
    notices.push("generated_pdfs_without_download_links");
  }

  if (expiredActiveInvitations > 0) warnings.push("expired_active_invitations");
  if (expiredActiveDownloadLinks > 0) warnings.push("expired_active_download_links");
  if (usedDownloadLinksStillActive > 0) warnings.push("used_download_links_still_active");

  if (revokedDownloadLinksTotal > 0) {
    notices.push("revoked_download_links_present");
  }

  if (downloadLinksWithoutLicence > 0) warnings.push("download_links_without_licence");
  if (downloadEventsWithoutLicence > 0) warnings.push("download_events_without_licence");
  if (emailEventsWithoutRelatedRecord > 0) {
    warnings.push("email_events_without_related_record");
  }

  return jsonResponse({
    ok: true,
    checked_at: new Date().toISOString(),
    system_status: warnings.length ? "attention_required" : "healthy",
    warnings,
    notices,
    config,
    schema,
    metrics: {
      documents_total: documentsTotal,
      active_documents: activeDocuments,
      access_requests_total: accessRequestsTotal,
      licences_total: licencesTotal,
      download_links_total: downloadLinksTotal,
      email_events_total: emailEventsTotal,

      failed_unresolved_email_events: failedUnresolvedEmailEvents,
      retryable_unresolved_email_events: retryableUnresolvedEmailEvents,

      pending_email_verification_requests: pendingEmailVerificationRequests,
      verified_unlicensed_requests: verifiedUnlicensedRequests,
      licences_missing_generated_pdfs: licencesMissingGeneratedPdfs,
      generated_pdfs_without_download_links: generatedPdfsWithoutDownloadLinks,

      expired_active_invitations: expiredActiveInvitations,
      expired_active_download_links: expiredActiveDownloadLinks,
      used_download_links_still_active: usedDownloadLinksStillActive,
      revoked_download_links_total: revokedDownloadLinksTotal,

      download_links_without_licence: downloadLinksWithoutLicence,
      download_events_without_licence: downloadEventsWithoutLicence,
      email_events_without_related_record: emailEventsWithoutRelatedRecord,

      latest_email_event_at: latestEmailEventAt,
      latest_download_event_at: latestDownloadEventAt,
      latest_access_request_at: latestAccessRequestAt,
      latest_licence_issued_at: latestLicenceIssuedAt,
      latest_pdf_generated_at: latestPdfGeneratedAt,
      latest_invitation_created_at: latestInvitationCreatedAt,
    },
  });
}