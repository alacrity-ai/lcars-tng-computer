-- Guest QR invites (TNGC-57). The house mints one with the service token, the
-- wall shows it as a QR, and a guest's phone trades it for a normal guest
-- session — no password ever spoken, typed, or photographed off the wall.
--
-- Same at-rest rule as sessions and pair codes: only the SHA-256 lives here.
-- Unlike pair codes an invite is MULTI-claim (a party is many phones) but
-- capped and short-lived, and minting deletes this tenant's predecessors so
-- there is never more than one live door.
CREATE TABLE guest_invites (
  id          TEXT PRIMARY KEY,          -- gi_<uuid-slice>
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  max_claims  INTEGER NOT NULL,
  claims      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_guest_invites_tenant ON guest_invites (tenant_id, created_at DESC);
