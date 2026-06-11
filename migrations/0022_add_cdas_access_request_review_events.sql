-- Migration number: 0022 	 2026-06-11T12:02:02.327Z
/*
 * Phase 3X-0H — Admin review controls for pending requests.
 *
 * Adds an immutable-ish review event trail for manual access-request review.
 *
 * This migration does not:
 * - approve requests automatically,
 * - issue licences,
 * - create download links,
 * - generate PDFs,
 * - email download links.
 */

CREATE TABLE IF NOT EXISTS document_access_request_review_events (
  id TEXT PRIMARY KEY,

  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL,

  previous_status TEXT,
  new_status TEXT,

  actor TEXT,
  reason TEXT,
  note TEXT,
  metadata_json TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CHECK (event_type IN (
    'held',
    'rejected',
    'review_approved',
    'note_added',
    'reopened'
  ))
);

CREATE INDEX IF NOT EXISTS idx_document_access_request_review_events_request
  ON document_access_request_review_events (request_id, created_at);

CREATE INDEX IF NOT EXISTS idx_document_access_request_review_events_type
  ON document_access_request_review_events (event_type, created_at);