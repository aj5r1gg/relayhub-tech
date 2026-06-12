INSERT INTO email_domain_policy (
  id,
  domain,
  status,
  reason,
  created_at,
  updated_at
)
VALUES
  (
    'edp_keemail_me',
    'keemail.me',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_mailfence_com',
    'mailfence.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_pm_me',
    'pm.me',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_proton_me',
    'proton.me',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_protonmail_com',
    'protonmail.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_tuta_com',
    'tuta.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_tuta_io',
    'tuta.io',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_tutamail_com',
    'tutamail.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'edp_tutanota_com',
    'tutanota.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
ON CONFLICT(domain) DO UPDATE SET
  id = excluded.id,
  status = excluded.status,
  reason = excluded.reason,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
