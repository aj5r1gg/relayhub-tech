-- Migration number: 0018 	 2026-06-11T11:01:42.854Z
/*
 * Phase 3X-0D — CDAS request intake policy foundation.
 *
 * This migration adds request intake policy records and baseline
 * email-domain policy rows.
 *
 * It does not:
 * - enable public document requests,
 * - attach intake policies to document release policies,
 * - issue licences,
 * - create download links,
 * - change existing requests,
 * - make any document public or requestable.
 */

CREATE TABLE IF NOT EXISTS request_intake_policies (
  id TEXT PRIMARY KEY,

  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1',
  status TEXT NOT NULL DEFAULT 'draft',

  applies_to_domain TEXT NOT NULL DEFAULT 'cdas',
  description TEXT,

  block_disposable_email INTEGER NOT NULL DEFAULT 1,
  review_free_email_for_controlled INTEGER NOT NULL DEFAULT 1,
  review_free_email_for_restricted INTEGER NOT NULL DEFAULT 1,
  review_role_accounts INTEGER NOT NULL DEFAULT 1,

  require_name INTEGER NOT NULL DEFAULT 1,
  require_email INTEGER NOT NULL DEFAULT 1,
  require_use_case_for_controlled INTEGER NOT NULL DEFAULT 1,
  require_use_case_for_restricted INTEGER NOT NULL DEFAULT 1,
  require_organisation_for_restricted INTEGER NOT NULL DEFAULT 1,

  allow_public_doctrine INTEGER NOT NULL DEFAULT 0,
  allow_public_summary INTEGER NOT NULL DEFAULT 0,
  allow_controlled_disclosure INTEGER NOT NULL DEFAULT 0,
  allow_restricted_disclosure INTEGER NOT NULL DEFAULT 0,
  allow_partner_only INTEGER NOT NULL DEFAULT 0,
  allow_internal_only INTEGER NOT NULL DEFAULT 0,
  allow_commercial_paid INTEGER NOT NULL DEFAULT 0,

  max_requests_per_email_per_day INTEGER NOT NULL DEFAULT 3,
  max_requests_per_domain_per_day INTEGER NOT NULL DEFAULT 10,
  max_requests_per_ip_per_day INTEGER NOT NULL DEFAULT 10,
  max_requests_per_document_per_email_per_day INTEGER NOT NULL DEFAULT 1,

  duplicate_request_window_hours INTEGER NOT NULL DEFAULT 24,
  verification_failure_review_threshold INTEGER NOT NULL DEFAULT 3,

  public_block_message TEXT NOT NULL DEFAULT 'This request cannot be accepted at this time.',
  public_review_message TEXT NOT NULL DEFAULT 'Your request has been received and will be reviewed.',
  public_more_info_message TEXT NOT NULL DEFAULT 'More information is required before this request can be reviewed.',
  admin_note TEXT,

  effective_from TEXT,
  effective_until TEXT,

  approved_by TEXT,
  approved_at TEXT,
  approval_note TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT,
  updated_by TEXT,

  UNIQUE (name, version),

  CHECK (status IN (
    'draft',
    'pending_review',
    'approved',
    'active',
    'suspended',
    'superseded',
    'retired'
  )),

  CHECK (applies_to_domain IN (
    'cdas',
    'private_files',
    'shared'
  ))
);

CREATE INDEX IF NOT EXISTS idx_request_intake_policies_status
  ON request_intake_policies (status, applies_to_domain);

CREATE INDEX IF NOT EXISTS idx_request_intake_policies_name_version
  ON request_intake_policies (name, version);

CREATE TABLE IF NOT EXISTS request_intake_policy_events (
  id TEXT PRIMARY KEY,

  request_intake_policy_id TEXT NOT NULL,
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
    'email_domain_policy_changed',
    'threshold_changed',
    'emergency_lockdown'
  ))
);

CREATE INDEX IF NOT EXISTS idx_request_intake_policy_events_policy
  ON request_intake_policy_events (request_intake_policy_id, created_at);

CREATE INDEX IF NOT EXISTS idx_request_intake_policy_events_type
  ON request_intake_policy_events (event_type, created_at);

/*
 * Email domain policy table.
 *
 * This is intentionally minimal and compatible with the CDAS v0.2 scope.
 * Later we can add admin UI and richer metadata, but this is enough for
 * request-intake evaluation.
 */
CREATE TABLE IF NOT EXISTS email_domain_policy (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CHECK (status IN (
    'allowed',
    'review',
    'blocked',
    'internal',
    'partner',
    'unknown'
  ))
);

CREATE INDEX IF NOT EXISTS idx_email_domain_policy_status
  ON email_domain_policy (status);

CREATE INDEX IF NOT EXISTS idx_email_domain_policy_domain
  ON email_domain_policy (domain);

/*
 * Seed an active baseline CDAS request intake policy.
 *
 * This policy is active, but no document release policy uses it until a
 * release policy explicitly references request_intake_policy_id.
 */

INSERT OR IGNORE INTO request_intake_policies (
  id,
  name,
  version,
  status,
  applies_to_domain,
  description,

  block_disposable_email,
  review_free_email_for_controlled,
  review_free_email_for_restricted,
  review_role_accounts,

  require_name,
  require_email,
  require_use_case_for_controlled,
  require_use_case_for_restricted,
  require_organisation_for_restricted,

  allow_public_doctrine,
  allow_public_summary,
  allow_controlled_disclosure,
  allow_restricted_disclosure,
  allow_partner_only,
  allow_internal_only,
  allow_commercial_paid,

  public_block_message,
  public_review_message,
  public_more_info_message,
  admin_note,

  approved_by,
  approved_at,
  approval_note,
  created_by,
  updated_by
) VALUES (
  'rip_cdas_standard_v1',
  'CDAS Standard Intake Policy',
  '1',
  'active',
  'cdas',
  'Baseline CDAS request intake policy for protected RelayHub documents.',

  1,
  1,
  1,
  1,

  1,
  1,
  1,
  1,
  1,

  0,
  0,
  0,
  0,
  0,
  0,
  0,

  'This request cannot be accepted at this time.',
  'Your request has been received and will be reviewed.',
  'More information is required before this request can be reviewed.',
  'Seeded active but not attached to any release policy. Release policies must explicitly reference this policy before it can be used.',

  'migration',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'Initial safe baseline intake policy.',
  'migration',
  'migration'
);

INSERT OR IGNORE INTO request_intake_policy_events (
  id,
  request_intake_policy_id,
  event_type,
  previous_state,
  new_state,
  reason,
  actor,
  metadata_json
) VALUES (
  'ripe_cdas_standard_v1_created',
  'rip_cdas_standard_v1',
  'created',
  NULL,
  'active',
  'Initial safe request intake policy seed.',
  'migration',
  json_object(
    'phase', '3X-0D',
    'attached_to_release_policies', 0,
    'block_disposable_email', 1,
    'review_free_email_for_controlled', 1,
    'review_free_email_for_restricted', 1
  )
);

/*
 * Baseline blocked disposable / throwaway email domains.
 *
 * This is not intended to be exhaustive. It is the local baseline list.
 * Admin UI and ongoing updates can expand it later.
 */

INSERT OR IGNORE INTO email_domain_policy (
  id,
  domain,
  status,
  reason
) VALUES
  ('edp_mailinator_com', 'mailinator.com', 'blocked', 'Disposable email domain.'),
  ('edp_yopmail_com', 'yopmail.com', 'blocked', 'Disposable email domain.'),
  ('edp_10minutemail_com', '10minutemail.com', 'blocked', 'Disposable email domain.'),
  ('edp_guerrillamail_com', 'guerrillamail.com', 'blocked', 'Disposable email domain.'),
  ('edp_guerrillamail_net', 'guerrillamail.net', 'blocked', 'Disposable email domain.'),
  ('edp_guerrillamail_org', 'guerrillamail.org', 'blocked', 'Disposable email domain.'),
  ('edp_grr_la', 'grr.la', 'blocked', 'Disposable email domain.'),
  ('edp_sharklasers_com', 'sharklasers.com', 'blocked', 'Disposable email domain.'),
  ('edp_throwawaymail_com', 'throwawaymail.com', 'blocked', 'Disposable email domain.'),
  ('edp_trashmail_com', 'trashmail.com', 'blocked', 'Disposable email domain.'),
  ('edp_getnada_com', 'getnada.com', 'blocked', 'Disposable email domain.'),
  ('edp_temp_mail_org', 'temp-mail.org', 'blocked', 'Disposable email domain.'),
  ('edp_tempmail_com', 'tempmail.com', 'blocked', 'Disposable email domain.'),
  ('edp_mohmal_com', 'mohmal.com', 'blocked', 'Disposable email domain.'),
  ('edp_dispostable_com', 'dispostable.com', 'blocked', 'Disposable email domain.'),

  ('edp_gmail_com', 'gmail.com', 'review', 'Free email domain. Review for controlled or restricted documents.'),
  ('edp_googlemail_com', 'googlemail.com', 'review', 'Free email domain. Review for controlled or restricted documents.'),
  ('edp_outlook_com', 'outlook.com', 'review', 'Free email domain. Review for controlled or restricted documents.'),
  ('edp_hotmail_com', 'hotmail.com', 'review', 'Free email domain. Review for controlled or restricted documents.'),
  ('edp_live_com', 'live.com', 'review', 'Free email domain. Review for controlled or restricted documents.'),
  ('edp_yahoo_com', 'yahoo.com', 'review', 'Free email domain. Review for controlled or restricted documents.'),
  ('edp_icloud_com', 'icloud.com', 'review', 'Free email domain. Review for controlled or restricted documents.'),
  ('edp_proton_me', 'proton.me', 'review', 'Privacy-focused/free email domain. Review for controlled or restricted documents.'),
  ('edp_protonmail_com', 'protonmail.com', 'review', 'Privacy-focused/free email domain. Review for controlled or restricted documents.');  