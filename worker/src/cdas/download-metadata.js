import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromText(text) {
  const encoded = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

function unavailableMetadataResponse(reason = "download_unavailable") {
  return jsonResponse(
    {
      ok: true,
      download_available: false,
      unavailable_reason: reason,
      message:
        "This controlled download link is unavailable, expired, already used, revoked, superseded, invalid, or no longer authorised.",
      controls: {
        serves_download: false,
        consumes_link: false,
        mutates_database: false,
        raw_token_returned: false,
        token_hash_returned: false,
        r2_object_returned: false,
        private_r2_url_returned: false,
        metadata_only: true,
      },
    },
    200
  );
}

function isExpired(value, now = new Date()) {
  const text = cleanText(value);

  if (!text) return true;

  const parsed = Date.parse(text);

  if (!Number.isFinite(parsed)) return true;

  return parsed <= now.getTime();
}

function publicUnavailableReason(record, now) {
  if (!record) return "download_link_not_found";

  if (record.link_status !== "active") {
    if (record.link_status === "used") return "download_link_used";
    if (record.link_status === "revoked") return "download_link_revoked";
    if (record.link_status === "superseded") return "download_link_superseded";
    if (record.link_status === "pending_activation") return "download_link_not_active";

    return "download_link_unavailable";
  }

  if (!record.link_activated_at) return "download_link_not_activated";
  if (record.link_used_at) return "download_link_used";
  if (record.link_revoked_at) return "download_link_revoked";
  if (record.link_superseded_at) return "download_link_superseded";
  if (!record.link_expires_at) return "download_link_missing_expiry";
  if (isExpired(record.link_expires_at, now)) return "download_link_expired";

  if (record.licence_status !== "issued") return "licence_unavailable";
  if (record.licence_revoked_at || record.confirmed_leak_at) return "licence_unavailable";
  if (record.superseded_by) return "licence_superseded";

  if (record.generated_pdf_status !== "generated") return "generated_pdf_unavailable";

  if (
    !record.link_generated_pdf_object_key ||
    !record.link_generated_pdf_sha256 ||
    !record.link_generated_pdf_size_bytes ||
    !record.link_generated_pdf_created_at
  ) {
    return "generated_pdf_evidence_unavailable";
  }

  if (
    record.link_generated_pdf_object_key !== record.generated_pdf_object_key ||
    record.link_generated_pdf_sha256 !== record.generated_pdf_sha256 ||
    Number(record.link_generated_pdf_size_bytes || 0) !==
      Number(record.generated_pdf_size_bytes || 0)
  ) {
    return "generated_pdf_evidence_mismatch";
  }

  if (record.generated_pdf_error) return "generated_pdf_error_present";

  return "";
}

async function getMetadataRecord(env, tokenHash) {
  return await env.RELAYHUB_DB.prepare(
    `SELECT
       dl.id AS download_id,
       dl.licence_id AS link_licence_id,
       dl.document_id AS link_document_id,
       dl.status AS link_status,
       dl.created_at AS link_created_at,
       dl.expires_at AS link_expires_at,
       dl.used_at AS link_used_at,
       dl.revoked_at AS link_revoked_at,
       dl.superseded_at AS link_superseded_at,
       dl.download_reference AS download_reference,
       dl.activated_at AS link_activated_at,
       dl.generated_pdf_object_key AS link_generated_pdf_object_key,
       dl.generated_pdf_sha256 AS link_generated_pdf_sha256,
       dl.generated_pdf_size_bytes AS link_generated_pdf_size_bytes,
       dl.generated_pdf_created_at AS link_generated_pdf_created_at,

       lic.id AS licence_id,
       lic.licence_number AS licence_number,
       lic.document_id AS document_id,
       lic.document_version AS document_version,
       lic.licence_terms_version AS licence_terms_version,
       lic.status AS licence_status,
       lic.revoked_at AS licence_revoked_at,
       lic.superseded_by AS superseded_by,
       lic.suspected_leak_at AS suspected_leak_at,
       lic.confirmed_leak_at AS confirmed_leak_at,
       lic.licence_holder_name AS licence_holder_name,
       lic.organisation_name AS organisation_name,
       lic.licence_holder_email_normalised AS licence_holder_email_normalised,

       lic.generated_pdf_status AS generated_pdf_status,
       lic.generated_pdf_object_key AS generated_pdf_object_key,
       lic.generated_pdf_sha256 AS generated_pdf_sha256,
       lic.generated_pdf_size_bytes AS generated_pdf_size_bytes,
       lic.generated_pdf_error AS generated_pdf_error,

       doc.title AS document_title,
       doc.description AS document_description,
       doc.slug AS document_slug,
       doc.classification AS document_classification,
       doc.access_class AS document_access_class
     FROM document_download_links dl
     JOIN document_licences lic
       ON lic.id = dl.licence_id
     LEFT JOIN documents doc
       ON doc.id = lic.document_id
      AND doc.version = lic.document_version
     WHERE dl.token_hash = ?
     LIMIT 1`
  )
    .bind(tokenHash)
    .first();
}

export async function handleCdasDocumentDownloadMetadata(request, env, token) {
  if (request.method !== "GET") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use GET to inspect controlled download metadata.",
      },
      405
    );
  }

  const rawToken = cleanText(token);

  if (!rawToken || rawToken.length < 32) {
    return unavailableMetadataResponse("invalid_download_token");
  }

  const tokenHash = await sha256HexFromText(rawToken);
  const record = await getMetadataRecord(env, tokenHash);

  const unavailableReason = publicUnavailableReason(record, new Date());

  if (unavailableReason) {
    return unavailableMetadataResponse(unavailableReason);
  }

  return jsonResponse({
    ok: true,
    download_available: true,
    document: {
      id: record.document_id,
      slug: record.document_slug || null,
      title: record.document_title || record.document_id,
      description: record.document_description || null,
      version: record.document_version,
      classification: record.document_classification || null,
      access_class: record.document_access_class || null,
    },
    licence: {
      id: record.licence_id,
      licence_number: record.licence_number,
      holder_name: record.licence_holder_name || null,
      organisation_name: record.organisation_name || null,
      recipient_email: record.licence_holder_email_normalised || null,
      terms_version: record.licence_terms_version,
      status: record.licence_status,
    },
    download_link: {
      id: record.download_id,
      reference: record.download_reference || null,
      status: record.link_status,
      created_at: record.link_created_at,
      activated_at: record.link_activated_at,
      expires_at: record.link_expires_at,
      used_at: record.link_used_at,
      revoked_at: record.link_revoked_at,
      superseded_at: record.link_superseded_at,
      single_use: true,
    },
    generated_pdf: {
      status: record.generated_pdf_status,
      size_bytes: Number(record.link_generated_pdf_size_bytes || 0),
      sha256_present: Boolean(record.link_generated_pdf_sha256),
    },
    controls: {
      serves_download: false,
      consumes_link: false,
      mutates_database: false,
      raw_token_returned: false,
      token_hash_returned: false,
      r2_object_returned: false,
      private_r2_url_returned: false,
      metadata_only: true,
    },
    message:
      "Controlled download metadata is available. Pressing the final download button will consume the link.",
  });
}
