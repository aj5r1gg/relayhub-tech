import { jsonResponse } from "../shared.js";
import {
  evaluateCdasGeneratedPdfToDownloadLinkEligibility,
} from "./generated-pdf-to-download-link-gate.js";

const REISSUE_CANDIDATE_STATUSES = new Set([
  "revoked",
  "superseded",
  "failed",
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseStatus(value) {
  return cleanText(value).toLowerCase();
}

function numberValue(value) {
  return Number(value || 0);
}

function getDb(env) {
  return env.RELAYHUB_DB || env.DB || env.DATABASE || null;
}

async function getDownloadLink(env, downloadId) {
  const db = getDb(env);

  if (!db) {
    throw new Error("D1 database binding was not found.");
  }

  return await db
    .prepare(
      `SELECT
         id,
         licence_id,
         document_id,
         status,
         created_at,
         expires_at,
         used_at,
         revoked_at,
         superseded_at,
         failure_reason,
         download_reference,
         activated_at,
         generated_pdf_object_key,
         generated_pdf_sha256,
         generated_pdf_size_bytes,
         generated_pdf_created_at
       FROM document_download_links
       WHERE id = ?
       LIMIT 1`
    )
    .bind(downloadId)
    .first();
}

async function getOpenReplacementCounts(env, licenceId, currentDownloadId) {
  const db = getDb(env);

  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total_open,
         SUM(CASE WHEN status = 'created' THEN 1 ELSE 0 END) AS created_count,
         SUM(CASE WHEN status = 'pending_generation' THEN 1 ELSE 0 END) AS pending_generation_count,
         SUM(CASE WHEN status = 'pending_activation' THEN 1 ELSE 0 END) AS pending_activation_count,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count
       FROM document_download_links
       WHERE licence_id = ?
         AND id <> ?
         AND status IN ('created', 'pending_generation', 'pending_activation', 'active', 'sent')
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND superseded_at IS NULL`
    )
    .bind(licenceId, currentDownloadId)
    .first();

  return {
    total_open: numberValue(row?.total_open),
    created: numberValue(row?.created_count),
    pending_generation: numberValue(row?.pending_generation_count),
    pending_activation: numberValue(row?.pending_activation_count),
    active: numberValue(row?.active_count),
    sent: numberValue(row?.sent_count),
  };
}

function isExpired(link) {
  const expiresAt = cleanText(link?.expires_at);

  if (!expiresAt) return false;

  const timestamp = Date.parse(expiresAt);

  if (!Number.isFinite(timestamp)) return false;

  return timestamp <= Date.now();
}

function publicOldDownloadLink(link) {
  if (!link) return null;

  return {
    id: link.id,
    licence_id: link.licence_id,
    document_id: link.document_id,
    download_reference: link.download_reference,
    status: link.status,
    created_at: link.created_at,
    expires_at: link.expires_at,
    activated_at: link.activated_at,
    used_at: link.used_at,
    revoked_at: link.revoked_at,
    superseded_at: link.superseded_at,
    expired: isExpired(link),
    failure_reason: link.failure_reason,
    generated_pdf: {
      object_key_present: Boolean(link.generated_pdf_object_key),
      sha256_present: Boolean(link.generated_pdf_sha256),
      size_bytes: link.generated_pdf_size_bytes || null,
      created_at: link.generated_pdf_created_at || null,
    },
  };
}

function buildCandidateDecision(link) {
  const blockers = [];
  const warnings = [];

  if (!link) {
    blockers.push("download_link_not_found");
    return { blockers, warnings };
  }

  const status = normaliseStatus(link.status);

  if (!link.licence_id) {
    blockers.push("download_link_missing_licence_id");
  }

  if (!link.download_reference) {
    warnings.push("download_reference_missing");
  }

  if (status === "used" || link.used_at) {
    blockers.push("used_download_link_not_reissue_candidate");
  }

  if (
    !REISSUE_CANDIDATE_STATUSES.has(status) &&
    !(isExpired(link) && status !== "used" && !link.used_at)
  ) {
    blockers.push(`download_link_status_${status || "missing"}_not_reissue_candidate`);
  }

  if (status === "active" && !isExpired(link)) {
    blockers.push("active_download_link_not_expired");
  }

  if (status === "pending_activation" && !link.revoked_at && !link.superseded_at) {
    blockers.push("pending_activation_link_should_be_revoked_before_reissue");
  }

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
  };
}

export async function evaluateCdasDownloadLinkReissueEligibility(env, downloadId) {
  const id = cleanText(downloadId);
  const link = await getDownloadLink(env, id);

  if (!link) {
    return {
      ok: false,
      eligible: false,
      decision: "blocked",
      blockers: ["download_link_not_found"],
      warnings: [],
      old_download_link: null,
      licence: null,
      counts: {
        open_replacement_links: 0,
      },
      controls: {
        mutates_database: false,
        creates_download_link: false,
        activates_link: false,
        sends_email: false,
        serves_download: false,
        modifies_licence: false,
        deletes_r2_object: false,
        returns_raw_token: false,
      },
    };
  }

  const candidate = buildCandidateDecision(link);

  let licenceGate = null;
  let openReplacementCounts = {
    total_open: 0,
    created: 0,
    pending_generation: 0,
    pending_activation: 0,
    active: 0,
    sent: 0,
  };

  if (link.licence_id) {
    licenceGate = await evaluateCdasGeneratedPdfToDownloadLinkEligibility(
      env,
      link.licence_id
    );

    openReplacementCounts = await getOpenReplacementCounts(
      env,
      link.licence_id,
      link.id
    );
  }

  const blockers = [
    ...candidate.blockers,
    ...(licenceGate?.blockers || []),
  ];

  const warnings = [
    ...candidate.warnings,
    ...(licenceGate?.warnings || []),
  ];

  if (openReplacementCounts.total_open > 0) {
    blockers.push("open_replacement_link_already_exists_for_licence");
  }

  const uniqueBlockers = Array.from(new Set(blockers));
  const uniqueWarnings = Array.from(new Set(warnings));

  const eligible = uniqueBlockers.length === 0;

  return {
    ok: true,
    action: "download_link_reissue_eligibility",
    eligible,
    decision: eligible ? "eligible_for_controlled_reissue" : "blocked",
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    old_download_link: publicOldDownloadLink(link),
    licence: licenceGate?.licence || null,
    document: licenceGate?.document || null,
    release_policy: licenceGate?.release_policy || null,
    generated_pdf_object: licenceGate?.generated_pdf_object || null,
    counts: {
      existing_download_links_total:
        licenceGate?.counts?.download_links_total ?? null,
      conflicting_open_download_links:
        licenceGate?.counts?.conflicting_open_download_links ?? null,
      open_replacement_links: openReplacementCounts.total_open,
      open_replacement_links_created: openReplacementCounts.created,
      open_replacement_links_pending_generation:
        openReplacementCounts.pending_generation,
      open_replacement_links_pending_activation:
        openReplacementCounts.pending_activation,
      open_replacement_links_active: openReplacementCounts.active,
      open_replacement_links_sent: openReplacementCounts.sent,
    },
    next_allowed_action: eligible
      ? "create_replacement_pending_activation_download_link"
      : null,
    controls: {
      mutates_database: false,
      creates_download_link: false,
      activates_link: false,
      sends_email: false,
      serves_download: false,
      modifies_licence: false,
      deletes_r2_object: false,
      returns_raw_token: false,
      exposes_token_hash: false,
      checks_existing_pdf_evidence: true,
      checks_open_replacement_conflicts: true,
    },
    safety: {
      download_link_created: false,
      old_link_modified: false,
      licence_modified: false,
      email_sent: false,
      pdf_served: false,
      r2_object_deleted: false,
    },
  };
}

export async function getCdasDownloadLinkReissueEligibility(
  request,
  env,
  downloadId
) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to check CDAS download-link reissue eligibility.",
      },
      405
    );
  }

  const id = cleanText(downloadId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_download_link_id",
        message: "Download link ID is required.",
      },
      400
    );
  }

  const result = await evaluateCdasDownloadLinkReissueEligibility(env, id);

  if (!result.old_download_link) {
    return jsonResponse(
      {
        ok: false,
        error: "download_link_not_found",
        eligible: false,
        decision: "blocked",
        blockers: ["download_link_not_found"],
        controls: result.controls,
        safety: result.safety,
      },
      404
    );
  }

  return jsonResponse(result);
}
