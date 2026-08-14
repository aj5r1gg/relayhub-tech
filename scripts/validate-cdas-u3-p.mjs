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

const RUN_ID =
  `u3p_${Date.now()}_${crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const REQUEST_URL =
  `${BASE_URL}/api/admin/uploads/cdas-document/access-request`;

const ACTOR =
  "u3-p-validator";


const DOCUMENTS = {
  valid: `${RUN_ID}_document_valid`,
  inactive: `${RUN_ID}_document_inactive`,
  unlisted: `${RUN_ID}_document_unlisted`,
  notRequestable: `${RUN_ID}_document_not_requestable`,
  noApproval: `${RUN_ID}_document_no_approval`,
  noSource: `${RUN_ID}_document_no_source`,
  noSha: `${RUN_ID}_document_no_sha`,
  noTerms: `${RUN_ID}_document_no_terms`,
  noListingEvent: `${RUN_ID}_document_no_listing_event`,
  badListingEvent: `${RUN_ID}_document_bad_listing_event`,
  impureListingEvent: `${RUN_ID}_document_impure_listing_event`,
};

const LISTING_EVENTS = {
  valid: `${RUN_ID}_listing_valid`,
  bad: `${RUN_ID}_listing_bad`,
  impure: `${RUN_ID}_listing_impure`,
};

const EMAILS = {
  successInput: `Mixed.Case.${RUN_ID}@Example.COM`,
  successCanonical:
    `mixed.case.${RUN_ID}@example.com`,
  duplicateInput:
    `MIXED.CASE.${RUN_ID}@EXAMPLE.COM`,
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


async function requestU3P({
  method = "GET",
  token = ADMIN_TOKEN,
  body = undefined,
  extraHeaders = {},
} = {}) {
  const headers = {
    "Connection": "close",
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
  return requestU3P({
    method: "GET",
    token: null,
  });
}


async function getAuthenticated() {
  return requestU3P({
    method: "GET",
  });
}


async function postIntake(body) {
  return requestU3P({
    method: "POST",
    body,
    extraHeaders: {
      "x-admin-actor":
        ACTOR,
      "x-request-id":
        `${RUN_ID}_request_trace`,
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


function documentAccessRequestsForDocument(
  documentId
) {
  return query(`
    SELECT
      id,
      document_id,
      document_version,
      name,
      email,
      email_normalised,
      licence_holder_type,
      organisation_name,
      contact_name,
      contact_email,
      role_title,
      recipient_category,
      status,
      access_class,
      requested_at,
      approved_at,
      denied_at,
      terms_version,
      risk_score,
      intake_source,
      request_review_status,
      requestability_status_at_intake,
      intake_event_id
    FROM document_access_requests
    WHERE document_id =
      ${sqlQuote(documentId)}
    ORDER BY requested_at, id;
  `);
}


function intakeEventsForDocument(
  documentId
) {
  return query(`
    SELECT
      id,
      access_request_id,
      document_id,
      listing_requestability_event_id,
      requester_name,
      requester_email,
      requester_organisation,
      requester_reason,
      intake_status,
      document_status,
      document_is_listed,
      document_requestability_status,
      document_requires_approval,
      request_status,
      request_review_status,
      admin_actor,
      request_id,
      licence_created,
      generated_pdf_created,
      download_link_created,
      email_sent,
      access_approved,
      direct_download_created,
      created_at
    FROM cdas_controlled_access_request_intake_events
    WHERE document_id =
      ${sqlQuote(documentId)}
    ORDER BY created_at, id;
  `);
}


function reviewEventsForRun() {
  return query(`
    SELECT
      id,
      request_id,
      event_type
    FROM document_access_request_review_events
    WHERE request_id LIKE
      ${sqlQuote(`${RUN_ID}%`)};
  `);
}


function captureGlobalProhibitedCounts() {
  return {
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
    captureGlobalProhibitedCounts();

  assert.deepEqual(
    after,
    before,
    `${label}: prohibited side-effect tables changed`
  );

  console.log(
    `PASS — ${label}: no review/licence/link/email/licence-issue side effects`
  );
}


function makeDocumentSlug(
  documentId
) {
  return documentId
    .replaceAll("_", "-");
}


function insertDocument(
  id,
  {
    status = "active",
    isListed = 1,
    requiresApproval = 1,
    requestabilityStatus =
      "requestable_with_approval",
    sourceObject =
      `validation/${RUN_ID}/${id}/source.odt`,
    sourceSha256 =
      "a".repeat(64),
    version =
      "v-test",
    licenceTermsVersion =
      "validation-terms-v1",
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
      ${sqlQuote(makeDocumentSlug(id))},
      'U3-P Validation Document',
      'Disposable U3-P validation fixture',
      'Disposable U3-P validation fixture',
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
      '2026-08-14T00:00:00.000Z',
      '2026-08-14T00:00:00.000Z'
    );
  `);
}


function insertListingEvent(
  id,
  documentId,
  {
    action =
      "enable_requestability",
    resultingIsListed = 1,
    resultingRequestabilityStatus =
      "requestable_with_approval",
    requiresApproval = 1,
    documentRequestable = 1,
    documentDownloadable = 0,
    generatedPdfCreated = 0,
    licenceCreated = 0,
    downloadLinkCreated = 0,
    emailSent = 0,
  } = {}
) {
  execute(`
    INSERT INTO cdas_listing_requestability_events (
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
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(documentId)},
      NULL,
      ${sqlQuote(action)},
      'active',
      'active',
      1,
      ${Number(resultingIsListed)},
      'not_requestable',
      ${sqlQuote(
        resultingRequestabilityStatus
      )},
      ${Number(requiresApproval)},
      'U3-P validation fixture',
      ${sqlQuote(ACTOR)},
      ${sqlQuote(
        `${RUN_ID}_listing_request`
      )},
      1,
      ${Number(documentRequestable)},
      ${Number(documentDownloadable)},
      ${Number(generatedPdfCreated)},
      ${Number(licenceCreated)},
      ${Number(downloadLinkCreated)},
      ${Number(emailSent)},
      '2026-08-14T00:00:00.000Z'
    );
  `);
}


function baseIntakeBody(
  documentId,
  email = EMAILS.successInput
) {
  return {
    document_id:
      documentId,

    requester_name:
      "U3-P Validator",

    requester_email:
      email,

    requester_organisation:
      "RelayHub Validation",

    requester_reason:
      "Automated U3-P behavioural validation",

    licence_holder_type:
      "organisation",

    contact_name:
      "U3-P Validator",

    contact_email:
      email,

    role_title:
      "Validation Operator",

    recipient_category:
      "Validation Tester",
  };
}


function assertNoRequestCreated(
  documentId,
  message
) {
  assertEqual(
    documentAccessRequestsForDocument(
      documentId
    ).length,
    0,
    message
  );
}


function assertNoIntakeEventCreated(
  documentId,
  message
) {
  assertEqual(
    intakeEventsForDocument(
      documentId
    ).length,
    0,
    message
  );
}


function setupFixtures() {
  insertDocument(
    DOCUMENTS.valid
  );

  insertListingEvent(
    LISTING_EVENTS.valid,
    DOCUMENTS.valid
  );


  insertDocument(
    DOCUMENTS.inactive,
    {
      status:
        "draft",
    }
  );


  insertDocument(
    DOCUMENTS.unlisted,
    {
      isListed:
        0,
    }
  );


  insertDocument(
    DOCUMENTS.notRequestable,
    {
      requestabilityStatus:
        "not_requestable",
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
      sourceObject: "",
    }
  );

  insertDocument(
    DOCUMENTS.noSha,
    {
      sourceSha256: null,
    }
  );

  insertDocument(
    DOCUMENTS.noTerms,
    {
      licenceTermsVersion: "",
    }
  );

  insertDocument(
    DOCUMENTS.noListingEvent
  );


  insertDocument(
    DOCUMENTS.badListingEvent
  );

  insertListingEvent(
    LISTING_EVENTS.bad,
    DOCUMENTS.badListingEvent,
    {
      resultingRequestabilityStatus:
        "not_requestable",

      documentRequestable:
        0,
    }
  );


  insertDocument(
    DOCUMENTS.impureListingEvent
  );

  insertListingEvent(
    LISTING_EVENTS.impure,
    DOCUMENTS.impureListingEvent,
    {
      licenceCreated:
        1,
    }
  );
}


function cleanup() {
  console.log(
    "\n[U3-P] Cleaning validation fixtures."
  );

  try {
    execute(`
      DELETE FROM document_access_request_review_events
      WHERE request_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM cdas_controlled_access_request_intake_events
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM document_access_requests
      WHERE document_id LIKE
        ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM cdas_listing_requestability_events
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
    "===== U3-P REAL BEHAVIOURAL VALIDATION ====="
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


  const requestColumns =
    columnNames(
      "document_access_requests"
    );

  for (
    const column
    of [
      "intake_source",
      "request_review_status",
      "requestability_status_at_intake",
      "intake_event_id",
    ]
  ) {
    assertTrue(
      requestColumns.has(column),
      `document_access_requests.${column} exists`
    );
  }


  const intakeColumns =
    columnNames(
      "cdas_controlled_access_request_intake_events"
    );

  for (
    const column
    of [
      "access_request_id",
      "listing_requestability_event_id",
      "intake_status",
      "request_status",
      "request_review_status",
      "licence_created",
      "generated_pdf_created",
      "download_link_created",
      "email_sent",
      "access_approved",
      "direct_download_created",
    ]
  ) {
    assertTrue(
      intakeColumns.has(column),
      `cdas_controlled_access_request_intake_events.${column} exists`
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
      "unauthenticated U3-P request rejected"
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
      "/api/admin/uploads/cdas-document/access-request",
      "GET exposes correct U3-P route"
    );

    assertEqual(
      result.body?.route_status,
      "cdas_controlled_access_request_intake_gate",
      "GET exposes U3-P route status"
    );

    assertEqual(
      result.body?.policy?.target_table,
      "document_access_requests",
      "GET exposes canonical target table"
    );

    assertEqual(
      result.body?.policy?.request_status,
      "pending_approval",
      "GET exposes pending request status"
    );

    assertEqual(
      result.body?.policy?.request_review_status,
      "pending_review",
      "GET exposes pending review status"
    );

    assertEqual(
      result.body?.policy?.approves_access,
      false,
      "GET confirms intake does not approve access"
    );

    assertEqual(
      result.body?.policy?.creates_licence,
      false,
      "GET confirms intake does not create licence"
    );
  }


  console.log(
    "\n===== INVALID EMAIL ====="
  );

  {
    const prohibitedBefore =
      captureGlobalProhibitedCounts();

    const result =
      await postIntake({
        document_id:
          DOCUMENTS.valid,

        requester_email:
          "not-an-email",
      });

    assertJsonResponse(
      result,
      "invalid email"
    );

    assertEqual(
      result.status,
      400,
      "invalid email rejected"
    );

    assertEqual(
      result.body?.error,
      "access_request_email_invalid",
      "invalid email returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.valid,
      "invalid email creates no request"
    );

    assertNoIntakeEventCreated(
      DOCUMENTS.valid,
      "invalid email creates no intake event"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "invalid email"
    );
  }


  console.log(
    "\n===== DOCUMENT NOT FOUND ====="
  );

  {
    const missingId =
      `${RUN_ID}_missing_document`;

    const prohibitedBefore =
      captureGlobalProhibitedCounts();

    const result =
      await postIntake(
        baseIntakeBody(
          missingId,
          `${RUN_ID}.missing@example.com`
        )
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
      "access_request_document_not_found",
      "missing document returns canonical error"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "missing document"
    );
  }


  console.log(
    "\n===== INACTIVE DOCUMENT ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.inactive,
          `${RUN_ID}.inactive@example.com`
        )
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
      "access_request_document_not_active",
      "inactive document returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.inactive,
      "inactive document creates no request"
    );
  }


  console.log(
    "\n===== UNLISTED DOCUMENT ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.unlisted,
          `${RUN_ID}.unlisted@example.com`
        )
      );

    assertJsonResponse(
      result,
      "unlisted document"
    );

    assertEqual(
      result.status,
      409,
      "unlisted document rejected"
    );

    assertEqual(
      result.body?.error,
      "access_request_document_not_listed",
      "unlisted document returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.unlisted,
      "unlisted document creates no request"
    );
  }


  console.log(
    "\n===== NON-REQUESTABLE DOCUMENT ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.notRequestable,
          `${RUN_ID}.notrequestable@example.com`
        )
      );

    assertJsonResponse(
      result,
      "non-requestable document"
    );

    assertEqual(
      result.status,
      409,
      "non-requestable document rejected"
    );

    assertEqual(
      result.body?.error,
      "access_request_document_not_requestable",
      "non-requestable document returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.notRequestable,
      "non-requestable document creates no request"
    );
  }


  console.log(
    "\n===== APPROVAL MUST REMAIN ENABLED ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.noApproval,
          `${RUN_ID}.noapproval@example.com`
        )
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
      "access_request_document_does_not_require_approval",
      "approval-disabled document returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.noApproval,
      "approval-disabled document creates no request"
    );
  }


  console.log(
    "\n===== SOURCE OBJECT REQUIRED ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.noSource,
          `${RUN_ID}.nosource@example.com`
        )
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
      "access_request_source_object_missing",
      "missing source object returns canonical error"
    );
  }


  console.log(
    "\n===== SOURCE SHA REQUIRED ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.noSha,
          `${RUN_ID}.nosha@example.com`
        )
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
      "access_request_source_sha256_missing",
      "missing source SHA returns canonical error"
    );
  }


  console.log(
    "\n===== LICENCE TERMS REQUIRED ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.noTerms,
          `${RUN_ID}.noterms@example.com`
        )
      );

    assertJsonResponse(
      result,
      "terms missing"
    );

    assertEqual(
      result.status,
      409,
      "missing licence terms rejected"
    );

    assertEqual(
      result.body?.error,
      "access_request_terms_version_missing",
      "missing licence terms returns canonical error"
    );
  }


  console.log(
    "\n===== LISTING EVENT REQUIRED ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.noListingEvent,
          `${RUN_ID}.nolisting@example.com`
        )
      );

    assertJsonResponse(
      result,
      "listing event missing"
    );

    assertEqual(
      result.status,
      409,
      "missing listing event rejected"
    );

    assertEqual(
      result.body?.error,
      "access_request_listing_requestability_event_missing",
      "missing listing event returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.noListingEvent,
      "missing listing event creates no request"
    );
  }


  console.log(
    "\n===== INELIGIBLE LISTING EVENT ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.badListingEvent,
          `${RUN_ID}.badlisting@example.com`
        )
      );

    assertJsonResponse(
      result,
      "ineligible listing event"
    );

    assertEqual(
      result.status,
      409,
      "ineligible listing event rejected"
    );

    assertEqual(
      result.body?.error,
      "access_request_latest_event_not_requestable",
      "ineligible listing event returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.badListingEvent,
      "ineligible listing event creates no request"
    );
  }


  console.log(
    "\n===== IMPURE LISTING EVENT ====="
  );

  {
    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.impureListingEvent,
          `${RUN_ID}.impure@example.com`
        )
      );

    assertJsonResponse(
      result,
      "impure listing event"
    );

    assertEqual(
      result.status,
      409,
      "impure listing event rejected"
    );

    assertEqual(
      result.body?.error,
      "access_request_listing_requestability_event_impure",
      "impure listing event returns canonical error"
    );

    assertNoRequestCreated(
      DOCUMENTS.impureListingEvent,
      "impure listing event creates no request"
    );
  }


  console.log(
    "\n===== SUCCESSFUL CONTROLLED INTAKE ====="
  );

  let createdRequestId;
  let createdIntakeEventId;

  {
    const prohibitedBefore =
      captureGlobalProhibitedCounts();

    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.valid,
          EMAILS.successInput
        )
      );

    assertJsonResponse(
      result,
      "successful intake"
    );

    assertEqual(
      result.status,
      201,
      "successful intake returns 201"
    );

    assertEqual(
      result.body?.ok,
      true,
      "successful intake response ok"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "successful intake accepted"
    );

    assertEqual(
      result.body?.validation_stage,
      "cdas_controlled_access_request_intake",
      "successful intake reports U3-P validation stage"
    );

    assertEqual(
      result.body?.requester?.email,
      EMAILS.successCanonical,
      "response normalises requester email"
    );

    assertEqual(
      result.body?.document_access_request
        ?.document_access_request
        ?.status,
      "pending_approval",
      "response request state is pending_approval"
    );

    assertEqual(
      result.body?.intake_event
        ?.request_review_status,
      "pending_review",
      "response intake event remains pending_review"
    );

    assertEqual(
      result.body?.prohibited_side_effects
        ?.access_approved,
      false,
      "response confirms access not approved"
    );

    assertEqual(
      result.body?.prohibited_side_effects
        ?.licence_created,
      false,
      "response confirms no licence created"
    );

    const requests =
      documentAccessRequestsForDocument(
        DOCUMENTS.valid
      );

    assertEqual(
      requests.length,
      1,
      "successful intake creates exactly one document_access_requests row"
    );

    const requestRow =
      requests[0];

    createdRequestId =
      requestRow.id;

    assertTrue(
      createdRequestId?.startsWith(
        "dar_"
      ),
      "created access request uses controlled request ID"
    );

    assertEqual(
      requestRow.document_id,
      DOCUMENTS.valid,
      "access request bound to correct document"
    );

    assertEqual(
      requestRow.status,
      "pending_approval",
      "persisted request status is pending_approval"
    );

    assertEqual(
      requestRow.request_review_status,
      "pending_review",
      "persisted request review status is pending_review"
    );

    assertEqual(
      requestRow.intake_source,
      "controlled_upload_requestability",
      "persisted intake source is canonical"
    );

    assertEqual(
      requestRow.requestability_status_at_intake,
      "requestable_with_approval",
      "persisted requestability snapshot is canonical"
    );

    assertEqual(
      requestRow.email,
      EMAILS.successCanonical,
      "persisted email normalised"
    );

    assertEqual(
      requestRow.email_normalised,
      EMAILS.successCanonical,
      "persisted email_normalised canonical"
    );

    assertEqual(
      requestRow.licence_holder_type,
      "organisation",
      "licence holder type preserved"
    );

    assertEqual(
      requestRow.recipient_category,
      "validation_tester",
      "recipient category normalised"
    );

    assertEqual(
      requestRow.approved_at,
      null,
      "intake does not approve request"
    );

    assertEqual(
      requestRow.denied_at,
      null,
      "intake does not deny request"
    );

    assertTrue(
      Boolean(
        requestRow.intake_event_id
      ),
      "request binds to intake event ID"
    );

    createdIntakeEventId =
      requestRow.intake_event_id;

    const intakeEvents =
      intakeEventsForDocument(
        DOCUMENTS.valid
      );

    assertEqual(
      intakeEvents.length,
      1,
      "successful intake creates exactly one intake evidence row"
    );

    const event =
      intakeEvents[0];

    assertEqual(
      event.id,
      createdIntakeEventId,
      "request intake_event_id matches evidence row"
    );

    assertEqual(
      event.access_request_id,
      createdRequestId,
      "intake event references created request"
    );

    assertEqual(
      event.document_id,
      DOCUMENTS.valid,
      "intake event references document"
    );

    assertEqual(
      event.listing_requestability_event_id,
      LISTING_EVENTS.valid,
      "intake event references qualifying U3-O event"
    );

    assertEqual(
      event.requester_email,
      EMAILS.successCanonical,
      "intake event stores normalised requester email"
    );

    assertEqual(
      event.intake_status,
      "received",
      "intake event status is received"
    );

    assertEqual(
      event.request_status,
      "pending_approval",
      "intake event records pending request state"
    );

    assertEqual(
      event.request_review_status,
      "pending_review",
      "intake event records pending review state"
    );

    assertEqual(
      Number(
        event.licence_created
      ),
      0,
      "intake evidence records no licence"
    );

    assertEqual(
      Number(
        event.generated_pdf_created
      ),
      0,
      "intake evidence records no generated PDF"
    );

    assertEqual(
      Number(
        event.download_link_created
      ),
      0,
      "intake evidence records no download link"
    );

    assertEqual(
      Number(
        event.email_sent
      ),
      0,
      "intake evidence records no email"
    );

    assertEqual(
      Number(
        event.access_approved
      ),
      0,
      "intake evidence records no approval"
    );

    assertEqual(
      Number(
        event.direct_download_created
      ),
      0,
      "intake evidence records no direct download"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "successful intake"
    );
  }


  console.log(
    "\n===== DUPLICATE PENDING REQUEST PROTECTION ====="
  );

  {
    const beforeRequestCount =
      documentAccessRequestsForDocument(
        DOCUMENTS.valid
      ).length;

    const beforeEvents =
      intakeEventsForDocument(
        DOCUMENTS.valid
      );

    const prohibitedBefore =
      captureGlobalProhibitedCounts();

    const result =
      await postIntake(
        baseIntakeBody(
          DOCUMENTS.valid,
          EMAILS.duplicateInput
        )
      );

    assertJsonResponse(
      result,
      "duplicate intake"
    );

    assertEqual(
      result.status,
      200,
      "duplicate pending request returns controlled 200"
    );

    assertEqual(
      result.body?.ok,
      true,
      "duplicate response ok"
    );

    assertEqual(
      result.body?.accepted,
      false,
      "duplicate intake not accepted as new request"
    );

    assertEqual(
      result.body?.duplicate_blocked,
      true,
      "duplicate intake explicitly blocked"
    );

    assertEqual(
      result.body?.duplicate_event_recorded,
      true,
      "duplicate intake records duplicate evidence"
    );

    const requestsAfter =
      documentAccessRequestsForDocument(
        DOCUMENTS.valid
      );

    assertEqual(
      requestsAfter.length,
      beforeRequestCount,
      "duplicate intake creates no second access request"
    );

    const eventsAfter =
      intakeEventsForDocument(
        DOCUMENTS.valid
      );

    assertEqual(
      eventsAfter.length,
      beforeEvents.length + 1,
      "duplicate intake creates one evidence event"
    );

    const duplicateEvent =
      eventsAfter.at(-1);

    assertEqual(
      duplicateEvent.access_request_id,
      createdRequestId,
      "duplicate event references existing request"
    );

    assertEqual(
      duplicateEvent.intake_status,
      "duplicate_blocked",
      "duplicate evidence records duplicate_blocked"
    );

    assertEqual(
      duplicateEvent.requester_email,
      EMAILS.successCanonical,
      "duplicate comparison uses normalised email"
    );

    assertEqual(
      Number(
        duplicateEvent.access_approved
      ),
      0,
      "duplicate event records no approval"
    );

    assertEqual(
      Number(
        duplicateEvent.licence_created
      ),
      0,
      "duplicate event records no licence"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "duplicate intake"
    );
  }


  console.log(
    "\n===== FINAL PROHIBITED SIDE-EFFECT ASSERTIONS ====="
  );

  assertEqual(
    reviewEventsForRun().length,
    0,
    "U3-P created no access request review events"
  );

  assertEqual(
    countWhere(
      "document_licences",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-P created no document licence"
  );

  assertEqual(
    countWhere(
      "document_download_links",
      `document_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-P created no document download link"
  );

  assertEqual(
    countWhere(
      "document_access_request_licence_issue_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-P created no licence issue event"
  );


  console.log();
  console.log(
    "============================================"
  );

  console.log(
    "PASS — U3-P REAL BEHAVIOURAL VALIDATION"
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
    "PASS — requester validation"
  );

  console.log(
    "PASS — document eligibility fail-closed"
  );

  console.log(
    "PASS — U3-O evidence requirement"
  );

  console.log(
    "PASS — impure U3-O evidence rejected"
  );

  console.log(
    "PASS — controlled request created"
  );

  console.log(
    "PASS — pending_approval boundary"
  );

  console.log(
    "PASS — pending_review boundary"
  );

  console.log(
    "PASS — intake evidence persisted"
  );

  console.log(
    "PASS — email normalisation"
  );

  console.log(
    "PASS — duplicate request protection"
  );

  console.log(
    "PASS — duplicate evidence recorded"
  );

  console.log(
    "PASS — no review performed"
  );

  console.log(
    "PASS — no approval performed"
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
    "PASS — U3-Q remains the next allowed gate"
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
    "FAIL — U3-P REAL BEHAVIOURAL VALIDATION"
  );

  console.error(
    "============================================"
  );

  console.error(error);

  process.exitCode = 1;
} finally {
  cleanup();
}