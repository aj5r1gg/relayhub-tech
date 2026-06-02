CREATE TABLE IF NOT EXISTS early_access_signups (
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

CREATE INDEX IF NOT EXISTS idx_early_access_email
ON early_access_signups(email);

CREATE INDEX IF NOT EXISTS idx_early_access_created_at
ON early_access_signups(created_at);