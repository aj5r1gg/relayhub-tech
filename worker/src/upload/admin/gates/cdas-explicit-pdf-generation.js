import {
  buildCdasGeneratedPdfFilename,
  buildCdasGeneratedPdfObjectKey,
} from "../../../cdas/generated-pdf-naming.js";

import {
  generatePreparedCdasLicencePdf,
} from "../../../cdas/generate-pdf.js";

import {
  evaluateCdasLicenceToPdfEligibility,
} from "../../../cdas/licence-to-pdf-gate.js";

const PDF_GENERATION_POLICY_VERSION = "U3-U";
const REQUIRED_PDF_PREPARATION_POLICY_VERSION = "U3-T";
const REQUIRED_LICENCE_ISSUANCE_POLICY_VERSION = "U3-S";
const REQUIRED_LICENCE_PREPARATION_POLICY_VERSION = "U3-R";
const REQUIRED_APPROVAL_POLICY_VERSION = "U3-Q";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function sameText(left, right) {
  return cleanText(left) === cleanText(right);
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 8) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);

  return Array.from(values)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function makeGenerationEventId() {
  return `lic_pdf_gen_${Date.now().toString(36)}_${randomHex(8)}`;
}

function jsonResponse(payload, status = 200) {
  return new Response(
    JSON.stringify(payload, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control":
          "no-store",
      },
    },
  );
}

function safetyPayload(overrides = {}) {
  return {
    source_r2_read: false,
    source_sha256_verified: false,

    generated_pdf_rendered: false,
    generated_pdf_r2_written: false,
    generated_pdf_r2_verified: false,
    licence_generated_pdf_fields_updated: false,

    pdf_generation_evidence_created: false,

    generated_pdf_overwritten: false,
    generated_pdf_deleted: false,

    download_link_created: false,
    download_link_activated: false,

    email_sent: false,
    download_served: false,

    ...overrides,
  };
}

function fail(
  error,
  message,
  status = 409,
  extra = {},
) {
  return jsonResponse(
    {
      ok: false,
      generated: false,
      error,
      message,
      ...extra,
      safety:
        safetyPayload(
          extra.safety || {},
        ),
    },
    status,
  );
}

function success(payload = {}) {
  return jsonResponse({
    ok: true,
    ...payload,
  });
}

async function readJsonBody(request) {
  try {
    const body =
      await request.json();

    return (
      body &&
      typeof body === "object"
    )
      ? body
      : {};
  } catch {
    return {};
  }
}

async function first(
  env,
  sql,
  bindings = [],
) {
  return await env.RELAYHUB_DB
    .prepare(sql)
    .bind(...bindings)
    .first();
}

async function count(
  env,
  sql,
  bindings = [],
) {
  const row =
    await first(
      env,
      sql,
      bindings,
    );

  return Number(
    row?.total || 0,
  );
}

function toHex(buffer) {
  return [
    ...new Uint8Array(buffer),
  ]
    .map(
      (byte) =>
        byte
          .toString(16)
          .padStart(2, "0"),
    )
    .join("");
}

async function sha256Hex(bytes) {
  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      bytes,
    );

  return toHex(digest);
}

async function getAccessRequest(
  env,
  requestId,
) {
  return await first(
    env,
    `SELECT *
     FROM document_access_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getLicenceForRequest(
  env,
  requestId,
) {
  return await first(
    env,
    `SELECT *
     FROM document_licences
     WHERE request_id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getDocument(
  env,
  documentId,
  version,
) {
  return await first(
    env,
    `SELECT *
     FROM documents
     WHERE id = ?
       AND version = ?
     LIMIT 1`,
    [
      documentId,
      version,
    ],
  );
}

async function getPdfPreparation(
  env,
  requestId,
) {
  return await first(
    env,
    `SELECT *
     FROM document_licence_pdf_preparation_events
     WHERE request_id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getGenerationEventByRequest(
  env,
  requestId,
) {
  return await first(
    env,
    `SELECT *
     FROM document_licence_pdf_generation_events
     WHERE request_id = ?
     LIMIT 1`,
    [requestId],
  );
}

async function getIssueEvent(
  env,
  id,
) {
  if (!cleanText(id)) {
    return null;
  }

  return await first(
    env,
    `SELECT *
     FROM document_access_request_licence_issue_events
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

async function getLicencePreparationEvent(
  env,
  id,
) {
  if (!cleanText(id)) {
    return null;
  }

  return await first(
    env,
    `SELECT *
     FROM document_access_request_licence_preparation_events
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

async function getReviewEvent(
  env,
  id,
) {
  if (!cleanText(id)) {
    return null;
  }

  return await first(
    env,
    `SELECT *
     FROM document_access_request_review_events
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

async function downloadLinkCount(
  env,
  licenceId,
) {
  return await count(
    env,
    `SELECT COUNT(*) AS total
     FROM document_download_links
     WHERE licence_id = ?`,
    [licenceId],
  );
}

function completeGeneratedLicenceEvidence(
  licence,
) {
  return Boolean(
    licence &&
    licence.generated_pdf_status ===
      "generated" &&
    licence.generated_pdf_object_key &&
    licence.generated_pdf_filename &&
    licence.generated_pdf_sha256 &&
    Number(
      licence.generated_pdf_size_bytes,
    ) > 0 &&
    licence.generated_pdf_content_type ===
      "application/pdf" &&
    licence.generated_pdf_created_at &&
    !licence.generated_pdf_error
  );
}

function pristineGeneratedLicenceState(
  licence,
) {
  return Boolean(
    licence &&
    licence.generated_pdf_status ===
      "not_generated" &&
    licence.generated_pdf_object_key ===
      null &&
    licence.generated_pdf_filename ===
      null &&
    licence.generated_pdf_sha256 ===
      null &&
    licence.generated_pdf_size_bytes ===
      null &&
    licence.generated_pdf_content_type ===
      null &&
    licence.generated_pdf_created_at ===
      null &&
    licence.generated_pdf_error ===
      null
  );
}

function generationEventMatchesLicence(
  event,
  licence,
  preparation,
) {
  if (
    !event ||
    !licence ||
    !preparation
  ) {
    return false;
  }

  return Boolean(
    sameText(
      event.request_id,
      licence.request_id,
    ) &&
    sameText(
      event.licence_id,
      licence.id,
    ) &&
    sameText(
      event.licence_number,
      licence.licence_number,
    ) &&
    sameText(
      event.document_id,
      licence.document_id,
    ) &&
    sameText(
      event.document_version,
      licence.document_version,
    ) &&
    sameText(
      event.pdf_preparation_event_id,
      preparation.id,
    ) &&
    sameText(
      event.source_object,
      preparation.source_object,
    ) &&
    sameText(
      event.source_sha256,
      preparation.source_sha256,
    ) &&
    sameText(
      event.rendered_licence_sha256,
      preparation.rendered_licence_sha256,
    ) &&
    sameText(
      event.rendered_terms_body_sha256,
      preparation.rendered_terms_body_sha256,
    ) &&
    sameText(
      event.generated_pdf_object_key,
      licence.generated_pdf_object_key,
    ) &&
    sameText(
      event.generated_pdf_filename,
      licence.generated_pdf_filename,
    ) &&
    sameText(
      event.generated_pdf_sha256,
      licence.generated_pdf_sha256,
    ) &&
    Number(
      event.generated_pdf_size_bytes,
    ) ===
      Number(
        licence.generated_pdf_size_bytes,
      ) &&
    event.generated_pdf_content_type ===
      "application/pdf" &&
    licence.generated_pdf_content_type ===
      "application/pdf" &&
    sameText(
      event.approval_policy_version,
      REQUIRED_APPROVAL_POLICY_VERSION,
    ) &&
    sameText(
      event.licence_preparation_policy_version,
      REQUIRED_LICENCE_PREPARATION_POLICY_VERSION,
    ) &&
    sameText(
      event.licence_issuance_policy_version,
      REQUIRED_LICENCE_ISSUANCE_POLICY_VERSION,
    ) &&
    sameText(
      event.pdf_preparation_policy_version,
      REQUIRED_PDF_PREPARATION_POLICY_VERSION,
    ) &&
    sameText(
      event.pdf_generation_policy_version,
      PDF_GENERATION_POLICY_VERSION,
    )
  );
}

async function inspectGeneratedR2Object(
  env,
  objectKey,
) {
  const key =
    cleanText(objectKey);

  if (!key) {
    return {
      exists: false,
      object_key: null,
    };
  }

  const head =
    await env.RELAYHUB_DOWNLOADS
      .head(key);

  if (!head) {
    return {
      exists: false,
      object_key: key,
    };
  }

  return {
    exists: true,
    object_key: key,
    size_bytes:
      Number(head.size || 0),
    content_type:
      head.httpMetadata
        ?.contentType ||
      null,
  };
}

async function readAndHashGeneratedR2Object(
  env,
  objectKey,
) {
  const key =
    cleanText(objectKey);

  const object =
    await env.RELAYHUB_DOWNLOADS
      .get(key);

  if (!object) {
    return {
      exists: false,
      object_key: key,
    };
  }

  const bytes =
    new Uint8Array(
      await object.arrayBuffer(),
    );

  return {
    exists: true,
    object_key: key,
    size_bytes:
      bytes.byteLength,
    sha256:
      await sha256Hex(bytes),
    content_type:
      object.httpMetadata
        ?.contentType ||
      "application/pdf",
  };
}

function evaluateFrozenProvenance({
  accessRequest,
  licence,
  document,
  preparation,
  issueEvent,
  licencePreparationEvent,
  reviewEvent,
  eligibility,
  canonicalObjectKey,
  canonicalFilename,
  downloadLinks,
}) {
  const blockers = [];

  if (!accessRequest) {
    blockers.push(
      "access_request_missing",
    );

    return blockers;
  }

  if (
    accessRequest.status !==
    "licence_issued"
  ) {
    blockers.push(
      "request_status_not_licence_issued",
    );
  }

  if (
    accessRequest.request_review_status !==
    "approved_for_licence_prep"
  ) {
    blockers.push(
      "request_review_status_invalid",
    );
  }

  if (
    accessRequest.approval_policy_version !==
    REQUIRED_APPROVAL_POLICY_VERSION
  ) {
    blockers.push(
      "request_approval_policy_invalid",
    );
  }

  if (!licence) {
    blockers.push(
      "issued_licence_missing",
    );

    return blockers;
  }

  if (
    licence.status !== "issued"
  ) {
    blockers.push(
      "licence_status_not_issued",
    );
  }

  if (
    !sameText(
      licence.request_id,
      accessRequest.id,
    )
  ) {
    blockers.push(
      "licence_request_mismatch",
    );
  }

  if (
    licence.revoked_at ||
    licence.revoked_by
  ) {
    blockers.push(
      "licence_revoked",
    );
  }

  if (licence.superseded_by) {
    blockers.push(
      "licence_superseded",
    );
  }

  if (licence.confirmed_leak_at) {
    blockers.push(
      "licence_confirmed_leak",
    );
  }

  if (!document) {
    blockers.push(
      "document_missing",
    );

    return blockers;
  }

  if (
    !sameText(
      document.id,
      licence.document_id,
    )
  ) {
    blockers.push(
      "document_id_mismatch",
    );
  }

  if (
    !sameText(
      document.version,
      licence.document_version,
    )
  ) {
    blockers.push(
      "document_version_mismatch",
    );
  }

  if (!preparation) {
    blockers.push(
      "u3_t_preparation_missing",
    );

    return blockers;
  }

  if (
    preparation.pdf_preparation_policy_version !==
    REQUIRED_PDF_PREPARATION_POLICY_VERSION
  ) {
    blockers.push(
      "u3_t_policy_version_invalid",
    );
  }

  if (
    preparation.approval_policy_version !==
    REQUIRED_APPROVAL_POLICY_VERSION
  ) {
    blockers.push(
      "u3_t_u3_q_policy_invalid",
    );
  }

  if (
    preparation.licence_preparation_policy_version !==
    REQUIRED_LICENCE_PREPARATION_POLICY_VERSION
  ) {
    blockers.push(
      "u3_t_u3_r_policy_invalid",
    );
  }

  if (
    preparation.licence_issuance_policy_version !==
    REQUIRED_LICENCE_ISSUANCE_POLICY_VERSION
  ) {
    blockers.push(
      "u3_t_u3_s_policy_invalid",
    );
  }

  if (
    !sameText(
      preparation.request_id,
      accessRequest.id,
    )
  ) {
    blockers.push(
      "u3_t_request_mismatch",
    );
  }

  if (
    !sameText(
      preparation.licence_id,
      licence.id,
    )
  ) {
    blockers.push(
      "u3_t_licence_mismatch",
    );
  }

  if (
    !sameText(
      preparation.licence_number,
      licence.licence_number,
    )
  ) {
    blockers.push(
      "u3_t_licence_number_mismatch",
    );
  }

  if (
    !sameText(
      preparation.document_id,
      licence.document_id,
    )
  ) {
    blockers.push(
      "u3_t_document_id_mismatch",
    );
  }

  if (
    !sameText(
      preparation.document_version,
      licence.document_version,
    )
  ) {
    blockers.push(
      "u3_t_document_version_mismatch",
    );
  }

  if (
    !sameText(
      preparation.source_object,
      licence.source_object,
    )
  ) {
    blockers.push(
      "u3_t_source_object_drift",
    );
  }

  if (
    !sameText(
      preparation.source_sha256,
      licence.source_sha256,
    )
  ) {
    blockers.push(
      "u3_t_source_sha256_drift",
    );
  }

  if (
    !sameText(
      preparation.rendered_licence_sha256,
      licence.rendered_licence_sha256,
    )
  ) {
    blockers.push(
      "u3_t_rendered_licence_sha256_drift",
    );
  }

  if (
    !sameText(
      preparation.rendered_terms_body_sha256,
      licence.rendered_terms_body_sha256,
    )
  ) {
    blockers.push(
      "u3_t_rendered_terms_sha256_drift",
    );
  }

  if (
    !sameText(
      preparation.planned_generated_pdf_object_key,
      canonicalObjectKey,
    )
  ) {
    blockers.push(
      "u3_t_generated_object_key_not_canonical",
    );
  }

  if (
    !sameText(
      preparation.planned_generated_pdf_filename,
      canonicalFilename,
    )
  ) {
    blockers.push(
      "u3_t_generated_filename_not_canonical",
    );
  }

  if (
    preparation.planned_generated_pdf_content_type !==
    "application/pdf"
  ) {
    blockers.push(
      "u3_t_generated_content_type_invalid",
    );
  }

  if (!issueEvent) {
    blockers.push(
      "u3_s_issue_event_missing",
    );
  } else {
    if (
      !sameText(
        issueEvent.id,
        preparation.licence_issue_event_id,
      )
    ) {
      blockers.push(
        "u3_s_issue_event_id_mismatch",
      );
    }

    if (
      !sameText(
        issueEvent.request_id,
        accessRequest.id,
      )
    ) {
      blockers.push(
        "u3_s_issue_request_mismatch",
      );
    }

    if (
      !sameText(
        issueEvent.licence_id,
        licence.id,
      )
    ) {
      blockers.push(
        "u3_s_issue_licence_mismatch",
      );
    }

    if (
      issueEvent.new_status !==
      "licence_issued"
    ) {
      blockers.push(
        "u3_s_issue_state_invalid",
      );
    }
  }

  if (!licencePreparationEvent) {
    blockers.push(
      "u3_r_preparation_event_missing",
    );
  } else {
    if (
      !sameText(
        licencePreparationEvent.id,
        preparation.licence_preparation_event_id,
      )
    ) {
      blockers.push(
        "u3_r_event_id_mismatch",
      );
    }

    if (
      !sameText(
        licencePreparationEvent.request_id,
        accessRequest.id,
      )
    ) {
      blockers.push(
        "u3_r_request_mismatch",
      );
    }

    if (
      licencePreparationEvent.preparation_policy_version !==
      REQUIRED_LICENCE_PREPARATION_POLICY_VERSION
    ) {
      blockers.push(
        "u3_r_policy_invalid",
      );
    }
  }

  if (!reviewEvent) {
    blockers.push(
      "u3_q_review_event_missing",
    );
  } else {
    if (
      !sameText(
        reviewEvent.id,
        preparation.review_event_id,
      )
    ) {
      blockers.push(
        "u3_q_review_event_id_mismatch",
      );
    }

    if (
      !sameText(
        reviewEvent.request_id,
        accessRequest.id,
      )
    ) {
      blockers.push(
        "u3_q_review_request_mismatch",
      );
    }

    if (
      reviewEvent.new_status !==
      "approved_pending_licence"
    ) {
      blockers.push(
        "u3_q_review_state_invalid",
      );
    }
  }

  if (
    !eligibility ||
    eligibility.eligible !== true
  ) {
    blockers.push(
      "licence_to_pdf_eligibility_blocked",
    );
  }

  if (downloadLinks !== 0) {
    blockers.push(
      "download_link_already_exists",
    );
  }

  return Array.from(
    new Set(blockers),
  );
}

async function insertGenerationEvent(
  env,
  {
    accessRequest,
    licence,
    preparation,
    generated,
    actor,
    note,
  },
) {
  const id =
    makeGenerationEventId();

  const metadata = {
    phase:
      PDF_GENERATION_POLICY_VERSION,

    request_status:
      accessRequest.status,

    request_review_status:
      accessRequest.request_review_status,

    licence_status:
      licence.status,

    review_event_id:
      preparation.review_event_id,

    licence_preparation_event_id:
      preparation.licence_preparation_event_id,

    licence_issue_event_id:
      preparation.licence_issue_event_id,

    pdf_preparation_event_id:
      preparation.id,

    approval_policy_version:
      REQUIRED_APPROVAL_POLICY_VERSION,

    licence_preparation_policy_version:
      REQUIRED_LICENCE_PREPARATION_POLICY_VERSION,

    licence_issuance_policy_version:
      REQUIRED_LICENCE_ISSUANCE_POLICY_VERSION,

    pdf_preparation_policy_version:
      REQUIRED_PDF_PREPARATION_POLICY_VERSION,

    pdf_generation_policy_version:
      PDF_GENERATION_POLICY_VERSION,

    source_object:
      preparation.source_object,

    source_sha256:
      preparation.source_sha256,

    rendered_licence_sha256:
      preparation.rendered_licence_sha256,

    rendered_terms_body_sha256:
      preparation.rendered_terms_body_sha256,

    generated_pdf_object_key:
      generated.object_key,

    generated_pdf_filename:
      generated.filename,

    generated_pdf_content_type:
      generated.content_type,

    generated_pdf_sha256:
      generated.sha256,

    generated_pdf_size_bytes:
      generated.size_bytes,

    generated_pdf_created_at:
      generated.created_at,

    source_r2_read: true,
    source_sha256_verified: true,

    generated_pdf_rendered: true,
    generated_pdf_r2_written: true,
    generated_pdf_r2_verified: true,

    licence_generated_pdf_fields_updated:
      true,

    download_link_created: false,
    download_link_activated: false,
    email_sent: false,
    download_served: false,
  };

  await env.RELAYHUB_DB
    .prepare(
      `INSERT INTO document_licence_pdf_generation_events (
         id,

         request_id,
         licence_id,
         licence_number,

         document_id,
         document_version,

         review_event_id,
         licence_preparation_event_id,
         licence_issue_event_id,
         pdf_preparation_event_id,

         source_object,
         source_sha256,

         rendered_licence_sha256,
         rendered_terms_body_sha256,

         generated_pdf_object_key,
         generated_pdf_filename,
         generated_pdf_content_type,

         generated_pdf_sha256,
         generated_pdf_size_bytes,
         generated_pdf_created_at,

         approval_policy_version,
         licence_preparation_policy_version,
         licence_issuance_policy_version,
         pdf_preparation_policy_version,
         pdf_generation_policy_version,

         actor,
         note,

         metadata_json,
         created_at
       )
       VALUES (
         ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?, ?,
         ?, ?,
         ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?,
         ?, ?
       )`,
    )
    .bind(
      id,

      accessRequest.id,
      licence.id,
      licence.licence_number,

      licence.document_id,
      licence.document_version,

      preparation.review_event_id,
      preparation.licence_preparation_event_id,
      preparation.licence_issue_event_id,
      preparation.id,

      preparation.source_object,
      preparation.source_sha256,

      preparation.rendered_licence_sha256,
      preparation.rendered_terms_body_sha256,

      generated.object_key,
      generated.filename,
      generated.content_type,

      generated.sha256,
      generated.size_bytes,
      generated.created_at,

      REQUIRED_APPROVAL_POLICY_VERSION,
      REQUIRED_LICENCE_PREPARATION_POLICY_VERSION,
      REQUIRED_LICENCE_ISSUANCE_POLICY_VERSION,
      REQUIRED_PDF_PREPARATION_POLICY_VERSION,
      PDF_GENERATION_POLICY_VERSION,

      actor,
      note,

      JSON.stringify(metadata),
      nowIso(),
    )
    .run();

  return await first(
    env,
    `SELECT *
     FROM document_licence_pdf_generation_events
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
}

async function verifyCompletedReplay({
  env,
  licence,
  preparation,
  generationEvent,
}) {
  if (
    !completeGeneratedLicenceEvidence(
      licence,
    )
  ) {
    return {
      ok: false,
      reason:
        "licence_generated_evidence_incomplete",
    };
  }

  if (
    !generationEventMatchesLicence(
      generationEvent,
      licence,
      preparation,
    )
  ) {
    return {
      ok: false,
      reason:
        "generation_event_mismatch",
    };
  }

  const object =
    await readAndHashGeneratedR2Object(
      env,
      licence.generated_pdf_object_key,
    );

  if (!object.exists) {
    return {
      ok: false,
      reason:
        "generated_r2_object_missing",
    };
  }

  if (
    object.sha256 !==
    licence.generated_pdf_sha256
  ) {
    return {
      ok: false,
      reason:
        "generated_r2_sha256_mismatch",
    };
  }

  if (
    Number(object.size_bytes) !==
    Number(
      licence.generated_pdf_size_bytes,
    )
  ) {
    return {
      ok: false,
      reason:
        "generated_r2_size_mismatch",
    };
  }

  if (
    object.content_type !==
    "application/pdf"
  ) {
    return {
      ok: false,
      reason:
        "generated_r2_content_type_invalid",
    };
  }

  return {
    ok: true,
    object,
  };
}

export async function handleCdasExplicitPdfGeneration(
  request,
  env,
) {
  if (request.method !== "POST") {
    return fail(
      "method_not_allowed",
      "Use POST to explicitly generate a prepared CDAS PDF.",
      405,
    );
  }

  if (!env?.RELAYHUB_DB?.prepare) {
    return fail(
      "database_unavailable",
      "D1 database binding is unavailable.",
      503,
    );
  }

  if (!env?.RELAYHUB_DOWNLOADS) {
    return fail(
      "r2_bucket_unavailable",
      "CDAS R2 bucket binding is unavailable.",
      503,
    );
  }

  const body =
    await readJsonBody(request);

  const requestId =
    cleanText(
      body.request_id ||
      body.access_request_id,
    );

  if (!requestId) {
    return fail(
      "request_id_missing",
      "Document access request ID is required.",
      400,
    );
  }

  const actor =
    cleanText(body.actor) ||
    cleanText(
      env.UPLOAD_ADMIN_ACTOR,
    ) ||
    cleanText(
      env.RELAYHUB_ADMIN_ACTOR,
    ) ||
    cleanText(
      request.headers.get(
        "cf-access-authenticated-user-email",
      ),
    ) ||
    cleanText(
      request.headers.get(
        "x-admin-actor",
      ),
    ) ||
    "admin";

  const note =
    nullableText(
      body.note ||
      body.reason,
    );

  const [
    accessRequest,
    licence,
    preparation,
    generationEvent,
  ] =
    await Promise.all([
      getAccessRequest(
        env,
        requestId,
      ),

      getLicenceForRequest(
        env,
        requestId,
      ),

      getPdfPreparation(
        env,
        requestId,
      ),

      getGenerationEventByRequest(
        env,
        requestId,
      ),
    ]);

  if (!accessRequest) {
    return fail(
      "access_request_not_found",
      "Document access request was not found.",
      404,
      {
        request_id:
          requestId,
      },
    );
  }

  if (!licence) {
    return fail(
      "issued_licence_missing",
      "An issued licence is required before explicit PDF generation.",
      409,
      {
        request_id:
          requestId,
      },
    );
  }

  if (!preparation) {
    return fail(
      "u3_t_preparation_missing",
      "U3-T PDF preparation evidence is required before explicit PDF generation.",
      409,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,
      },
    );
  }

  /*
   * Replay/reconciliation path comes first.
   *
   * If a generation event exists, U3-U must never
   * invoke the generator again. It may only prove
   * that the existing licence + event + R2 evidence
   * agree.
   */
  if (generationEvent) {
    const replay =
      await verifyCompletedReplay({
        env,
        licence,
        preparation,
        generationEvent,
      });

    if (!replay.ok) {
      return fail(
        "u3_u_recovery_required",
        "Existing U3-U generation evidence is inconsistent with the licence or R2 object. Manual recovery is required.",
        409,
        {
          request_id:
            requestId,

          licence_id:
            licence.id,

          generation_event_id:
            generationEvent.id,

          recovery_reason:
            replay.reason,
        },
      );
    }

    return success({
      action:
        "explicit_pdf_generation",

      generated: true,
      already_generated: true,

      request_id:
        requestId,

      licence_id:
        licence.id,

      licence_number:
        licence.licence_number,

      pdf_preparation_event_id:
        preparation.id,

      pdf_generation_event_id:
        generationEvent.id,

      generated_pdf: {
        object_key:
          licence.generated_pdf_object_key,

        filename:
          licence.generated_pdf_filename,

        sha256:
          licence.generated_pdf_sha256,

        size_bytes:
          licence.generated_pdf_size_bytes,

        content_type:
          licence.generated_pdf_content_type,

        created_at:
          licence.generated_pdf_created_at,
      },

      next_allowed_action:
        "download_link_preparation",

      safety:
        safetyPayload({
          generated_pdf_r2_verified:
            true,

          pdf_generation_evidence_created:
            true,
        }),

      message:
        "U3-U generation was already completed and all persisted D1 and R2 evidence matches. No PDF was regenerated or overwritten.",
    });
  }

  const [
    document,
    issueEvent,
    licencePreparationEvent,
    reviewEvent,
    eligibility,
    downloadLinks,
  ] =
    await Promise.all([
      getDocument(
        env,
        licence.document_id,
        licence.document_version,
      ),

      getIssueEvent(
        env,
        preparation
          .licence_issue_event_id,
      ),

      getLicencePreparationEvent(
        env,
        preparation
          .licence_preparation_event_id,
      ),

      getReviewEvent(
        env,
        preparation.review_event_id,
      ),

      evaluateCdasLicenceToPdfEligibility(
        env,
        licence.id,
      ),

      downloadLinkCount(
        env,
        licence.id,
      ),
    ]);

  if (!document) {
    return fail(
      "document_missing",
      "The document bound to the issued licence could not be found.",
      409,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,
      },
    );
  }

  const canonicalObjectKey =
    buildCdasGeneratedPdfObjectKey({
      licence,
      document,
    });

  const canonicalFilename =
    buildCdasGeneratedPdfFilename({
      licence,
      document,
    });

  const blockers =
    evaluateFrozenProvenance({
      accessRequest,
      licence,
      document,
      preparation,
      issueEvent,
      licencePreparationEvent,
      reviewEvent,
      eligibility,
      canonicalObjectKey,
      canonicalFilename,
      downloadLinks,
    });

  if (blockers.length > 0) {
    return fail(
      "u3_u_generation_blocked",
      "The issued licence no longer matches the frozen U3-T preparation evidence.",
      409,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        licence_number:
          licence.licence_number,

        blockers,

        licence_to_pdf_blockers:
          eligibility?.blockers ||
          [],

        licence_to_pdf_warnings:
          eligibility?.warnings ||
          [],
      },
    );
  }

  /*
   * With no U3-U event, complete generated D1 state
   * must not already exist. That would mean some
   * other path generated the PDF without creating
   * authoritative U3-U evidence.
   */
  if (
    completeGeneratedLicenceEvidence(
      licence,
    )
  ) {
    return fail(
      "u3_u_recovery_required",
      "The licence already contains generated PDF evidence but no U3-U generation event exists. Manual reconciliation is required.",
      409,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        recovery_reason:
          "generated_d1_evidence_without_u3_u_event",
      },
    );
  }

  if (
    !pristineGeneratedLicenceState(
      licence,
    )
  ) {
    return fail(
      "u3_u_recovery_required",
      "The licence generated-PDF state is neither pristine nor a completed U3-U generation. Manual recovery is required.",
      409,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        generated_pdf_status:
          licence.generated_pdf_status,

        recovery_reason:
          "non_pristine_generated_pdf_state",
      },
    );
  }

  const beforeObject =
    await inspectGeneratedR2Object(
      env,
      preparation
        .planned_generated_pdf_object_key,
    );

  if (beforeObject.exists) {
    return fail(
      "u3_u_recovery_required",
      "The frozen U3-T destination already exists in R2 but no matching generated-PDF D1 evidence or U3-U event exists. Refusing to overwrite it.",
      409,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        object_key:
          beforeObject.object_key,

        recovery_reason:
          "r2_object_exists_without_generation_evidence",
      },
    );
  }

  let generatedResult;

  try {
    generatedResult =
      await generatePreparedCdasLicencePdf(
        env,
        {
          licence,
          document,

          sourceObject:
            preparation
              .source_object,

          sourceSha256:
            preparation
              .source_sha256,

          generatedObjectKey:
            preparation
              .planned_generated_pdf_object_key,

          generatedFilename:
            preparation
              .planned_generated_pdf_filename,

          actor,
          note:
            note || "",
        },
      );
  } catch (error) {
    /*
     * The primitive performs R2 PUT before the D1
     * licence update. Therefore any exception after
     * mutation begins requires reconciliation rather
     * than assuming nothing changed.
     */
    const [
      postErrorLicence,
      postErrorObject,
    ] =
      await Promise.all([
        getLicenceForRequest(
          env,
          requestId,
        ),

        inspectGeneratedR2Object(
          env,
          preparation
            .planned_generated_pdf_object_key,
        ),
      ]);

    if (
      postErrorObject.exists ||
      !pristineGeneratedLicenceState(
        postErrorLicence,
      )
    ) {
      return fail(
        "u3_u_recovery_required",
        "Explicit PDF generation failed after mutation may have begun. R2 and D1 must be reconciled before retry.",
        500,
        {
          request_id:
            requestId,

          licence_id:
            licence.id,

          recovery_reason:
            "generation_failed_after_possible_mutation",

          detail:
            error?.message ||
            String(error),

          r2_object_exists:
            postErrorObject.exists,

          generated_pdf_status:
            postErrorLicence
              ?.generated_pdf_status ||
            null,
        },
      );
    }

    return fail(
      "u3_u_generation_failed",
      "Explicit PDF generation failed before any durable generated evidence was detected.",
      500,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        detail:
          error?.message ||
          String(error),
      },
    );
  }

  if (
    !generatedResult?.ok ||
    !generatedResult?.generated
  ) {
    return fail(
      generatedResult?.error ||
        "u3_u_generation_failed",

      generatedResult?.message ||
        "Explicit PDF generation did not complete.",

      409,

      {
        request_id:
          requestId,

        licence_id:
          licence.id,
      },
    );
  }

  const [
    postLicence,
    generatedObject,
    postDownloadLinks,
  ] =
    await Promise.all([
      getLicenceForRequest(
        env,
        requestId,
      ),

      readAndHashGeneratedR2Object(
        env,
        preparation
          .planned_generated_pdf_object_key,
      ),

      downloadLinkCount(
        env,
        licence.id,
      ),
    ]);

  if (
    !completeGeneratedLicenceEvidence(
      postLicence,
    )
  ) {
    return fail(
      "u3_u_recovery_required",
      "R2 generation completed but the licence does not contain complete generated-PDF evidence. Manual reconciliation is required.",
      500,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        recovery_reason:
          "generated_licence_evidence_incomplete",
      },
    );
  }

  if (!generatedObject.exists) {
    return fail(
      "u3_u_recovery_required",
      "The licence records a generated PDF but the corresponding R2 object cannot be read.",
      500,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        recovery_reason:
          "generated_r2_object_missing_after_generation",
      },
    );
  }

  const postBlockers = [];

  if (
    !sameText(
      postLicence.generated_pdf_object_key,
      preparation
        .planned_generated_pdf_object_key,
    )
  ) {
    postBlockers.push(
      "persisted_object_key_differs_from_u3_t",
    );
  }

  if (
    !sameText(
      postLicence.generated_pdf_filename,
      preparation
        .planned_generated_pdf_filename,
    )
  ) {
    postBlockers.push(
      "persisted_filename_differs_from_u3_t",
    );
  }

  if (
    postLicence.generated_pdf_content_type !==
    "application/pdf"
  ) {
    postBlockers.push(
      "persisted_content_type_invalid",
    );
  }

  if (
    generatedObject.sha256 !==
    postLicence.generated_pdf_sha256
  ) {
    postBlockers.push(
      "generated_r2_sha256_differs_from_d1",
    );
  }

  if (
    Number(
      generatedObject.size_bytes,
    ) !==
    Number(
      postLicence.generated_pdf_size_bytes,
    )
  ) {
    postBlockers.push(
      "generated_r2_size_differs_from_d1",
    );
  }

  if (
    generatedObject.content_type !==
    "application/pdf"
  ) {
    postBlockers.push(
      "generated_r2_content_type_invalid",
    );
  }

  if (postDownloadLinks !== 0) {
    postBlockers.push(
      "download_link_created_during_u3_u",
    );
  }

  if (
    postBlockers.length > 0
  ) {
    return fail(
      "u3_u_recovery_required",
      "Generated PDF evidence does not reconcile across U3-T, D1 and R2. Manual recovery is required.",
      500,
      {
        request_id:
          requestId,

        licence_id:
          licence.id,

        recovery_reason:
          "post_generation_evidence_mismatch",

        blockers:
          postBlockers,
      },
    );
  }

  let generationEventCreated;

  try {
    generationEventCreated =
      await insertGenerationEvent(
        env,
        {
          accessRequest,
          licence:
            postLicence,
          preparation,

          generated: {
            object_key:
              postLicence
                .generated_pdf_object_key,

            filename:
              postLicence
                .generated_pdf_filename,

            sha256:
              postLicence
                .generated_pdf_sha256,

            size_bytes:
              postLicence
                .generated_pdf_size_bytes,

            content_type:
              postLicence
                .generated_pdf_content_type,

            created_at:
              postLicence
                .generated_pdf_created_at,
          },

          actor,
          note,
        },
      );
  } catch (error) {
    /*
     * At this point R2 + licence D1 evidence are
     * already durable. Failing to persist the U3-U
     * event is therefore explicitly a recovery case.
     */
    const existing =
      await getGenerationEventByRequest(
        env,
        requestId,
      );

    if (
      existing &&
      generationEventMatchesLicence(
        existing,
        postLicence,
        preparation,
      )
    ) {
      generationEventCreated =
        existing;
    } else {
      return fail(
        "u3_u_recovery_required",
        "The PDF and licence evidence were created but the U3-U generation event could not be safely persisted. Manual reconciliation is required.",
        500,
        {
          request_id:
            requestId,

          licence_id:
            licence.id,

          recovery_reason:
            "generation_event_persistence_failed",

          detail:
            error?.message ||
            String(error),
        },
      );
    }
  }

  return success({
    action:
      "explicit_pdf_generation",

    generated: true,
    already_generated: false,

    request_id:
      requestId,

    licence_id:
      postLicence.id,

    licence_number:
      postLicence.licence_number,

    pdf_preparation_event_id:
      preparation.id,

    pdf_generation_event_id:
      generationEventCreated.id,

    generated_pdf: {
      object_key:
        postLicence
          .generated_pdf_object_key,

      filename:
        postLicence
          .generated_pdf_filename,

      sha256:
        postLicence
          .generated_pdf_sha256,

      size_bytes:
        postLicence
          .generated_pdf_size_bytes,

      content_type:
        postLicence
          .generated_pdf_content_type,

      created_at:
        postLicence
          .generated_pdf_created_at,
    },

    source: {
      object_key:
        preparation.source_object,

      sha256:
        preparation.source_sha256,

      verified: true,
    },

    next_allowed_action:
      "download_link_preparation",

    safety:
      safetyPayload({
        source_r2_read: true,
        source_sha256_verified:
          true,

        generated_pdf_rendered:
          true,

        generated_pdf_r2_written:
          true,

        generated_pdf_r2_verified:
          true,

        licence_generated_pdf_fields_updated:
          true,

        pdf_generation_evidence_created:
          true,
      }),

    message:
      "U3-U explicitly generated, persisted and verified the prepared CDAS PDF. No download link was created or activated, no email was sent, and no download was served.",
  });
}