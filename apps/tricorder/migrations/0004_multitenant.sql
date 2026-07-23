-- Multi-tenant self-serve plane (TNGC-29). Tenants gain a public slug (typed
-- at login to disambiguate handles across households); self-registered admins
-- gain an email + verification state. Household members created in the admin
-- console still have no email — nothing changes for them.

ALTER TABLE tenants ADD COLUMN slug TEXT;
ALTER TABLE tenants ADD COLUMN created_ip TEXT;
UPDATE tenants SET slug = id WHERE slug IS NULL;
CREATE UNIQUE INDEX idx_tenants_slug ON tenants (slug);

ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
CREATE UNIQUE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;

-- Pairing codes (single-use, short TTL, stored hashed): the human types the
-- code into the house wizard; the wizard trades it for the service token.
CREATE TABLE pair_codes (
  id          TEXT PRIMARY KEY,          -- pc_<uuid-slice>
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  code_hash   TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_pair_codes_tenant ON pair_codes (tenant_id, created_at DESC);

-- Email verification tokens (hashed, 24h TTL, single-use).
CREATE TABLE email_tokens (
  id          TEXT PRIMARY KEY,          -- et_<uuid-slice>
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  purpose     TEXT NOT NULL,             -- 'verify'
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX idx_email_tokens_user ON email_tokens (user_id, created_at DESC);

-- Fixed-window throttle counters for the public endpoints (register, pair,
-- resend). D1-backed because Worker isolates share nothing.
CREATE TABLE throttle (
  key          TEXT PRIMARY KEY,         -- e.g. 'register:ip:1.2.3.4'
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
