-- Migration number: 0017 	 2026-06-11T10:56:30.183Z
/*
 * Phase 3X-0C — Seed safe CDAS release policies.
 *
 * This migration is intentionally conservative.
 *
 * It creates release-policy rows for existing CDAS documents, but:
 * - does not activate public request,
 * - does not enable public download,
 * - does not mark policies active,
 * - does not bypass licence terms,
 * - does not bypass request intake policy,
 * - does not issue licences,
 * - does not generate PDFs,
 * - does not create download links.
 *
 * Safe posture:
 * Existing documents may become visible to admin release-policy tooling,
 * but they remain blocked until deliberately reviewed and activated.
 */

INSERT OR IGNORE INTO document_release_policies (
  id,

  document_id,
  document_version,

  release_class,
  policy_status,
  public_visibility,
  access_mode,
  release_state,

  licence_terms_id,
  licence_terms_version,
  licence_terms_status,

  request_intake_policy_id,

  listed_publicly,
  request_button_enabled,
  public_download_enabled,
  public_summary_allowed,

  approval_required,
  email_verification_required,
  manual_review_required,
  invitation_required,
  payment_required,

  watermark_required,
  personalised_pdf_required,
  download_id_required,
  single_use_link_required,
  evidence_bundle_required,

  redistribution_allowed,
  commercial_use_allowed,
  derivative_use_allowed,
  training_ai_allowed,
  public_quoting_allowed,

  abuse_screening_required,
  disposable_email_block_required,
  business_context_required,
  source_hash_required,

  public_label,
  public_action_label,
  public_message,
  admin_note,

  created_by,
  updated_by
)
SELECT
  'drp_' || lower(hex(randomblob(8))) AS id,

  d.id AS document_id,
  COALESCE(d.version, '') AS document_version,

  CASE
    WHEN d.classification = 'public_open' THEN 'PUBLIC_DOCTRINE'
    WHEN d.classification = 'public_licensed' THEN 'PUBLIC_SUMMARY'
    WHEN d.classification = 'controlled' THEN 'CONTROLLED_DISCLOSURE'
    WHEN d.classification = 'restricted' THEN 'RESTRICTED_DISCLOSURE'
    WHEN d.classification = 'confidential' THEN 'PARTNER_ONLY'
    WHEN d.classification = 'internal_only' THEN 'INTERNAL_ONLY'
    ELSE 'UNRELEASED'
  END AS release_class,

  'draft' AS policy_status,

  CASE
    WHEN COALESCE(d.is_listed, 0) = 1 THEN 'listed'
    ELSE 'hidden'
  END AS public_visibility,

  CASE
    WHEN d.access_class = 'direct_public' THEN 'public_download'
    WHEN d.access_class = 'verified_public' THEN 'verified_public'
    WHEN d.access_class = 'licensed_public' THEN 'licensed_public'
    WHEN d.access_class = 'controlled_verified' THEN 'controlled_disclosure'
    WHEN d.access_class = 'approval_required' THEN 'restricted_controlled_disclosure'
    WHEN d.access_class = 'invite_only' THEN 'invite_only'
    WHEN d.access_class = 'paid_verified' THEN 'paid_verified'
    ELSE 'not_available'
  END AS access_mode,

  CASE
    WHEN d.status IN ('draft', 'review') THEN 'draft'
    WHEN d.status = 'active' THEN 'licence_pending'
    WHEN d.status = 'restricted' THEN 'licence_pending'
    WHEN d.status = 'superseded' THEN 'retired'
    WHEN d.status IN ('withdrawn', 'retired', 'archived', 'disabled') THEN 'retired'
    ELSE 'draft'
  END AS release_state,

  NULL AS licence_terms_id,
  NULLIF(COALESCE(d.licence_terms_version, ''), '') AS licence_terms_version,

  CASE
    WHEN lt.status IN ('active', 'approved') THEN lt.status
    WHEN NULLIF(COALESCE(d.licence_terms_version, ''), '') IS NOT NULL THEN 'unverified'
    ELSE 'missing'
  END AS licence_terms_status,

  NULL AS request_intake_policy_id,

  CASE
    WHEN COALESCE(d.is_listed, 0) = 1 THEN 1
    ELSE 0
  END AS listed_publicly,

  0 AS request_button_enabled,
  0 AS public_download_enabled,

  CASE
    WHEN COALESCE(d.is_listed, 0) = 1 THEN 1
    ELSE 0
  END AS public_summary_allowed,

  1 AS approval_required,
  1 AS email_verification_required,
  1 AS manual_review_required,
  0 AS invitation_required,

  CASE
    WHEN d.access_class = 'paid_verified' THEN 1
    ELSE 0
  END AS payment_required,

  1 AS watermark_required,
  1 AS personalised_pdf_required,
  1 AS download_id_required,
  1 AS single_use_link_required,
  1 AS evidence_bundle_required,

  0 AS redistribution_allowed,
  0 AS commercial_use_allowed,
  0 AS derivative_use_allowed,
  0 AS training_ai_allowed,
  0 AS public_quoting_allowed,

  1 AS abuse_screening_required,
  1 AS disposable_email_block_required,
  1 AS business_context_required,
  1 AS source_hash_required,

  CASE
    WHEN d.status IN ('active', 'restricted') THEN 'Controlled release pending'
    WHEN d.status IN ('draft', 'review') THEN 'Preparing'
    WHEN d.status = 'superseded' THEN 'Superseded'
    WHEN d.status IN ('withdrawn', 'retired', 'archived', 'disabled') THEN 'Not available'
    ELSE 'Not available'
  END AS public_label,

  'Access not open' AS public_action_label,

  CASE
    WHEN d.status IN ('active', 'restricted') THEN
      'Access will open after release policy, licence terms, and request protection are finalised.'
    WHEN d.status IN ('draft', 'review') THEN
      'This document is being prepared and is not currently available.'
    WHEN d.status = 'superseded' THEN
      'This document has been superseded and is not currently available for public request.'
    ELSE
      'This document is not currently available.'
  END AS public_message,

  'Seeded as safe default-deny. Review, licence, intake policy, and activation are required before request or download can be enabled.' AS admin_note,

  'migration' AS created_by,
  'migration' AS updated_by
FROM documents d
LEFT JOIN licence_terms lt
  ON lt.version = d.licence_terms_version;

/*
 * Record one creation event for each seeded policy.
 */

INSERT INTO document_release_policy_events (
  id,
  release_policy_id,
  document_id,
  document_version,
  event_type,
  previous_state,
  new_state,
  reason,
  actor,
  metadata_json
)
SELECT
  'drpe_' || lower(hex(randomblob(8))) AS id,
  p.id AS release_policy_id,
  p.document_id,
  p.document_version,
  'created' AS event_type,
  NULL AS previous_state,
  p.policy_status AS new_state,
  'Initial safe default-deny release policy seed.' AS reason,
  'migration' AS actor,
  json_object(
    'phase', '3X-0C',
    'safe_default_deny', 1,
    'request_button_enabled', p.request_button_enabled,
    'public_download_enabled', p.public_download_enabled,
    'policy_status', p.policy_status,
    'release_state', p.release_state
  ) AS metadata_json
FROM document_release_policies p
WHERE NOT EXISTS (
  SELECT 1
  FROM document_release_policy_events e
  WHERE e.release_policy_id = p.id
    AND e.event_type = 'created'
);
