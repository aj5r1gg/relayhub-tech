CREATE TABLE document_licence_pdf_preparation_events (
  id TEXT PRIMARY KEY,

  request_id TEXT NOT NULL,
  licence_id TEXT NOT NULL,
  licence_number TEXT NOT NULL,

  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,

  review_event_id TEXT NOT NULL,
  licence_preparation_event_id TEXT NOT NULL,
  licence_issue_event_id TEXT NOT NULL,

  source_object TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,

  rendered_licence_sha256 TEXT NOT NULL,
  rendered_terms_body_sha256 TEXT NOT NULL,

  planned_generated_pdf_object_key TEXT NOT NULL,
  planned_generated_pdf_filename TEXT NOT NULL,
  planned_generated_pdf_content_type TEXT NOT NULL
    DEFAULT 'application/pdf',

  approval_policy_version TEXT NOT NULL,
  licence_preparation_policy_version TEXT NOT NULL,
  licence_issuance_policy_version TEXT NOT NULL,
  pdf_preparation_policy_version TEXT NOT NULL
    DEFAULT 'U3-T',

  actor TEXT,
  note TEXT,

  metadata_json TEXT NOT NULL DEFAULT '{}',

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),

  FOREIGN KEY (request_id)
    REFERENCES document_access_requests(id),

  FOREIGN KEY (licence_id)
    REFERENCES document_licences(id),

  FOREIGN KEY (licence_issue_event_id)
    REFERENCES document_access_request_licence_issue_events(id),

  FOREIGN KEY (licence_preparation_event_id)
    REFERENCES document_access_request_licence_preparation_events(id),

  FOREIGN KEY (review_event_id)
    REFERENCES document_access_request_review_events(id)
);

CREATE UNIQUE INDEX
  idx_document_licence_pdf_preparation_licence_unique
ON document_licence_pdf_preparation_events(licence_id);

CREATE UNIQUE INDEX
  idx_document_licence_pdf_preparation_request_unique
ON document_licence_pdf_preparation_events(request_id);

CREATE INDEX
  idx_document_licence_pdf_preparation_issue_event
ON document_licence_pdf_preparation_events(
  licence_issue_event_id
);

CREATE INDEX
  idx_document_licence_pdf_preparation_document
ON document_licence_pdf_preparation_events(
  document_id,
  document_version
);

CREATE INDEX
  idx_document_licence_pdf_preparation_created
ON document_licence_pdf_preparation_events(created_at);