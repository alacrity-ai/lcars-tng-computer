# The container fence (TNGC-19 + TNGC-20)

**The host runs Docker and browsers — nothing else.** Repo code executes only
inside two containers:

- **`stack`** (`make dev`) — server (:3789) + vite wall (:5173) + Piper TTS
  (:3790), driven by the same `scripts/dev.mjs` as always. :5173 is published
  to the LAN (TV kiosk); :3789/:3790 to host loopback only.
- **`computer`** (`make computer`) — the Claude session, its file tools,
  hooks, and both MCP servers (console, bridge), behind a default-deny egress
  firewall. Bridge :3791 published to host loopback (say.sh).

**Why:** a compromised Tricorder credential means arbitrary natural-language
command of a `--dangerously-skip-permissions` session. The session fence
keeps host secrets (SSH keys, the agentsecrets master key, other repos)
unreachable by construction. The stack fence closes the second-order hole:
code the session writes into the repo *executes* — but now inside a box, not
as a host process. A malicious "self-improvement" is contained, visible in
git, and revertible.

The **dogfooding loop is untouched**: both containers bind-mount the repo
rw; the session edits a panel, the stack container's vite hot-reloads it
onto the wall.

## The read-only fence rule

Paths the HOST executes are overlaid **read-only in BOTH containers**:
`docker/`, `compose.yaml`, `Makefile`, `scripts/`, `.git/`. Nothing running
inside a fence can rewrite the fence, the host tooling, or git hooks —
change those from the host only. (`.git` ro also means commits happen from
the host; the Computer never committed its own work anyway. `git status`
inside may warn about an unwritable index — harmless.)

Two host-side disciplines complete the picture:

- **Never run `pnpm install` for this repo on the host** — postinstall
  scripts are repo code. Install inside a container:
  `docker compose run --rm --no-deps computer pnpm install <pkg>`.
- **Recommended, one-time:** `git config --global core.hooksPath
  ~/.config/git/hooks` — makes every repo on the machine immune to
  `.git/hooks` injection. (Repos using husky set a local hooksPath, which
  still wins; plain `.git/hooks` users would need per-repo exceptions.)

## Pieces

| File | Role |
|---|---|
| `docker/Dockerfile` | session image: node:24 + pnpm + Claude Code CLI + git + iptables/iproute2 |
| `docker/stack.Dockerfile` | stack image: node:24 + pnpm + uv/python3 (Piper is CPU-only onnxruntime — no GPU needed) |
| `docker/entrypoint.sh` | session only — root: firewall + volume chown → drop to `node` → exec |
| `docker/init-firewall.sh` | default-deny egress (v4 ipset allowlist, v6 rejected), allows stack:3789 on the compose subnet + host-gateway:3789 fallback; self-verifying, refuses to start on failure |
| `docker/allowed-domains.txt` | session egress allowlist — bind-mounted ro, **edit + relaunch, no rebuild** |
| `compose.yaml` | both services, mounts (incl. the ro overlays), ports, env. TTS venv lives in the `tng-tts-venv` volume (`UV_PROJECT_ENVIRONMENT`), never in the repo's `.venv` |

## Day-to-day

```bash
make dev             # stack container, foreground logs, Ctrl+C stops   [terminal 1]
make computer        # session container                                [terminal 2]
make health          # from the host — all ports published to loopback
make down            # compose down + bare-mode leftovers by port

make stack-image     # rebuild stack image
make computer-image  # rebuild session image (e.g. new Claude Code release)
make dev-bare        # old host launches — fallback only, NO fence
make computer-bare
```

- Boot order: stack first, then computer (console-mcp targets
  `http://stack:3789` by service DNS; with a bare stack instead, launch the
  session with `TNG_SERVER_URL=http://host.docker.internal:3789`).
- **First `make computer` ever**: Claude login (browser + paste code) —
  persists in the `tng-claude-config` volume. The channels "local
  development" dialog appears every launch.
- First `make dev` after an image wipe: uv downloads TTS deps into the venv
  volume (a minute or two); later launches are instant.
- The bridge takes ~8s to appear on :3791 after session launch.

## Widening / narrowing the session's egress

Add/remove hostnames in `docker/allowed-domains.txt`, relaunch the session.
Domains resolve to IPs at container start — a week-old session can go stale
against CDN rotations; relaunch fixes that too. WebSearch is server-side
(api.anthropic.com) and needs nothing. The stack container has ordinary
egress (nothing secret inside; the repo is public).

## Troubleshooting

- **"ports are not available"** → a bare-mode process (or old container)
  holds the port: `make down`, or `fuser -k <port>/tcp` for bare leftovers.
- **Firewall FAIL at start** → DNS hiccup at resolve time; relaunch. If
  api.anthropic.com genuinely can't resolve, the box's network is the problem.
- **Session can't reach the console** (speak fails) → is the stack container
  up? Both must be on the compose network (`docker compose ps`).
- **Login loop / corrupt session state** → `docker volume rm
  tng-computer_tng-claude-config`, log in fresh.
- **TTS env broken** → `docker volume rm tng-computer_tng-tts-venv`, next
  `make dev` rebuilds it.

## Residual risk (accepted, eyes open)

- Session OAuth token in its volume: theft = quota burn until revoked.
- A valid Tricorder login can still use the Computer's legitimate powers
  (wall, allowlisted browsing, editing app code — visible in git). TNGC-15's
  door defenses are the first layer.
- The stack serves JS to LAN browsers; a malicious panel is contained by the
  browser sandbox on the kiosk machine.
