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
| `packages/shared` | Typed WebSocket protocol + panel props shared across TS packages |
| `packages/console-mcp` | MCP server Claude uses: `display` / `speak` / `chime` / `screen_state` |
| `packages/bridge` | Channel MCP server: voice transcripts → running Claude session (Phase 3) |
| `claude/` | The Computer's identity: `CLAUDE.md`, skills, MCP registrations, settings |
| `voice/` | Reference clips + wake-word training artifacts (gitignored) |

## Run

```bash
pnpm install
pnpm dev          # starts server (:3789) + web (:5173), prints the Claude launch command
pnpm kiosk        # opens the webapp fullscreen in Chrome kiosk mode
```
