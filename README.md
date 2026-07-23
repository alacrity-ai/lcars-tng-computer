# TNG Computer

A personal Star Trek TNG ship's computer. A persistent **Claude Code session is the brain**;
this monorepo is everything around it: the LCARS display terminal, the audio pipeline,
the MCP servers Claude uses to drive them, and the Tricorder — a phone PWA the household
uses to talk to it from anywhere.

The load-bearing trick: the brain is a development agent living inside its own running
source tree. Ask it for a panel that doesn't exist and it writes the panel, hot-reloads
it onto the wall, and uses it — in one request.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the design and
[`docs/TRICORDER_PLAN.md`](docs/TRICORDER_PLAN.md) for the current phased plan
(the "Tricorder era", epic TNGC-10). Tracked on kbRelay board **TNGC**.

## How input flows

Phones (any network) → Tricorder PWA (user login, hold-to-talk or type) →
Cloudflare Worker + per-tenant Durable Object queue → **outbound** WebSocket held
by the home bridge (no inbound holes into the house) → channel event pushed into
the Claude session → the wall answers. Office push-to-talk posts to the bridge's
local endpoint and rides the same path.

## Layout

| Path | What |
|---|---|
| `apps/web` | Vite + React fullscreen LCARS webapp (display, TTS audio out, YouTube media) |
| `apps/server` | Node API: WebSocket hub, TTS front |
| `apps/tts` | Python TTS sidecar: `/synth` text→WAV (Piper; Qwen3-TTS slot shelved with TNGC-4) |
| `apps/ear` | *(dead — v1 wake-word daemon; removal tracked in TNGC-17)* |
| `apps/tricorder` | Cloudflare Worker + per-tenant DO queue + D1 + the Tricorder PWA, at myhome.computer |
| `packages/shared` | Typed WebSocket protocol + panel props shared across TS packages |
| `packages/contract` | The tiny versioned cloud↔bridge message contract |
| `packages/console-mcp` | MCP server Claude uses: `display` / `speak` / `chime` / `screen_state` |
| `packages/bridge` | Bridge MCP server: channel-push delivery into the session + outbound WSS to Tricorder |
| `claude/` | The Computer's identity: `CLAUDE.md`, skills, MCP registrations, settings |
| `voice/` | Piper voice models + legacy training artifacts |

## Run

```bash
make setup        # one-time: pnpm install, TTS deps, Piper voice model
make dev          # the stack IN DOCKER: server (:3789) + web (:5173)
                  # + TTS (:3790)                                        [terminal 1]
make kiosk        # fullscreen LCARS display                             [terminal 2]
make computer     # the Claude session that IS the Computer, in its own
                  # Docker fence (docs/sops/computer-container.md)       [terminal 3]
make lan          # TV-room kiosk status/instructions (docs/sops/tv-room-kiosk.md)

make demo         # tour the display without Claude (panels, speech, chimes)
make health       # is everything up?
```

The TTS sidecar is optional at runtime — if it's down, spoken lines degrade to
on-screen captions. Engine selection: `TNG_TTS_ENGINE=piper|qwen3` (qwen3 is the
Majel-clone slot, pending reference audio — see TNGC-4).

## License

[MIT](LICENSE).
