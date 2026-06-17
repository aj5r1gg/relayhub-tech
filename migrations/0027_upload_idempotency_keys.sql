-- RelayHub Website — Controlled Upload Facility
-- Migration 0027: upload_idempotency_keys
--
-- Purpose:
--   Create idempotency-key tracking for controlled uploads.
--
-- Safety posture:
--   Additive only.
--   Stores only hashed idempotency keys, never raw browser/client keys.
--   Does not upload files.
--   Does not write R2.
--   Does not publish, licence, email, create links, or alter existing CDAS records.

CREATE TABLE IF NOT EXISTS upload_idempotency_keys (
  id TEXT PRIMARY KEY,

  idempotency_key_hash TEXT NOT NULL UNIQUE,

  upload_transaction_id TEXT NOT NULL,

  upload_domain TEXT NOT NULL
    CHECK (upload_domain IN ('cdas_document', 'private_file')),

  status TEXT NOT NULL
    CHECK (
      status IN (
        'started',
        'in_progress',
        'completed',
        'completed_with_warning',
        'failed_before_r2',
        'failed_after_r2',
        'recovery_required',
        'expired',
        'abandoned'
      )
    ),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,

  replay_count INTEGER NOT NULL DEFAULT 0
    CHECK (replay_count >= 0),

  last_replayed_at TEXT,

  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_upload_idempotency_keys_hash
  ON upload_idempotency_keys (idempotency_key_hash);

CREATE INDEX IF NOT EXISTS idx_upload_idempotency_keys_transaction
  ON upload_idempotency_keys (upload_transaction_id);

CREATE INDEX IF NOT EXISTS idx_upload_idempotency_keys_domain
  ON upload_idempotency_keys (upload_domain);

CREATE INDEX IF NOT EXISTS idx_upload_idempotency_keys_status
  ON upload_idempotency_keys (status);

CREATE INDEX IF NOT EXISTS idx_upload_idempotency_keys_expires_at
  ON upload_idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS idx_upload_idempotency_keys_created_at
  ON upload_idempotency_keys (created_at);
