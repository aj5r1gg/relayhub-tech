INSERT INTO email_domain_policy (
  domain,
  status,
  reason,
  created_at,
  updated_at
)
VALUES
  (
    'proton.me',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'protonmail.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'pm.me',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'mailfence.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'tuta.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'tutanota.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'tutamail.com',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'tuta.io',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ),
  (
    'keemail.me',
    'review',
    'Privacy-focused personal email provider. Not blocked. Manual review may be required for controlled, restricted, partner, or commercially sensitive documents where organisational attribution or requester context is required.',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
ON CONFLICT(domain) DO UPDATE SET
  status = excluded.status,
  reason = excluded.reason,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
