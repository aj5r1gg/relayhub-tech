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
  "u3-l-validator";

const RUN_ID =
  `u3l_${Date.now()}_${crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const REQUEST_URL =
  `${BASE_URL}/api/admin/uploads/cdas-document/review`;


const DOCUMENTS = {
  hold:
    `${RUN_ID}_document_hold`,

  reject:
    `${RUN_ID}_document_reject`,

  approve:
    `${RUN_ID}_document_approve`,

  rereview:
    `${RUN_ID}_document_rereview`,

  active:
    `${RUN_ID}_document_active`,

  listed:
    `${RUN_ID}_document_listed`,

  noApproval:
    `${RUN_ID}_document_no_approval`,
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


async function requestU3L({
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
    status:
      response.status,

    raw,

    body:
      parseResponseBody(raw),
  };
}


async function getUnauthenticated() {
  return requestU3L({
    method: "GET",
    token: null,
  });
}


async function getAuthenticated() {
  return requestU3L({
    method: "GET",
  });
}


async function postReview(
  documentId,
  action,
  {
    reviewNotes =
      `U3-L validation ${action}`,

    uploadTransactionId =
      null,

    requestSuffix =
      action,
  } = {}
) {
  const body = {
    document_id:
      documentId,

    action,

    review_notes:
      reviewNotes,
  };

  if (uploadTransactionId) {
    body.upload_transaction_id =
      uploadTransactionId;
  }

  return requestU3L({
    method: "POST",

    body,

    extraHeaders: {
      "x-admin-actor":
        ACTOR,

      "x-request-id":
        `${RUN_ID}_${requestSuffix}`,
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


function reviewEvents(
  documentId
) {
  return query(`
    SELECT
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
    FROM cdas_upload_review_events
    WHERE document_id =
      ${sqlQuote(documentId)}
    ORDER BY created_at, id;
  `);
}


function captureProhibitedCounts() {
  return {
    activationPrepEvents:
      countWhere(
        "cdas_activation_prep_events"
      ),

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

    accessReviewEvents:
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
    `PASS — ${label}: no activation-prep/activation/listing/access/licence/link/email side effects`
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
    status =
      "draft",

    isListed =
      0,

    requiresApproval =
      1,

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
      'U3-L Validation Document',
      'Disposable U3-L validation fixture',
      'Disposable U3-L validation fixture',
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


function setupFixtures() {
  insertDocument(
    DOCUMENTS.hold
  );

  insertDocument(
    DOCUMENTS.reject
  );

  insertDocument(
    DOCUMENTS.approve
  );

  insertDocument(
    DOCUMENTS.rereview
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
}


function cleanup() {
  console.log(
    "\n[U3-L] Cleaning validation fixtures."
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


function assertReviewEventPure(
  event,
  label
) {
  assertEqual(
    event.previous_document_status,
    "draft",
    `${label} event records previous draft state`
  );

  assertEqual(
    event.resulting_document_status,
    "draft",
    `${label} event records resulting draft state`
  );

  assertEqual(
    Number(event.public_visibility_created),
    0,
    `${label} event records no public visibility`
  );

  assertEqual(
    Number(event.licence_created),
    0,
    `${label} event records no licence`
  );

  assertEqual(
    Number(event.download_link_created),
    0,
    `${label} event records no download link`
  );

  assertEqual(
    Number(event.email_sent),
    0,
    `${label} event records no email`
  );

  assertEqual(
    Number(event.document_activated),
    0,
    `${label} event records no activation`
  );

  assertEqual(
    Number(event.generated_pdf_created),
    0,
    `${label} event records no generated PDF`
  );
}


function assertDocumentStillControlled(
  document,
  label
) {
  assertEqual(
    document.status,
    "draft",
    `${label} keeps document draft`
  );

  assertEqual(
    Number(document.is_listed),
    0,
    `${label} keeps document unlisted`
  );

  assertEqual(
    Number(document.requires_approval),
    1,
    `${label} preserves approval requirement`
  );

  assertEqual(
    document.requestability_status,
    "not_requestable",
    `${label} keeps document not requestable`
  );

  assertEqual(
    document.listed_at,
    null,
    `${label} leaves listed_at null`
  );

  assertEqual(
    document.requestable_at,
    null,
    `${label} leaves requestable_at null`
  );
}


async function main() {
  console.log(
    "===== U3-L REAL BEHAVIOURAL VALIDATION ====="
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
      "document_id",
      "review_action",
      "previous_document_status",
      "resulting_document_status",
      "review_notes",
      "admin_actor",
      "request_id",
      "public_visibility_created",
      "licence_created",
      "download_link_created",
      "email_sent",
      "document_activated",
      "generated_pdf_created",
      "created_at",
    ]
  ) {
    assertTrue(
      reviewColumns.has(column),
      `cdas_upload_review_events.${column} exists`
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
      "unauthenticated U3-L request rejected"
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
      "/api/admin/uploads/cdas-document/review",
      "GET exposes correct U3-L route"
    );

    assertEqual(
      result.body?.route_status,
      "cdas_draft_review_action_gate",
      "GET exposes U3-L route status"
    );

    assert.deepEqual(
      result.body?.allowed_actions,
      [
        "hold",
        "reject",
        "approve_for_activation_prep",
      ]
    );

    console.log(
      "PASS — GET exposes canonical U3-L action vocabulary"
    );

    assertEqual(
      result.body?.policy
        ?.document_must_be_draft,
      true,
      "GET confirms document must be draft"
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
        ?.activates_document,
      false,
      "GET confirms U3-L does not activate"
    );

    assertEqual(
      result.body?.policy
        ?.makes_document_requestable,
      false,
      "GET confirms U3-L does not enable requestability"
    );

    assertEqual(
      result.body?.policy
        ?.creates_licence,
      false,
      "GET confirms U3-L creates no licence"
    );
  }


  console.log(
    "\n===== INVALID ACTION ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postReview(
        DOCUMENTS.hold,
        "definitely_invalid"
      );

    assertJsonResponse(
      result,
      "invalid action"
    );

    assertEqual(
      result.status,
      400,
      "invalid action rejected"
    );

    assertEqual(
      result.body?.error,
      "upload_review_action_invalid",
      "invalid action returns canonical error"
    );

    assertEqual(
      reviewEvents(
        DOCUMENTS.hold
      ).length,
      0,
      "invalid action creates no review event"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "invalid action"
    );
  }


  console.log(
    "\n===== DOCUMENT ID REQUIRED ====="
  );

  {
    const result =
      await requestU3L({
        method:
          "POST",

        body: {
          action:
            "hold",
        },

        extraHeaders: {
          "x-admin-actor":
            ACTOR,

          "x-request-id":
            `${RUN_ID}_missing_document_id`,
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
      "upload_review_document_id_missing",
      "missing document id returns canonical error"
    );
  }


  console.log(
    "\n===== DOCUMENT NOT FOUND ====="
  );

  {
    const result =
      await postReview(
        `${RUN_ID}_missing_document`,
        "hold"
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
      "upload_review_document_not_found",
      "missing document returns canonical error"
    );
  }


  console.log(
    "\n===== DOCUMENT MUST BE DRAFT ====="
  );

  {
    const result =
      await postReview(
        DOCUMENTS.active,
        "hold"
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
      "upload_review_document_not_draft",
      "non-draft document returns canonical error"
    );
  }


  console.log(
    "\n===== DOCUMENT MUST BE UNLISTED ====="
  );

  {
    const result =
      await postReview(
        DOCUMENTS.listed,
        "hold"
      );

    assertJsonResponse(
      result,
      "listed document"
    );

    assertEqual(
      result.status,
      409,
      "listed document rejected"
    );

    assertEqual(
      result.body?.error,
      "upload_review_document_is_listed",
      "listed document returns canonical error"
    );
  }


  console.log(
    "\n===== APPROVAL REQUIREMENT ====="
  );

  {
    const result =
      await postReview(
        DOCUMENTS.noApproval,
        "hold"
      );

    assertJsonResponse(
      result,
      "approval-disabled document"
    );

    assertEqual(
      result.status,
      409,
      "approval-disabled document rejected"
    );

    assertEqual(
      result.body?.error,
      "upload_review_document_does_not_require_approval",
      "approval-disabled document returns canonical error"
    );
  }


  console.log(
    "\n===== HOLD ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const before =
      documentRow(
        DOCUMENTS.hold
      );

    const result =
      await postReview(
        DOCUMENTS.hold,
        "hold",
        {
          reviewNotes:
            "U3-L hold validation",

          requestSuffix:
            "hold",
        }
      );

    assertJsonResponse(
      result,
      "hold"
    );

    assertEqual(
      result.status,
      200,
      "hold accepted"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "hold response accepted"
    );

    assertEqual(
      result.body?.review?.action,
      "hold",
      "hold action preserved"
    );

    assertEqual(
      result.body?.review?.review_state,
      "held",
      "hold returns held review state"
    );

    assertEqual(
      result.body?.review?.next_allowed_gate,
      null,
      "hold exposes no next operational gate"
    );

    const after =
      documentRow(
        DOCUMENTS.hold
      );

    assertDocumentStillControlled(
      after,
      "hold"
    );

    assertTrue(
      after.updated_at !== before.updated_at,
      "hold touches document updated_at"
    );

    const events =
      reviewEvents(
        DOCUMENTS.hold
      );

    assertEqual(
      events.length,
      1,
      "hold creates exactly one review event"
    );

    const event =
      events[0];

    assertEqual(
      event.review_action,
      "hold",
      "hold event records canonical action"
    );

    assertTrue(
      event.id?.startsWith(
        "curv_"
      ),
      "hold event uses canonical ID prefix"
    );

    assertEqual(
      event.review_notes,
      "U3-L hold validation",
      "hold event preserves review notes"
    );

    assertEqual(
      event.admin_actor,
      ACTOR,
      "hold event records admin actor"
    );

    assertReviewEventPure(
      event,
      "hold"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "hold"
    );
  }


  console.log(
    "\n===== REJECT ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const before =
      documentRow(
        DOCUMENTS.reject
      );

    const result =
      await postReview(
        DOCUMENTS.reject,
        "reject",
        {
          reviewNotes:
            "U3-L reject validation",

          requestSuffix:
            "reject",
        }
      );

    assertJsonResponse(
      result,
      "reject"
    );

    assertEqual(
      result.status,
      200,
      "reject accepted"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "reject response accepted"
    );

    assertEqual(
      result.body?.review?.action,
      "reject",
      "reject action preserved"
    );

    assertEqual(
      result.body?.review?.review_state,
      "rejected",
      "reject returns rejected review state"
    );

    assertEqual(
      result.body?.review?.next_allowed_gate,
      null,
      "reject exposes no next operational gate"
    );

    const after =
      documentRow(
        DOCUMENTS.reject
      );

    assertDocumentStillControlled(
      after,
      "reject"
    );

    assertTrue(
      after.updated_at !== before.updated_at,
      "reject touches document updated_at"
    );

    const events =
      reviewEvents(
        DOCUMENTS.reject
      );

    assertEqual(
      events.length,
      1,
      "reject creates exactly one review event"
    );

    const event =
      events[0];

    assertEqual(
      event.review_action,
      "reject",
      "reject event records canonical action"
    );

    assertReviewEventPure(
      event,
      "reject"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "reject"
    );
  }


  console.log(
    "\n===== APPROVE FOR ACTIVATION PREP ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const before =
      documentRow(
        DOCUMENTS.approve
      );

    const result =
      await postReview(
        DOCUMENTS.approve,
        "approve_for_activation_prep",
        {
          reviewNotes:
            "U3-L activation-prep approval validation",

          requestSuffix:
            "approve",
        }
      );

    assertJsonResponse(
      result,
      "approve_for_activation_prep"
    );

    assertEqual(
      result.status,
      200,
      "approve_for_activation_prep accepted"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "approval response accepted"
    );

    assertEqual(
      result.body?.review?.action,
      "approve_for_activation_prep",
      "approval action preserved"
    );

    assertEqual(
      result.body?.review?.review_state,
      "approved_for_activation_prep",
      "approval returns activation-prep review state"
    );

    assertEqual(
      result.body?.review?.next_allowed_gate,
      "U3-M — CDAS Activation Preparation Gate",
      "approval exposes U3-M as next gate"
    );

    assertEqual(
      result.body?.prohibited_side_effects?.activated,
      false,
      "approval response confirms no activation"
    );

    assertEqual(
      result.body?.prohibited_side_effects?.licence_created,
      false,
      "approval response confirms no licence"
    );

    const after =
      documentRow(
        DOCUMENTS.approve
      );

    assertDocumentStillControlled(
      after,
      "approve_for_activation_prep"
    );

    assertTrue(
      after.updated_at !== before.updated_at,
      "approval touches document updated_at"
    );

    const events =
      reviewEvents(
        DOCUMENTS.approve
      );

    assertEqual(
      events.length,
      1,
      "approval creates exactly one review event"
    );

    const event =
      events[0];

    assertEqual(
      event.review_action,
      "approve_for_activation_prep",
      "approval event records canonical action"
    );

    assertReviewEventPure(
      event,
      "approve_for_activation_prep"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "approve_for_activation_prep"
    );
  }


  console.log(
    "\n===== CURRENT RE-REVIEW SEMANTICS ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const firstReview =
      await postReview(
        DOCUMENTS.rereview,
        "hold",
        {
          reviewNotes:
            "Initial U3-L hold",

          requestSuffix:
            "rereview_hold",
        }
      );

    assertJsonResponse(
      firstReview,
      "initial re-review fixture hold"
    );

    assertEqual(
      firstReview.status,
      200,
      "initial hold accepted"
    );

    assertEqual(
      reviewEvents(
        DOCUMENTS.rereview
      ).length,
      1,
      "initial hold creates first review event"
    );


    const secondReview =
      await postReview(
        DOCUMENTS.rereview,
        "approve_for_activation_prep",
        {
          reviewNotes:
            "Subsequent U3-L approval",

          requestSuffix:
            "rereview_approve",
        }
      );

    assertJsonResponse(
      secondReview,
      "second review"
    );

    assertEqual(
      secondReview.status,
      200,
      "current implementation permits second review"
    );

    assertEqual(
      secondReview.body?.accepted,
      true,
      "second review is accepted"
    );

    assertEqual(
      secondReview.body?.review?.action,
      "approve_for_activation_prep",
      "second review records new action"
    );

    assertEqual(
      secondReview.body?.review?.next_allowed_gate,
      "U3-M — CDAS Activation Preparation Gate",
      "second review may advance to U3-M"
    );

    const events =
      reviewEvents(
        DOCUMENTS.rereview
      );

    assertEqual(
      events.length,
      2,
      "current U3-L semantics persist multiple review events"
    );

    assertEqual(
      events[0].review_action,
      "hold",
      "review history preserves initial hold"
    );

    assertEqual(
      events[1].review_action,
      "approve_for_activation_prep",
      "review history preserves later approval"
    );

    assertReviewEventPure(
      events[0],
      "initial re-review hold"
    );

    assertReviewEventPure(
      events[1],
      "subsequent re-review approval"
    );

    const document =
      documentRow(
        DOCUMENTS.rereview
      );

    assertDocumentStillControlled(
      document,
      "re-review sequence"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "current re-review semantics"
    );

    console.log(
      "PASS — validator records current re-review behaviour without asserting finalisation semantics"
    );
  }


  console.log(
    "\n===== FINAL PROHIBITED SIDE-EFFECT ASSERTIONS ====="
  );

  assertEqual(
    countWhere(
      "cdas_activation_prep_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no activation-prep event"
  );

  assertEqual(
    countWhere(
      "cdas_activation_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no explicit activation event"
  );

  assertEqual(
    countWhere(
      "cdas_listing_requestability_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no listing/requestability event"
  );

  assertEqual(
    countWhere(
      "document_access_requests",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no document access request"
  );

  assertEqual(
    countWhere(
      "cdas_controlled_access_request_intake_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no access request intake event"
  );

  assertEqual(
    countWhere(
      "document_licences",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no document licence"
  );

  assertEqual(
    countWhere(
      "document_download_links",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no document download link"
  );

  assertEqual(
    countWhere(
      "document_access_request_licence_issue_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-L created no licence issue event"
  );


  console.log();
  console.log(
    "============================================"
  );

  console.log(
    "PASS — U3-L REAL BEHAVIOURAL VALIDATION"
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
    "PASS — canonical review action vocabulary"
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
    "PASS — hold behaviour"
  );

  console.log(
    "PASS — reject behaviour"
  );

  console.log(
    "PASS — approve-for-activation-prep behaviour"
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
    "PASS — review evidence persisted"
  );

  console.log(
    "PASS — document updated_at touched"
  );

  console.log(
    "PASS — current repeated-review semantics explicitly validated"
  );

  console.log(
    "PASS — no activation preparation performed"
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
    "PASS — U3-M exposed only after approve_for_activation_prep"
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
    "FAIL — U3-L REAL BEHAVIOURAL VALIDATION"
  );

  console.error(
    "============================================"
  );

  console.error(error);

  process.exitCode = 1;
} finally {
  cleanup();
}
