PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_create_early_access_signups.sql','2026-06-02 11:45:05');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_create_contact_messages.sql','2026-06-02 12:19:49');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0004_cdas_v0_2.sql','2026-06-07 21:09:32');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(4,'0005_website_legacy_tables.sql','2026-06-08 21:20:42');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(5,'0007_cdas_v02_schema.sql','2026-06-08 21:20:42');
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
INSERT INTO "early_access_signups" ("id","created_at","name","email","community","message","ip_hash","user_agent","source") VALUES(3,'2026-06-08 12:05:14','Andrew','aj5rigg@gmail.com','test','test after modularisation','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','early-access-form');
INSERT INTO "early_access_signups" ("id","created_at","name","email","community","message","ip_hash","user_agent","source") VALUES(4,'2026-06-08 12:05:51','Andrew','aj5rigg@gmail.com','test','test after modularisation','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','early-access-form');
INSERT INTO "early_access_signups" ("id","created_at","name","email","community","message","ip_hash","user_agent","source") VALUES(5,'2026-06-08 12:08:47','Andrew','aj5rigg@gmail.com','test','test after modularisation 2','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','early-access-form');
INSERT INTO "early_access_signups" ("id","created_at","name","email","community","message","ip_hash","user_agent","source") VALUES(6,'2026-06-08 12:23:39','Andrew','aj5rigg@gmail.com','test','test after modularisation 27','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','early-access-form');
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
);
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source") VALUES(1,'2026-06-02 12:23:08','Contact Test User','contacttest@example.com','General enquiry','Testing RelayHub contact form','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0','contact-form');
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source") VALUES(2,'2026-06-02 21:34:03','Robertsmist','zekisuquc419@gmail.com','General enquiry','Γεια σου, ήθελα να μάθω την τιμή σας.','db5f7a60ffcc707f0ff736248ec26745e065d782dd6e43596d4b74d56a9637a2','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36','contact-form');
INSERT INTO "contact_messages" ("id","created_at","name","email","topic","message","ip_hash","user_agent","source") VALUES(3,'2026-06-08 12:12:41','Andrew','aj5rigg@gmail.com','General enquiry','test contact','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','contact-form');
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
INSERT INTO "documents" ("id","slug","title","summary","description","version","status","classification","access_class","source_object","source_sha256","generated_prefix","licence_terms_version","is_listed","allow_redownload","max_redownloads","requires_approval","current_version_of","supersedes_document_id","superseded_by_document_id","created_at","updated_at") VALUES('relayhub-overview','relayhub-overview','RelayHub Overview',NULL,NULL,'0.2','active','public_licensed','licensed_public','docs/originals/relayhub/RelayHub-Overview-v0.2.pdf',NULL,'docs/generated/free/','FREE-PUBLIC-DISTRIBUTION-v0.1',1,1,3,0,NULL,NULL,NULL,'2026-06-08T22:06:39.081Z','2026-06-08 22:34:16');
INSERT INTO "documents" ("id","slug","title","summary","description","version","status","classification","access_class","source_object","source_sha256","generated_prefix","licence_terms_version","is_listed","allow_redownload","max_redownloads","requires_approval","current_version_of","supersedes_document_id","superseded_by_document_id","created_at","updated_at") VALUES('example-relayhub-paid-document','example-relayhub-paid-document','Example RelayHub Paid Document',NULL,NULL,'0.1','disabled','controlled','paid_verified','docs/originals/relayhub/example-relayhub-paid-document-v0.1.pdf',NULL,'docs/generated/paid/','CDAS-LICENCE-v0.1',0,0,3,0,NULL,NULL,NULL,'2026-06-08T22:06:39.081Z','2026-06-08T22:06:39.081Z');
INSERT INTO "documents" ("id","slug","title","summary","description","version","status","classification","access_class","source_object","source_sha256","generated_prefix","licence_terms_version","is_listed","allow_redownload","max_redownloads","requires_approval","current_version_of","supersedes_document_id","superseded_by_document_id","created_at","updated_at") VALUES('example-private-paid-document','example-private-paid-document','Example Private Paid Document',NULL,NULL,'0.1','disabled','restricted','paid_verified','docs/originals/private/example-private-paid-document-v0.1.pdf',NULL,'docs/generated/paid/','CDAS-LICENCE-v0.1',0,0,3,1,NULL,NULL,NULL,'2026-06-08T22:06:39.081Z','2026-06-08T22:06:39.081Z');
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
INSERT INTO "licence_terms" ("id","version","title","body","body_sha256","status","applies_to_access_class","effective_from","effective_to","created_at","retired_at","notes") VALUES('lt_cdas_v0_1','CDAS-LICENCE-v0.1','RelayHub Individual Document Licence v0.1','This document is individually licensed to the named licence holder. The licence holder may read and retain the document for personal, organisational, review, educational, or evaluation purposes as permitted by RelayHub. The licence holder must not redistribute, republish, resell, modify, remove licence markings from, or present this document as their own work or authority without written permission from RelayHub. RelayHub may revoke future access where misuse, redistribution, incorrect recipient details, or policy breach is identified. Revocation does not erase historical audit records and does not imply technical recall of already downloaded copies.',NULL,'superseded','controlled_verified',NULL,NULL,'2026-06-07 21:09:32','2026-06-08 22:34:16','Initial CDAS licence terms for controlled verified documents. Superseded by FREE-PUBLIC-DISTRIBUTION-v0.1 template.');
INSERT INTO "licence_terms" ("id","version","title","body","body_sha256","status","applies_to_access_class","effective_from","effective_to","created_at","retired_at","notes") VALUES('lt_free_public_distribution_v0_1','FREE-PUBLIC-DISTRIBUTION-v0.1','RelayHub Free Public Distribution Licence v0.1',replace('FREE PUBLIC DISTRIBUTION LICENCE\n\nDocument Title: {{DOCUMENT_TITLE}}\n\nVersion: {{DOCUMENT_VERSION}}\n\nCopyright © {{YEAR}} {{COPYRIGHT_HOLDER}}\n\nAll rights reserved.\n\nLICENCE TYPE\n\nFree Public Distribution Licence\n\nThis document is provided free of charge to support learning, community development, discussion, research, and participation within the RelayHub ecosystem.\n\nThe copyright holder grants permission to download, store, read, print, and redistribute this document subject to the conditions below.\n\nPURPOSE\n\nThis document exists to help people understand, evaluate, discuss, and participate in the ideas, projects, communities, and technologies described within it.\n\nSharing is encouraged.\n\nAttribution is required.\n\nOWNERSHIP\n\nOwnership of this document and all associated intellectual property remains with the copyright holder.\n\nDownloading, receiving, or sharing this document does not transfer ownership of any intellectual property rights.\n\nPERMITTED USES\n\nYou may:\n• Download this document.\n• Store this document.\n• Print this document.\n• Share this document with others.\n• Email this document to others.\n• Provide copies to friends, family, colleagues, communities, organisations, schools, clubs, and associations.\n• Host copies for redistribution provided the document remains complete and unmodified.\n• Use the document for educational purposes.\n• Quote reasonable excerpts with attribution.\n• Reference the document in articles, presentations, reports, videos, podcasts, and other publications.\n\nREDISTRIBUTION RIGHTS\n\nRedistribution is expressly permitted provided that:\n• the document remains complete,\n• the document remains unmodified,\n• attribution remains intact,\n• copyright notices remain intact,\n• licence notices remain intact,\n• branding remains intact where applicable,\n• version information remains intact.\n\nRedistribution should include a reference to the official source where practical.\n\nATTRIBUTION REQUIREMENT\n\nAny redistribution should identify the original source as:\n\n{{COPYRIGHT_HOLDER}}\n\nand where applicable:\n\n{{OFFICIAL_WEBSITE}}\n\nATTRIBUTION MUST NOT BE REMOVED.\n\nPROHIBITED USES\n\nYou may not:\n• Claim authorship of the document.\n• Remove copyright notices.\n• Remove attribution notices.\n• Remove licence notices.\n• Remove branding where applicable.\n• Remove identifying metadata.\n• Sell the document by itself.\n• Misrepresent the document as your own work.\n• Publish modified versions as if they were the original document.\n• Create confusion regarding authorship, ownership, endorsement, or official status.\n\nMODIFIED VERSIONS\n\nYou may create notes, commentary, reviews, analyses, summaries, or derivative works based upon the ideas contained within the document.\n\nHowever:\n• modified versions must be clearly identified as modified,\n• modified versions must not be presented as official versions,\n• modified versions must not imply endorsement by the copyright holder.\n\nPERSONALISED COPY INFORMATION\n\nThis copy may contain identifying information relating to the person who downloaded it.\n\nSuch information may include:\n• recipient name,\n• recipient email address,\n• download identifier,\n• download date,\n• watermark information,\n• embedded metadata.\n\nThese identifiers support ecosystem analytics, document improvement, intellectual property protection, and operational administration.\n\nLATEST VERSION\nThe latest official version of this document may be available from:\n\n{{OFFICIAL_WEBSITE}}\n\nReaders are encouraged to obtain current versions directly from the official source.\n\nNO WARRANTY\n\nThis document is provided for informational and educational purposes.\n\nWhile reasonable efforts have been made to ensure accuracy, no warranty is provided regarding:\n• completeness,\n• accuracy,\n• suitability,\n• future availability,\n• fitness for a particular purpose.\n\nLIMITATION OF LIABILITY\n\nTo the maximum extent permitted by law, the copyright holder shall not be liable for any loss, damage, cost, or consequence arising from the use of this document.\n\nCONTACT\n\nQuestions regarding attribution, redistribution, licensing, translations, derivative works, or official versions may be directed to:\n\n{{CONTACT_EMAIL}}\n\nFINAL NOTE\n\nPlease share this document.\n\nRelayHub grows through voluntary participation, learning, cooperation, and community building.\n\nHelp others discover the ideas, tools, and communities that can strengthen local resilience and human flourishing.\n\nEND OF FREE PUBLIC DISTRIBUTION LICENCE','\n',char(10)),'946b164fcad39563e6cd1ab8ab397177a9a21938552654e5dea54a7c8af43050','active','licensed_public','2026-06-08 22:34:16',NULL,'2026-06-08 22:34:16',NULL,'Reusable Free Public Distribution Licence template. Placeholders are intentionally preserved and rendered per document before display, acceptance, or download.');
INSERT INTO "licence_terms" ("id","version","title","body","body_sha256","status","applies_to_access_class","effective_from","effective_to","created_at","retired_at","notes") VALUES('lt_commercial_use_v0_1','COMMERCIAL-USE-v0.1','RelayHub Commercial Use Licence v0.1',replace('COMMERCIAL USE LICENCE\n\nDocument Title: {{DOCUMENT_TITLE}}\n\nVersion: {{DOCUMENT_VERSION}}\n\nCopyright © {{YEAR}} {{COPYRIGHT_HOLDER}}\n\nAll rights reserved.\n\nLICENCE TYPE\n\nCommercial Use Licence\n\nThis licence grants expanded commercial rights to the organisation or individual identified below.\n\nLICENCE HOLDER\n\nLicensed Organisation:\n{{LICENSED_ORGANISATION}}\n\nAuthorised Contact:\n{{LICENSED_NAME}}\n\nEmail:\n{{LICENSED_EMAIL}}\n\nDownload ID:\n{{DOWNLOAD_ID}}\n\nOrder Number:\n{{ORDER_NUMBER}}\n\nLicence Date:\n{{LICENCE_DATE}}\n\nPERMITTED USES\n\nThe licence holder may:\n\n• Download, store, and print copies of the document.\n• Use the document internally within their organisation.\n• Share the document with employees, officers, contractors, directors, and consultants working for the licensed organisation.\n• Use the document within commercial operations.\n• Use the document as a reference when delivering services to clients.\n• Use concepts, methods, frameworks, templates, and processes described within the document.\n• Produce internal derivative works based upon the information contained within the document.\n• Retain archival copies for backup and compliance purposes.\n\nRESTRICTIONS\n\nThe licence holder may not:\n\n• Redistribute the original document publicly.\n• Publish the document online.\n• Sell copies of the document.\n• Offer the document for download.\n• Remove copyright notices, watermarks, attribution notices, licence information, or identifying metadata.\n• Claim authorship of the original document.\n• Represent the document itself as a product created by the licence holder.\n\nCLIENT DISTRIBUTION\n\nUnless explicitly authorised in writing, this licence does not permit distribution of the original document to clients, customers, students, members, or third parties.\n\nWhere client distribution rights are required, an Enterprise Redistribution Licence must be obtained.\n\nPERSONALISED COPY NOTICE\n\nThis copy contains identifying information associated with the licence holder and may contain:\n\n• organisation name,\n• authorised contact details,\n• licence identifiers,\n• transaction identifiers,\n• watermark information,\n• embedded metadata.\n\nNO TRANSFER OF OWNERSHIP\n\nPurchase grants a licence to use the document.\n\nPurchase does not transfer ownership of the intellectual property.\n\nAll copyright, moral rights, and associated intellectual property remain the property of the copyright holder.\n\nEND OF COMMERCIAL USE LICENCE\n\n','\n',char(10)),'9599e2e0aacda6d6c94d08d10b6822a73efb653590c5748b1f72ac83342df690','active','paid_verified','2026-06-08 22:38:28',NULL,'2026-06-08 22:38:28',NULL,'Reusable Commercial Use Licence template. Placeholders are intentionally preserved and rendered per document, licence holder, order, and download.');
INSERT INTO "licence_terms" ("id","version","title","body","body_sha256","status","applies_to_access_class","effective_from","effective_to","created_at","retired_at","notes") VALUES('lt_enterprise_redistribution_v0_1','ENTERPRISE-REDISTRIBUTION-v0.1','RelayHub Enterprise Redistribution Licence v0.1',replace('ENTERPRISE REDISTRIBUTION LICENCE\n\nDocument Title: {{DOCUMENT_TITLE}}\n\nVersion: {{DOCUMENT_VERSION}}\n\nCopyright © {{YEAR}} {{COPYRIGHT_HOLDER}}\n\nAll rights reserved.\n\nLICENCE TYPE\n\nEnterprise Redistribution Licence\n\nThis licence grants expanded rights to reproduce and distribute the licensed document within the scope defined below.\n\nLICENCE HOLDER\n\nLicensed Organisation:\n{{LICENSED_ORGANISATION}}\n\nAuthorised Representative:\n{{LICENSED_NAME}}\n\nEmail:\n{{LICENSED_EMAIL}}\n\nLicence Number:\n{{LICENCE_NUMBER}}\n\nDownload ID:\n{{DOWNLOAD_ID}}\n\nOrder Number:\n{{ORDER_NUMBER}}\n\nLicence Date:\n{{LICENCE_DATE}}\n\nLICENCE PURPOSE\n\nThis licence is intended for organisations that require the ability to distribute copies of the licensed document to employees, members, students, clients, customers, participants, affiliates, contractors, or other authorised recipients.\n\nThis licence expands redistribution rights beyond those available under Personal Use and Commercial Use licences.\n\nPERMITTED USES\n\nThe licence holder may:\n\n• Download, store, print, and archive copies of the document.\n• Use the document internally within the organisation.\n• Provide copies of the document to employees, officers, directors, contractors, consultants, and authorised representatives.\n• Distribute copies to students, trainees, members, clients, customers, programme participants, and other authorised recipients.\n• Include the document within internal training programmes.\n• Include the document within paid training programmes.\n• Use the document as supporting material within consulting engagements.\n• Provide copies to project stakeholders where relevant to the organisation''s activities.\n• Store the document within internal document management systems.\n• Store the document within internal learning management systems.\n• Create reasonable backup copies for continuity, recovery, and compliance purposes.\n\nREDISTRIBUTION RIGHTS\n\nThe licence holder may redistribute the document in its complete and unmodified form to authorised recipients.\n\nRecipients do not obtain ownership of the intellectual property.\n\nRecipients receive only a limited right to use the distributed copy under the authority of the licence holder.\n\nINTELLECTUAL PROPERTY OWNERSHIP\n\nAll copyright, moral rights, trademarks, branding, and intellectual property remain the sole property of the copyright holder.\n\nNothing in this licence transfers ownership of intellectual property.\n\nATTRIBUTION REQUIREMENTS\n\nAll distributed copies must retain:\n\n• copyright notices,\n• attribution statements,\n• licence notices,\n• branding elements where applicable,\n• watermark information where applicable,\n• version information.\n\nAttribution may not be removed, obscured, altered, or replaced.\n\nPROHIBITED USES\n\nThe licence holder may not:\n\n• Claim authorship of the original document.\n• Remove copyright notices.\n• Remove attribution notices.\n• Remove identifying metadata.\n• Sell ownership of the document.\n• Transfer intellectual property rights.\n• Publish the document as the licence holder''s own work.\n• Remove licence notices from distributed copies.\n• Misrepresent the relationship between the licence holder and the copyright holder.\n\nDOCUMENT MODIFICATION\n\nUnless explicitly authorised in writing, this licence does not permit:\n\n• modification of the original document,\n• publication of modified versions,\n• creation of derivative commercial publications,\n• rebranding of the original document.\n\nAuthorised excerpts may be used for educational, training, reporting, and consulting purposes provided attribution is maintained.\n\nPERSONALISED IDENTIFIERS\n\nDistributed copies may contain:\n\n• licence identifiers,\n• organisation identifiers,\n• distribution identifiers,\n• watermark information,\n• embedded metadata,\n• transaction references.\n\nThese identifiers exist to support licence administration, version management, intellectual property protection, and auditability.\n\nAUDIT RIGHTS\n\nThe copyright holder may request reasonable evidence demonstrating compliance with the terms of this licence.\n\nSuch evidence may include:\n\n• approximate distribution numbers,\n• recipient categories,\n• deployment scope,\n• current licence status.\n\nCONFIDENTIALITY\n\nWhere the document contains confidential, proprietary, restricted, or non-public information, the licence holder remains responsible for ensuring distribution only to authorised recipients.\n\nNO WARRANTY\n\nThis document is provided "as is".\n\nNo warranty is provided regarding:\n\n• completeness,\n• suitability,\n• legal compliance,\n• commercial outcomes,\n• fitness for a particular purpose.\n\nLIMITATION OF LIABILITY\n\nTo the maximum extent permitted by law, the copyright holder shall not be liable for any direct, indirect, incidental, consequential, or special damages arising from the use of this document.\n\nLICENCE TERMINATION\n\nThis licence may be terminated if the licence holder materially breaches the terms of this agreement.\n\nUpon termination:\n\n• redistribution rights cease,\n• future distributions must stop,\n• existing lawful recipients may continue using previously distributed copies unless otherwise required by law.\n\nCONTACT\n\nLicensing Enquiries:\n{{CONTACT_EMAIL}}\n\nEND OF ENTERPRISE REDISTRIBUTION LICENCE\n\n','\n',char(10)),'c9e59b0ef3e47c943749866b3223ed1927bdc2a334eb83ec9ff0ceb1af1c741d','active','approval_required','2026-06-08 22:38:28',NULL,'2026-06-08 22:38:28',NULL,'Reusable Enterprise Redistribution Licence template. Placeholders are intentionally preserved and rendered per document, organisation, licence, order, and download.');
INSERT INTO "licence_terms" ("id","version","title","body","body_sha256","status","applies_to_access_class","effective_from","effective_to","created_at","retired_at","notes") VALUES('lt_personal_use_v0_1','PERSONAL-USE-v0.1','RelayHub Personal Use Licence v0.1',replace('PERSONAL USE LICENCE\n\nDocument Title: {{DOCUMENT_TITLE}}\n\nVersion: {{DOCUMENT_VERSION}}\n\nCopyright © {{YEAR}} {{COPYRIGHT_HOLDER}}\n\nAll rights reserved.\n\nLICENCE TYPE\n\nPersonal Use Licence\n\nThis document is licensed to the individual identified below.\n\nThe licence is personal, non-exclusive, non-transferable, revocable for breach, and subject to the terms of this licence.\n\nLICENCE HOLDER\n\nLicensed To:\n{{LICENSED_NAME}}\n\nEmail:\n{{LICENSED_EMAIL}}\n\nDownload ID:\n{{DOWNLOAD_ID}}\n\nOrder Number:\n{{ORDER_NUMBER}}\n\nLicence Date:\n{{LICENCE_DATE}}\n\nPERMITTED USES\n\nThe licence holder may:\n\n• Download and store copies of this document for personal use.\n• Print copies for personal use.\n• Use the information contained within the document for personal study, education, research, planning, and implementation.\n• Use the information contained within the document within their own household or for their own personal projects.\n• Retain archival copies for backup purposes.\n\nPROHIBITED USES\n\nThe licence holder may not:\n\n• Share this document with any other person.\n• Provide copies to family members, friends, colleagues, clients, contractors, employees, organisations, or communities.\n• Upload the document to any website, repository, cloud service, forum, messaging platform, or file sharing service.\n• Redistribute the document in whole or in part.\n• Sell, rent, lease, sublicense, or otherwise transfer the document.\n• Include substantial portions of the document within another publication.\n• Remove copyright notices, watermarks, attribution notices, metadata, download identifiers, or licence information.\n• Use the document as part of a commercial training programme.\n• Use the document within a consulting engagement where the document itself is provided to a client.\n• Represent the document as their own work.\n\nPERSONALISED COPY NOTICE\n\nThis copy contains identifying information associated with the licence holder.\n\nThe document may contain visible and invisible identifiers including:\n\n• name,\n• email address,\n• download identifier,\n• order identifier,\n• transaction references,\n• watermark information,\n• embedded metadata.\n\nUNAUTHORISED DISTRIBUTION\n\nUnauthorised redistribution may result in:\n\n• licence termination,\n• loss of update eligibility,\n• denial of future purchases,\n• copyright enforcement action,\n• recovery of damages where permitted by law.\n\nNO TRANSFER OF OWNERSHIP\n\nPurchase grants a licence to use the document.\n\nPurchase does not transfer ownership of the intellectual property.\n\nAll copyright, moral rights, and associated intellectual property remain the property of the copyright holder.\n\nEND OF PERSONAL USE LICENCE\n\n','\n',char(10)),'999ff1dc07a7a66e0a7f5173dcb6e8e567455a2022f79313b2f3d7b317d35645','active','paid_verified','2026-06-08 22:38:28',NULL,'2026-06-08 22:38:28',NULL,'Reusable Personal Use Licence template. Placeholders are intentionally preserved and rendered per document, licence holder, order, and download.');
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
INSERT INTO "document_access_requests" ("id","document_id","document_version","name","email","email_normalised","licence_holder_type","organisation_name","contact_name","contact_email","role_title","recipient_category","status","access_class","verification_token_hash","verification_sent_at","email_verified_at","email_delivery_status","requested_at","expires_at","approved_at","approved_by","approval_role","approval_policy_version","approval_note","denied_at","denied_by","denial_reason","terms_version","terms_accepted_at","terms_acceptance_ip_hash","terms_acceptance_user_agent","ip_hash","user_agent","risk_score","risk_flags") VALUES('dar_mq5tq3xu_8c8867c5ae0d461a','relayhub-overview','0.2','Test User','test@example.com','test@example.com','individual',NULL,'Test User','test@example.com',NULL,'supporter','email_pending','licensed_public',NULL,NULL,NULL,NULL,'2026-06-08T23:10:08.754Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'FREE-PUBLIC-DISTRIBUTION-v0.1','2026-06-08T23:10:08.754Z','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0',0,'[]');
INSERT INTO "document_access_requests" ("id","document_id","document_version","name","email","email_normalised","licence_holder_type","organisation_name","contact_name","contact_email","role_title","recipient_category","status","access_class","verification_token_hash","verification_sent_at","email_verified_at","email_delivery_status","requested_at","expires_at","approved_at","approved_by","approval_role","approval_policy_version","approval_note","denied_at","denied_by","denial_reason","terms_version","terms_accepted_at","terms_acceptance_ip_hash","terms_acceptance_user_agent","ip_hash","user_agent","risk_score","risk_flags") VALUES('dar_mq5tqqka_53d5492a12f1225a','relayhub-overview','0.2','Test User','test@example.com','test@example.com','individual',NULL,'Test User','test@example.com',NULL,'supporter','email_pending','licensed_public',NULL,NULL,NULL,NULL,'2026-06-08T23:10:38.074Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'FREE-PUBLIC-DISTRIBUTION-v0.1','2026-06-08T23:10:38.074Z','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0',0,'[]');
INSERT INTO "document_access_requests" ("id","document_id","document_version","name","email","email_normalised","licence_holder_type","organisation_name","contact_name","contact_email","role_title","recipient_category","status","access_class","verification_token_hash","verification_sent_at","email_verified_at","email_delivery_status","requested_at","expires_at","approved_at","approved_by","approval_role","approval_policy_version","approval_note","denied_at","denied_by","denial_reason","terms_version","terms_accepted_at","terms_acceptance_ip_hash","terms_acceptance_user_agent","ip_hash","user_agent","risk_score","risk_flags") VALUES('dar_mq5ubqct_5635142d7fa08ea5','relayhub-overview','0.2','Andrew Rigg','aj5rigg@gmail.com','aj5rigg@gmail.com','individual',NULL,'Andrew Rigg','aj5rigg@gmail.com',NULL,'supporter','email_pending','licensed_public',NULL,NULL,NULL,NULL,'2026-06-08T23:26:57.581Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'FREE-PUBLIC-DISTRIBUTION-v0.1','2026-06-08T23:26:57.581Z','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',0,'[]');
INSERT INTO "document_access_requests" ("id","document_id","document_version","name","email","email_normalised","licence_holder_type","organisation_name","contact_name","contact_email","role_title","recipient_category","status","access_class","verification_token_hash","verification_sent_at","email_verified_at","email_delivery_status","requested_at","expires_at","approved_at","approved_by","approval_role","approval_policy_version","approval_note","denied_at","denied_by","denial_reason","terms_version","terms_accepted_at","terms_acceptance_ip_hash","terms_acceptance_user_agent","ip_hash","user_agent","risk_score","risk_flags") VALUES('dar_mq5uq1c7_7bd1108172edcb4c','relayhub-overview','0.2','Andrew Rigg','aj5rigg@gmail.com','aj5rigg@gmail.com','individual',NULL,'Andrew Rigg','aj5rigg@gmail.com',NULL,'supporter','email_pending','licensed_public',NULL,NULL,NULL,NULL,'2026-06-08T23:38:04.999Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'FREE-PUBLIC-DISTRIBUTION-v0.1','2026-06-08T23:38:04.999Z','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',0,'[]');
INSERT INTO "document_access_requests" ("id","document_id","document_version","name","email","email_normalised","licence_holder_type","organisation_name","contact_name","contact_email","role_title","recipient_category","status","access_class","verification_token_hash","verification_sent_at","email_verified_at","email_delivery_status","requested_at","expires_at","approved_at","approved_by","approval_role","approval_policy_version","approval_note","denied_at","denied_by","denial_reason","terms_version","terms_accepted_at","terms_acceptance_ip_hash","terms_acceptance_user_agent","ip_hash","user_agent","risk_score","risk_flags") VALUES('dar_mq5utl79_2cb03fdf352c1bda','relayhub-overview','0.2','Test User','test@example.com','test@example.com','individual',NULL,'Test User','test@example.com',NULL,'supporter','email_pending','licensed_public','47df4d8f7bd87c2aea7b0cdc5b603baa3850c8495dda9f4294beed1232d97ce3',NULL,NULL,'verification_token_generated_email_not_sent','2026-06-08T23:40:50.709Z','2026-06-09T23:40:50.709Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'FREE-PUBLIC-DISTRIBUTION-v0.1','2026-06-08T23:40:50.709Z','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','curl/8.18.0',0,'[]');
INSERT INTO "document_access_requests" ("id","document_id","document_version","name","email","email_normalised","licence_holder_type","organisation_name","contact_name","contact_email","role_title","recipient_category","status","access_class","verification_token_hash","verification_sent_at","email_verified_at","email_delivery_status","requested_at","expires_at","approved_at","approved_by","approval_role","approval_policy_version","approval_note","denied_at","denied_by","denial_reason","terms_version","terms_accepted_at","terms_acceptance_ip_hash","terms_acceptance_user_agent","ip_hash","user_agent","risk_score","risk_flags") VALUES('dar_mq5wn05a_764064042ab29edb','relayhub-overview','0.2','Andrew Rigg','aj5rigg@gmail.com','aj5rigg@gmail.com','individual',NULL,'Andrew Rigg','aj5rigg@gmail.com',NULL,'supporter','email_pending','licensed_public','186e5eb34331204dbcd38c16fa4f797e53eaf6396dd478011ed4a5c6e0ccdffb',NULL,NULL,'verification_token_generated_email_not_sent','2026-06-09T00:31:42.718Z','2026-06-10T00:31:42.718Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'FREE-PUBLIC-DISTRIBUTION-v0.1','2026-06-09T00:31:42.718Z','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0','c08e09c554627a59f3f0bf9f43322dfbdf4426190aa0c8c3ccf1ba4a8ae6cd3b','Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',0,'[]');
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
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',5);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('early_access_signups',6);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('contact_messages',3);
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
CREATE INDEX idx_documents_is_listed
ON documents(is_listed);
CREATE INDEX idx_document_access_requests_document_id
ON document_access_requests(document_id);
CREATE INDEX idx_document_access_requests_email_normalised
ON document_access_requests(email_normalised);
CREATE INDEX idx_document_access_requests_expires_at
ON document_access_requests(expires_at);
CREATE INDEX idx_document_licences_licence_number
ON document_licences(licence_number);
CREATE INDEX idx_document_licences_document_id
ON document_licences(document_id);
CREATE INDEX idx_document_licences_email_normalised
ON document_licences(licence_holder_email_normalised);
CREATE INDEX idx_document_download_links_licence_id
ON document_download_links(licence_id);
CREATE INDEX idx_document_download_links_document_id
ON document_download_links(document_id);
CREATE INDEX idx_document_download_links_token_hash
ON document_download_links(token_hash);
CREATE INDEX idx_document_download_links_expires_at
ON document_download_links(expires_at);
CREATE INDEX idx_document_download_events_licence_id
ON document_download_events(licence_id);
CREATE INDEX idx_document_download_events_document_id
ON document_download_events(document_id);
CREATE INDEX idx_admin_audit_events_admin_identity
ON admin_audit_events(admin_identity);
