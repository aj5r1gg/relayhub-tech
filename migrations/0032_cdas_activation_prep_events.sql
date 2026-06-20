CREATE TABLE IF NOT EXISTS cdas_activation_prep_events (
  id TEXT PRIMARY KEY,

  document_id TEXT NOT NULL,
  upload_transaction_id TEXT,
  review_event_id TEXT,

  prep_status TEXT NOT NULL CHECK (
    prep_status IN (
      'prepared',
      'blocked'
    )
  ),

  previous_document_status TEXT,
  resulting_document_status TEXT,

  prep_notes TEXT,
  admin_actor TEXT,
  request_id TEXT,

  source_object TEXT,
  source_sha256 TEXT,

  public_visibility_created INTEGER NOT NULL DEFAULT 0,
  document_activated INTEGER NOT NULL DEFAULT 0,
  document_published INTEGER NOT NULL DEFAULT 0,
  document_requestable INTEGER NOT NULL DEFAULT 0,
  generated_pdf_created INTEGER NOT NULL DEFAULT 0,
  licence_created INTEGER NOT NULL DEFAULT 0,
  download_link_created INTEGER NOT NULL DEFAULT 0,
  email_sent INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_prep_events_document_id
  ON cdas_activation_prep_events(document_id);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_prep_events_upload_transaction_id
  ON cdas_activation_prep_events(upload_transaction_id);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_prep_events_review_event_id
  ON cdas_activation_prep_events(review_event_id);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_prep_events_prep_status
  ON cdas_activation_prep_events(prep_status);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_prep_events_created_at
  ON cdas_activation_prep_events(created_at);