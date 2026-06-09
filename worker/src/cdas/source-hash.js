import { jsonResponse } from "../shared.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256HexFromArrayBuffer(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return toHex(digest);
}

function normaliseR2Key(value) {
  return cleanText(value).replace(/^\/+/, "");
}

async function getDocument(env, documentIdOrSlug) {
  const ref = cleanText(documentIdOrSlug);

  if (!ref) return null;

  return await env.RELAYHUB_DB.prepare(
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
       licence_terms_version
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

export async function captureCdasDocumentSourceSha256(request, env, documentIdOrSlug) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to capture the source PDF SHA-256.",
      },
      { status: 405, headers: { allow: "POST" } }
    );
  }

  if (!env.RELAYHUB_DOWNLOADS) {
    return jsonResponse(
      {
        ok: false,
        error: "r2_binding_missing",
        message: "R2 binding RELAYHUB_DOWNLOADS is not available to the Worker.",
      },
      { status: 500 }
    );
  }

  const documentRef = cleanText(documentIdOrSlug);

  if (!documentRef) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_document_id",
        message: "Document ID or slug is required.",
      },
      { status: 400 }
    );
  }

  const document = await getDocument(env, documentRef);

  if (!document) {
    return jsonResponse(
      {
        ok: false,
        error: "document_not_found",
        message: "CDAS document was not found.",
      },
      { status: 404 }
    );
  }

  if (!document.source_object) {
    return jsonResponse(
      {
        ok: false,
        error: "document_source_object_missing",
        message: "Document does not have a source_object value.",
        document: {
          id: document.id,
          slug: document.slug,
          title: document.title,
          version: document.version,
        },
      },
      { status: 409 }
    );
  }

  const sourceObjectKey = normaliseR2Key(document.source_object);
  const r2Object = await env.RELAYHUB_DOWNLOADS.get(sourceObjectKey);

  if (!r2Object) {
    return jsonResponse(
      {
        ok: false,
        error: "source_object_not_found_in_r2",
        message: "The document source object was not found in R2.",
        document: {
          id: document.id,
          slug: document.slug,
          title: document.title,
          version: document.version,
          source_object: sourceObjectKey,
        },
      },
      { status: 404 }
    );
  }

  const bodyBuffer = await r2Object.arrayBuffer();
  const sourceSha256 = await sha256HexFromArrayBuffer(bodyBuffer);
  const capturedAt = nowIso();

  await env.RELAYHUB_DB.prepare(
    `UPDATE documents
     SET source_sha256 = ?
     WHERE id = ?`
  )
    .bind(sourceSha256, document.id)
    .run();

  const updatedDocument = await getDocument(env, document.id);

  return jsonResponse({
    ok: true,
    captured_at: capturedAt,
    document: {
      id: updatedDocument.id,
      slug: updatedDocument.slug,
      title: updatedDocument.title,
      version: updatedDocument.version,
      status: updatedDocument.status,
      classification: updatedDocument.classification,
      access_class: updatedDocument.access_class,
      source_object: updatedDocument.source_object,
      source_sha256: updatedDocument.source_sha256,
      licence_terms_version: updatedDocument.licence_terms_version,
    },
    source_object: {
      key: sourceObjectKey,
      size: r2Object.size ?? bodyBuffer.byteLength,
      http_etag: r2Object.httpEtag ?? null,
      uploaded: r2Object.uploaded ? r2Object.uploaded.toISOString() : null,
    },
    evidence: {
      algorithm: "SHA-256",
      source_sha256: sourceSha256,
      stored_in: "documents.source_sha256",
    },
    controls: {
      reads_from_r2: true,
      writes_to_r2: false,
      generates_pdf: false,
      creates_download_link: false,
      serves_download: false,
      mutates_document_hash_field: true,
    },
    message:
      "Source document SHA-256 captured and stored. No PDF was generated and no download link was created.",
  });
}