CREATE TABLE IF NOT EXISTS cdas_email_events (
  id TEXT PRIMARY KEY,

  related_type TEXT NOT NULL,
  related_id TEXT NOT NULL,

  email_type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,

  provider TEXT,
  provider_message_id TEXT,

  status TEXT NOT NULL,
  error TEXT,
  message TEXT,

  subject TEXT,
  created_at TEXT NOT NULL,

  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_related
ON cdas_email_events(related_type, related_id);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_email_type
ON cdas_email_events(email_type);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_status
ON cdas_email_events(status);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_created_at
ON cdas_email_events(created_at);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_provider_message_id
ON cdas_email_events(provider_message_id);