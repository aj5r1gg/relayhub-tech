-- Migration number: 0016 	 2026-06-11T10:29:51.562Z
CREATE TABLE IF NOT EXISTS document_release_policies (
  id TEXT PRIMARY KEY,

  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL DEFAULT '',

  release_class TEXT NOT NULL DEFAULT 'UNRELEASED',
  policy_status TEXT NOT NULL DEFAULT 'draft',
  public_visibility TEXT NOT NULL DEFAULT 'hidden',
  access_mode TEXT NOT NULL DEFAULT 'not_available',
  release_state TEXT NOT NULL DEFAULT 'draft',

  licence_terms_id TEXT,
  licence_terms_version TEXT,
  licence_terms_status TEXT NOT NULL DEFAULT 'missing',

  request_intake_policy_id TEXT,

  listed_publicly INTEGER NOT NULL DEFAULT 0,
  request_button_enabled INTEGER NOT NULL DEFAULT 0,
  public_download_enabled INTEGER NOT NULL DEFAULT 0,
  public_summary_allowed INTEGER NOT NULL DEFAULT 0,

  approval_required INTEGER NOT NULL DEFAULT 1,
  email_verification_required INTEGER NOT NULL DEFAULT 1,
  manual_review_required INTEGER NOT NULL DEFAULT 1,
  invitation_required INTEGER NOT NULL DEFAULT 0,
  payment_required INTEGER NOT NULL DEFAULT 0,

  watermark_required INTEGER NOT NULL DEFAULT 1,
  personalised_pdf_required INTEGER NOT NULL DEFAULT 1,
  download_id_required INTEGER NOT NULL DEFAULT 1,
  single_use_link_required INTEGER NOT NULL DEFAULT 1,
  evidence_bundle_required INTEGER NOT NULL DEFAULT 1,

  redistribution_allowed INTEGER NOT NULL DEFAULT 0,
  commercial_use_allowed INTEGER NOT NULL DEFAULT 0,
  derivative_use_allowed INTEGER NOT NULL DEFAULT 0,
  training_ai_allowed INTEGER NOT NULL DEFAULT 0,
  public_quoting_allowed INTEGER NOT NULL DEFAULT 0,

  abuse_screening_required INTEGER NOT NULL DEFAULT 1,
  disposable_email_block_required INTEGER NOT NULL DEFAULT 1,
  business_context_required INTEGER NOT NULL DEFAULT 1,
  source_hash_required INTEGER NOT NULL DEFAULT 1,

  public_label TEXT NOT NULL DEFAULT 'Not available',
  public_action_label TEXT NOT NULL DEFAULT 'Not available',
  public_message TEXT NOT NULL DEFAULT 'This document is not currently available.',
  admin_note TEXT,

  effective_from TEXT,
  effective_until TEXT,
  supersedes_policy_id TEXT,

  approved_by TEXT,
  approved_at TEXT,
  approval_note TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT,
  updated_by TEXT,

  CHECK (policy_status IN (
    'draft',
    'pending_review',
    'approved',
    'active',
    'suspended',
    'superseded',
    'retired'
  )),

  CHECK (release_class IN (
    'PUBLIC_DOCTRINE',
    'PUBLIC_SUMMARY',
    'CONTROLLED_DISCLOSURE',
    'RESTRICTED_DISCLOSURE',
    'PARTNER_ONLY',
    'INTERNAL_ONLY',
    'COMMERCIAL_PAID',
    'UNRELEASED'
  )),

  CHECK (public_visibility IN (
    'hidden',
    'listed',
    'public',
    'private',
    'internal'
  )),

  CHECK (release_state IN (
    'draft',
    'preparing',
    'licence_pending',
    'abuse_gate_pending',
    'request_open',
    'public_released',
    'partner_only',
    'suspended',
    'retired'
  )),

  CHECK (access_mode IN (
    'not_available',
    'public_download',
    'verified_public',
    'licensed_public',
    'controlled_disclosure',
    'restricted_controlled_disclosure',
    'partner_only',
    'invite_only',
    'paid_verified',
    'disabled'
  )),

  UNIQUE (document_id, document_version)
);

CREATE INDEX IF NOT EXISTS idx_document_release_policies_document
  ON document_release_policies (document_id, document_version);

CREATE INDEX IF NOT EXISTS idx_document_release_policies_status
  ON document_release_policies (policy_status, release_state);

CREATE INDEX IF NOT EXISTS idx_document_release_policies_public
  ON document_release_policies (
    listed_publicly,
    public_visibility,
    public_download_enabled,
    request_button_enabled
  );

CREATE INDEX IF NOT EXISTS idx_document_release_policies_access
  ON document_release_policies (
    release_class,
    access_mode,
    approval_required,
    manual_review_required
  );

CREATE INDEX IF NOT EXISTS idx_document_release_policies_licence
  ON document_release_policies (
    licence_terms_id,
    licence_terms_version,
    licence_terms_status
  );

CREATE TABLE IF NOT EXISTS document_release_policy_events (
  id TEXT PRIMARY KEY,

  release_policy_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL DEFAULT '',

  event_type TEXT NOT NULL,
  previous_state TEXT,
  new_state TEXT,

  reason TEXT,
  actor TEXT,
  metadata_json TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CHECK (event_type IN (
    'created',
    'updated',
    'submitted_for_review',
    'approved',
    'activated',
    'suspended',
    'superseded',
    'retired',
    'request_enabled',
    'request_disabled',
    'public_download_enabled',
    'public_download_disabled',
    'licence_terms_assigned',
    'licence_terms_changed',
    'abuse_policy_changed',
    'emergency_lockdown'
  ))
);

CREATE INDEX IF NOT EXISTS idx_document_release_policy_events_policy
  ON document_release_policy_events (release_policy_id, created_at);

CREATE INDEX IF NOT EXISTS idx_document_release_policy_events_document
  ON document_release_policy_events (document_id, document_version, created_at);

CREATE INDEX IF NOT EXISTS idx_document_release_policy_events_type
  ON document_release_policy_events (event_type, created_at);