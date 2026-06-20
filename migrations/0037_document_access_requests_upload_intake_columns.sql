ALTER TABLE document_access_requests
  ADD COLUMN intake_source TEXT NOT NULL DEFAULT 'existing_cdas_flow';

ALTER TABLE document_access_requests
  ADD COLUMN request_review_status TEXT NOT NULL DEFAULT 'pending_review';

ALTER TABLE document_access_requests
  ADD COLUMN requestability_status_at_intake TEXT;

ALTER TABLE document_access_requests
  ADD COLUMN intake_event_id TEXT;