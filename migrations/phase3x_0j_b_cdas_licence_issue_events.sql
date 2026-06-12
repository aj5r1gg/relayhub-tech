CREATE UNIQUE INDEX IF NOT EXISTS idx_document_licences_request_id_unique
ON document_licences(request_id)
WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_access_request_licence_issue_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  licence_id TEXT NOT NULL,
  licence_number TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  actor TEXT,
  note TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_dar_licence_issue_events_request_id_created
ON document_access_request_licence_issue_events(request_id, created_at);

CREATE INDEX IF NOT EXISTS idx_dar_licence_issue_events_licence_id_created
ON document_access_request_licence_issue_events(licence_id, created_at);
