-- Identity v2 (TNGC-15): users own passwords and roles; devices become sessions.
-- Users, not devices, are the identity anchor — a "device" is only a session
-- label ("leif @ desktop"). Clean reshape: pre-launch, only test data exists,
-- so the seeded device rows are dropped, not migrated.

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until INTEGER;

DROP TABLE devices;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  device_label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Reseed the household: placeholders out, ariel in (passwords set out-of-band —
-- hashes never live in a migration file).
DELETE FROM users WHERE id IN ('u_mom', 'u_joe');
UPDATE users SET role = 'admin' WHERE id = 'u_leif';
UPDATE users SET role = 'guest' WHERE id = 'u_guest';
INSERT INTO users (id, tenant_id, handle, name, created_at, role)
  SELECT 'u_ariel', id, 'ariel', 'Ariel', strftime('%s', 'now') * 1000, 'member'
    FROM tenants WHERE id = 'home';
