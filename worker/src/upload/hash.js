const PDF_MAGIC_HEADER = "%PDF-";

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

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getCrypto() {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }

  throw new Error("Web Crypto API is not available in this runtime.");
}

export async function sha256Hex(input) {
  let bytes;

  if (input instanceof ArrayBuffer) {
    bytes = input;
  } else if (ArrayBuffer.isView(input)) {
    bytes = input.buffer.slice(
      input.byteOffset,
      input.byteOffset + input.byteLength
    );
  } else if (typeof input === "string") {
    bytes = new TextEncoder().encode(input).buffer;
  } else {
    return fail(
      "sha256_invalid_input",
      "SHA-256 input must be a string, ArrayBuffer, or typed array."
    );
  }

  const digest = await getCrypto().subtle.digest("SHA-256", bytes);

  return pass(toHex(digest));
}

export function byteLength(input) {
  if (input instanceof ArrayBuffer) {
    return input.byteLength;
  }

  if (ArrayBuffer.isView(input)) {
    return input.byteLength;
  }

  if (typeof input === "string") {
    return new TextEncoder().encode(input).byteLength;
  }

  return 0;
}

export function readFirstBytes(input, count = 5) {
  const wanted = Math.max(0, Number(count || 0));

  if (!wanted) {
    return new Uint8Array();
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input.slice(0, wanted));
  }

  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(
      input.buffer.slice(
        input.byteOffset,
        input.byteOffset + Math.min(input.byteLength, wanted)
      )
    );
  }

  if (typeof input === "string") {
    return new TextEncoder().encode(input).slice(0, wanted);
  }

  return new Uint8Array();
}

export function bytesToAscii(bytes) {
  return [...bytes]
    .map((byte) => String.fromCharCode(byte))
    .join("");
}

export function hasPdfMagicHeader(input) {
  const firstBytes = readFirstBytes(input, PDF_MAGIC_HEADER.length);
  const header = bytesToAscii(firstBytes);

  return header === PDF_MAGIC_HEADER;
}

export function normaliseFileExtension(filenameOrExtension) {
  const raw = cleanText(filenameOrExtension).toLowerCase();

  if (!raw) {
    return "";
  }

  const withoutQuery = raw.split("?")[0].split("#")[0];
  const lastSegment = withoutQuery.replaceAll("\\", "/").split("/").pop() || "";
  const index = lastSegment.lastIndexOf(".");

  if (index === -1) {
    return lastSegment.replace(/^\./, "");
  }

  return lastSegment.slice(index + 1).replace(/^\./, "");
}

export function validatePdfSanity(options = {}) {
  const bytes = options.bytes;
  const filename = cleanText(options.filename);
  const mimeType = cleanText(options.mimeType).toLowerCase();
  const maxBytes = Number(options.maxBytes || 10 * 1024 * 1024);
  const size = byteLength(bytes);
  const extension = normaliseFileExtension(filename);

  if (!bytes) {
    return fail(
      "upload_file_missing",
      "A file is required."
    );
  }

  if (size <= 0) {
    return fail(
      "upload_file_empty",
      "The uploaded file is empty.",
      { size }
    );
  }

  if (maxBytes > 0 && size > maxBytes) {
    return fail(
      "upload_file_too_large",
      "The uploaded file is too large.",
      {
        size,
        max_size: maxBytes,
      }
    );
  }

  if (extension !== "pdf") {
    return fail(
      "upload_file_extension_not_allowed",
      "Only PDF files are allowed in this upload phase.",
      {
        filename,
        extension,
        allowed_extension: "pdf",
      }
    );
  }

  if (mimeType && mimeType !== "application/pdf") {
    return fail(
      "upload_file_mime_not_allowed",
      "The uploaded file type is not allowed for this upload phase.",
      {
        mime_type: mimeType,
        allowed_mime_type: "application/pdf",
      }
    );
  }

  if (!hasPdfMagicHeader(bytes)) {
    return fail(
      "upload_file_pdf_header_missing",
      "This does not look like a valid PDF. The file does not begin with the expected PDF header.",
      {
        expected_header: PDF_MAGIC_HEADER,
      }
    );
  }

  return {
    ok: true,
    value: {
      size,
      extension,
      mime_type: mimeType || "application/pdf",
      pdf_header_present: true,
    },
    warnings: [
      {
        code: "pdf_sanity_is_not_malware_scanning",
        message:
          "PDF sanity validation checks basic file structure only. It does not prove the file is safe, clean, or free from malicious content.",
      },
    ],
  };
}

export async function hashUploadBytes(options = {}) {
  const bytes = options.bytes;
  const size = byteLength(bytes);

  if (!bytes) {
    return fail(
      "upload_hash_file_missing",
      "Cannot calculate hash because no file bytes were provided."
    );
  }

  if (size <= 0) {
    return fail(
      "upload_hash_file_empty",
      "Cannot calculate hash for an empty file.",
      { size }
    );
  }

  const hashResult = await sha256Hex(bytes);

  if (!hashResult.ok) {
    return hashResult;
  }

  return {
    ok: true,
    value: {
      source_sha256: hashResult.value,
      source_size: size,
      hash_algorithm: "SHA-256",
    },
    warnings: [],
  };
}

export async function buildUploadSourceEvidence(options = {}) {
  const bytes = options.bytes;
  const filename = options.filename;
  const mimeType = options.mimeType;
  const maxBytes = options.maxBytes;

  const sanityResult = validatePdfSanity({
    bytes,
    filename,
    mimeType,
    maxBytes,
  });

  if (!sanityResult.ok) {
    return sanityResult;
  }

  const hashResult = await hashUploadBytes({ bytes });

  if (!hashResult.ok) {
    return hashResult;
  }

  return {
    ok: true,
    value: {
      original_filename: cleanText(filename),
      mime_type: sanityResult.value.mime_type,
      file_extension: sanityResult.value.extension,
      source_size: hashResult.value.source_size,
      source_sha256: hashResult.value.source_sha256,
      hash_algorithm: hashResult.value.hash_algorithm,
      pdf_header_present: sanityResult.value.pdf_header_present,
    },
    warnings: sanityResult.warnings || [],
  };
}

export function buildSha256Sidecar(sourceSha256) {
  const hash = cleanText(sourceSha256).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return fail(
      "sha256_invalid_hex",
      "SHA-256 value must be a 64-character lowercase hexadecimal string.",
      {
        source_sha256: sourceSha256,
      }
    );
  }

  return pass(`${hash}\n`);
}

export const uploadHashPolicy = {
  hashAlgorithm: "SHA-256",
  pdfMagicHeader: PDF_MAGIC_HEADER,
  defaultMaxUploadBytes: 10 * 1024 * 1024,
  allowedExtension: "pdf",
  allowedMimeType: "application/pdf",
  safetyStatement:
    "PDF sanity validation checks basic file structure only. It does not prove the file is safe, clean, or free from malicious content.",
};
