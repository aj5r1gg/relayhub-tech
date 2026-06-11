import { jsonResponse, methodNotAllowed } from "../shared.js";

import {
  getCdasDocumentReleasePolicyDecision,
} from "./document-release-policies.js";

const ROLE_ACCOUNT_PREFIXES = new Set([
  "admin",
  "administrator",
  "contact",
  "hello",
  "info",
  "office",
  "sales",
  "support",
  "team",
  "webmaster",
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function getEmailParts(email) {
  const normalised = normaliseEmail(email);
  const atIndex = normalised.lastIndexOf("@");

  if (atIndex <= 0 || atIndex === normalised.length - 1) {
    return {
      valid: false,
      email: normalised,
      local: "",
      domain: "",
    };
  }

  return {
    valid: true,
    email: normalised,
    local: normalised.slice(0, atIndex),
    domain: normalised.slice(atIndex + 1),
  };
}

function isRoleAccount(local) {
  const firstPart = cleanText(local).toLowerCase().split(/[.+_-]/)[0];
  return ROLE_ACCOUNT_PREFIXES.has(firstPart);
}

async function safeFirst(statement, bindings = []) {
  return statement.bind(...bindings).first();
}

async function countMatching(env, sql, bindings = []) {
  const row = await safeFirst(env.RELAYHUB_DB.prepare(sql), bindings);
  return Number(row?.total || 0);
}

async function getRequestIntakePolicy(env, policyId) {
  const id = cleanText(policyId);

  if (!id) return null;

  return safeFirst(
    env.RELAYHUB_DB.prepare(
      `SELECT *
       FROM request_intake_policies
       WHERE id = ?
       LIMIT 1`
    ),
    [id]
  );
}

async function getEmailDomainPolicy(env, domain) {
  const cleanDomain = cleanText(domain).toLowerCase();

  if (!cleanDomain) return null;

  return safeFirst(
    env.RELAYHUB_DB.prepare(
      `SELECT *
       FROM email_domain_policy
       WHERE domain = ?
       LIMIT 1`
    ),
    [cleanDomain]
  );
}

async function getRecentRequestCounts(env, { email, domain, ip_hash, document_id }) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const emailCount = email
    ? await countMatching(
        env,
        `SELECT COUNT(*) AS total
         FROM document_access_requests
         WHERE email_normalised = ?
           AND requested_at >= ?`,
        [email, since]
      )
    : 0;

  const documentEmailCount = email && document_id
    ? await countMatching(
        env,
        `SELECT COUNT(*) AS total
         FROM document_access_requests
         WHERE email_normalised = ?
           AND document_id = ?
           AND requested_at >= ?`,
        [email, document_id, since]
      )
    : 0;

  const domainCount = domain
    ? await countMatching(
        env,
        `SELECT COUNT(*) AS total
         FROM document_access_requests
         WHERE lower(substr(email_normalised, instr(email_normalised, '@') + 1)) = ?
           AND requested_at >= ?`,
        [domain, since]
      )
    : 0;

  const ipCount = ip_hash
    ? await countMatching(
        env,
        `SELECT COUNT(*) AS total
         FROM document_access_requests
         WHERE ip_hash = ?
           AND requested_at >= ?`,
        [ip_hash, since]
      )
    : 0;

  return {
    email_24h: emailCount,
    document_email_24h: documentEmailCount,
    domain_24h: domainCount,
    ip_24h: ipCount,
  };
}

function bool(value) {
  return value === true || value === 1 || value === "1";
}

function numberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function classifyReleaseClass(value) {
  return cleanText(value).toUpperCase();
}

function isControlledOrRestricted(releaseClass) {
  return [
    "CONTROLLED_DISCLOSURE",
    "RESTRICTED_DISCLOSURE",
    "PARTNER_ONLY",
    "COMMERCIAL_PAID",
  ].includes(classifyReleaseClass(releaseClass));
}

function isRestrictedLike(releaseClass) {
  return [
    "RESTRICTED_DISCLOSURE",
    "PARTNER_ONLY",
    "INTERNAL_ONLY",
  ].includes(classifyReleaseClass(releaseClass));
}

function finalDecision({ blockers, warnings, manualReviewReasons }) {
  if (blockers.length > 0) {
    return {
      allowed: false,
      decision: "hard_block",
      next_state: "not_created",
    };
  }

  if (manualReviewReasons.length > 0 || warnings.length > 0) {
    return {
      allowed: true,
      decision: "manual_review_required",
      next_state: "pending_review",
    };
  }

  return {
    allowed: true,
    decision: "allow_with_review",
    next_state: "pending_review",
  };
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function evaluateCdasRequestIntakePolicy(
  env,
  {
    document_id,
    document_version = "",
    name,
    email,
    organisation_name,
    role_title,
    recipient_category,
    use_case,
    ip_hash,
    user_agent,
  } = {}
) {
  const releaseDecision = await getCdasDocumentReleasePolicyDecision(env, {
    document_id,
    document_version,
    purpose: "request",
  });

  const releasePolicy = releaseDecision?.policy || {};
  const releaseEvaluation = releaseDecision?.evaluation || {};
  const releaseClass = classifyReleaseClass(releasePolicy.release_class);

  const blockers = [];
  const warnings = [];
  const manualReviewReasons = [];
  const riskFlags = [];

  if (!releaseEvaluation.allowed) {
    blockers.push(...(releaseEvaluation.blockers || []));
  }

  const intakePolicy = await getRequestIntakePolicy(
    env,
    releasePolicy.request_intake_policy_id
  );

  if (!intakePolicy) {
    blockers.push("request_intake_policy_missing");
  } else if (intakePolicy.status !== "active") {
    blockers.push(`request_intake_policy_status_${intakePolicy.status || "unknown"}`);
  }

  const emailParts = getEmailParts(email);
  const emailDomainPolicy = await getEmailDomainPolicy(env, emailParts.domain);

  if (!emailParts.valid) {
    blockers.push("invalid_email");
    riskFlags.push("invalid_email");
  }

  if (intakePolicy && bool(intakePolicy.require_name) && !cleanText(name)) {
    blockers.push("name_required");
    riskFlags.push("missing_name");
  }

  if (intakePolicy && bool(intakePolicy.require_email) && !emailParts.valid) {
    blockers.push("valid_email_required");
  }

  if (
    intakePolicy &&
    bool(intakePolicy.require_use_case_for_controlled) &&
    isControlledOrRestricted(releaseClass) &&
    !cleanText(use_case)
  ) {
    manualReviewReasons.push("use_case_missing");
    riskFlags.push("missing_use_case");
  }

  if (
    intakePolicy &&
    bool(intakePolicy.require_use_case_for_restricted) &&
    isRestrictedLike(releaseClass) &&
    !cleanText(use_case)
  ) {
    manualReviewReasons.push("use_case_required_for_restricted");
    riskFlags.push("missing_restricted_use_case");
  }

  if (
    intakePolicy &&
    bool(intakePolicy.require_organisation_for_restricted) &&
    isRestrictedLike(releaseClass) &&
    !cleanText(organisation_name)
  ) {
    manualReviewReasons.push("organisation_required_for_restricted");
    riskFlags.push("missing_organisation");
  }

  if (emailDomainPolicy?.status === "blocked") {
    blockers.push("email_domain_blocked");
    riskFlags.push("blocked_email_domain");
  }

  if (
    intakePolicy &&
    bool(intakePolicy.block_disposable_email) &&
    emailDomainPolicy?.status === "blocked"
  ) {
    blockers.push("disposable_email_domain");
    riskFlags.push("disposable_email");
  }

  if (
    emailDomainPolicy?.status === "review" &&
    isControlledOrRestricted(releaseClass)
  ) {
    manualReviewReasons.push("review_email_domain");
    riskFlags.push("review_email_domain");
  }

  if (emailParts.valid && isRoleAccount(emailParts.local)) {
    warnings.push("role_account_email");
    riskFlags.push("role_account");
  }

  const counts = await getRecentRequestCounts(env, {
    email: emailParts.email,
    domain: emailParts.domain,
    ip_hash,
    document_id: releasePolicy.document_id || document_id,
  });

  if (
    intakePolicy &&
    counts.email_24h >= numberOrDefault(intakePolicy.max_requests_per_email_per_day, 3)
  ) {
    blockers.push("too_many_requests_email");
    riskFlags.push("too_many_requests_email");
  }

  if (
    intakePolicy &&
    counts.document_email_24h >=
      numberOrDefault(intakePolicy.max_requests_per_document_per_email_per_day, 1)
  ) {
    blockers.push("duplicate_document_request_email");
    riskFlags.push("duplicate_document_request");
  }

  if (
    intakePolicy &&
    counts.domain_24h >= numberOrDefault(intakePolicy.max_requests_per_domain_per_day, 10)
  ) {
    manualReviewReasons.push("too_many_requests_domain");
    riskFlags.push("too_many_requests_domain");
  }

  if (
    intakePolicy &&
    ip_hash &&
    counts.ip_24h >= numberOrDefault(intakePolicy.max_requests_per_ip_per_day, 10)
  ) {
    blockers.push("too_many_requests_ip");
    riskFlags.push("too_many_requests_ip");
  }

  const decision = finalDecision({
    blockers,
    warnings,
    manualReviewReasons,
  });

  return {
    ok: true,
    evaluated_at: new Date().toISOString(),
    document_id: releasePolicy.document_id || document_id,
    document_version: releasePolicy.document_version || document_version,

    release_policy: releasePolicy,
    release_evaluation: releaseEvaluation,
    request_intake_policy: intakePolicy || null,
    email_domain_policy: emailDomainPolicy || null,

    requester: {
      name: cleanText(name),
      email_original: cleanText(email),
      email_normalised: emailParts.email,
      email_domain: emailParts.domain,
      organisation_name: cleanText(organisation_name),
      role_title: cleanText(role_title),
      recipient_category: cleanText(recipient_category) || "unknown",
      use_case_present: Boolean(cleanText(use_case)),
      user_agent_present: Boolean(cleanText(user_agent)),
    },

    counts_24h: counts,

    allowed: decision.allowed,
    decision: decision.decision,
    next_state: decision.next_state,

    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    manual_review_reasons: [...new Set(manualReviewReasons)],
    risk_flags: [...new Set(riskFlags)],

    public_message: decision.allowed
      ? intakePolicy?.public_review_message || "Your request has been received and will be reviewed."
      : releasePolicy.public_message ||
        intakePolicy?.public_block_message ||
        "This request cannot be accepted at this time.",

    admin_message: decision.allowed
      ? "Request intake may proceed to review."
      : "Request intake blocked before request creation.",
  };
}

export async function handleCdasRequestIntakeEvaluation(request, env) {
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const body = await readJsonBody(request);

  if (!body || typeof body !== "object") {
    return jsonResponse(
      {
        ok: false,
        error: "invalid_json_body",
        message: "Expected a JSON request body.",
      },
      400
    );
  }

  if (!cleanText(body.document_id)) {
    return jsonResponse(
      {
        ok: false,
        error: "document_id_required",
        message: "document_id is required.",
      },
      400
    );
  }

  const evaluation = await evaluateCdasRequestIntakePolicy(env, {
    document_id: body.document_id,
    document_version: body.document_version || "",
    name: body.name,
    email: body.email,
    organisation_name: body.organisation_name,
    role_title: body.role_title,
    recipient_category: body.recipient_category,
    use_case: body.use_case,
    ip_hash: body.ip_hash,
    user_agent: body.user_agent,
  });

  return jsonResponse(evaluation);
}