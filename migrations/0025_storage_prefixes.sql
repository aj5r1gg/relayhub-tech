-- RelayHub Website — Controlled Upload Facility
-- Migration 0025: storage_prefixes
--
-- Purpose:
--   Create governed storage prefix registry for controlled uploads.
--
-- Safety posture:
--   Additive only.
--   Operators must use approved prefixes instead of arbitrary R2 object keys.
--   Prefixes encode governance domain and must preserve CDAS/private separation.

CREATE TABLE IF NOT EXISTS storage_prefixes (
  id TEXT PRIMARY KEY,

  domain TEXT NOT NULL
    CHECK (domain IN ('cdas_document', 'private_file')),

  label TEXT NOT NULL,

  prefix TEXT NOT NULL UNIQUE,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (
      status IN (
        'draft',
        'active',
        'disabled',
        'deprecated',
        'archived',
        'blocked'
      )
    ),

  description TEXT,

  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  disabled_at TEXT,
  deprecated_at TEXT,
  archived_at TEXT,
  blocked_at TEXT,

  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_storage_prefixes_domain
  ON storage_prefixes (domain);

CREATE INDEX IF NOT EXISTS idx_storage_prefixes_status
  ON storage_prefixes (status);

CREATE INDEX IF NOT EXISTS idx_storage_prefixes_domain_status
  ON storage_prefixes (domain, status);

CREATE INDEX IF NOT EXISTS idx_storage_prefixes_prefix
  ON storage_prefixes (prefix);

CREATE INDEX IF NOT EXISTS idx_storage_prefixes_created_at
  ON storage_prefixes (created_at);