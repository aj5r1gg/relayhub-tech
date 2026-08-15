CREATE TABLE IF NOT EXISTS document_licence_pdf_generation_events (
  id TEXT PRIMARY KEY,

  request_id TEXT NOT NULL,
  licence_id TEXT NOT NULL,
  licence_number TEXT NOT NULL,

  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,

  review_event_id TEXT NOT NULL,
  licence_preparation_event_id TEXT NOT NULL,
  licence_issue_event_id TEXT NOT NULL,
  pdf_preparation_event_id TEXT NOT NULL,

  source_object TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,

  rendered_licence_sha256 TEXT NOT NULL,
  rendered_terms_body_sha256 TEXT NOT NULL,

  generated_pdf_object_key TEXT NOT NULL,
  generated_pdf_filename TEXT NOT NULL,
  generated_pdf_content_type TEXT NOT NULL
    DEFAULT 'application/pdf',

  generated_pdf_sha256 TEXT NOT NULL,
  generated_pdf_size_bytes INTEGER NOT NULL,
  generated_pdf_created_at TEXT NOT NULL,

  approval_policy_version TEXT NOT NULL,
  licence_preparation_policy_version TEXT NOT NULL,
  licence_issuance_policy_version TEXT NOT NULL,
  pdf_preparation_policy_version TEXT NOT NULL,
  pdf_generation_policy_version TEXT NOT NULL
    DEFAULT 'U3-U',

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
    REFERENCES document_access_request_review_events(id),

  FOREIGN KEY (pdf_preparation_event_id)
    REFERENCES document_licence_pdf_preparation_events(id),

  CHECK (generated_pdf_content_type = 'application/pdf'),

  CHECK (generated_pdf_size_bytes > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_document_licence_pdf_generation_request_unique
ON document_licence_pdf_generation_events(request_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_document_licence_pdf_generation_licence_unique
ON document_licence_pdf_generation_events(licence_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_document_licence_pdf_generation_preparation_unique
ON document_licence_pdf_generation_events(pdf_preparation_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_document_licence_pdf_generation_object_key_unique
ON document_licence_pdf_generation_events(generated_pdf_object_key);

CREATE INDEX IF NOT EXISTS
  idx_document_licence_pdf_generation_issue_event
ON document_licence_pdf_generation_events(licence_issue_event_id);

CREATE INDEX IF NOT EXISTS
  idx_document_licence_pdf_generation_document
ON document_licence_pdf_generation_events(
  document_id,
  document_version
);

CREATE INDEX IF NOT EXISTS
  idx_document_licence_pdf_generation_created
ON document_licence_pdf_generation_events(created_at);
