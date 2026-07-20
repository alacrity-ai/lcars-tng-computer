# TNG Computer — Design Document

*A personal Star Trek TNG ship's computer: always-on, wake-word driven, Claude Code as the brain, an LCARS webapp as the face and voice.*

**Status:** Draft v1 — 2026-07-20
**Repo:** `~/lets-get-rich/tng-computer` (monorepo: webapp, API, voice daemon, Claude skills/MCP package)

---

## 1. Executive Summary

A long-running **Claude Code session is the entire brain**. It hears the user (via a wake-word + speech-to-text pipeline that injects transcripts into the session), decides what to do, and acts through MCP tools. The **webapp is a terminal Claude controls, not an app with logic of its own**: a full-screen Vite+React LCARS display that renders whatever Claude tells it to render, speaks whatever Claude tells it to say (in a Majel-Barrett-style computer voice), and hosts the Spotify playback device.

Everything Claude can't do natively — visualization, audio output, music playback — lives in the webapp behind MCP tools. Everything else — understanding, reasoning, orchestration, web browsing, service integration — is Claude.

```
        "Computer, play some jazz and show me the weather"
                          │
   ┌──────────────────────▼──────────────────────┐
   │  EAR DAEMON (Python)                        │
   │  openWakeWord("computer") → Silero VAD      │
   │  → faster-whisper STT → transcript          │
   └──────────────────────┬──────────────────────┘
                          │ HTTP POST (localhost)
   ┌──────────────────────▼──────────────────────┐
   │  BRIDGE (custom channel MCP server)         │
   │  mcp.notification → running Claude session  │
   └──────────────────────┬──────────────────────┘
                          │
   ┌──────────────────────▼──────────────────────┐
   │  CLAUDE CODE SESSION (the Computer)         │
   │  skills + CLAUDE.md persona + MCP tools     │
   └──────┬───────────────┬───────────────┬──────┘
          │ console.display│ console.speak │ music.play
   ┌──────▼───────────────▼───────────────▼──────┐
   │  API SERVER (Node)                          │
   │  WebSocket push · TTS synth · Spotify PKCE  │
   └──────────────────────┬──────────────────────┘
                          │ WebSocket
   ┌──────────────────────▼──────────────────────┐
   │  LCARS WEBAPP (Vite+React, fullscreen)      │
   │  panels · audio out (Majel TTS) ·           │
   │  Spotify Web Playback SDK device            │
   └─────────────────────────────────────────────┘
```

---

## 2. Research Findings That Shaped This Design

Verified July 2026. These invalidate a lot of older tutorials.

| Finding | Consequence |
|---|---|
| Claude Code has **native voice dictation** (`/voice`, push-to-talk) but **no wake-word / always-listening mode** | We still need our own ear daemon; native `/voice` is a useful dev-mode fallback only |
| **Channels** (experimental) let an MCP server push events into a *running* session via MCP notifications; custom channels need `--dangerously-load-development-channels` | This is our transcript-injection path. Fallback if channels shift under us: Agent SDK streaming-input loop (§9) |
| Claude Code has **no native TTS**; community pattern is Stop/PostToolUse hooks → external TTS | Confirms plan: webapp owns TTS behind an MCP `speak` tool |
| **Picovoice Porcupine free tier died June 30, 2026** | openWakeWord (Apache-2.0) with a custom-trained "computer" model is the wake-word path |
| **Qwen3-TTS (Jan 2026, Apache-2.0)** does zero-shot voice cloning from a **3-second** reference; ~97ms streaming, low VRAM | Primary TTS engine. Fallbacks: Chatterbox (MIT), XTTS-v2 |
| Roddenberry estate's official Majel voice shipped only as narration in a 2024 Vision Pro app — **never licensable**; the one community Majel model died with PlayHT (sunset Dec 2025) | We clone locally from cleaned TNG clips for private home use (§6 has the legal/ToS notes) |
| ElevenLabs / OpenAI **block cloning voices you don't own**; local open models don't | Cloud "Majel-adjacent" voice design is the compliant alternative if we want one |
| **Spotify Feb 2026 tightening**: dev-mode apps capped at 5 users, owner must have Premium, `/search` limit max 10, many catalog endpoints removed; `localhost` redirect URIs banned (use `127.0.0.1`); Recommendations/Audio Features gone since Nov 2024 | Fine for single-user home use. Playback control + Web Playback SDK survived. Code against the Feb 2026 migration guide only |
| For 2–10s commands, **VAD-endpoint-then-batch-transcribe beats streaming STT**; Silero VAD is the standard endpointer | Ear daemon: Silero VAD capture → faster-whisper batch. Groq whisper-large-v3-turbo ($0.04/hr) as near-free cloud fallback |
| Long-running sessions: `--resume` restores full context; Stop hooks / `/loop` keep sessions alive; known wart around MCP subprocess cleanup (claude-code#36730) | Supervisor script + session-resume strategy in §8 |

---

## 3. Components

### 3.1 The Brain — Claude Code session (`claude/`)

A persistent interactive Claude Code session launched with our channel plugin. Its identity comes from:

- **`CLAUDE.md` persona**: it *is* the Enterprise computer. Terse, precise, slightly formal. Answers verbally via `console.speak`, visually via `console.display`. Never says "I'll go ahead and…" — it says "Working." then does it.
- **Skills**: `music` (Spotify flows), `display` (panel vocabulary and when to use which), `briefing` (morning summary), etc.
- **MCP servers**: `console` (display/speak), `music` (Spotify), `bridge` (voice channel in).
- **Permissions**: pre-allowed tool list so it never blocks on a prompt while the user is standing in the room talking to it.

### 3.2 The Ears — voice daemon (`apps/ear/`, Python)

Always-on local process owning the microphone:

1. **Wake word**: openWakeWord running a custom-trained **"computer"** model (one-time synthetic-TTS training pipeline, ~1.5 hr on Colab; the official notebook has bit-rotted — use the maintained community fork). Continuous, CPU-cheap.
2. **Earcon**: on wake, tell the API server to play the TNG acknowledgment chirp on the webapp (instant feedback that it's listening).
3. **Capture + endpointing**: Silero VAD; utterance ends after ~600–800ms of silence (tunable).
4. **STT**: faster-whisper `large-v3-turbo` / `distil-large-v3` locally (sub-second for a 5s clip on RTX-class GPU). Fallback: Groq `whisper-large-v3-turbo` REST.
5. **Inject**: POST transcript to the bridge channel server → MCP notification into the Claude session.

The daemon knows nothing about meaning. It converts sound into text and passes it on.

> **⚠️ WSL2 caveat:** WSL2 has no first-class mic access. Options, in order of preference: (a) run the ear daemon natively on Windows (Python + openWakeWord run fine there) POSTing to the bridge over localhost; (b) WSLg/PulseAudio passthrough (fiddly); (c) long-term, move the whole stack to a dedicated Linux mini-PC by the screen. Decision needed at Phase 3.

### 3.3 The Bridge — channel MCP server (`packages/bridge/`)

Small MCP server registered in the session's `.mcp.json`, declaring the experimental `claude/channel` capability:

- Listens on localhost HTTP for `{ "transcript": "...", "confidence": ... }` from the ear daemon.
- Pushes it into the session as a channel notification (`<channel source="voice">` event).
- Session launched via `claude --dangerously-load-development-channels server:bridge` (custom channels aren't on the curated allowlist yet).

**Risk**: channels are a research preview; protocol may change. Mitigation in §9.

### 3.4 The Hands — console + music MCP servers (`packages/console-mcp/`)

The tool surface Claude uses to drive the physical room. Thin: each tool is an HTTP call to the API server.

**`console` tools**
- `display(view, props)` — render a named panel: `status`, `weather`, `calendar`, `now-playing`, `web`, `chart`, `text`, `alert`, `blank`…
- `speak(text, opts)` — synthesize in the Computer voice and play through the webapp. Returns when playback completes (so Claude can sequence speech).
- `chime(name)` — earcons: acknowledge, complete, error, red-alert.
- `screen_state()` — what's currently displayed (so Claude can reason about the screen).

**`music` tools** (own thin Spotify MCP — the community servers are fragmented/stale; we need ~6 endpoints)
- `search(query)` (limit ≤10 — Feb 2026 cap), `play(uri|query)`, `pause`, `next`, `queue(uri)`, `now_playing`, `set_volume`.

### 3.5 The Face & Voice — API server + webapp (`apps/server/`, `apps/web/`)

**API server (Node/TypeScript, Fastify or Hono):**
- WebSocket hub pushing display/speak/chime commands to the webapp.
- **TTS service**: fronts a local **Qwen3-TTS** process holding the cloned Majel-style voice (reference: 30–60s of cleaned, isolated TNG computer lines). Streams audio to the webapp. Fallbacks: Chatterbox → XTTS-v2 → a stock voice so the system never goes mute.
- **Spotify auth**: Authorization Code + PKCE. **Redirect URI must be `http://127.0.0.1:<port>/callback` — `localhost` is banned.** Owner Premium required. Stores/refreshes tokens (access 1h, refresh 6mo).
- REST endpoints mirroring the MCP tools (the MCP servers are thin clients of this API).

**Webapp (Vite + React, fullscreen kiosk):**
- LCARS aesthetic: authentic panel geometry, the classic palette (gold `#FF9900`, lavender `#CC99CC`, blue `#9999CC`, orange-red `#CC6666`), Antonio/Khan-style condensed type, beveled elbow frames. Idle state = slowly updating status board, like a bridge console.
- Panel registry keyed by `view` name; WebSocket messages swap/animate panels.
- **Audio out**: plays TTS streams and earcons. (Browser autoplay policy requires one user gesture after load to unlock audio — kiosk boot flow includes a single "engage" tap.)
- **Spotify Web Playback SDK**: the tab registers itself as a Connect device ("TNG Computer") so music plays out of the same speakers. Needs Widevine/EME (Chrome/Edge). Playback calls must target this `device_id` or they 404 `NO_ACTIVE_DEVICE`.

---

## 4. End-to-End Flow

"Computer, play some Miles Davis and dim the lights display."

1. Ear daemon wake-word hit → chirp plays on webapp → VAD captures utterance → faster-whisper → transcript.
2. POST → bridge → MCP notification → Claude session receives `<channel source="voice">play some miles davis…</channel>`.
3. Claude (persona + skills): calls `music.search("Miles Davis")`, `music.play(uri)`, `console.display("now-playing", {...})`, `console.speak("Playing Miles Davis.")`.
4. API server: Spotify API targets the webapp's device_id; WebSocket pushes the now-playing panel; Qwen3-TTS synthesizes and the webapp speaks.
5. Total target latency, wake→first spoken response: **< 4s** (wake ~0.2s, capture = utterance length, STT <1s, Claude first tool call ~1–2s, TTS start ~0.3s). Chirp + instant "Working…" panel make perceived latency much lower.

---

## 5. Monorepo Layout

```
tng-computer/
├── apps/
│   ├── web/            # Vite + React LCARS frontend
│   ├── server/         # Node API: WebSocket hub, TTS front, Spotify auth
│   └── ear/            # Python: openWakeWord + Silero VAD + faster-whisper
├── packages/
│   ├── console-mcp/    # MCP server: display / speak / chime / music tools
│   ├── bridge/         # MCP channel server: voice transcript → session
│   └── shared/         # TS types shared by web/server/mcp (panel props, WS protocol)
├── claude/
│   ├── CLAUDE.md       # Computer persona + operating rules
│   ├── skills/         # music, display, briefing, ...
│   ├── settings.json   # hooks, permissions (pre-allowed tools)
│   └── mcp.json        # console, music, bridge registrations
├── voice/
│   ├── reference/      # cleaned Majel reference clips (gitignored)
│   └── training/       # openWakeWord "computer" model + training notes
├── docs/
│   └── DESIGN.md       # this file
└── package.json        # pnpm workspaces; ear managed with uv
```

Tooling: **pnpm workspaces** (TS side), **uv** (Python side), one `dev` script that brings up server + web + ear + prints the `claude` launch command.

---

## 6. The Voice (deep-dive)

**Goal:** the flat, warm, precise TNG computer delivery — this is the soul of the project.

**Primary path — local clone (private, non-commercial home use):**
1. Collect 30–60s of Majel computer lines from TNG; the raw audio carries music/SFX and the post-production "computer filter" — clean with a source separator (Demucs/UVR) and pick dry-ish lines.
2. Zero-shot clone with **Qwen3-TTS** (Apache-2.0, 3s minimum reference, ~97ms streaming, modest VRAM). Evaluate; if the filtered timbre confuses it, fall back to **Chatterbox** (MIT, ~10s reference — note: outputs carry Resemble's inaudible watermark) or **XTTS-v2** (non-commercial license — fine here).
3. Optional post-chain in the server: subtle band-pass + compression to taste, matching the shipboard sound.

**Compliant alternative:** ElevenLabs Voice Design prompt ("calm, warm, precise adult female computer voice, mid-Atlantic, measured, slightly formal") — Majel-*adjacent*, zero ToS ambiguity, ~$22/mo.

**Legal/ToS posture (not legal advice):** CA's post-mortem publicity right (Civ. Code §3344.1) is scoped to *commercial* use; the pending NO FAKES Act is not yet law. Private, non-commercial, in-home use of a locally-run clone appears outside these triggers, but it's untested — so: local models only (cloud providers' ToS prohibit it anyway), never publish the cloned voice model or generated audio, and this stays a home project, not a YouTube monetization asset featuring "Majel Barrett."

---

## 7. Claude Session Configuration

- **Launch:** `claude --dangerously-load-development-channels server:bridge` inside `claude/` (wrapped in a `computer` supervisor script).
- **Persona (`CLAUDE.md`):** speak through `console.speak`, display through `console.display`; verbal replies ≤ 2 sentences unless asked for detail; acknowledge long tasks with "Working." then a chime on completion; TNG diction ("Unable to comply" for refusals).
- **Permissions:** pre-allow `console.*`, `music.*`, WebFetch/WebSearch, and whitelisted Bash — the Computer must never stall on a permission prompt mid-conversation.
- **Hooks:**
  - `SessionStart`: verify server/ear health, display boot panel, speak "Computer online."
  - `Stop`: optional safety net — if the turn produced no `speak` call but has a user-facing answer, synthesize a spoken summary.
- **Model:** Sonnet (org policy) — right latency/cost profile for an always-on conversational agent anyway.

## 8. Always-On Operation

- Supervisor script (systemd user unit or pm2): starts server, ear daemon, TTS process, Chromium in kiosk mode, and the Claude session; restarts on crash; resumes the session with `--resume <id>` so room context survives restarts.
- Context growth: auto-compaction handles long sessions; nightly scheduled restart with a fresh session (previous day summarized into a memory note) keeps costs and latency flat.
- Known wart: MCP subprocesses sometimes outlive sessions (claude-code#36730) — supervisor sweeps orphans on restart.

## 9. Risks & Fallbacks

| Risk | Likelihood | Fallback |
|---|---|---|
| Channels protocol changes / dev flag removed (research preview) | Medium | **Agent SDK streaming-input loop**: a small Node host using `query()` with streaming input replaces "interactive Claude Code + channel" — same brain, same MCP tools, transcript injection becomes trivial. Bridge is isolated so only it changes. |
| WSL2 mic access | High (known pain) | Ear daemon runs natively on Windows, POSTs over localhost; or dedicated Linux box. |
| Qwen3-TTS quality on the filtered Majel timbre | Medium | Chatterbox → XTTS-v2 → ElevenLabs Voice Design (Majel-adjacent). |
| openWakeWord custom-model false accepts/rejects ("computer" is a common word) | Medium | Tune threshold + VAD gating; require short pause after wake word; retrain with more synthetic negatives. |
| Spotify tightens dev mode further | Low-Medium | Single-user usage is the most protected class; worst case, swap the `music` MCP to a local library/player. |
| Whisper hallucination on silence | Low | VAD gating (already the mitigation); drop transcripts below confidence floor. |

## 10. Build Phases

1. **Phase 0 — Scaffold**: monorepo, pnpm+uv, shared WS protocol types, kiosk shell with static LCARS boot screen.
2. **Phase 1 — Text loop (no voice)**: console MCP + API + webapp; drive the display by *typing* into the Claude session. Proves the Claude→MCP→WebSocket→panel spine.
3. **Phase 2 — The Voice**: Qwen3-TTS service, Majel reference prep, `console.speak`, earcons. The moment it first talks back.
4. **Phase 3 — The Ears**: openWakeWord training, ear daemon, bridge channel, end-to-end "Computer, …" → spoken reply. (WSL mic decision lands here.)
5. **Phase 4 — Music**: Spotify PKCE + Web Playback SDK + music MCP + now-playing panel.
6. **Phase 5 — Polish**: more panels (weather, calendar, web viewer, charts), briefing skill, red-alert mode, nightly session rotation, multi-room ideas.

Each phase ends with a demo you can show someone.
