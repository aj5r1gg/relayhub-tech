const CDAS_DOMAIN = "cdas_document";
const PRIVATE_FILE_DOMAIN = "private_file";

const CDAS_PREFIX_ROOT = "docs/originals/relayhub/";
const PRIVATE_FILE_PREFIX_ROOT = "private-files/";

const MAX_SAFE_FILENAME_LENGTH = 160;
const MAX_SLUG_LENGTH = 120;
const MAX_VERSION_LENGTH = 40;
const MAX_ID_SEGMENT_LENGTH = 160;

function cleanText(value) {
  return String(value ?? "").trim();
}

function fail(error, message, details = {}) {
  return {
    ok: false,
    error,
    message,
    details,
  };
}

function pass(value, warnings = []) {
  return {
    ok: true,
    value,
    warnings,
  };
}

function normalisePrefix(rawPrefix) {
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

function hasPathEscape(value) {
  const text = cleanText(value).replaceAll("\\", "/");

  return (
    text === ".." ||
    text.startsWith("../") ||
    text.endsWith("/..") ||
    text.includes("/../")
  );
}

function hasControlCharacters(value) {
  return /[\x00-\x1F\x7F]/.test(String(value ?? ""));
}

function stripExtension(filename) {
  const clean = cleanText(filename);
  const index = clean.lastIndexOf(".");

  if (index <= 0) {
    return clean;
  }

  return clean.slice(0, index);
}

function extensionFromFilename(filename) {
  const clean = cleanText(filename).toLowerCase();
  const index = clean.lastIndexOf(".");

  if (index <= 0 || index === clean.length - 1) {
    return "";
  }

  return clean.slice(index + 1);
}

export function normaliseObjectKeyPrefix(rawPrefix) {
  return normalisePrefix(rawPrefix);
}

export function safePathSegment(value, options = {}) {
  const fallback = cleanText(options.fallback || "item");
  const maxLength = Number(options.maxLength || MAX_ID_SEGMENT_LENGTH);

  let text = cleanText(value);

  text = text.normalize("NFKD");
  text = text.replace(/[\u0300-\u036f]/g, "");
  text = text.toLowerCase();
  text = text.replaceAll("\\", "-");
  text = text.replaceAll("/", "-");
  text = text.replace(/[^a-z0-9._-]+/g, "-");
  text = text.replace(/-+/g, "-");
  text = text.replace(/\.+/g, ".");
  text = text.replace(/^[.-]+/, "");
  text = text.replace(/[.-]+$/, "");

  if (!text) {
    text = fallback;
  }

  if (text === "." || text === "..") {
    text = fallback;
  }

  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    text = text.replace(/[.-]+$/, "");
  }

  return text || fallback;
}

export function safeFilename(originalFilename, options = {}) {
  const fallbackBase = cleanText(options.fallbackBase || "source");
  const allowedExtension = cleanText(options.allowedExtension || "pdf")
    .replace(/^\./, "")
    .toLowerCase();

  const base = safePathSegment(stripExtension(originalFilename), {
    fallback: fallbackBase,
    maxLength: MAX_SAFE_FILENAME_LENGTH,
  });

  const detectedExtension = extensionFromFilename(originalFilename);
  const extension = allowedExtension || detectedExtension || "pdf";

  return `${base}.${extension}`;
}

export function validateObjectKeyPrefixForDomain({ domain, prefix }) {
  const cleanDomain = cleanText(domain);
  const cleanPrefix = normalisePrefix(prefix);

  if (!cleanPrefix) {
    return fail(
      "object_key_prefix_missing",
      "Storage prefix is required."
    );
  }

  if (hasControlCharacters(cleanPrefix)) {
    return fail(
      "object_key_prefix_control_character",
      "Storage prefix must not contain control characters.",
      { prefix: cleanPrefix }
    );
  }

  if (hasPathEscape(cleanPrefix)) {
    return fail(
      "object_key_prefix_path_escape",
      "Storage prefix must not contain parent-directory references.",
      { prefix: cleanPrefix }
    );
  }

  if (cleanPrefix.includes("//")) {
    return fail(
      "object_key_prefix_duplicate_separator",
      "Storage prefix must not contain duplicate path separators.",
      { prefix: cleanPrefix }
    );
  }

  if (cleanDomain === CDAS_DOMAIN) {
    if (!cleanPrefix.startsWith(CDAS_PREFIX_ROOT)) {
      return fail(
        "object_key_prefix_wrong_domain_root",
        "CDAS document object keys must stay under the CDAS source-document prefix root.",
        {
          prefix: cleanPrefix,
          required_root: CDAS_PREFIX_ROOT,
        }
      );
    }

    if (cleanPrefix.startsWith(PRIVATE_FILE_PREFIX_ROOT)) {
      return fail(
        "object_key_prefix_cross_domain",
        "CDAS document object keys must not use the private-file namespace.",
        { prefix: cleanPrefix }
      );
    }

    return pass(cleanPrefix);
  }

  if (cleanDomain === PRIVATE_FILE_DOMAIN) {
    if (!cleanPrefix.startsWith(PRIVATE_FILE_PREFIX_ROOT)) {
      return fail(
        "object_key_prefix_wrong_domain_root",
        "Private-file object keys must stay under the private-file prefix root.",
        {
          prefix: cleanPrefix,
          required_root: PRIVATE_FILE_PREFIX_ROOT,
        }
      );
    }

    if (cleanPrefix.startsWith(CDAS_PREFIX_ROOT)) {
      return fail(
        "object_key_prefix_cross_domain",
        "Private-file object keys must not use the CDAS source-document namespace.",
        { prefix: cleanPrefix }
      );
    }

    return pass(cleanPrefix);
  }

  return fail(
    "object_key_invalid_domain",
    "Upload domain is not recognised.",
    { domain: cleanDomain }
  );
}

export function validateObjectKey(key, options = {}) {
  const domain = cleanText(options.domain);
  const objectKey = cleanText(key).replaceAll("\\", "/");

  if (!objectKey) {
    return fail(
      "object_key_missing",
      "Object key is required."
    );
  }

  if (objectKey.startsWith("/")) {
    return fail(
      "object_key_leading_slash",
      "Object key must not begin with a slash.",
      { object_key: objectKey }
    );
  }

  if (objectKey.endsWith("/")) {
    return fail(
      "object_key_trailing_slash",
      "Object key must refer to an object, not a folder.",
      { object_key: objectKey }
    );
  }

  if (hasControlCharacters(objectKey)) {
    return fail(
      "object_key_control_character",
      "Object key must not contain control characters.",
      { object_key: objectKey }
    );
  }

  if (hasPathEscape(objectKey)) {
    return fail(
      "object_key_path_escape",
      "Object key must not contain parent-directory references.",
      { object_key: objectKey }
    );
  }

  if (objectKey.includes("//")) {
    return fail(
      "object_key_duplicate_separator",
      "Object key must not contain duplicate path separators.",
      { object_key: objectKey }
    );
  }

  if (domain) {
    if (domain === CDAS_DOMAIN && !objectKey.startsWith(CDAS_PREFIX_ROOT)) {
      return fail(
        "object_key_wrong_domain_root",
        "CDAS document object key is outside the CDAS source-document namespace.",
        {
          object_key: objectKey,
          required_root: CDAS_PREFIX_ROOT,
        }
      );
    }

    if (domain === PRIVATE_FILE_DOMAIN && !objectKey.startsWith(PRIVATE_FILE_PREFIX_ROOT)) {
      return fail(
        "object_key_wrong_domain_root",
        "Private-file object key is outside the private-file namespace.",
        {
          object_key: objectKey,
          required_root: PRIVATE_FILE_PREFIX_ROOT,
        }
      );
    }
  }

  return pass(objectKey);
}

export function buildCdasSourceObjectKeys(options = {}) {
  const prefixResult = validateObjectKeyPrefixForDomain({
    domain: CDAS_DOMAIN,
    prefix: options.prefix,
  });

  if (!prefixResult.ok) {
    return prefixResult;
  }

  const documentId = safePathSegment(options.documentId || options.slug, {
    fallback: "document",
    maxLength: MAX_SLUG_LENGTH,
  });

  const version = safePathSegment(options.version, {
    fallback: "draft",
    maxLength: MAX_VERSION_LENGTH,
  });

  const sourceFilename = "source.pdf";

  const baseKey = `${prefixResult.value}${documentId}/${version}/`;
  const sourceObjectKey = `${baseKey}${sourceFilename}`;
  const sha256ObjectKey = `${baseKey}source.sha256`;
  const metadataObjectKey = `${baseKey}metadata.json`;

  const sourceValidation = validateObjectKey(sourceObjectKey, {
    domain: CDAS_DOMAIN,
  });

  if (!sourceValidation.ok) {
    return sourceValidation;
  }

  return {
    ok: true,
    domain: CDAS_DOMAIN,
    prefix: prefixResult.value,
    document_id: documentId,
    version,
    source_object_key: sourceObjectKey,
    sha256_object_key: sha256ObjectKey,
    metadata_object_key: metadataObjectKey,
    object_keys: {
      source: sourceObjectKey,
      sha256: sha256ObjectKey,
      metadata: metadataObjectKey,
    },
    warnings: [],
  };
}

export function buildPrivateFileObjectKeys(options = {}) {
  const prefixResult = validateObjectKeyPrefixForDomain({
    domain: PRIVATE_FILE_DOMAIN,
    prefix: options.prefix,
  });

  if (!prefixResult.ok) {
    return prefixResult;
  }

  const privateFileId = safePathSegment(options.privateFileId, {
    fallback: "private-file",
    maxLength: MAX_ID_SEGMENT_LENGTH,
  });

  const sourceFilename = "source.pdf";

  const baseKey = `${prefixResult.value}${privateFileId}/`;
  const sourceObjectKey = `${baseKey}${sourceFilename}`;
  const sha256ObjectKey = `${baseKey}source.sha256`;
  const metadataObjectKey = `${baseKey}metadata.json`;

  const sourceValidation = validateObjectKey(sourceObjectKey, {
    domain: PRIVATE_FILE_DOMAIN,
  });

  if (!sourceValidation.ok) {
    return sourceValidation;
  }

  return {
    ok: true,
    domain: PRIVATE_FILE_DOMAIN,
    prefix: prefixResult.value,
    private_file_id: privateFileId,
    source_object_key: sourceObjectKey,
    sha256_object_key: sha256ObjectKey,
    metadata_object_key: metadataObjectKey,
    object_keys: {
      source: sourceObjectKey,
      sha256: sha256ObjectKey,
      metadata: metadataObjectKey,
    },
    warnings: [],
  };
}

export function buildUploadObjectKeys(options = {}) {
  const domain = cleanText(options.domain);

  if (domain === CDAS_DOMAIN) {
    return buildCdasSourceObjectKeys(options);
  }

  if (domain === PRIVATE_FILE_DOMAIN) {
    return buildPrivateFileObjectKeys(options);
  }

  return fail(
    "object_key_invalid_upload_domain",
    "Upload domain is not recognised.",
    { domain }
  );
}

export const uploadObjectKeyPolicy = {
  cdasDomain: CDAS_DOMAIN,
  privateFileDomain: PRIVATE_FILE_DOMAIN,
  cdasPrefixRoot: CDAS_PREFIX_ROOT,
  privateFilePrefixRoot: PRIVATE_FILE_PREFIX_ROOT,
  fixedSourceFilename: "source.pdf",
  fixedSha256Filename: "source.sha256",
  fixedMetadataFilename: "metadata.json",
};