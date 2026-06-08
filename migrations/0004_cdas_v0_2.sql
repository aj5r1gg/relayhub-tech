-- RelayHub Controlled Document Access System v0.2
-- Migration: 0004_cdas_v0_2.sql
--
-- Purpose:
-- Adds the foundational D1 schema for verified, licensed,
-- auditable RelayHub document access.
--
-- This migration is intentionally additive.
-- It does not remove or modify existing download tables.

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Documents Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,

  title TEXT NOT NULL,
  summary TEXT,
  description TEXT,

  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',

  classification TEXT NOT NULL DEFAULT 'controlled',
  access_class TEXT NOT NULL DEFAULT 'controlled_verified',

  source_object TEXT NOT NULL,
  source_sha256 TEXT,

  generated_prefix TEXT,

  licence_terms_version TEXT NOT NULL,

  is_listed INTEGER NOT NULL DEFAULT 1,
  allow_redownload INTEGER NOT NULL DEFAULT 1,
  max_redownloads INTEGER,

  requires_approval INTEGER NOT NULL DEFAULT 0,

  current_version_of TEXT,
  supersedes_document_id TEXT,
  superseded_by_document_id TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_slug
ON documents(slug);

CREATE INDEX IF NOT EXISTS idx_documents_status
ON documents(status);

CREATE INDEX IF NOT EXISTS idx_documents_classification
ON documents(classification);

CREATE INDEX IF NOT EXISTS idx_documents_access_class
ON documents(access_class);

CREATE INDEX IF NOT EXISTS idx_documents_listed
ON documents(is_listed);


-- ============================================================
-- 2. Licence Terms Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS licence_terms (
  id TEXT PRIMARY KEY,

  version TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT,

  status TEXT NOT NULL DEFAULT 'draft',

  applies_to_access_class TEXT,

  effective_from TEXT,
  effective_to TEXT,

  created_at TEXT NOT NULL,
  retired_at TEXT,

  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_licence_terms_version
ON licence_terms(version);

CREATE INDEX IF NOT EXISTS idx_licence_terms_status
ON licence_terms(status);

CREATE INDEX IF NOT EXISTS idx_licence_terms_access_class
ON licence_terms(applies_to_access_class);


-- ============================================================
-- 3. Document Access Requests
-- ============================================================

CREATE TABLE IF NOT EXISTS document_access_requests (
  id TEXT PRIMARY KEY,

  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,

  name TEXT,
  email TEXT NOT NULL,
  email_normalised TEXT NOT NULL,

  licence_holder_type TEXT NOT NULL DEFAULT 'individual',

  organisation_name TEXT,
  contact_name TEXT,
  contact_email TEXT,
  role_title TEXT,

  recipient_category TEXT NOT NULL DEFAULT 'unknown',

  status TEXT NOT NULL,
  access_class TEXT NOT NULL,

  verification_token_hash TEXT,
  verification_sent_at TEXT,
  email_verified_at TEXT,
  email_delivery_status TEXT,

  requested_at TEXT NOT NULL,
  expires_at TEXT,

  approved_at TEXT,
  approved_by TEXT,
  approval_role TEXT,
  approval_policy_version TEXT,
  approval_note TEXT,

  denied_at TEXT,
  denied_by TEXT,
  denial_reason TEXT,

  terms_version TEXT NOT NULL,
  terms_accepted_at TEXT,
  terms_acceptance_ip_hash TEXT,
  terms_acceptance_user_agent TEXT,

  ip_hash TEXT,
  user_agent TEXT,

  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_flags TEXT,

  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE INDEX IF NOT EXISTS idx_document_access_requests_document
ON document_access_requests(document_id);

CREATE INDEX IF NOT EXISTS idx_document_access_requests_email
ON document_access_requests(email_normalised);

CREATE INDEX IF NOT EXISTS idx_document_access_requests_status
ON document_access_requests(status);

CREATE INDEX IF NOT EXISTS idx_document_access_requests_requested_at
ON document_access_requests(requested_at);

CREATE INDEX IF NOT EXISTS idx_document_access_requests_verified
ON document_access_requests(email_verified_at);

CREATE INDEX IF NOT EXISTS idx_document_access_requests_risk
ON document_access_requests(risk_score);


-- ============================================================
-- 4. Document Licences
-- ============================================================

CREATE TABLE IF NOT EXISTS document_licences (
  id TEXT PRIMARY KEY,

  licence_number TEXT NOT NULL UNIQUE,

  request_id TEXT,

  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,

  licence_holder_type TEXT NOT NULL DEFAULT 'individual',

  licence_holder_name TEXT,
  organisation_name TEXT,
  contact_name TEXT,
  contact_email TEXT,

  licence_holder_email TEXT NOT NULL,
  licence_holder_email_normalised TEXT NOT NULL,

  recipient_category TEXT NOT NULL DEFAULT 'unknown',

  licence_terms_version TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'active',

  issued_at TEXT NOT NULL,
  expires_at TEXT,

  revoked_at TEXT,
  revoked_by TEXT,
  revocation_reason TEXT,

  superseded_by TEXT,
  corrected_from TEXT,

  suspected_leak_at TEXT,
  confirmed_leak_at TEXT,

  notes TEXT,

  FOREIGN KEY (request_id) REFERENCES document_access_requests(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE INDEX IF NOT EXISTS idx_document_licences_number
ON document_licences(licence_number);

CREATE INDEX IF NOT EXISTS idx_document_licences_document
ON document_licences(document_id);

CREATE INDEX IF NOT EXISTS idx_document_licences_email
ON document_licences(licence_holder_email_normalised);

CREATE INDEX IF NOT EXISTS idx_document_licences_status
ON document_licences(status);

CREATE INDEX IF NOT EXISTS idx_document_licences_issued_at
ON document_licences(issued_at);

CREATE INDEX IF NOT EXISTS idx_document_licences_request
ON document_licences(request_id);


-- ============================================================
-- 5. Document Download Links
-- ============================================================

CREATE TABLE IF NOT EXISTS document_download_links (
  id TEXT PRIMARY KEY,

  licence_id TEXT NOT NULL,
  document_id TEXT NOT NULL,

  token_hash TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'created',

  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,

  used_at TEXT,
  revoked_at TEXT,
  superseded_at TEXT,

  ip_hash TEXT,
  user_agent TEXT,

  failure_reason TEXT,

  FOREIGN KEY (licence_id) REFERENCES document_licences(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE INDEX IF NOT EXISTS idx_document_download_links_licence
ON document_download_links(licence_id);

CREATE INDEX IF NOT EXISTS idx_document_download_links_document
ON document_download_links(document_id);

CREATE INDEX IF NOT EXISTS idx_document_download_links_token
ON document_download_links(token_hash);

CREATE INDEX IF NOT EXISTS idx_document_download_links_status
ON document_download_links(status);

CREATE INDEX IF NOT EXISTS idx_document_download_links_expires
ON document_download_links(expires_at);


-- ============================================================
-- 6. Document Download Events
-- ============================================================

CREATE TABLE IF NOT EXISTS document_download_events (
  id TEXT PRIMARY KEY,

  download_id TEXT NOT NULL UNIQUE,

  licence_id TEXT NOT NULL,
  licence_number TEXT NOT NULL,

  document_id TEXT NOT NULL,
  document_version TEXT NOT NULL,

  licence_holder_name TEXT,
  organisation_name TEXT,
  licence_holder_email TEXT NOT NULL,

  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,

  ip_hash TEXT,
  user_agent TEXT,

  generated_object TEXT,
  source_object TEXT,

  source_sha256 TEXT,
  generated_sha256 TEXT,
  template_sha256 TEXT,

  licence_page_template_version TEXT,
  watermark_template_version TEXT,
  footer_template_version TEXT,
  terms_template_version TEXT,
  generation_engine_version TEXT,

  terms_version TEXT NOT NULL,

  success INTEGER NOT NULL DEFAULT 1,
  failure_reason TEXT,

  FOREIGN KEY (licence_id) REFERENCES document_licences(id),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE INDEX IF NOT EXISTS idx_document_download_events_download_id
ON document_download_events(download_id);

CREATE INDEX IF NOT EXISTS idx_document_download_events_licence
ON document_download_events(licence_id);

CREATE INDEX IF NOT EXISTS idx_document_download_events_licence_number
ON document_download_events(licence_number);

CREATE INDEX IF NOT EXISTS idx_document_download_events_document
ON document_download_events(document_id);

CREATE INDEX IF NOT EXISTS idx_document_download_events_email
ON document_download_events(licence_holder_email);

CREATE INDEX IF NOT EXISTS idx_document_download_events_event_at
ON document_download_events(event_at);

CREATE INDEX IF NOT EXISTS idx_document_download_events_event_type
ON document_download_events(event_type);

CREATE INDEX IF NOT EXISTS idx_document_download_events_success
ON document_download_events(success);


-- ============================================================
-- 7. Admin Audit Events
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id TEXT PRIMARY KEY,

  admin_identity TEXT NOT NULL,

  action TEXT NOT NULL,

  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,

  before_json TEXT,
  after_json TEXT,

  reason TEXT,

  created_at TEXT NOT NULL,

  ip_hash TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_admin
ON admin_audit_events(admin_identity);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_action
ON admin_audit_events(action);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_target
ON admin_audit_events(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created_at
ON admin_audit_events(created_at);


-- ============================================================
-- 8. Email Domain Policy
-- ============================================================

CREATE TABLE IF NOT EXISTS email_domain_policy (
  id TEXT PRIMARY KEY,

  domain TEXT NOT NULL UNIQUE,

  status TEXT NOT NULL,
  reason TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_domain_policy_domain
ON email_domain_policy(domain);

CREATE INDEX IF NOT EXISTS idx_email_domain_policy_status
ON email_domain_policy(status);


-- ============================================================
-- 9. CDAS Counters
-- ============================================================
--
-- D1 does not provide PostgreSQL-style sequences.
-- This table supports predictable licence/download numbering.
--
-- Example:
-- counter_name = 'licence_2026'
-- current_value = 42
--
-- Next licence:
-- RH-LIC-2026-000043

CREATE TABLE IF NOT EXISTS cdas_counters (
  counter_name TEXT PRIMARY KEY,
  current_value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cdas_counters_updated_at
ON cdas_counters(updated_at);


-- ============================================================
-- 10. Optional Local Event Notes
-- ============================================================
--
-- This allows internal notes against requests, licences, leaks,
-- generation failures, support issues, etc.

CREATE TABLE IF NOT EXISTS cdas_notes (
  id TEXT PRIMARY KEY,

  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,

  note_type TEXT NOT NULL DEFAULT 'general',
  body TEXT NOT NULL,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cdas_notes_target
ON cdas_notes(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_cdas_notes_type
ON cdas_notes(note_type);

CREATE INDEX IF NOT EXISTS idx_cdas_notes_created_at
ON cdas_notes(created_at);


-- ============================================================
-- 11. Initial Licence Terms
-- ============================================================

INSERT OR IGNORE INTO licence_terms (
  id,
  version,
  title,
  body,
  body_sha256,
  status,
  applies_to_access_class,
  effective_from,
  effective_to,
  created_at,
  retired_at,
  notes
) VALUES (
  'lt_cdas_v0_1',
  'CDAS-LICENCE-v0.1',
  'RelayHub Individual Document Licence v0.1',
  'This document is individually licensed to the named licence holder. The licence holder may read and retain the document for personal, organisational, review, educational, or evaluation purposes as permitted by RelayHub. The licence holder must not redistribute, republish, resell, modify, remove licence markings from, or present this document as their own work or authority without written permission from RelayHub. RelayHub may revoke future access where misuse, redistribution, incorrect recipient details, or policy breach is identified. Revocation does not erase historical audit records and does not imply technical recall of already downloaded copies.',
  NULL,
  'active',
  'controlled_verified',
  NULL,
  NULL,
  datetime('now'),
  NULL,
  'Initial CDAS licence terms for controlled verified documents.'
);


-- ============================================================
-- 12. Initial Email Domain Policy Entries
-- ============================================================

INSERT OR IGNORE INTO email_domain_policy (
  id,
  domain,
  status,
  reason,
  created_at,
  updated_at
) VALUES
  (
    'edp_mailinator',
    'mailinator.com',
    'blocked',
    'Disposable email domain.',
    datetime('now'),
    datetime('now')
  ),
  (
    'edp_guerrillamail',
    'guerrillamail.com',
    'blocked',
    'Disposable email domain.',
    datetime('now'),
    datetime('now')
  ),
  (
    'edp_10minutemail',
    '10minutemail.com',
    'blocked',
    'Disposable email domain.',
    datetime('now'),
    datetime('now')
  ),
  (
    'edp_yopmail',
    'yopmail.com',
    'blocked',
    'Disposable email domain.',
    datetime('now'),
    datetime('now')
  ),
  (
    'edp_tempmail',
    'tempmail.com',
    'blocked',
    'Disposable email domain.',
    datetime('now'),
    datetime('now')
  );


-- ============================================================
-- 13. Initial Counters
-- ============================================================

INSERT OR IGNORE INTO cdas_counters (
  counter_name,
  current_value,
  updated_at
) VALUES
  ('licence_2026', 0, datetime('now')),
  ('download_2026', 0, datetime('now'));