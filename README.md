# TNG Computer

A personal Star Trek TNG ship's computer. A persistent **Claude Code session is the brain**;
this monorepo is everything around it: the LCARS display terminal, the audio pipeline, and
the MCP servers Claude uses to drive them.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the design and
[`docs/TRICORDER_PLAN.md`](docs/TRICORDER_PLAN.md) for the current phased plan
(the "Tricorder era", epic TNGC-10). Tracked on kbRelay board **TNGC**.

## Layout

| Path | What |
|---|---|
| `apps/web` | Vite + React fullscreen LCARS webapp (display, TTS audio out, YouTube media) |
| `apps/server` | Node API: WebSocket hub, TTS front |
| `apps/tts` | Python TTS sidecar: `/synth` text→WAV (Piper; Qwen3-TTS slot shelved with TNGC-4) |
| `apps/ear` | *(dead — v1 wake-word daemon; removal tracked in TNGC-17)* |
| `packages/shared` | Typed WebSocket protocol + panel props shared across TS packages |
| `packages/console-mcp` | MCP server Claude uses: `display` / `speak` / `chime` / `screen_state` |
| `packages/bridge` | Message-queue MCP server (rework to blocking `await_message` in TNGC-13) |
| `claude/` | The Computer's identity: `CLAUDE.md`, skills, MCP registrations, settings |
| `voice/` | Piper voice models + legacy training artifacts |

## Run

```bash
make setup        # one-time: pnpm install, TTS deps, Piper voice model
make dev          # server (:3789) + web (:5173) + TTS sidecar (:3790)   [terminal 1]
make kiosk        # fullscreen LCARS display                             [terminal 2]
make computer     # the Claude session that IS the Computer              [terminal 3]
make lan          # TV-room kiosk status/instructions (docs/sops/tv-room-kiosk.md)

make demo         # tour the display without Claude (panels, speech, chimes)
make health       # is everything up?
```

The TTS sidecar is optional at runtime — if it's down, spoken lines degrade to
on-screen captions. Engine selection: `TNG_TTS_ENGINE=piper|qwen3` (qwen3 is the
Majel-clone slot, pending reference audio — see TNGC-4).
