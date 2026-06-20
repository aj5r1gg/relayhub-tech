ALTER TABLE documents
  ADD COLUMN requestability_status TEXT NOT NULL DEFAULT 'not_requestable';

ALTER TABLE documents
  ADD COLUMN listed_at TEXT;

ALTER TABLE documents
  ADD COLUMN requestable_at TEXT;