-- Tricorder Library (TNGC-23): the D1 side is a metadata INDEX only — one row
-- per saved wall primitive. Payloads (props JSON, e.g. ~30 KB diagram SVGs)
-- live in the R2 bucket `tricorder-library` at r2_key, fronted exclusively by
-- the Worker; they never bloat these rows or the list queries.

CREATE TABLE library_items (
  id          TEXT PRIMARY KEY,          -- li_<uuid-slice>
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  owner_id    TEXT NOT NULL REFERENCES users(id),
  family      TEXT NOT NULL,             -- prose|data|visual|procedure|notation|media
  view        TEXT NOT NULL,             -- the PanelView, verbatim
  title       TEXT NOT NULL,             -- the wall's summary line at save time
  r2_key      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  from_user   TEXT,                      -- sender's handle when received via send
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_library_owner ON library_items (tenant_id, owner_id, created_at DESC);
