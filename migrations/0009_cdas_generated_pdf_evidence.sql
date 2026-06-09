ALTER TABLE document_licences ADD COLUMN source_object TEXT;
ALTER TABLE document_licences ADD COLUMN source_sha256 TEXT;

ALTER TABLE document_licences ADD COLUMN generated_pdf_object_key TEXT;
ALTER TABLE document_licences ADD COLUMN generated_pdf_filename TEXT;
ALTER TABLE document_licences ADD COLUMN generated_pdf_sha256 TEXT;
ALTER TABLE document_licences ADD COLUMN generated_pdf_size_bytes INTEGER;
ALTER TABLE document_licences ADD COLUMN generated_pdf_content_type TEXT;

ALTER TABLE document_licences ADD COLUMN generated_pdf_status TEXT DEFAULT 'not_generated';
ALTER TABLE document_licences ADD COLUMN generated_pdf_created_at TEXT;
ALTER TABLE document_licences ADD COLUMN generated_pdf_error TEXT;