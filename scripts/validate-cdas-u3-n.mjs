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
  "u3-n-validator";

const RUN_ID =
  `u3n_${Date.now()}_${crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const REQUEST_URL =
  `${BASE_URL}/api/admin/uploads/cdas-document/activate`;


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

  noPrep:
    `${RUN_ID}_document_no_prep`,

  prepBlocked:
    `${RUN_ID}_document_prep_blocked`,

  impurePrep:
    `${RUN_ID}_document_impure_prep`,
};


const PREP_EVENTS = {
  valid:
    `${RUN_ID}_prep_valid`,

  blocked:
    `${RUN_ID}_prep_blocked`,

  impure:
    `${RUN_ID}_prep_impure`,
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


async function requestU3N({
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
  return requestU3N({
    method: "GET",
    token: null,
  });
}


async function getAuthenticated() {
  return requestU3N({
    method: "GET",
  });
}


async function postActivation(
  documentId,
  {
    activationNotes =
      "U3-N automated validation",
  } = {}
) {
  return requestU3N({
    method: "POST",
    body: {
      document_id:
        documentId,

      activation_notes:
        activationNotes,
    },
    extraHeaders: {
      "x-admin-actor":
        ACTOR,

      "x-request-id":
        `${RUN_ID}_activation_request`,
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


function activationEvents(
  documentId
) {
  return query(`
    SELECT
      id,
      document_id,
      upload_transaction_id,
      review_event_id,
      activation_prep_event_id,
      activation_status,
      previous_document_status,
      resulting_document_status,
      activation_notes,
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
    FROM cdas_activation_events
    WHERE document_id =
      ${sqlQuote(documentId)}
    ORDER BY created_at, id;
  `);
}


function captureProhibitedCounts() {
  return {
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
    `PASS — ${label}: no listing/access-request/review/licence/link/email/licence-issue side effects`
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
      'U3-N Validation Document',
      'Disposable U3-N validation fixture',
      'Disposable U3-N validation fixture',
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


function insertPrepEvent(
  id,
  documentId,
  {
    prepStatus =
      "prepared",

    publicVisibilityCreated = 0,
    documentActivated = 0,
    documentPublished = 0,
    documentRequestable = 0,
    generatedPdfCreated = 0,
    licenceCreated = 0,
    downloadLinkCreated = 0,
    emailSent = 0,

    createdAt =
      "2026-08-14T00:01:00.000Z",
  } = {}
) {
  execute(`
    INSERT INTO cdas_activation_prep_events (
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
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(documentId)},
      NULL,
      NULL,
      ${sqlQuote(prepStatus)},
      'draft',
      'draft',
      'U3-N validation prep fixture',
      ${sqlQuote(ACTOR)},
      ${sqlQuote(`${RUN_ID}_prep_request`)},
      ${sqlQuote(
        `validation/${RUN_ID}/${documentId}/source.odt`
      )},
      ${sqlQuote("a".repeat(64))},
      ${Number(publicVisibilityCreated)},
      ${Number(documentActivated)},
      ${Number(documentPublished)},
      ${Number(documentRequestable)},
      ${Number(generatedPdfCreated)},
      ${Number(licenceCreated)},
      ${Number(downloadLinkCreated)},
      ${Number(emailSent)},
      ${sqlQuote(createdAt)}
    );
  `);
}


function setupFixtures() {
  insertDocument(
    DOCUMENTS.valid
  );

  insertPrepEvent(
    PREP_EVENTS.valid,
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
    DOCUMENTS.noPrep
  );


  insertDocument(
    DOCUMENTS.prepBlocked
  );

  insertPrepEvent(
    PREP_EVENTS.blocked,
    DOCUMENTS.prepBlocked,
    {
      prepStatus:
        "blocked",
    }
  );


  insertDocument(
    DOCUMENTS.impurePrep
  );

  insertPrepEvent(
    PREP_EVENTS.impure,
    DOCUMENTS.impurePrep,
    {
      documentRequestable:
        1,
    }
  );
}


function cleanup() {
  console.log(
    "\n[U3-N] Cleaning validation fixtures."
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
    "===== U3-N REAL BEHAVIOURAL VALIDATION ====="
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


  const prepColumns =
    columnNames(
      "cdas_activation_prep_events"
    );

  for (
    const column
    of [
      "prep_status",
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


  const activationColumns =
    columnNames(
      "cdas_activation_events"
    );

  for (
    const column
    of [
      "activation_prep_event_id",
      "activation_status",
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
      activationColumns.has(column),
      `cdas_activation_events.${column} exists`
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
      "unauthenticated U3-N request rejected"
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
      "/api/admin/uploads/cdas-document/activate",
      "GET exposes correct U3-N route"
    );

    assertEqual(
      result.body?.route_status,
      "cdas_explicit_activation_gate",
      "GET exposes U3-N route status"
    );

    assertEqual(
      result.body?.policy
        ?.requires_activation_prep_event,
      true,
      "GET confirms activation prep required"
    );

    assertEqual(
      result.body?.policy
        ?.document_must_be_draft,
      true,
      "GET confirms document must be draft"
    );

    assertEqual(
      result.body?.policy
        ?.keeps_document_unlisted,
      true,
      "GET confirms activation keeps document unlisted"
    );

    assertEqual(
      result.body?.policy
        ?.keeps_approval_required,
      true,
      "GET confirms approval requirement preserved"
    );

    assertEqual(
      result.body?.policy
        ?.makes_document_requestable,
      false,
      "GET confirms U3-N does not enable requestability"
    );

    assertEqual(
      result.body?.policy
        ?.creates_licence,
      false,
      "GET confirms U3-N creates no licence"
    );
  }


  console.log(
    "\n===== DOCUMENT ID REQUIRED ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await requestU3N({
        method: "POST",
        body: {
          activation_notes:
            "missing document id",
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
      "activation_document_id_missing",
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
      await postActivation(
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
      "activation_document_not_found",
      "missing document returns canonical error"
    );
  }


  console.log(
    "\n===== DOCUMENT MUST BE DRAFT ====="
  );

  {
    const result =
      await postActivation(
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
      "activation_document_not_draft",
      "non-draft document returns canonical error"
    );
  }


  console.log(
    "\n===== DOCUMENT MUST BE UNLISTED ====="
  );

  {
    const result =
      await postActivation(
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
      "activation_document_is_listed",
      "listed draft returns canonical error"
    );
  }


  console.log(
    "\n===== APPROVAL REQUIREMENT ====="
  );

  {
    const result =
      await postActivation(
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
      "activation_document_does_not_require_approval",
      "approval-disabled draft returns canonical error"
    );
  }


  console.log(
    "\n===== SOURCE OBJECT REQUIRED ====="
  );

  {
    const result =
      await postActivation(
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
      "activation_source_object_missing",
      "missing source object returns canonical error"
    );
  }


  console.log(
    "\n===== SOURCE SHA REQUIRED ====="
  );

  {
    const result =
      await postActivation(
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
      "activation_source_sha256_missing",
      "missing source SHA returns canonical error"
    );
  }


  console.log(
    "\n===== ACTIVATION PREP REQUIRED ====="
  );

  {
    const result =
      await postActivation(
        DOCUMENTS.noPrep
      );

    assertJsonResponse(
      result,
      "activation prep missing"
    );

    assertEqual(
      result.status,
      409,
      "missing activation prep rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_event_missing",
      "missing activation prep returns canonical error"
    );
  }


  console.log(
    "\n===== PREP MUST BE PREPARED ====="
  );

  {
    const result =
      await postActivation(
        DOCUMENTS.prepBlocked
      );

    assertJsonResponse(
      result,
      "non-prepared prep event"
    );

    assertEqual(
      result.status,
      409,
      "non-prepared prep event rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_not_prepared",
      "non-prepared prep event returns canonical error"
    );
  }


  console.log(
    "\n===== IMPURE PREP EVENT ====="
  );

  {
    const result =
      await postActivation(
        DOCUMENTS.impurePrep
      );

    assertJsonResponse(
      result,
      "impure prep event"
    );

    assertEqual(
      result.status,
      409,
      "impure prep event rejected"
    );

    assertEqual(
      result.body?.error,
      "activation_prep_event_impure",
      "impure prep event returns canonical error"
    );
  }


  console.log(
    "\n===== SUCCESSFUL EXPLICIT ACTIVATION ====="
  );

  let createdActivationEventId;

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const before =
      documentRow(
        DOCUMENTS.valid
      );

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
      await postActivation(
        DOCUMENTS.valid,
        {
          activationNotes:
            "U3-N successful activation validation",
        }
      );

    assertJsonResponse(
      result,
      "successful activation"
    );

    assertEqual(
      result.status,
      200,
      "successful activation returns 200"
    );

    assertEqual(
      result.body?.ok,
      true,
      "successful activation response ok"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "successful activation accepted"
    );

    assertEqual(
      result.body?.validation_stage,
      "cdas_explicit_activation",
      "successful activation reports U3-N stage"
    );

    assertEqual(
      result.body?.document
        ?.previous_status,
      "draft",
      "response records previous draft state"
    );

    assertEqual(
      result.body?.document
        ?.resulting_status,
      "active",
      "response records resulting active state"
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
      result.body?.activation_preparation_event
        ?.id,
      PREP_EVENTS.valid,
      "response binds activation prep evidence"
    );

    assertEqual(
      result.body?.activation
        ?.next_allowed_gate,
      "U3-O — CDAS Controlled Listing and Requestability Gate",
      "response exposes U3-O as next gate"
    );

    assertEqual(
      result.body?.public_visibility
        ?.listed_publicly,
      false,
      "activation does not list document publicly"
    );

    assertEqual(
      result.body?.public_visibility
        ?.requestable_publicly,
      false,
      "activation does not make document requestable"
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
      "active",
      "activation persists active status"
    );

    assertEqual(
      Number(after.is_listed),
      0,
      "activation preserves unlisted state in D1"
    );

    assertEqual(
      Number(after.requires_approval),
      1,
      "activation preserves approval requirement in D1"
    );

    assertEqual(
      after.requestability_status,
      "not_requestable",
      "activation preserves not-requestable state"
    );

    assertEqual(
      after.listed_at,
      null,
      "activation does not populate listed_at"
    );

    assertEqual(
      after.requestable_at,
      null,
      "activation does not populate requestable_at"
    );

    const events =
      activationEvents(
        DOCUMENTS.valid
      );

    assertEqual(
      events.length,
      1,
      "successful activation creates exactly one activation event"
    );

    const event =
      events[0];

    createdActivationEventId =
      event.id;

    assertTrue(
      createdActivationEventId?.startsWith(
        "cact_"
      ),
      "activation event uses canonical ID prefix"
    );

    assertEqual(
      event.activation_prep_event_id,
      PREP_EVENTS.valid,
      "activation event binds prep event"
    );

    assertEqual(
      event.activation_status,
      "activated",
      "activation event status is activated"
    );

    assertEqual(
      event.previous_document_status,
      "draft",
      "activation event records previous draft state"
    );

    assertEqual(
      event.resulting_document_status,
      "active",
      "activation event records resulting active state"
    );

    assertEqual(
      event.source_object,
      before.source_object,
      "activation event preserves source object evidence"
    );

    assertEqual(
      event.source_sha256,
      before.source_sha256,
      "activation event preserves source SHA evidence"
    );

    assertEqual(
      Number(event.public_visibility_created),
      0,
      "activation event records no public visibility"
    );

    assertEqual(
      Number(event.document_activated),
      1,
      "activation event records explicit activation"
    );

    assertEqual(
      Number(event.document_published),
      0,
      "activation event records no publication"
    );

    assertEqual(
      Number(event.document_requestable),
      0,
      "activation event records no requestability"
    );

    assertEqual(
      Number(event.generated_pdf_created),
      0,
      "activation event records no PDF"
    );

    assertEqual(
      Number(event.licence_created),
      0,
      "activation event records no licence"
    );

    assertEqual(
      Number(event.download_link_created),
      0,
      "activation event records no download link"
    );

    assertEqual(
      Number(event.email_sent),
      0,
      "activation event records no email"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "successful activation"
    );
  }


  console.log(
    "\n===== REPEAT ACTIVATION FAILS SAFE ====="
  );

  {
    const eventsBefore =
      activationEvents(
        DOCUMENTS.valid
      ).length;

    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postActivation(
        DOCUMENTS.valid
      );

    assertJsonResponse(
      result,
      "repeat activation"
    );

    assertEqual(
      result.status,
      409,
      "repeat activation rejected after document became active"
    );

    assertEqual(
      result.body?.error,
      "activation_document_not_draft",
      "repeat activation fails at draft boundary"
    );

    assertEqual(
      activationEvents(
        DOCUMENTS.valid
      ).length,
      eventsBefore,
      "repeat activation creates no second activation event"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "repeat activation"
    );
  }


  console.log(
    "\n===== FINAL PROHIBITED SIDE-EFFECT ASSERTIONS ====="
  );

  assertEqual(
    countWhere(
      "cdas_listing_requestability_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-N created no listing/requestability event"
  );

  assertEqual(
    countWhere(
      "document_access_requests",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-N created no document access request"
  );

  assertEqual(
    countWhere(
      "cdas_controlled_access_request_intake_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-N created no access request intake event"
  );

  assertEqual(
    countWhere(
      "document_access_request_review_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-N created no access request review event"
  );

  assertEqual(
    countWhere(
      "document_licences",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-N created no document licence"
  );

  assertEqual(
    countWhere(
      "document_download_links",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-N created no document download link"
  );

  assertEqual(
    countWhere(
      "document_access_request_licence_issue_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-N created no licence issue event"
  );


  console.log();
  console.log(
    "============================================"
  );

  console.log(
    "PASS — U3-N REAL BEHAVIOURAL VALIDATION"
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
    "PASS — activation prep required"
  );

  console.log(
    "PASS — prep must be prepared"
  );

  console.log(
    "PASS — impure prep evidence rejected"
  );

  console.log(
    "PASS — explicit activation behaviour"
  );

  console.log(
    "PASS — document becomes active"
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
    "PASS — activation event persisted"
  );

  console.log(
    "PASS — prep evidence binding preserved"
  );

  console.log(
    "PASS — source evidence binding preserved"
  );

  console.log(
    "PASS — repeat activation fails safely"
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
    "PASS — U3-O remains the next allowed gate"
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
    "FAIL — U3-N REAL BEHAVIOURAL VALIDATION"
  );

  console.error(
    "============================================"
  );

  console.error(error);

  process.exitCode = 1;
} finally {
  cleanup();
}