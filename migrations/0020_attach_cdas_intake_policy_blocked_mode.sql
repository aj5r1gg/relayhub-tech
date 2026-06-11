-- Migration number: 0020 	 2026-06-11T11:42:33.699Z
/*
 * Phase 3X-0F — Attach request intake policy in blocked mode.
 *
 * This attaches the active CDAS standard request intake policy to the
 * RelayHub Overview release policy, but deliberately keeps the release
 * policy non-active and non-requestable.
 *
 * This migration does not:
 * - enable request buttons,
 * - enable public downloads,
 * - activate the release policy,
 * - set release_state to request_open,
 * - create access requests,
 * - issue licences,
 * - create download links.
 */

UPDATE document_release_policies
SET
  request_intake_policy_id = 'rip_cdas_standard_v1',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  updated_by = 'migration',
  admin_note =
    COALESCE(admin_note, '') ||
    CASE
      WHEN admin_note IS NULL OR trim(admin_note) = '' THEN ''
      ELSE char(10) || char(10)
    END ||
    'Phase 3X-0F: attached rip_cdas_standard_v1 in blocked mode. Request and download remain disabled.'
WHERE document_id = 'relayhub-overview'
  AND document_version = '0.2'
  AND request_intake_policy_id IS NULL;

/*
 * Record attachment event.
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
  'updated' AS event_type,
  'request_intake_policy_id:null' AS previous_state,
  'request_intake_policy_id:rip_cdas_standard_v1' AS new_state,
  'Phase 3X-0F: attached request intake policy in blocked mode. Request and download remain disabled.' AS reason,
  'migration' AS actor,
  json_object(
    'phase', '3X-0F',
    'request_intake_policy_id', p.request_intake_policy_id,
    'policy_status', p.policy_status,
    'release_state', p.release_state,
    'request_button_enabled', p.request_button_enabled,
    'public_download_enabled', p.public_download_enabled,
    'blocked_mode', 1
  ) AS metadata_json
FROM document_release_policies p
WHERE p.document_id = 'relayhub-overview'
  AND p.document_version = '0.2'
  AND p.request_intake_policy_id = 'rip_cdas_standard_v1'
  AND NOT EXISTS (
    SELECT 1
    FROM document_release_policy_events e
    WHERE e.release_policy_id = p.id
      AND e.event_type = 'updated'
      AND e.reason LIKE 'Phase 3X-0F:%'
  );