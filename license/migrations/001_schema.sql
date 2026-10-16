CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_ciphertext TEXT NOT NULL,
  code_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled', 'expired')),
  expires_at TIMESTAMPTZ,
  valid_for_days INTEGER CHECK (valid_for_days IS NULL OR valid_for_days > 0),
  activated_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT ''
);
INSERT INTO settings (id, contact_email, contact_phone) VALUES (1, '', '') ON CONFLICT DO NOTHING;
