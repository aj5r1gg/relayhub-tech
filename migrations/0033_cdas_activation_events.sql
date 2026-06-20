CREATE TABLE IF NOT EXISTS cdas_activation_events (
  id TEXT PRIMARY KEY,

  document_id TEXT NOT NULL,
  upload_transaction_id TEXT,
  review_event_id TEXT,
  activation_prep_event_id TEXT,

  activation_status TEXT NOT NULL CHECK (
    activation_status IN (
      'activated',
      'blocked'
    )
  ),

  previous_document_status TEXT,
  resulting_document_status TEXT,

  activation_notes TEXT,
  admin_actor TEXT,
  request_id TEXT,

  source_object TEXT,
  source_sha256 TEXT,

  public_visibility_created INTEGER NOT NULL DEFAULT 0,
  document_activated INTEGER NOT NULL DEFAULT 1,
  document_published INTEGER NOT NULL DEFAULT 0,
  document_requestable INTEGER NOT NULL DEFAULT 0,
  generated_pdf_created INTEGER NOT NULL DEFAULT 0,
  licence_created INTEGER NOT NULL DEFAULT 0,
  download_link_created INTEGER NOT NULL DEFAULT 0,
  email_sent INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_events_document_id
  ON cdas_activation_events(document_id);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_events_upload_transaction_id
  ON cdas_activation_events(upload_transaction_id);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_events_review_event_id
  ON cdas_activation_events(review_event_id);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_events_activation_prep_event_id
  ON cdas_activation_events(activation_prep_event_id);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_events_activation_status
  ON cdas_activation_events(activation_status);

CREATE INDEX IF NOT EXISTS idx_cdas_activation_events_created_at
  ON cdas_activation_events(created_at);