# TNG Computer v2 — The Tricorder Era: Phased Implementation Plan

**Status:** Adopted 2026-07-22 · **Epic:** TNGC-10 · **Supersedes** the phasing in `DESIGN.md` §10 (v1)
**Repo:** `~/lets-get-rich/tng-computer` (single monorepo — includes Tricorder)

---

## 1. What changed and why

Living with the v1 build reshaped the target. The load-bearing discovery: the magic of
this system is that **the brain is a development agent living inside its own running
source tree** — asked for a panel that doesn't exist, it writes the panel, hot-reloads
it onto the wall, and uses it. Everything below protects that property (compute stays
on the office GPU box, stack keeps running from the repo via `make dev`).

Decisions locked 2026-07-22:

| Decision | Replaces |
|---|---|
| **Multi-user push-to-talk via phones** (Tricorder PWA) | Wake word + always-on ear daemon (openWakeWord, Silero VAD, WSL2 mic problem — all dead) |
| **Phone-native speech recognition** (Web Speech API / keyboard dictation) | Server-side STT (faster-whisper, Groq fallback — dead) |
| **Channels push delivery** (revised 2026-07-22 evening — TNGC-18) | ~~Blocking `bridge.await_message` loop~~ — built first (TNGC-13), wedged in soak at timeout boundaries; channels adopted despite preview status |
| **One monorepo** — Tricorder is `apps/tricorder`, deployed to Cloudflare | Separate tricorder repo |
| **Wall over LAN** — living-room TV Chrome (F11) is the kiosk | Wall bound to the office machine |
| **YouTube stays the media path** | Spotify plans (scrapped — PKCE, Web Playback SDK, music MCP all cancelled) |
| **Piper TTS stays** | Majel clone (shelved, not cancelled — TNGC-4 holds it for later) |

## 2. Target architecture

```
   phone / iPad (any network)                      office GPU box (LAN)
┌─────────────────────────────┐          ┌────────────────────────────────────┐
│ TRICORDER PWA               │          │ CLAUDE CODE SESSION (the brain)    │
│ user login + password       │          │  persona + skills + MCP tools      │
│ hold-to-talk → native STT   │          │   ▲ channel event per message      │
└──────────────┬──────────────┘          │   │ {user, device, transcript}     │
               │ HTTPS (transcript)      │ ┌─┴──────────────────────────────┐ │
┌──────────────▼──────────────┐          │ │ BRIDGE (MCP server)            │ │
│ TRICORDER API (Cloudflare)  │          │ │ • channel push per message     │ │
│ myhome.computer   │  outbound│ │ • outbound WSS client ─────────┼─┼──┐
│ Worker (Hono) + D1          │◄─────────┼─┤ • local POST /message          │ │  │
│ Durable Object per tenant:  │   WSS    │ │   (office push-to-talk)        │ │  │
│  queue · ack · replay ·     │          │ └────────────────────────────────┘ │  │
│  60s TTL · online/offline   │          │   │ console.* / tricorder.* MCP    │  │
└─────────────────────────────┘          │ ┌─▼──────────────────────────────┐ │  │
        ▲                                │ │ API SERVER · WS hub · TTS front│ │  │
        │ saved_items etc.               │ └─┬──────────────────────────────┘ │  │
        └── tricorder.* MCP tools ───────┼───┼── (service token) ─────────────┘  │
                                         └───┼────────────────────────────────┘  │
                                             │ WebSocket (LAN)                    │
                                  ┌──────────▼───────────┐                        │
                                  │ LCARS WALL — TV kiosk│    no inbound holes:   │
                                  │ Chrome F11, panels,  │    office box only     │
                                  │ Piper TTS, YouTube   │    dials OUT ──────────┘
                                  └──────────────────────┘
```

Key properties:

- **No inbound connections to the home network.** The bridge dials out and holds the
  WebSocket; NAT keeps it alive. No tunnel, no port forwarding.
- **Channels delivery** (TNGC-18). Each message is pushed into the session as a
  channel event the moment it arrives; the session idles normally between events.
  (The v1 blocking `await_message` loop wedged in soak and was replaced.)
- **Everything is a queue message.** Tricorder utterances and office push-to-talk both
  arrive as `{user, device, transcript, ts}` — one input path, fully attributed. The
  terminal is for development only.
- **Attribution is the identity model.** Users belong to the tenant (household);
  a device is only a session label on a logged-in user; "save this to **my** tricorder"
  resolves from the `user` on the triggering message, not from who owns the session.
- **Two hands, then three.** `console.*` drives the shared wall; `tricorder.*`
  (Phase 5) drives the private per-user data plane. Tricorder and the wall never talk
  to each other — the brain mediates everything.

## 3. Queue semantics (the contract that matters)

- Every transcript is **persisted** in the DO queue, then pushed down the socket.
- **The bridge owns the dispatcher queue** (TNGC-22): while a turn is running
  (known from the session's UserPromptSubmit/Stop hooks), arriving commands are
  held bridge-side — visible, ordered, withdrawable — and dispatch one per turn.
  A lost Stop hook degrades to harness-side queueing after 10min; never wedges.
- The bridge **acks at dispatch or withdrawal** (not arrival); unacked messages
  **replay** on reconnect, so a held queue survives a bridge restart.
- Voice commands **expire 60s** after enqueue **on arrival/replay** — durability
  is for Wi-Fi blips, not time-shifting speech. Deliberately-held queue time
  doesn't count: a visible, withdrawable queue makes waiting legitimate.
- Every queue change publishes a **snapshot** (`queue` up-frame → DO → PWA queue
  screen) and a count (wall badge). **Withdraw/cancel** flows back as a
  `withdraw` down-frame; own commands only, admin overrides — enforced in the
  Worker. Cancelling the ACTIVE command arms the session's PreToolUse gate:
  every non-console tool call is denied with a CANCELLED notice until the turn
  ends (an already-executing tool call runs out — the axe falls at the next one).
- The DO's socket state is the **Computer online/offline** signal surfaced in the PWA.
- **Library display commands** (TNGC-23) ride the SAME queue as first-class items
  (`kind: "display"` — visible, ordered, withdrawable, same persist/ack/replay/TTL),
  but dispatch **deterministically**: the bridge fetches the payload from the cloud
  (fetch-at-dispatch — frames and snapshots stay metadata-sized) and POSTs it to the
  console server. No channel event, no session turn, no LLM tokens; displays at the
  head of the queue run immediately when idle and never set `busy`.
- The message shape `{user, device, transcript, ts}` is a tiny versioned contract in a
  shared monorepo package — the only coupling between cloud and home.

## 4. Phases

Each phase ends with a demo. Ordering was deliberate: the event-loop pattern was
proven with zero infrastructure in Phase 2 (and its v1 failed honestly there, hence
2b); cloud semantics were proven by curl in Phase 3 before any UI exists in Phase 4.

| Phase | Ticket | Scope | Demo |
|---|---|---|---|
| **0 — Record reset** | TNGC-11 | `DESIGN.md` v2 rewrite to match this plan (board reset already done 2026-07-22) | Docs describe the system being built |
| **1 — Wall on the LAN** | TNGC-12 | Serve web+API on the network; TV Chrome kiosk; audio-unlock boot flow; make target | LCARS on the living-room TV, driven from the office session |
| **2 — Event loop v1** | TNGC-13 | *(superseded by TNGC-18)* blocking `await_message` + re-arm discipline | Worked in demo; wedged in soak |
| **2b — Event loop v2** | TNGC-18 | channels push delivery; remove re-arm/Stop-hook machinery; `--dangerously-load-development-channels server:bridge` | say.sh → channel event → wall; terminal free; zero timeout cycles |
| **3 — Tricorder backend** | TNGC-14 | `apps/tricorder`: Worker + per-tenant DO + D1; device auth; ack/replay/TTL; bridge outbound WSS; deploy to myhome.computer | Off-LAN curl → wall responds; replay/TTL verified by killing the bridge |
| **4 — Tricorder PWA v1** | TNGC-15 | User login (password; leif/ariel/guest, roles); hold-to-talk via native speech + first-class type mode; admin console (create/disable users, rotate-guest); online/offline indicator; installable | Guest picks up TV-room iPad: "tell me about bees" → wall answers |
| **5 — Personal data plane** | TNGC-16 → **delivered by TNGC-23** | The Library: D1 index + R2 payloads; `library` MCP tool; speaker-resolved "save to my tricorder"; PWA Library screen (search/browse/send/display-on-wall). Design: `TRICORDER_LIBRARY_IMPLEMENTATION_DESIGN.md` + `TRICORDER_LIBRARY_PWA_UX_DESIGN.md` | Ariel saves the bees article; it appears on Ariel's phone only — and goes back on the wall from the phone |
| **6 — Appliance hardening** | TNGC-17 | Delete `apps/ear` + await-loop leftovers; supervisor/autostart; nightly session rotation; reconnect torture tests; SOPs | Pull the plug mid-interaction; everything returns unattended |

Not in this epic: **TNGC-4** (Majel voice — shelved, Piper stays), **TNGC-9**
(lighting), **TNGC-7** (panel/briefing/red-alert polish — hardening portion moved to
Phase 6 here).

## 5. Risks & fallbacks

| Risk | Mitigation / fallback |
|---|---|
| Channels protocol churn (research preview, dev flag) | Bridge is the isolation boundary; the Agent SDK streaming-input host replaces only its delivery guts |
| Channel events drop silently when the launch flag / org policy is missing | `make computer` bakes the flag in; `peek_messages` + bridge `/health` show received-vs-pushed for diagnosis |
| Web Speech API quirks (iOS prefixing, permission prompts) | Text-input fallback with keyboard-mic dictation is always present; PTT is progressive enhancement |
| Cloudflare or internet outage | LAN degradation path: office PTT posts directly to the bridge's local endpoint and the wall keeps working; PWA shows offline |
| Blocking-tool pattern is a community pattern, not a guaranteed product surface | Channels (if it graduates) or the Agent SDK streaming-input host replace only the bridge's delivery mechanism; phones/Worker/DO/queue contract unchanged |
| One session, many speakers — interleaved commands | Acceptable at household scale (`speak` serializes); attribution keeps "my" correct per message; revisit only if contention is real |
| Context growth in the always-on session | Inherent to the long-lived-session model; nightly rotation with day-summary memory note (Phase 6) keeps it flat |

## 6. Deferred / explicitly out of scope

- **Majel voice clone** — shelved with Piper as the working voice; TNGC-4 retains the
  research (Qwen3-TTS, reference-clip prep, legal posture) for when we circle back.
- **Spotify** — scrapped entirely; YouTube media path is live and sufficient.
- **Shared stateful entities** (todos, "share this with Mom and Joe") — design note is
  a Phase 5 deliverable; implementation is a future epic.
- **Ambient wake word** ("Computer, …" with no button) — possible someday on top of the
  same queue; nothing in this plan blocks it, nothing in this plan needs it.
- **Multiple walls / multi-room** — the WS hub already fans out; formally out of scope
  until there's a second screen worth mounting.
