ALTER TABLE cdas_email_events
ADD COLUMN retry_of_event_id TEXT;

ALTER TABLE cdas_email_events
ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cdas_email_events
ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cdas_email_events
ADD COLUMN next_retry_after TEXT;

ALTER TABLE cdas_email_events
ADD COLUMN resolved_at TEXT;

ALTER TABLE cdas_email_events
ADD COLUMN resolved_by TEXT;

ALTER TABLE cdas_email_events
ADD COLUMN resolution_note TEXT;

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_retry_of_event_id
ON cdas_email_events(retry_of_event_id);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_retryable
ON cdas_email_events(retryable, status);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_next_retry_after
ON cdas_email_events(next_retry_after);

CREATE INDEX IF NOT EXISTS idx_cdas_email_events_resolved_at
ON cdas_email_events(resolved_at);