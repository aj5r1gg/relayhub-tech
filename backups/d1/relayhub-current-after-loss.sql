PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_create_early_access_signups.sql','2026-06-02 11:45:05');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_create_contact_messages.sql','2026-06-02 12:19:49');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0004_cdas_v0_2.sql','2026-06-07 21:09:32');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(4,'0005_website_legacy_tables.sql','2026-06-08 07:19:57');
CREATE TABLE early_access_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name TEXT,
  email TEXT NOT NULL,
  community TEXT,
  message TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  source TEXT DEFAULT 'early-access-form'
);
INSERT INTO "early_access_signups" ("id","created_at","name","email","community","message","ip_hash","user_agent","source") VALUES(1,'2026-06-02 11:48:58','D1 Test User','d1test@example.com','RelayHub D1 test','Testing D1 storage','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0','early-access-form');
INSERT INTO "early_access_signups" ("id","created_at","name","email","community","message","ip_hash","user_agent","source") VALUES(2,'2026-06-02 12:05:56','Email Format Test','emailtest@example.com','RelayHub test','Testing improved email format','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0','early-access-form');
CREATE TABLE contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT,
  message TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  source TEXT DEFAULT 'contact-form'
, subject TEXT);
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source","subject") VALUES(1,'2026-06-02 12:23:08','Contact Test User','contacttest@example.com','General enquiry','Testing RelayHub contact form','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0','contact-form',NULL);
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source","subject") VALUES(2,'2026-06-02 21:34:03','Robertsmist','zekisuquc419@gmail.com','General enquiry','Γεια σου, ήθελα να μάθω την τιμή σας.','db5f7a60ffcc707f0ff736248ec26745e065d782dd6e43596d4b74d56a9637a2','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36','contact-form',NULL);
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source","subject") VALUES(3,'2026-06-08T07:30:39.732Z','Test User','test@example.com',NULL,'Testing contact form after contact_messages id patch','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','curl/8.18.0','contact-form','Worker modularisation test');
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source","subject") VALUES(4,'2026-06-08T08:25:46.960Z','Andrew','aj5rigg@gmail.com',NULL,'test contact form','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','contact-form','');
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source","subject") VALUES(5,'2026-06-08T08:31:45.457Z','Andrew','aj5rigg@gmail.com',NULL,'test again contact form','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','contact-form','');
CREATE TABLE documents (
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
CREATE TABLE licence_terms (
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
INSERT INTO "licence_terms" ("id","version","title","body","body_sha256","status","applies_to_access_class","effective_from","effective_to","created_at","retired_at","notes") VALUES('lt_cdas_v0_1','CDAS-LICENCE-v0.1','RelayHub Individual Document Licence v0.1','This document is individually licensed to the named licence holder. The licence holder may read and retain the document for personal, organisational, review, educational, or evaluation purposes as permitted by RelayHub. The licence holder must not redistribute, republish, resell, modify, remove licence markings from, or present this document as their own work or authority without written permission from RelayHub. RelayHub may revoke future access where misuse, redistribution, incorrect recipient details, or policy breach is identified. Revocation does not erase historical audit records and does not imply technical recall of already downloaded copies.',NULL,'active','controlled_verified',NULL,NULL,'2026-06-07 21:09:32',NULL,'Initial CDAS licence terms for controlled verified documents.');
CREATE TABLE document_access_requests (
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
CREATE TABLE document_licences (
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
CREATE TABLE document_download_links (
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
CREATE TABLE document_download_events (
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
CREATE TABLE admin_audit_events (
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
CREATE TABLE email_domain_policy (
  id TEXT PRIMARY KEY,

  domain TEXT NOT NULL UNIQUE,

  status TEXT NOT NULL,
  reason TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO "email_domain_policy" ("id","domain","status","reason","created_at","updated_at") VALUES('edp_mailinator','mailinator.com','blocked','Disposable email domain.','2026-06-07 21:09:32','2026-06-07 21:09:32');
INSERT INTO "email_domain_policy" ("id","domain","status","reason","created_at","updated_at") VALUES('edp_guerrillamail','guerrillamail.com','blocked','Disposable email domain.','2026-06-07 21:09:32','2026-06-07 21:09:32');
INSERT INTO "email_domain_policy" ("id","domain","status","reason","created_at","updated_at") VALUES('edp_10minutemail','10minutemail.com','blocked','Disposable email domain.','2026-06-07 21:09:32','2026-06-07 21:09:32');
INSERT INTO "email_domain_policy" ("id","domain","status","reason","created_at","updated_at") VALUES('edp_yopmail','yopmail.com','blocked','Disposable email domain.','2026-06-07 21:09:32','2026-06-07 21:09:32');
INSERT INTO "email_domain_policy" ("id","domain","status","reason","created_at","updated_at") VALUES('edp_tempmail','tempmail.com','blocked','Disposable email domain.','2026-06-07 21:09:32','2026-06-07 21:09:32');
CREATE TABLE cdas_counters (
  counter_name TEXT PRIMARY KEY,
  current_value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT INTO "cdas_counters" ("counter_name","current_value","updated_at") VALUES('licence_2026',0,'2026-06-07 21:09:32');
INSERT INTO "cdas_counters" ("counter_name","current_value","updated_at") VALUES('download_2026',0,'2026-06-07 21:09:32');
CREATE TABLE cdas_notes (
  id TEXT PRIMARY KEY,

  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,

  note_type TEXT NOT NULL DEFAULT 'general',
  body TEXT NOT NULL,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE early_access_requests (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT NOT NULL,
  community TEXT,
  role TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('69a0d1534c7af533d845c50df6cf1fff','Test User','test@example.com','Test','Testing','Testing early access form after legacy table migration','2026-06-08T07:20:24.025Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','curl/8.18.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('60c9813b581a2f88f0bda6db68a967f6','Andrew','aj5rigg@gmail.com','household','','test','2026-06-08T07:31:13.743Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('760dcfc2dac0ce516580c725cfa6fc8e','Andrew','aj5rigg@gmail.com','household','','test','2026-06-08T07:31:25.001Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('497ee62198ee8c8a7f90fda79509ead7','Andrew','aj5rigg@gmail.com','household','','test','2026-06-08T07:42:26.166Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('bd8de4aa02e8fa53f6d815945b272f12','Andrew','aj5rigg@gmail.com','community group','Community organiser','test','2026-06-08T07:47:10.810Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('238a148c75078b093bf9fd454695518e','Andrew','aj5rigg@gmail.com','group','Developer','test','2026-06-08T08:08:10.338Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('46ccf5509dcae7f8a53d3e411e8087e2','Email Debug Test','test@example.com','Test','Testing','Testing whether Worker email sends','2026-06-08T08:09:58.863Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','curl/8.18.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('a5bce48b5757d6e988b4e5789e24a64b','Email Debug Test','test@example.com','Test','Testing','Testing whether Worker email sends','2026-06-08T08:11:29.117Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','curl/8.18.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('05030b712207fd296b25daf5fda8b164','Email Debug Test','test@example.com','Test','Testing','Testing whether Worker email sends after raw MIME patch','2026-06-08T08:23:55.696Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','curl/8.18.0');
INSERT INTO "early_access_requests" ("id","name","email","community","role","message","created_at","ip_hash","user_agent") VALUES('b66392ad6722d8e05473b9d6ccd2aed5','Andrew','aj5rigg@gmail.com','test','Other','test','2026-06-08T08:24:57.056Z','0c666c8d2a07e2edf154f70bb577ecb8c52f35cbad92c9163a5b614e5d8de356','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0');
CREATE TABLE download_registry (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  document_title TEXT,
  document_version TEXT,
  source_object TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  licence_number TEXT,
  token_hash TEXT NOT NULL,
  token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'issued',
  issued_at TEXT NOT NULL,
  downloaded_at TEXT,
  generated_object TEXT,
  ip_hash TEXT,
  user_agent TEXT
);
CREATE TABLE download_events (
  id TEXT PRIMARY KEY,
  registry_id TEXT,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  metadata TEXT
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',4);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('early_access_signups',2);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('contact_messages',5);
CREATE INDEX idx_early_access_email
ON early_access_signups(email);
CREATE INDEX idx_early_access_created_at
ON early_access_signups(created_at);
CREATE INDEX idx_contact_messages_email
ON contact_messages(email);
CREATE INDEX idx_contact_messages_created_at
ON contact_messages(created_at);
CREATE INDEX idx_documents_slug
ON documents(slug);
CREATE INDEX idx_documents_status
ON documents(status);
CREATE INDEX idx_documents_classification
ON documents(classification);
CREATE INDEX idx_documents_access_class
ON documents(access_class);
CREATE INDEX idx_documents_listed
ON documents(is_listed);
CREATE INDEX idx_licence_terms_version
ON licence_terms(version);
CREATE INDEX idx_licence_terms_status
ON licence_terms(status);
CREATE INDEX idx_licence_terms_access_class
ON licence_terms(applies_to_access_class);
CREATE INDEX idx_document_access_requests_document
ON document_access_requests(document_id);
CREATE INDEX idx_document_access_requests_email
ON document_access_requests(email_normalised);
CREATE INDEX idx_document_access_requests_status
ON document_access_requests(status);
CREATE INDEX idx_document_access_requests_requested_at
ON document_access_requests(requested_at);
CREATE INDEX idx_document_access_requests_verified
ON document_access_requests(email_verified_at);
CREATE INDEX idx_document_access_requests_risk
ON document_access_requests(risk_score);
CREATE INDEX idx_document_licences_number
ON document_licences(licence_number);
CREATE INDEX idx_document_licences_document
ON document_licences(document_id);
CREATE INDEX idx_document_licences_email
ON document_licences(licence_holder_email_normalised);
CREATE INDEX idx_document_licences_status
ON document_licences(status);
CREATE INDEX idx_document_licences_issued_at
ON document_licences(issued_at);
CREATE INDEX idx_document_licences_request
ON document_licences(request_id);
CREATE INDEX idx_document_download_links_licence
ON document_download_links(licence_id);
CREATE INDEX idx_document_download_links_document
ON document_download_links(document_id);
CREATE INDEX idx_document_download_links_token
ON document_download_links(token_hash);
CREATE INDEX idx_document_download_links_status
ON document_download_links(status);
CREATE INDEX idx_document_download_links_expires
ON document_download_links(expires_at);
CREATE INDEX idx_document_download_events_download_id
ON document_download_events(download_id);
CREATE INDEX idx_document_download_events_licence
ON document_download_events(licence_id);
CREATE INDEX idx_document_download_events_licence_number
ON document_download_events(licence_number);
CREATE INDEX idx_document_download_events_document
ON document_download_events(document_id);
CREATE INDEX idx_document_download_events_email
ON document_download_events(licence_holder_email);
CREATE INDEX idx_document_download_events_event_at
ON document_download_events(event_at);
CREATE INDEX idx_document_download_events_event_type
ON document_download_events(event_type);
CREATE INDEX idx_document_download_events_success
ON document_download_events(success);
CREATE INDEX idx_admin_audit_events_admin
ON admin_audit_events(admin_identity);
CREATE INDEX idx_admin_audit_events_action
ON admin_audit_events(action);
CREATE INDEX idx_admin_audit_events_target
ON admin_audit_events(target_type, target_id);
CREATE INDEX idx_admin_audit_events_created_at
ON admin_audit_events(created_at);
CREATE INDEX idx_email_domain_policy_domain
ON email_domain_policy(domain);
CREATE INDEX idx_email_domain_policy_status
ON email_domain_policy(status);
CREATE INDEX idx_cdas_counters_updated_at
ON cdas_counters(updated_at);
CREATE INDEX idx_cdas_notes_target
ON cdas_notes(target_type, target_id);
CREATE INDEX idx_cdas_notes_type
ON cdas_notes(note_type);
CREATE INDEX idx_cdas_notes_created_at
ON cdas_notes(created_at);
CREATE INDEX idx_early_access_requests_email
ON early_access_requests(email);
CREATE INDEX idx_early_access_requests_created_at
ON early_access_requests(created_at);
CREATE INDEX idx_download_registry_document_id
ON download_registry(document_id);
CREATE INDEX idx_download_registry_email
ON download_registry(email);
CREATE INDEX idx_download_registry_token_hash
ON download_registry(token_hash);
CREATE INDEX idx_download_registry_status
ON download_registry(status);
CREATE INDEX idx_download_registry_issued_at
ON download_registry(issued_at);
CREATE INDEX idx_download_events_registry_id
ON download_events(registry_id);
CREATE INDEX idx_download_events_event_type
ON download_events(event_type);
CREATE INDEX idx_download_events_event_at
ON download_events(event_at);
