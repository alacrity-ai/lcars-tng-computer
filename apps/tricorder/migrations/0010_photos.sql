-- Family photos (TNGC-64): D1 index rows for R2 objects at
-- photos/<tenant>/<id> in the tricorder-library bucket. `secret` makes each
-- photo a capability URL (/api/photos/raw/<id>/<secret>) so plain <img> tags
-- on walls and phones can fetch it without a bearer header — unguessable,
-- revoked by deletion.
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  album TEXT,
  taken_at INTEGER NOT NULL,    -- ms epoch; client-supplied (file date), upload time as fallback
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_photos_tenant_taken ON photos (tenant_id, taken_at DESC);
