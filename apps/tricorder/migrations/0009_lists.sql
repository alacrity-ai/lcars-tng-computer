-- Family lists (TNGC-63): shopping, chores, packing, todo. Same shape of
-- ownership as the calendar — tenant-scoped, written by the Computer's tool
-- (service plane) and by household members (session plane), never guests.
CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,                -- lenient vocabulary; NULL when unknown
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One "shopping" per household, case-insensitively — voice resolves lists by
-- name, so a dupe would make "add milk to the shopping list" ambiguous.
CREATE UNIQUE INDEX idx_lists_tenant_name ON lists (tenant_id, lower(name));

CREATE TABLE list_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  list_id TEXT NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  checked_by TEXT,              -- who claimed it ("who bought the milk")
  checked_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_list_items_list ON list_items (tenant_id, list_id, created_at);
