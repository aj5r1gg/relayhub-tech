CREATE TABLE IF NOT EXISTS cdas_upload_review_events (
  id TEXT PRIMARY KEY,

  document_id TEXT NOT NULL,
  upload_transaction_id TEXT,

  review_action TEXT NOT NULL CHECK (
    review_action IN (
      'hold',
      'reject',
      'approve_for_activation_prep'
    )
  ),

  previous_document_status TEXT,
  resulting_document_status TEXT,

  review_notes TEXT,
  admin_actor TEXT,
  request_id TEXT,

  public_visibility_created INTEGER NOT NULL DEFAULT 0,
  licence_created INTEGER NOT NULL DEFAULT 0,
  download_link_created INTEGER NOT NULL DEFAULT 0,
  email_sent INTEGER NOT NULL DEFAULT 0,
  document_activated INTEGER NOT NULL DEFAULT 0,
  generated_pdf_created INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cdas_upload_review_events_document_id
  ON cdas_upload_review_events(document_id);

CREATE INDEX IF NOT EXISTS idx_cdas_upload_review_events_upload_transaction_id
  ON cdas_upload_review_events(upload_transaction_id);

CREATE INDEX IF NOT EXISTS idx_cdas_upload_review_events_action
  ON cdas_upload_review_events(review_action);

CREATE INDEX IF NOT EXISTS idx_cdas_upload_review_events_created_at
  ON cdas_upload_review_events(created_at);