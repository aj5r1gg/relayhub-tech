-- RelayHub Website — Controlled Upload Facility
-- Migration 0024: upload_transactions
--
-- Purpose:
--   Create the upload transaction ledger used to track every upload request
--   that reaches application code.
--
-- Safety posture:
--   Additive only.
--   Does not alter existing CDAS document, licence, download-link, or event tables.
--   Does not publish, activate, licence, email, or create download links.

CREATE TABLE IF NOT EXISTS upload_transactions (
  id TEXT PRIMARY KEY,

  upload_domain TEXT NOT NULL
    CHECK (upload_domain IN ('cdas_document', 'private_file')),

  related_record_type TEXT,
  related_record_id TEXT,

  upload_status TEXT NOT NULL DEFAULT 'started'
    CHECK (
      upload_status IN (
        'started',
        'validating',
        'blocked',
        'uploading',
        'r2_written',
        'hash_calculated',
        'd1_record_created',
        'sidecar_written',
        'audit_recorded',
        'completed',
        'completed_with_warning',
        'failed',
        'abandoned',
        'recovery_required',
        'recovered'
      )
    ),

  original_filename TEXT,
  safe_filename TEXT,
  mime_type TEXT,
  file_extension TEXT,

  source_size INTEGER
    CHECK (source_size IS NULL OR source_size >= 0),

  source_sha256 TEXT,

  selected_prefix_id TEXT,
  selected_prefix TEXT,

  intended_object_key TEXT,
  final_object_key TEXT,

  r2_written_at TEXT,
  r2_readback_checked_at TEXT,
  hash_calculated_at TEXT,
  d1_record_created_at TEXT,
  sidecar_written_at TEXT,
  audit_recorded_at TEXT,

  started_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  abandoned_at TEXT,

  recovery_status TEXT NOT NULL DEFAULT 'none'
    CHECK (
      recovery_status IN (
        'none',
        'not_required',
        'required',
        'in_progress',
        'recovered',
        'abandoned',
        'manual_review',
        'unrecoverable'
      )
    ),

  failure_stage TEXT,
  failure_reason TEXT,

  admin_actor TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  request_id TEXT,

  idempotency_key_hash TEXT,
  idempotency_expires_at TEXT,

  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_domain
  ON upload_transactions (upload_domain);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_status
  ON upload_transactions (upload_status);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_recovery_status
  ON upload_transactions (recovery_status);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_related_record
  ON upload_transactions (related_record_type, related_record_id);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_prefix
  ON upload_transactions (selected_prefix_id);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_final_object_key
  ON upload_transactions (final_object_key);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_source_sha256
  ON upload_transactions (source_sha256);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_started_at
  ON upload_transactions (started_at);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_completed_at
  ON upload_transactions (completed_at);

CREATE INDEX IF NOT EXISTS idx_upload_transactions_idempotency_key_hash
  ON upload_transactions (idempotency_key_hash);