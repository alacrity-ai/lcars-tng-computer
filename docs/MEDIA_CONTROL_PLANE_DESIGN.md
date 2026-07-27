# Media control plane — implementation design (TNGC-69 / TNGC-70)

Transport control for playing media, driven from a tricorder **without waking
the Claude session**. "Next track" should cost a tap and ~200ms, not a held
talk button, a model turn, and a tool call.

Two phases, one plane:

- **Phase 1 (TNGC-69)** — the plane itself plus a mini transport bar (`⏮ ⏯ ⏭`)
  under the hold-to-talk circle on the tricorder's main screen.
- **Phase 2 (TNGC-70)** — a full Media plugin screen: the whole session in
  order, tap-to-jump, loop, volume.

---

## 1. Why this is cheap: the plane already exists

The Lights plugin (TNGC-40) established the deterministic control plane, and
claudeops (TNGC-54) proved it generalizes to a non-sidecar target:

```
phone  →  POST /api/plugins/<id>/control      (Worker: validate + REBUILD args,
                                               attribute, write control_log)
       →  TenantHub DO  /control              (ephemeral: no storage, no replay)
       →  WSS  {type:"control", ctl}          (down-frame on the live link)
       →  bridge executeControl()             (re-validate, rebuild AGAIN)
       →  local HTTP                          (the plugin's own service)
```

State flows the other way on the same link:

```
bridge polls a local source  →  {type:"plugin_state", plugin, state}
       →  DO storage (latest snapshot per plugin)
       →  GET /api/plugins/<id>/state         (PWA polls this)
```

Two properties matter here and both are already true:

1. **Control frames dispatch even mid-turn.** They bypass the command queue
   entirely — a lights tap works while the Computer is mid-thought, and so
   will a skip.
2. **Nothing is trusted across the internet.** The Worker validates and
   rebuilds args from scratch; the bridge validates and rebuilds *again*
   before touching the house. Free-form JSON never rides a control frame.

For media the "plugin's own service" is the wall server (`TNG_SERVER_URL`,
:3789) that the bridge already talks to for displays and the idle gallery.
No new process, no new port, no new trust boundary.

---

## 2. What is genuinely missing (the gap analysis)

Four gaps, all server-side and all small.

### 2.1 "Previous track" does not exist

`queues: Map<wall, QueueItem[]>` holds only what is **waiting**. `playNext()`
shifts the head off and the outgoing track is simply forgotten. There is
nowhere for ⏮ to read from.

**Fix**: a per-wall played-history stack in `youtube.ts`, alongside `queues`
and with the same lifetime (in-memory, per process — a stack restart starts a
new session, which is correct).

```
history: Map<wall, QueueItem[]>      // oldest → newest, cap 25
```

- Every advance (`playNext`) pushes the *outgoing* track onto history first.
- `prev` pops history, pushes the *current* track back onto the FRONT of the
  queue, and plays the popped track. Nothing is lost: ⏮ then ⏭ returns you
  exactly where you were.
- Consecutive-duplicate guard on push, so a re-display of the same track
  can't stack up.

This one structure also unlocks `jump` (skipped tracks go to history, so ⏮
still walks back through them) and `loop` (a drained queue is refilled from
history + current).

### 2.2 Paused state is unknown to the server

`media pause` is a fire-and-forget broadcast to whatever player has the wall;
the hub records nothing. A `⏯` button with no truth behind it can only be
optimistic, and optimism drifts the moment someone pauses from another phone.

**Fix**: `paused: boolean` on the hub's per-wall `DisplayEntry`, next to
`playback`. Set true on `media pause`; cleared on `play`, on any new track
(display youtube / playbackTrack), and on `clearPlayback`.

Known limitation, accepted: a video that ends *while paused* leaves the flag
stale until the next track. Harmless — playback is gone, the bar hides.

### 2.3 No compact "what is playing" read

`screen_state` is per-wall and heavy (it carries full panel props). Nothing
answers "what is each wall playing, and can I go back/forward?" in one shot.

**Fix**: `GET /api/console/media-state` — composed entirely from data the
server already holds (TNGC-66 built most of the composition):

```jsonc
{
  "primary": "main",
  "walls": [{
    "wall": "main",
    "playing": { "videoId": "...", "title": "...", "channel": "...",
                 "durationSeconds": 213, "audioOnly": true,
                 "backgrounded": false },
    "paused": false,
    "loop": false,
    "queue":   [ /* QueueItem, play order */ ],
    "history": [ /* QueueItem, oldest → newest */ ]
  }]
}
```

Only walls with playback, a queue, or history appear — an idle house returns
`{walls: []}`, which is what makes "hide the bar" trivial.

### 2.4 The bridge has no media relay

**Fix**: mirror the claudeops relay exactly.

- `pollPlugins()` gains a media leg: fetch media-state, push `plugin_state`
  on change, mark the `media` plugin online iff the wall server answered.
- A **fast beat** (3s) runs only while some wall is playing — the same
  conditional-fast-poll trick claudeops uses while a turn is in flight.
  At rest the media leg rides the normal 15s beat.
- `executeControl` gains a `media` branch mapping ops to console routes that
  already exist (plus the new queue actions).

---

## 3. The op vocabulary

One control plugin id: `media`. Ops, and where each lands:

| op | args | wall-server call |
|---|---|---|
| `next` | — | `POST /api/console/queue {action:"skip"}` |
| `prev` | — | `POST /api/console/queue {action:"prev"}` **(new)** |
| `pause` / `play` | — | `POST /api/console/media {action}` |
| `stop` | — | `POST /api/console/media {action:"stop"}` |
| `volume_up` / `volume_down` | — | `POST /api/console/media {action}` |
| `jump` | `index` 0..24 | `POST /api/console/queue {action:"jump", index}` **(new)** |
| `loop` | `enabled` bool | `POST /api/console/queue {action:"loop", enabled}` **(new)** |

Every op carries `wall` (validated as a display name, defaulted server-side by
the existing `resolveWall` rule). Args are rebuilt at both gates; `index` is
range-checked twice.

`jump` semantics: tracks *before* the chosen index move to history in order,
the chosen track plays, the remainder stays queued. This is what makes ⏮
behave the way a person expects after a jump.

`loop` semantics: when the queue drains at natural end and loop is on, the
cycle is rebuilt as `history + current` (consecutive-dedup applied), history
clears, and playback continues. A single looping track therefore repeats
forever without stacking duplicates.

---

## 4. Phase 1 surface: the transport bar

Placed in `view-main` directly under `.ptt-wrap`, so it sits beneath the
hold-to-talk circle in the phone layout and inside the right-hand column of
the tablet two-pane layout.

```
┌──────────────────────────────────────┐
│   ⏮      ⏯      ⏭     Miles Davis…   │   ← wall chip only when >1 wall plays
└──────────────────────────────────────┘
```

- **Hidden entirely** unless the targeted wall has playback. The main screen
  stays exactly as clean as it is today when nothing is on.
- `⏭` disabled when the queue is empty; `⏮` disabled when history is empty
  (i.e. the first track of the session); `⏯` renders pause vs play from the
  server's `paused` flag.
- **No new polling timer.** The Worker attaches a compact media summary to
  `/api/status`, which the main screen already polls (15s at rest, 2s in its
  fast window). A tap applies optimistically, fires the op, and bumps the
  fast window so real state confirms within ~2s.
- Wall targeting follows the user's existing wall selection (`getWall()`,
  the ▸ pill). If that wall isn't playing but another is, the bar follows the
  playing one and shows its name as a chip.

### Gating

`/api/status` is served to every session including guests, so the media
summary is attached **only** when the session is a member (not guest) **and**
the `media` plugin is enabled for the tenant. Guests never see the bar,
matching the rest of the plugin family.

---

## 5. Phase 2 surface: the Media plugin screen

A `Media` tile on the plugin grid (bridge-rostered, so it obeys the same
enable switch) opens `view-md`:

- **Now playing** card: title, channel, AUDIO / BACKGROUND tags, wall name.
- **The session in order**: history (dimmed, above), current (highlighted),
  up-next (numbered, below). One list, so the shape of the session is
  legible at a glance.
- **Tap a queued track** → `jump`. Tap a history track → `prev` repeatedly is
  wrong; instead history rows are tappable too and issue `jump` semantics in
  reverse is *not* supported in v1 — history rows are informational. (Keeps
  the op count honest; ⏮ covers stepping back.)
- **Loop toggle**, **volume nudges**, **stop**, and the same transport row.
- **Wall picker** when more than one wall has media.

Polls `/api/plugins/media/state` at 3s while open (the same cadence the
claudeops screen uses), stops on leave.

---

## 6. Files touched

| File | Change |
|---|---|
| `packages/contract/src/index.ts` | `MediaState` / `MediaWallState` types for the `plugin_state` payload |
| `packages/shared/src/index.ts` | queue actions `prev`/`jump`/`loop`; `MediaStateResponse` |
| `apps/server/src/hub.ts` | `paused` on DisplayEntry + setter, cleared on track change/stop; `playbackWalls()` |
| `apps/server/src/routes/youtube.ts` | history stack, `prev`/`jump`/`loop` actions, loop-on-exhaustion, `mediaState()` export |
| `apps/server/src/routes/console.ts` | `GET /api/console/media-state`; pause/play set the paused flag |
| `packages/bridge/src/index.ts` | media leg in `pollPlugins`, fast beat while playing, `media` roster entry + tile, `executeControl` media branch |
| `apps/tricorder/src/hub.ts` | media summary on DO `/status` |
| `apps/tricorder/src/worker.ts` | `/api/plugins/media/{state,control}`; gated media summary on `/api/status` |
| `apps/tricorder/public/index.html` | transport bar (phase 1), `view-md` screen (phase 2), plugin dispatch |

## 7. Explicitly out of scope

- **Seeking / scrubbing and elapsed time.** The server never learns playhead
  position — only the wall's own player knows it. Surfacing it would need a
  new report channel from every player; not worth it for a transport bar.
- **Reordering or removing individual queued tracks** from the phone.
- **Anything touching the LLM.** If a media action needs judgment ("play
  something like this"), that is a voice command, not a button.
