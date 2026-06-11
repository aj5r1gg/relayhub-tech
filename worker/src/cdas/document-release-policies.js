import { jsonResponse } from "../shared.js";

const BOOLEAN_FIELDS = [
  "listed_publicly",
  "request_button_enabled",
  "public_download_enabled",
  "public_summary_allowed",
  "approval_required",
  "email_verification_required",
  "manual_review_required",
  "invitation_required",
  "payment_required",
  "watermark_required",
  "personalised_pdf_required",
  "download_id_required",
  "single_use_link_required",
  "evidence_bundle_required",
  "redistribution_allowed",
  "commercial_use_allowed",
  "derivative_use_allowed",
  "training_ai_allowed",
  "public_quoting_allowed",
  "abuse_screening_required",
  "disposable_email_block_required",
  "business_context_required",
  "source_hash_required",
];

const REQUESTABLE_ACCESS_MODES = new Set([
  "verified_public",
  "licensed_public",
  "controlled_disclosure",
  "restricted_controlled_disclosure",
  "partner_only",
  "invite_only",
  "paid_verified",
]);

const PUBLIC_DOWNLOAD_ACCESS_MODES = new Set([
  "public_download",
]);

const ACTIVE_LICENCE_TERM_STATUSES = new Set([
  "active",
  "approved",
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseDocumentId(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normaliseVersion(value) {
  return cleanText(value)
    .replace(/^v/i, "")
    .replace(/_/g, ".")
    .trim();
}

function toBool(value) {
  return value === true || value === 1 || value === "1";
}

function normalisePolicyRow(row) {
  if (!row) return null;

  const policy = { ...row };

  for (const field of BOOLEAN_FIELDS) {
    policy[field] = toBool(policy[field]);
  }

  return policy;
}

function nowIso() {
  return new Date().toISOString();
}

function methodNotAllowed(message, allow = "GET") {
  return jsonResponse(
    {
      ok: false,
      error: "method_not_allowed",
      message,
    },
    { status: 405, headers: { allow } }
  );
}

function createDefaultDenyPolicy({ documentId, documentVersion, reason }) {
  return {
    id: null,
    document_id: normaliseDocumentId(documentId) || "unknown",
    document_version: normaliseVersion(documentVersion),
    release_class: "UNRELEASED",
    policy_status: "missing",
    public_visibility: "hidden",
    access_mode: "not_available",
    release_state: "draft",

    licence_terms_id: null,
    licence_terms_version: null,
    licence_terms_status: "missing",
    request_intake_policy_id: null,

    listed_publicly: false,
    request_button_enabled: false,
    public_download_enabled: false,
    public_summary_allowed: false,

    approval_required: true,
    email_verification_required: true,
    manual_review_required: true,
    invitation_required: false,
    payment_required: false,

    watermark_required: true,
    personalised_pdf_required: true,
    download_id_required: true,
    single_use_link_required: true,
    evidence_bundle_required: true,

    redistribution_allowed: false,
    commercial_use_allowed: false,
    derivative_use_allowed: false,
    training_ai_allowed: false,
    public_quoting_allowed: false,

    abuse_screening_required: true,
    disposable_email_block_required: true,
    business_context_required: true,
    source_hash_required: true,

    public_label: "Not available",
    public_action_label: "Not available",
    public_message: "This document is not currently available.",
    admin_note:
      reason || "No active release policy exists. Default deny applies.",

    effective_from: null,
    effective_until: null,
    supersedes_policy_id: null,
    approved_by: null,
    approved_at: null,
    approval_note: null,
    created_at: null,
    updated_at: null,
    created_by: null,
    updated_by: null,

    default_deny: true,
    default_deny_reason: reason || "release_policy_missing",
  };
}

async function safeFirst(statement, bindings = []) {
  return statement.bind(...bindings).first();
}

async function safeAll(statement, bindings = []) {
  const result = await statement.bind(...bindings).all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function resolveDocument(env, documentId, documentVersion = "") {
  const ref = cleanText(documentId);
  const normalisedRef = normaliseDocumentId(ref);
  const version = normaliseVersion(documentVersion);

  if (!ref && !normalisedRef) {
    return null;
  }

  const bindings = [];
  let where = "(id = ? OR slug = ?)";
  bindings.push(ref, normalisedRef);

  if (version) {
    where += " AND version = ?";
    bindings.push(version);
  }

  return safeFirst(
    env.RELAYHUB_DB.prepare(
      `SELECT
         id,
         slug,
         title,
         version,
         status,
         classification,
         access_class,
         source_object,
         source_sha256,
         licence_terms_version,
         is_listed,
         requires_approval,
         updated_at
       FROM documents
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT 1`
    ),
    bindings
  );
}

async function resolveLicenceTerms(env, policy) {
  const termsId = cleanText(policy?.licence_terms_id);
  const termsVersion = cleanText(policy?.licence_terms_version);

  if (!termsId && !termsVersion) {
    return null;
  }

  return safeFirst(
    env.RELAYHUB_DB.prepare(
      `SELECT
         id,
         version,
         title,
         status,
         body_sha256,
         effective_from,
         effective_to,
         created_at,
         retired_at
       FROM licence_terms
       WHERE id = ? OR version = ?
       LIMIT 1`
    ),
    [termsId, termsVersion]
  );
}

async function findReleasePolicy(env, documentId, documentVersion = "") {
  const ref = cleanText(documentId);
  const normalisedRef = normaliseDocumentId(ref);
  const version = normaliseVersion(documentVersion);

  if (!ref && !normalisedRef) {
    return null;
  }

  const bindings = [];
  const where = [];

  where.push("(document_id = ? OR document_id = ?)");
  bindings.push(ref, normalisedRef);

  if (version) {
    where.push("document_version = ?");
    bindings.push(version);
  }

  const row = await safeFirst(
    env.RELAYHUB_DB.prepare(
      `SELECT *
       FROM document_release_policies
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE policy_status
           WHEN 'active' THEN 0
           WHEN 'approved' THEN 1
           WHEN 'pending_review' THEN 2
           WHEN 'draft' THEN 3
           WHEN 'suspended' THEN 4
           WHEN 'superseded' THEN 5
           WHEN 'retired' THEN 6
           ELSE 9
         END,
         updated_at DESC
       LIMIT 1`
    ),
    bindings
  );

  return normalisePolicyRow(row);
}

function evaluatePolicy({ policy, document, licenceTerms, purpose = "request" }) {
  const blockers = [];
  const warnings = [];
  const notices = [];

  if (!policy) {
    blockers.push("release_policy_missing");
  }

  if (policy?.default_deny) {
    blockers.push(policy.default_deny_reason || "default_deny");
  }

  if (!document) {
    blockers.push("document_record_missing");
  }

  if (document && document.status !== "active") {
    blockers.push(`document_status_${document.status || "unknown"}`);
  }

  if (policy && policy.policy_status !== "active") {
    blockers.push(`policy_status_${policy.policy_status || "unknown"}`);
  }

  if (policy && policy.effective_from) {
    const fromTime = Date.parse(policy.effective_from);

    if (Number.isFinite(fromTime) && Date.now() < fromTime) {
      blockers.push("policy_not_yet_effective");
    }
  }

  if (policy && policy.effective_until) {
    const untilTime = Date.parse(policy.effective_until);

    if (Number.isFinite(untilTime) && Date.now() > untilTime) {
      blockers.push("policy_expired");
    }
  }

  if (policy?.source_hash_required && !cleanText(document?.source_sha256)) {
    blockers.push("document_source_sha256_missing");
  }

  if (purpose === "public_catalogue") {
    if (!policy?.listed_publicly) {
      blockers.push("not_listed_publicly");
    }
  }

  if (purpose === "request") {
    if (!policy?.request_button_enabled) {
      blockers.push("request_button_disabled");
    }

    if (!REQUESTABLE_ACCESS_MODES.has(policy?.access_mode)) {
      blockers.push(`access_mode_not_requestable_${policy?.access_mode || "unknown"}`);
    }

    if (policy?.release_state !== "request_open") {
      blockers.push(`release_state_${policy?.release_state || "unknown"}`);
    }

    if (!cleanText(policy?.licence_terms_id) && !cleanText(policy?.licence_terms_version)) {
      blockers.push("licence_terms_missing");
    }

    if (!ACTIVE_LICENCE_TERM_STATUSES.has(cleanText(policy?.licence_terms_status).toLowerCase())) {
      blockers.push(`licence_terms_status_${policy?.licence_terms_status || "missing"}`);
    }

    if (!licenceTerms) {
      blockers.push("licence_terms_record_missing");
    }

    if (
      licenceTerms &&
      !ACTIVE_LICENCE_TERM_STATUSES.has(cleanText(licenceTerms.status).toLowerCase())
    ) {
      blockers.push(`licence_terms_record_status_${licenceTerms.status || "unknown"}`);
    }

    if (policy?.abuse_screening_required && !cleanText(policy?.request_intake_policy_id)) {
      blockers.push("request_intake_policy_missing");
    }
  }

  if (purpose === "public_download") {
    if (!policy?.public_download_enabled) {
      blockers.push("public_download_disabled");
    }

    if (!PUBLIC_DOWNLOAD_ACCESS_MODES.has(policy?.access_mode)) {
      blockers.push(`access_mode_not_public_download_${policy?.access_mode || "unknown"}`);
    }

    if (policy?.release_state !== "public_released") {
      blockers.push(`release_state_${policy?.release_state || "unknown"}`);
    }
  }

  if (policy?.manual_review_required) {
    notices.push("manual_review_required");
  }

  if (policy?.approval_required) {
    notices.push("approval_required");
  }

  if (policy?.disposable_email_block_required) {
    notices.push("disposable_email_block_required");
  }

  const allowed = blockers.length === 0;

  let decision = "hard_block";

  if (allowed && policy?.manual_review_required) {
    decision = "manual_review_required";
  } else if (allowed && policy?.approval_required) {
    decision = "allow_with_review";
  } else if (allowed) {
    decision = "allow";
  }

  return {
    allowed,
    decision,
    purpose,
    evaluated_at: nowIso(),
    blockers,
    warnings,
    notices,
    public_message: allowed
      ? "This document is available under the current release policy."
      : policy?.public_message || "This document is not currently available.",
    admin_message: allowed
      ? "Release policy gate passed."
      : "Release policy gate blocked access.",
    next_state: allowed ? "policy_gate_passed" : "not_created",
  };
}

export async function getCdasDocumentReleasePolicyDecision(
  env,
  {
    document_id,
    document_version = "",
    purpose = "request",
  } = {}
) {
  const documentId = cleanText(document_id);
  const requestedVersion = normaliseVersion(document_version);

  const document = await resolveDocument(env, documentId, requestedVersion);
  const effectiveDocumentId = document?.id || document?.slug || documentId;
  const effectiveVersion = requestedVersion || normaliseVersion(document?.version);

  const policy =
    (await findReleasePolicy(env, effectiveDocumentId, effectiveVersion)) ||
    createDefaultDenyPolicy({
      documentId: effectiveDocumentId || documentId,
      documentVersion: effectiveVersion,
      reason: "release_policy_missing",
    });

  const licenceTerms = await resolveLicenceTerms(env, policy);

  const evaluation = evaluatePolicy({
    policy,
    document,
    licenceTerms,
    purpose,
  });

  return {
    ok: true,
    document: document || null,
    policy,
    licence_terms: licenceTerms || null,
    evaluation,
  };
}

export async function listCdasDocumentReleasePolicies(request, env) {
  if (request.method !== "GET") {
    return methodNotAllowed("Use GET to list CDAS document release policies.");
  }

  const url = new URL(request.url);

  const q = cleanText(url.searchParams.get("q"));
  const status = cleanText(url.searchParams.get("policy_status"));
  const releaseClass = cleanText(url.searchParams.get("release_class"));
  const publicOnly = url.searchParams.get("public") === "1";
  const limit = Math.min(
    Math.max(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1),
    250
  );
  const offset = Math.max(Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  const where = [];
  const bindings = [];

  if (q) {
    where.push(
      "(id LIKE ? OR document_id LIKE ? OR document_version LIKE ? OR public_label LIKE ?)"
    );
    const like = `%${q}%`;
    bindings.push(like, like, like, like);
  }

  if (status) {
    where.push("policy_status = ?");
    bindings.push(status);
  }

  if (releaseClass) {
    where.push("release_class = ?");
    bindings.push(releaseClass);
  }

  if (publicOnly) {
    where.push("listed_publicly = 1");
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await safeFirst(
    env.RELAYHUB_DB.prepare(
      `SELECT COUNT(*) AS total
       FROM document_release_policies
       ${whereSql}`
    ),
    bindings
  );

  const rows = await safeAll(
    env.RELAYHUB_DB.prepare(
      `SELECT *
       FROM document_release_policies
       ${whereSql}
       ORDER BY
         listed_publicly DESC,
         document_id ASC,
         document_version ASC,
         updated_at DESC
       LIMIT ?
       OFFSET ?`
    ),
    [...bindings, limit, offset]
  );

  const normalisedRows = rows.map(normalisePolicyRow);

  return jsonResponse({
    ok: true,
    total: Number(totalRow?.total || 0),
    limit,
    offset,
    filters: {
      q: q || null,
      policy_status: status || null,
      release_class: releaseClass || null,
      public: publicOnly,
    },
    rows: normalisedRows,
    default_deny_rule:
      "A document without an active release policy is not public, not requestable, and not downloadable.",
  });
}

export async function getCdasDocumentReleasePolicy(request, env, documentIdOrSlug) {
  if (request.method !== "GET") {
    return methodNotAllowed("Use GET to read a CDAS document release policy.");
  }

  const url = new URL(request.url);
  const version = normaliseVersion(url.searchParams.get("version"));
  const purpose = cleanText(url.searchParams.get("purpose")) || "request";

  const allowedPurposes = new Set([
    "request",
    "public_catalogue",
    "public_download",
  ]);

  const safePurpose = allowedPurposes.has(purpose) ? purpose : "request";

  const decision = await getCdasDocumentReleasePolicyDecision(env, {
    document_id: documentIdOrSlug,
    document_version: version,
    purpose: safePurpose,
  });

  return jsonResponse(decision);
}