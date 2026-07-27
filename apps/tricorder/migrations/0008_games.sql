-- TNGC-61: games. LIVE match state does NOT live here — it lives in the
-- TenantHub DO under `game:match`, because the DO is single-threaded per
-- tenant and that is what makes guess ordering exact. D1 gets the epitaph:
-- one row per finished match, for the leaderboard and for "who won last time".

CREATE TABLE game_results (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  game TEXT NOT NULL,
  mode TEXT NOT NULL,
  players INTEGER NOT NULL,
  -- One human line for the PWA: "Leif & Ariel — 7 of 10 for 118".
  summary TEXT NOT NULL,
  -- JSON: final scores per player/team plus the words that came up.
  detail TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX idx_game_results_tenant ON game_results (tenant_id, ended_at DESC);
