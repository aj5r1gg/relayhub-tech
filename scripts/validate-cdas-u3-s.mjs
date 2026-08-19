import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE_URL = "http://127.0.0.1:8787";
const ADMIN_TOKEN = "u3-s-validator-token";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS ${message}`);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${ADMIN_TOKEN}`);

  return fetch(`${BASE_URL}${path}`, {
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
      `Expected JSON response, got ${response.status}: ${body}`,
    );
  }
}

async function d1(command) {
  return new Promise((resolve, reject) => {
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

  return Array.isArray(result[0]?.results)
    ? result[0].results
    : [];
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

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sqlText(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

async function getTerms() {
  const terms = await firstRow(`
    SELECT
      id,
      version,
      body,
      body_sha256,
      status
    FROM licence_terms
    WHERE version = 'CDAS-LICENCE-v0.1'
    LIMIT 1;
  `);

  assert(Boolean(terms), "validator licence terms exist");

  return {
    ...terms,
    effective_body_sha256:
      terms.body_sha256 || await sha256Hex(terms.body),
  };
}

async function seedFixture({
  label,
  includePreparation = true,
  requestStatus = "approved_pending_licence",
  requestReviewStatus = "approved_for_licence_prep",
  preparationPolicyVersion = "U3-R",
  includeReviewEvent = true,
} = {}) {
  const suffix =
    `${label || "fixture"}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  const documentId = `u3s_doc_${suffix}`;
  const requestId = `u3s_req_${suffix}`;
  const reviewEventId = `u3s_review_${suffix}`;
  const releasePolicyId = `u3s_policy_${suffix}`;
  const preparationId = `u3s_prep_${suffix}`;

  const now = new Date().toISOString();
  const terms = await getTerms();

  const sourceObject =
    `docs/source/${documentId}.pdf`;

  const sourceSha256 =
    "b".repeat(64);

  const email =
    `${suffix}@example.invalid`;

  const name =
    `U3-S ${label || "Validator"}`;

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
      ${sqlText(documentId)},
      ${sqlText(documentId)},
      ${sqlText(`${name} Document`)},
      'U3-S validator fixture',
      '1.0',
      'active',
      'controlled',
      'controlled_verified',
      ${sqlText(sourceObject)},
      ${sqlText(sourceSha256)},
      ${sqlText(terms.version)},
      1,
      1,
      'requestable_with_approval',
      ${sqlText(now)},
      ${sqlText(now)},
      ${sqlText(now)},
      ${sqlText(now)}
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
      request_intake_policy_id,
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
      ${sqlText(releasePolicyId)},
      ${sqlText(documentId)},
      '1.0',
      'CONTROLLED_DISCLOSURE',
      'active',
      'listed',
      'controlled_disclosure',
      'request_open',
      ${sqlText(terms.id)},
      ${sqlText(terms.version)},
      'active',
      'rip_cdas_standard_v1',
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
      ${sqlText(now)},
      ${sqlText(now)}
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
      ${sqlText(requestId)},
      ${sqlText(documentId)},
      '1.0',
      ${sqlText(name)},
      ${sqlText(email)},
      ${sqlText(email)},
      'individual',
      NULL,
      ${sqlText(name)},
      ${sqlText(email)},
      'public_reader',
      ${sqlText(requestStatus)},
      'controlled_verified',
      ${sqlText(now)},
      ${sqlText(now)},
      ${sqlText(now)},
      'u3-q-validator',
      'cdas_upload_gate',
      'U3-Q',
      'Approved for U3-S validation',
      ${sqlText(terms.version)},
      ${sqlText(now)},
      0,
      'u3-s-validator',
      ${sqlText(requestReviewStatus)},
      'requestable_with_approval'
    );
  `);

  if (includeReviewEvent) {
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
        ${sqlText(reviewEventId)},
        ${sqlText(requestId)},
        'review_approved',
        'pending_approval',
        'approved_pending_licence',
        'u3-q-validator',
        NULL,
        'Approved for licence preparation',
        '{"phase":"U3-Q"}',
        ${sqlText(now)}
      );
    `);
  }

  if (includePreparation) {
    await d1(`
      INSERT INTO document_access_request_licence_preparation_events (
        id,
        request_id,
        document_id,
        document_version,
        review_event_id,
        release_policy_id,
        licence_terms_id,
        licence_terms_version,
        licence_terms_body_sha256,
        source_object,
        source_sha256,
        licence_holder_type,
        licence_holder_name,
        organisation_name,
        contact_name,
        contact_email,
        licence_holder_email,
        licence_holder_email_normalised,
        recipient_category,
        request_terms_version,
        terms_accepted_at,
        approved_at,
        approved_by,
        approval_role,
        approval_policy_version,
        actor,
        note,
        preparation_policy_version,
        metadata_json,
        created_at
      )
      VALUES (
        ${sqlText(preparationId)},
        ${sqlText(requestId)},
        ${sqlText(documentId)},
        '1.0',
        ${sqlText(reviewEventId)},
        ${sqlText(releasePolicyId)},
        ${sqlText(terms.id)},
        ${sqlText(terms.version)},
        ${sqlText(terms.effective_body_sha256)},
        ${sqlText(sourceObject)},
        ${sqlText(sourceSha256)},
        'individual',
        ${sqlText(name)},
        NULL,
        ${sqlText(name)},
        ${sqlText(email)},
        ${sqlText(email)},
        ${sqlText(email)},
        'public_reader',
        ${sqlText(terms.version)},
        ${sqlText(now)},
        ${sqlText(now)},
        'u3-q-validator',
        'cdas_upload_gate',
        'U3-Q',
        'u3-r-validator',
        'Prepared for U3-S validation',
        ${sqlText(preparationPolicyVersion)},
        '{"phase":"U3-R"}',
        ${sqlText(now)}
      );
    `);
  }

  return {
    documentId,
    requestId,
    reviewEventId,
    releasePolicyId,
    preparationId,
    sourceObject,
    sourceSha256,
    email,
    name,
    terms,
    now,
  };
}

async function issue(requestId, note = "U3-S validator issuance") {
  const response = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-issue",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "u3-s-validator",
      },
      body: JSON.stringify({
        request_id: requestId,
        note,
      }),
    },
  );

  return {
    response,
    body: await json(response),
  };
}

async function assertNoIssuance(requestId, label) {
  const licenceCount = await scalar(`
    SELECT COUNT(*) AS total
    FROM document_licences
    WHERE request_id = ${sqlText(requestId)};
  `);

  const issueEventCount = await scalar(`
    SELECT COUNT(*) AS total
    FROM document_access_request_licence_issue_events
    WHERE request_id = ${sqlText(requestId)};
  `);

  const linkCount = await scalar(`
    SELECT COUNT(*) AS total
    FROM document_download_links dl
    INNER JOIN document_licences lic
      ON lic.id = dl.licence_id
    WHERE lic.request_id = ${sqlText(requestId)};
  `);

  const requestRow = await firstRow(`
    SELECT status
    FROM document_access_requests
    WHERE id = ${sqlText(requestId)}
    LIMIT 1;
  `);

  assert(
    licenceCount === 0,
    `${label}: creates no licence`,
  );

  assert(
    issueEventCount === 0,
    `${label}: creates no licence issue event`,
  );

  assert(
    linkCount === 0,
    `${label}: creates no download link`,
  );

  assert(
    requestRow?.status !== "licence_issued",
    `${label}: request does not become licence_issued`,
  );
}

async function validatePositivePath() {
  console.log("");
  console.log("===== POSITIVE / REPLAY PATH =====");

  const fixture = await seedFixture({
    label: "positive",
  });

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 200,
    "eligible prepared request passes U3-S",
  );

  assert(
    result.body.ok === true &&
      result.body.issued === true &&
      result.body.already_issued === false,
    "U3-S reports successful explicit licence issuance",
  );

  assert(
    result.body.safety?.licence_created === true,
    "U3-S reports licence creation",
  );

  assert(
    result.body.safety?.licence_issue_event_created === true,
    "U3-S reports issue-event creation",
  );

  assert(
    result.body.safety?.generated_pdf_created === false,
    "U3-S does not generate a PDF",
  );

  assert(
    result.body.safety?.download_link_created === false,
    "U3-S does not create a download link",
  );

  assert(
    result.body.safety?.email_sent === false,
    "U3-S does not send email",
  );

  assert(
    result.body.safety?.download_served === false,
    "U3-S does not serve a download",
  );

  const requestRow = await firstRow(`
    SELECT
      status,
      request_review_status
    FROM document_access_requests
    WHERE id = ${sqlText(fixture.requestId)}
    LIMIT 1;
  `);

  assert(
    requestRow?.status === "licence_issued",
    "U3-S persists licence_issued request state",
  );

  assert(
    requestRow?.request_review_status ===
      "approved_for_licence_prep",
    "U3-S preserves U3-Q review state",
  );

  const licence = await firstRow(`
    SELECT *
    FROM document_licences
    WHERE request_id = ${sqlText(fixture.requestId)}
    LIMIT 1;
  `);

  assert(Boolean(licence), "U3-S persists a licence");

  assert(
    licence.document_id === fixture.documentId,
    "issued licence binds exact document",
  );

  assert(
    licence.document_version === "1.0",
    "issued licence binds exact version",
  );

  assert(
    licence.licence_holder_name === fixture.name,
    "issued licence uses frozen licence-holder name",
  );

  assert(
    licence.licence_holder_email_normalised === fixture.email,
    "issued licence uses frozen email",
  );

  assert(
    licence.licence_terms_version === fixture.terms.version,
    "issued licence uses frozen terms version",
  );

  assert(
    licence.rendered_terms_body_sha256 ===
      fixture.terms.effective_body_sha256,
    "issued licence terms hash matches U3-R evidence",
  );

  assert(
    licence.source_object === fixture.sourceObject,
    "issued licence preserves frozen source object",
  );

  assert(
    licence.source_sha256 === fixture.sourceSha256,
    "issued licence preserves frozen source SHA-256",
  );

  assert(
    licence.generated_pdf_status === "not_generated",
    "issued licence remains not_generated for PDF",
  );

  assert(
    licence.generated_pdf_object_key === null,
    "issued licence has no PDF object key",
  );

  const issueEvent = await firstRow(`
    SELECT *
    FROM document_access_request_licence_issue_events
    WHERE request_id = ${sqlText(fixture.requestId)}
    LIMIT 1;
  `);

  assert(
    Boolean(issueEvent),
    "U3-S persists licence issue evidence",
  );

  const metadata =
    JSON.parse(issueEvent.metadata_json || "{}");

  assert(
    metadata.preparation_event_id === fixture.preparationId,
    "issue evidence binds exact U3-R preparation",
  );

  assert(
    metadata.review_event_id === fixture.reviewEventId,
    "issue evidence binds exact U3-Q review",
  );

  assert(
    metadata.issuance_policy_version === "U3-S",
    "issue evidence records U3-S policy",
  );

  const replay = await issue(fixture.requestId);

  assert(
    replay.response.status === 200,
    "U3-S replay succeeds safely",
  );

  assert(
    replay.body.already_issued === true,
    "U3-S replay is idempotent",
  );

  assert(
    await scalar(`
      SELECT COUNT(*) AS total
      FROM document_licences
      WHERE request_id = ${sqlText(fixture.requestId)};
    `) === 1,
    "U3-S replay creates no duplicate licence",
  );

  assert(
    await scalar(`
      SELECT COUNT(*) AS total
      FROM document_access_request_licence_issue_events
      WHERE request_id = ${sqlText(fixture.requestId)};
    `) === 1,
    "U3-S replay creates no duplicate issue event",
  );
}

async function validateNoPreparation() {
  console.log("");
  console.log("===== NO U3-R PREPARATION =====");

  const fixture = await seedFixture({
    label: "no-preparation",
    includePreparation: false,
  });

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S blocks request without U3-R evidence",
  );

  assert(
    result.body.error ===
      "licence_preparation_evidence_missing",
    "U3-S identifies missing U3-R evidence",
  );

  await assertNoIssuance(
    fixture.requestId,
    "missing preparation",
  );
}

async function validateInvalidRequestState() {
  console.log("");
  console.log("===== INVALID REQUEST STATE =====");

  const fixture = await seedFixture({
    label: "invalid-state",
    requestStatus: "pending_approval",
  });

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S blocks invalid request state",
  );

  assert(
    result.body.blockers?.includes(
      "request_status_not_approved_pending_licence",
    ),
    "U3-S reports invalid request-state blocker",
  );

  await assertNoIssuance(
    fixture.requestId,
    "invalid request state",
  );
}

async function validateRequestabilityRevoked() {
  console.log("");
  console.log("===== REQUESTABILITY REVOKED =====");

  const fixture = await seedFixture({
    label: "not-requestable",
  });

  await d1(`
    UPDATE documents
    SET requestability_status = 'not_requestable'
    WHERE id = ${sqlText(fixture.documentId)};
  `);

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S fails closed when requestability is revoked",
  );

  assert(
    result.body.blockers?.includes(
      "document_not_requestable_with_approval",
    ),
    "U3-S reports requestability blocker",
  );

  await assertNoIssuance(
    fixture.requestId,
    "requestability revoked",
  );
}

async function validateSourceShaDrift() {
  console.log("");
  console.log("===== SOURCE SHA DRIFT =====");

  const fixture = await seedFixture({
    label: "source-sha-drift",
  });

  await d1(`
    UPDATE documents
    SET source_sha256 = '${"c".repeat(64)}'
    WHERE id = ${sqlText(fixture.documentId)};
  `);

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S fails closed when source SHA changes",
  );

  assert(
    result.body.blockers?.includes(
      "document_source_sha256_changed_after_preparation",
    ),
    "U3-S reports source SHA drift",
  );

  await assertNoIssuance(
    fixture.requestId,
    "source SHA drift",
  );
}

async function validateSourceObjectDrift() {
  console.log("");
  console.log("===== SOURCE OBJECT DRIFT =====");

  const fixture = await seedFixture({
    label: "source-object-drift",
  });

  await d1(`
    UPDATE documents
    SET source_object = 'docs/source/changed-u3s.pdf'
    WHERE id = ${sqlText(fixture.documentId)};
  `);

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S fails closed when source object changes",
  );

  assert(
    result.body.blockers?.includes(
      "document_source_object_changed_after_preparation",
    ),
    "U3-S reports source-object drift",
  );

  await assertNoIssuance(
    fixture.requestId,
    "source object drift",
  );
}

async function validateIdentityDrift() {
  console.log("");
  console.log("===== LICENCE-HOLDER IDENTITY DRIFT =====");

  const fixture = await seedFixture({
    label: "identity-drift",
  });

  await d1(`
    UPDATE document_access_requests
    SET email_normalised = 'changed-u3s@example.invalid'
    WHERE id = ${sqlText(fixture.requestId)};
  `);

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S fails closed when licence-holder identity changes",
  );

  assert(
    result.body.blockers?.some((blocker) =>
      blocker.includes(
        "licence_holder_licence_holder_email_normalised_changed_after_preparation",
      ),
    ),
    "U3-S reports licence-holder identity drift",
  );

  await assertNoIssuance(
    fixture.requestId,
    "identity drift",
  );
}

async function validateTermsBodyDrift() {
  console.log("");
  console.log("===== LICENCE TERMS BODY DRIFT =====");

  const fixture = await seedFixture({
    label: "terms-body-drift",
  });

  const originalBody = fixture.terms.body;
  const originalHash = fixture.terms.body_sha256;

  try {
    await d1(`
      UPDATE licence_terms
      SET
        body = body || CHAR(10) || 'U3-S mutation test',
        body_sha256 = NULL
      WHERE id = ${sqlText(fixture.terms.id)};
    `);

    const result = await issue(fixture.requestId);

    assert(
      result.response.status === 409,
      "U3-S fails closed when licence terms body changes",
    );

    assert(
      result.body.blockers?.includes(
        "licence_terms_body_changed_after_preparation",
      ),
      "U3-S reports licence terms body drift",
    );

    await assertNoIssuance(
      fixture.requestId,
      "licence terms body drift",
    );
  } finally {
    await d1(`
      UPDATE licence_terms
      SET
        body = ${sqlText(originalBody)},
        body_sha256 = ${sqlText(originalHash)}
      WHERE id = ${sqlText(fixture.terms.id)};
    `);
  }
}

async function validateTermsBindingDrift() {
  console.log("");
  console.log("===== LICENCE TERMS BINDING DRIFT =====");

  const fixture = await seedFixture({
    label: "terms-binding-drift",
  });

  await d1(`
    UPDATE documents
    SET licence_terms_version = 'CHANGED-LICENCE-v9'
    WHERE id = ${sqlText(fixture.documentId)};
  `);

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S fails closed when document terms binding changes",
  );

  assert(
    result.body.blockers?.includes(
      "document_licence_terms_changed_after_preparation",
    ),
    "U3-S reports document terms-binding drift",
  );

  await assertNoIssuance(
    fixture.requestId,
    "terms binding drift",
  );
}

async function validateReviewEvidenceMissing() {
  console.log("");
  console.log("===== U3-Q REVIEW EVIDENCE MISSING =====");

  const fixture = await seedFixture({
    label: "missing-review",
    includeReviewEvent: false,
  });

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S blocks missing U3-Q review evidence",
  );

  assert(
    result.body.blockers?.includes(
      "qualifying_u3_q_review_event_missing",
    ),
    "U3-S identifies missing U3-Q evidence",
  );

  await assertNoIssuance(
    fixture.requestId,
    "missing U3-Q review evidence",
  );
}

async function validateBadPreparationPolicy() {
  console.log("");
  console.log("===== INVALID U3-R POLICY VERSION =====");

  const fixture = await seedFixture({
    label: "bad-prep-policy",
    preparationPolicyVersion: "U3-R-INVALID",
  });

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S blocks non-U3-R preparation evidence",
  );

  assert(
    result.body.blockers?.includes(
      "preparation_policy_version_not_u3_r",
    ),
    "U3-S identifies invalid preparation policy",
  );

  await assertNoIssuance(
    fixture.requestId,
    "invalid preparation policy",
  );
}

async function validatePartialStateRecovery() {
  console.log("");
  console.log("===== PARTIAL ISSUANCE / RECOVERY REQUIRED =====");

  const fixture = await seedFixture({
    label: "partial-recovery",
  });

  const issuedAt = new Date().toISOString();
  const fakeLicenceId =
    `lic_partial_${Date.now().toString(36)}`;

  const fakeLicenceNumber =
    `RH-LIC-2099-${Math.floor(Math.random() * 900000 + 100000)}`;

  await d1(`
    INSERT INTO document_licences (
      id,
      licence_number,
      request_id,
      document_id,
      document_version,
      licence_holder_type,
      licence_holder_name,
      organisation_name,
      contact_name,
      contact_email,
      licence_holder_email,
      licence_holder_email_normalised,
      recipient_category,
      licence_terms_version,
      status,
      issued_at,
      rendered_licence_body,
      rendered_licence_sha256,
      rendered_terms_body_sha256,
      rendered_licence_placeholders,
      rendered_licence_unresolved_placeholders,
      rendered_licence_at,
      source_object,
      source_sha256,
      generated_pdf_status
    )
    VALUES (
      ${sqlText(fakeLicenceId)},
      ${sqlText(fakeLicenceNumber)},
      ${sqlText(fixture.requestId)},
      ${sqlText(fixture.documentId)},
      '1.0',
      'individual',
      ${sqlText(fixture.name)},
      NULL,
      ${sqlText(fixture.name)},
      ${sqlText(fixture.email)},
      ${sqlText(fixture.email)},
      ${sqlText(fixture.email)},
      'public_reader',
      ${sqlText(fixture.terms.version)},
      'issued',
      ${sqlText(issuedAt)},
      ${sqlText(fixture.terms.body)},
      ${sqlText(fixture.terms.effective_body_sha256)},
      ${sqlText(fixture.terms.effective_body_sha256)},
      '[]',
      '[]',
      ${sqlText(issuedAt)},
      ${sqlText(fixture.sourceObject)},
      ${sqlText(fixture.sourceSha256)},
      'not_generated'
    );
  `);

  const result = await issue(fixture.requestId);

  assert(
    result.response.status === 409,
    "U3-S blocks ambiguous partial issuance state",
  );

  assert(
    result.body.error === "u3_s_recovery_required",
    "U3-S marks partial issuance as recovery-required",
  );

  assert(
    await scalar(`
      SELECT COUNT(*) AS total
      FROM document_licences
      WHERE request_id = ${sqlText(fixture.requestId)};
    `) === 1,
    "recovery handling creates no second licence",
  );

  assert(
    await scalar(`
      SELECT COUNT(*) AS total
      FROM document_access_request_licence_issue_events
      WHERE request_id = ${sqlText(fixture.requestId)};
    `) === 0,
    "recovery handling does not fabricate missing issue evidence",
  );

  const requestRow = await firstRow(`
    SELECT status
    FROM document_access_requests
    WHERE id = ${sqlText(fixture.requestId)}
    LIMIT 1;
  `);

  assert(
    requestRow?.status === "approved_pending_licence",
    "recovery handling does not silently advance request state",
  );
}

async function validateRouteContract() {
  console.log("");
  console.log("===== ROUTE CONTRACT =====");

  const fixture = await seedFixture({
    label: "route-contract",
  });

  const unauthorised = await fetch(
    `${BASE_URL}/api/admin/uploads/cdas-document/access-request/licence-issue`,
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
    "U3-S route requires admin authentication",
  );

  const wrongMethod = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-issue",
    {
      method: "GET",
    },
  );

  assert(
    wrongMethod.status === 405,
    "U3-S rejects non-POST methods",
  );

  const missingId = await request(
    "/api/admin/uploads/cdas-document/access-request/licence-issue",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );

  assert(
    missingId.status === 400,
    "U3-S requires access request ID",
  );
}

async function main() {
  console.log("===== U3-S FULL VALIDATION =====");

  const beforeLicences = await scalar(
    "SELECT COUNT(*) AS total FROM document_licences;",
  );

  const beforeIssueEvents = await scalar(
    "SELECT COUNT(*) AS total FROM document_access_request_licence_issue_events;",
  );

  const beforeLinks = await scalar(
    "SELECT COUNT(*) AS total FROM document_download_links;",
  );

  await validateRouteContract();
  await validatePositivePath();
  await validateNoPreparation();
  await validateInvalidRequestState();
  await validateRequestabilityRevoked();
  await validateSourceShaDrift();
  await validateSourceObjectDrift();
  await validateIdentityDrift();
  await validateTermsBodyDrift();
  await validateTermsBindingDrift();
  await validateReviewEvidenceMissing();
  await validateBadPreparationPolicy();
  await validatePartialStateRecovery();

  const afterLicences = await scalar(
    "SELECT COUNT(*) AS total FROM document_licences;",
  );

  const afterIssueEvents = await scalar(
    "SELECT COUNT(*) AS total FROM document_access_request_licence_issue_events;",
  );

  const afterLinks = await scalar(
    "SELECT COUNT(*) AS total FROM document_download_links;",
  );

  /*
   * One legitimate licence + one deliberately seeded partial-state
   * licence should exist after this full validator.
   */
  assert(
    afterLicences === beforeLicences + 2,
    "full U3-S validation produces only expected licence rows",
  );

  assert(
    afterIssueEvents === beforeIssueEvents + 1,
    "full U3-S validation produces only one legitimate issue event",
  );

  assert(
    afterLinks === beforeLinks,
    "full U3-S validation produces no download links",
  );

  console.log("");
  console.log("===== U3-S FULL VALIDATION PASSED =====");
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