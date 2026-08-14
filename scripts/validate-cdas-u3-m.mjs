#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";


const BASE_URL =
  process.env.CDAS_VALIDATION_BASE_URL ||
  "http://127.0.0.1:8787";

const ADMIN_TOKEN =
  process.env.CDAS_VALIDATION_ADMIN_TOKEN ||
  "u3q-local-validation-token";

const DB_NAME =
  process.env.CDAS_VALIDATION_DB ||
  "relayhub_early_access";

const ACTOR =
  "u3-m-validator";

const RUN_ID =
  `u3m_${Date.now()}_${crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const REQUEST_URL =
  `${BASE_URL}/api/admin/uploads/cdas-document/activation-prep`;


const DOCUMENTS = {
  valid:
    `${RUN_ID}_document_valid`,

  active:
    `${RUN_ID}_document_active`,

  listed:
    `${RUN_ID}_document_listed`,

  noApproval:
    `${RUN_ID}_document_no_approval`,

  noSource:
    `${RUN_ID}_document_no_source`,

  noSha:
    `${RUN_ID}_document_no_sha`,

  noReview:
    `${RUN_ID}_document_no_review`,

  reviewHold:
    `${RUN_ID}_document_review_hold`,

  reviewReject:
    `${RUN_ID}_document_review_reject`,

  impureReview:
    `${RUN_ID}_document_impure_review`,
};


const REVIEW_EVENTS = {
  valid:
    `${RUN_ID}_review_valid`,

  hold:
    `${RUN_ID}_review_hold`,

  reject:
    `${RUN_ID}_review_reject`,

  impure:
    `${RUN_ID}_review_impure`,
};


function sqlQuote(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}


function d1(sql) {
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DB_NAME,
      "--local",
      "--json",
      "--command",
      sql,
    ],
    {
      encoding: "utf8",
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    }
  );

  return JSON.parse(output);
}


function extractRows(result) {
  if (!Array.isArray(result)) {
    return [];
  }

  for (const item of result) {
    if (Array.isArray(item?.results)) {
      return item.results;
    }

    if (
      Array.isArray(
        item?.result?.results
      )
    ) {
      return item.result.results;
    }
  }

  return [];
}


function query(sql) {
  return extractRows(
    d1(sql)
  );
}


function first(sql) {
  return query(sql)[0] || null;
}


function scalar(
  sql,
  key = "value"
) {
  const row = first(sql);

  if (!row) {
    throw new Error(
      `Expected scalar query result:\n${sql}`
    );
  }

  return row[key];
}


function execute(sql) {
  d1(sql);
}


function assertEqual(
  actual,
  expected,
  message
) {
  assert.equal(
    actual,
    expected,
    message
  );

  console.log(
    `PASS — ${message}`
  );
}


function assertTrue(
  value,
  message
) {
  assert.ok(
    value,
    message
  );

  console.log(
    `PASS — ${message}`
  );
}


function parseResponseBody(raw) {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {
      parse_error: true,
      raw,
    };
  }
}


function assertJsonResponse(
  result,
  label
) {
  assert.ok(
    !result.body?.parse_error,
    `${label}: response body was not valid JSON: ${result.raw}`
  );

  console.log(
    `PASS — ${label}: response body is valid JSON`
  );
}


async function requestU3M({
  method = "GET",
  token = ADMIN_TOKEN,
  body = undefined,
  extraHeaders = {},
} = {}) {
  const headers = {
    Connection: "close",
    ...extraHeaders,
  };

  if (token) {
    headers.Authorization =
      `Bearer ${token}`;
  }

  let encodedBody;

  if (body !== undefined) {
    headers["Content-Type"] =
      "application/json";

    encodedBody =
      JSON.stringify(body);
  }

  const response =
    await fetch(
      REQUEST_URL,
      {
        method,
        headers,
        body: encodedBody,
      }
    );

  const raw =
    await response.text();

  return {
    status: response.status,
    raw,
    body:
      parseResponseBody(raw),
  };
}


async function getUnauthenticated() {
  return requestU3M({
    method: "GET",
    token: null,
  });
}


async function getAuthenticated() {
  return requestU3M({
    method: "GET",
  });
}


async function postPreparation(
  documentId,
  {
    prepNotes =
      "U3-M automated validation",
  } = {}
) {
  return requestU3M({
    method: "POST",
    body: {
      document_id:
        documentId,

      prep_notes:
        prepNotes,
    },
    extraHeaders: {
      "x-admin-actor":
        ACTOR,

      "x-request-id":
        `${RUN_ID}_prep_request`,
    },
  });
}


function tableExists(table) {
  const row = first(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ${sqlQuote(table)}
    LIMIT 1;
  `);

  return row?.name === table;
}


function columnNames(table) {
  return new Set(
    query(
      `PRAGMA table_info(${table});`
    ).map(
      (row) => row.name
    )
  );
}


function countWhere(
  table,
  where = "1 = 1"
) {
  return Number(
    scalar(
      `SELECT COUNT(*) AS value
       FROM ${table}
       WHERE ${where};`
    )
  );
}


function documentRow(
  documentId
) {
  return first(`
    SELECT
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
      requestability_status,
      listed_at,
      requestable_at,
      created_at,
      updated_at
    FROM documents
    WHERE id = ${sqlQuote(documentId)}
    LIMIT 1;
  `);
}


function prepEvents(
  documentId
) {
  return query(`
    SELECT
      id,
      document_id,
      upload_transaction_id,
      review_event_id,
      prep_status,
      previous_document_status,
      resulting_document_status,
      prep_notes,
      admin_actor,
      request_id,
      source_object,
      source_sha256,
      public_visibility_created,
      document_activated,
      document_published,
      document_requestable,
      generated_pdf_created,
      licence_created,
      download_link_created,
      email_sent,
      created_at
    FROM cdas_activation_prep_events
    WHERE document_id =
      ${sqlQuote(documentId)}
    ORDER BY created_at, id;
  `);
}


function captureProhibitedCounts() {
  return {
    activationEvents:
      countWhere(
        "cdas_activation_events"
      ),

    listingEvents:
      countWhere(
        "cdas_listing_requestability_events"
      ),

    accessRequests:
      countWhere(
        "document_access_requests"
      ),

    intakeEvents:
      countWhere(
        "cdas_controlled_access_request_intake_events"
      ),

    reviewEvents:
      countWhere(
        "document_access_request_review_events"
      ),

    licences:
      countWhere(
        "document_licences"
      ),

    downloadLinks:
      countWhere(
        "document_download_links"
      ),

    emailEvents:
      countWhere(
        "cdas_email_events"
      ),

    licenceIssueEvents:
      countWhere(
        "document_access_request_licence_issue_events"
      ),
  };
}


function assertProhibitedCountsUnchanged(
  before,
  label
) {
  const after =
    captureProhibitedCounts();

  assert.deepEqual(
    after,
    before,
    `${label}: prohibited downstream tables changed`
  );

  console.log(
    `PASS — ${label}: no activation/listing/access-request/review/licence/link/email/licence-issue side effects`
  );
}


function makeSlug(
  documentId
) {
  return documentId
    .replaceAll("_", "-");
}


function insertDocument(
  id,
  {
    status = "draft",
    isListed = 0,
    requiresApproval = 1,
    requestabilityStatus =
      "not_requestable",

    sourceObject =
      `validation/${RUN_ID}/${id}/source.odt`,

    sourceSha256 =
      "a".repeat(64),

    licenceTermsVersion =
      "validation-terms-v1",

    version =
      "v-test",
  } = {}
) {
  execute(`
    INSERT INTO documents (
      id,
      slug,
      title,
      summary,
      description,
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
      requires_approval,
      created_at,
      updated_at,
      requestability_status,
      listed_at,
      requestable_at
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(makeSlug(id))},
      'U3-M Validation Document',
      'Disposable U3-M validation fixture',
      'Disposable U3-M validation fixture',
      ${sqlQuote(version)},
      ${sqlQuote(status)},
      'controlled',
      'controlled_verified',
      ${sqlQuote(sourceObject)},
      ${sqlQuote(sourceSha256)},
      ${sqlQuote(
        `validation/${RUN_ID}/${id}/generated/`
      )},
      ${sqlQuote(licenceTermsVersion)},
      ${Number(isListed)},
      0,
      ${Number(requiresApproval)},
      '2026-08-14T00:00:00.000Z',
      '2026-08-14T00:00:00.000Z',
      ${sqlQuote(requestabilityStatus)},
      NULL,
      NULL
    );
  `);
}


function insertReviewEvent(
  id,
  documentId,
  {
    reviewAction =
      "approve_for_activation_prep",

    publicVisibilityCreated = 0,
    licenceCreated = 0,
    downloadLinkCreated = 0,
    emailSent = 0,
    documentActivated = 0,
    generatedPdfCreated = 0,

    createdAt =
      "2026-08-14T00:01:00.000Z",
  } = {}
) {
  execute(`
    INSERT INTO cdas_upload_review_events (
      id,
      document_id,
      upload_transaction_id,
      review_action,
      previous_document_status,
      resulting_document_status,
      review_notes,
      admin_actor,
      request_id,
      public_visibility_created,
      licence_created,
      download_link_created,
      email_sent,
      document_activated,
      generated_pdf_created,
      created_at
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(documentId)},
      NULL,
      ${sqlQuote(reviewAction)},
      'draft',
      'draft',
      'U3-M validation review fixture',
      ${sqlQuote(ACTOR)},
      ${sqlQuote(`${RUN_ID}_review_request`)},
      ${Number(publicVisibilityCreated)},
      ${Number(licenceCreated)},
      ${Number(downloadLinkCreated)},
      ${Number(emailSent)},
      ${Number(documentActivated)},
      ${Number(generatedPdfCreated)},
      ${sqlQuote(createdAt)}
    );
  `);
}


function setupFixtures() {
  insertDocument(
    DOCUMENTS.valid
  );

  insertReviewEvent(
    REVIEW_EVENTS.valid,
    DOCUMENTS.valid
  );


  insertDocument(
    DOCUMENTS.active,
    {
      status:
        "active",
    }
  );


  insertDocument(
    DOCUMENTS.listed,
    {
      isListed:
        1,
    }
  );


  insertDocument(
    DOCUMENTS.noApproval,
    {
      requiresApproval:
        0,
    }
  );


  insertDocument(
    DOCUMENTS.noSource,
    {
      sourceObject:
        "",
    }
  );


  insertDocument(
    DOCUMENTS.noSha,
    {
      sourceSha256:
        null,
    }
  );


  insertDocument(
    DOCUMENTS.noReview
  );


  insertDocument(
    DOCUMENTS.reviewHold
  );

  insertReviewEvent(
    REVIEW_EVENTS.hold,
    DOCUMENTS.reviewHold,
    {
      reviewAction:
        "hold",
    }
  );


  insertDocument(
    DOCUMENTS.reviewReject
  );

  insertReviewEvent(
    REVIEW_EVENTS.reject,
    DOCUMENTS.reviewReject,
    {
      reviewAction:
        "reject",
    }
  );


  insertDocument(
    DOCUMENTS.impureReview
  );

  insertReviewEvent(
    REVIEW_EVENTS.impure,
    DOCUMENTS.impureReview,
    {
      publicVisibilityCreated:
        1,
    }
  );
}


function cleanup() {
  console.log(
    "\n[U3-M] Cleaning validation fixtures."
  );

  try {
    execute(`
      DELETE FROM cdas_controlled_access_request_intake_events
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM document_access_request_review_events
      WHERE request_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM document_access_requests
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM cdas_listing_requestability_events
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM cdas_activation_events
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM cdas_activation_prep_events
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM cdas_upload_review_events
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM document_licences
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM document_download_links
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM documents
      WHERE id LIKE
        ${sqlQuote(`${RUN_ID}%`)};
    `);

    console.log(
      "PASS — validation fixtures removed"
    );
  } catch (error) {
    console.error(
      "WARNING — automatic fixture cleanup failed:",
      error.message
    );
  }
}


async function main() {
  console.log(
    "===== U3-M REAL BEHAVIOURAL VALIDATION ====="
  );

  console.log(
    `Run ID: ${RUN_ID}`
  );

  console.log(
    `Worker: ${BASE_URL}`
  );

  console.log(
    `Local D1: ${DB_NAME}`
  );


  const requiredTables = [
    "documents",
    "cdas_upload_review_events",
    "cdas_activation_prep_events",
    "cdas_activation_events",
    "cdas_listing_requestability_events",
    "document_access_requests",
    "cdas_controlled_access_request_intake_events",
    "document_access_request_review_events",
    "document_licences",
    "document_download_links",
    "cdas_email_events",
    "document_access_request_licence_issue_events",
  ];

  for (
    const table
    of requiredTables
  ) {
    assertTrue(
      tableExists(table),
      `required table exists: ${table}`
    );
  }


  const reviewColumns =
    columnNames(
      "cdas_upload_review_events"
    );

  for (
    const column
    of [
      "review_action",
      "public_visibility_created",
      "licence_created",
      "download_link_created",
      "email_sent",
      "document_activated",
      "generated_pdf_created",
    ]
  ) {
    assertTrue(
      reviewColumns.has(column),
      `cdas_upload_review_events.${column} exists`
    );
  }


  const prepColumns =
    columnNames(
      "cdas_activation_prep_events"
    );

  for (
    const column
    of [
      "review_event_id",
      "prep_status",
      "previous_document_status",
      "resulting_document_status",
      "source_object",
      "source_sha256",
      "public_visibility_created",
      "document_activated",
      "document_published",
      "document_requestable",
      "generated_pdf_created",
      "licence_created",
      "download_link_created",
      "email_sent",
    ]
  ) {
    assertTrue(
      prepColumns.has(column),
      `cdas_activation_prep_events.${column} exists`
    );
  }


  setupFixtures();


  console.log(
    "\n===== AUTHENTICATION ====="
  );

  {
    const result =
      await getUnauthenticated();

    assertJsonResponse(
      result,
      "unauthenticated request"
    );

    assertEqual(
      result.status,
      401,
      "unauthenticated U3-M request rejected"
    );

    assertEqual(
      result.body?.error,
      "admin_auth_failed",
      "unauthenticated request returns canonical admin error"
    );
  }


  console.log(
    "\n===== ROUTE DISCOVERY ====="
  );

  {
    const result =
      await getAuthenticated();

    assertJsonResponse(
      result,
      "authenticated GET"
    );

    assertEqual(
      result.status,
      200,
      "authenticated GET succeeds"
    );

    assertEqual(
      result.body?.route,
      "/api/admin/uploads/cdas-document/activation-prep",
      "GET exposes correct U3-M route"
    );

    assertEqual(
      result.body?.route_status,
      "cdas_activation_preparation_gate",
      "GET exposes U3-M route status"
    );

    assertEqual(
      result.body?.policy
        ?.requires_review_action,
      "approve_for_activation_prep",
      "GET exposes required draft review action"
    );

    assertEqual(
      result.body?.policy
        ?.document_must_be_draft,
      true,
      "GET confirms document must remain draft"
    );

    assertEqual(
      result.body?.policy
        ?.document_must_be_unlisted,
      true,
      "GET confirms document must be unlisted"
    );

    assertEqual(
      result.body?.policy
        ?.document_must_require_approval,
      true,
      "GET confirms approval requirement"
    );

    assertEqual(
      result.body?.policy
        ?.creates_activation_prep_event,
      true,
      "GET confirms U3-M creates preparation evidence"
    );

    assertEqual(
      result.body?.policy
        ?.activates_document,
      false,
      "GET confirms U3-M does not activate"
    );

    assertEqual(
      result.body?.policy
        ?.makes_document_requestable,
      false,
      "GET confirms U3-M does not enable requestability"
    );

    assertEqual(
      result.body?.policy
        ?.creates_licence,
      false,
      "GET confirms U3-M creates no licence"
    );
  }


  console.log(
    "\n===== DOCUMENT ID REQUIRED ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await requestU3M({
        method: "POST",
        body: {
          prep_notes:
            "missing document ID",
        },
        extraHeaders: {
          "x-admin-actor":
            ACTOR,
        },
      });

    assertJsonResponse(
      result,
      "missing document id"
    );

    assertEqual(
      result.status,
      409,
      "missing document id rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_document_id_missing",
      "missing document id returns canonical error"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "missing document id"
    );
  }


  console.log(
    "\n===== DOCUMENT NOT FOUND ====="
  );

  {
    const result =
      await postPreparation(
        `${RUN_ID}_missing_document`
      );

    assertJsonResponse(
      result,
      "missing document"
    );

    assertEqual(
      result.status,
      409,
      "missing document rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_document_not_found",
      "missing document returns canonical error"
    );
  }


  console.log(
    "\n===== DOCUMENT MUST BE DRAFT ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.active
      );

    assertJsonResponse(
      result,
      "non-draft document"
    );

    assertEqual(
      result.status,
      409,
      "non-draft document rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_document_not_draft",
      "non-draft document returns canonical error"
    );
  }


  console.log(
    "\n===== DOCUMENT MUST BE UNLISTED ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.listed
      );

    assertJsonResponse(
      result,
      "listed draft"
    );

    assertEqual(
      result.status,
      409,
      "listed draft rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_document_is_listed",
      "listed draft returns canonical error"
    );
  }


  console.log(
    "\n===== APPROVAL REQUIREMENT ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.noApproval
      );

    assertJsonResponse(
      result,
      "approval-disabled draft"
    );

    assertEqual(
      result.status,
      409,
      "approval-disabled draft rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_document_does_not_require_approval",
      "approval-disabled draft returns canonical error"
    );
  }


  console.log(
    "\n===== SOURCE OBJECT REQUIRED ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.noSource
      );

    assertJsonResponse(
      result,
      "source object missing"
    );

    assertEqual(
      result.status,
      409,
      "missing source object rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_source_object_missing",
      "missing source object returns canonical error"
    );
  }


  console.log(
    "\n===== SOURCE SHA REQUIRED ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.noSha
      );

    assertJsonResponse(
      result,
      "source SHA missing"
    );

    assertEqual(
      result.status,
      409,
      "missing source SHA rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_source_sha256_missing",
      "missing source SHA returns canonical error"
    );
  }


  console.log(
    "\n===== REVIEW EVENT REQUIRED ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.noReview
      );

    assertJsonResponse(
      result,
      "review event missing"
    );

    assertEqual(
      result.status,
      409,
      "missing review event rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_review_event_missing",
      "missing review event returns canonical error"
    );
  }


  console.log(
    "\n===== REVIEW MUST APPROVE ACTIVATION PREP ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.reviewHold
      );

    assertJsonResponse(
      result,
      "hold review event"
    );

    assertEqual(
      result.status,
      409,
      "hold review event rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_review_not_approved",
      "hold review event returns canonical error"
    );
  }


  {
    const result =
      await postPreparation(
        DOCUMENTS.reviewReject
      );

    assertJsonResponse(
      result,
      "reject review event"
    );

    assertEqual(
      result.status,
      409,
      "reject review event rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_review_not_approved",
      "reject review event returns canonical error"
    );
  }


  console.log(
    "\n===== IMPURE REVIEW EVENT ====="
  );

  {
    const result =
      await postPreparation(
        DOCUMENTS.impureReview
      );

    assertJsonResponse(
      result,
      "impure review event"
    );

    assertEqual(
      result.status,
      409,
      "impure review event rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_review_event_impure",
      "impure review event returns canonical error"
    );
  }


  console.log(
    "\n===== SUCCESSFUL ACTIVATION PREPARATION ====="
  );

  let originalUpdatedAt;
  let createdPrepEventId;

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const before =
      documentRow(
        DOCUMENTS.valid
      );

    originalUpdatedAt =
      before.updated_at;

    assertEqual(
      before.status,
      "draft",
      "valid fixture starts draft"
    );

    assertEqual(
      Number(before.is_listed),
      0,
      "valid fixture starts unlisted"
    );

    assertEqual(
      Number(before.requires_approval),
      1,
      "valid fixture starts approval-required"
    );

    assertEqual(
      before.requestability_status,
      "not_requestable",
      "valid fixture starts not requestable"
    );

    const result =
      await postPreparation(
        DOCUMENTS.valid,
        {
          prepNotes:
            "U3-M successful preparation validation",
        }
      );

    assertJsonResponse(
      result,
      "successful preparation"
    );

    assertEqual(
      result.status,
      200,
      "successful preparation returns 200"
    );

    assertEqual(
      result.body?.ok,
      true,
      "successful preparation response ok"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "successful preparation accepted"
    );

    assertEqual(
      result.body?.validation_stage,
      "cdas_activation_preparation",
      "successful preparation reports U3-M stage"
    );

    assertEqual(
      result.body?.document
        ?.status,
      "draft",
      "response preserves draft status"
    );

    assertEqual(
      result.body?.document
        ?.is_listed,
      0,
      "response preserves unlisted state"
    );

    assertEqual(
      result.body?.document
        ?.requires_approval,
      1,
      "response preserves approval requirement"
    );

    assertEqual(
      result.body?.review_event
        ?.id,
      REVIEW_EVENTS.valid,
      "response binds approved review event"
    );

    assertEqual(
      result.body?.review_event
        ?.review_action,
      "approve_for_activation_prep",
      "response exposes approval review action"
    );

    assertEqual(
      result.body?.activation_preparation
        ?.next_allowed_gate,
      "U3-N — CDAS Explicit Activation Gate",
      "response exposes U3-N as next gate"
    );

    assertEqual(
      result.body?.prohibited_side_effects
        ?.activated,
      false,
      "response confirms no activation"
    );

    assertEqual(
      result.body?.prohibited_side_effects
        ?.licence_created,
      false,
      "response confirms no licence"
    );

    const after =
      documentRow(
        DOCUMENTS.valid
      );

    assertEqual(
      after.status,
      "draft",
      "preparation keeps document draft in D1"
    );

    assertEqual(
      Number(after.is_listed),
      0,
      "preparation keeps document unlisted in D1"
    );

    assertEqual(
      Number(after.requires_approval),
      1,
      "preparation preserves approval requirement in D1"
    );

    assertEqual(
      after.requestability_status,
      "not_requestable",
      "preparation preserves not-requestable state"
    );

    assertEqual(
      after.listed_at,
      null,
      "preparation does not populate listed_at"
    );

    assertEqual(
      after.requestable_at,
      null,
      "preparation does not populate requestable_at"
    );

    assertTrue(
      after.updated_at !== originalUpdatedAt,
      "preparation touches document updated_at"
    );

    const events =
      prepEvents(
        DOCUMENTS.valid
      );

    assertEqual(
      events.length,
      1,
      "successful preparation creates exactly one prep event"
    );

    const event =
      events[0];

    createdPrepEventId =
      event.id;

    assertTrue(
      createdPrepEventId?.startsWith(
        "cape_"
      ),
      "prep event uses canonical ID prefix"
    );

    assertEqual(
      event.review_event_id,
      REVIEW_EVENTS.valid,
      "prep event binds approved review evidence"
    );

    assertEqual(
      event.prep_status,
      "prepared",
      "prep event status is prepared"
    );

    assertEqual(
      event.previous_document_status,
      "draft",
      "prep event records previous draft state"
    );

    assertEqual(
      event.resulting_document_status,
      "draft",
      "prep event records resulting draft state"
    );

    assertEqual(
      event.source_object,
      before.source_object,
      "prep event preserves source object evidence"
    );

    assertEqual(
      event.source_sha256,
      before.source_sha256,
      "prep event preserves source SHA evidence"
    );

    assertEqual(
      event.admin_actor,
      ACTOR,
      "prep event records admin actor"
    );

    assertEqual(
      Number(event.public_visibility_created),
      0,
      "prep event records no public visibility"
    );

    assertEqual(
      Number(event.document_activated),
      0,
      "prep event records no activation"
    );

    assertEqual(
      Number(event.document_published),
      0,
      "prep event records no publication"
    );

    assertEqual(
      Number(event.document_requestable),
      0,
      "prep event records no requestability"
    );

    assertEqual(
      Number(event.generated_pdf_created),
      0,
      "prep event records no PDF"
    );

    assertEqual(
      Number(event.licence_created),
      0,
      "prep event records no licence"
    );

    assertEqual(
      Number(event.download_link_created),
      0,
      "prep event records no download link"
    );

    assertEqual(
      Number(event.email_sent),
      0,
      "prep event records no email"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "successful preparation"
    );
  }


  console.log(
    "\n===== IDEMPOTENT PREPARATION REPLAY ====="
  );

  {
    const eventsBefore =
      prepEvents(
        DOCUMENTS.valid
      ).length;

    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postPreparation(
        DOCUMENTS.valid,
        {
          prepNotes:
            "U3-M repeated preparation validation",
        }
      );

    assertJsonResponse(
      result,
      "repeat preparation"
    );

    assertEqual(
      result.status,
      200,
      "repeat preparation returns controlled 200"
    );

    assertEqual(
      result.body?.ok,
      true,
      "repeat preparation response ok"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "repeat preparation remains accepted"
    );

    assertEqual(
      result.body?.idempotent_replay,
      true,
      "repeat preparation reports idempotent replay"
    );

    assertEqual(
      result.body?.validation_stage,
      "activation_prep_existing_replay",
      "repeat preparation stops at replay boundary"
    );

    assertEqual(
      result.body
        ?.existing_activation_prep_event
        ?.id,
      createdPrepEventId,
      "repeat preparation returns original prep event"
    );

    assertEqual(
      prepEvents(
        DOCUMENTS.valid
      ).length,
      eventsBefore,
      "repeat preparation creates no second prep event"
    );

    const document =
      documentRow(
        DOCUMENTS.valid
      );

    assertEqual(
      document.status,
      "draft",
      "repeat preparation leaves document draft"
    );

    assertEqual(
      Number(document.is_listed),
      0,
      "repeat preparation leaves document unlisted"
    );

    assertEqual(
      document.requestability_status,
      "not_requestable",
      "repeat preparation leaves document not requestable"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "repeat preparation"
    );
  }


  console.log(
    "\n===== FINAL PROHIBITED SIDE-EFFECT ASSERTIONS ====="
  );

  assertEqual(
    countWhere(
      "cdas_activation_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no explicit activation event"
  );

  assertEqual(
    countWhere(
      "cdas_listing_requestability_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no listing/requestability event"
  );

  assertEqual(
    countWhere(
      "document_access_requests",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no document access request"
  );

  assertEqual(
    countWhere(
      "cdas_controlled_access_request_intake_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no access request intake event"
  );

  assertEqual(
    countWhere(
      "document_access_request_review_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no access request review event"
  );

  assertEqual(
    countWhere(
      "document_licences",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no document licence"
  );

  assertEqual(
    countWhere(
      "document_download_links",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no document download link"
  );

  assertEqual(
    countWhere(
      "document_access_request_licence_issue_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-M created no licence issue event"
  );


  console.log();
  console.log(
    "============================================"
  );

  console.log(
    "PASS — U3-M REAL BEHAVIOURAL VALIDATION"
  );

  console.log(
    "============================================"
  );

  console.log(
    "PASS — real dispatcher exercised"
  );

  console.log(
    "PASS — admin authentication exercised"
  );

  console.log(
    "PASS — real local D1 exercised"
  );

  console.log(
    "PASS — document draft boundary"
  );

  console.log(
    "PASS — unlisted boundary"
  );

  console.log(
    "PASS — approval-required boundary"
  );

  console.log(
    "PASS — source evidence required"
  );

  console.log(
    "PASS — review evidence required"
  );

  console.log(
    "PASS — review must approve activation preparation"
  );

  console.log(
    "PASS — impure review evidence rejected"
  );

  console.log(
    "PASS — activation preparation behaviour"
  );

  console.log(
    "PASS — document remains draft"
  );

  console.log(
    "PASS — document remains unlisted"
  );

  console.log(
    "PASS — document remains not requestable"
  );

  console.log(
    "PASS — approval requirement preserved"
  );

  console.log(
    "PASS — document updated_at touched"
  );

  console.log(
    "PASS — preparation event persisted"
  );

  console.log(
    "PASS — review evidence binding preserved"
  );

  console.log(
    "PASS — source evidence binding preserved"
  );

  console.log(
    "PASS — repeat preparation is idempotent"
  );

  console.log(
    "PASS — no activation performed"
  );

  console.log(
    "PASS — no listing/requestability side effect"
  );

  console.log(
    "PASS — no access request created"
  );

  console.log(
    "PASS — no review performed"
  );

  console.log(
    "PASS — no licence issued"
  );

  console.log(
    "PASS — no PDF generated"
  );

  console.log(
    "PASS — no download link created"
  );

  console.log(
    "PASS — no email side effect"
  );

  console.log(
    "PASS — U3-N remains the next allowed gate"
  );
}


try {
  await main();
} catch (error) {
  console.error();

  console.error(
    "============================================"
  );

  console.error(
    "FAIL — U3-M REAL BEHAVIOURAL VALIDATION"
  );

  console.error(
    "============================================"
  );

  console.error(error);

  process.exitCode = 1;
} finally {
  cleanup();
}