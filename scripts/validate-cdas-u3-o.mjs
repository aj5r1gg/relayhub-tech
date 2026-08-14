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
  "u3-o-validator";

const RUN_ID =
  `u3o_${Date.now()}_${crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const REQUEST_URL =
  `${BASE_URL}/api/admin/uploads/cdas-document/listing-requestability`;


const DOCUMENTS = {
  stateMachine:
    `${RUN_ID}_document_state_machine`,

  inactive:
    `${RUN_ID}_document_inactive`,

  noApproval:
    `${RUN_ID}_document_no_approval`,

  noSource:
    `${RUN_ID}_document_no_source`,

  noSha:
    `${RUN_ID}_document_no_sha`,

  noActivation:
    `${RUN_ID}_document_no_activation`,

  activationNotActivated:
    `${RUN_ID}_document_activation_not_activated`,

  impureActivation:
    `${RUN_ID}_document_impure_activation`,
};


const ACTIVATION_EVENTS = {
  stateMachine:
    `${RUN_ID}_activation_state_machine`,

  notActivated:
    `${RUN_ID}_activation_not_activated`,

  impure:
    `${RUN_ID}_activation_impure`,
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


function assertNotEqual(
  actual,
  expected,
  message
) {
  assert.notEqual(
    actual,
    expected,
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


async function requestU3O({
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
  return requestU3O({
    method: "GET",
    token: null,
  });
}


async function getAuthenticated() {
  return requestU3O({
    method: "GET",
  });
}


async function postAction(
  documentId,
  action,
  {
    actionNotes =
      `U3-O validation ${action}`,
  } = {}
) {
  return requestU3O({
    method: "POST",
    body: {
      document_id:
        documentId,

      action,

      action_notes:
        actionNotes,
    },
    extraHeaders: {
      "x-admin-actor":
        ACTOR,

      "x-request-id":
        `${RUN_ID}_${action}`,
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


function listingEvents(
  documentId
) {
  return query(`
    SELECT
      id,
      document_id,
      activation_event_id,
      action,
      previous_document_status,
      resulting_document_status,
      previous_is_listed,
      resulting_is_listed,
      previous_requestability_status,
      resulting_requestability_status,
      requires_approval,
      action_notes,
      admin_actor,
      request_id,
      public_visibility_created,
      document_requestable,
      document_downloadable,
      generated_pdf_created,
      licence_created,
      download_link_created,
      email_sent,
      created_at
    FROM cdas_listing_requestability_events
    WHERE document_id =
      ${sqlQuote(documentId)}
    ORDER BY created_at, id;
  `);
}


function captureProhibitedCounts() {
  return {
    accessRequests:
      countWhere(
        "document_access_requests"
      ),

    reviewEvents:
      countWhere(
        "document_access_request_review_events"
      ),

    intakeEvents:
      countWhere(
        "cdas_controlled_access_request_intake_events"
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
    `PASS — ${label}: no access-request/review/licence/link/email/licence-issue side effects`
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
    status = "active",
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

    listedAt = null,
    requestableAt = null,
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
      'U3-O Validation Document',
      'Disposable U3-O validation fixture',
      'Disposable U3-O validation fixture',
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
      ${sqlQuote(listedAt)},
      ${sqlQuote(requestableAt)}
    );
  `);
}


function insertActivationEvent(
  id,
  documentId,
  {
    activationStatus =
      "activated",

    publicVisibilityCreated = 0,
    documentActivated = 1,
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
    INSERT INTO cdas_activation_events (
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
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(documentId)},
      NULL,
      NULL,
      NULL,
      ${sqlQuote(activationStatus)},
      'draft',
      'active',
      'U3-O validation activation fixture',
      ${sqlQuote(ACTOR)},
      ${sqlQuote(`${RUN_ID}_activation_request`)},
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
    DOCUMENTS.stateMachine,
    {
      status:
        "active",

      isListed:
        0,

      requiresApproval:
        1,

      requestabilityStatus:
        "not_requestable",
    }
  );

  insertActivationEvent(
    ACTIVATION_EVENTS.stateMachine,
    DOCUMENTS.stateMachine
  );


  insertDocument(
    DOCUMENTS.inactive,
    {
      status:
        "draft",
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
    DOCUMENTS.noActivation
  );


  insertDocument(
    DOCUMENTS.activationNotActivated
  );

  insertActivationEvent(
    ACTIVATION_EVENTS.notActivated,
    DOCUMENTS.activationNotActivated,
    {
      activationStatus:
        "blocked",
    }
  );


  insertDocument(
    DOCUMENTS.impureActivation
  );

  insertActivationEvent(
    ACTIVATION_EVENTS.impure,
    DOCUMENTS.impureActivation,
    {
      licenceCreated:
        1,
    }
  );
}


function cleanup() {
  console.log(
    "\n[U3-O] Cleaning validation fixtures."
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
    "===== U3-O REAL BEHAVIOURAL VALIDATION ====="
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


  const documentColumns =
    columnNames("documents");

  for (
    const column
    of [
      "is_listed",
      "requires_approval",
      "requestability_status",
      "listed_at",
      "requestable_at",
    ]
  ) {
    assertTrue(
      documentColumns.has(column),
      `documents.${column} exists`
    );
  }


  const eventColumns =
    columnNames(
      "cdas_listing_requestability_events"
    );

  for (
    const column
    of [
      "activation_event_id",
      "action",
      "previous_is_listed",
      "resulting_is_listed",
      "previous_requestability_status",
      "resulting_requestability_status",
      "requires_approval",
      "public_visibility_created",
      "document_requestable",
      "document_downloadable",
      "generated_pdf_created",
      "licence_created",
      "download_link_created",
      "email_sent",
    ]
  ) {
    assertTrue(
      eventColumns.has(column),
      `cdas_listing_requestability_events.${column} exists`
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
      "unauthenticated U3-O request rejected"
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
      "/api/admin/uploads/cdas-document/listing-requestability",
      "GET exposes correct U3-O route"
    );

    assertEqual(
      result.body?.route_status,
      "cdas_controlled_listing_requestability_gate",
      "GET exposes U3-O route status"
    );

    assert.deepEqual(
      result.body?.allowed_actions,
      [
        "list_only",
        "enable_requestability",
        "disable_requestability",
        "unlist",
      ]
    );

    console.log(
      "PASS — GET exposes canonical U3-O action vocabulary"
    );

    assertEqual(
      result.body?.policy
        ?.requires_explicit_activation,
      true,
      "GET confirms explicit activation required"
    );

    assertEqual(
      result.body?.policy
        ?.document_must_be_active,
      true,
      "GET confirms document must be active"
    );

    assertEqual(
      result.body?.policy
        ?.requires_approval_must_remain_enabled,
      true,
      "GET confirms approval requirement preserved"
    );

    assertEqual(
      result.body?.policy
        ?.creates_licence,
      false,
      "GET confirms U3-O creates no licence"
    );
  }


  console.log(
    "\n===== INVALID ACTION ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postAction(
        DOCUMENTS.stateMachine,
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
      "listing_requestability_action_invalid",
      "invalid action returns canonical error"
    );

    assertEqual(
      listingEvents(
        DOCUMENTS.stateMachine
      ).length,
      0,
      "invalid action creates no U3-O event"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "invalid action"
    );
  }


  console.log(
    "\n===== DOCUMENT NOT FOUND ====="
  );

  {
    const result =
      await postAction(
        `${RUN_ID}_missing_document`,
        "list_only"
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
      "listing_requestability_document_not_found",
      "missing document returns canonical error"
    );
  }


  console.log(
    "\n===== INACTIVE DOCUMENT ====="
  );

  {
    const result =
      await postAction(
        DOCUMENTS.inactive,
        "list_only"
      );

    assertJsonResponse(
      result,
      "inactive document"
    );

    assertEqual(
      result.status,
      409,
      "inactive document rejected"
    );

    assertEqual(
      result.body?.error,
      "listing_requestability_document_not_active",
      "inactive document returns canonical error"
    );
  }


  console.log(
    "\n===== APPROVAL REQUIREMENT ====="
  );

  {
    const result =
      await postAction(
        DOCUMENTS.noApproval,
        "list_only"
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
      "listing_requestability_document_does_not_require_approval",
      "approval-disabled document returns canonical error"
    );
  }


  console.log(
    "\n===== SOURCE OBJECT REQUIRED ====="
  );

  {
    const result =
      await postAction(
        DOCUMENTS.noSource,
        "list_only"
      );

    assertJsonResponse(
      result,
      "source-object missing"
    );

    assertEqual(
      result.status,
      409,
      "missing source object rejected"
    );

    assertEqual(
      result.body?.error,
      "listing_requestability_source_object_missing",
      "missing source object returns canonical error"
    );
  }


  console.log(
    "\n===== SOURCE SHA REQUIRED ====="
  );

  {
    const result =
      await postAction(
        DOCUMENTS.noSha,
        "list_only"
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
      "listing_requestability_source_sha256_missing",
      "missing source SHA returns canonical error"
    );
  }


  console.log(
    "\n===== ACTIVATION EVENT REQUIRED ====="
  );

  {
    const result =
      await postAction(
        DOCUMENTS.noActivation,
        "list_only"
      );

    assertJsonResponse(
      result,
      "activation event missing"
    );

    assertEqual(
      result.status,
      409,
      "missing activation event rejected"
    );

    assertEqual(
      result.body?.error,
      "listing_requestability_activation_event_missing",
      "missing activation event returns canonical error"
    );
  }


  console.log(
    "\n===== ACTIVATION MUST BE ACTIVATED ====="
  );

  {
    const result =
      await postAction(
        DOCUMENTS.activationNotActivated,
        "list_only"
      );

    assertJsonResponse(
      result,
      "non-activated activation event"
    );

    assertEqual(
      result.status,
      409,
      "non-activated event rejected"
    );

    assertEqual(
      result.body?.error,
      "listing_requestability_activation_not_activated",
      "non-activated event returns canonical error"
    );
  }


  console.log(
    "\n===== IMPURE ACTIVATION EVENT ====="
  );

  {
    const result =
      await postAction(
        DOCUMENTS.impureActivation,
        "list_only"
      );

    assertJsonResponse(
      result,
      "impure activation event"
    );

    assertEqual(
      result.status,
      409,
      "impure activation event rejected"
    );

    assertEqual(
      result.body?.error,
      "listing_requestability_activation_event_impure",
      "impure activation event returns canonical error"
    );
  }


  console.log(
    "\n===== STATE MACHINE: LIST ONLY ====="
  );

  let listedAtAfterListOnly;

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const before =
      documentRow(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      Number(before.is_listed),
      0,
      "state machine starts unlisted"
    );

    assertEqual(
      before.requestability_status,
      "not_requestable",
      "state machine starts not requestable"
    );

    assertEqual(
      before.listed_at,
      null,
      "state machine starts without listed_at"
    );

    assertEqual(
      before.requestable_at,
      null,
      "state machine starts without requestable_at"
    );

    const result =
      await postAction(
        DOCUMENTS.stateMachine,
        "list_only"
      );

    assertJsonResponse(
      result,
      "list_only"
    );

    assertEqual(
      result.status,
      200,
      "list_only accepted"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "list_only response accepted"
    );

    assertEqual(
      result.body?.document
        ?.resulting_is_listed,
      1,
      "list_only response lists document"
    );

    assertEqual(
      result.body?.document
        ?.resulting_requestability_status,
      "not_requestable",
      "list_only response leaves document not requestable"
    );

    const after =
      documentRow(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      Number(after.is_listed),
      1,
      "list_only persists listed state"
    );

    assertEqual(
      after.requestability_status,
      "not_requestable",
      "list_only persists not_requestable"
    );

    assertTrue(
      Boolean(after.listed_at),
      "list_only populates listed_at"
    );

    assertEqual(
      after.requestable_at,
      null,
      "list_only leaves requestable_at null"
    );

    assertEqual(
      after.status,
      "active",
      "list_only preserves active status"
    );

    assertEqual(
      Number(after.requires_approval),
      1,
      "list_only preserves approval requirement"
    );

    listedAtAfterListOnly =
      after.listed_at;

    const events =
      listingEvents(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      events.length,
      1,
      "list_only creates exactly one U3-O event"
    );

    const event =
      events[0];

    assertEqual(
      event.action,
      "list_only",
      "list_only event records action"
    );

    assertEqual(
      event.activation_event_id,
      ACTIVATION_EVENTS.stateMachine,
      "list_only event references activation evidence"
    );

    assertEqual(
      Number(event.previous_is_listed),
      0,
      "list_only event records previous listing state"
    );

    assertEqual(
      Number(event.resulting_is_listed),
      1,
      "list_only event records resulting listing state"
    );

    assertEqual(
      event.resulting_requestability_status,
      "not_requestable",
      "list_only event records resulting requestability state"
    );

    assertEqual(
      Number(event.public_visibility_created),
      1,
      "list_only event records visibility creation"
    );

    assertEqual(
      Number(event.document_requestable),
      0,
      "list_only event records document not requestable"
    );

    assertEqual(
      Number(event.document_downloadable),
      0,
      "list_only event records no direct download"
    );

    assertEqual(
      Number(event.generated_pdf_created),
      0,
      "list_only event records no PDF"
    );

    assertEqual(
      Number(event.licence_created),
      0,
      "list_only event records no licence"
    );

    assertEqual(
      Number(event.download_link_created),
      0,
      "list_only event records no download link"
    );

    assertEqual(
      Number(event.email_sent),
      0,
      "list_only event records no email"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "list_only"
    );
  }


  console.log(
    "\n===== STATE MACHINE: ENABLE REQUESTABILITY ====="
  );

  let requestableAtAfterEnable;

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postAction(
        DOCUMENTS.stateMachine,
        "enable_requestability"
      );

    assertJsonResponse(
      result,
      "enable_requestability"
    );

    assertEqual(
      result.status,
      200,
      "enable_requestability accepted"
    );

    assertEqual(
      result.body?.document
        ?.resulting_is_listed,
      1,
      "enable_requestability keeps document listed"
    );

    assertEqual(
      result.body?.document
        ?.resulting_requestability_status,
      "requestable_with_approval",
      "enable_requestability enables controlled requestability"
    );

    assertEqual(
      result.body?.listing_requestability
        ?.next_allowed_gate,
      "U3-P — CDAS Controlled Access Request Intake Gate",
      "enable_requestability exposes U3-P as next gate"
    );

    const after =
      documentRow(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      Number(after.is_listed),
      1,
      "enable_requestability keeps listed state"
    );

    assertEqual(
      after.requestability_status,
      "requestable_with_approval",
      "enable_requestability persists controlled requestability"
    );

    assertEqual(
      after.listed_at,
      listedAtAfterListOnly,
      "enable_requestability preserves listed_at"
    );

    assertTrue(
      Boolean(after.requestable_at),
      "enable_requestability populates requestable_at"
    );

    requestableAtAfterEnable =
      after.requestable_at;

    const events =
      listingEvents(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      events.length,
      2,
      "enable_requestability creates second U3-O event"
    );

    const event =
      events[1];

    assertEqual(
      event.action,
      "enable_requestability",
      "enable requestability event records action"
    );

    assertEqual(
      event.previous_requestability_status,
      "not_requestable",
      "enable requestability event records previous state"
    );

    assertEqual(
      event.resulting_requestability_status,
      "requestable_with_approval",
      "enable requestability event records resulting state"
    );

    assertEqual(
      Number(event.document_requestable),
      1,
      "enable requestability event records transition"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "enable_requestability"
    );
  }


  console.log(
    "\n===== STATE MACHINE: REPEAT ENABLE REQUESTABILITY ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postAction(
        DOCUMENTS.stateMachine,
        "enable_requestability"
      );

    assertJsonResponse(
      result,
      "repeat enable_requestability"
    );

    assertEqual(
      result.status,
      200,
      "repeat enable_requestability accepted"
    );

    const after =
      documentRow(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      after.requestable_at,
      requestableAtAfterEnable,
      "repeat enable preserves original requestable_at"
    );

    const events =
      listingEvents(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      events.length,
      3,
      "repeat enable creates evidence event"
    );

    const event =
      events[2];

    assertEqual(
      event.action,
      "enable_requestability",
      "repeat enable event records action"
    );

    assertEqual(
      event.previous_requestability_status,
      "requestable_with_approval",
      "repeat enable records already-requestable state"
    );

    assertEqual(
      Number(event.document_requestable),
      0,
      "repeat enable records no new requestability transition"
    );

    assertEqual(
      Number(event.public_visibility_created),
      0,
      "repeat enable records no new public visibility transition"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "repeat enable_requestability"
    );
  }


  console.log(
    "\n===== STATE MACHINE: DISABLE REQUESTABILITY ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postAction(
        DOCUMENTS.stateMachine,
        "disable_requestability"
      );

    assertJsonResponse(
      result,
      "disable_requestability"
    );

    assertEqual(
      result.status,
      200,
      "disable_requestability accepted"
    );

    const after =
      documentRow(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      Number(after.is_listed),
      1,
      "disable_requestability preserves listed state"
    );

    assertEqual(
      after.requestability_status,
      "not_requestable",
      "disable_requestability persists not_requestable"
    );

    assertEqual(
      after.listed_at,
      listedAtAfterListOnly,
      "disable_requestability preserves listed_at"
    );

    assertEqual(
      after.requestable_at,
      null,
      "disable_requestability clears requestable_at"
    );

    const events =
      listingEvents(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      events.length,
      4,
      "disable_requestability creates fourth U3-O event"
    );

    const event =
      events[3];

    assertEqual(
      event.action,
      "disable_requestability",
      "disable requestability event records action"
    );

    assertEqual(
      event.resulting_requestability_status,
      "not_requestable",
      "disable event records not_requestable"
    );

    assertEqual(
      Number(event.resulting_is_listed),
      1,
      "disable event preserves listing"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "disable_requestability"
    );
  }


  console.log(
    "\n===== STATE MACHINE: RE-ENABLE REQUESTABILITY ====="
  );

  let secondRequestableAt;

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postAction(
        DOCUMENTS.stateMachine,
        "enable_requestability"
      );

    assertJsonResponse(
      result,
      "re-enable requestability"
    );

    assertEqual(
      result.status,
      200,
      "re-enable requestability accepted"
    );

    const after =
      documentRow(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      after.requestability_status,
      "requestable_with_approval",
      "re-enable restores controlled requestability"
    );

    assertTrue(
      Boolean(after.requestable_at),
      "re-enable repopulates requestable_at"
    );

    secondRequestableAt =
      after.requestable_at;

    assertNotEqual(
      secondRequestableAt,
      null,
      "re-enable has concrete requestable_at"
    );

    const events =
      listingEvents(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      events.length,
      5,
      "re-enable creates fifth U3-O event"
    );

    assertEqual(
      Number(events[4].document_requestable),
      1,
      "re-enable event records new requestability transition"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "re-enable requestability"
    );
  }


  console.log(
    "\n===== STATE MACHINE: UNLIST ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postAction(
        DOCUMENTS.stateMachine,
        "unlist"
      );

    assertJsonResponse(
      result,
      "unlist"
    );

    assertEqual(
      result.status,
      200,
      "unlist accepted"
    );

    assertEqual(
      result.body?.document
        ?.resulting_is_listed,
      0,
      "unlist response removes listing"
    );

    assertEqual(
      result.body?.document
        ?.resulting_requestability_status,
      "not_requestable",
      "unlist response removes requestability"
    );

    const after =
      documentRow(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      Number(after.is_listed),
      0,
      "unlist persists unlisted state"
    );

    assertEqual(
      after.requestability_status,
      "not_requestable",
      "unlist persists not_requestable"
    );

    assertEqual(
      after.listed_at,
      null,
      "unlist clears listed_at"
    );

    assertEqual(
      after.requestable_at,
      null,
      "unlist clears requestable_at"
    );

    assertEqual(
      after.status,
      "active",
      "unlist preserves active document status"
    );

    assertEqual(
      Number(after.requires_approval),
      1,
      "unlist preserves approval requirement"
    );

    const events =
      listingEvents(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      events.length,
      6,
      "unlist creates sixth U3-O event"
    );

    const event =
      events[5];

    assertEqual(
      event.action,
      "unlist",
      "unlist event records action"
    );

    assertEqual(
      Number(event.previous_is_listed),
      1,
      "unlist event records previous listed state"
    );

    assertEqual(
      Number(event.resulting_is_listed),
      0,
      "unlist event records resulting unlisted state"
    );

    assertEqual(
      event.previous_requestability_status,
      "requestable_with_approval",
      "unlist event records previous requestability"
    );

    assertEqual(
      event.resulting_requestability_status,
      "not_requestable",
      "unlist event records requestability removed"
    );

    assertEqual(
      Number(event.document_requestable),
      0,
      "unlist event records no requestability creation"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "unlist"
    );
  }


  console.log(
    "\n===== FINAL U3-O EVENT EVIDENCE ====="
  );

  {
    const events =
      listingEvents(
        DOCUMENTS.stateMachine
      );

    assertEqual(
      events.length,
      6,
      "state-machine validation produced exactly six U3-O events"
    );

    for (
      const event
      of events
    ) {
      assertEqual(
        event.activation_event_id,
        ACTIVATION_EVENTS.stateMachine,
        `${event.action} event bound to explicit activation evidence`
      );

      assertEqual(
        event.resulting_document_status,
        "active",
        `${event.action} event preserves active document state`
      );

      assertEqual(
        Number(event.requires_approval),
        1,
        `${event.action} event preserves approval requirement`
      );

      assertEqual(
        Number(event.document_downloadable),
        0,
        `${event.action} event records no direct download`
      );

      assertEqual(
        Number(event.generated_pdf_created),
        0,
        `${event.action} event records no PDF`
      );

      assertEqual(
        Number(event.licence_created),
        0,
        `${event.action} event records no licence`
      );

      assertEqual(
        Number(event.download_link_created),
        0,
        `${event.action} event records no download link`
      );

      assertEqual(
        Number(event.email_sent),
        0,
        `${event.action} event records no email`
      );
    }
  }


  console.log(
    "\n===== FINAL PROHIBITED SIDE-EFFECT ASSERTIONS ====="
  );

  assertEqual(
    countWhere(
      "document_access_requests",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-O created no document access request"
  );

  assertEqual(
    countWhere(
      "cdas_controlled_access_request_intake_events",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-O created no access request intake event"
  );

  assertEqual(
    countWhere(
      "document_licences",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-O created no document licence"
  );

  assertEqual(
    countWhere(
      "document_download_links",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-O created no document download link"
  );

  assertEqual(
    countWhere(
      "document_access_request_licence_issue_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-O created no licence issue event"
  );


  console.log();
  console.log(
    "============================================"
  );

  console.log(
    "PASS — U3-O REAL BEHAVIOURAL VALIDATION"
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
    "PASS — invalid action fails closed"
  );

  console.log(
    "PASS — document eligibility fails closed"
  );

  console.log(
    "PASS — explicit activation required"
  );

  console.log(
    "PASS — non-activated evidence rejected"
  );

  console.log(
    "PASS — impure activation evidence rejected"
  );

  console.log(
    "PASS — list_only behaviour"
  );

  console.log(
    "PASS — enable_requestability behaviour"
  );

  console.log(
    "PASS — repeated enable behaviour"
  );

  console.log(
    "PASS — disable_requestability behaviour"
  );

  console.log(
    "PASS — re-enable behaviour"
  );

  console.log(
    "PASS — unlist behaviour"
  );

  console.log(
    "PASS — listed_at transitions"
  );

  console.log(
    "PASS — requestable_at transitions"
  );

  console.log(
    "PASS — U3-O event evidence persisted"
  );

  console.log(
    "PASS — activation evidence binding preserved"
  );

  console.log(
    "PASS — active status preserved"
  );

  console.log(
    "PASS — approval requirement preserved"
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
    "PASS — U3-P remains the next gate only when requestability is enabled"
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
    "FAIL — U3-O REAL BEHAVIOURAL VALIDATION"
  );

  console.error(
    "============================================"
  );

  console.error(error);

  process.exitCode = 1;
} finally {
  cleanup();
}