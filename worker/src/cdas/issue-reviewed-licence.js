import { jsonResponse } from "../shared.js";
import { evaluateCdasReviewToLicenceEligibility } from "./review-to-licence-gate.js";

function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(bytes = 8) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function makeLicenceId() {
  return `lic_${Date.now().toString(36)}_${randomToken(8)}`;
}

function makeLicenceNumber(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");

  return `RH-CDAS-${y}${m}${d}-${randomToken(4).toUpperCase()}`;
}

function makeIssueEventId() {
  return `dar_lic_issue_${Date.now().toString(36)}_${randomToken(8)}`;
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function getCreatedLicence(env, licenceId) {
  return await env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM document_licences
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(licenceId)
    .first();
}

async function insertLicenceIssueEvent(env, {
  requestId,
  licenceId,
  licenceNumber,
  previousStatus,
  newStatus,
  actor,
  note,
  metadata,
}) {
  await env.RELAYHUB_DB.prepare(
    `INSERT INTO document_access_request_licence_issue_events (
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      makeIssueEventId(),
      requestId,
      licenceId,
      licenceNumber,
      previousStatus || null,
      newStatus || null,
      actor || null,
      note || null,
      JSON.stringify(metadata || {}),
      nowIso(),
    )
    .run();
}

export async function issueCdasReviewedRequestLicence(request, env, requestId) {
  if (request.method !== "POST") {
    return jsonResponse(
      {
        ok: false,
        error: "method_not_allowed",
        message: "Use POST to issue a licence from a reviewed request.",
      },
      405,
    );
  }

  const id = cleanText(requestId);

  if (!id) {
    return jsonResponse(
      {
        ok: false,
        error: "missing_request_id",
        message: "Access request ID is required.",
      },
      400,
    );
  }

  const body = await readJsonBody(request);
  const actor = cleanText(body.actor) || "admin";
  const note = cleanText(body.note || body.reason);

  const eligibility = await evaluateCdasReviewToLicenceEligibility(env, id);

  if (!eligibility.ok || !eligibility.request) {
    return jsonResponse(
      {
        ok: false,
        error: "access_request_not_found",
        message: "CDAS access request was not found.",
        request_id: id,
        safety: {
          licence_created: false,
          generated_pdf_created: false,
          download_link_created: false,
          email_sent: false,
        },
      },
      404,
    );
  }

  if (!eligibility.eligible) {
    return jsonResponse(
      {
        ok: false,
        error: "licence_issue_blocked",
        message: "This access request is not eligible for licence issue.",
        request_id: id,
        decision: eligibility.decision,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        counts: eligibility.counts,
        safety: {
          licence_created: false,
          generated_pdf_created: false,
          download_link_created: false,
          email_sent: false,
        },
      },
      409,
    );
  }

  const accessRequest = eligibility.request;
  const document = eligibility.document;
  const releasePolicy = eligibility.release_policy;

  const issuedAt = nowIso();
  const licenceId = makeLicenceId();
  const licenceNumber = makeLicenceNumber(new Date());

  const licenceHolderType =
    cleanText(accessRequest.licence_holder_type) ||
    (cleanText(accessRequest.organisation_name) ? "organisation" : "individual");

  const licenceHolderName =
    cleanText(accessRequest.organisation_name) ||
    cleanText(accessRequest.name) ||
    cleanText(accessRequest.email);

  const contactName =
    cleanText(accessRequest.contact_name) ||
    cleanText(accessRequest.name) ||
    null;

  const contactEmail =
    cleanText(accessRequest.contact_email) ||
    cleanText(accessRequest.email) ||
    null;

  const licenceTermsVersion =
    cleanText(accessRequest.terms_version) ||
    cleanText(document.licence_terms_version) ||
    cleanText(releasePolicy.licence_terms_version);

  try {
    await env.RELAYHUB_DB.prepare(
      `INSERT INTO document_licences (
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
         notes,
         source_object,
         source_sha256,
         generated_pdf_status
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        licenceId,
        licenceNumber,
        id,
        accessRequest.document_id,
        accessRequest.document_version,
        licenceHolderType,
        licenceHolderName,
        cleanText(accessRequest.organisation_name) || null,
        contactName,
        contactEmail,
        cleanText(accessRequest.email) || null,
        cleanText(accessRequest.email_normalised) || null,
        cleanText(accessRequest.recipient_category) || null,
        licenceTermsVersion || null,
        "issued",
        issuedAt,
        note || null,
        document.source_object,
        document.source_sha256,
        "not_generated",
      )
      .run();

    await env.RELAYHUB_DB.prepare(
      `UPDATE document_access_requests
       SET status = ?,
           approval_note = COALESCE(approval_note, ?)
       WHERE id = ?
         AND status = ?`,
    )
      .bind("licence_issued", note || null, id, "review_approved")
      .run();

    await insertLicenceIssueEvent(env, {
      requestId: id,
      licenceId,
      licenceNumber,
      previousStatus: "review_approved",
      newStatus: "licence_issued",
      actor,
      note,
      metadata: {
        phase: "3X-0J-B",
        release_policy_id: releasePolicy.id,
        document_id: accessRequest.document_id,
        document_version: accessRequest.document_version,
      },
    });

    const licence = await getCreatedLicence(env, licenceId);

    return jsonResponse({
      ok: true,
      action: "issue_licence",
      request_id: id,
      previous_status: "review_approved",
      new_status: "licence_issued",
      licence_id: licenceId,
      licence_number: licenceNumber,
      licence,
      eligibility: {
        decision: eligibility.decision,
        warnings: eligibility.warnings,
      },
      safety: {
        licence_created: true,
        generated_pdf_created: false,
        download_link_created: false,
        email_sent: false,
      },
    });
  } catch (error) {
    const message = error?.message || String(error);

    return jsonResponse(
      {
        ok: false,
        error: "licence_issue_failed",
        message,
        request_id: id,
        safety: {
          licence_created: false,
          generated_pdf_created: false,
          download_link_created: false,
          email_sent: false,
        },
      },
      409,
    );
  }
}
