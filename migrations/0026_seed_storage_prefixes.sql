-- RelayHub Website — Controlled Upload Facility
-- Migration 0026: seed_storage_prefixes
--
-- Purpose:
--   Seed safe initial CDAS and private-file upload prefixes.
--
-- Safety posture:
--   Additive only.
--   Uses INSERT OR IGNORE so repeated migration execution does not duplicate rows.
--   Validation prefixes are seeded but kept as draft by default.
--   No files are uploaded.
--   No documents are published.
--   No licences, links, or email events are created.

INSERT OR IGNORE INTO storage_prefixes (
  id,
  domain,
  label,
  prefix,
  status,
  description,
  created_by,
  created_at,
  updated_at,
  notes
) VALUES
  (
    'sp_cdas_general',
    'cdas_document',
    'CDAS General',
    'docs/originals/relayhub/general/',
    'active',
    'General RelayHub CDAS source document uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_cdas_governance',
    'cdas_document',
    'CDAS Governance',
    'docs/originals/relayhub/governance/',
    'active',
    'RelayHub governance and policy source document uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_cdas_relayos',
    'cdas_document',
    'CDAS RelayOS',
    'docs/originals/relayhub/relayos/',
    'active',
    'RelayOS source document uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_cdas_validation',
    'cdas_document',
    'CDAS Validation',
    'docs/originals/relayhub/validation/',
    'active',
    'Validation reports and controlled validation evidence intended for CDAS document workflow.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_cdas_public_overviews',
    'cdas_document',
    'CDAS Public Overviews',
    'docs/originals/relayhub/public-overviews/',
    'active',
    'Public overview source documents that may later enter CDAS workflow after activation gates.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_cdas_operator_guides',
    'cdas_document',
    'CDAS Operator Guides',
    'docs/originals/relayhub/operator-guides/',
    'active',
    'Operator guide source documents for controlled CDAS workflow.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_cdas_validation_sandbox',
    'cdas_document',
    'CDAS Validation Sandbox',
    'docs/originals/relayhub/_validation/',
    'draft',
    'Validation-only CDAS upload namespace. Not for normal document activation.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Validation prefix. Keep draft unless deliberately running validation-mode tests.'
  ),
  (
    'sp_private_general',
    'private_file',
    'Private General',
    'private-files/originals/general/',
    'active',
    'General private controlled file uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_private_client',
    'private_file',
    'Private Client',
    'private-files/originals/client/',
    'active',
    'Client private controlled file uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_private_pilot',
    'private_file',
    'Private Pilot',
    'private-files/originals/pilot/',
    'active',
    'Pilot private controlled file uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_private_partner',
    'private_file',
    'Private Partner',
    'private-files/originals/partner/',
    'active',
    'Partner private controlled file uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_private_review',
    'private_file',
    'Private Review',
    'private-files/originals/review/',
    'active',
    'Private review-copy uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_private_commercial',
    'private_file',
    'Private Commercial',
    'private-files/originals/commercial/',
    'active',
    'Commercial private controlled file uploads.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Seeded by 0026_seed_storage_prefixes.sql.'
  ),
  (
    'sp_private_validation_sandbox',
    'private_file',
    'Private Validation Sandbox',
    'private-files/originals/_validation/',
    'draft',
    'Validation-only private-file upload namespace. Not for normal private delivery.',
    'migration',
    datetime('now'),
    datetime('now'),
    'Validation prefix. Keep draft unless deliberately running validation-mode tests.'
  );