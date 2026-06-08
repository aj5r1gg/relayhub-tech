import { DOCUMENT_CATALOGUE_KEY } from "../config.js";

const DEFAULT_TERMS_VERSION = "CDAS-LICENCE-v0.1";

const JSON_HEADERS = {
  "content-type": "application/json; charset=UTF-8",
  "cache-control": "no-store",
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...extraHeaders,
    },
  });
}

function getR2Bucket(env) {
  return (
    env.RELAYHUB_DOWNLOADS ||
    env.DOWNLOADS ||
    env.RELAYHUB_DOCS ||
    env.DOCUMENTS ||
    env.R2_BUCKET ||
    null
  );
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanLower(value) {
  return cleanText(value).toLowerCase();
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normaliseBoolean(value, fallback = true) {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return fallback ? 1 : 0;
}

function normaliseNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function normaliseCataloguePayload(payload) {
  if (Array.isArray(payload)) return payload;

  if (!payload || typeof payload !== "object") {
    return [];
  }

  if (Array.isArray(payload.documents)) return payload.documents;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.catalogue)) return payload.catalogue;

  if (payload.catalogue && typeof payload.catalogue === "object") {
    if (Array.isArray(payload.catalogue.documents)) {
      return payload.catalogue.documents;
    }

    if (Array.isArray(payload.catalogue.items)) {
      return payload.catalogue.items;
    }
  }

  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.documents)) {
      return payload.data.documents;
    }

    if (Array.isArray(payload.data.items)) {
      return payload.data.items;
    }
  }

  /*
   * Support keyed object catalogues:
   *
   * {
   *   "relayhub-overview": { ... },
   *   "example-relayhub-paid-document": { ... },
   *   "example-private-paid-document": { ... }
   * }
   */
  const values = Object.values(payload);

  if (
    values.length > 0 &&
    values.every(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
    )
  ) {
    return values;
  }

  return [];
}

function inferClassification(item) {
  const explicit = cleanLower(
    item.classification ||
      item.documentClassification ||
      item.document_classification
  );

  const access = cleanLower(item.access || item.accessMode || item.access_mode);
  const licenceType = cleanLower(item.licenceType || item.licence_type);
  const category = cleanLower(item.category);
  const requiresPayment = item.requiresPayment === true;
  const requiresDownloaderDetails = item.requiresDownloaderDetails === true;

  /*
   * Legacy catalogue mapping:
   *
   * public + free + downloader details → public_licensed
   * public + free + no details         → public_open
   * paid                               → controlled
   * private + paid                     → restricted
   *
   * Payment itself is represented at access_class level as paid_verified.
   */
  if (explicit === "public") {
    if (access === "free" && requiresDownloaderDetails) {
      return "public_licensed";
    }

    if (access === "free" || licenceType.includes("public")) {
      return "public_licensed";
    }

    return "public_open";
  }

  if (explicit === "paid") {
    if (category === "private") {
      return "restricted";
    }

    return "controlled";
  }

  if (explicit === "private") return "restricted";
  if (explicit === "restricted") return "restricted";
  if (explicit === "confidential") return "confidential";
  if (explicit === "internal") return "internal_only";
  if (explicit === "internal_only") return "internal_only";
  if (explicit === "withdrawn") return "withdrawn";
  if (explicit === "retired_public") return "retired_public";

  if (explicit) return explicit;

  const accessClass = cleanLower(
    item.accessClass ||
      item.access_class ||
      item.downloadAccessClass
  );

  if (accessClass === "direct_public") return "public_open";
  if (accessClass === "verified_public") return "public_licensed";
  if (accessClass === "licensed_public") return "public_licensed";
  if (accessClass === "controlled_verified") return "controlled";
  if (accessClass === "approval_required") return "restricted";
  if (accessClass === "invite_only") return "confidential";
  if (accessClass === "paid_verified") {
    return category === "private" ? "restricted" : "controlled";
  }

  const visibility = cleanLower(item.visibility || item.audience);

  if (visibility.includes("private")) return "restricted";
  if (visibility.includes("pilot")) return "restricted";
  if (visibility.includes("partner")) return "restricted";
  if (visibility.includes("public")) return "public_licensed";

  if (requiresPayment || access === "paid") {
    return category === "private" ? "restricted" : "controlled";
  }

  return "controlled";
}

function inferAccessClass(item, classification) {
  const explicit = cleanLower(
    item.accessClass ||
      item.access_class ||
      item.downloadAccessClass
  );

  if (explicit) return explicit;

  const access = cleanLower(item.access || item.accessMode || item.access_mode);
  const category = cleanLower(item.category);
  const requiresPayment = item.requiresPayment === true;
  const requiresDownloaderDetails = item.requiresDownloaderDetails === true;

  /*
   * Legacy catalogue mapping.
   */
  if (access === "paid" || requiresPayment) {
    return "paid_verified";
  }

  if (classification === "public_open") {
    return requiresDownloaderDetails ? "verified_public" : "direct_public";
  }

  if (classification === "public_licensed") return "licensed_public";
  if (classification === "controlled") return "controlled_verified";
  if (classification === "restricted") return "approval_required";
  if (classification === "confidential") return "invite_only";
  if (classification === "internal_only") return "invite_only";
  if (classification === "withdrawn") return "disabled";
  if (classification === "retired_public") return "licensed_public";

  if (category === "private") return "approval_required";

  return "controlled_verified";
}

function inferStatus(item) {
  const explicit = cleanLower(item.status || item.lifecycleStatus);

  if (explicit) return explicit;

  if (item.active === false) return "disabled";
  if (item.withdrawn === true) return "withdrawn";
  if (item.superseded === true) return "superseded";

  return "active";
}

function inferIsListed(item, status) {
  if (item.isListed !== undefined) return normaliseBoolean(item.isListed, true);
  if (item.is_listed !== undefined) return normaliseBoolean(item.is_listed, true);
  if (item.listed !== undefined) return normaliseBoolean(item.listed, true);

  if (status === "disabled" || status === "withdrawn" || status === "archived") {
    return 0;
  }

  return 1;
}

function inferAllowRedownload(item, classification, accessClass, status) {
  if (item.allowRedownload !== undefined) {
    return normaliseBoolean(item.allowRedownload, true);
  }

  if (item.allow_redownload !== undefined) {
    return normaliseBoolean(item.allow_redownload, true);
  }

  if (status === "disabled" || status === "withdrawn") {
    return 0;
  }

  if (
    classification === "restricted" ||
    classification === "confidential" ||
    accessClass === "approval_required" ||
    accessClass === "invite_only"
  ) {
    return 0;
  }

  return 1;
}

function inferMaxRedownloads(item, classification, accessClass) {
  const explicit =
    item.maxRedownloads ??
    item.max_redownloads ??
    item.maxDownloads ??
    item.max_downloads;

  const parsed = normaliseNumberOrNull(explicit);

  if (parsed !== null) {
    return parsed;
  }

  if (accessClass === "paid_verified") return 3;
  if (classification === "public_licensed") return 3;
  if (classification === "controlled") return 2;

  return null;
}

function inferRequiresApproval(item, classification, accessClass) {
  if (item.requiresApproval !== undefined) {
    return normaliseBoolean(item.requiresApproval, false);
  }

  if (item.requires_approval !== undefined) {
    return normaliseBoolean(item.requires_approval, false);
  }

  if (
    accessClass === "approval_required" ||
    accessClass === "invite_only" ||
    classification === "restricted" ||
    classification === "confidential" ||
    classification === "internal_only"
  ) {
    return 1;
  }

  return 0;
}

function mapCatalogueItemToDocument(item) {
  const title = cleanText(item.title || item.name || item.documentTitle);
  const version = cleanText(item.version || item.documentVersion || "v0.1");

  const rawId = cleanText(
    item.documentId ||
      item.document_id ||
      item.id ||
      item.slug ||
      title
  );

  const id = slugify(rawId);
  const slug = slugify(item.slug || rawId || title);

  const safeId = id || slugify(`${title}-${version}`);

  const sourceObject = cleanText(
    item.sourceObject ||
      item.source_object ||
      item.objectKey ||
      item.r2Object ||
      item.path ||
      item.file
  );

  const classification = inferClassification(item);
  const accessClass = inferAccessClass(item, classification);
  const status = inferStatus(item);

  return {
    id: safeId,
    slug: slug || safeId,
    title,
    version,
    status,
    classification,
    access_class: accessClass,
    source_object: sourceObject,
    source_sha256: cleanText(item.sourceSha256 || item.source_sha256),
    generated_prefix:
      cleanText(item.generatedPrefix || item.generated_prefix) ||
      `docs/generated/${safeId}/${version}/`,
    licence_terms_version:
      cleanText(
        item.licenceTermsVersion ||
          item.licence_terms_version ||
          item.termsVersion ||
          item.terms_version
      ) || DEFAULT_TERMS_VERSION,
    is_listed: inferIsListed(item, status),
    allow_redownload: inferAllowRedownload(
      item,
      classification,
      accessClass,
      status
    ),
    max_redownloads: inferMaxRedownloads(item, classification, accessClass),
    requires_approval: inferRequiresApproval(item, classification, accessClass),
    current_version_of:
      cleanText(item.currentVersionOf || item.current_version_of) || null,
    supersedes_document_id:
      cleanText(item.supersedesDocumentId || item.supersedes_document_id) || null,
    superseded_by_document_id:
      cleanText(item.supersededByDocumentId || item.superseded_by_document_id) ||
      null,
  };
}

function validateMappedDocument(doc) {
  const errors = [];

  if (!doc.id) errors.push("missing id");
  if (!doc.slug) errors.push("missing slug");
  if (!doc.title) errors.push("missing title");
  if (!doc.version) errors.push("missing version");
  if (!doc.status) errors.push("missing status");
  if (!doc.classification) errors.push("missing classification");
  if (!doc.access_class) errors.push("missing access_class");
  if (!doc.source_object) errors.push("missing source_object");
  if (!doc.licence_terms_version) errors.push("missing licence_terms_version");

  return errors;
}

async function upsertDocument(env, doc, timestamp) {
  await env.RELAYHUB_DB.prepare(
    `INSERT INTO documents (
       id,
       slug,
       title,
       version,
       status,
       classification,
       access_class,
       source_object,
       source_sha256,
       generated_prefix,
       licence_terms_version,
       is_listed,
       allow_redownload,
       max_redownloads,
       requires_approval,
       current_version_of,
       supersedes_document_id,
       superseded_by_document_id,
       created_at,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       slug = excluded.slug,
       title = excluded.title,
       version = excluded.version,
       status = excluded.status,
       classification = excluded.classification,
       access_class = excluded.access_class,
       source_object = excluded.source_object,
       source_sha256 = excluded.source_sha256,
       generated_prefix = excluded.generated_prefix,
       licence_terms_version = excluded.licence_terms_version,
       is_listed = excluded.is_listed,
       allow_redownload = excluded.allow_redownload,
       max_redownloads = excluded.max_redownloads,
       requires_approval = excluded.requires_approval,
       current_version_of = excluded.current_version_of,
       supersedes_document_id = excluded.supersedes_document_id,
       superseded_by_document_id = excluded.superseded_by_document_id,
       updated_at = excluded.updated_at`
  )
    .bind(
      doc.id,
      doc.slug,
      doc.title,
      doc.version,
      doc.status,
      doc.classification,
      doc.access_class,
      doc.source_object,
      doc.source_sha256 || null,
      doc.generated_prefix,
      doc.licence_terms_version,
      doc.is_listed,
      doc.allow_redownload,
      doc.max_redownloads,
      doc.requires_approval,
      doc.current_version_of,
      doc.supersedes_document_id,
      doc.superseded_by_document_id,
      timestamp,
      timestamp
    )
    .run();
}

export async function importCdasDocumentsFromCatalogue(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to import the CDAS document catalogue.",
      },
      405,
      {
        allow: "POST",
      }
    );
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "1";

  const bucket = getR2Bucket(env);

  if (!bucket) {
    return jsonResponse(
      {
        ok: false,
        error: "r2_bucket_not_configured",
        message:
          "No recognised R2 bucket binding was available to read the document catalogue.",
      },
      500
    );
  }

  const key = DOCUMENT_CATALOGUE_KEY || "docs/catalogue/documents.json";
  const object = await bucket.get(key);

  if (!object) {
    return jsonResponse(
      {
        ok: false,
        error: "catalogue_not_found",
        message: `Document catalogue was not found at ${key}.`,
      },
      404
    );
  }

  let payload;

  try {
    payload = JSON.parse(await object.text());
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: "catalogue_parse_failed",
        message: "Document catalogue could not be parsed as JSON.",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }

  const rawItems = normaliseCataloguePayload(payload);
  const timestamp = nowIso();

  const imported = [];
  const skipped = [];

  for (const item of rawItems) {
    const mapped = mapCatalogueItemToDocument(item);
    const errors = validateMappedDocument(mapped);

    if (errors.length > 0) {
      skipped.push({
        source: item,
        mapped,
        errors,
      });
      continue;
    }

    if (!dryRun) {
      await upsertDocument(env, mapped, timestamp);
    }

    imported.push(mapped);
  }

  return jsonResponse({
    ok: true,
    dry_run: dryRun,
    catalogue_key: key,
    total_catalogue_items: rawItems.length,
    imported_count: imported.length,
    skipped_count: skipped.length,
    imported,
    skipped,
  });
}