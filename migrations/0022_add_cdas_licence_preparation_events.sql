/*
 * CDAS U3-R — Licence Preparation Evidence
 *
 * Records the immutable inputs approved for later explicit licence issuance.
 *
 * This table does NOT represent an issued licence.
 * U3-R MUST NOT:
 * - create document_licences;
 * - allocate a licence number;
 * - create a licence-issue event;
 * - generate a PDF;
 * - create a download link;
 * - send email;
 * - serve a download.
 */

CREATE TABLE IF NOT EXISTS document_access_request_licence_preparation_events (
  id TEXT PRIMARY KEY,

  request_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,

  review_event_id TEXT NOT NULL,

  release_policy_id TEXT,
  licence_terms_id TEXT NOT NULL,
  licence_terms_version TEXT NOT NULL,
  licence_terms_body_sha256 TEXT NOT NULL,

  source_object TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,

  licence_holder_type TEXT NOT NULL,
  licence_holder_name TEXT NOT NULL,
  organisation_name TEXT,
  contact_name TEXT,
  contact_email TEXT,
  licence_holder_email TEXT NOT NULL,
  licence_holder_email_normalised TEXT NOT NULL,
  recipient_category TEXT,

  request_terms_version TEXT NOT NULL,
  terms_accepted_at TEXT NOT NULL,

  approved_at TEXT NOT NULL,
  approved_by TEXT,
  approval_role TEXT,
  approval_policy_version TEXT NOT NULL,

  actor TEXT,
  note TEXT,

  preparation_policy_version TEXT NOT NULL DEFAULT 'U3-R',

  metadata_json TEXT NOT NULL DEFAULT '{}',

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dar_licence_preparation_request_unique
ON document_access_request_licence_preparation_events(request_id);

CREATE INDEX IF NOT EXISTS idx_dar_licence_preparation_document
ON document_access_request_licence_preparation_events(
  document_id,
  document_version
);

CREATE INDEX IF NOT EXISTS idx_dar_licence_preparation_review_event
ON document_access_request_licence_preparation_events(review_event_id);

CREATE INDEX IF NOT EXISTS idx_dar_licence_preparation_created
ON document_access_request_licence_preparation_events(created_at);
