-- TNGC-40: tricorder plugins — the cloud's half of the control plane.
-- Availability is bridge-reported live (never stored here); these tables hold
-- which available plugins each household admin has switched on, and who
-- issued which control op ("who turned the house dark at 11pm").

CREATE TABLE tenant_plugins (
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, plugin_id)
);

CREATE TABLE control_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  op TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_control_log_tenant_time ON control_log (tenant_id, created_at);
