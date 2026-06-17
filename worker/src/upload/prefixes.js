const VALID_UPLOAD_DOMAINS = new Set(["cdas_document", "private_file"]);

const VALID_PREFIX_STATUSES = new Set([
  "draft",
  "active",
  "disabled",
  "deprecated",
  "archived",
  "blocked",
]);

const CDAS_PREFIX_ROOT = "docs/originals/relayhub/";
const PRIVATE_FILE_PREFIX_ROOT = "private-files/";

function cleanText(value) {
  return String(value ?? "").trim();
}

function fail(error, message, details = {}) {
  return {
    ok: false,
    error,
    message,
    details,
    warnings: [],
  };
}

function pass(prefix, warnings = []) {
  return {
    ok: true,
    prefix,
    warnings,
  };
}

export function normaliseStoragePrefix(rawPrefix) {
  let prefix = cleanText(rawPrefix);

  prefix = prefix.replaceAll("\\", "/");
  prefix = prefix.replace(/\/+/g, "/");

  while (prefix.startsWith("/")) {
    prefix = prefix.slice(1);
  }

  if (prefix && !prefix.endsWith("/")) {
    prefix = `${prefix}/`;
  }

  return prefix;
}

export function validateStoragePrefixString(rawPrefix) {
  const prefix = normaliseStoragePrefix(rawPrefix);

  if (!prefix) {
    return fail(
      "storage_prefix_missing",
      "Storage prefix is required."
    );
  }

  if (prefix.length > 300) {
    return fail(
      "storage_prefix_too_long",
      "Storage prefix is too long.",
      { max_length: 300 }
    );
  }

  if (prefix.startsWith("/")) {
    return fail(
      "storage_prefix_leading_slash",
      "Storage prefix must not begin with a slash.",
      { prefix }
    );
  }

  if (prefix.includes("../") || prefix.includes("..\\")) {
    return fail(
      "storage_prefix_path_escape",
      "Storage prefix must not contain path escape segments.",
      { prefix }
    );
  }

  if (prefix.includes("/../") || prefix.includes("/..")) {
    return fail(
      "storage_prefix_path_escape",
      "Storage prefix must not contain parent-directory references.",
      { prefix }
    );
  }

  if (/[\x00-\x1F\x7F]/.test(prefix)) {
    return fail(
      "storage_prefix_control_character",
      "Storage prefix must not contain control characters.",
      { prefix }
    );
  }

  if (prefix.includes("//")) {
    return fail(
      "storage_prefix_duplicate_separator",
      "Storage prefix must not contain duplicate path separators.",
      { prefix }
    );
  }

  return pass(prefix);
}

export function validateStoragePrefixDomain({ domain, prefix }) {
  const cleanDomain = cleanText(domain);
  const cleanPrefix = normaliseStoragePrefix(prefix);

  if (!VALID_UPLOAD_DOMAINS.has(cleanDomain)) {
    return fail(
      "storage_prefix_invalid_domain",
      "Storage prefix domain is not recognised.",
      { domain: cleanDomain }
    );
  }

  const stringResult = validateStoragePrefixString(cleanPrefix);

  if (!stringResult.ok) {
    return stringResult;
  }

  if (cleanDomain === "cdas_document") {
    if (!cleanPrefix.startsWith(CDAS_PREFIX_ROOT)) {
      return fail(
        "storage_prefix_wrong_domain_root",
        "CDAS document uploads must use a RelayHub CDAS source-document prefix.",
        {
          domain: cleanDomain,
          prefix: cleanPrefix,
          required_root: CDAS_PREFIX_ROOT,
        }
      );
    }

    if (cleanPrefix.startsWith(PRIVATE_FILE_PREFIX_ROOT)) {
      return fail(
        "storage_prefix_cross_domain",
        "CDAS document uploads must not use a private-file prefix.",
        {
          domain: cleanDomain,
          prefix: cleanPrefix,
        }
      );
    }
  }

  if (cleanDomain === "private_file") {
    if (!cleanPrefix.startsWith(PRIVATE_FILE_PREFIX_ROOT)) {
      return fail(
        "storage_prefix_wrong_domain_root",
        "Private-file uploads must use a private-file prefix.",
        {
          domain: cleanDomain,
          prefix: cleanPrefix,
          required_root: PRIVATE_FILE_PREFIX_ROOT,
        }
      );
    }

    if (cleanPrefix.startsWith(CDAS_PREFIX_ROOT)) {
      return fail(
        "storage_prefix_cross_domain",
        "Private-file uploads must not use a CDAS document prefix.",
        {
          domain: cleanDomain,
          prefix: cleanPrefix,
        }
      );
    }
  }

  return pass(cleanPrefix);
}

export function validateStoragePrefixStatus(prefixRecord, options = {}) {
  const allowDeprecated = Boolean(options.allowDeprecated);
  const status = cleanText(prefixRecord?.status).toLowerCase();

  if (!VALID_PREFIX_STATUSES.has(status)) {
    return fail(
      "storage_prefix_invalid_status",
      "Storage prefix status is not recognised.",
      {
        prefix_id: prefixRecord?.id || null,
        status,
      }
    );
  }

  if (status === "active") {
    return pass(prefixRecord);
  }

  if (status === "deprecated" && allowDeprecated) {
    return pass(prefixRecord, [
      {
        code: "storage_prefix_deprecated",
        message:
          "The selected storage prefix is deprecated. It is recognised but should not be used for new uploads unless deliberately required.",
      },
    ]);
  }

  if (status === "draft") {
    return fail(
      "storage_prefix_not_active",
      "The selected storage prefix is still draft and cannot be used for uploads.",
      {
        prefix_id: prefixRecord?.id || null,
        status,
      }
    );
  }

  if (status === "disabled") {
    return fail(
      "storage_prefix_disabled",
      "The selected storage prefix is disabled and cannot be used for new uploads.",
      {
        prefix_id: prefixRecord?.id || null,
        status,
      }
    );
  }

  if (status === "deprecated") {
    return fail(
      "storage_prefix_deprecated",
      "The selected storage prefix is deprecated and cannot be used for new uploads.",
      {
        prefix_id: prefixRecord?.id || null,
        status,
      }
    );
  }

  if (status === "archived") {
    return fail(
      "storage_prefix_archived",
      "The selected storage prefix is archived and is evidence-only.",
      {
        prefix_id: prefixRecord?.id || null,
        status,
      }
    );
  }

  if (status === "blocked") {
    return fail(
      "storage_prefix_blocked",
      "The selected storage prefix is blocked and must not be used.",
      {
        prefix_id: prefixRecord?.id || null,
        status,
      }
    );
  }

  return fail(
    "storage_prefix_unusable",
    "The selected storage prefix cannot be used.",
    {
      prefix_id: prefixRecord?.id || null,
      status,
    }
  );
}

export async function getStoragePrefixById(env, prefixId) {
  const id = cleanText(prefixId);

  if (!id) {
    return null;
  }

  const row = await env.DB.prepare(
    `SELECT
       id,
       domain,
       label,
       prefix,
       status,
       description,
       created_by,
       created_at,
       updated_at,
       disabled_at,
       deprecated_at,
       archived_at,
       blocked_at,
       notes
     FROM storage_prefixes
     WHERE id = ?`
  )
    .bind(id)
    .first();

  return row || null;
}

export async function listStoragePrefixes(env, options = {}) {
  const domain = cleanText(options.domain);
  const status = cleanText(options.status);
  const includeArchived = Boolean(options.includeArchived);
  const includeBlocked = Boolean(options.includeBlocked);

  const where = [];
  const binds = [];

  if (domain) {
    where.push("domain = ?");
    binds.push(domain);
  }

  if (status) {
    where.push("status = ?");
    binds.push(status);
  }

  if (!includeArchived) {
    where.push("status != 'archived'");
  }

  if (!includeBlocked) {
    where.push("status != 'blocked'");
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const result = await env.DB.prepare(
    `SELECT
       id,
       domain,
       label,
       prefix,
       status,
       description,
       created_by,
       created_at,
       updated_at,
       disabled_at,
       deprecated_at,
       archived_at,
       blocked_at,
       notes
     FROM storage_prefixes
     ${whereSql}
     ORDER BY domain ASC, prefix ASC`
  )
    .bind(...binds)
    .all();

  return result.results || [];
}

export async function validateStoragePrefixForUpload(env, options = {}) {
  const domain = cleanText(options.domain);
  const prefixId = cleanText(options.prefixId);
  const allowDeprecated = Boolean(options.allowDeprecated);

  if (!VALID_UPLOAD_DOMAINS.has(domain)) {
    return fail(
      "storage_prefix_invalid_upload_domain",
      "Upload domain is not recognised.",
      { domain }
    );
  }

  if (!prefixId) {
    return fail(
      "storage_prefix_id_missing",
      "Storage prefix selection is required.",
      { domain }
    );
  }

  const prefixRecord = await getStoragePrefixById(env, prefixId);

  if (!prefixRecord) {
    return fail(
      "storage_prefix_not_found",
      "The selected storage prefix could not be found.",
      {
        domain,
        prefix_id: prefixId,
      }
    );
  }

  if (prefixRecord.domain !== domain) {
    return fail(
      "storage_prefix_domain_mismatch",
      "The selected storage prefix belongs to the wrong upload domain.",
      {
        requested_domain: domain,
        prefix_domain: prefixRecord.domain,
        prefix_id: prefixRecord.id,
        prefix: prefixRecord.prefix,
      }
    );
  }

  const domainResult = validateStoragePrefixDomain({
    domain,
    prefix: prefixRecord.prefix,
  });

  if (!domainResult.ok) {
    return domainResult;
  }

  const statusResult = validateStoragePrefixStatus(prefixRecord, {
    allowDeprecated,
  });

  if (!statusResult.ok) {
    return statusResult;
  }

  return {
    ok: true,
    prefix: {
      ...prefixRecord,
      prefix: domainResult.prefix,
    },
    warnings: statusResult.warnings || [],
  };
}

export const uploadPrefixPolicy = {
  validDomains: Array.from(VALID_UPLOAD_DOMAINS),
  validStatuses: Array.from(VALID_PREFIX_STATUSES),
  cdasPrefixRoot: CDAS_PREFIX_ROOT,
  privateFilePrefixRoot: PRIVATE_FILE_PREFIX_ROOT,
};