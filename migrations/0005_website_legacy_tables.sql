-- RelayHub Website Legacy Tables
-- Migration: 0005_website_legacy_tables.sql
--
-- Purpose:
-- Restores/creates the non-CDAS website tables used by:
-- /api/early-access
-- /api/contact
-- /api/free-download
-- /api/download/:token
-- /api/admin/newsletter
-- /api/admin/contact
-- /api/admin/downloads
-- /api/admin/download-registry

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. Early Access Requests
-- ============================================================

CREATE TABLE IF NOT EXISTS early_access_requests (
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

CREATE INDEX IF NOT EXISTS idx_early_access_requests_email
ON early_access_requests(email);

CREATE INDEX IF NOT EXISTS idx_early_access_requests_created_at
ON early_access_requests(created_at);


-- ============================================================
-- 2. Contact Messages
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT NOT NULL,
  subject TEXT,
  message TEXT,
  created_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_email
ON contact_messages(email);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
ON contact_messages(created_at);


-- ============================================================
-- 3. Legacy Download Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS download_registry (
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

CREATE INDEX IF NOT EXISTS idx_download_registry_document_id
ON download_registry(document_id);

CREATE INDEX IF NOT EXISTS idx_download_registry_email
ON download_registry(email);

CREATE INDEX IF NOT EXISTS idx_download_registry_token_hash
ON download_registry(token_hash);

CREATE INDEX IF NOT EXISTS idx_download_registry_status
ON download_registry(status);

CREATE INDEX IF NOT EXISTS idx_download_registry_issued_at
ON download_registry(issued_at);


-- ============================================================
-- 4. Legacy Download Events
-- ============================================================

CREATE TABLE IF NOT EXISTS download_events (
  id TEXT PRIMARY KEY,
  registry_id TEXT,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_download_events_registry_id
ON download_events(registry_id);

CREATE INDEX IF NOT EXISTS idx_download_events_event_type
ON download_events(event_type);

CREATE INDEX IF NOT EXISTS idx_download_events_event_at
ON download_events(event_at);