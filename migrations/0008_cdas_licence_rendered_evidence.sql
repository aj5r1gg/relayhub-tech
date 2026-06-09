ALTER TABLE document_licences
ADD COLUMN rendered_licence_body TEXT;

ALTER TABLE document_licences
ADD COLUMN rendered_licence_sha256 TEXT;

ALTER TABLE document_licences
ADD COLUMN rendered_terms_body_sha256 TEXT;

ALTER TABLE document_licences
ADD COLUMN rendered_licence_placeholders TEXT;

ALTER TABLE document_licences
ADD COLUMN rendered_licence_unresolved_placeholders TEXT;

ALTER TABLE document_licences
ADD COLUMN rendered_licence_at TEXT;