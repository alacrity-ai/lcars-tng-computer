# Games plugin + Pictionary — implementation design

Two tickets:

- **Core** — a single `Games` plugin with a submenu, the match engine, the
  wall-push path, and the file layout every future game drops into.
- **Pictionary** — the first game in that frame.

Grounded in a read of `apps/tricorder/src/{worker,hub,calendar}.ts`,
`apps/tricorder/public/index.html`, `packages/contract/src/index.ts`,
`packages/bridge/src/index.ts`, `apps/server/src/routes/console.ts` and
`packages/{shared,panel-renderer}`. Follows the brainstorm in
`GAMES_BRAINSTORM.md` (TNGC-60).

---

## 1. Code audit — what exists, and what it forces

| Fact | Where | Consequence for this design |
|---|---|---|
| Cloud-native plugins need no manifest and no sidecar; they merge into the bridge roster and are always online | `worker.ts:397` `CLOUD_PLUGINS` | `games` is cloud-native, like `calendar`. It must be playable with the Computer switched off. |
| The plugin grid dispatches on plugin id with a hardcoded `if/else` | `index.html:2418` `openPlugins` | One tile, `Games`, opening a **submenu** — so ten games cost one tile, which is exactly what was asked for. |
| The TenantHub DO is single-threaded per tenant and **uses no alarm today** | `hub.ts` — no `alarm()` handler anywhere | The DO is the authoritative game server, and games own the DO alarm. Serialization is free; turn deadlines are an alarm chain. |
| Existing DO flood fuses are sized for voice (`/enqueue` 30/min) and lights (`/control` 60/min) | `hub.ts:174`, `hub.ts:283` | Game traffic **must not** ride those paths. New `/game/*` DO endpoints with game-sized fuses. |
| The bridge already POSTs `/api/console/display` in five places | `bridge/src/index.ts:220,285,434,529` | The wall push needs **no new server work** — a new down-frame the bridge turns into that POST. |
| `/api/console/display` accepts `{view, props, wall}` and broadcasts to the addressed wall | `server/src/routes/console.ts:256` | Game frames are ordinary panel displays. Composite already rate-limits itself at 2/s; games adopt the same ceiling. |
| The MCP `display` tool is `z.enum(PANEL_VIEWS)` | `console-mcp/src/index.ts:135` | A game panel in `PANEL_VIEWS` would become a thing the model can display at random. Needs a machine-only view carve-out. |
| Session bearer tokens carry handle + role; the calendar writes `created_by` from the session, never the body | `calendar.ts:8` | Same rule for games: the actor is the session's handle. A player can never act as someone else. |
| Guest is **one shared account** with one handle | `worker.ts:869` rotate-guest, `guest.ts` | Two guests on two phones are **one player**. Guests stay out of v1 — see §9. |
| A panel ships to the wall (source) *and* the viewscreen (prebuilt `build:vs` bundle) | `docs/sops/adding-new-panels.md` | `build:vs` before deploy, or phones in Viewscreen mode show the stub. |

---

## 2. Shape

```
phone (drawer)  ──POST /api/plugins/games/act──┐
phone (guesser) ──POST … {op:"guess"} ─────────┤
phone (any)     ──GET  …/state?since=N ────────┤
                                               ▼
                                   Worker (auth, role, rebuild)
                                               │
                                               ▼
                                   TenantHub DO  ← the authoritative server
                                     • one active match per tenant
                                     • pure reducer, transactional
                                     • alarm = the turn clock
                                               │
                                    display_props down-frame (≤2/s)
                                               ▼
                                            bridge
                                               │  POST /api/console/display
                                               ▼
                                     house server → the wall
```

Phones **poll**; the wall is **pushed**. There is no server→phone push channel
outside Viewscreen mode (TNGC-60 constraint 3), and building one is not on this
ticket. Polling is honest here: 700 ms during a turn, 2 s otherwise, and reads
are incremental (`?since=`), so a poll during drawing carries only the strokes
that are new.

### Why the DO and not D1

The DO is single-threaded per tenant, so two guesses 4 ms apart are ordered by
arrival with no clock to trust and no transaction to lose. Live match state
lives in DO storage (`game:match`); D1 gets only the **finished** result, for
the leaderboard. Same split as the queue and roster.

### The reducer

All game logic is a **pure function**: `(state, request) → {state, response,
wall?, alarmAt?}`. The DO is a thin transactional shell around it. That makes
the entire rules engine unit-testable with no miniflare, no network and no
clock — the time is an argument.

---

## 3. File and folder layout

The thing a future game author reads. **A new game is one folder and one
registry line.**

```
apps/tricorder/src/games/
  engine.ts          shared types + the match lifecycle every game gets free:
                     Match, Player, phases, join/leave/start/end, scoring,
                     projection, shuffle, normalize, levenshtein
  registry.ts        GAME_REGISTRY: id → GameModule. Add a game here.
  routes.ts          the Hono family mounted at /api/plugins/games
  pictionary/
    index.ts         the GameModule: phases, act handlers, projections, wall props
    words.ts         the word list
  <next-game>/
    index.ts
    …
```

A `GameModule` is the whole contract:

```ts
export interface GameModule<S> {
  id: string;                 // "pictionary" — matches the folder
  name: string;               // "Pictionary"
  blurb: string;              // one line in the submenu
  minPlayers: number;
  maxPlayers: number;
  modes: GameMode[];          // {id, name, minPlayers, hint}
  /** Fresh game-specific state when the host starts the match. */
  begin(m: Match<S>, now: number): Begin<S>;
  /** One player action. Pure. Never trusts anything but `actor`. */
  act(m: Match<S>, actor: Actor, body: unknown, now: number): Act<S>;
  /** The phase deadline fired. */
  expire(m: Match<S>, now: number): Act<S>;
  /** End the match for ANY reason — turns exhausted, the host called it, the
      roster collapsed. Always returns a result row. */
  conclude(m: Match<S>, now: number): Act<S>;
  /** What THIS user may see. The only place secrets are allowed to be dropped. */
  project(m: Match<S>, viewer: string, since: number): unknown;
  /** What the wall may see — never viewer-specific, never secret. */
  wallProps(m: Match<S>): { view: PanelView; props: unknown } | null;
}
```

`project` and `wallProps` being separate functions is the load-bearing safety
property: the secret word is dropped in exactly two places, both of them named
after who is looking.

`conclude` is separate from `expire` for a reason found while testing: ending a
match early (the host stops it, the roster collapses) went through `expire`,
which for pictionary means *start the next turn* — so every game anyone stopped
early vanished without a result row. One entry point for "this match is over,
however it got there" fixes the class, not the instance.

Everything else — the tricorder screens, the wall panel, the D1 result row —
lives where its surface already lives:

```
apps/tricorder/public/index.html                    games submenu + per-game screens
packages/shared/src/index.ts                        PictionaryPanelProps, PANEL_VIEWS
packages/panel-renderer/src/panels/PictionaryPanel.tsx
apps/tricorder/migrations/0008_games.sql            finished-match results only
```

---

## 4. The core (ticket A)

### 4.1 Plugin registration

`games` joins `CLOUD_PLUGINS` in `worker.ts`:

```ts
{ id: "games", name: "Games", online: true,
  tile: { color: "#99ccff",
          icon: { viewBox: "0 0 24 24", paths: [
            "M6 9h12a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3z",
            "M8 12.5v3", "M6.5 14h3", "M16 13h.01", "M18 15h.01" ] } } }
```

`#99ccff` is LCARS sky — distinct from lights `#ff9900`, calendar `#cc99cc`,
claudeops `#9999cc`. The two `h.01` paths render as dots because `tileGlyph`
sets `stroke-linecap: round` (`index.html:2365`).

### 4.2 Routes — `/api/plugins/games/*`

Household members only, tenant-enabled, same gate shape as lights and calendar.

| Route | Who | Does |
|---|---|---|
| `GET /catalog` | any member | the registry: id, name, blurb, player range, modes |
| `GET /state?since=N` | any member | the match projected **for the caller** |
| `POST /match` | any member | create a lobby (409 if one is live) |
| `POST /match/join` | any member | join the lobby |
| `POST /match/leave` | any member | leave; host leaving hands off or ends |
| `POST /match/start` | host | assign teams, begin |
| `POST /match/end` | host or admin | abandon |
| `POST /act` | any player | one game action, dispatched to the module |

Every body is **validated and rebuilt** — no free-form JSON reaches the reducer.
The actor is always `{handle, name, role}` from the session, never the body.

### 4.3 DO endpoints and the alarm

`/game/read`, `/game/write` on the hub, with fuses sized for play (600 reads,
300 writes per minute per tenant — a household of eight polling at 700 ms is
~11 req/s, so this is headroom, not a limit anyone reaches).

`alarm()` lands on the hub for the first time. It reads the match, calls
`expire`, saves, re-arms. **Games own the hub alarm.** A code comment says so,
because the next feature that wants one has to share rather than clobber.

### 4.4 Wall push — the `display_props` down-frame

Additive to `LinkDownFrame`:

```ts
| { v: 1; type: "display_props"; view: string; props: unknown; wall?: string }
```

The bridge turns it into the POST it already makes five times over. The DO
sends at most one every 500 ms and only when a live link exists — the game is
fully playable with the wall dark.

The target wall is the **host's currently selected wall**, captured when the
match is created (the PWA already has a wall selector — `getWall()`,
`index.html:1172`), so the game paints the screen the person who started it was
already talking to.

### 4.5 Machine-only panel views

`PANEL_VIEWS` must cover every view the registry can draw, but the model should
not be able to `display` a pictionary board out of nowhere. So:

```ts
export const PANEL_VIEWS = [ …, "pictionary" ] as const;   // registry totality
export const MACHINE_VIEWS = ["pictionary"] as const;      // driven by machinery
export const DISPLAY_VIEWS = PANEL_VIEWS.filter(v => !MACHINE_VIEWS.includes(v));
```

The MCP tool switches to `z.enum(DISPLAY_VIEWS)`. Every future game panel adds
one line to `MACHINE_VIEWS`.

### 4.6 D1

```sql
-- 0008_games.sql
CREATE TABLE game_results (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, game TEXT NOT NULL,
  mode TEXT NOT NULL, players INTEGER NOT NULL,
  summary TEXT NOT NULL,         -- one human line: "Leif & Ariel — 7 of 10"
  detail TEXT NOT NULL,          -- JSON: final scores per player/team
  started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
CREATE INDEX idx_game_results_tenant ON game_results (tenant_id, ended_at DESC);
```

Live state never goes here. Only the epitaph.

### 4.7 The submenu

`Games` tile → a screen listing the catalog as cards (name, blurb, player range,
and whether a match is already live). Tapping one opens that game's screen. If a
match is already running, every card except the live one is disabled and the
live one reads **Rejoin** — which is also how a phone that died mid-game gets
back in.

---

## 5. Pictionary (ticket B)

### 5.1 The loop

1. **Lobby.** One person taps *Start* → a lobby exists. Others go Plugins →
   Games → Pictionary and tap *Join*. Minimum 2, maximum 8.
2. **Start.** The host picks a mode (defaulted by headcount), teams are shuffled
   if applicable, turn order is fixed.
3. **Turn** (90 s). One drawer, one secret word. The drawer draws on their
   phone; the wall shows the canvas, the clock, the letter mask and the guess
   feed. Guessers type guesses on their phones.
4. **Reveal** (8 s). The word, who got it, points awarded.
5. Repeat until every player has drawn twice (capped at 12 turns), then
   **Over** — final scoreboard on the wall, result row in D1.

### 5.2 Modes — including Leif's 1-on-1

| Mode | Players | How it works |
|---|---|---|
| **Co-op** | 2–3 | No teams. Everyone but the drawer guesses, and every point goes into **one shared total** — you're playing against the clock and against your own best score, not each other. This is the answer to "not quite sure how one-on-one pictionary works": it becomes a two-person co-op run, and D1 remembers the household's best. |
| **Teams** | 4+ | Two teams, auto-shuffled (the host can re-shuffle in the lobby). The drawer's own teammates guess; the other team watches and heckles. Turns alternate teams. |

Headcount picks the default; the host can override where both are legal.

### 5.3 Drawing, and how it gets anywhere

**On the phone.** A `<canvas>` sized to the viewport, pointer events, six colors
and three brush widths, undo and clear. Points are captured in a **0–999
integer grid**, not pixels, so every surface scales the same picture and the
payload is small. Points within 4 units of the previous one are dropped at
capture — a slow finger otherwise emits hundreds of duplicates.

**On the wire.** A stroke is `{c: colorIndex, w: widthIndex, p: [x,y,x,y,…]}`.
The drawer POSTs *new* strokes at ~4 Hz, never the whole picture. Hard caps in
the reducer: 400 strokes, 200 points per stroke, 6000 points per turn — beyond
that the op is refused, because a canvas is an unbounded input from a phone.

**On the way back.** `GET /state?since=N` returns only strokes after index `N`
plus the current count; the client appends and resets when the turn id changes.
So a 700 ms poll during drawing carries a few hundred bytes, not the picture.

**On the wall.** Full stroke list, ≤2/s. The wall stays stateless and always
correct — a wall that comes up mid-turn draws the whole picture on its first
frame, with no catch-up protocol.

### 5.4 Guessing and judging — no model in the loop

Guesses are normalized (lowercase, strip accents and punctuation, collapse
whitespace) and compared exactly. A Levenshtein distance of 1–2 scores nothing
but returns **"so close!"** to that guesser only — which is the single most fun
thing a computer referee can do and costs twenty lines.

The word list is built in (`words.ts`, ~240 drawable nouns across three
difficulty bands), so the game is complete with the Computer switched off. The
brain generating themed packs is a **later** ticket, and it would follow the
brainstorm's rule: generate ahead of play, never inside the loop.

The drawer's own guesses are ignored. The drawer may **skip** (no points, next
turn), which also covers "I have no idea how to draw *entropy*".

### 5.5 Scoring

- Guesser: `10 + floor(secondsRemaining / 9)` → 10–20, so speed pays.
- Drawer: 5 when someone solves it.
- Co-op: everything lands in the shared total (individual tallies still shown).
- Teams: everything lands on the drawer's team.

### 5.6 What each surface shows

| | Wall | Drawer's phone | Guesser's phone |
|---|---|---|---|
| The word | mask `_ _ _ _` | **the word** | mask |
| The canvas | large, live | the drawing surface | live, read-only |
| The clock | large ring | numeric | numeric |
| Guesses | scrolling feed | feed | feed + input |
| Scores | full board | compact | compact |

The word reaches exactly one device, dropped server-side by `project`. It is
never in the wall props, never in another player's payload, and never
recoverable from the guess feed.

### 5.7 Panel

`packages/panel-renderer/src/panels/PictionaryPanel.tsx`, view `pictionary`,
registered in `MACHINE_VIEWS`. Strokes render as one `<path>` per stroke in a
`viewBox="0 0 1000 1000"` SVG — the same integer grid the phone captured in, so
the wall needs no scaling logic. LCARS frame, letter mask in the elbow, timer
ring, guess feed down the side, scoreboard along the bottom.

Per the panels SOP: it must render its own dead state, since a saved or recalled
board is a board from a finished game.

---

## 6. Security posture

| Risk | Handling |
|---|---|
| A guesser reads the secret word | `project` is viewer-scoped; the word is attached only when `viewer === drawer`. `wallProps` has no branch that can emit it. |
| A player acts as another player | The actor is the session handle. The body's idea of who it is, is ignored — the calendar's rule (`calendar.ts:8`). |
| A phone floods strokes | Per-op caps (400/200/6000) in the reducer, plus a DO write fuse (300/min). Refusals are errors, not silent truncation. |
| A phone injects markup through a guess or name | Guesses are text nodes on the phone and text in the panel. `innerHTML` is not used, exactly as with plugin tiles. |
| A guest joins | Guests can't reach `/api/plugins` at all today, and the account is shared — see §9. |
| The wall gets strobed | ≤2/s in the DO, mirroring the composite ceiling the server already enforces. |
| A match outlives interest | Lobbies idle out at 30 min, live matches at 2 h; the alarm reaps them. |

---

## 7. Test plan

**Reducer (pure, no harness).** Full match walk-throughs for both modes;
minimum/maximum headcount; join-after-start; the host leaving; solve, timeout
and skip; the score formula at both ends of the clock; stroke caps refusing at
the boundary; normalization (`"Fire Truck"` = `"firetruck"`? — no, deliberately:
punctuation and case fold, word joins do not); "so close" on distance 1 and 2
but not 3; and the projection tests that matter most: **no projection for a
non-drawer, and no wall props, ever contains the word.**

**Worker (miniflare).** Role gates, tenant scoping (a second tenant can't see
the match), the enable gate, `since=` incrementality, and rejection of a
malformed act body.

**Panel.** SSR render against ugly props — empty strokes, 6000 points, missing
scores, a 40-character word, unicode names.

**End to end.** Two sessions on one local worker playing a full 2-player co-op
match, asserting the wall frames that would have been pushed.

---

## 8. Landing order

1. `build:vs` **then** `wrangler deploy` — the viewscreen bundle is prebuilt and
   the deploy will not build it (TNGC-57).
2. `wrangler d1 migrations apply` for `0008_games.sql`.
3. `make computer` — the bridge changed (the new down-frame).
4. Enable `Games` for the household in the Admin console.

---

## 9. Deferred, deliberately

- **Guests.** The premise of a party game, and the one thing this design refuses
  to do yet — because the guest account is a *single shared identity*
  (`worker.ts:869`), so two guests on two phones would be one player with one
  score. Doing it properly means player identity keyed on the session's device
  rather than the handle, plus a per-plugin `guestAllowed` flag so opening games
  doesn't open lights. Worth its own ticket, and the guest QR makes it a great
  one. Not smuggled into this one.
- **Push to phones.** Polling is fine for a turn game. Red Alert needs a real
  channel; that's TNGC-60's second gap.
- **Model-generated word packs.** The static list ships first so the game works
  with the Computer off.
- **Voice.** No voice control — it was the wrong input for games, which is why
  this exists.
- **Spectator viewscreen.** A phone in Viewscreen mode will render the wall
  panel for free, but it is not a designed surface here.
