CREATE TABLE IF NOT EXISTS document_access_invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,

  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,

  invitation_type TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'active',

  recipient_email TEXT,
  recipient_name TEXT,

  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL,
  created_by TEXT,

  expires_at TEXT,
  last_used_at TEXT,

  revoked_at TEXT,
  revoked_by TEXT,
  revocation_reason TEXT,

  superseded_at TEXT,
  superseded_by TEXT,

  notes TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_document_access_invitations_token_hash
ON document_access_invitations(token_hash);

CREATE INDEX IF NOT EXISTS idx_document_access_invitations_document
ON document_access_invitations(document_id, document_version);

CREATE INDEX IF NOT EXISTS idx_document_access_invitations_status
ON document_access_invitations(status);

CREATE INDEX IF NOT EXISTS idx_document_access_invitations_created_at
ON document_access_invitations(created_at);

CREATE INDEX IF NOT EXISTS idx_document_access_invitations_recipient_email
ON document_access_invitations(recipient_email);