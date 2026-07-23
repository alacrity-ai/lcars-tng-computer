# Tricorder Library — Implementation Design (final draft)

**Ticket:** TNGC-23 · **Status:** Design approved for build · **Date:** 2026-07-22
**Supersedes:** the Computer's `docs/TRICORDER_LIBRARY_HANDOFF.md` (consumed and deleted per handoff-file lifecycle)
**Companion:** `TRICORDER_LIBRARY_PWA_UX_DESIGN.md` — the phone-side navigation/browsing design (list ergonomics at hundreds of items, search, pagination, renderers, states). Read it before touching `apps/tricorder/public`.
**Prereq reading:** `apps/tricorder/README.md`, `docs/TRICORDER_PLAN.md` §2–3, `apps/server/src/history.ts`

---

## 1. The feature

Standing in the room, a user says **"save to my tricorder"** and whatever primitive is
on the wall — the diagram, the recipe, the table — is captured to that user's personal
library in the Tricorder cloud. The Tricorder PWA gains a **Library screen**: search,
browse by family, open a saved item natively in the app, **send** a copy to another
user, or **display it back on the wall**. Ownership follows the *speaking user* (the
channel event's `user`), never the session owner.

## 2. Non-negotiable constraints

These shaped every decision below; violating any of them is a design regression:

1. **Zero payload bytes through model context.** Saving or re-displaying a ~30 KB
   diagram must never push the SVG through an MCP tool result or tool argument. The
   model handles **ids and titles only**; payloads move machine-to-machine. This is
   the svgAsset lesson (commit 937bf74) extended to the cloud.
2. **The house calls out; nothing on the internet connects in** (TRICORDER_PLAN §2).
   Cloud→house actions ride the existing bridge link, never a new listener.
3. **Secrets stay inside the fenced `computer` container.** The tenant service token
   lives there today (bridge env, injected by `make computer` from agentsecrets). It
   does **not** move into the `stack` container — the stack executes dogfooded code,
   and TNGC-20 exists precisely so that code can't reach credentials.
4. **Link frames stay small.** Queue snapshots and down-frames carry metadata, never
   payloads — the DO relays and stores them, and the queue screen polls them.

## 3. Architecture overview

**Answer to the open storage question: R2 is never exposed directly to anyone.**
The worker fronts it for *both* sides — the PWA reads via session-auth routes, the
house reads/writes via service-token routes. Same bucket, one auth surface:

- No R2 credentials ever enter the house (nothing new inside the fence).
- No new egress domains — `myhome.computer` is already on
  `docker/allowed-domains.txt` (the bridge links to it).
- The worker enforces tenancy/ownership on every byte; a leaked R2 URL scheme or
  bucket policy can't.
- At household scale the extra worker hop is noise (~tens of ms).

```
        HOUSE (fenced)                              CLOUD
┌─────────────────────────────┐        ┌────────────────────────────────┐
│ computer container          │        │ tricorder worker               │
│  ┌──────────┐  ┌─────────┐  │  HTTPS │  ┌────────┐  ┌────┐  ┌──────┐  │
│  │console-  │  │ bridge  │◄─┼────────┼─►│ /link  │  │ D1 │  │  R2  │  │
│  │mcp       │  │ (v0.6)  │  │  + WSS │  │ /api/* │  │meta│  │props │  │
│  └────┬─────┘  └────┬────┘  │        │  └───▲────┘  └────┘  └──────┘  │
│       │ ids only    │       │        │      │ session auth            │
│  ┌────▼─────────────▼────┐  │        │  ┌───┴──────────┐              │
│  │ packages/library-     │  │        │  │ Tricorder PWA│              │
│  │ client (shared fetch) │  │        │  │ Library tab  │              │
│  └───────────┬───────────┘  │        │  └──────────────┘              │
└──────────────┼──────────────┘        └────────────────────────────────┘
               │ props (server-side only)
┌──────────────▼──────────────┐
│ stack container             │
│  console server :3789       │   ← PanelHistory lives here; gains an
│  (NO cloud token, ever)     │     internal props-export route only
└─────────────────────────────┘
```

**The cloud-library client lives in the `computer` container** — a small shared
module `packages/library-client` (save / fetch / search, HTTPS base derived from
`TNG_TRICORDER_URL`, bearer `TNG_TRICORDER_TOKEN`) used by **both** processes that
need it:

- **console-mcp** — voice-initiated save / search / display / send.
- **bridge** — PWA-initiated "display on wall" (fetch-at-dispatch, §7).

Zero new env plumbing: both values are already in the container environment.

## 4. What a "primitive" is (the unit of save)

Every wall render is a typed `(view, props)` pair already recorded verbatim in
`PanelHistory` (`apps/server/src/history.ts`, ring of 50, powers `recall`). **A saved
item is one history entry, frozen.** No new serialization format.

Family (derived from `view`, stored denormalized, validated by the worker):

| Family | Views | Notes |
|---|---|---|
| prose | text, article, news, results | |
| data | chart, table, quote, scoreboard, weather | goes stale — PWA shows `created_at` prominently |
| visual | diagram, image, map, night-sky | diagram payload is inline SVG (~30 KB typical) |
| procedure | steps, quiz | full step array; position resets |
| notation | code, math | |
| media | youtube | `{videoId, title, channel}` — a bookmark, not bytes |
| — | status, alert, blank, boot | **not savable** (already skipped by PanelHistory) |

## 5. Storage: D1 index + R2 payload

- **D1 `library_items`** — one row per save, metadata only. Everything browse/search
  touches. Migration `apps/tricorder/migrations/0003_library.sql`.
- **R2 bucket `tricorder-library`** (new `r2_buckets` binding `LIBRARY` in
  `wrangler.jsonc`) — the `props` JSON, one object per item, key
  `lib/<tenant_id>/<item_id>.json`.

```sql
CREATE TABLE library_items (
  id          TEXT PRIMARY KEY,          -- li_<uuid-slice>
  tenant_id   TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  family      TEXT NOT NULL,             -- prose|data|visual|procedure|notation|media
  view        TEXT NOT NULL,             -- the PanelView
  title       TEXT NOT NULL,             -- PanelHistory summary line
  r2_key      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  from_user   TEXT,                      -- sender's handle when received via send
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_library_owner ON library_items (tenant_id, owner_id, created_at DESC);
```

Search v1: `WHERE owner_id = ? AND title LIKE ?` + family filter. Household scale —
no FTS. Payload cap **256 KB** (worker 413s above it; measure worst-case article
before shipping, adjust the constant). Soft quota ~500 items/user (polish phase).

## 6. Cloud API (worker)

Two auth planes: **session** (PWA bearer token → user) and **service** (tenant
service token, same verification as `/link` — hash match on
`tenants.service_token_hash`). Service-plane requests act *for* a named owner
because the token isn't user-scoped; the house is trusted within its tenant.

| Route | Auth | What |
|---|---|---|
| `POST /api/library` | service | ingest `{owner, view, title, props}`; worker derives+validates family, writes R2 then D1; 413 over cap; returns `{id, title}` |
| `GET /api/library?owner=&family=&q=&limit=` | service | metadata list for voice search (owner handle required) |
| `GET /api/library?family=&q=&received=&before=&limit=` | session | own items, newest first, metadata only; `before` = created_at cursor for infinite scroll, `received=1` filters to items with `from_user` (see the UX doc) |
| `GET /api/library/:id` | session **or** service | metadata + payload (streamed from R2). Session: own items only. Service: any item in tenant |
| `DELETE /api/library/:id` | session or service | own items (admin: anyone's); service passes `owner` for the ownership check |
| `POST /api/library/:id/send` `{to}` | session or service | copy D1 row + R2 object to user `to`, `from_user` = sender's handle; immutable snapshot (later edits/deletes by sender don't affect the copy) |
| `POST /api/library/:id/display` | session | enqueue a `display` item onto the wall queue (§7); 409 with "wall offline" body if no live link |
| `GET /api/users` | session | handles + display names for the send picker (non-admin; excludes guest) |

**Guest role: no library in v1** — no saves, no receives, Library tab hidden.

## 7. Data flows

### 7a. Save (house → cloud, outbound — no contract change)

```
"save to my tricorder"        (channel event: user=ariel, device=Pixel)
  → session calls library tool: save {owner:"ariel"}
  → console-mcp: GET  {server}/api/console/history/current     (props stay machine-side)
                 POST {cloud}/api/library   (service token)     via library-client
  → tool returns {id, title} — the ONLY thing the model sees
  → Computer: "Saved to your tricorder."
```

- New **internal console-server routes**: `GET /api/console/history/current` and
  `GET /api/console/history/:id/props` — full `(view, props, summary)` export.
  Loopback + compose network only, like every console route; props are wall
  content, not secrets.
- "Save **that**" after the wall moved on: v1 saves the *current* panel only — the
  skill says to `recall`-redisplay first, then save. No history-picking UI.
- Typed terminal input has no channel user → the skill asks whose tricorder, or
  defaults to the session owner if unambiguous.

### 7b. Display on wall — voice-initiated ("show my saved warp core diagram")

```
  → library tool: search {q:"warp core", owner:"leif"}  → metadata list (≤20, ids+titles)
  → model picks one id (this is the ONLY model involvement)
  → library tool: display {id}
  → console-mcp: GET {cloud}/api/library/:id (service token)   — payload arrives here
                 POST {server}/api/console/display {view, props}
  → wall renders; PanelHistory records it (normal display path) → recall works on it
```

### 7c. Display on wall — PWA-initiated ("Display on wall" button)

Rides the TNGC-22 dispatcher queue as a **first-class queue item** — visible on the
queue screen, withdrawable, turn-gated like everything else:

```
PWA tap → POST /api/library/:id/display (session auth, ownership check)
  → DO: down-frame  {type:"display", itemId, view, title}      ← metadata only
  → bridge enqueues QueueItem {kind:"display", itemId, transcript:title}
      · idle → dispatches immediately
      · turn active → waits; at turn-end, display items dispatch BEFORE the next
        transcript (in order; consecutive displays fire sequentially, last wins)
  → at dispatch: bridge GETs {cloud}/api/library/:itemId (service token — fetch-at-
    dispatch, so frames stay tiny and the payload is fresh)
    → POST {server}/api/console/display → ack {status:"dispatched"}
```

- **No channel event, no session turn, no LLM tokens** — deterministic. It does not
  set `busy` and does not consume the one-transcript-per-turn budget.
- Item deleted between enqueue and dispatch → cloud 404 → ack with error status,
  skip, log. Stack down while bridge up → same error-ack path.
- Wall offline entirely (no bridge link) → the worker's `/display` returns 409
  "wall offline"; the PWA shows it inline. No synthetic-transcript fallback is
  built — it burns a turn and fails in exactly the same offline case (the
  handoff's own analysis; option (b) is dropped, not deferred).

**Why fetch-at-dispatch instead of the handoff's inline-at-enqueue:** inlining a
30 KB payload into the down-frame puts it in DO memory, in the bridge queue, and —
fatally — in every queue snapshot up-frame the PWA polls. Fetch-at-dispatch keeps
every frame at metadata size and reuses the exact same resolver as the voice path.

### 7d. Send ("send this to Ariel")

Cloud-only copy (§6). Spoken at the wall, the skill supports the one-breath form:
save to own library + `send` in the same tool flow. v1 notification is a passive
"received" badge in the recipient's Library tab (`from_user` set); no wall chime.

## 8. Contract changes (additive — no version bump)

Per the additive-frames rule (both ends ignore unknown types; bump only on shape
changes to existing frames):

- `QueueItem` gains optional `kind?: "transcript" | "display"` (absent = transcript)
  and `itemId?`. The queue screen renders display items with a 📄/library glyph and
  the item title; withdraw works unchanged.
- New down-frame `{type:"display", itemId, view, title}`.
- Bridge → **v0.6**. Worker + PWA deploy together as always; the bridge picks the
  feature up at the next session restart. An old bridge ignores `display` frames
  silently — acceptable during the deploy window since worker-first deploy order is
  already the norm.

## 9. Tricorder PWA — Library screen

- **Library tab**: search box + family filter chips + paged list (title, family
  badge, relative time, `from_user` badge). `GET /api/library`.
- **Item view** — native rendering, phased:
  - **Phase 1** (cheap, high value): `diagram` (inject the SVG — self-contained),
    `image`, `text`, `code` (monospace + existing palette), `table` (plain HTML),
    `steps` (ordered list), `media` (thumbnail + YouTube link).
  - **Phase 2**: `math` (KaTeX), `chart` (needs a renderer). `map`/`night-sky` stay
    "display on wall only" — they're live panels, not documents.
  - Any view without a renderer → title + family + **Display on wall** button.
- **Actions**: Send (user picker from `GET /api/users`), Display on wall, Delete.
- `data`-family items show a prominent staleness stamp ("captured 3 weeks ago").
- Keep LCARS; the design language and single-file `index.html` discipline apply
  (syntax-check the script block before deploying; edge propagation ~10 s).

## 10. House-side surfaces

- **MCP tool** (`packages/console-mcp`): one `library` tool, actions
  `save {owner?}` · `search {q?, family?, owner?}` · `display {id}` ·
  `send {id, to}` · `remove {id}`. Results are **always metadata** (ids, titles,
  families, timestamps). The tool description states the iron rule: *never* Read a
  library payload or pass props inline — display is by id only.
- **Skill** `claude/.claude/skills/library/SKILL.md` — new skill, not a `recall`
  extension (recall = wall history, this = cloud persistence). Triggers: "save to my
  tricorder", "save this for me", "what's in my library", "show my saved diagrams",
  "send this to Ariel". Documents owner resolution (channel user; ask when typed),
  save-current-only semantics, and the one-breath save+send.
- **CLAUDE.md** capability table: one new row for the skill, per knowledge-placement
  rules.

## 11. Build order (each step ships alone; stop anywhere and it's coherent)

1. **Cloud storage + ingest** — migration 0003, R2 binding, `POST /api/library`,
   list/get/delete (both auth planes). Curl-tested. *Worker only.*
2. **Save path from the house** — console history-export routes,
   `packages/library-client`, `library` tool (save/search only), skill, CLAUDE.md.
   *Acceptance:* diagram on wall, "save to my tricorder" → D1 row + R2 object +
   voice confirmation; verify zero payload bytes in the session transcript.
3. **Voice display-back** — `display` action in the tool (§7b). *Acceptance:* "show
   my saved periodic table" renders from cloud with only ids in context.
4. **PWA Library screen** — browse/search + phase-1 renderers + delete (§9).
5. **Display on wall from PWA** — contract additions, bridge v0.6 dispatch handling,
   worker `/display` route (§7c). *Acceptance:* tap on phone → panel appears without
   the session speaking; while a turn runs it queues, shows on the queue screen, and
   can be withdrawn.
6. **Send** — `/send` + `GET /api/users` + picker + received badge (§7d).
7. **Polish** — payload-cap tuning, staleness stamps, quotas, phase-2 renderers.

Deploy choreography: worker/PWA anytime (`wrangler deploy` from `apps/tricorder`,
creds via agentsecrets inline). Steps 2/3/5 touch console-mcp/bridge/skills → they
activate at the **next `make computer` restart**; batch them onto a restart Leif is
already taking. Stack picks up the console routes by hot reload.

## 11b. Playlist items (TNGC-25)

A playlist — **now playing + every queued track, in order** — is a first-class
library item: `view: "playlist"`, family `media`, props
`{ tracks: [{videoId, title?, channel?, durationSeconds?}] }`. Not a wall
panel; it's a *restorable queue state* (~2 KB for a 20-track party).

- **Save (voice):** "save this playlist [as party mix]" → `library
  save_playlist {owner, name?}` → console-mcp GETs
  `/api/console/playlist/current` (hub's youtube panel + the play queue,
  server-side — zero bytes through the model) → cloud ingest. Default title
  `"<first track> +N more"`. 409 when nothing is playing or queued. Save from
  the phone is deliberately out of scope: the queue lives house-side, and you
  save the vibe while you're in the room.
- **Restore (both paths, one branch):** the console display route intercepts
  `view === "playlist"` → `restorePlaylist(props)` in youtube.ts: the play
  queue is **replaced** with tracks 2..N (capped at MAX_QUEUE), track 1
  broadcasts through the TNGC-24 embed-vs-audio decoration, and auto-advance
  does the rest. Because the bridge's display dispatch already POSTs
  `{view, props}` to that route, the PWA's "Display on wall" and the voice
  path both restore with **zero bridge or contract changes**. Restoring
  replaces the current queue by design — playing a playlist means starting
  that vibe, not appending to the old one.
- **PWA:** native renderer — count header + ordered track list (title,
  channel · duration). Send/Delete/search work generically. It files under
  the `media` chip; the row's `playlist` view label is its badge.
- Tracks carry metadata only — never `audioOnly`/`startSeconds`; playability
  is re-decided at restore time (embeddability changes; TNGC-24 owns it).

## 12. Decisions log (closing the handoff's open questions)

| Question | Decision | Why |
|---|---|---|
| D1 vs blob | Both: D1 index + R2 payload | Lean queryable index; payloads never bloat rows or list queries |
| Direct R2 access for the house? | **No — worker fronts R2 for everyone** | One auth surface; no new secrets in the fence; no new egress domains; tenancy enforced in code |
| Where does the cloud client live? | `computer` container (`packages/library-client`, used by console-mcp + bridge) | Token already there and stays there; stack (dogfood executor) remains secret-free |
| `save_primitive` on server or bridge? | Neither exactly: **console-mcp orchestrates**; server only exports history props internally | History read stays on the server; token stays in the fence; env plumbing = zero changes |
| Display path (a) typed envelope vs (b) synthetic transcript | (a), with **fetch-at-dispatch** instead of inline-at-enqueue; (b) dropped | Deterministic, no tokens, tiny frames, one shared resolver; (b) fails in the same offline case while costing a turn |
| Turn interaction of PWA displays | Ride the TNGC-22 queue: immediate when idle, dispatch at turn boundaries when busy, withdrawable | Consistency with the queue mental model; no mid-turn panel clobbering |
| Contract version | Additive, no bump; bridge v0.6 | Both ends ignore unknown frame types |
| Payload cap | 256 KB, measured before ship | Diagrams ~30 KB; generous headroom without inviting abuse |
| Guests | No library v1 | Rotating shared identity; ownership semantics don't fit |
| Send notification | Passive badge v1 | Wall chime is polish, needs presence logic |
| Ticket | **TNGC-23** | Filed; the handoff predated it |

## 13. Risks & watch-items

- **Service-token scope creep**: the token now authorizes library reads/writes, not
  just the link. Blast radius review: a stolen token could read/write this tenant's
  library and steal the bridge link — the latter was already true; library adds no
  new *class* of exposure. Rotation stays a single agentsecrets update + restart.
- **PanelHistory `current` ambiguity**: rapid re-displays update the last entry in
  place (by design); "save" grabs whatever is truly on screen. Correct, but document
  in the skill that the save target is *what the wall shows now*.
- **D1 bind cap (100/statement)**: irrelevant at these query shapes; keep any future
  bulk operations chunked regardless.
- **Testing discipline**: worker tests via curl against a `wrangler dev` instance or
  the deployed worker with a scratch owner; house-side tests **in-container**, on
  scratch ports, never against the live bridge/wall link.
