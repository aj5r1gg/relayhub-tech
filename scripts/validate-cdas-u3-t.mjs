import {
  spawn,
  spawnSync,
} from "node:child_process";

import {
  readFileSync,
} from "node:fs";

const BASE_URL = "http://127.0.0.1:8787";

const ROUTE =
  "/api/admin/uploads/cdas-document/access-request/generated-pdf-preparation";

const DATABASE = "relayhub_early_access";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }

  console.log(`PASS ${message}`);
}

function section(title) {
  console.log(`\n===== ${title} =====`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sqlText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "NULL";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseDevVars() {
  let text = "";

  try {
    text = readFileSync(
      ".dev.vars",
      "utf8",
    );
  } catch {
    return {};
  }

  const vars = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (
      !line ||
      line.startsWith("#")
    ) {
      continue;
    }

    const equals = line.indexOf("=");

    if (equals < 1) {
      continue;
    }

    const key =
      line.slice(0, equals).trim();

    let value =
      line.slice(equals + 1).trim();

    if (
      (value.startsWith('"') &&
        value.endsWith('"')) ||
      (value.startsWith("'") &&
        value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}

const DEV_VARS = parseDevVars();

const ADMIN_TOKEN =
  DEV_VARS.RELAYHUB_ADMIN_TOKEN || "";

function d1(command) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DATABASE,
      "--local",
      "--json",
      "--command",
      command,
    ],
    {
      encoding: "utf8",
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        `D1 command failed (${result.status})`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const output =
    String(result.stdout || "").trim();

  if (!output) {
    return [];
  }

  let parsed;

  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(
      `Could not parse D1 JSON output:\n${output}`,
    );
  }

  return parsed;
}

function rows(command) {
  const result = d1(command);

  if (!Array.isArray(result)) {
    return [];
  }

  const all = [];

  for (const block of result) {
    if (
      Array.isArray(block?.results)
    ) {
      all.push(...block.results);
    }
  }

  return all;
}

function firstRow(command) {
  return rows(command)[0] || null;
}

function scalar(
  command,
  field = "total",
) {
  const row = firstRow(command);

  if (!row) {
    return null;
  }

  return row[field];
}

async function requestJson(
  path,
  {
    method = "GET",
    auth = true,
    body = undefined,
  } = {},
) {
  const headers = {
    Connection: "close",
  };

  if (auth) {
    if (!ADMIN_TOKEN) {
      throw new Error(
        "RELAYHUB_ADMIN_TOKEN is missing from .dev.vars",
      );
    }

    headers.Authorization =
      `Bearer ${ADMIN_TOKEN}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] =
      "application/json";
  }

  let response;

  try {
    response = await fetch(
      `${BASE_URL}${path}`,
      {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : JSON.stringify(body),
      },
    );
  } catch (error) {
    const cause = error?.cause;

    console.error(
      "\n===== HTTP FETCH FAILURE =====",
    );

    console.error(
      "method:",
      method,
    );

    console.error(
      "path:",
      path,
    );

    console.error(
      "error:",
      error?.message || String(error),
    );

    console.error(
      "cause:",
      cause || null,
    );

    if (cause) {
      console.error(
        "cause.code:",
        cause.code || null,
      );

      console.error(
        "cause.errno:",
        cause.errno || null,
      );

      console.error(
        "cause.syscall:",
        cause.syscall || null,
      );

      console.error(
        "cause.address:",
        cause.address || null,
      );

      console.error(
        "cause.port:",
        cause.port || null,
      );
    }

    throw error;
  }

  let payload = null;

  try {
    payload =
      await response.json();
  } catch {
    payload = null;
  }

  return {
    status: response.status,
    body: payload,
  };
}

async function waitForWorker() {
  for (
    let attempt = 1;
    attempt <= 100;
    attempt += 1
  ) {
    try {
      const response =
        await fetch(BASE_URL, {
          headers: {
            Connection: "close",
          },
        });

      if (response) {
        return;
      }
    } catch {
      // Worker not ready yet.
    }

    await sleep(100);
  }

  throw new Error(
    "Wrangler dev server did not become ready.",
  );
}

function startWorker() {
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--local",
      "--port",
      "8787",
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe",
      ],
      env: process.env,
    },
  );

  child.stdout.on(
    "data",
    (chunk) => {
      process.stderr.write(
        `[wrangler] ${chunk}`,
      );
    },
  );

  child.stderr.on(
    "data",
    (chunk) => {
      process.stderr.write(
        `[wrangler] ${chunk}`,
      );
    },
  );

  return child;
}

function findFixture() {
  return firstRow(`
    SELECT
      r.id AS request_id,

      r.status AS request_status,
      r.request_review_status,
      r.approval_policy_version,
      r.email_verified_at,
      r.terms_accepted_at,

      l.id AS licence_id,
      l.licence_number,
      l.document_id,
      l.document_version,
      l.status AS licence_status,
      l.source_object,
      l.source_sha256,
      l.rendered_licence_body,
      l.rendered_licence_sha256,
      l.rendered_terms_body_sha256,
      l.rendered_licence_unresolved_placeholders,
      l.rendered_licence_at,

      l.generated_pdf_status,
      l.generated_pdf_object_key,
      l.generated_pdf_filename,
      l.generated_pdf_sha256,
      l.generated_pdf_size_bytes,
      l.generated_pdf_content_type,
      l.generated_pdf_created_at,
      l.generated_pdf_error,

      i.id AS issue_event_id,
      i.metadata_json AS issue_metadata_json,
      i.created_at AS issue_created_at,

      d.slug AS document_slug,
      d.title AS document_title

    FROM document_access_request_licence_issue_events i

    INNER JOIN document_licences l
      ON l.id = i.licence_id
     AND l.request_id = i.request_id

    INNER JOIN document_access_requests r
      ON r.id = i.request_id

    INNER JOIN documents d
      ON d.id = l.document_id
     AND d.version = l.document_version

    WHERE
      r.status = 'licence_issued'

      AND r.request_review_status =
        'approved_for_licence_prep'

      AND r.approval_policy_version =
        'U3-Q'

      AND l.status = 'issued'

      AND l.generated_pdf_status =
        'not_generated'

      AND l.generated_pdf_object_key
        IS NULL

      AND l.generated_pdf_filename
        IS NULL

      AND l.generated_pdf_sha256
        IS NULL

      AND l.generated_pdf_size_bytes
        IS NULL

      AND l.generated_pdf_content_type
        IS NULL

      AND l.generated_pdf_created_at
        IS NULL

      AND l.generated_pdf_error
        IS NULL

      AND NOT EXISTS (
        SELECT 1
        FROM document_download_links dl
        WHERE dl.licence_id = l.id
      )

    ORDER BY i.created_at DESC
    LIMIT 1;
  `);
}

function ensureFixtureExists() {
  let fixture = findFixture();

  if (fixture) {
    return fixture;
  }

  console.log(
    "No clean issued U3-S fixture exists; running U3-S validator once.",
  );

  const result = spawnSync(
    process.execPath,
    [
      "scripts/validate-cdas-u3-s.mjs",
    ],
    {
      encoding: "utf8",
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      "Unable to create prerequisite U3-S fixture.",
    );
  }

  fixture = findFixture();

  if (!fixture) {
    throw new Error(
      "U3-S validator completed but no suitable issued licence fixture was found.",
    );
  }

  return fixture;
}

function getIssueEvent(
  issueEventId,
) {
  return firstRow(`
    SELECT *
    FROM document_access_request_licence_issue_events
    WHERE id = ${sqlText(issueEventId)}
    LIMIT 1;
  `);
}

function getLicence(
  licenceId,
) {
  return firstRow(`
    SELECT *
    FROM document_licences
    WHERE id = ${sqlText(licenceId)}
    LIMIT 1;
  `);
}

function getPreparation(
  licenceId,
) {
  return firstRow(`
    SELECT *
    FROM document_licence_pdf_preparation_events
    WHERE licence_id =
      ${sqlText(licenceId)}
    LIMIT 1;
  `);
}

function preparationCount(
  licenceId,
) {
  return Number(
    scalar(`
      SELECT COUNT(*) AS total
      FROM document_licence_pdf_preparation_events
      WHERE licence_id =
        ${sqlText(licenceId)};
    `) || 0,
  );
}

function downloadLinkCount(
  licenceId,
) {
  return Number(
    scalar(`
      SELECT COUNT(*) AS total
      FROM document_download_links
      WHERE licence_id =
        ${sqlText(licenceId)};
    `) || 0,
  );
}

function emailEventCount() {
  return Number(
    scalar(`
      SELECT COUNT(*) AS total
      FROM cdas_email_events;
    `) || 0,
  );
}

function deletePreparation(
  fixture,
) {
  d1(`
    DELETE FROM
      document_licence_pdf_preparation_events
    WHERE licence_id =
        ${sqlText(fixture.licence_id)}
       OR request_id =
        ${sqlText(fixture.request_id)};
  `);
}

function parseIssueMetadata(
  fixture,
) {
  try {
    return JSON.parse(
      fixture.issue_metadata_json || "{}",
    );
  } catch {
    return null;
  }
}

function getUpstreamEvidence(
  fixture,
) {
  const metadata =
    parseIssueMetadata(fixture);

  assert(
    Boolean(metadata),
    "validator can parse U3-S issue metadata",
  );

  const licencePreparation =
    firstRow(`
      SELECT *
      FROM document_access_request_licence_preparation_events
      WHERE id =
        ${sqlText(
          metadata.preparation_event_id,
        )}
      LIMIT 1;
    `);

  const reviewEvent =
    firstRow(`
      SELECT *
      FROM document_access_request_review_events
      WHERE id =
        ${sqlText(
          metadata.review_event_id,
        )}
      LIMIT 1;
    `);

  return {
    metadata,
    licencePreparation,
    reviewEvent,
  };
}

function expectedObjectKey(
  fixture,
) {
  const slug =
    String(
      fixture.document_slug ||
      fixture.document_id ||
      "document",
    )
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  const version =
    String(
      fixture.document_version ||
      "version",
    )
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  const licenceNumber =
    String(
      fixture.licence_number ||
      fixture.licence_id,
    )
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);

  return [
    "docs",
    "generated",
    "cdas",
    slug,
    version,
    `${licenceNumber}.pdf`,
  ].join("/");
}

function safeFilename(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function expectedFilename(
  fixture,
) {
  const title =
    safeFilename(
      fixture.document_title ||
      fixture.document_id ||
      "RelayHub-Document",
    );

  const version =
    safeFilename(
      fixture.document_version ||
      "version",
    );

  const licenceNumber =
    safeFilename(
      fixture.licence_number ||
      fixture.licence_id,
    );

  return `${title}-v${version}-${licenceNumber}.pdf`;
}

function assertLicenceStillUnGenerated(
  licence,
  label,
) {
  assert(
    licence.generated_pdf_status ===
      "not_generated",
    `${label}: generated_pdf_status remains not_generated`,
  );

  assert(
    licence.generated_pdf_object_key === null,
    `${label}: generated PDF object key remains null`,
  );

  assert(
    licence.generated_pdf_filename === null,
    `${label}: generated PDF filename remains null`,
  );

  assert(
    licence.generated_pdf_sha256 === null,
    `${label}: generated PDF SHA-256 remains null`,
  );

  assert(
    licence.generated_pdf_size_bytes === null,
    `${label}: generated PDF size remains null`,
  );

  assert(
    licence.generated_pdf_content_type === null,
    `${label}: generated PDF content type remains null`,
  );

  assert(
    licence.generated_pdf_created_at === null,
    `${label}: generated PDF timestamp remains null`,
  );

  assert(
    licence.generated_pdf_error === null,
    `${label}: generated PDF error remains null`,
  );
}

async function invoke(
  fixture,
  body = {},
) {
  return await requestJson(
    ROUTE,
    {
      method: "POST",
      body: {
        request_id:
          fixture.request_id,

        note:
          "U3-T validator preparation",

        ...body,
      },
    },
  );
}

async function main() {
  section("U3-T VALIDATION");

  const fixture =
    ensureFixtureExists();

  const upstream =
    getUpstreamEvidence(fixture);

  assert(
    upstream.metadata.phase === "U3-S",
    "fixture has authoritative U3-S issue metadata",
  );

  assert(
    upstream.metadata
      .issuance_policy_version ===
      "U3-S",
    "fixture records U3-S issuance policy",
  );

  assert(
    upstream.metadata
      .preparation_policy_version ===
      "U3-R",
    "fixture preserves U3-R preparation policy",
  );

  assert(
    upstream.metadata
      .approval_policy_version ===
      "U3-Q",
    "fixture preserves U3-Q approval policy",
  );

  assert(
    Boolean(
      upstream.licencePreparation,
    ),
    "fixture has U3-R preparation evidence",
  );

  assert(
    Boolean(
      upstream.reviewEvent,
    ),
    "fixture has U3-Q review evidence",
  );

  deletePreparation(fixture);

  const baselineLicence =
    getLicence(fixture.licence_id);

  const baselineDownloadLinks =
    downloadLinkCount(
      fixture.licence_id,
    );

  const baselineEmailEvents =
    emailEventCount();

  assertLicenceStillUnGenerated(
    baselineLicence,
    "baseline",
  );

  assert(
    baselineDownloadLinks === 0,
    "baseline has no download link",
  );

  section("AUTHENTICATION");

  {
    const result =
      await requestJson(
        ROUTE,
        {
          method: "POST",
          auth: false,
          body: {
            request_id:
              fixture.request_id,
          },
        },
      );

    assert(
      result.status === 401,
      "U3-T route requires admin authentication",
    );
  }

  section("METHOD");

  {
    const result =
      await requestJson(
        ROUTE,
        {
          method: "GET",
        },
      );

    assert(
      result.status === 405,
      "U3-T rejects non-POST methods",
    );
  }

  section("REQUEST ID");

  {
    const result =
      await requestJson(
        ROUTE,
        {
          method: "POST",
          body: {},
        },
      );

    assert(
      result.status === 400,
      "U3-T requires an access request ID",
    );
  }

  section("POSITIVE PREPARATION");

  const beforePositiveLicence =
    getLicence(fixture.licence_id);

  const beforePositiveLinks =
    downloadLinkCount(
      fixture.licence_id,
    );

  const beforePositiveEmails =
    emailEventCount();

  const positive =
    await invoke(fixture);

  assert(
    positive.status === 200,
    "eligible U3-S issued licence passes U3-T",
  );

  assert(
    positive.body?.ok === true &&
      positive.body?.prepared === true,
    "U3-T reports successful generated PDF preparation",
  );

  assert(
    positive.body?.already_prepared ===
      false,
    "first U3-T execution creates new preparation evidence",
  );

  assert(
    positive.body?.next_allowed_action ===
      "explicit_pdf_generation",
    "U3-T exposes explicit PDF generation as the next action",
  );

  assert(
    positive.body?.safety
      ?.pdf_preparation_evidence_created ===
      true,
    "U3-T reports preparation evidence creation",
  );

  assert(
    positive.body?.safety
      ?.r2_source_read === false,
    "U3-T does not read the source object from R2",
  );

  assert(
    positive.body?.safety
      ?.r2_generated_object_read === false,
    "U3-T does not read a generated object from R2",
  );

  assert(
    positive.body?.safety
      ?.r2_generated_object_written === false,
    "U3-T does not write a generated object to R2",
  );

  assert(
    positive.body?.safety
      ?.generated_pdf_created === false,
    "U3-T does not generate a PDF",
  );

  assert(
    positive.body?.safety
      ?.licence_generated_pdf_fields_updated ===
      false,
    "U3-T does not mutate licence generated-PDF fields",
  );

  assert(
    positive.body?.safety
      ?.download_link_created === false,
    "U3-T does not create a download link",
  );

  assert(
    positive.body?.safety
      ?.download_link_activated === false,
    "U3-T does not activate a download link",
  );

  assert(
    positive.body?.safety
      ?.email_sent === false,
    "U3-T does not send email",
  );

  assert(
    positive.body?.safety
      ?.download_served === false,
    "U3-T does not serve a download",
  );

  const preparation =
    getPreparation(
      fixture.licence_id,
    );

  assert(
    Boolean(preparation),
    "U3-T persists PDF preparation evidence",
  );

  assert(
    preparation.request_id ===
      fixture.request_id,
    "U3-T binds preparation to exact access request",
  );

  assert(
    preparation.licence_id ===
      fixture.licence_id,
    "U3-T binds preparation to exact issued licence",
  );

  assert(
    preparation.licence_number ===
      fixture.licence_number,
    "U3-T freezes exact licence number",
  );

  assert(
    preparation.document_id ===
      fixture.document_id,
    "U3-T freezes exact document ID",
  );

  assert(
    preparation.document_version ===
      fixture.document_version,
    "U3-T freezes exact document version",
  );

  assert(
    preparation.licence_issue_event_id ===
      fixture.issue_event_id,
    "U3-T binds exact U3-S issue event",
  );

  assert(
    preparation
      .licence_preparation_event_id ===
      upstream.metadata
        .preparation_event_id,
    "U3-T binds exact U3-R preparation event",
  );

  assert(
    preparation.review_event_id ===
      upstream.metadata.review_event_id,
    "U3-T binds exact U3-Q review event",
  );

  assert(
    preparation.source_object ===
      fixture.source_object,
    "U3-T freezes source object",
  );

  assert(
    preparation.source_sha256 ===
      fixture.source_sha256,
    "U3-T freezes source SHA-256",
  );

  assert(
    preparation.rendered_licence_sha256 ===
      fixture.rendered_licence_sha256,
    "U3-T freezes rendered licence SHA-256",
  );

  assert(
    preparation
      .rendered_terms_body_sha256 ===
      fixture.rendered_terms_body_sha256,
    "U3-T freezes rendered terms SHA-256",
  );

  assert(
    preparation
      .planned_generated_pdf_object_key ===
      expectedObjectKey(fixture),
    "U3-T freezes canonical generated PDF object key",
  );

  assert(
    preparation
      .planned_generated_pdf_filename ===
      expectedFilename(fixture),
    "U3-T freezes canonical generated PDF filename",
  );

  assert(
    preparation
      .planned_generated_pdf_content_type ===
      "application/pdf",
    "U3-T freezes application/pdf content type",
  );

  assert(
    preparation.approval_policy_version ===
      "U3-Q",
    "U3-T preserves U3-Q policy provenance",
  );

  assert(
    preparation
      .licence_preparation_policy_version ===
      "U3-R",
    "U3-T preserves U3-R policy provenance",
  );

  assert(
    preparation
      .licence_issuance_policy_version ===
      "U3-S",
    "U3-T preserves U3-S policy provenance",
  );

  assert(
    preparation
      .pdf_preparation_policy_version ===
      "U3-T",
    "U3-T records its own preparation policy version",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 1,
    "successful U3-T creates exactly one preparation event",
  );

  const afterPositiveLicence =
    getLicence(fixture.licence_id);

  assertLicenceStillUnGenerated(
    afterPositiveLicence,
    "positive U3-T",
  );

  assert(
    JSON.stringify(
      {
        status:
          beforePositiveLicence
            .generated_pdf_status,
        object:
          beforePositiveLicence
            .generated_pdf_object_key,
        filename:
          beforePositiveLicence
            .generated_pdf_filename,
        sha:
          beforePositiveLicence
            .generated_pdf_sha256,
        size:
          beforePositiveLicence
            .generated_pdf_size_bytes,
        type:
          beforePositiveLicence
            .generated_pdf_content_type,
        created:
          beforePositiveLicence
            .generated_pdf_created_at,
        error:
          beforePositiveLicence
            .generated_pdf_error,
      },
    ) ===
      JSON.stringify(
        {
          status:
            afterPositiveLicence
              .generated_pdf_status,
          object:
            afterPositiveLicence
              .generated_pdf_object_key,
          filename:
            afterPositiveLicence
              .generated_pdf_filename,
          sha:
            afterPositiveLicence
              .generated_pdf_sha256,
          size:
            afterPositiveLicence
              .generated_pdf_size_bytes,
          type:
            afterPositiveLicence
              .generated_pdf_content_type,
          created:
            afterPositiveLicence
              .generated_pdf_created_at,
          error:
            afterPositiveLicence
              .generated_pdf_error,
        },
      ),
    "U3-T leaves all generated-PDF licence fields unchanged",
  );

  assert(
    downloadLinkCount(
      fixture.licence_id,
    ) ===
      beforePositiveLinks,
    "U3-T adds no download links",
  );

  assert(
    emailEventCount() ===
      beforePositiveEmails,
    "U3-T adds no email events",
  );

  section("IDEMPOTENT REPLAY");

  const replay =
    await invoke(fixture);

  assert(
    replay.status === 200,
    "completed U3-T preparation may be replayed safely",
  );

  assert(
    replay.body?.already_prepared ===
      true,
    "U3-T replay is idempotent",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 1,
    "U3-T replay creates no duplicate preparation evidence",
  );

  assertLicenceStillUnGenerated(
    getLicence(fixture.licence_id),
    "U3-T replay",
  );

  section("PREPARATION EVIDENCE CONFLICT");

  const originalPreparedHash =
    preparation.rendered_licence_sha256;

  d1(`
    UPDATE
      document_licence_pdf_preparation_events
    SET
      rendered_licence_sha256 =
        ${sqlText("f".repeat(64))}
    WHERE licence_id =
      ${sqlText(fixture.licence_id)};
  `);

  const conflict =
    await invoke(fixture);

  assert(
    conflict.status === 409,
    "U3-T rejects conflicting existing preparation evidence",
  );

  assert(
    conflict.body?.error ===
      "generated_pdf_preparation_evidence_conflict",
    "U3-T identifies preparation evidence conflict",
  );

  d1(`
    UPDATE
      document_licence_pdf_preparation_events
    SET
      rendered_licence_sha256 =
        ${sqlText(originalPreparedHash)}
    WHERE licence_id =
      ${sqlText(fixture.licence_id)};
  `);

  assertLicenceStillUnGenerated(
    getLicence(fixture.licence_id),
    "preparation conflict",
  );

  section("LICENCE SOURCE HASH DRIFT");

  deletePreparation(fixture);

  const originalSourceHash =
    fixture.source_sha256;

  d1(`
    UPDATE document_licences
    SET source_sha256 =
      ${sqlText("c".repeat(64))}
    WHERE id =
      ${sqlText(fixture.licence_id)};
  `);

  const sourceDrift =
    await invoke(fixture);

  assert(
    sourceDrift.status === 409,
    "U3-T fails closed when licence source hash drifts",
  );

  assert(
    Array.isArray(
      sourceDrift.body?.blockers,
    ) &&
      sourceDrift.body.blockers.some(
        (value) =>
          String(value).includes(
            "source",
          ),
      ),
    "U3-T reports source provenance drift",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "source drift creates no U3-T preparation evidence",
  );

  d1(`
    UPDATE document_licences
    SET source_sha256 =
      ${sqlText(originalSourceHash)}
    WHERE id =
      ${sqlText(fixture.licence_id)};
  `);

  section("RENDERED TERMS HASH DRIFT");

  const originalTermsHash =
    fixture.rendered_terms_body_sha256;

  d1(`
    UPDATE document_licences
    SET rendered_terms_body_sha256 =
      ${sqlText("d".repeat(64))}
    WHERE id =
      ${sqlText(fixture.licence_id)};
  `);

  const termsDrift =
    await invoke(fixture);

  assert(
    termsDrift.status === 409,
    "U3-T fails closed when rendered terms evidence drifts",
  );

  assert(
    termsDrift.body?.blockers?.includes(
      "rendered_terms_hash_differs_from_u3_r",
    ),
    "U3-T identifies rendered terms provenance drift",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "terms drift creates no preparation evidence",
  );

  d1(`
    UPDATE document_licences
    SET rendered_terms_body_sha256 =
      ${sqlText(originalTermsHash)}
    WHERE id =
      ${sqlText(fixture.licence_id)};
  `);

  section("GENERATED PDF STATE NOT PRISTINE");

  d1(`
    UPDATE document_licences
    SET generated_pdf_status = 'pending'
    WHERE id =
      ${sqlText(fixture.licence_id)};
  `);

  const nonPristine =
    await invoke(fixture);

  assert(
    nonPristine.status === 409,
    "U3-T rejects non-pristine generated PDF state",
  );

  assert(
    nonPristine.body?.blockers?.includes(
      "generated_pdf_status_pending",
    ),
    "U3-T reports non-pristine generated PDF status",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "non-pristine PDF state creates no preparation evidence",
  );

  d1(`
    UPDATE document_licences
    SET generated_pdf_status =
      'not_generated'
    WHERE id =
      ${sqlText(fixture.licence_id)};
  `);

  section("LICENCE-TO-PDF ELIGIBILITY BLOCK");

  const originalVerifiedAt =
    fixture.email_verified_at;

  d1(`
    UPDATE document_access_requests
    SET email_verified_at = NULL
    WHERE id =
      ${sqlText(fixture.request_id)};
  `);

  const eligibilityBlocked =
    await invoke(fixture);

  assert(
    eligibilityBlocked.status === 409,
    "U3-T fails closed when licence-to-PDF eligibility fails",
  );

  assert(
    eligibilityBlocked.body
      ?.blockers?.includes(
        "licence_to_pdf_eligibility_blocked",
      ),
    "U3-T records licence-to-PDF gate failure",
  );

  assert(
    eligibilityBlocked.body
      ?.licence_to_pdf_blockers
      ?.includes(
        "request_email_not_verified",
      ),
    "U3-T exposes underlying email-verification blocker",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "eligibility failure creates no preparation evidence",
  );

  d1(`
    UPDATE document_access_requests
    SET email_verified_at =
      ${sqlText(originalVerifiedAt)}
    WHERE id =
      ${sqlText(fixture.request_id)};
  `);

  section("INVALID U3-S POLICY PROVENANCE");

  const issueEvent =
    getIssueEvent(
      fixture.issue_event_id,
    );

  const originalMetadata =
    issueEvent.metadata_json;

  const badMetadata =
    JSON.parse(originalMetadata);

  badMetadata.issuance_policy_version =
    "U3-S-INVALID";

  d1(`
    UPDATE
      document_access_request_licence_issue_events
    SET metadata_json =
      ${sqlText(
        JSON.stringify(badMetadata),
      )}
    WHERE id =
      ${sqlText(fixture.issue_event_id)};
  `);

  const invalidU3S =
    await invoke(fixture);

  assert(
    invalidU3S.status === 409,
    "U3-T blocks invalid U3-S issuance provenance",
  );

  assert(
    invalidU3S.body
      ?.blockers?.includes(
        "u3_s_issuance_policy_version_invalid",
      ),
    "U3-T identifies invalid U3-S policy version",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "invalid U3-S provenance creates no preparation evidence",
  );

  d1(`
    UPDATE
      document_access_request_licence_issue_events
    SET metadata_json =
      ${sqlText(originalMetadata)}
    WHERE id =
      ${sqlText(fixture.issue_event_id)};
  `);

  section("MISSING U3-R PREPARATION EVIDENCE");

  const missingPrepMetadata =
    JSON.parse(originalMetadata);

  missingPrepMetadata.preparation_event_id =
    "u3t_missing_preparation_event";

  d1(`
    UPDATE
      document_access_request_licence_issue_events
    SET metadata_json =
      ${sqlText(
        JSON.stringify(
          missingPrepMetadata,
        ),
      )}
    WHERE id =
      ${sqlText(fixture.issue_event_id)};
  `);

  const missingU3R =
    await invoke(fixture);

  assert(
    missingU3R.status === 409,
    "U3-T blocks missing U3-R preparation evidence",
  );

  assert(
    missingU3R.body
      ?.blockers?.includes(
        "u3_r_preparation_event_missing",
      ),
    "U3-T identifies missing U3-R preparation evidence",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "missing U3-R evidence creates no U3-T preparation",
  );

  d1(`
    UPDATE
      document_access_request_licence_issue_events
    SET metadata_json =
      ${sqlText(originalMetadata)}
    WHERE id =
      ${sqlText(fixture.issue_event_id)};
  `);

  section("MULTIPLE U3-S ISSUE EVENTS");

  const duplicateIssueId =
    `u3t_duplicate_issue_${Date.now().toString(36)}`;

  d1(`
    INSERT INTO
      document_access_request_licence_issue_events (
        id,
        request_id,
        licence_id,
        licence_number,
        previous_status,
        new_status,
        actor,
        note,
        metadata_json,
        created_at
      )
    VALUES (
      ${sqlText(duplicateIssueId)},
      ${sqlText(fixture.request_id)},
      ${sqlText(fixture.licence_id)},
      ${sqlText(fixture.licence_number)},
      'approved_pending_licence',
      'licence_issued',
      'u3-t-validator',
      'Intentional duplicate issue event for U3-T validation',
      ${sqlText(originalMetadata)},
      strftime(
        '%Y-%m-%dT%H:%M:%fZ',
        'now'
      )
    );
  `);

  const multipleIssues =
    await invoke(fixture);

  assert(
    multipleIssues.status === 409,
    "U3-T blocks ambiguous multiple U3-S issue-event state",
  );

  assert(
    multipleIssues.body
      ?.blockers?.includes(
        "u3_s_issue_event_count_not_one",
      ),
    "U3-T identifies multiple U3-S issue events",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "multiple issue events create no preparation evidence",
  );

  d1(`
    DELETE FROM
      document_access_request_licence_issue_events
    WHERE id =
      ${sqlText(duplicateIssueId)};
  `);

  section("ONE LICENCE PER REQUEST SCHEMA INVARIANT");

  const licenceIndexes =
    rows(`
      PRAGMA index_list(document_licences);
    `);

  const uniqueLicenceIndexes =
    licenceIndexes.filter(
      (index) =>
        Number(index.unique || 0) === 1,
    );

  let requestIdUnique = false;

  for (const index of uniqueLicenceIndexes) {
    const indexName =
      String(index.name || "");

    if (!indexName) {
      continue;
    }

    const columns =
      rows(`
        PRAGMA index_info(
          ${JSON.stringify(indexName)}
        );
      `);

    if (
      columns.length === 1 &&
      columns[0]?.name === "request_id"
    ) {
      requestIdUnique = true;
      break;
    }
  }

  assert(
    requestIdUnique,
    "document_licences schema enforces unique request_id",
  );

  const licenceCountForRequest =
    Number(
      scalar(`
        SELECT COUNT(*) AS total
        FROM document_licences
        WHERE request_id =
          ${sqlText(fixture.request_id)};
      `) || 0,
    );

  assert(
    licenceCountForRequest === 1,
    "fixture has exactly one issued licence for the access request",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 0,
    "licence uniqueness invariant leaves no stray U3-T preparation evidence",
  );

  section("FINAL POSITIVE RE-CHECK");

  const finalPositive =
    await invoke(fixture);

  assert(
    finalPositive.status === 200,
    "U3-T succeeds after negative-state recovery",
  );

  assert(
    finalPositive.body?.prepared === true &&
      finalPositive.body?.already_prepared ===
        false,
    "final clean U3-T execution creates preparation evidence",
  );

  assert(
    preparationCount(
      fixture.licence_id,
    ) === 1,
    "final U3-T state contains exactly one preparation event",
  );

  assertLicenceStillUnGenerated(
    getLicence(fixture.licence_id),
    "final U3-T",
  );

  assert(
    downloadLinkCount(
      fixture.licence_id,
    ) === baselineDownloadLinks,
    "full U3-T validation creates no download links",
  );

  assert(
    emailEventCount() ===
      baselineEmailEvents,
    "full U3-T validation creates no email events",
  );

  section("STATIC R2 / PDF MUTATION BOUNDARY");

  const source = readFileSync(
    "worker/src/upload/admin/gates/cdas-generated-pdf-preparation.js",
    "utf8",
  );

  const prohibited = [
    "RELAYHUB_DOWNLOADS",
    "PDFDocument",
    'from "pdf-lib"',
    "INSERT INTO document_download_links",
    "UPDATE document_licences",
    ".put(",
  ];

  for (const needle of prohibited) {
    assert(
      !source.includes(needle),
      `U3-T gate source contains no prohibited operation: ${needle}`,
    );
  }

  console.log(
    "\n===== U3-T FULL VALIDATION PASSED =====",
  );
}

const worker =
  startWorker();

worker.on(
  "exit",
  (code, signal) => {
    console.error(
      `\n===== WRANGLER CHILD EXITED: code=${code} signal=${signal} =====`,
    );
  },
);

let exitCode = 0;

try {
  await waitForWorker();
  await main();
} catch (error) {
  exitCode = 1;

  console.error(
    error?.stack ||
      error?.message ||
      String(error),
  );
} finally {
  if (
    worker.exitCode === null &&
    worker.signalCode === null
  ) {
    worker.kill("SIGTERM");
  }

  await Promise.race([
    new Promise((resolve) => {
      if (
        worker.exitCode !== null ||
        worker.signalCode !== null
      ) {
        resolve();
        return;
      }

      worker.once(
        "exit",
        resolve,
      );
    }),

    sleep(2000),
  ]);
}

process.exit(exitCode);