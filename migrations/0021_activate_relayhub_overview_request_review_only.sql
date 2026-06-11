-- Migration number: 0021 	 2026-06-11T11:52:52.104Z
/*
 * Phase 3X-0G — Activate controlled request path for RelayHub Overview
 * in review-only mode.
 *
 * This makes RelayHub Overview requestable, but only into manual review.
 *
 * It does not:
 * - approve requests automatically,
 * - issue licences automatically,
 * - create download links automatically,
 * - enable public download,
 * - bypass email verification,
 * - bypass request intake policy,
 * - bypass disposable email blocking.
 */

UPDATE document_release_policies
SET
  policy_status = 'active',
  release_state = 'request_open',
  request_button_enabled = 1,
  public_download_enabled = 0,

  approval_required = 1,
  email_verification_required = 1,
  manual_review_required = 1,
  invitation_required = 0,
  payment_required = 0,

  watermark_required = 1,
  personalised_pdf_required = 1,
  download_id_required = 1,
  single_use_link_required = 1,
  evidence_bundle_required = 1,

  abuse_screening_required = 1,
  disposable_email_block_required = 1,
  business_context_required = 1,
  source_hash_required = 1,

  request_intake_policy_id = 'rip_cdas_standard_v1',

  public_label = 'Request access',
  public_action_label = 'Request access',
  public_message = 'Access requests are open for review. Approved recipients may receive a personalised licensed copy after verification and manual approval.',

  approved_by = COALESCE(approved_by, 'migration'),
  approved_at = COALESCE(approved_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approval_note = COALESCE(
    approval_note,
    'Phase 3X-0G: activated request-open review-only mode for RelayHub Overview.'
  ),

  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_by = 'migration',

  admin_note =
    COALESCE(admin_note, '') ||
    CASE
      WHEN admin_note IS NULL OR trim(admin_note) = '' THEN ''
      ELSE char(10) || char(10)
    END ||
    'Phase 3X-0G: request-open review-only mode. Public download remains disabled. Licence issue and download remain manual.'
WHERE document_id = 'relayhub-overview'
  AND document_version = '0.2'
  AND request_intake_policy_id = 'rip_cdas_standard_v1'
  AND licence_terms_status = 'active'
  AND public_download_enabled = 0;

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
  'activated' AS event_type,
  'blocked_mode' AS previous_state,
  'request_open_review_only' AS new_state,
  'Phase 3X-0G: activated RelayHub Overview request path in review-only mode.' AS reason,
  'migration' AS actor,
  json_object(
    'phase', '3X-0G',
    'policy_status', p.policy_status,
    'release_state', p.release_state,
    'request_button_enabled', p.request_button_enabled,
    'public_download_enabled', p.public_download_enabled,
    'request_intake_policy_id', p.request_intake_policy_id,
    'manual_review_required', p.manual_review_required,
    'email_verification_required', p.email_verification_required,
    'automatic_licence_issue', 0,
    'automatic_download_link_issue', 0,
    'review_only', 1
  ) AS metadata_json
FROM document_release_policies p
WHERE p.document_id = 'relayhub-overview'
  AND p.document_version = '0.2'
  AND p.policy_status = 'active'
  AND p.release_state = 'request_open'
  AND p.request_button_enabled = 1
  AND p.public_download_enabled = 0
  AND NOT EXISTS (
    SELECT 1
    FROM document_release_policy_events e
    WHERE e.release_policy_id = p.id
      AND e.event_type = 'activated'
      AND e.reason LIKE 'Phase 3X-0G:%'
  );