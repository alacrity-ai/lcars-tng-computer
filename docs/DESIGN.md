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
│ device login + PIN          │          │  persona + skills + MCP tools      │
│ hold-to-talk → native STT   │          │   ▲ await_message returns          │
└──────────────┬──────────────┘          │   │ {user, device, transcript}     │
               │ HTTPS (transcript)      │ ┌─┴──────────────────────────────┐ │
┌──────────────▼──────────────┐          │ │ BRIDGE (MCP server)            │ │
│ TRICORDER API (Cloudflare)  │          │ │ • blocking await_message tool  │ │
│ tricorder.lalalimited.com   │  outbound│ │ • outbound WSS client          │ │
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
| **No channels.** The session gives itself agency with a blocking `bridge.await_message` MCP tool. | MCP is pull-only — servers can't start turns; channels was the workaround but it's a research preview behind a dev flag. The blocking-tool loop works on stable Claude Code: while blocked, no tokens burn; when a message arrives the tool returns and the session acts, then re-arms. |
| **Outbound-only connectivity.** The bridge dials out to the Tricorder DO and holds a WebSocket. | Nothing on the internet can reach into the home network; no tunnel, no port forwarding. The phones meet the brain at the Durable Object. |
| **One monorepo.** Tricorder is `apps/tricorder`, deployed to Cloudflare (`tricorder.lalalimited.com`). | One product, colocated. The deploy target differs; the code lives together. |
| **Attribution is the identity model.** Every message is `{user, device, transcript, ts}`. | Users belong to the household tenant; "save this to **my** tricorder" resolves per *speaker*, not per session. Foundation for per-user saved items and future shared entities. |
| **YouTube is the media path.** Spotify scrapped. | It works today and needs no auth dance; the v1 Spotify plan (PKCE, Web Playback SDK, dev-mode caps) is cancelled. |
| **Piper is the voice.** Majel clone shelved (TNGC-4). | Good-enough now; the Qwen3-TTS clone slot in `apps/tts` stays for when we circle back. Voice-clone research is preserved in TNGC-4, not here. |

## 3. Components

### 3.1 The Brain — Claude Code session (`claude/`)

A persistent interactive session. Identity from `CLAUDE.md` (it *is* the Computer:
terse, precise, "Working." then acts, "Unable to comply." for refusals), ~20 capability
skills loaded on demand (weather, maps, charts, media, quiz, timers, night sky, recall,
…), pre-allowed permissions so it never stalls mid-conversation.

**The event loop (v2's control-flow inversion):** when idle, the session calls
`bridge.await_message(timeout)`. The call blocks — zero inference, zero tokens — until
a transcript arrives; the session services it through the console tools, then re-arms.
A persona rule makes re-arming reflexive; a Stop hook is the safety net (a stop with no
pending await is blocked with "re-arm"). The terminal stops being an input path and
becomes what it actually is: the development console.

### 3.2 The Voice Input — Tricorder (`apps/tricorder`, Cloudflare)

A PWA any household member logs into as a device ("Leif's Phone", "Mom's Phone",
"Shared Guest iPad") with a PIN → long-lived device token. Hold-to-talk drives the
platform's own speech recognition; release posts the transcript. A plain text input
(with the keyboard's mic key) is the zero-API-risk fallback. The app shows Computer
online/offline from the DO's socket state.

Backend: Hono Worker + **per-tenant Durable Object** + D1 (`tenants`, `users`,
`devices`, `messages`, later `saved_items`). The DO is the meeting point: phones post
into the queue; the bridge holds an outbound WSS from home and receives pushes.

**Queue contract:** persist every transcript → push down the socket → bridge acks on
hand-to-session → unacked messages replay on reconnect → voice commands **expire 60s**
after enqueue at replay time (durability is for Wi-Fi blips, not for time-shifting
speech — "queue Madonna" from 20 minutes ago must not fire on reboot). Expired drops
are logged.

### 3.3 The Bridge (`packages/bridge`)

The only component that knows how messages enter the session. Three faces:
`await_message` (blocking MCP tool the session calls), the outbound WSS client (cloud
messages), and a local `POST /message` (office push-to-talk, same message shape,
`device: "office"`). If the delivery mechanism ever changes — channels graduates, or we
move to an Agent SDK streaming host — only this package changes.

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
3. The session's pending `await_message` returns the message. Persona: instant spoken
   acknowledgment (`speak`, non-blocking), then the work.
4. Claude researches, calls `display("subject", …)` then `speak("Bees are…")` — the
   API server pushes panels over the WS hub, the Piper sidecar synthesizes, the TV
   speaks.
5. Claude re-arms `await_message`. If the guest says "save this to my tricorder",
   the *attribution on that new message* decides whose saved items it lands in.

Latency budget: PTT release → wall responding ≈ phone STT (sub-second) + cloud hop
(~100–300ms) + first tool call (~1–2s), masked by the acknowledgment line.

## 5. Session Configuration

- **Launch:** plain `claude` in `claude/` (`make computer`). No dev flags — the v1
  `--dangerously-load-development-channels` requirement is gone with channels.
- **Persona:** speak through `console.speak`, display through `console.display`;
  ≤2 spoken sentences unless asked; display-before-speak ordering; instant
  acknowledgments with `waitForPlayback: false`; **when idle, `await_message`**.
- **Permissions:** pre-allow `console.*`, `bridge.*`, `tricorder.*`, WebFetch/WebSearch,
  whitelisted Bash. MCP tool-timeout raised to cover long `await_message` blocks.
- **Hooks:** SessionStart (health check, boot panel, "Computer online."); Stop
  (block stops that leave no pending await → re-arm; clears the wall's working badge).

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
| Session fails to re-arm the await loop | Medium, early | Persona rule + Stop-hook block; Phase 2 AC includes an overnight soak and a mid-task-failure test |
| Blocking-tool pattern is a convention, not a contract | Low | Channels (if it graduates) or an Agent SDK streaming-input host — either replaces only the bridge's delivery guts |
| Web Speech API quirks (iOS prefixes, permission prompts) | Medium | Text input + keyboard-mic dictation is always present; PTT is progressive enhancement |
| Cloudflare / internet outage | Low | Wall + office PTT are LAN-local and keep working; PWA shows offline |
| Interleaved commands from multiple speakers | Certain, by design | `speak` serializes; attribution keeps "my" correct per message; fine at household scale |
| WSL2 LAN plumbing breaks (IP churn) | Low | Portproxy pins to 127.0.0.1 (survives WSL restarts); DHCP reservation for the Windows IP; `make lan` diagnoses |

## 8. Build Phases

See [`TRICORDER_PLAN.md`](TRICORDER_PLAN.md) — epic TNGC-10, tickets TNGC-11…17.
Summary: **0** record reset · **1** wall on the LAN · **2** await_message loop (local)
· **3** Tricorder backend + outbound link · **4** Tricorder PWA · **5** personal data
plane (saved articles) · **6** appliance hardening (ear/channels deleted, supervisor,
torture tests).

---

## Appendix A — v1 research findings (July 2026) — *historical*

Preserved because the reasoning still informs v2 (and TNGC-4). The **struck-through
consequences** are obsolete under v2.

| Finding | v1 consequence → v2 status |
|---|---|
| Claude Code has native voice dictation but no wake-word mode | ~~Build our own ear daemon~~ → moot; input is phone PTT |
| Channels (experimental) can push into a running session; needs a dev flag | ~~Transcript-injection path~~ → replaced by the blocking `await_message` loop; channels is a possible future upgrade |
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
