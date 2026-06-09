PRAGMA foreign_keys = off;

CREATE TABLE document_download_events_new (
  id TEXT PRIMARY KEY,
  download_id TEXT NOT NULL,
  licence_id TEXT NOT NULL,
  licence_number TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,
  licence_holder_name TEXT,
  organisation_name TEXT,
  licence_holder_email TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  generated_object TEXT,
  source_object TEXT,
  source_sha256 TEXT,
  generated_sha256 TEXT,
  template_sha256 TEXT,
  licence_page_template_version TEXT,
  watermark_template_version TEXT,
  footer_template_version TEXT,
  terms_template_version TEXT,
  generation_engine_version TEXT,
  terms_version TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 1,
  failure_reason TEXT
);

INSERT INTO document_download_events_new (
  id,
  download_id,
  licence_id,
  licence_number,
  document_id,
  document_version,
  licence_holder_name,
  organisation_name,
  licence_holder_email,
  event_type,
  event_at,
  ip_hash,
  user_agent,
  generated_object,
  source_object,
  source_sha256,
  generated_sha256,
  template_sha256,
  licence_page_template_version,
  watermark_template_version,
  footer_template_version,
  terms_template_version,
  generation_engine_version,
  terms_version,
  success,
  failure_reason
)
SELECT
  id,
  download_id,
  licence_id,
  licence_number,
  document_id,
  document_version,
  licence_holder_name,
  organisation_name,
  licence_holder_email,
  event_type,
  event_at,
  ip_hash,
  user_agent,
  generated_object,
  source_object,
  source_sha256,
  generated_sha256,
  template_sha256,
  licence_page_template_version,
  watermark_template_version,
  footer_template_version,
  terms_template_version,
  generation_engine_version,
  terms_version,
  success,
  failure_reason
FROM document_download_events;

DROP TABLE document_download_events;

ALTER TABLE document_download_events_new RENAME TO document_download_events;

CREATE INDEX IF NOT EXISTS idx_document_download_events_download_id
  ON document_download_events (download_id);

CREATE INDEX IF NOT EXISTS idx_document_download_events_licence_id
  ON document_download_events (licence_id);

CREATE INDEX IF NOT EXISTS idx_document_download_events_event_type
  ON document_download_events (event_type);

CREATE INDEX IF NOT EXISTS idx_document_download_events_event_at
  ON document_download_events (event_at);

CREATE INDEX IF NOT EXISTS idx_document_download_events_document_id
  ON document_download_events (document_id);

PRAGMA foreign_keys = on;