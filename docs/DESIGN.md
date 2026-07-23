# TNG Computer — Design Document

*A personal Star Trek TNG ship's computer: a persistent Claude Code session as the brain, an LCARS wall on the living-room TV as the shared face, and household phones as the microphones.*

**Status:** v2 — 2026-07-22 (the "Tricorder era" — supersedes v1's wake-word/channels architecture)
**Repo:** `~/lets-get-rich/tng-computer` (single monorepo — includes the Tricorder cloud app)
**Phasing:** [`TRICORDER_PLAN.md`](TRICORDER_PLAN.md) · epic **TNGC-10** on kbRelay

---

## 1. Executive Summary

A long-running **Claude Code session is the entire brain**. It receives attributed
transcripts from household members' phones, decides what to do, and acts through MCP
tools. The **webapp is a terminal Claude controls, not an app with logic of its own**:
a full-screen Vite+React LCARS display that renders whatever Claude tells it to render
and speaks whatever Claude tells it to say.

The load-bearing property — discovered by living with v1, protected by everything in
v2 — is that **the brain is a development agent inside its own running source tree**.
The stack runs from the repo via `make dev` on the same machine as the session, so the
Computer can build its own features on request: asked for a timeline panel that doesn't
exist, it writes the panel, hot-reloads it onto the wall, and uses it, in one request.
No architecture change may separate the brain from the repo and the dev server.

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
│ myhome.computer   │  outbound│ │ • outbound WSS client          │ │
│ Worker (Hono) + D1          │◄─────────┼─┤ • local POST /message          │ │
│ Durable Object per tenant:  │   WSS    │ │   (office push-to-talk)        │ │
│  queue · ack · replay ·     │          │ └────────────────────────────────┘ │
│  60s TTL · online/offline   │          │   │ console.* / tricorder.* MCP    │
└─────────────────────────────┘          │ ┌─▼──────────────────────────────┐ │
                                         │ │ API SERVER · WS hub · TTS front│ │
                                         │ └─┬──────────────────────────────┘ │
                                         └───┼────────────────────────────────┘
                                             │ WebSocket (LAN, vite proxy :5173)
                                  ┌──────────▼───────────┐
                                  │ LCARS WALL — TV kiosk│
                                  │ Chrome F11, panels,  │
                                  │ Piper TTS, YouTube   │
                                  └──────────────────────┘
```

Everything Claude can't do natively — visualization, audio output, media playback —
lives in the webapp behind MCP tools. Everything else — understanding, reasoning,
orchestration, web browsing — is Claude.

## 2. Core architectural decisions (locked 2026-07-22)

| Decision | Rationale |
|---|---|
| **Push-to-talk phones, not a wake word.** Input is the Tricorder PWA: hold a button, speak, release. | Button release *is* the endpoint — no VAD tuning, no false accepts, no always-open mic, no WSL2 microphone problem. Kills the entire v1 ear-daemon stack. |
| **Phone-native STT.** The transcript is produced on the phone (Web Speech API / keyboard dictation). | iPhone/Android recognition is durable and free; the server never sees audio. The GPU's only audio job is TTS. |
| **Channels push delivery** (revised 2026-07-22 evening, TNGC-18). The bridge declares the experimental `claude/channel` capability and pushes each message into the session as a channel event. | We tried the no-channels alternative first — a blocking `bridge.await_message` loop (TNGC-13). It failed its soak: every timeout return was a fresh model-discipline decision, and the session eventually narrated instead of re-arming and wedged. Channels moves "wake up and behave" from model judgment into protocol. Cost accepted: research preview, `--dangerously-load-development-channels server:bridge` at launch. |
| **Outbound-only connectivity.** The bridge dials out to the Tricorder DO and holds a WebSocket. | Nothing on the internet can reach into the home network; no tunnel, no port forwarding. The phones meet the brain at the Durable Object. |
| **One monorepo.** Tricorder is `apps/tricorder`, deployed to Cloudflare (`myhome.computer`). | One product, colocated. The deploy target differs; the code lives together. |
| **Attribution is the identity model.** Every message is `{user, device, transcript, ts}`. | Users belong to the household tenant; "save this to **my** tricorder" resolves per *speaker*, not per session. Foundation for per-user saved items and future shared entities. |
| **YouTube is the media path.** Spotify scrapped. | It works today and needs no auth dance; the v1 Spotify plan (PKCE, Web Playback SDK, dev-mode caps) is cancelled. |
| **Piper is the voice.** Majel clone shelved (TNGC-4). | Good-enough now; the Qwen3-TTS clone slot in `apps/tts` stays for when we circle back. Voice-clone research is preserved in TNGC-4, not here. |

## 3. Components

### 3.1 The Brain — Claude Code session (`claude/`)

A persistent interactive session. Identity from `CLAUDE.md` (it *is* the Computer:
terse, precise, "Working." then acts, "Unable to comply." for refusals), ~20 capability
skills loaded on demand (weather, maps, charts, media, quiz, timers, night sky, recall,
…), pre-allowed permissions so it never stalls mid-conversation.

**Event delivery (channels, TNGC-18):** the session simply idles between requests.
When a transcript arrives, the bridge pushes it as a channel event —
`<channel source="bridge" user="…" device="…">transcript</channel>` — which starts a
new turn immediately on an idle session; events arriving mid-turn queue and deliver
as a group on the next turn (Claude Code owns that queueing). No polling, no parked
tool call, no re-arm discipline. The terminal stays a normal interactive console for
development at all times.

### 3.2 The Voice Input — Tricorder (`apps/tricorder`, Cloudflare)

A PWA each household member logs into as a **user** — leif (admin), ariel (member),
guest — with a password, from any device; a "device" is only a session label
("leif @ iPhone"), and one user can hold many concurrent sessions. Guest sessions
expire after ~24h, and changing a password revokes every session that user holds,
so a one-tap **rotate-guest** in the admin console (admin role only: create/disable
users, reset passwords, revoke sessions) puts the house keys back in the drawer
after a party. Two first-class input modes, both always visible: **hold-to-talk**
driving the platform's own speech recognition (release posts the transcript), and a
**type mode** for loud rooms and speech-mangled names. The app shows Computer
online/offline from the DO's socket state.

Backend: Hono Worker + **per-tenant Durable Object** + D1 (`tenants`, `users`,
`sessions`, later `saved_items`). The DO is the meeting point: phones post
into the queue; the bridge holds an outbound WSS from home and receives pushes.

**Queue contract:** persist every transcript → push down the socket → bridge acks on
hand-to-session → unacked messages replay on reconnect → voice commands **expire 60s**
after enqueue at replay time (durability is for Wi-Fi blips, not for time-shifting
speech — "queue Madonna" from 20 minutes ago must not fire on reboot). Expired drops
are logged.

### 3.3 The Bridge (`packages/bridge`)

The only component that knows how messages enter the session. Three faces: the
channel push (`notifications/claude/channel`, one per message, `user`/`device` as
tag attributes), the outbound WSS client (cloud messages), and a local
`POST /message` (office push-to-talk, same message shape, `device: "office"`).
A read-only `peek_messages` tool exists purely to diagnose silent channel drops
(the preview's failure mode when the launch flag is missing). If channels shifts
under us — protocol churn, flag removal — the Agent SDK streaming-input host
replaces only this package's delivery guts.

### 3.4 The Hands — console + tricorder MCP (`packages/console-mcp`, +Phase 5)

**`console` tools** (thin HTTP calls to the API server): `display(view, props)` over a
registry of 20+ panels (status, text, alert, weather, charts, maps, night sky, quiz,
timeline, scoreboard, YouTube, …), `speak(text, opts)` (blocks until playback; ordering
contract: display before speak), `chime(name)`, `screen_state()`.

**`tricorder` tools** (Phase 5): `save_item` / `list_items` / `get_item` against the
cloud API with a tenant service token — the brain's hand into the *private* per-user
data plane. Saves never route through the TNG API server; the wall isn't involved.

### 3.5 The Face & Voice — API server + wall (`apps/server`, `apps/web`, `apps/tts`)

Node/Fastify API: WebSocket hub (broadcasts to every connected display), TTS front
(Piper sidecar on :3790; degrade to on-screen captions if it's down), YouTube routes,
widget/timer state, panel history (powers the `recall` skill).

Wall: full-screen LCARS (authentic geometry, gold `#FF9900` / lavender `#CC99CC` /
blue `#9999CC`), panel registry keyed by `view`, karaoke read-along highlighting,
ambient data cascades. **Same-origin by construction**: the vite dev server proxies
`/api`, `/audio`, `/ws` to the server, so a remote display only ever needs port 5173.

**Displays:** office browser and/or the TV-room Chrome in F11. Only :5173 is LAN-
exposed (WSL2 → Windows portproxy via `scripts/expose-lan.ps1`); the control API and
TTS ports stay loopback-only because they're unauthenticated. Audio unlock: browsers
block autoplay until a gesture — the wall probes on load and shows a one-tap **ENGAGE**
overlay when needed (the office kiosk script launches Chrome with the autoplay flag and
never sees it). SOP: [`sops/tv-room-kiosk.md`](sops/tv-room-kiosk.md).

## 4. End-to-End Flow

"Computer, tell me about bees" — from the guest iPad in the TV room:

1. Guest holds the Tricorder button, speaks, releases → phone STT produces the
   transcript → POST to the Tricorder API with the device token.
2. DO persists to the queue, pushes `{user: "guest-ipad", device, transcript, ts}` down
   the socket to the bridge.
3. The bridge pushes the message as a channel event; the idle session starts a turn
   immediately. Persona: instant spoken acknowledgment (`speak`, non-blocking), then
   the work.
4. Claude researches, calls `display("subject", …)` then `speak("Bees are…")` — the
   API server pushes panels over the WS hub, the Piper sidecar synthesizes, the TV
   speaks.
5. The session goes idle until the next event. If the guest says "save this to my
   tricorder", the *attribution on that new event* decides whose saved items it
   lands in.

Latency budget: PTT release → wall responding ≈ phone STT (sub-second) + cloud hop
(~100–300ms) + first tool call (~1–2s), masked by the acknowledgment line.

## 5. Session Configuration

- **Launch:** `claude --dangerously-load-development-channels server:bridge` in
  `claude/` (`make computer` wraps it, creds injected from agentsecrets). Expect the
  one-time "local development" confirmation dialog. **Without the flag, channel
  events drop silently** — `peek_messages` / bridge `/health` diagnose that.
- **Persona:** speak through `console.speak`, display through `console.display`;
  ≤2 spoken sentences unless asked; display-before-speak ordering; instant
  acknowledgments with `waitForPlayback: false`; channel events serviced like spoken
  requests, attribution from the event's `user`/`device`.
- **Permissions:** pre-allow `console.*`, `bridge.peek_messages`, `tricorder.*`,
  WebFetch/WebSearch, whitelisted Bash.
- **Hooks:** SessionStart (health check, boot panel, "Computer online."); Stop clears
  the wall's working badge. (Whether hooks fire on channel-initiated turns is
  undocumented in the preview — verify empirically; the working badge may not show
  for voice turns.)

## 6. Always-On Operation

- Supervisor (Phase 6): server, TTS sidecar, session with `--resume`; restart on crash;
  kill by port, not by process-name pattern (the pkill-tsx orphan gotcha).
- Context: auto-compaction plus nightly rotation — fresh session each night with the
  previous day summarized into a memory note; keeps cost and latency flat.
- The wall reconnects its WS with backoff; the bridge reconnects its WSS with backoff
  and replays unacked (fresh) messages; the ENGAGE tap re-unlocks audio after refresh.

## 7. Risks & Fallbacks

| Risk | Likelihood | Fallback |
|---|---|---|
| Channels protocol churn / dev flag removed (research preview) | Medium | Bridge is the isolation boundary; Agent SDK streaming-input host replaces only its delivery guts |
| Channel events drop silently when the launch flag / org policy is missing | Low-Medium | make computer bakes the flag in; `peek_messages` + bridge `/health` show received-vs-pushed |
| Web Speech API quirks (iOS prefixes, permission prompts) | Medium | Text input + keyboard-mic dictation is always present; PTT is progressive enhancement |
| Cloudflare / internet outage | Low | Wall + office PTT are LAN-local and keep working; PWA shows offline |
| Interleaved commands from multiple speakers | Certain, by design | `speak` serializes; attribution keeps "my" correct per message; fine at household scale |
| WSL2 LAN plumbing breaks (IP churn) | Low | Portproxy pins to 127.0.0.1 (survives WSL restarts); DHCP reservation for the Windows IP; `make lan` diagnoses |

## 8. Build Phases

See [`TRICORDER_PLAN.md`](TRICORDER_PLAN.md) — epic TNGC-10, tickets TNGC-11…17.
Summary: **0** record reset · **1** wall on the LAN · **2** await loop v1 (superseded)
· **3** Tricorder backend + outbound link · **4** Tricorder PWA · **5** personal data
plane (saved articles) · **6** appliance hardening (ear + await-loop leftovers deleted, supervisor,
torture tests).

---

## Appendix A — v1 research findings (July 2026) — *historical*

Preserved because the reasoning still informs v2 (and TNGC-4). The **struck-through
consequences** are obsolete under v2.

| Finding | v1 consequence → v2 status |
|---|---|
| Claude Code has native voice dictation but no wake-word mode | ~~Build our own ear daemon~~ → moot; input is phone PTT |
| Channels (experimental) can push into a running session; needs a dev flag | The blocking `await_message` loop was tried instead (TNGC-13) and wedged in soak → channels adopted after all (TNGC-18) |
| No native TTS; community pattern is hooks → external TTS | Confirmed v2: the webapp owns TTS behind `speak` (Piper today) |
| Picovoice Porcupine free tier died June 2026 | ~~openWakeWord instead~~ → moot |
| Qwen3-TTS (Apache-2.0) zero-shot clones from 3s reference | Still the Majel-clone plan — shelved in TNGC-4 with the legal/ToS notes |
| Roddenberry estate's Majel voice never licensable; cloud providers block third-party voice cloning | Ditto — local-only, private home use, per TNGC-4 |
| Spotify Feb 2026 tightening (dev-mode caps, endpoint removals) | ~~Code against the migration guide~~ → Spotify scrapped entirely; YouTube is the media path |
| For 2–10s commands, VAD-endpoint-then-batch beats streaming STT | Moot — the phone does STT; button release is the endpoint |
| Long-running sessions: `--resume`, Stop hooks, MCP subprocess wart (claude-code#36730) | Still governs Phase 6 hardening |

## Appendix B — v1 architecture (superseded)

v1 (design v1, 2026-07-20) was: always-on **ear daemon** (openWakeWord "computer" →
Silero VAD → faster-whisper) → **channel MCP server** pushing transcripts into the
session via the experimental channels feature → console MCP → wall, with **Spotify**
as the music system and a **Majel-cloned** voice as Phase 2. Of that stack: the ear
daemon is dead code awaiting deletion (TNGC-17), channels was never enabled in anger,
Spotify was cancelled, and the Majel clone is shelved (TNGC-4). The console-MCP → API
server → WS hub → LCARS wall spine survives unchanged — it was always the part that
worked.
