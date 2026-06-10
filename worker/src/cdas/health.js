import { jsonResponse } from "../shared.js";

async function count(env, sql) {
  const row = await env.RELAYHUB_DB.prepare(sql).first();
  return Number(row?.total || 0);
}

async function latest(env, sql) {
  const row = await env.RELAYHUB_DB.prepare(sql).first();
  return row?.latest_at || null;
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
    documentsTotal,
    activeDocuments,
    accessRequestsTotal,
    licencesTotal,
    downloadLinksTotal,
    emailEventsTotal,
    failedUnresolvedEmailEvents,
    retryableUnresolvedEmailEvents,
    latestEmailEventAt,
    latestDownloadEventAt,
  ] = await Promise.all([
    count(env, "SELECT COUNT(*) AS total FROM documents"),
    count(env, "SELECT COUNT(*) AS total FROM documents WHERE status = 'active'"),
    count(env, "SELECT COUNT(*) AS total FROM document_access_requests"),
    count(env, "SELECT COUNT(*) AS total FROM document_licences"),
    count(env, "SELECT COUNT(*) AS total FROM document_download_links"),
    count(env, "SELECT COUNT(*) AS total FROM cdas_email_events"),
    count(
      env,
      "SELECT COUNT(*) AS total FROM cdas_email_events WHERE status = 'failed' AND resolved_at IS NULL"
    ),
    count(
      env,
      "SELECT COUNT(*) AS total FROM cdas_email_events WHERE retryable = 1 AND resolved_at IS NULL"
    ),
    latest(env, "SELECT MAX(created_at) AS latest_at FROM cdas_email_events"),
    latest(env, "SELECT MAX(event_at) AS latest_at FROM document_download_events"),
  ]);

  const warnings = [];

  if (activeDocuments < 1) {
    warnings.push("no_active_documents");
  }

  if (failedUnresolvedEmailEvents > 0) {
    warnings.push("unresolved_failed_email_events");
  }

  if (retryableUnresolvedEmailEvents > 0) {
    warnings.push("unresolved_retryable_email_events");
  }

  return jsonResponse({
    ok: true,
    checked_at: new Date().toISOString(),
    system_status: warnings.length ? "attention_required" : "healthy",
    warnings,
    metrics: {
      documents_total: documentsTotal,
      active_documents: activeDocuments,
      access_requests_total: accessRequestsTotal,
      licences_total: licencesTotal,
      download_links_total: downloadLinksTotal,
      email_events_total: emailEventsTotal,
      failed_unresolved_email_events: failedUnresolvedEmailEvents,
      retryable_unresolved_email_events: retryableUnresolvedEmailEvents,
      latest_email_event_at: latestEmailEventAt,
      latest_download_event_at: latestDownloadEventAt,
    },
  });
}