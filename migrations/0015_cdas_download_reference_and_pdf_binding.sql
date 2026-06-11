-- CDAS Phase 3W-G1
-- Add human-facing download references and generated-PDF evidence binding
-- to document_download_links.

ALTER TABLE document_download_links
ADD COLUMN download_reference TEXT;

ALTER TABLE document_download_links
ADD COLUMN activated_at TEXT;

ALTER TABLE document_download_links
ADD COLUMN generated_pdf_object_key TEXT;

ALTER TABLE document_download_links
ADD COLUMN generated_pdf_sha256 TEXT;

ALTER TABLE document_download_links
ADD COLUMN generated_pdf_size_bytes INTEGER;

ALTER TABLE document_download_links
ADD COLUMN generated_pdf_created_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_download_links_download_reference
ON document_download_links(download_reference);

CREATE INDEX IF NOT EXISTS idx_document_download_links_status
ON document_download_links(status);

CREATE INDEX IF NOT EXISTS idx_document_download_links_licence_status
ON document_download_links(licence_id, status);