CREATE TABLE IF NOT EXISTS cdas_controlled_access_request_intake_events (
  id TEXT PRIMARY KEY,

  access_request_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  listing_requestability_event_id TEXT,

  requester_name TEXT,
  requester_email TEXT,
  requester_organisation TEXT,
  requester_reason TEXT,

  intake_status TEXT NOT NULL CHECK (
    intake_status IN (
      'received',
      'duplicate_blocked',
      'blocked'
    )
  ),

  document_status TEXT,
  document_is_listed INTEGER,
  document_requestability_status TEXT,
  document_requires_approval INTEGER,

  request_status TEXT NOT NULL DEFAULT 'pending_approval',
  request_review_status TEXT NOT NULL DEFAULT 'pending_review',

  admin_actor TEXT,
  request_id TEXT,

  licence_created INTEGER NOT NULL DEFAULT 0,
  generated_pdf_created INTEGER NOT NULL DEFAULT 0,
  download_link_created INTEGER NOT NULL DEFAULT 0,
  email_sent INTEGER NOT NULL DEFAULT 0,
  access_approved INTEGER NOT NULL DEFAULT 0,
  direct_download_created INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cdas_access_request_intake_events_access_request_id
  ON cdas_controlled_access_request_intake_events(access_request_id);

CREATE INDEX IF NOT EXISTS idx_cdas_access_request_intake_events_document_id
  ON cdas_controlled_access_request_intake_events(document_id);

CREATE INDEX IF NOT EXISTS idx_cdas_access_request_intake_events_listing_event
  ON cdas_controlled_access_request_intake_events(listing_requestability_event_id);

CREATE INDEX IF NOT EXISTS idx_cdas_access_request_intake_events_status
  ON cdas_controlled_access_request_intake_events(intake_status);

CREATE INDEX IF NOT EXISTS idx_cdas_access_request_intake_events_created_at
  ON cdas_controlled_access_request_intake_events(created_at);