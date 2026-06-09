import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

function normaliseR2Key(value) {
  return cleanText(value).replace(/^\/+/, "");
}

async function getLicence(env, licenceIdOrNumber) {
  const ref = cleanText(licenceIdOrNumber);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
    `SELECT
       *
     FROM document_licences
     WHERE id = ? OR licence_number = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

function evaluateGeneratedPdfInspection({ licence, r2Object, actualSha256, actualSize }) {
  const blockers = [];
  const warnings = [];

  if (!licence) {
    blockers.push("licence_not_found");

    return {
      object_exists: false,
      evidence_matches: false,
      blockers,
      warnings,
    };
  }

  if (licence.generated_pdf_status !== "generated") {
    blockers.push("generated_pdf_status_not_generated");
  }

  if (!licence.generated_pdf_object_key) {
    blockers.push("missing_generated_pdf_object_key");
  }

  if (!licence.generated_pdf_filename) {
    warnings.push("missing_generated_pdf_filename");
  }

  if (!licence.generated_pdf_sha256) {
    blockers.push("missing_generated_pdf_sha256");
  }

  if (!licence.generated_pdf_size_bytes) {
    blockers.push("missing_generated_pdf_size_bytes");
  }

  if (!licence.generated_pdf_content_type) {
    warnings.push("missing_generated_pdf_content_type");
  }

  if (!licence.generated_pdf_created_at) {
    warnings.push("missing_generated_pdf_created_at");
  }

  if (licence.generated_pdf_error) {
    warnings.push("generated_pdf_error_field_is_not_empty");
  }

  if (!r2Object) {
    blockers.push("generated_pdf_object_not_found_in_r2");

    return {
      object_exists: false,
      evidence_matches: false,
      blockers,
      warnings,
    };
  }

  if (actualSha256 && licence.generated_pdf_sha256 && actualSha256 !== licence.generated_pdf_sha256) {
    blockers.push("generated_pdf_sha256_mismatch");
  }

  if (
    Number.isFinite(Number(actualSize)) &&
    Number.isFinite(Number(licence.generated_pdf_size_bytes)) &&
    Number(actualSize) !== Number(licence.generated_pdf_size_bytes)
  ) {
    blockers.push("generated_pdf_size_mismatch");
  }

  const evidenceMatches =
    blockers.length === 0 &&
    Boolean(r2Object) &&
    Boolean(actualSha256) &&
    actualSha256 === licence.generated_pdf_sha256 &&
    Number(actualSize) === Number(licence.generated_pdf_size_bytes);

  return {
    object_exists: Boolean(r2Object),
    evidence_matches: evidenceMatches,
    blockers,
    warnings,
  };
}

export async function inspectCdasGeneratedPdf(request, env, licenceIdOrNumber) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to inspect a generated CDAS PDF.",
      },
      405
    );
  }

  if (!env.RELAYHUB_DOWNLOADS) {
    return jsonResponse(
      {
        ok: false,
        error: "r2_binding_missing",
        message: "R2 binding RELAYHUB_DOWNLOADS is not available to the Worker.",
      },
      500
    );
  }

  const ref = cleanText(licenceIdOrNumber);

  if (!ref) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_licence_id",
        message: "Licence ID or licence number is required.",
      },
      400
    );
  }

  const licence = await getLicence(env, ref);

  if (!licence) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_not_found",
        message: "CDAS licence was not found.",
      },
      404
    );
  }

  const generatedObjectKey = normaliseR2Key(licence.generated_pdf_object_key);

  if (!generatedObjectKey) {
    const inspection = evaluateGeneratedPdfInspection({
      licence,
      r2Object: null,
      actualSha256: null,
      actualSize: null,
    });

    return jsonResponse({
      ok: true,
      inspected: true,
      object_exists: false,
      evidence_matches: false,
      blockers: inspection.blockers,
      warnings: inspection.warnings,
      licence: {
        id: licence.id,
        licence_number: licence.licence_number,
        document_id: licence.document_id,
        document_version: licence.document_version,
        generated_pdf_status: licence.generated_pdf_status,
        generated_pdf_object_key: licence.generated_pdf_object_key,
        generated_pdf_filename: licence.generated_pdf_filename,
        generated_pdf_sha256: licence.generated_pdf_sha256,
        generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
        generated_pdf_content_type: licence.generated_pdf_content_type,
        generated_pdf_created_at: licence.generated_pdf_created_at,
        generated_pdf_error: licence.generated_pdf_error,
      },
      r2_object: null,
      controls: {
        reads_generated_pdf_from_r2: false,
        calculates_generated_pdf_sha256: false,
        writes_to_r2: false,
        mutates_database: false,
        creates_download_link: false,
        serves_download: false,
        public_access: false,
        inspection_only: true,
      },
      message:
        "Generated PDF inspection completed. No generated object key is recorded on the licence.",
    });
  }

  const r2Object = await env.RELAYHUB_DOWNLOADS.get(generatedObjectKey);

  let actualSha256 = null;
  let actualSize = null;

  if (r2Object) {
    const bytes = await r2Object.arrayBuffer();
    actualSize = r2Object.size ?? bytes.byteLength;
    actualSha256 = await sha256HexFromBytes(bytes);
  }

  const inspection = evaluateGeneratedPdfInspection({
    licence,
    r2Object,
    actualSha256,
    actualSize,
  });

  return jsonResponse({
    ok: true,
    inspected: true,
    object_exists: inspection.object_exists,
    evidence_matches: inspection.evidence_matches,
    blockers: inspection.blockers,
    warnings: inspection.warnings,
    licence: {
      id: licence.id,
      licence_number: licence.licence_number,
      document_id: licence.document_id,
      document_version: licence.document_version,
      licence_holder_email_normalised: licence.licence_holder_email_normalised,
      generated_pdf_status: licence.generated_pdf_status,
      generated_pdf_object_key: licence.generated_pdf_object_key,
      generated_pdf_filename: licence.generated_pdf_filename,
      generated_pdf_sha256: licence.generated_pdf_sha256,
      generated_pdf_size_bytes: licence.generated_pdf_size_bytes,
      generated_pdf_content_type: licence.generated_pdf_content_type,
      generated_pdf_created_at: licence.generated_pdf_created_at,
      generated_pdf_error: licence.generated_pdf_error,
    },
    r2_object: r2Object
      ? {
          key: generatedObjectKey,
          exists: true,
          size: actualSize,
          uploaded: r2Object.uploaded ? r2Object.uploaded.toISOString() : null,
          http_etag: r2Object.httpEtag ?? null,
          http_metadata: r2Object.httpMetadata ?? null,
          custom_metadata: r2Object.customMetadata ?? null,
          calculated_sha256: actualSha256,
        }
      : {
          key: generatedObjectKey,
          exists: false,
          size: null,
          uploaded: null,
          http_etag: null,
          http_metadata: null,
          custom_metadata: null,
          calculated_sha256: null,
        },
    comparisons: {
      sha256_matches:
        Boolean(actualSha256) &&
        Boolean(licence.generated_pdf_sha256) &&
        actualSha256 === licence.generated_pdf_sha256,
      size_matches:
        Number.isFinite(Number(actualSize)) &&
        Number.isFinite(Number(licence.generated_pdf_size_bytes)) &&
        Number(actualSize) === Number(licence.generated_pdf_size_bytes),
      status_is_generated: licence.generated_pdf_status === "generated",
      database_error_is_clear: !licence.generated_pdf_error,
    },
    controls: {
      reads_generated_pdf_from_r2: Boolean(r2Object),
      calculates_generated_pdf_sha256: Boolean(r2Object),
      writes_to_r2: false,
      mutates_database: false,
      creates_download_link: false,
      serves_download: false,
      public_access: false,
      inspection_only: true,
    },
    message: inspection.evidence_matches
      ? "Generated PDF inspection passed. R2 object and D1 evidence match."
      : "Generated PDF inspection completed with blockers or warnings.",
  });
}