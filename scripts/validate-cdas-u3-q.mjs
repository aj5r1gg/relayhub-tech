#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const BASE_URL =
  process.env.CDAS_VALIDATION_BASE_URL || "http://127.0.0.1:8787";

const ADMIN_TOKEN =
  process.env.CDAS_VALIDATION_ADMIN_TOKEN || "u3q-local-validation-token";

const DB_NAME =
  process.env.CDAS_VALIDATION_DB || "relayhub_early_access";

const RUN_ID =
  `u3q_${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const DOCUMENT_ID = `${RUN_ID}_document`;
const DOCUMENT_SLUG = `${RUN_ID}-document`;

const REQUEST_IDS = {
  disabled: `${RUN_ID}_disabled`,
  invalid: `${RUN_ID}_invalid`,
  hold: `${RUN_ID}_hold`,
  reject: `${RUN_ID}_reject`,
  approve: `${RUN_ID}_approve`,
  ineligible: `${RUN_ID}_ineligible`,
};

const REQUEST_URL =
  `${BASE_URL}/api/admin/uploads/cdas-document/access-request/review`;


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
      stdio: ["ignore", "pipe", "pipe"],
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

    if (Array.isArray(item?.result?.results)) {
      return item.result.results;
    }
  }

  return [];
}


function query(sql) {
  return extractRows(d1(sql));
}


function first(sql) {
  return query(sql)[0] || null;
}


function scalar(sql, key = "value") {
  const row = first(sql);

  if (!row) {
    throw new Error(`Expected scalar query result:\n${sql}`);
  }

  return row[key];
}


function execute(sql) {
  d1(sql);
}


function assertEqual(actual, expected, message) {
  assert.equal(actual, expected, message);
  console.log(`PASS — ${message}`);
}


function assertTrue(value, message) {
  assert.ok(value, message);
  console.log(`PASS — ${message}`);
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


async function postReview(
  requestId,
  action,
  {
    token = ADMIN_TOKEN,
    extraHeaders = {},
    reason = "U3-Q automated validation",
    note = `validation run ${RUN_ID}`,
  } = {}
) {
  const response = await fetch(REQUEST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connection": "close",
      "x-admin-actor": "u3-q-validator",
      ...extraHeaders,
    },
    body: JSON.stringify({
      request_id: requestId,
      action,
      reason,
      note,
    }),
  });

  const raw = await response.text();
  const body = parseResponseBody(raw);

  return {
    status: response.status,
    body,
    raw,
  };
}


async function getReview({
  token = ADMIN_TOKEN,
} = {}) {
  const response = await fetch(REQUEST_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Connection": "close",
    },
  });

  const raw = await response.text();
  const body = parseResponseBody(raw);

  return {
    status: response.status,
    body,
    raw,
  };
}


async function getUnauthenticatedReview() {
  const response = await fetch(REQUEST_URL, {
    headers: {
      "Connection": "close",
    },
  });

  const raw = await response.text();
  const body = parseResponseBody(raw);

  return {
    status: response.status,
    body,
    raw,
  };
}


function assertJsonResponse(result, label) {
  assert.ok(
    !result.body?.parse_error,
    `${label}: response body was not valid JSON: ${result.raw}`
  );

  console.log(
    `PASS — ${label}: response body is valid JSON`
  );
}


function insertFixtureRequest(id) {
  const email = `${id}@validation.invalid`;

  execute(`
    INSERT INTO document_access_requests (
      id,
      document_id,
      document_version,
      name,
      email,
      email_normalised,
      licence_holder_type,
      recipient_category,
      status,
      access_class,
      requested_at,
      terms_version,
      risk_score,
      intake_source,
      request_review_status,
      requestability_status_at_intake
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(DOCUMENT_ID)},
      'v-test',
      'U3-Q Validator',
      ${sqlQuote(email)},
      ${sqlQuote(email)},
      'individual',
      'validation',
      'pending_approval',
      'controlled_verified',
      '2026-08-14T00:00:00.000Z',
      'validation-terms-v1',
      0,
      'u3_q_validation',
      'pending_review',
      'requestable_with_approval'
    );
  `);
}


function requestRow(id) {
  return first(`
    SELECT
      id,
      status,
      request_review_status,
      approved_at,
      approved_by,
      approval_role,
      approval_policy_version,
      approval_note,
      denied_at,
      denied_by,
      denial_reason
    FROM document_access_requests
    WHERE id = ${sqlQuote(id)}
    LIMIT 1;
  `);
}


function reviewEvents(id) {
  return query(`
    SELECT
      id,
      request_id,
      event_type,
      previous_status,
      new_status,
      actor,
      reason,
      note,
      metadata_json,
      created_at
    FROM document_access_request_review_events
    WHERE request_id = ${sqlQuote(id)}
    ORDER BY created_at, id;
  `);
}


function countWhere(table, where = "1 = 1") {
  return Number(
    scalar(
      `SELECT COUNT(*) AS value FROM ${table} WHERE ${where};`
    )
  );
}


function captureProhibitedCounts() {
  return {
    licences: countWhere("document_licences"),
    download_links: countWhere("document_download_links"),
    emails: countWhere("cdas_email_events"),
    licence_issue_events: countWhere(
      "document_access_request_licence_issue_events"
    ),
  };
}


function assertProhibitedCountsUnchanged(before, label) {
  const after = captureProhibitedCounts();

  assert.deepEqual(
    after,
    before,
    `${label}: prohibited side-effect tables changed`
  );

  console.log(
    `PASS — ${label}: no licence/download-link/email/licence-issue side effects`
  );
}


function cleanup() {
  console.log("\n[U3-Q] Cleaning validation fixtures.");

  try {
    execute(`
      DELETE FROM document_access_request_review_events
      WHERE request_id LIKE ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM document_access_requests
      WHERE id LIKE ${sqlQuote(`${RUN_ID}%`)};

      DELETE FROM documents
      WHERE id = ${sqlQuote(DOCUMENT_ID)};
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
    "===== U3-Q REAL BEHAVIOURAL VALIDATION ====="
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
    "document_access_requests",
    "document_access_request_review_events",
    "document_licences",
    "document_download_links",
    "cdas_email_events",
    "document_access_request_licence_issue_events",
  ];

  for (const table of requiredTables) {
    const row = first(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ${sqlQuote(table)}
      LIMIT 1;
    `);

    assertEqual(
      row?.name,
      table,
      `required table exists: ${table}`
    );
  }


  const requiredRequestColumns = [
    "intake_source",
    "request_review_status",
    "requestability_status_at_intake",
    "intake_event_id",
  ];

  const requestColumns = new Set(
    query(
      "PRAGMA table_info(document_access_requests);"
    ).map((row) => row.name)
  );

  for (const column of requiredRequestColumns) {
    assertTrue(
      requestColumns.has(column),
      `document_access_requests.${column} exists`
    );
  }


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
      ${sqlQuote(DOCUMENT_ID)},
      ${sqlQuote(DOCUMENT_SLUG)},
      'U3-Q Validation Document',
      'Disposable U3-Q validation fixture',
      'Disposable U3-Q validation fixture',
      'v-test',
      'active',
      'controlled',
      'controlled_verified',
      ${sqlQuote(`validation/${RUN_ID}/source.odt`)},
      ${sqlQuote("a".repeat(64))},
      ${sqlQuote(`validation/${RUN_ID}/generated/`)},
      'validation-terms-v1',
      1,
      0,
      1,
      '2026-08-14T00:00:00.000Z',
      '2026-08-14T00:00:00.000Z',
      'requestable_with_approval',
      '2026-08-14T00:00:00.000Z',
      '2026-08-14T00:00:00.000Z'
    );
  `);


  for (const id of Object.values(REQUEST_IDS)) {
    insertFixtureRequest(id);
  }


  console.log(
    "\n===== AUTHENTICATION ====="
  );

  {
    const result =
      await getUnauthenticatedReview();

    assertJsonResponse(
      result,
      "unauthenticated request"
    );

    assertEqual(
      result.status,
      401,
      "unauthenticated U3-Q request rejected"
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
      await getReview();

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
      result.body.route,
      "/api/admin/uploads/cdas-document/access-request/review",
      "GET exposes correct U3-Q route"
    );

    assertTrue(
      Array.isArray(
        result.body.allowed_actions
      ),
      "GET exposes allowed action vocabulary"
    );

    assert.deepEqual(
      result.body.allowed_actions,
      [
        "hold",
        "reject",
        "approve_for_licence_prep",
      ]
    );

    console.log(
      "PASS — GET exposes canonical U3-Q actions"
    );
  }


  console.log(
    "\n===== INVALID ACTION ====="
  );

  {
    const before =
      requestRow(
        REQUEST_IDS.invalid
      );

    const eventsBefore =
      reviewEvents(
        REQUEST_IDS.invalid
      ).length;

    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postReview(
        REQUEST_IDS.invalid,
        "definitely_not_valid"
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
      result.body.error,
      "access_request_review_action_invalid",
      "invalid action returns canonical error"
    );

    assert.deepEqual(
      requestRow(
        REQUEST_IDS.invalid
      ),
      before,
      "invalid action did not mutate request"
    );

    console.log(
      "PASS — invalid action did not mutate request"
    );

    assertEqual(
      reviewEvents(
        REQUEST_IDS.invalid
      ).length,
      eventsBefore,
      "invalid action created no review event"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "invalid action"
    );
  }


  console.log(
    "\n===== HOLD ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postReview(
        REQUEST_IDS.hold,
        "hold"
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
      result.body.ok,
      true,
      "hold response ok"
    );

    assertEqual(
      result.body.action,
      "hold",
      "hold action preserved"
    );

    const row =
      requestRow(
        REQUEST_IDS.hold
      );

    assertEqual(
      row.status,
      "pending_approval",
      "hold keeps pending_approval"
    );

    assertEqual(
      row.request_review_status,
      "review_hold",
      "hold changes review status to review_hold"
    );

    const events =
      reviewEvents(
        REQUEST_IDS.hold
      );

    assertEqual(
      events.length,
      1,
      "hold creates exactly one review event"
    );

    assertEqual(
      events[0].event_type,
      "held",
      "hold event type recorded"
    );

    assertEqual(
      events[0].new_status,
      "pending_approval",
      "hold event records resulting status"
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

    const result =
      await postReview(
        REQUEST_IDS.reject,
        "reject",
        {
          reason:
            "Automated rejection validation",
          note:
            "U3-Q reject test",
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

    const row =
      requestRow(
        REQUEST_IDS.reject
      );

    assertEqual(
      row.status,
      "denied",
      "reject changes status to denied"
    );

    assertEqual(
      row.request_review_status,
      "rejected",
      "reject changes review status to rejected"
    );

    assertTrue(
      Boolean(
        row.denied_at
      ),
      "reject records denied_at"
    );

    assertTrue(
      Boolean(row.denied_by),
      "reject records admin actor"
    );

    const events =
      reviewEvents(
        REQUEST_IDS.reject
      );

    assertEqual(
      events.length,
      1,
      "reject creates exactly one review event"
    );

    assertEqual(
      events[0].event_type,
      "rejected",
      "reject event type recorded"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "reject"
    );
  }


  console.log(
    "\n===== APPROVE FOR LICENCE PREP ====="
  );

  {
    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postReview(
        REQUEST_IDS.approve,
        "approve_for_licence_prep",
        {
          note:
            "U3-Q approval validation",
        }
      );

    assertJsonResponse(
      result,
      "approve_for_licence_prep"
    );

    assertEqual(
      result.status,
      200,
      "approve_for_licence_prep accepted"
    );

    const row =
      requestRow(
        REQUEST_IDS.approve
      );

    assertEqual(
      row.status,
      "approved_pending_licence",
      "approval stops at approved_pending_licence"
    );

    assertEqual(
      row.request_review_status,
      "approved_for_licence_prep",
      "approval stops at approved_for_licence_prep review state"
    );

    assertTrue(
      Boolean(
        row.approved_at
      ),
      "approval records approved_at"
    );

    assertTrue(
      Boolean(row.approved_by),
      "approval records admin actor"
    );

    assertEqual(
      row.approval_role,
      "cdas_upload_gate",
      "approval role recorded"
    );

    assertEqual(
      row.approval_policy_version,
      "U3-Q",
      "approval policy version recorded"
    );

    const events =
      reviewEvents(
        REQUEST_IDS.approve
      );

    assertEqual(
      events.length,
      1,
      "approval creates exactly one review event"
    );

    assertEqual(
      events[0].event_type,
      "review_approved",
      "approval event type recorded"
    );

    assertEqual(
      events[0].new_status,
      "approved_pending_licence",
      "approval event records boundary state"
    );

    const metadata =
      JSON.parse(
        events[0].metadata_json
      );

    assertEqual(
      metadata.gate,
      "U3-Q",
      "event metadata identifies U3-Q"
    );

    assertEqual(
      metadata.licence_created,
      false,
      "event evidence says no licence created"
    );

    assertEqual(
      metadata.generated_pdf_created,
      false,
      "event evidence says no generated PDF created"
    );

    assertEqual(
      metadata.download_link_created,
      false,
      "event evidence says no download link created"
    );

    assertEqual(
      metadata.email_sent,
      false,
      "event evidence says no email sent"
    );

    assertEqual(
      metadata.direct_download_created,
      false,
      "event evidence says no direct download created"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "approve_for_licence_prep"
    );
  }


  console.log(
    "\n===== APPROVAL ELIGIBILITY FAIL-CLOSED ====="
  );

  {
    execute(`
      UPDATE documents
      SET requestability_status = 'not_requestable'
      WHERE id = ${sqlQuote(DOCUMENT_ID)};
    `);

    const before =
      requestRow(
        REQUEST_IDS.ineligible
      );

    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postReview(
        REQUEST_IDS.ineligible,
        "approve_for_licence_prep"
      );

    assertJsonResponse(
      result,
      "failed approval eligibility"
    );

    assertEqual(
      result.status,
      409,
      "approval rejected when document no longer requestable"
    );

    assertEqual(
      result.body.error,
      "access_request_review_document_not_requestable",
      "approval eligibility returns canonical failure"
    );

    assert.deepEqual(
      requestRow(
        REQUEST_IDS.ineligible
      ),
      before,
      "failed eligibility check does not mutate request"
    );

    console.log(
      "PASS — failed approval eligibility leaves request unchanged"
    );

    assertEqual(
      reviewEvents(
        REQUEST_IDS.ineligible
      ).length,
      0,
      "failed eligibility creates no review event"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "failed approval eligibility"
    );

    execute(`
      UPDATE documents
      SET requestability_status = 'requestable_with_approval'
      WHERE id = ${sqlQuote(DOCUMENT_ID)};
    `);
  }


  console.log(
    "\n===== FINALISED REQUEST CANNOT BE RE-REVIEWED ====="
  );

  {
    const eventsBefore =
      reviewEvents(
        REQUEST_IDS.approve
      ).length;

    const prohibitedBefore =
      captureProhibitedCounts();

    const result =
      await postReview(
        REQUEST_IDS.approve,
        "approve_for_licence_prep"
      );

    assertJsonResponse(
      result,
      "repeat approval"
    );

    assertEqual(
      result.status,
      409,
      "finalised approval cannot be reviewed again"
    );

    assertEqual(
      result.body.error,
      "access_request_review_already_finalised",
      "repeat approval rejected at finalisation boundary"
    );

    assertEqual(
      reviewEvents(
        REQUEST_IDS.approve
      ).length,
      eventsBefore,
      "repeat approval creates no second event"
    );

    assertProhibitedCountsUnchanged(
      prohibitedBefore,
      "repeat approval"
    );
  }


  console.log(
    "\n===== FINAL PROHIBITED SIDE-EFFECT ASSERTIONS ====="
  );

  assertEqual(
    countWhere(
      "document_licences",
      `document_id = ${sqlQuote(DOCUMENT_ID)}`
    ),
    0,
    "U3-Q created no document licence"
  );

  assertEqual(
    countWhere(
      "document_download_links",
      `document_id = ${sqlQuote(DOCUMENT_ID)}`
    ),
    0,
    "U3-Q created no document download link"
  );

  assertEqual(
    countWhere(
      "document_access_request_licence_issue_events",
      `request_id LIKE ${sqlQuote(`${RUN_ID}%`)}`
    ),
    0,
    "U3-Q created no licence issue event"
  );


  console.log();
  console.log(
    "============================================"
  );

  console.log(
    "PASS — U3-Q REAL BEHAVIOURAL VALIDATION"
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
    "PASS — hold behaviour"
  );

  console.log(
    "PASS — reject behaviour"
  );

  console.log(
    "PASS — approval-for-licence-prep boundary"
  );

  console.log(
    "PASS — approval eligibility fails closed"
  );

  console.log(
    "PASS — finalised requests cannot be re-reviewed"
  );

  console.log(
    "PASS — review evidence persisted"
  );

  console.log(
    "PASS — prohibited side effects absent"
  );

  console.log(
    "PASS — no licence issuance performed"
  );

  console.log(
    "PASS — U3-R remains outside this validation"
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
    "FAIL — U3-Q REAL BEHAVIOURAL VALIDATION"
  );

  console.error(
    "============================================"
  );

  console.error(error);

  process.exitCode = 1;
} finally {
  cleanup();
}