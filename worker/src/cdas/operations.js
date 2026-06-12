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
    integrity.email_events_with_unknown_related_type > 0
  ) {
    return "warning";
  }

  if (email.unresolved_failed_events > 0 || email.retryable_events > 0) {
    return "attention";
  }

  if (
    workflow.pending_verification > 0 ||
    workflow.verified_unlicensed > 0 ||
    workflow.generated_pdfs_without_links > 0 ||
    email.failed_events > 0
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
          WHERE status = 'pending_approval'
        `,
      ),
    ),
    pending_review: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests
          WHERE status = 'pending_review'
        `,
      ),
    ),
    on_hold: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests
          WHERE status = 'on_hold'
        `,
      ),
    ),
    review_approved: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests
          WHERE status = 'review_approved'
        `,
      ),
    ),
    rejected: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests
          WHERE status = 'rejected'
        `,
      ),
    ),
    licence_issued: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_access_requests
          WHERE status = 'licence_issued'
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
    active: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM document_licences
          WHERE status = 'active'
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
          WHERE status IN ('created', 'sent', 'active')
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
            AND success = 1
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

    /*
      cdas_email_events real schema uses:
      - related_type
      - related_id

      This check deliberately validates known related_type values only.
      It does not yet prove that the related_id exists in the relevant table.
      That can be added later as a stronger integrity check per related_type.
    */
    email_events_with_unknown_related_type: numberValue(
      await first(
        db,
        `
          SELECT COUNT(*) AS total
          FROM cdas_email_events e
          WHERE e.related_id IS NOT NULL
            AND e.related_type IS NOT NULL
            AND e.related_type NOT IN (
              'access_request',
              'licence',
              'download_link',
              'invitation',
              'test'
            )
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
          retryable,
          retry_count,
          retry_of_event_id,
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
          r.id,
          r.document_id,
          r.document_version,
          r.name,
          r.email,
          r.email_normalised,
          r.status,
          r.requested_at,
          r.email_verified_at,
          r.email_delivery_status,
          r.risk_score,
          r.risk_flags,
          r.approval_note,
          r.denial_reason,
          (
            SELECT e.event_type
            FROM document_access_request_review_events e
            WHERE e.request_id = r.id
            ORDER BY e.created_at DESC
            LIMIT 1
          ) AS latest_review_event,
          (
            SELECT e.created_at
            FROM document_access_request_review_events e
            WHERE e.request_id = r.id
            ORDER BY e.created_at DESC
            LIMIT 1
          ) AS latest_review_at
        FROM document_access_requests r
        WHERE r.status IN (
          'created',
          'email_pending',
          'email_sent',
          'pending_approval',
          'pending_review',
          'on_hold',
          'review_approved',
          'rejected'
        )
        ORDER BY r.requested_at DESC
        LIMIT 25
      `,
    ),
    recent_licences: await all(
      db,
      `
        SELECT
          id,
          licence_number,
          document_id,
          document_version,
          licence_holder_name,
          organisation_name,
          status,
          issued_at
        FROM document_licences
        ORDER BY issued_at DESC
        LIMIT 10
      `,
    ),
    recent_downloads: await all(
      db,
      `
        SELECT
          id,
          download_id,
          licence_number,
          document_id,
          document_version,
          licence_holder_name,
          event_at,
          success,
          failure_reason
        FROM document_download_events
        ORDER BY event_at DESC
        LIMIT 10
      `,
    ),
  };

  const queryFailures = compactFailureList({
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

  if (email.retryable_events > 0) {
    notices.push("retryable_email_events_present");
  }

  if (email.failed_events > 0 && email.unresolved_failed_events === 0) {
    notices.push("historical_failed_email_events_present");
  }

  if (email.unresolved_failed_events > 0) {
    warnings.push("unresolved_failed_email_events_present");
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

  if (integrity.email_events_with_unknown_related_type > 0) {
    warnings.push("email_events_with_unknown_related_type");
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