import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = "http://127.0.0.1:8787";
const ADMIN_TOKEN = "u3-r-validator-token";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS ${message}`);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${ADMIN_TOKEN}`);

  return await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

async function json(response) {
  const body = await response.text();

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `Expected JSON response, got status ${response.status}: ${body}`,
    );
  }
}

async function d1(command) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "relayhub_early_access",
        "--local",
        "--json",
        "--command",
        command,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `D1 command failed (${code})\n${stderr}\n${stdout}`,
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `Could not parse D1 JSON output: ${error.message}\n${stdout}`,
          ),
        );
      }
    });
  });
}

function rows(result) {
  if (!Array.isArray(result) || !result.length) {
    return [];
  }

  if (Array.isArray(result[0]?.results)) {
    return result[0].results;
  }

  return [];
}

async function scalar(command, field = "total") {
  const result = await d1(command);
  const row = rows(result)[0] || {};

  return Number(row[field] || 0);
}

async function firstRow(command) {
  const result = await d1(command);

  return rows(result)[0] || null;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/`);

      if (response) {
        return;
      }
    } catch {
      // Keep waiting.
    }

    await sleep(250);
  }

  throw new Error("Wrangler dev server did not become ready.");
}

async function seedFixture() {
  const suffix = Date.now().toString(36);

  const documentId = `u3r_doc_${suffix}`;
  const requestId = `u3r_req_${suffix}`;
  const reviewEventId = `u3r_review_${suffix}`;
  const releasePolicyId = `u3r_policy_${suffix}`;

  const now = new Date().toISOString();

  await d1(`
    INSERT INTO documents (
      id,
      slug,
      title,
      description,
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
    )
    VALUES (
      '${documentId}',
      '${documentId}',
      'U3-R Validator Document',
      'U3-R validator fixture',
      '1.0',
      'active',
      'controlled',
      'controlled_verified',
      'docs/source/${documentId}.pdf',
      '${"a".repeat(64)}',
      'CDAS-LICENCE-v0.1',
      1,
      1,
      'requestable_controlled',
      '${now}',
      '${now}',
      '${now}',
      '${now}'
    );
  `);

  await d1(`
    INSERT INTO document_release_policies (
      id,
      document_id,
      document_version,
      release_class,
      policy_status,
      public_visibility,
      access_mode,
      release_state,
      licence_terms_id,
      licence_terms_version,
      licence_terms_status,
      listed_publicly,
      request_button_enabled,
      public_download_enabled,
      approval_required,
      email_verification_required,
      manual_review_required,
      payment_required,
      watermark_required,
      personalised_pdf_required,
      download_id_required,
      single_use_link_required,
      evidence_bundle_required,
      source_hash_required,
      created_at,
      updated_at
    )
    VALUES (
      '${releasePolicyId}',
      '${documentId}',
      '1.0',
      'CONTROLLED_DISCLOSURE',
      'active',
      'listed',
      'controlled_disclosure',
      'request_open',
      'lt_cdas_v0_1',
      'CDAS-LICENCE-v0.1',
      'active',
      1,
      1,
      0,
      1,
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      '${now}',
      '${now}'
    );
  `);

  await d1(`
    INSERT INTO document_access_requests (
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
      recipient_category,
      status,
      access_class,
      email_verified_at,
      requested_at,
      approved_at,
      approved_by,
      approval_role,
      approval_policy_version,
      approval_note,
      terms_version,
      terms_accepted_at,
      risk_score,
      intake_source,
      request_review_status,
      requestability_status_at_intake
    )
    VALUES (
      '${requestId}',
      '${documentId}',
      '1.0',
      'U3-R Validator',
      'u3-r-validator@example.invalid',
      'u3-r-validator@example.invalid',
      'individual',
      NULL,
      'U3-R Validator',
      'u3-r-validator@example.invalid',
      'public_reader',
      'approved_pending_licence',
      'controlled_verified',
      '${now}',
      '${now}',
      '${now}',
      'u3-q-validator',
      'cdas_upload_gate',
      'U3-Q',
      'Approved for U3-R validation',
      'CDAS-LICENCE-v0.1',
      '${now}',
      0,
      'u3-r-validator',
      'approved_for_licence_prep',
      'requestable_controlled'
    );
  `);

  await d1(`
    INSERT INTO document_access_request_review_events (
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
    )
    VALUES (
      '${reviewEventId}',
      '${requestId}',
      'review_approved',
      'pending_approval',
      'approved_pending_licence',
      'u3-q-validator',
      NULL,
      'Approved for licence preparation',
      '{"phase":"U3-Q"}',
      '${now}'
    );
  `);

  return {
    documentId,
    requestId,
    reviewEventId,
    releasePolicyId,
  };
}

async function main() {
  console.log("===== U3-R VALIDATION =====");

  const beforePreparation = await scalar(
    "SELECT COUNT(*) AS total FROM document_access_request_licence_preparation_events;",
  );

  const beforeLicences = await scalar(
    "SELECT COUNT(*) AS total FROM document_licences;",
  );

  const beforeIssueEvents = await scalar(
    "SELECT COUNT(*) AS total FROM document_access_request_licence_issue_events;",
  );

  const beforeLinks = await scalar(
    "SELECT COUNT(*) AS total FROM document_download_links;",
  );

  const fixture = await seedFixture();

  const unauthorised = await fetch(
    `${BASE_URL}/api/admin/uploads/cdas-document/access-request/licence-preparation`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: fixture.requestId,
      }),
    },
  );

  assert(
    unauthorised.status === 401,
    "U3-R route requires admin authentication",
  );

  let response = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-preparation",
    {
      method: "GET",
    },
  );

  assert(
    response.status === 405,
    "U3-R rejects non-POST methods",
  );

  response = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-preparation",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );

  assert(
    response.status === 400,
    "U3-R requires an access request ID",
  );

  response = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-preparation",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "u3-r-validator",
      },
      body: JSON.stringify({
        request_id: fixture.requestId,
        note: "U3-R validator preparation",
      }),
    },
  );

  const prepared = await json(response);

  assert(
    response.status === 200,
    "eligible approved request passes U3-R",
  );

  assert(
    prepared.ok === true && prepared.prepared === true,
    "U3-R reports successful licence preparation",
  );

  assert(
    prepared.already_prepared === false,
    "first U3-R execution creates new preparation evidence",
  );

  assert(
    prepared.next_allowed_action === "explicit_licence_issue",
    "U3-R exposes explicit licence issue as the next action",
  );

  assert(
    prepared.safety?.licence_created === false,
    "U3-R does not create a licence",
  );

  assert(
    prepared.safety?.licence_issue_event_created === false,
    "U3-R does not create a licence issue event",
  );

  assert(
    prepared.safety?.generated_pdf_created === false,
    "U3-R does not generate a PDF",
  );

  assert(
    prepared.safety?.download_link_created === false,
    "U3-R does not create a download link",
  );

  assert(
    prepared.safety?.email_sent === false,
    "U3-R does not send email",
  );

  const preparationRow = await firstRow(`
    SELECT *
    FROM document_access_request_licence_preparation_events
    WHERE request_id = '${fixture.requestId}'
    LIMIT 1;
  `);

  assert(
    Boolean(preparationRow),
    "U3-R persists preparation evidence",
  );

  assert(
    preparationRow.review_event_id === fixture.reviewEventId,
    "U3-R binds preparation to qualifying U3-Q review evidence",
  );

  assert(
    preparationRow.release_policy_id === fixture.releasePolicyId,
    "U3-R binds preparation to release policy",
  );

  assert(
    preparationRow.licence_terms_id === "lt_cdas_v0_1",
    "U3-R binds preparation to exact licence terms record",
  );

  assert(
    preparationRow.licence_terms_version === "CDAS-LICENCE-v0.1",
    "U3-R freezes licence terms version",
  );

  assert(
    /^[a-f0-9]{64}$/i.test(
      preparationRow.licence_terms_body_sha256 || "",
    ),
    "U3-R freezes licence terms body SHA-256",
  );

  assert(
    preparationRow.source_sha256 === "a".repeat(64),
    "U3-R freezes source SHA-256",
  );

  assert(
    preparationRow.approval_policy_version === "U3-Q",
    "U3-R preserves U3-Q approval policy evidence",
  );

  assert(
    preparationRow.preparation_policy_version === "U3-R",
    "U3-R records its own preparation policy version",
  );

  const afterFirstPreparation = await scalar(
    `SELECT COUNT(*) AS total
     FROM document_access_request_licence_preparation_events
     WHERE request_id = '${fixture.requestId}';`,
  );

  assert(
    afterFirstPreparation === 1,
    "successful U3-R creates exactly one preparation event",
  );

  response = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-preparation",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "u3-r-validator",
      },
      body: JSON.stringify({
        request_id: fixture.requestId,
        note: "U3-R validator preparation",
      }),
    },
  );

  const replay = await json(response);

  assert(
    response.status === 200,
    "completed U3-R preparation may be replayed safely",
  );

  assert(
    replay.already_prepared === true,
    "U3-R replay is idempotent",
  );

  const afterReplay = await scalar(
    `SELECT COUNT(*) AS total
     FROM document_access_request_licence_preparation_events
     WHERE request_id = '${fixture.requestId}';`,
  );

  assert(
    afterReplay === 1,
    "U3-R replay creates no duplicate preparation evidence",
  );

  await d1(`
    UPDATE documents
    SET requestability_status = 'not_requestable'
    WHERE id = '${fixture.documentId}';
  `);

  response = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-preparation",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: fixture.requestId,
        note: "U3-R validator preparation",
      }),
    },
  );

  const disabled = await json(response);

  assert(
    response.status === 409,
    "U3-R fails closed when document is no longer requestable",
  );

  assert(
    Array.isArray(disabled.blockers) &&
      disabled.blockers.includes(
        "document_not_requestable_controlled",
      ),
    "U3-R reports requestability blocker",
  );

  await d1(`
    UPDATE documents
    SET requestability_status = 'requestable_controlled'
    WHERE id = '${fixture.documentId}';
  `);

  await d1(`
    UPDATE document_access_requests
    SET email_normalised = 'changed-u3-r@example.invalid'
    WHERE id = '${fixture.requestId}';
  `);

  response = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-preparation",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: fixture.requestId,
        note: "U3-R validator preparation",
      }),
    },
  );

  const conflict = await json(response);

  assert(
    response.status === 409,
    "U3-R rejects changed inputs after preparation",
  );

  assert(
    conflict.error === "licence_preparation_evidence_conflict",
    "U3-R identifies preparation evidence conflicts",
  );

  const afterLicences = await scalar(
    "SELECT COUNT(*) AS total FROM document_licences;",
  );

  const afterIssueEvents = await scalar(
    "SELECT COUNT(*) AS total FROM document_access_request_licence_issue_events;",
  );

  const afterLinks = await scalar(
    "SELECT COUNT(*) AS total FROM document_download_links;",
  );

  const afterPreparation = await scalar(
    "SELECT COUNT(*) AS total FROM document_access_request_licence_preparation_events;",
  );

  assert(
    afterLicences === beforeLicences,
    "U3-R creates no document licence",
  );

  assert(
    afterIssueEvents === beforeIssueEvents,
    "U3-R creates no licence issue event",
  );

  assert(
    afterLinks === beforeLinks,
    "U3-R creates no download link",
  );

  assert(
    afterPreparation === beforePreparation + 1,
    "U3-R adds exactly one durable preparation record",
  );

  console.log("");
  console.log("===== U3-R VALIDATION PASSED =====");
}

const wrangler = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--local",
    "--port",
    "8787",
    "--var",
    `RELAYHUB_ADMIN_TOKEN:${ADMIN_TOKEN}`,
  ],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  },
);

wrangler.stdout.on("data", (chunk) => {
  process.stdout.write(`[wrangler] ${chunk}`);
});

wrangler.stderr.on("data", (chunk) => {
  process.stderr.write(`[wrangler] ${chunk}`);
});

try {
  await waitForServer();
  await main();
} finally {
  wrangler.kill("SIGTERM");
}