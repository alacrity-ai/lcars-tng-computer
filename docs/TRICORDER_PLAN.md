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
| **Blocking `bridge.await_message` MCP tool** — the session is its own event loop | Channels (research preview, dev flag). Channels remains a *future upgrade path only* |
| **One monorepo** — Tricorder is `apps/tricorder`, deployed to Cloudflare | Separate tricorder repo |
| **Wall over LAN** — living-room TV Chrome (F11) is the kiosk | Wall bound to the office machine |
| **YouTube stays the media path** | Spotify plans (scrapped — PKCE, Web Playback SDK, music MCP all cancelled) |
| **Piper TTS stays** | Majel clone (shelved, not cancelled — TNGC-4 holds it for later) |

## 2. Target architecture

```
   phone / iPad (any network)                      office GPU box (LAN)
┌─────────────────────────────┐          ┌────────────────────────────────────┐
│ TRICORDER PWA               │          │ CLAUDE CODE SESSION (the brain)    │
│ device login + PIN          │          │  persona + skills + MCP tools      │
│ hold-to-talk → native STT   │          │   ▲ await_message returns          │
└──────────────┬──────────────┘          │   │ {user, device, transcript}     │
               │ HTTPS (transcript)      │ ┌─┴──────────────────────────────┐ │
┌──────────────▼──────────────┐          │ │ BRIDGE (MCP server)            │ │
│ TRICORDER API (Cloudflare)  │          │ │ • blocking await_message tool  │ │
│ tricorder.lalalimited.com   │  outbound│ │ • outbound WSS client ─────────┼─┼──┐
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
- **No channels.** MCP is pull-only, so the session gives itself agency: when idle it
  calls `await_message`, which blocks (zero tokens while waiting) until a message
  arrives, services it, and re-arms. Persona rule + Stop-hook safety net enforce re-arm.
- **Everything is a queue message.** Tricorder utterances and office push-to-talk both
  arrive as `{user, device, transcript, ts}` — one input path, fully attributed. The
  terminal is for development only.
- **Attribution is the identity model.** Users belong to the tenant (household);
  devices belong to users; "save this to **my** tricorder" resolves from the `user` on
  the triggering message, not from who owns the session.
- **Two hands, then three.** `console.*` drives the shared wall; `tricorder.*`
  (Phase 5) drives the private per-user data plane. Tricorder and the wall never talk
  to each other — the brain mediates everything.

## 3. Queue semantics (the contract that matters)

- Every transcript is **persisted** in the DO/D1 queue, then pushed down the socket.
- The bridge **acks** after successfully handing the message to the session; unacked
  messages **replay** on reconnect.
- Voice commands **expire 60s** after enqueue when replayed — durability is for Wi-Fi
  blips, not for time-shifting speech ("queue Madonna" from 20 minutes ago must not
  fire on reboot). Expired drops are logged, not silent.
- The DO's socket state is the **Computer online/offline** signal surfaced in the PWA.
- The message shape `{user, device, transcript, ts}` is a tiny versioned contract in a
  shared monorepo package — the only coupling between cloud and home.

## 4. Phases

Each phase ends with a demo. Ordering is deliberate: the riskiest new pattern (the
await loop) is proven with zero infrastructure in Phase 2; cloud semantics are proven
by curl in Phase 3 before any UI exists in Phase 4.

| Phase | Ticket | Scope | Demo |
|---|---|---|---|
| **0 — Record reset** | TNGC-11 | `DESIGN.md` v2 rewrite to match this plan (board reset already done 2026-07-22) | Docs describe the system being built |
| **1 — Wall on the LAN** | TNGC-12 | Serve web+API on the network; TV Chrome kiosk; audio-unlock boot flow; make target | LCARS on the living-room TV, driven from the office session |
| **2 — Event loop v1** | TNGC-13 | `await_message` blocking tool + local POST; persona re-arm rule; Stop-hook net; office PTT via local POST | Spacebar PTT → queue → await → wall; terminal untouched; survives overnight idle |
| **3 — Tricorder backend** | TNGC-14 | `apps/tricorder`: Worker + per-tenant DO + D1; device auth; ack/replay/TTL; bridge outbound WSS; deploy to tricorder.lalalimited.com | Off-LAN curl → wall responds; replay/TTL verified by killing the bridge |
| **4 — Tricorder PWA v1** | TNGC-15 | Device login + PIN; hold-to-talk via native speech; text fallback; online/offline indicator; installable | Guest picks up TV-room iPad: "tell me about bees" → wall answers |
| **5 — Personal data plane** | TNGC-16 | `saved_items` schema; `tricorder.*` MCP toolset on the brain; speaker-resolved "save to my tricorder"; PWA list+search; shared-entities design note | Mom saves the bees article; it appears on Mom's phone only |
| **6 — Appliance hardening** | TNGC-17 | Delete `apps/ear` + channels refs; supervisor/autostart; nightly session rotation; reconnect torture tests; SOPs | Pull the plug mid-interaction; everything returns unattended |

Not in this epic: **TNGC-4** (Majel voice — shelved, Piper stays), **TNGC-9**
(lighting), **TNGC-7** (panel/briefing/red-alert polish — hardening portion moved to
Phase 6 here).

## 5. Risks & fallbacks

| Risk | Mitigation / fallback |
|---|---|
| Session fails to re-arm `await_message` after a task or error | Persona rule is primary; Stop hook blocks any stop with no pending await and instructs re-arm; Phase 2 AC includes overnight soak + failure-path test |
| MCP tool-timeout kills long blocking waits | Raise the tool-timeout config; `await_message` also self-returns `{timeout:true}` on a long interval so cycles are cheap and observable |
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
