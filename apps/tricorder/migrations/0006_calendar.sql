-- TNGC-46: the family calendar. Events are tenant-scoped, wall-clock local
-- (date + optional time strings, no timezone conversion — it's a house
-- calendar), with a single optional category from the shared vocabulary.
-- Written by the house (service plane) this era; member writes arrive with
-- the deterministic tricorder plugin follow-up.

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,            -- YYYY-MM-DD
  time TEXT,                     -- HH:MM (24h), NULL = all-day
  end_time TEXT,                 -- HH:MM (24h), optional
  location TEXT,
  category TEXT,                 -- from CALENDAR_CATEGORIES, else NULL
  notes TEXT,
  created_by TEXT NOT NULL,      -- user handle (attribution), or "computer"
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_calendar_tenant_date ON calendar_events (tenant_id, date);
