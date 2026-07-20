# TNG Computer

A personal Star Trek TNG ship's computer. A persistent **Claude Code session is the brain**;
this monorepo is everything around it: the LCARS display terminal, the audio pipeline, and
the MCP servers Claude uses to drive them.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design. Tracked on kbRelay board **TNGC**.

## Layout

| Path | What |
|---|---|
| `apps/web` | Vite + React fullscreen LCARS webapp (display, TTS audio out, Spotify device) |
| `apps/server` | Node API: WebSocket hub, TTS front, Spotify auth |
| `apps/ear` | Python voice daemon: wake word → VAD → STT (Phase 3) |
| `apps/tts` | Python TTS sidecar: `/synth` text→WAV (Piper baseline; Qwen3-TTS Majel-clone slot) |
| `packages/shared` | Typed WebSocket protocol + panel props shared across TS packages |
| `packages/console-mcp` | MCP server Claude uses: `display` / `speak` / `chime` / `screen_state` |
| `packages/bridge` | Channel MCP server: voice transcripts → running Claude session (Phase 3) |
| `claude/` | The Computer's identity: `CLAUDE.md`, skills, MCP registrations, settings |
| `voice/` | Reference clips + wake-word training artifacts (gitignored) |

## Run

```bash
pnpm install
uv sync --project apps/tts
uv run --project apps/tts python -m piper.download_voices en_US-lessac-medium --data-dir voice/piper

pnpm dev          # server (:3789) + web (:5173) + TTS sidecar (:3790)
pnpm kiosk        # opens the webapp fullscreen in Chrome kiosk mode
```

The TTS sidecar is optional at runtime — if it's down, spoken lines degrade to
on-screen captions. Engine selection: `TNG_TTS_ENGINE=piper|qwen3` (qwen3 is the
Majel-clone slot, pending reference audio — see TNGC-4).
