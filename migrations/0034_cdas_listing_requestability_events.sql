CREATE TABLE IF NOT EXISTS cdas_listing_requestability_events (
  id TEXT PRIMARY KEY,

  document_id TEXT NOT NULL,
  activation_event_id TEXT,

  action TEXT NOT NULL CHECK (
    action IN (
      'list_only',
      'enable_requestability',
      'disable_requestability',
      'unlist'
    )
  ),

  previous_document_status TEXT,
  resulting_document_status TEXT,

  previous_is_listed INTEGER,
  resulting_is_listed INTEGER,

  previous_requestability_status TEXT,
  resulting_requestability_status TEXT,

  requires_approval INTEGER NOT NULL DEFAULT 1,

  action_notes TEXT,
  admin_actor TEXT,
  request_id TEXT,

  public_visibility_created INTEGER NOT NULL DEFAULT 0,
  document_requestable INTEGER NOT NULL DEFAULT 0,
  document_downloadable INTEGER NOT NULL DEFAULT 0,
  generated_pdf_created INTEGER NOT NULL DEFAULT 0,
  licence_created INTEGER NOT NULL DEFAULT 0,
  download_link_created INTEGER NOT NULL DEFAULT 0,
  email_sent INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cdas_listing_requestability_events_document_id
  ON cdas_listing_requestability_events(document_id);

CREATE INDEX IF NOT EXISTS idx_cdas_listing_requestability_events_activation_event_id
  ON cdas_listing_requestability_events(activation_event_id);

CREATE INDEX IF NOT EXISTS idx_cdas_listing_requestability_events_action
  ON cdas_listing_requestability_events(action);

CREATE INDEX IF NOT EXISTS idx_cdas_listing_requestability_events_created_at
  ON cdas_listing_requestability_events(created_at);