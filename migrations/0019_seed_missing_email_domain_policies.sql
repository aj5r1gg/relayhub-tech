-- Migration number: 0019 	 2026-06-11T11:06:43.280Z
/*
 * Phase 3X-0D repair — seed missing baseline email domain policies.
 *
 * This does not enable document requests.
 * This only completes the baseline email-domain policy data.
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