#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const BASE_URL =
  process.env.CDAS_VALIDATION_BASE_URL ||
  "http://127.0.0.1:8787";

const ADMIN_TOKEN =
  process.env.CDAS_VALIDATION_ADMIN_TOKEN ||
  "u3q-local-validation-token";

const DB_NAME =
  process.env.CDAS_VALIDATION_DB ||
  "relayhub_early_access";

const R2_BUCKET =
  process.env.CDAS_VALIDATION_R2_BUCKET ||
  "relayhub-downloads";

const RUN_ID =
  `u3k_${Date.now()}_${crypto.randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const SLUG =
  `${RUN_ID}-document`;

const TITLE =
  "U3-K Contract Validation Document";

const VERSION =
  "v-test";

const LICENCE_TERMS_VERSION =
  "validation-terms-v1";

const CLIENT_REQUEST_ID =
  `${RUN_ID}_client_request`;

const REQUEST_URL =
  `${BASE_URL}/api/admin/uploads/cdas-document`;

const TMP_DIR =
  mkdtempSync(
    join(
      tmpdir(),
      "relayhub-u3k-contract-"
    )
  );


/* -------------------------------------------------------------------------- */
/* Deterministic PDF fixture                                                  */
/* -------------------------------------------------------------------------- */

const PDF_TEXT = `%PDF-1.4
% U3-K contract validator ${RUN_ID}
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT
/F1 12 Tf
20 100 Td
(U3-K validation) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f
trailer
<< /Root 1 0 R /Size 5 >>
startxref
0
%%EOF
`;

const PDF_BYTES =
  Buffer.from(
    PDF_TEXT,
    "utf8"
  );

const EXPECTED_SHA256 =
  crypto
    .createHash("sha256")
    .update(PDF_BYTES)
    .digest("hex");


/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

function section(title) {
  console.log();
  console.log(
    `===== ${title} =====`
  );
}


function pass(message) {
  console.log(
    `PASS — ${message}`
  );
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

  pass(message);
}


function assertTrue(
  value,
  message
) {
  assert.ok(
    value,
    message
  );

  pass(message);
}


function assertJson(
  result,
  label
) {
  assert.ok(
    !result.body?.parse_error,
    `${label}: response was not valid JSON`
  );

  pass(
    `${label}: response body is valid JSON`
  );
}


/* -------------------------------------------------------------------------- */
/* SQL helpers                                                                */
/* -------------------------------------------------------------------------- */

function sqlQuote(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "NULL";
  }

  return `'${String(value)
    .replaceAll("'", "''")}'`;
}


function d1(sql) {
  const output =
    execFileSync(
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


function rows(result) {
  if (!Array.isArray(result)) {
    return [];
  }

  for (const item of result) {
    if (
      Array.isArray(
        item?.results
      )
    ) {
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
  return rows(
    d1(sql)
  );
}


function execute(sql) {
  d1(sql);
}


function first(sql) {
  return (
    query(sql)[0] ||
    null
  );
}


function scalar(sql) {
  const row =
    first(sql);

  if (!row) {
    throw new Error(
      `Expected scalar result:\n${sql}`
    );
  }

  return Number(
    row.value
  );
}


function countWhere(
  table,
  where =
    "1 = 1"
) {
  return scalar(`
    SELECT COUNT(*) AS value
    FROM ${table}
    WHERE ${where};
  `);
}


function tableExists(table) {
  return Boolean(
    first(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ${sqlQuote(table)}
      LIMIT 1;
    `)
  );
}


/* -------------------------------------------------------------------------- */
/* Persistence readers                                                        */
/* -------------------------------------------------------------------------- */

function activeStoragePrefix() {
  return first(`
    SELECT
      id,
      domain,
      prefix,
      status
    FROM storage_prefixes
    WHERE domain = 'cdas_document'
      AND status = 'active'
    ORDER BY id
    LIMIT 1;
  `);
}


function documentBySlug() {
  return first(`
    SELECT
      id,
      slug,
      version,
      status,
      classification,
      access_class,
      source_object,
      source_sha256,
      generated_prefix,
      licence_terms_version,
      is_listed,
      requires_approval,
      requestability_status,
      listed_at,
      requestable_at
    FROM documents
    WHERE slug = ${sqlQuote(SLUG)}
    LIMIT 1;
  `);
}


function transactionsForRun() {
  return query(`
    SELECT *
    FROM upload_transactions
    WHERE related_record_id =
      ${sqlQuote(SLUG)}
    ORDER BY started_at, id;
  `);
}


function idempotencyForTransaction(
  transactionId
) {
  return query(`
    SELECT *
    FROM upload_idempotency_keys
    WHERE upload_transaction_id =
      ${sqlQuote(transactionId)}
    ORDER BY created_at, id;
  `);
}


/* -------------------------------------------------------------------------- */
/* Downstream boundary                                                        */
/* -------------------------------------------------------------------------- */

const DOWNSTREAM_TABLES = [
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


function downstreamCounts() {
  const result = {};

  for (
    const table
    of DOWNSTREAM_TABLES
  ) {
    result[table] =
      countWhere(table);
  }

  return result;
}


function assertDownstreamUnchanged(
  before,
  label
) {
  const after =
    downstreamCounts();

  assert.deepEqual(
    after,
    before,
    `${label}: downstream persistence changed`
  );

  pass(
    `${label}: no downstream gate side effects`
  );
}


/* -------------------------------------------------------------------------- */
/* Core count helpers                                                         */
/* -------------------------------------------------------------------------- */

function coreCounts() {
  return {
    transactions:
      countWhere(
        "upload_transactions"
      ),

    idempotency:
      countWhere(
        "upload_idempotency_keys"
      ),

    documents:
      countWhere(
        "documents"
      ),
  };
}


/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

function formData({
  storagePrefixId,
  clientRequestId =
    CLIENT_REQUEST_ID,
  includeClientRequestId =
    true,
} = {}) {
  const form =
    new FormData();

  form.append(
    "slug",
    SLUG
  );

  form.append(
    "title",
    TITLE
  );

  form.append(
    "summary",
    "Disposable U3-K contract fixture"
  );

  form.append(
    "description",
    "Disposable U3-K contract fixture"
  );

  form.append(
    "version",
    VERSION
  );

  form.append(
    "classification",
    "controlled"
  );

  form.append(
    "access_class",
    "controlled_verified"
  );

  form.append(
    "licence_terms_version",
    LICENCE_TERMS_VERSION
  );

  form.append(
    "storage_prefix_id",
    storagePrefixId
  );

  if (
    includeClientRequestId
  ) {
    form.append(
      "client_request_id",
      clientRequestId
    );
  }

  form.append(
    "file",
    new File(
      [PDF_BYTES],
      `${RUN_ID}.pdf`,
      {
        type:
          "application/pdf",
      }
    )
  );

  return form;
}


async function request({
  method =
    "GET",
  mode =
    null,
  token =
    ADMIN_TOKEN,
  form =
    undefined,
  body =
    undefined,
  headers =
    {},
} = {}) {
  const url =
    new URL(
      REQUEST_URL
    );

  if (mode) {
    url.searchParams.set(
      "mode",
      mode
    );
  }

  const requestHeaders = {
    Connection:
      "close",

    ...headers,
  };

  if (token) {
    requestHeaders.Authorization =
      `Bearer ${token}`;
  }

  const response =
    await fetch(
      url,
      {
        method,
        headers:
          requestHeaders,

        body:
          form !== undefined
            ? form
            : body,
      }
    );

  const raw =
    await response.text();

  let parsed;

  try {
    parsed =
      JSON.parse(raw);
  } catch {
    parsed = {
      parse_error:
        true,

      raw,
    };
  }

  return {
    status:
      response.status,

    body:
      parsed,

    raw,
  };
}


/* -------------------------------------------------------------------------- */
/* R2                                                                         */
/* -------------------------------------------------------------------------- */

function r2Get(
  key,
  target
) {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "get",
      `${R2_BUCKET}/${key}`,
      "--local",
      "--file",
      target,
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    }
  );
}


function readR2(key) {
  const target =
    join(
      TMP_DIR,
      crypto.randomUUID()
    );

  try {
    r2Get(
      key,
      target
    );

    return readFileSync(
      target
    );
  } finally {
    rmSync(
      target,
      {
        force: true,
      }
    );
  }
}


function r2Exists(key) {
  try {
    readR2(key);
    return true;
  } catch {
    return false;
  }
}


function r2Delete(key) {
  if (!key) {
    return;
  }

  try {
    execFileSync(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "delete",
        `${R2_BUCKET}/${key}`,
        "--local",
        "--force",
      ],
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    );
  } catch {
    // Best effort cleanup.
  }
}


/* -------------------------------------------------------------------------- */
/* Cleanup                                                                    */
/* -------------------------------------------------------------------------- */

let cleanupTransactionId =
  null;

let cleanupDocumentId =
  null;

let cleanupObjectKeys =
  [];


function cleanup() {
  console.log();
  console.log(
    "[U3-K] Cleaning validation fixtures."
  );

  for (
    const key
    of cleanupObjectKeys
  ) {
    r2Delete(key);
  }

  if (
    cleanupTransactionId
  ) {
    try {
      execute(`
        DELETE FROM upload_idempotency_keys
        WHERE upload_transaction_id =
          ${sqlQuote(cleanupTransactionId)};
      `);
    } catch {
      // Continue.
    }

    try {
      execute(`
        DELETE FROM admin_audit_events
        WHERE target_type =
          'upload_transaction'
          AND target_id =
            ${sqlQuote(cleanupTransactionId)};
      `);
    } catch {
      // Continue.
    }
  }

  if (
    cleanupDocumentId
  ) {
    try {
      execute(`
        DELETE FROM documents
        WHERE id =
          ${sqlQuote(cleanupDocumentId)};
      `);
    } catch {
      // Continue.
    }
  }

  if (
    cleanupTransactionId
  ) {
    try {
      execute(`
        DELETE FROM upload_transactions
        WHERE id =
          ${sqlQuote(cleanupTransactionId)};
      `);
    } catch {
      // Continue.
    }
  }

  /*
   * Run-specific fallback for an interrupted assertion after persistence.
   */
  try {
    const leftovers =
      transactionsForRun();

    for (
      const transaction
      of leftovers
    ) {
      try {
        execute(`
          DELETE FROM upload_idempotency_keys
          WHERE upload_transaction_id =
            ${sqlQuote(transaction.id)};
        `);
      } catch {
        // Continue.
      }

      try {
        execute(`
          DELETE FROM admin_audit_events
          WHERE target_type =
            'upload_transaction'
            AND target_id =
              ${sqlQuote(transaction.id)};
        `);
      } catch {
        // Continue.
      }

      try {
        execute(`
          DELETE FROM upload_transactions
          WHERE id =
            ${sqlQuote(transaction.id)};
        `);
      } catch {
        // Continue.
      }
    }
  } catch {
    // Continue.
  }

  try {
    execute(`
      DELETE FROM documents
      WHERE slug =
        ${sqlQuote(SLUG)};
    `);
  } catch {
    // Continue.
  }

  rmSync(
    TMP_DIR,
    {
      recursive: true,
      force: true,
    }
  );

  pass(
    "validator cleanup complete"
  );
}


/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(
    "===== U3-K CONTRACT VALIDATION ====="
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

  console.log(
    `Local R2: ${R2_BUCKET}`
  );


  /* ---------------------------------------------------------------------- */
  /* Environment                                                             */
  /* ---------------------------------------------------------------------- */

  section(
    "ENVIRONMENT"
  );

  for (
    const table
    of [
      "documents",
      "storage_prefixes",
      "upload_transactions",
      "upload_idempotency_keys",
      ...DOWNSTREAM_TABLES,
    ]
  ) {
    assertTrue(
      tableExists(table),
      `required table exists: ${table}`
    );
  }

  const prefix =
    activeStoragePrefix();

  assertTrue(
    prefix,
    "active CDAS storage prefix exists"
  );

  assertEqual(
    prefix.domain,
    "cdas_document",
    "active prefix belongs to CDAS domain"
  );


  /* ---------------------------------------------------------------------- */
  /* Authentication                                                          */
  /* ---------------------------------------------------------------------- */

  section(
    "AUTHENTICATION"
  );

  {
    const result =
      await request({
        token:
          null,
      });

    assertJson(
      result,
      "unauthenticated GET"
    );

    assertEqual(
      result.status,
      401,
      "unauthenticated request rejected"
    );

    assertEqual(
      result.body?.error,
      "admin_auth_failed",
      "canonical admin authentication error returned"
    );
  }


  /* ---------------------------------------------------------------------- */
  /* Route contract                                                          */
  /* ---------------------------------------------------------------------- */

  section(
    "ROUTE CONTRACT"
  );

  {
    const result =
      await request();

    assertJson(
      result,
      "authenticated GET"
    );

    assertEqual(
      result.status,
      200,
      "authenticated route discovery succeeds"
    );

    assertEqual(
      result.body?.route,
      "/api/admin/uploads/cdas-document",
      "correct route exposed"
    );

    assertEqual(
      result.body?.switches
        ?.uploads_enabled,
      true,
      "uploads enabled"
    );

    assertEqual(
      result.body?.switches
        ?.cdas_uploads_enabled,
      true,
      "CDAS uploads enabled"
    );

    assertEqual(
      result.body?.switches
        ?.upload_route_skeleton_enabled,
      true,
      "route skeleton enabled"
    );

    assertEqual(
      result.body?.switches
        ?.upload_route_dry_run_enabled,
      true,
      "dry-run enabled"
    );

    assertEqual(
      result.body?.switches
        ?.upload_route_real_write_enabled,
      true,
      "real-write enabled"
    );
  }


  const downstreamBefore =
    downstreamCounts();


  /* ---------------------------------------------------------------------- */
  /* Malformed input                                                         */
  /* ---------------------------------------------------------------------- */

  section(
    "MALFORMED MULTIPART FAILS CLOSED"
  );

  {
    const before =
      coreCounts();

    const result =
      await request({
        method:
          "POST",

        mode:
          "dry-run",

        body:
          JSON.stringify({
            invalid:
              true,
          }),

        headers: {
          "Content-Type":
            "application/json",
        },
      });

    assertJson(
      result,
      "malformed request"
    );

    assertEqual(
      result.status,
      400,
      "malformed multipart rejected"
    );

    assert.deepEqual(
      coreCounts(),
      before,
      "malformed request creates no core persistence"
    );

    pass(
      "malformed request creates no core persistence"
    );

    assertDownstreamUnchanged(
      downstreamBefore,
      "malformed request"
    );
  }


  /* ---------------------------------------------------------------------- */
  /* Dry-run                                                                 */
  /* ---------------------------------------------------------------------- */

  section(
    "DRY-RUN CONTRACT"
  );

  let dryRun;

  {
    const before =
      coreCounts();

    const result =
      await request({
        method:
          "POST",

        mode:
          "dry-run",

        form:
          formData({
            storagePrefixId:
              prefix.id,
          }),
      });

    assertJson(
      result,
      "dry-run"
    );

    assertEqual(
      result.status,
      200,
      "dry-run succeeds"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "dry-run accepted"
    );

    dryRun =
      result.body
        ?.dry_run_preview;

    assertTrue(
      dryRun,
      "dry-run preview returned"
    );

    assertEqual(
      dryRun
        ?.hash_evidence
        ?.source_sha256,
      EXPECTED_SHA256,
      "dry-run hash matches uploaded bytes"
    );

    assertEqual(
      Number(
        dryRun
          ?.hash_evidence
          ?.source_size
      ),
      PDF_BYTES.length,
      "dry-run byte count matches uploaded bytes"
    );

    assertEqual(
      dryRun
        ?.r2_absence_check
        ?.absence_confirmed,
      true,
      "dry-run confirms target R2 keys absent"
    );

    assertEqual(
      dryRun
        ?.draft_document_record
        ?.preflight
        ?.safe_to_create,
      true,
      "dry-run confirms document row safe to create"
    );

    assert.deepEqual(
      coreCounts(),
      before,
      "dry-run creates no transaction, idempotency record or document"
    );

    pass(
      "dry-run creates no transaction, idempotency record or document"
    );

    assertEqual(
      documentBySlug(),
      null,
      "dry-run creates no document"
    );

    assertDownstreamUnchanged(
      downstreamBefore,
      "dry-run"
    );
  }


  /* ---------------------------------------------------------------------- */
  /* Idempotency required                                                    */
  /* ---------------------------------------------------------------------- */

  section(
    "IDEMPOTENCY REQUIRED"
  );

  {
    const before =
      coreCounts();

    const result =
      await request({
        method:
          "POST",

        mode:
          "real-write",

        form:
          formData({
            storagePrefixId:
              prefix.id,

            includeClientRequestId:
              false,
          }),
      });

    assertJson(
      result,
      "missing idempotency"
    );

    assertEqual(
      result.status,
      400,
      "real-write without client_request_id rejected"
    );

    assert.deepEqual(
      coreCounts(),
      before,
      "missing idempotency creates no core persistence"
    );

    pass(
      "missing idempotency creates no core persistence"
    );

    assertDownstreamUnchanged(
      downstreamBefore,
      "missing idempotency"
    );
  }


  /* ---------------------------------------------------------------------- */
  /* Real write                                                              */
  /* ---------------------------------------------------------------------- */

  section(
    "REAL-WRITE CONTRACT"
  );

  let transaction;
  let document;
  let idempotency;

  {
    const before =
      coreCounts();

    const result =
      await request({
        method:
          "POST",

        mode:
          "real-write",

        form:
          formData({
            storagePrefixId:
              prefix.id,
          }),
      });

    assertJson(
      result,
      "real-write"
    );

    if (
      result.status !== 201
    ) {
      console.error(
        JSON.stringify(
          result.body,
          null,
          2
        )
      );
    }

    assertEqual(
      result.status,
      201,
      "real-write succeeds"
    );

    assertEqual(
      result.body?.accepted,
      true,
      "real-write accepted"
    );


    const after =
      coreCounts();

    assertEqual(
      after.transactions,
      before.transactions + 1,
      "exactly one upload transaction created"
    );

    assertEqual(
      after.idempotency,
      before.idempotency + 1,
      "exactly one idempotency record created"
    );

    assertEqual(
      after.documents,
      before.documents + 1,
      "exactly one document created"
    );


    const transactions =
      transactionsForRun();

    assertEqual(
      transactions.length,
      1,
      "exactly one transaction belongs to validator upload"
    );

    transaction =
      transactions[0];

    cleanupTransactionId =
      transaction.id;


    document =
      documentBySlug();

    assertTrue(
      document,
      "draft document persisted"
    );

    cleanupDocumentId =
      document.id;


    const idempotencyRows =
      idempotencyForTransaction(
        transaction.id
      );

    assertEqual(
      idempotencyRows.length,
      1,
      "exactly one idempotency record binds transaction"
    );

    idempotency =
      idempotencyRows[0];


    /* -------------------------------------------------------------------- */
    /* Durable document contract                                             */
    /* -------------------------------------------------------------------- */

    assertEqual(
      document.status,
      "draft",
      "document remains draft"
    );

    assertEqual(
      Number(
        document.is_listed
      ),
      0,
      "document remains unlisted"
    );

    assertEqual(
      Number(
        document.requires_approval
      ),
      1,
      "document requires approval"
    );

    assertEqual(
      document.requestability_status,
      "not_requestable",
      "document remains not requestable"
    );

    assertEqual(
      document.listed_at,
      null,
      "listed_at remains null"
    );

    assertEqual(
      document.requestable_at,
      null,
      "requestable_at remains null"
    );

    assertEqual(
      document.classification,
      "controlled",
      "classification preserved"
    );

    assertEqual(
      document.access_class,
      "controlled_verified",
      "access class preserved"
    );

    assertEqual(
      document.source_sha256,
      EXPECTED_SHA256,
      "document source hash matches upload"
    );


    /* -------------------------------------------------------------------- */
    /* Durable transaction evidence                                          */
    /* -------------------------------------------------------------------- */

    assertEqual(
      transaction.upload_domain,
      "cdas_document",
      "transaction belongs to CDAS document domain"
    );

    assertEqual(
      transaction.related_record_id,
      SLUG,
      "transaction bound to uploaded document slug"
    );

    assertEqual(
      transaction.source_sha256,
      EXPECTED_SHA256,
      "transaction source hash matches upload"
    );

    assertEqual(
      Number(
        transaction.source_size
      ),
      PDF_BYTES.length,
      "transaction source size matches upload"
    );

    assertEqual(
      transaction.failed_at,
      null,
      "upload transaction did not fail"
    );


    /* -------------------------------------------------------------------- */
    /* Idempotency contract                                                  */
    /* -------------------------------------------------------------------- */

    assertTrue(
      [
        "completed",
        "completed_with_warning",
      ].includes(
        idempotency.status
      ),
      "idempotency record is completed"
    );

    assertEqual(
      Number(
        idempotency.replay_count
      ),
      0,
      "new idempotency record has no replay yet"
    );


    /* -------------------------------------------------------------------- */
    /* R2 durable evidence                                                   */
    /* -------------------------------------------------------------------- */

    const sourceKey =
      document.source_object;

    const shaKey =
      result.body
        ?.upload_result
        ?.object_keys
        ?.sha256;

    const metadataKey =
      result.body
        ?.upload_result
        ?.object_keys
        ?.metadata;

    cleanupObjectKeys = [
      sourceKey,
      shaKey,
      metadataKey,
    ].filter(Boolean);


    assertTrue(
      Boolean(sourceKey),
      "document source object key persisted"
    );

    assertTrue(
      Boolean(shaKey),
      "SHA sidecar key returned"
    );

    assertTrue(
      Boolean(metadataKey),
      "metadata sidecar key returned"
    );


    assertTrue(
      r2Exists(sourceKey),
      "source PDF exists in local R2"
    );

    assertTrue(
      r2Exists(shaKey),
      "SHA sidecar exists in local R2"
    );

    assertTrue(
      r2Exists(metadataKey),
      "metadata sidecar exists in local R2"
    );


    const storedSource =
      readR2(
        sourceKey
      );

    assertEqual(
      storedSource.length,
      PDF_BYTES.length,
      "R2 source size matches upload"
    );

    assertEqual(
      crypto
        .createHash("sha256")
        .update(storedSource)
        .digest("hex"),
      EXPECTED_SHA256,
      "R2 source bytes match uploaded source"
    );


    assertDownstreamUnchanged(
      downstreamBefore,
      "real-write"
    );
  }


  /* ---------------------------------------------------------------------- */
  /* Replay                                                                  */
  /* ---------------------------------------------------------------------- */

  section(
    "IDEMPOTENT REPLAY CONTRACT"
  );

  {
    const before =
      coreCounts();

    const sourceBefore =
      readR2(
        document.source_object
      );

    const result =
      await request({
        method:
          "POST",

        mode:
          "real-write",

        form:
          formData({
            storagePrefixId:
              prefix.id,
          }),
      });

    assertJson(
      result,
      "idempotent replay"
    );

    assertEqual(
      result.status,
      200,
      "completed replay returns controlled 200"
    );

    assertEqual(
      result.body?.idempotent_replay,
      true,
      "response identifies idempotent replay"
    );


    assert.deepEqual(
      coreCounts(),
      before,
      "replay creates no duplicate transaction, idempotency record or document"
    );

    pass(
      "replay creates no duplicate transaction, idempotency record or document"
    );


    const transactionsAfter =
      transactionsForRun();

    assertEqual(
      transactionsAfter.length,
      1,
      "replay retains one upload transaction"
    );


    const idempotencyAfter =
      idempotencyForTransaction(
        transaction.id
      );

    assertEqual(
      idempotencyAfter.length,
      1,
      "replay retains one idempotency row"
    );

    assertEqual(
      Number(
        idempotencyAfter[0]
          .replay_count
      ),
      1,
      "replay count increments exactly once"
    );

    assertTrue(
      Boolean(
        idempotencyAfter[0]
          .last_replayed_at
      ),
      "replay timestamp recorded"
    );


    const sourceAfter =
      readR2(
        document.source_object
      );

    assertEqual(
      crypto
        .createHash("sha256")
        .update(sourceAfter)
        .digest("hex"),
      crypto
        .createHash("sha256")
        .update(sourceBefore)
        .digest("hex"),
      "replay leaves source R2 object unchanged"
    );


    assertDownstreamUnchanged(
      downstreamBefore,
      "idempotent replay"
    );
  }


  /* ---------------------------------------------------------------------- */
  /* Final downstream safety                                                 */
  /* ---------------------------------------------------------------------- */

  section(
    "FINAL U3-K SAFETY BOUNDARY"
  );

  assertDownstreamUnchanged(
    downstreamBefore,
    "final U3-K boundary"
  );


  console.log();
  console.log(
    "============================================"
  );

  console.log(
    "PASS — U3-K CONTRACT VALIDATION"
  );

  console.log(
    "============================================"
  );

  pass(
    "real dispatcher exercised"
  );

  pass(
    "admin authentication exercised"
  );

  pass(
    "real local D1 exercised"
  );

  pass(
    "real local R2 exercised"
  );

  pass(
    "malformed multipart fails closed"
  );

  pass(
    "dry-run performs no writes"
  );

  pass(
    "R2 absence preflight proven"
  );

  pass(
    "real-write requires idempotency"
  );

  pass(
    "one transaction created"
  );

  pass(
    "one idempotency record created"
  );

  pass(
    "one controlled draft document created"
  );

  pass(
    "draft remains unlisted"
  );

  pass(
    "draft remains approval-gated"
  );

  pass(
    "draft remains not requestable"
  );

  pass(
    "source hash preserved"
  );

  pass(
    "source PDF written and read back from R2"
  );

  pass(
    "SHA sidecar written"
  );

  pass(
    "metadata sidecar written"
  );

  pass(
    "completed idempotent replay proven"
  );

  pass(
    "replay creates no duplicate writes"
  );

  pass(
    "U3-L remains outside U3-K"
  );

  pass(
    "U3-M remains outside U3-K"
  );

  pass(
    "U3-N remains outside U3-K"
  );

  pass(
    "U3-O remains outside U3-K"
  );

  pass(
    "U3-P remains outside U3-K"
  );

  pass(
    "U3-Q remains outside U3-K"
  );

  pass(
    "U3-R remains outside U3-K"
  );
}


/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

try {
  await main();
} catch (error) {
  console.error();

  console.error(
    "============================================"
  );

  console.error(
    "FAIL — U3-K CONTRACT VALIDATION"
  );

  console.error(
    "============================================"
  );

  console.error(error);

  process.exitCode = 1;
} finally {
  cleanup();
}
