CREATE TABLE IF NOT EXISTS contact_messages (
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

CREATE INDEX IF NOT EXISTS idx_contact_messages_email
ON contact_messages(email);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at
ON contact_messages(created_at);