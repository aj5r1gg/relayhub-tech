ALTER TABLE document_access_requests
ADD COLUMN invitation_id TEXT;

ALTER TABLE document_access_requests
ADD COLUMN invitation_used_at TEXT;

CREATE INDEX IF NOT EXISTS idx_document_access_requests_invitation_id
ON document_access_requests(invitation_id);