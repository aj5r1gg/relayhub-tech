// worker/src/cdas/operations.js

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function getDb(env) {
  return env.DB || env.RELAYHUB_DB || env.DATABASE || null;
}

async function first(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const result = await stmt.bind(...params).first();
    return result || {};
  } catch (error) {
    return {
      __query_failed: true,
      __error: String(error?.message || error),
      __sql: sql,
    };
  }
}

async function all(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const result = await stmt.bind(...params).all();
    return result?.results || [];
  } catch (error) {
    return [
      {
        __query_failed: true,
        __error: String(error?.message || error),
        __sql: sql,
      },
    ];
  }
}

function numberValue(row, key = "total") {
  if (!row || row.__query_failed) return 0;
  const value = row[key];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function compactFailureList(groups) {
  const failures = [];

  for (const [group, value] of Object.entries(groups)) {
    if (value && value.__query_failed) {
      failures.push({
        group,
        error: value.__error,
      });
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && item.__query_failed) {
          failures.push({
            group,
            error: item.__error,
          });
        }
      }
    }
  }

  return failures;
}

function classifyOperationsStatus({ health, email, workflow, integrity, queryFailures }) {
  if (queryFailures.length > 0) return "warning";

  if (
    integrity.download_links_without_licence > 0 ||
    integrity.download_events_without_licence > 0 ||
    integrity.email_events_without_related_record > 0
  ) {
    return "warning";
  }

  if (email.failed_events > 0 || email.retryable_events > 0) {
    return "attention";
  }

  if (
    workflow.pending_verification > 0 ||
    workflow.verified_unlicensed > 0 ||
    workflow.generated_pdfs_without_links > 0
  ) {
    return "notice";
  }

  if (health?.system_status === "fault") return "warning";
  if (health?.system_status === "warning") return "attention";

  return "healthy";
}

export async function handleCdasOperationsJson(request, env) {
  const db = getDb(env);

  if (!db) {
    return json(
      {
        ok: false,
        system: "cdas",
        endpoint: "/api/admin/cdas/operations",
        status: "fault",
        error: "D1 database binding was not found.",
      },
      500,
    );
  }

  const now = new Date().toISOString();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const weekIso = weekStart.toISOString();

  const core = {
    documents: numberValue(await first(db, "SELECT COUNT(*) AS total FROM documents")),
    active_documents: numberValue(
      await first(db, "SELECT COUNT(*) AS total FROM documents WHERE status = 'active'"),
    ),
    access_requests: numberValue(
      await first(db, "SELECT COUNT(*) AS total FROM document_access_requests"),
    ),
    licences: numberValue(await first(db, "SELECT COUNT(*) AS total FROM document_licences")),
    download_links: numberValue(
      await first(db, "SELECT COUNT(*) AS total FROM document_download_links"),
    ),
    download_events: numberValue(
      await first(db, "SELECT COUNT(*) AS total FROM document_download_events"),
    ),
    email_events: numberValue(await first(db, "SELECT COUNT(*) AS total FROM cdas_email_events")),
  };

  const email = {
    failed_events: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM cdas_email_events
          WHERE status IN ('failed', 'bounced', 'complained', 'blocked')
        `,
      ),
    ),
    retryable_events: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM cdas_email_events
          WHERE retryable = 1
            AND resolved_at IS NULL
        `,
      ),
    ),
    unresolved_failed_events: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM cdas_email_events
          WHERE status IN ('failed', 'bounced', 'complained', 'blocked')
            AND resolved_at IS NULL
        `,
      ),
    ),
    sent_today: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM cdas_email_events
          WHERE status = 'sent'
            AND created_at >= ?
        `,
        [todayIso],
      ),
    ),
  };

  const workflow = {
    pending_verification: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests
          WHERE email_verified_at IS NULL
            AND status IN ('created', 'email_pending', 'email_sent')
        `,
      ),
    ),
    verified_unlicensed: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests r
          LEFT JOIN document_licences l ON l.request_id = r.id
          WHERE r.email_verified_at IS NOT NULL
            AND l.id IS NULL
            AND r.status NOT IN ('denied', 'cancelled', 'expired', 'closed')
        `,
      ),
    ),
    pending_approval: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests
          WHERE status IN ('pending_approval', 'pending_review')
        `,
      ),
    ),
    generated_pdfs_without_links: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences l
          LEFT JOIN document_download_links dl ON dl.licence_id = l.id
          WHERE l.generated_pdf_object_key IS NOT NULL
            AND dl.id IS NULL
        `,
      ),
    ),
  };

  const licences = {
    issued_today: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences
          WHERE issued_at >= ?
        `,
        [todayIso],
      ),
    ),
    issued_last_7_days: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences
          WHERE issued_at >= ?
        `,
        [weekIso],
      ),
    ),
    issued: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences
          WHERE status = 'issued'
        `,
      ),
    ),
    active: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences
          WHERE status IN ('issued', 'active')
        `,
      ),
    ),
    revoked: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences
          WHERE status = 'revoked'
             OR revoked_at IS NOT NULL
        `,
      ),
    ),
    generated_missing_hash: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences
          WHERE generated_pdf_object_key IS NOT NULL
            AND generated_pdf_sha256 IS NULL
        `,
      ),
    ),
  };

  const downloads = {
    active_links: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE status IN ('created', 'pending_generation', 'pending_activation', 'sent', 'active')
            AND revoked_at IS NULL
            AND used_at IS NULL
            AND expires_at > ?
        `,
        [now],
      ),
    ),
    pending_activation_links: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE status = 'pending_activation'
            AND revoked_at IS NULL
            AND used_at IS NULL
            AND expires_at > ?
        `,
        [now],
      ),
    ),
    activated_links: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE status = 'active'
            AND activated_at IS NOT NULL
            AND revoked_at IS NULL
            AND used_at IS NULL
            AND expires_at > ?
        `,
        [now],
      ),
    ),
    expired_links: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE expires_at <= ?
            AND used_at IS NULL
            AND revoked_at IS NULL
        `,
        [now],
      ),
    ),
    used_links: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE used_at IS NOT NULL
             OR status = 'used'
        `,
      ),
    ),
    revoked_links: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE revoked_at IS NOT NULL
             OR status = 'revoked'
        `,
      ),
    ),
    downloads_today: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_events
          WHERE event_at >= ?
            AND event_type = 'document_downloaded'
            AND success = 1
        `,
        [todayIso],
      ),
    ),
    replay_denials_today: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_events
          WHERE event_at >= ?
            AND event_type = 'download_replay_denied'
        `,
        [todayIso],
      ),
    ),
  };

  const integrity = {
    download_links_without_licence: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links dl
          LEFT JOIN document_licences l ON l.id = dl.licence_id
          WHERE l.id IS NULL
        `,
      ),
    ),
    download_events_without_licence: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_events de
          LEFT JOIN document_licences l ON l.id = de.licence_id
          WHERE l.id IS NULL
        `,
      ),
    ),
    email_events_without_related_record: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM cdas_email_events e
          WHERE e.related_record_id IS NOT NULL
            AND e.related_record_type IS NOT NULL
            AND e.related_record_type NOT IN (
              'access_request',
              'licence',
              'download_link',
              'invitation',
              'test'
            )
        `,
      ),
    ),
    active_download_links_missing_activation: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE status = 'active'
            AND activated_at IS NULL
        `,
      ),
    ),
    used_download_links_missing_used_at: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_download_links
          WHERE status = 'used'
            AND used_at IS NULL
        `,
      ),
    ),
  };

  const recent = {
    failed_emails: await all(
      db,
      `
        SELECT
          id,
          email_type AS event_type,
          related_type,
          related_id,
          status,
          recipient_email,
          provider,
          provider_message_id,
          subject,
          error,
          message,
          retryable,
          retry_count,
          next_retry_after,
          created_at,
          resolved_at,
          resolved_by,
          resolution_note
        FROM cdas_email_events
        WHERE status IN ('failed', 'bounced', 'complained', 'blocked')
        ORDER BY created_at DESC
        LIMIT 10
      `,
    ),

    pending_requests: await all(
      db,
      `
        SELECT
          id,
          document_id,
          document_version,
          name,
          email,
          status,
          requested_at,
          email_verified_at
        FROM document_access_requests
        WHERE status IN ('created', 'email_pending', 'email_sent', 'pending_approval', 'pending_review')
        ORDER BY requested_at DESC
        LIMIT 10
      `,
    ),

    recent_licences: await all(
      db,
      `
        SELECT
          l.id,
          l.licence_number,
          l.document_id,
          l.document_version,
          l.licence_holder_name,
          l.organisation_name,
          l.status,
          l.issued_at,
          l.generated_pdf_status,
          l.generated_pdf_object_key,
          l.generated_pdf_sha256,
          l.generated_pdf_size_bytes,
          l.generated_pdf_created_at,

          (
            SELECT dl.id
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_id,

          (
            SELECT dl.download_reference
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_reference,

          (
            SELECT dl.status
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_status,

          (
            SELECT dl.created_at
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_created_at,

          (
            SELECT dl.activated_at
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_activated_at,

          (
            SELECT dl.used_at
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_used_at,

          (
            SELECT dl.revoked_at
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_revoked_at,

          (
            SELECT dl.superseded_at
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_superseded_at,

          (
            SELECT dl.failure_reason
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
            ORDER BY dl.created_at DESC
            LIMIT 1
          ) AS latest_download_link_failure_reason,

          (
            SELECT COUNT(*)
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
              AND dl.status IN ('created', 'pending_generation', 'pending_activation', 'active', 'sent')
              AND dl.used_at IS NULL
              AND dl.revoked_at IS NULL
              AND dl.superseded_at IS NULL
          ) AS open_download_link_count,

          (
            SELECT COUNT(*)
            FROM document_download_links dl
            WHERE dl.licence_id = l.id
              AND dl.status = 'pending_activation'
              AND dl.used_at IS NULL
              AND dl.revoked_at IS NULL
              AND dl.superseded_at IS NULL
          ) AS pending_activation_link_count,

          (
            SELECT de.event_at
            FROM document_download_events de
            WHERE de.licence_id = l.id
              AND de.event_type = 'download_link_reissued_pending_activation'
            ORDER BY de.event_at DESC
            LIMIT 1
          ) AS latest_reissue_event_at,

          (
            SELECT de.download_id
            FROM document_download_events de
            WHERE de.licence_id = l.id
              AND de.event_type = 'download_link_reissued_pending_activation'
            ORDER BY de.event_at DESC
            LIMIT 1
          ) AS latest_reissue_download_id,

          (
            SELECT de.failure_reason
            FROM document_download_events de
            WHERE de.licence_id = l.id
              AND de.event_type = 'download_link_reissued_pending_activation'
            ORDER BY de.event_at DESC
            LIMIT 1
          ) AS latest_reissue_detail,

          (
            SELECT old.download_reference
            FROM document_download_links old
            WHERE old.licence_id = l.id
              AND old.superseded_at IS NOT NULL
            ORDER BY old.superseded_at DESC
            LIMIT 1
          ) AS latest_superseded_reference,

          (
            SELECT old.id
            FROM document_download_links old
            WHERE old.licence_id = l.id
              AND old.superseded_at IS NOT NULL
            ORDER BY old.superseded_at DESC
            LIMIT 1
          ) AS latest_superseded_link_id,

          (
            SELECT old.status
            FROM document_download_links old
            WHERE old.licence_id = l.id
              AND old.superseded_at IS NOT NULL
            ORDER BY old.superseded_at DESC
            LIMIT 1
          ) AS latest_superseded_link_status,

          (
            SELECT old.superseded_at
            FROM document_download_links old
            WHERE old.licence_id = l.id
              AND old.superseded_at IS NOT NULL
            ORDER BY old.superseded_at DESC
            LIMIT 1
          ) AS latest_superseded_at

        FROM document_licences l
        ORDER BY l.issued_at DESC
        LIMIT 10
      `,
    ),
    recent_downloads: await all(
      db,
      `
        SELECT
          de.id,
          de.download_id,
          de.licence_number,
          de.document_id,
          de.document_version,
          de.licence_holder_name,
          de.event_type,
          de.event_at,
          de.success,
          de.failure_reason,
          dl.download_reference,
          dl.status AS download_link_status,
          dl.created_at AS download_link_created_at,
          dl.activated_at AS download_link_activated_at,
          dl.used_at AS download_link_used_at,
          dl.revoked_at AS download_link_revoked_at,
          dl.superseded_at AS download_link_superseded_at
        FROM document_download_events de
        LEFT JOIN document_download_links dl
          ON dl.id = de.download_id
        ORDER BY de.event_at DESC
        LIMIT 10
      `,
    ),

  };

  const queryFailures = compactFailureList({
    core,
    email,
    workflow,
    licences,
    downloads,
    integrity,
    recent_failed_emails: recent.failed_emails,
    recent_pending_requests: recent.pending_requests,
    recent_licences: recent.recent_licences,
    recent_downloads: recent.recent_downloads,
  });

  const health = {
    system_status: "unknown",
    note: "Operations endpoint is read-only. Full health is available at /api/admin/cdas/health.",
  };

  const status = classifyOperationsStatus({
    health,
    email,
    workflow,
    integrity,
    queryFailures,
  });

  const notices = [];
  const warnings = [];

  if (workflow.pending_verification > 0) {
    notices.push("pending_verification_backlog");
  }

  if (workflow.verified_unlicensed > 0) {
    notices.push("verified_requests_waiting_for_licence");
  }

  if (workflow.pending_approval > 0) {
    notices.push("requests_waiting_for_admin_approval");
  }

  if (workflow.generated_pdfs_without_links > 0) {
    notices.push("generated_pdfs_waiting_for_download_links");
  }

  if (downloads.pending_activation_links > 0) {
    notices.push("download_links_waiting_for_activation");
  }

  if (downloads.activated_links > 0) {
    notices.push("active_download_links_waiting_for_delivery_or_download");
  }

  if (email.retryable_events > 0) {
    notices.push("retryable_email_events_present");
  }

  if (email.failed_events > 0) {
    warnings.push("failed_email_events_present");
  }

  if (licences.generated_missing_hash > 0) {
    warnings.push("generated_pdf_hashes_missing");
  }

  if (integrity.download_links_without_licence > 0) {
    warnings.push("download_links_without_licence");
  }

  if (integrity.download_events_without_licence > 0) {
    warnings.push("download_events_without_licence");
  }

  if (integrity.active_download_links_missing_activation > 0) {
    warnings.push("active_download_links_missing_activation_timestamp");
  }

  if (integrity.used_download_links_missing_used_at > 0) {
    warnings.push("used_download_links_missing_used_timestamp");
  }

  if (queryFailures.length > 0) {
    warnings.push("operations_query_failures_present");
  }

  return json({
    ok: true,
    system: "cdas",
    endpoint: "/api/admin/cdas/operations",
    generated_at: now,
    status,
    warnings,
    notices,
    core,
    email,
    workflow,
    licences,
    downloads,
    integrity,
    recent,
    query_failures: queryFailures,
    links: {
      health_dashboard: "/admin/cdas-health",
      email_events: "/admin/cdas-email-events",
      access_requests: "/admin/cdas-access-requests",
      documents: "/admin/cdas-documents",
      licences: "/admin/cdas-licences",
      download_links: "/admin/cdas-download-links",
      downloads: "/admin/downloads",
      licence_terms: "/admin/cdas-licence-terms",
    },
  });
}