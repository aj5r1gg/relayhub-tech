import {
  spawn,
  spawnSync,
} from "node:child_process";

import {
  createHash,
  randomUUID,
} from "node:crypto";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import {
  join,
} from "node:path";

import {
  tmpdir,
} from "node:os";

const BASE_URL =
  process.env.CDAS_VALIDATION_BASE_URL ||
  "http://127.0.0.1:8787";

const DB_NAME =
  process.env.CDAS_VALIDATION_DB ||
  "relayhub_early_access";

const R2_BUCKET =
  process.env.CDAS_VALIDATION_R2_BUCKET ||
  "relayhub-downloads";

const RUN_ID =
  `u3u_${Date.now()}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;

const SLUG =
  `${RUN_ID}-document`;

const TITLE =
  "U3-U End-to-End Validation Document";

const VERSION =
  "1.0";

const LICENCE_TERMS_VERSION =
  "CDAS-LICENCE-v0.1";

const RELEASE_POLICY_ID =
  `${RUN_ID}_release_policy`;

const CLIENT_REQUEST_ID =
  `${RUN_ID}_client_request`;

const REQUESTER_EMAIL =
  `${RUN_ID}@example.invalid`;

const TMP_DIR =
  mkdtempSync(
    join(
      tmpdir(),
      "relayhub-u3u-validation-",
    ),
  );

const SOURCE_FILE =
  join(
    TMP_DIR,
    "source.pdf",
  );

const GENERATED_FILE =
  join(
    TMP_DIR,
    "generated.pdf",
  );

const RESTORE_FILE =
  join(
    TMP_DIR,
    "restore.pdf",
  );

const CORRUPT_FILE =
  join(
    TMP_DIR,
    "corrupt.pdf",
  );

const ROUTES = {
  upload:
    "/api/admin/uploads/cdas-document",

  review:
    "/api/admin/uploads/cdas-document/review",

  activationPrep:
    "/api/admin/uploads/cdas-document/activation-prep",

  activate:
    "/api/admin/uploads/cdas-document/activate",

  requestability:
    "/api/admin/uploads/cdas-document/listing-requestability",

  intake:
    "/api/admin/uploads/cdas-document/access-request",

  accessReview:
    "/api/admin/uploads/cdas-document/access-request/review",

  licencePrep:
    "/api/admin/uploads/cdas-document/access-request/licence-preparation",

  licenceIssue:
    "/api/admin/uploads/cdas-document/access-request/licence-issue",

  pdfPrep:
    "/api/admin/uploads/cdas-document/access-request/generated-pdf-preparation",

  pdfGenerate:
    "/api/admin/uploads/cdas-document/access-request/pdf-generation",
};

const PDF_TEXT = `%PDF-1.4
% RelayHub U3-U validation ${RUN_ID}
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 68 >>
stream
BT
/F1 14 Tf
30 150 Td
(RelayHub U3-U validation source) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Root 1 0 R /Size 6 >>
startxref
0
%%EOF
`;

const PDF_BYTES =
  Buffer.from(
    PDF_TEXT,
    "utf8",
  );

const EXPECTED_SOURCE_SHA256 =
  createHash("sha256")
    .update(PDF_BYTES)
    .digest("hex");

function section(title) {
  console.log(
    `\n===== ${title} =====`,
  );
}

function pass(message) {
  console.log(
    `PASS ${message}`,
  );
}

function assert(
  condition,
  message,
) {
  if (!condition) {
    throw new Error(
      `FAIL: ${message}`,
    );
  }

  pass(message);
}

function equal(
  actual,
  expected,
  message,
) {
  if (actual !== expected) {
    throw new Error(
      [
        `FAIL: ${message}`,
        `expected: ${JSON.stringify(expected)}`,
        `actual:   ${JSON.stringify(actual)}`,
      ].join("\n"),
    );
  }

  pass(message);
}

function sleep(ms) {
  return new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        ms,
      );
    },
  );
}

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

function sha256(bytes) {
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}

function loadDevVars() {
  let content = "";

  try {
    content =
      readFileSync(
        ".dev.vars",
        "utf8",
      );
  } catch {
    return {};
  }

  const vars = {};

  for (
    const raw
    of content.split(/\r?\n/)
  ) {
    const line =
      raw.trim();

    if (
      !line ||
      line.startsWith("#")
    ) {
      continue;
    }

    const index =
      line.indexOf("=");

    if (index < 1) {
      continue;
    }

    const key =
      line
        .slice(0, index)
        .trim();

    let value =
      line
        .slice(index + 1)
        .trim();

    if (
      (
        value.startsWith('"') &&
        value.endsWith('"')
      ) ||
      (
        value.startsWith("'") &&
        value.endsWith("'")
      )
    ) {
      value =
        value.slice(1, -1);
    }

    vars[key] =
      value;
  }

  return vars;
}

const DEV_VARS =
  loadDevVars();

const ADMIN_TOKEN =
  DEV_VARS
    .RELAYHUB_ADMIN_TOKEN ||
  "";

function run(
  command,
  args,
  {
    allowFailure = false,
  } = {},
) {
  const result =
    spawnSync(
      command,
      args,
      {
        encoding:
          "utf8",

        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );

  if (
    !allowFailure &&
    result.status !== 0
  ) {
    throw new Error(
      [
        `${command} failed (${result.status})`,
        result.stdout || "",
        result.stderr || "",
      ].join("\n"),
    );
  }

  return result;
}

function d1Raw(sql) {
  const result =
    run(
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
    );

  const raw =
    String(
      result.stdout || "",
    ).trim();

  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Could not parse D1 JSON:\n${raw}`,
    );
  }
}

function rows(sql) {
  const blocks =
    d1Raw(sql);

  if (
    !Array.isArray(blocks)
  ) {
    return [];
  }

  return blocks.flatMap(
    (block) =>
      Array.isArray(
        block?.results,
      )
        ? block.results
        : [],
  );
}

function first(sql) {
  return (
    rows(sql)[0] ||
    null
  );
}

function scalar(
  sql,
  field = "total",
) {
  const row =
    first(sql);

  return row
    ? row[field]
    : null;
}

function execute(sql) {
  d1Raw(sql);
}

function tableExists(name) {
  return Boolean(
    first(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name =
          ${sqlQuote(name)}
      LIMIT 1;
    `),
  );
}

function activeStoragePrefix() {
  const columns =
    rows(`
      PRAGMA table_info(
        storage_prefixes
      );
    `);

  const names =
    new Set(
      columns.map(
        (row) =>
          row.name,
      ),
    );

  const clauses = [
    "domain = 'cdas_document'",
  ];

  if (
    names.has("is_active")
  ) {
    clauses.push(
      "is_active = 1",
    );
  } else if (
    names.has("active")
  ) {
    clauses.push(
      "active = 1",
    );
  } else if (
    names.has("status")
  ) {
    clauses.push(
      "status = 'active'",
    );
  }

  const order = [];

  if (
    names.has("updated_at")
  ) {
    order.push(
      "updated_at DESC",
    );
  }

  if (
    names.has("created_at")
  ) {
    order.push(
      "created_at DESC",
    );
  }

  const orderSql =
    order.length
      ? `ORDER BY ${order.join(", ")}`
      : "";

  return first(`
    SELECT *
    FROM storage_prefixes
    WHERE ${clauses.join(" AND ")}
    ${orderSql}
    LIMIT 1;
  `);
}

function r2Get(
  key,
  target,
  {
    allowMissing = false,
  } = {},
) {
  if (
    existsSync(target)
  ) {
    rmSync(
      target,
      {
        force: true,
      },
    );
  }

  const result =
    run(
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
        allowFailure:
          allowMissing,
      },
    );

  if (
    result.status !== 0
  ) {
    return false;
  }

  return existsSync(
    target,
  );
}

function r2Put(
  key,
  source,
) {
  run(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${R2_BUCKET}/${key}`,
      "--local",
      "--file",
      source,
      "--content-type",
      "application/pdf",
    ],
  );
}

function r2Delete(
  key,
) {
  if (!key) {
    return;
  }

  run(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "delete",
      `${R2_BUCKET}/${key}`,
      "--local",
    ],
    {
      allowFailure:
        true,
    },
  );
}

async function request(
  path,
  {
    method = "POST",
    auth = true,
    body = undefined,
    form = undefined,
    query = undefined,
  } = {},
) {
  const url =
    new URL(
      `${BASE_URL}${path}`,
    );

  if (query) {
    for (
      const [
        key,
        value,
      ]
      of Object.entries(query)
    ) {
      if (
        value !== undefined &&
        value !== null
      ) {
        url.searchParams.set(
          key,
          String(value),
        );
      }
    }
  }

  const headers = {
    Connection:
      "close",
  };

  if (auth) {
    if (!ADMIN_TOKEN) {
      throw new Error(
        "RELAYHUB_ADMIN_TOKEN missing from .dev.vars",
      );
    }

    headers.Authorization =
      `Bearer ${ADMIN_TOKEN}`;
  }

  let requestBody;

  if (
    form !== undefined
  ) {
    requestBody =
      form;
  } else if (
    body !== undefined
  ) {
    headers[
      "Content-Type"
    ] =
      "application/json";

    requestBody =
      JSON.stringify(body);
  }

  let response;

  try {
    response =
      await fetch(
        url,
        {
          method,
          headers,
          body:
            requestBody,
        },
      );
  } catch (error) {
    console.error(
      "\n===== HTTP FAILURE =====",
    );

    console.error(
      method,
      url.toString(),
    );

    console.error(
      error?.cause ||
      error,
    );

    throw error;
  }

  const raw =
    await response.text();

  let parsed;

  try {
    parsed =
      JSON.parse(raw);
  } catch {
    parsed = {
      raw,
      parse_error:
        true,
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

async function waitForWorker() {
  for (
    let attempt = 0;
    attempt < 100;
    attempt += 1
  ) {
    try {
      const response =
        await fetch(
          BASE_URL,
          {
            headers: {
              Connection:
                "close",
            },
          },
        );

      if (response) {
        return;
      }
    } catch {
      // Keep waiting.
    }

    await sleep(100);
  }

  throw new Error(
    "Wrangler did not become ready.",
  );
}

function startWorker() {
  const child =
    spawn(
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

        env:
          process.env,
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

  child.on(
    "exit",
    (
      code,
      signal,
    ) => {
      console.error(
        `\n===== WRANGLER CHILD EXITED: code=${code} signal=${signal} =====`,
      );
    },
  );

  return child;
}

function uploadForm(
  storagePrefixId,
) {
  const form =
    new FormData();

  form.append(
    "slug",
    SLUG,
  );

  form.append(
    "title",
    TITLE,
  );

  form.append(
    "summary",
    "Disposable U3-U end-to-end validation fixture",
  );

  form.append(
    "description",
    "Disposable U3-U end-to-end validation fixture",
  );

  form.append(
    "version",
    VERSION,
  );

  form.append(
    "classification",
    "controlled",
  );

  form.append(
    "access_class",
    "controlled_verified",
  );

  form.append(
    "licence_terms_version",
    LICENCE_TERMS_VERSION,
  );

  form.append(
    "storage_prefix_id",
    storagePrefixId,
  );

  form.append(
    "client_request_id",
    CLIENT_REQUEST_ID,
  );

  form.append(
    "file",
    new File(
      [
        PDF_BYTES,
      ],
      `${RUN_ID}.pdf`,
      {
        type:
          "application/pdf",
      },
    ),
  );

  return form;
}

function getDocument() {
  return first(`
    SELECT *
    FROM documents
    WHERE slug =
      ${sqlQuote(SLUG)}
    LIMIT 1;
  `);
}

function getRequest(
  documentId,
) {
  return first(`
    SELECT *
    FROM document_access_requests
    WHERE document_id =
        ${sqlQuote(documentId)}
      AND email_normalised =
        ${sqlQuote(
          REQUESTER_EMAIL
            .toLowerCase(),
        )}
    ORDER BY requested_at DESC
    LIMIT 1;
  `);
}

function getLicence(
  requestId,
) {
  return first(`
    SELECT *
    FROM document_licences
    WHERE request_id =
      ${sqlQuote(requestId)}
    LIMIT 1;
  `);
}

function getPdfPreparation(
  requestId,
) {
  return first(`
    SELECT *
    FROM
      document_licence_pdf_preparation_events
    WHERE request_id =
      ${sqlQuote(requestId)}
    LIMIT 1;
  `);
}

function getPdfGeneration(
  requestId,
) {
  return first(`
    SELECT *
    FROM
      document_licence_pdf_generation_events
    WHERE request_id =
      ${sqlQuote(requestId)}
    LIMIT 1;
  `);
}

function generationCount(
  requestId,
) {
  return Number(
    scalar(`
      SELECT COUNT(*) AS total
      FROM
        document_licence_pdf_generation_events
      WHERE request_id =
        ${sqlQuote(requestId)};
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
        ${sqlQuote(licenceId)};
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

function assertPristine(
  licence,
  label,
) {
  equal(
    licence.generated_pdf_status,
    "not_generated",
    `${label}: generated status is not_generated`,
  );

  equal(
    licence.generated_pdf_object_key,
    null,
    `${label}: object key is null`,
  );

  equal(
    licence.generated_pdf_filename,
    null,
    `${label}: filename is null`,
  );

  equal(
    licence.generated_pdf_sha256,
    null,
    `${label}: generated SHA-256 is null`,
  );

  equal(
    licence.generated_pdf_size_bytes,
    null,
    `${label}: generated byte count is null`,
  );

  equal(
    licence.generated_pdf_content_type,
    null,
    `${label}: content type is null`,
  );

  equal(
    licence.generated_pdf_created_at,
    null,
    `${label}: generated timestamp is null`,
  );

  equal(
    licence.generated_pdf_error,
    null,
    `${label}: generated error is null`,
  );
}

function restorePristineLicence(
  licenceId,
) {
  execute(`
    UPDATE document_licences
    SET
      generated_pdf_object_key = NULL,
      generated_pdf_filename = NULL,
      generated_pdf_sha256 = NULL,
      generated_pdf_size_bytes = NULL,
      generated_pdf_content_type = NULL,
      generated_pdf_status =
        'not_generated',
      generated_pdf_created_at = NULL,
      generated_pdf_error = NULL
    WHERE id =
      ${sqlQuote(licenceId)};
  `);
}

function removeGenerationEvent(
  requestId,
) {
  execute(`
    DELETE FROM
      document_licence_pdf_generation_events
    WHERE request_id =
      ${sqlQuote(requestId)};
  `);
}

function createControlledDisclosureReleasePolicy(
  document,
) {
  const now =
    new Date().toISOString();

  execute(`
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
      ${sqlQuote(RELEASE_POLICY_ID)},
      ${sqlQuote(document.id)},
      ${sqlQuote(document.version)},

      'CONTROLLED_DISCLOSURE',
      'active',
      'listed',
      'controlled_disclosure',
      'request_open',

      'lt_cdas_v0_1',
      ${sqlQuote(LICENCE_TERMS_VERSION)},
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

      ${sqlQuote(now)},
      ${sqlQuote(now)}
    );
  `);

  return first(`
    SELECT *
    FROM document_release_policies
    WHERE id =
      ${sqlQuote(RELEASE_POLICY_ID)}
    LIMIT 1;
  `);
}

async function buildRealFixture() {
  section(
    "REAL U3-K → U3-T FIXTURE",
  );

  const prefix =
    activeStoragePrefix();

  assert(
    Boolean(prefix),
    "active CDAS storage prefix exists",
  );

  equal(
    prefix.domain,
    "cdas_document",
    "storage prefix belongs to CDAS document domain",
  );

  section("U3-K REAL UPLOAD");

  const upload =
    await request(
      ROUTES.upload,
      {
        method:
          "POST",

        query: {
          mode:
            "real-write",
        },

        form:
          uploadForm(
            prefix.id,
          ),
      },
    );

  if (
    upload.status !== 201
  ) {
    console.error(
      JSON.stringify(
        upload.body,
        null,
        2,
      ),
    );
  }

  equal(
    upload.status,
    201,
    "U3-K real-write succeeds",
  );

  assert(
    upload.body
      ?.accepted === true,
    "U3-K accepts real upload",
  );

  const document =
    getDocument();

  assert(
    Boolean(document),
    "U3-K persists document row",
  );

  equal(
    document.status,
    "draft",
    "U3-K leaves document draft",
  );

  equal(
    document.source_sha256,
    EXPECTED_SOURCE_SHA256,
    "U3-K persists exact source SHA-256",
  );

  assert(
    Boolean(
      document.source_object,
    ),
    "U3-K persists source object key",
  );

  const uploadedSource =
    join(
      TMP_DIR,
      "uploaded-source.pdf",
    );

  assert(
    r2Get(
      document.source_object,
      uploadedSource,
      {
        allowMissing:
          true,
      },
    ),
    "U3-K source object exists in local R2",
  );

  equal(
    sha256(
      readFileSync(
        uploadedSource,
      ),
    ),
    EXPECTED_SOURCE_SHA256,
    "U3-K R2 source bytes match expected SHA-256",
  );

  section("U3-L DRAFT REVIEW");

  const review =
    await request(
      ROUTES.review,
      {
        body: {
          document_id:
            document.id,

          action:
            "approve_for_activation_prep",

          review_notes:
            "U3-U end-to-end validator approval",
        },
      },
    );

  equal(
    review.status,
    200,
    "U3-L approves document for activation preparation",
  );

  section("U3-M ACTIVATION PREPARATION");

  const activationPrep =
    await request(
      ROUTES.activationPrep,
      {
        body: {
          document_id:
            document.id,

          prep_notes:
            "U3-U end-to-end validator activation preparation",
        },
      },
    );

  equal(
    activationPrep.status,
    200,
    "U3-M prepares document activation",
  );

  section("U3-N EXPLICIT ACTIVATION");

  const activation =
    await request(
      ROUTES.activate,
      {
        body: {
          document_id:
            document.id,

          activation_notes:
            "U3-U end-to-end validator activation",
        },
      },
    );

  equal(
    activation.status,
    200,
    "U3-N explicitly activates document",
  );

  const activatedDocument =
    getDocument();

  equal(
    activatedDocument.status,
    "active",
    "U3-N leaves document active",
  );

  section("U3-O REQUESTABILITY");

  const requestability =
    await request(
      ROUTES.requestability,
      {
        body: {
          document_id:
            document.id,

          action:
            "enable_requestability",

          action_notes:
            "U3-U end-to-end validator requestability",
        },
      },
    );

  equal(
    requestability.status,
    200,
    "U3-O enables controlled requestability",
  );

  const requestableDocument =
    getDocument();

  equal(
    requestableDocument
      .requestability_status,
    "requestable_with_approval",
    "document becomes requestable with approval required",
  );

  section(
    "CONTROLLED DISCLOSURE RELEASE POLICY",
  );

  const releasePolicy =
    createControlledDisclosureReleasePolicy(
      requestableDocument,
    );

  assert(
    Boolean(releasePolicy),
    "validator establishes explicit release-policy prerequisite",
  );

  equal(
    releasePolicy.release_class,
    "CONTROLLED_DISCLOSURE",
    "release policy uses CONTROLLED_DISCLOSURE class",
  );

  equal(
    releasePolicy.policy_status,
    "active",
    "release policy is active",
  );

  equal(
    releasePolicy.access_mode,
    "controlled_disclosure",
    "release policy uses controlled disclosure access mode",
  );

  equal(
    releasePolicy.release_state,
    "request_open",
    "release policy permits request processing",
  );

  equal(
    releasePolicy.licence_terms_version,
    LICENCE_TERMS_VERSION,
    "release policy binds exact licence terms version",
  );

  equal(
    releasePolicy.licence_terms_status,
    "active",
    "release policy licence terms are active",
  );

  equal(
    Number(
      releasePolicy.approval_required,
    ),
    1,
    "release policy requires approval",
  );

  equal(
    Number(
      releasePolicy.public_download_enabled,
    ),
    0,
    "release policy prohibits public download",
  );

  equal(
    Number(
      releasePolicy.personalised_pdf_required,
    ),
    1,
    "release policy requires personalised PDF",
  );

  equal(
    Number(
      releasePolicy.download_id_required,
    ),
    1,
    "release policy requires controlled download identity",
  );

  equal(
    Number(
      releasePolicy.single_use_link_required,
    ),
    1,
    "release policy requires single-use link control",
  );

  equal(
    Number(
      releasePolicy.evidence_bundle_required,
    ),
    1,
    "release policy requires evidence bundle",
  );

  equal(
    Number(
      releasePolicy.source_hash_required,
    ),
    1,
    "release policy requires source hash evidence",
  );

  section("U3-P ACCESS REQUEST");

  const intake =
    await request(
      ROUTES.intake,
      {
        body: {
          document_id:
            document.id,

          requester_name:
            "U3-U Validator",

          requester_email:
            REQUESTER_EMAIL,

          requester_organisation:
            "RelayHub Validation",

          requester_reason:
            "U3-U end-to-end generated PDF validation",

          contact_name:
            "U3-U Validator",

          contact_email:
            REQUESTER_EMAIL,

          role_title:
            "Validation Operator",
        },
      },
    );

  assert(
    intake.status === 200 ||
    intake.status === 201,
    "U3-P accepts controlled access request",
  );

  let accessRequest =
    getRequest(
      document.id,
    );

  assert(
    Boolean(accessRequest),
    "U3-P persists access request",
  );

  execute(`
    UPDATE document_access_requests
    SET
      email_verified_at =
        strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          'now'
        ),

      terms_accepted_at =
        strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          'now'
        ),

      terms_acceptance_ip_hash =
        ${sqlQuote(
          `u3u-${RUN_ID}-ip`,
        )},

      terms_acceptance_user_agent =
        'U3-U validation harness'

    WHERE id =
      ${sqlQuote(
        accessRequest.id,
      )};
  `);

  accessRequest =
    getRequest(
      document.id,
    );

  assert(
    Boolean(
      accessRequest
        .email_verified_at,
    ),
    "validator records email verification prerequisite",
  );

  assert(
    Boolean(
      accessRequest
        .terms_accepted_at,
    ),
    "validator records terms acceptance prerequisite",
  );

  section("U3-Q ACCESS REQUEST APPROVAL");

  const approval =
    await request(
      ROUTES.accessReview,
      {
        body: {
          request_id:
            accessRequest.id,

          action:
            "approve_for_licence_prep",

          reason:
            "U3-U end-to-end validation",

          note:
            "Approved for licence preparation by U3-U validator",
        },
      },
    );

  equal(
    approval.status,
    200,
    "U3-Q approves request for licence preparation",
  );

  accessRequest =
    getRequest(
      document.id,
    );

  equal(
    accessRequest.status,
    "approved_pending_licence",
    "U3-Q stops at approved_pending_licence",
  );

  equal(
    accessRequest
      .request_review_status,
    "approved_for_licence_prep",
    "U3-Q records approved_for_licence_prep",
  );

  section("U3-R LICENCE PREPARATION");

  const licencePrep =
    await request(
      ROUTES.licencePrep,
      {
        body: {
          request_id:
            accessRequest.id,

          note:
            "U3-U validator licence preparation",
        },
      },
    );

  if (
    licencePrep.status !== 200
  ) {
    console.error(
      JSON.stringify(
        licencePrep.body,
        null,
        2,
      ),
    );
  }

  equal(
    licencePrep.status,
    200,
    "U3-R prepares exact licence inputs",
  );

  section("U3-S EXPLICIT LICENCE ISSUANCE");

  const licenceIssue =
    await request(
      ROUTES.licenceIssue,
      {
        body: {
          request_id:
            accessRequest.id,

          note:
            "U3-U validator explicit licence issuance",
        },
      },
    );

  if (
    licenceIssue.status !== 200
  ) {
    console.error(
      JSON.stringify(
        licenceIssue.body,
        null,
        2,
      ),
    );
  }

  equal(
    licenceIssue.status,
    200,
    "U3-S explicitly issues licence",
  );

  const licence =
    getLicence(
      accessRequest.id,
    );

  assert(
    Boolean(licence),
    "U3-S persists issued licence",
  );

  equal(
    licence.status,
    "issued",
    "U3-S licence is issued",
  );

  equal(
    licence.source_sha256,
    EXPECTED_SOURCE_SHA256,
    "issued licence preserves real source SHA-256",
  );

  section("U3-T PDF PREPARATION");

  const pdfPrep =
    await request(
      ROUTES.pdfPrep,
      {
        body: {
          request_id:
            accessRequest.id,

          note:
            "U3-U validator generated PDF preparation",
        },
      },
    );

  if (
    pdfPrep.status !== 200
  ) {
    console.error(
      JSON.stringify(
        pdfPrep.body,
        null,
        2,
      ),
    );
  }

  equal(
    pdfPrep.status,
    200,
    "U3-T prepares generated PDF",
  );

  const preparation =
    getPdfPreparation(
      accessRequest.id,
    );

  assert(
    Boolean(preparation),
    "U3-T persists PDF preparation event",
  );

  equal(
    preparation
      .pdf_preparation_policy_version,
    "U3-T",
    "U3-T preparation records U3-T policy",
  );

  equal(
    preparation.source_sha256,
    EXPECTED_SOURCE_SHA256,
    "U3-T freezes real source SHA-256",
  );

  assertPristine(
    getLicence(
      accessRequest.id,
    ),
    "pre-U3-U",
  );

  return {
    document:
      getDocument(),

    releasePolicy,

    accessRequest:
      getRequest(
        document.id,
      ),

    licence:
      getLicence(
        accessRequest.id,
      ),

    preparation,
  };
}

async function validateU3U(
  fixture,
) {
  const {
    document,
    accessRequest,
    licence,
    preparation,
  } =
    fixture;

  const baselineEmails =
    emailEventCount();

  equal(
    downloadLinkCount(
      licence.id,
    ),
    0,
    "baseline contains no download link",
  );

  equal(
    generationCount(
      accessRequest.id,
    ),
    0,
    "baseline contains no U3-U generation event",
  );

  section("U3-U AUTHENTICATION");

  const unauthenticated =
    await request(
      ROUTES.pdfGenerate,
      {
        auth: false,

        body: {
          request_id:
            accessRequest.id,
        },
      },
    );

  equal(
    unauthenticated.status,
    401,
    "U3-U requires admin authentication",
  );

  section("U3-U METHOD");

  const wrongMethod =
    await request(
      ROUTES.pdfGenerate,
      {
        method:
          "GET",
      },
    );

  equal(
    wrongMethod.status,
    405,
    "U3-U rejects non-POST methods",
  );

  section("U3-U REQUEST ID");

  const missingRequest =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {},
      },
    );

  equal(
    missingRequest.status,
    400,
    "U3-U requires request_id",
  );

  section("U3-U SOURCE EVIDENCE");

  assert(
    r2Get(
      document.source_object,
      SOURCE_FILE,
      {
        allowMissing:
          true,
      },
    ),
    "real source object exists in local R2",
  );

  equal(
    sha256(
      readFileSync(
        SOURCE_FILE,
      ),
    ),
    preparation.source_sha256,
    "real R2 source bytes equal frozen U3-T SHA-256",
  );

  section("U3-U POSITIVE GENERATION");

  const result =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,

          note:
            "U3-U validator explicit PDF generation",
        },
      },
    );

  if (
    result.status !== 200
  ) {
    console.error(
      JSON.stringify(
        result.body,
        null,
        2,
      ),
    );
  }

  equal(
    result.status,
    200,
    "eligible U3-T preparation passes U3-U",
  );

  assert(
    result.body?.ok === true,
    "U3-U response is successful",
  );

  equal(
    result.body
      ?.generated,
    true,
    "U3-U reports generated PDF",
  );

  equal(
    result.body
      ?.already_generated,
    false,
    "first U3-U call is not replay",
  );

  equal(
    result.body
      ?.pdf_preparation_event_id,
    preparation.id,
    "U3-U binds exact U3-T preparation",
  );

  equal(
    result.body
      ?.generated_pdf
      ?.object_key,
    preparation
      .planned_generated_pdf_object_key,
    "U3-U uses exact frozen object key",
  );

  equal(
    result.body
      ?.generated_pdf
      ?.filename,
    preparation
      .planned_generated_pdf_filename,
    "U3-U uses exact frozen filename",
  );

  equal(
    result.body
      ?.safety
      ?.source_r2_read,
    true,
    "U3-U reads source from R2",
  );

  equal(
    result.body
      ?.safety
      ?.source_sha256_verified,
    true,
    "U3-U verifies source SHA-256",
  );

  equal(
    result.body
      ?.safety
      ?.generated_pdf_rendered,
    true,
    "U3-U renders personalised PDF",
  );

  equal(
    result.body
      ?.safety
      ?.generated_pdf_r2_written,
    true,
    "U3-U writes generated PDF to R2",
  );

  equal(
    result.body
      ?.safety
      ?.generated_pdf_r2_verified,
    true,
    "U3-U verifies generated R2 object",
  );

  equal(
    result.body
      ?.safety
      ?.licence_generated_pdf_fields_updated,
    true,
    "U3-U persists generated-PDF licence evidence",
  );

  equal(
    result.body
      ?.safety
      ?.pdf_generation_evidence_created,
    true,
    "U3-U persists generation event",
  );

  equal(
    result.body
      ?.safety
      ?.download_link_created,
    false,
    "U3-U creates no download link",
  );

  equal(
    result.body
      ?.safety
      ?.download_link_activated,
    false,
    "U3-U activates no download link",
  );

  equal(
    result.body
      ?.safety
      ?.email_sent,
    false,
    "U3-U sends no email",
  );

  equal(
    result.body
      ?.safety
      ?.download_served,
    false,
    "U3-U serves no download",
  );

  const generatedLicence =
    getLicence(
      accessRequest.id,
    );

  equal(
    generatedLicence
      .generated_pdf_status,
    "generated",
    "licence generated status becomes generated",
  );

  equal(
    generatedLicence
      .generated_pdf_object_key,
    preparation
      .planned_generated_pdf_object_key,
    "D1 generated key equals U3-T frozen key",
  );

  equal(
    generatedLicence
      .generated_pdf_filename,
    preparation
      .planned_generated_pdf_filename,
    "D1 generated filename equals U3-T frozen filename",
  );

  equal(
    generatedLicence
      .generated_pdf_content_type,
    "application/pdf",
    "D1 generated content type is application/pdf",
  );

  assert(
    Boolean(
      generatedLicence
        .generated_pdf_sha256,
    ),
    "D1 stores generated PDF SHA-256",
  );

  assert(
    Number(
      generatedLicence
        .generated_pdf_size_bytes,
    ) > 0,
    "D1 stores generated PDF byte count",
  );

  assert(
    Boolean(
      generatedLicence
        .generated_pdf_created_at,
    ),
    "D1 stores generated timestamp",
  );

  equal(
    generatedLicence
      .generated_pdf_error,
    null,
    "successful U3-U leaves generated error null",
  );

  assert(
    r2Get(
      generatedLicence
        .generated_pdf_object_key,
      GENERATED_FILE,
    ),
    "generated object exists in local R2",
  );

  const generatedBytes =
    readFileSync(
      GENERATED_FILE,
    );

  equal(
    sha256(
      generatedBytes,
    ),
    generatedLicence
      .generated_pdf_sha256,
    "generated R2 bytes hash equals D1 SHA-256",
  );

  equal(
    generatedBytes.byteLength,
    Number(
      generatedLicence
        .generated_pdf_size_bytes,
    ),
    "generated R2 byte count equals D1",
  );

  const event =
    getPdfGeneration(
      accessRequest.id,
    );

  assert(
    Boolean(event),
    "U3-U persists generation event",
  );

  equal(
    event.request_id,
    accessRequest.id,
    "U3-U event binds exact request",
  );

  equal(
    event.licence_id,
    generatedLicence.id,
    "U3-U event binds exact licence",
  );

  equal(
    event.pdf_preparation_event_id,
    preparation.id,
    "U3-U event binds exact U3-T evidence",
  );

  equal(
    event.review_event_id,
    preparation.review_event_id,
    "U3-U event preserves U3-Q provenance",
  );

  equal(
    event
      .licence_preparation_event_id,
    preparation
      .licence_preparation_event_id,
    "U3-U event preserves U3-R provenance",
  );

  equal(
    event
      .licence_issue_event_id,
    preparation
      .licence_issue_event_id,
    "U3-U event preserves U3-S provenance",
  );

  equal(
    event
      .pdf_generation_policy_version,
    "U3-U",
    "U3-U event records U3-U policy",
  );

  equal(
    event
      .generated_pdf_sha256,
    generatedLicence
      .generated_pdf_sha256,
    "U3-U event freezes generated SHA-256",
  );

  equal(
    generationCount(
      accessRequest.id,
    ),
    1,
    "U3-U creates exactly one generation event",
  );

  equal(
    downloadLinkCount(
      generatedLicence.id,
    ),
    0,
    "U3-U creates no download links",
  );

  equal(
    emailEventCount(),
    baselineEmails,
    "U3-U creates no email events",
  );

  const requestAfter =
    getRequest(
      document.id,
    );

  equal(
    requestAfter.status,
    "licence_issued",
    "U3-U leaves request status licence_issued",
  );

  equal(
    requestAfter
      .request_review_status,
    "approved_for_licence_prep",
    "U3-U preserves U3-Q review state",
  );

  section("U3-U IDEMPOTENT REPLAY");

  const replay =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,

          note:
            "U3-U validator replay",
        },
      },
    );

  equal(
    replay.status,
    200,
    "completed U3-U may be replayed safely",
  );

  equal(
    replay.body
      ?.already_generated,
    true,
    "U3-U replay is explicitly idempotent",
  );

  equal(
    generationCount(
      accessRequest.id,
    ),
    1,
    "replay creates no duplicate generation event",
  );

  const replayFile =
    join(
      TMP_DIR,
      "replay.pdf",
    );

  r2Get(
    generatedLicence
      .generated_pdf_object_key,
    replayFile,
  );

  equal(
    sha256(
      readFileSync(
        replayFile,
      ),
    ),
    generatedLicence
      .generated_pdf_sha256,
    "replay does not overwrite generated R2 object",
  );

  return {
    baselineEmails,
    generatedLicence,
    event,
    generatedBytes:
      Buffer.from(
        generatedBytes,
      ),
  };
}

async function validateRecovery(
  fixture,
  generatedState,
) {
  const {
    accessRequest,
  } =
    fixture;

  const {
    generatedLicence,
    generatedBytes,
  } =
    generatedState;

  const objectKey =
    generatedLicence
      .generated_pdf_object_key;

  section(
    "RECOVERY — ORPHAN R2 OBJECT",
  );

  removeGenerationEvent(
    accessRequest.id,
  );

  restorePristineLicence(
    generatedLicence.id,
  );

  writeFileSync(
    RESTORE_FILE,
    generatedBytes,
  );

  r2Delete(
    objectKey,
  );

  r2Put(
    objectKey,
    RESTORE_FILE,
  );

  const orphan =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,
        },
      },
    );

  equal(
    orphan.status,
    409,
    "orphan R2 object is blocked",
  );

  equal(
    orphan.body?.error,
    "u3_u_recovery_required",
    "orphan R2 object requires recovery",
  );

  equal(
    orphan.body
      ?.recovery_reason,
    "r2_object_exists_without_generation_evidence",
    "orphan R2 recovery reason is explicit",
  );

  r2Delete(
    objectKey,
  );

  section(
    "RECOVERY — PARTIAL D1 STATE",
  );

  execute(`
    UPDATE document_licences
    SET
      generated_pdf_status =
        'pending',

      generated_pdf_error =
        'U3-U validator partial state'

    WHERE id =
      ${sqlQuote(
        generatedLicence.id,
      )};
  `);

  const partial =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,
        },
      },
    );

  equal(
    partial.status,
    409,
    "partial generated D1 state is blocked",
  );

  equal(
    partial.body?.error,
    "u3_u_recovery_required",
    "partial D1 state requires recovery",
  );

  equal(
    partial.body
      ?.recovery_reason,
    "non_pristine_generated_pdf_state",
    "partial-state recovery reason is explicit",
  );

  restorePristineLicence(
    generatedLicence.id,
  );

  section(
    "RECOVERY — REGENERATE CLEAN STATE",
  );

  const regenerated =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,

          note:
            "U3-U validator regeneration after explicit recovery",
        },
      },
    );

  equal(
    regenerated.status,
    200,
    "clean fixture can generate after explicit recovery",
  );

  const restoredLicence =
    getLicence(
      accessRequest.id,
    );

  const restoredEvent =
    getPdfGeneration(
      accessRequest.id,
    );

  assert(
    Boolean(restoredEvent),
    "regenerated state has U3-U event",
  );

  const restoredObject =
    join(
      TMP_DIR,
      "restored-generated.pdf",
    );

  r2Get(
    restoredLicence
      .generated_pdf_object_key,
    restoredObject,
  );

  const restoredBytes =
    readFileSync(
      restoredObject,
    );

  section(
    "RECOVERY — D1 GENERATED / R2 MISSING",
  );

  r2Delete(
    restoredLicence
      .generated_pdf_object_key,
  );

  const missingR2 =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,
        },
      },
    );

  equal(
    missingR2.status,
    409,
    "generated D1 evidence with missing R2 is blocked",
  );

  equal(
    missingR2.body?.error,
    "u3_u_recovery_required",
    "missing generated R2 requires recovery",
  );

  equal(
    missingR2.body
      ?.recovery_reason,
    "generated_r2_object_missing",
    "missing-R2 recovery reason is explicit",
  );

  writeFileSync(
    RESTORE_FILE,
    restoredBytes,
  );

  r2Put(
    restoredLicence
      .generated_pdf_object_key,
    RESTORE_FILE,
  );

  section(
    "RECOVERY — R2 HASH MISMATCH",
  );

  writeFileSync(
    CORRUPT_FILE,
    Buffer.from(
      "%PDF-1.4\n% deliberate U3-U corruption\n%%EOF\n",
      "utf8",
    ),
  );

  r2Delete(
    restoredLicence
      .generated_pdf_object_key,
  );

  r2Put(
    restoredLicence
      .generated_pdf_object_key,
    CORRUPT_FILE,
  );

  const corrupt =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,
        },
      },
    );

  equal(
    corrupt.status,
    409,
    "generated R2 hash mismatch is blocked",
  );

  equal(
    corrupt.body?.error,
    "u3_u_recovery_required",
    "R2 hash mismatch requires recovery",
  );

  equal(
    corrupt.body
      ?.recovery_reason,
    "generated_r2_sha256_mismatch",
    "R2 hash mismatch reason is explicit",
  );

  r2Delete(
    restoredLicence
      .generated_pdf_object_key,
  );

  r2Put(
    restoredLicence
      .generated_pdf_object_key,
    RESTORE_FILE,
  );

  section(
    "RECOVERY — D1 / U3-U EVENT MISMATCH",
  );

  const correctHash =
    restoredLicence
      .generated_pdf_sha256;

  execute(`
    UPDATE document_licences
    SET generated_pdf_sha256 =
      ${sqlQuote(
        "e".repeat(64),
      )}
    WHERE id =
      ${sqlQuote(
        restoredLicence.id,
      )};
  `);

  const mismatch =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,
        },
      },
    );

  equal(
    mismatch.status,
    409,
    "D1/event mismatch is blocked",
  );

  equal(
    mismatch.body?.error,
    "u3_u_recovery_required",
    "D1/event mismatch requires recovery",
  );

  equal(
    mismatch.body
      ?.recovery_reason,
    "generation_event_mismatch",
    "D1/event mismatch reason is explicit",
  );

  execute(`
    UPDATE document_licences
    SET generated_pdf_sha256 =
      ${sqlQuote(
        correctHash,
      )}
    WHERE id =
      ${sqlQuote(
        restoredLicence.id,
      )};
  `);

  section(
    "FINAL RECONCILIATION",
  );

  const finalReplay =
    await request(
      ROUTES.pdfGenerate,
      {
        body: {
          request_id:
            accessRequest.id,
        },
      },
    );

  equal(
    finalReplay.status,
    200,
    "U3-U succeeds after evidence restoration",
  );

  equal(
    finalReplay.body
      ?.already_generated,
    true,
    "final U3-U state is completed replay",
  );

  equal(
    generationCount(
      accessRequest.id,
    ),
    1,
    "final state contains exactly one U3-U event",
  );

  equal(
    downloadLinkCount(
      restoredLicence.id,
    ),
    0,
    "recovery validation creates no download links",
  );

  equal(
    emailEventCount(),
    generatedState
      .baselineEmails,
    "recovery validation creates no email events",
  );
}

function cleanup(
  fixture,
) {
  section("CLEANUP");

  try {
    if (
      fixture
        ?.licence
        ?.generated_pdf_object_key
    ) {
      r2Delete(
        fixture
          .licence
          .generated_pdf_object_key,
      );
    }
  } catch {
    // Best-effort cleanup.
  }

  try {
    if (
      fixture
        ?.preparation
        ?.planned_generated_pdf_object_key
    ) {
      r2Delete(
        fixture
          .preparation
          .planned_generated_pdf_object_key,
      );
    }
  } catch {
    // Best-effort cleanup.
  }

  try {
    if (
      fixture
        ?.document
        ?.source_object
    ) {
      r2Delete(
        fixture
          .document
          .source_object,
      );
    }
  } catch {
    // Best-effort cleanup.
  }

  const requestId =
    fixture
      ?.accessRequest
      ?.id;

  const licenceId =
    fixture
      ?.licence
      ?.id;

  const documentId =
    fixture
      ?.document
      ?.id;

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          document_licence_pdf_generation_events
        WHERE request_id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          document_licence_pdf_preparation_events
        WHERE request_id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          document_access_request_licence_issue_events
        WHERE request_id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (licenceId) {
      execute(`
        DELETE FROM
          document_download_links
        WHERE licence_id =
          ${sqlQuote(licenceId)};
      `);
    }
  } catch {}

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          document_licences
        WHERE request_id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          document_access_request_licence_preparation_events
        WHERE request_id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          document_access_request_review_events
        WHERE request_id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          cdas_controlled_access_request_intake_events
        WHERE request_id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (requestId) {
      execute(`
        DELETE FROM
          document_access_requests
        WHERE id =
          ${sqlQuote(requestId)};
      `);
    }
  } catch {}

  try {
    if (documentId) {
      execute(`
        DELETE FROM
          cdas_listing_requestability_events
        WHERE document_id =
          ${sqlQuote(documentId)};
      `);
    }
  } catch {}

  try {
    if (documentId) {
      execute(`
        DELETE FROM
          cdas_activation_events
        WHERE document_id =
          ${sqlQuote(documentId)};
      `);
    }
  } catch {}

  try {
    if (documentId) {
      execute(`
        DELETE FROM
          cdas_activation_prep_events
        WHERE document_id =
          ${sqlQuote(documentId)};
      `);
    }
  } catch {}

  try {
    if (documentId) {
      execute(`
        DELETE FROM
          cdas_upload_review_events
        WHERE document_id =
          ${sqlQuote(documentId)};
      `);
    }
  } catch {}

  try {
    execute(`
      DELETE FROM document_release_policies
      WHERE id =
        ${sqlQuote(RELEASE_POLICY_ID)};
    `);
  } catch {
    // Best-effort cleanup.
  }

  try {
    execute(`
      DELETE FROM upload_idempotency_keys
      WHERE client_request_id =
        ${sqlQuote(
          CLIENT_REQUEST_ID,
        )};
    `);
  } catch {}

  try {
    execute(`
      DELETE FROM upload_transactions
      WHERE related_record_id =
        ${sqlQuote(SLUG)};
    `);
  } catch {}

  try {
    execute(`
      DELETE FROM documents
      WHERE slug =
        ${sqlQuote(SLUG)};
    `);
  } catch {}

  try {
    rmSync(
      TMP_DIR,
      {
        recursive: true,
        force: true,
      },
    );
  } catch {}

  pass(
    "RUN_ID-scoped validation fixtures removed",
  );
}

async function main() {
  console.log(
    "===== U3-U REAL END-TO-END VALIDATION =====",
  );

  console.log(
    `Run ID: ${RUN_ID}`,
  );

  console.log(
    `Worker: ${BASE_URL}`,
  );

  console.log(
    `Local D1: ${DB_NAME}`,
  );

  console.log(
    `Local R2: ${R2_BUCKET}`,
  );

  section("ENVIRONMENT");

  const requiredTables = [
    "documents",
    "storage_prefixes",
    "cdas_upload_review_events",
    "cdas_activation_prep_events",
    "cdas_activation_events",
    "cdas_listing_requestability_events",
    "document_access_requests",
    "cdas_controlled_access_request_intake_events",
    "document_access_request_review_events",
    "document_access_request_licence_preparation_events",
    "document_licences",
    "document_access_request_licence_issue_events",
    "document_licence_pdf_preparation_events",
    "document_licence_pdf_generation_events",
    "document_download_links",
    "cdas_email_events",
    "document_release_policies",
  ];

  for (
    const table
    of requiredTables
  ) {
    assert(
      tableExists(table),
      `required table exists: ${table}`,
    );
  }

  let fixture = null;

  try {
    fixture =
      await buildRealFixture();

    const generatedState =
      await validateU3U(
        fixture,
      );

    await validateRecovery(
      fixture,
      generatedState,
    );

    section(
      "STATIC DOWNSTREAM BOUNDARY",
    );

    const gateSource =
      readFileSync(
        "worker/src/upload/admin/gates/cdas-explicit-pdf-generation.js",
        "utf8",
      );

    const prohibited = [
      "INSERT INTO document_download_links",
      "sendEmail",
      "RESEND",
      "emailCdasDownloadLink",
      "issueCdasDownloadLink",
    ];

    for (
      const needle
      of prohibited
    ) {
      assert(
        !gateSource.includes(
          needle,
        ),
        `U3-U gate contains no prohibited downstream operation: ${needle}`,
      );
    }

    console.log(
      "\n==============================================",
    );

    console.log(
      "PASS — U3-U REAL END-TO-END VALIDATION",
    );

    console.log(
      "==============================================",
    );

    console.log(
      "PASS — genuine U3-K R2 upload exercised",
    );

    console.log(
      "PASS — real U3-L → U3-T provenance chain exercised",
    );

    console.log(
      "PASS — explicit controlled-disclosure release policy exercised",
    );

    console.log(
      "PASS — real source SHA-256 verified",
    );

    console.log(
      "PASS — real personalised PDF generated",
    );

    console.log(
      "PASS — generated R2 bytes read back and hashed",
    );

    console.log(
      "PASS — D1 generated evidence verified",
    );

    console.log(
      "PASS — U3-U event evidence verified",
    );

    console.log(
      "PASS — idempotent replay verified",
    );

    console.log(
      "PASS — orphan-R2 recovery boundary verified",
    );

    console.log(
      "PASS — partial-D1 recovery boundary verified",
    );

    console.log(
      "PASS — missing-R2 recovery boundary verified",
    );

    console.log(
      "PASS — generated hash mismatch recovery boundary verified",
    );

    console.log(
      "PASS — U3-U/D1 evidence mismatch recovery boundary verified",
    );

    console.log(
      "PASS — no download link created",
    );

    console.log(
      "PASS — no email sent",
    );

    console.log(
      "PASS — U3-V remains outside this validation",
    );
  } finally {
    cleanup(
      fixture,
    );
  }
}

const worker =
  startWorker();

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
    worker.kill(
      "SIGTERM",
    );
  }

  await Promise.race([
    new Promise(
      (resolve) => {
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
      },
    ),

    sleep(2000),
  ]);
}

process.exit(
  exitCode,
);