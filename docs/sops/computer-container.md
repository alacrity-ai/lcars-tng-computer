# The Computer session container (TNGC-19)

`make computer` runs the brain — the Claude Code session, its file tools,
hooks, and both MCP servers (console, bridge) — inside a Docker fence.
**Why:** a compromised Tricorder credential means arbitrary natural-language
command of a `--dangerously-skip-permissions` session; the container makes
that blast radius "one repo and an allowlist", not "the whole office box".
Host SSH keys, the agentsecrets master key, gh tokens, and every other repo
simply do not exist inside.

The **dev stack stays on the host** (`make dev` as always). The container
bind-mounts the repo read-write, so the self-improvement loop is untouched:
the session edits a panel, host vite hot-reloads it onto the wall.

## Pieces

| File | Role |
|---|---|
| `docker/Dockerfile` | node:24 + pnpm + Claude Code CLI + git + iptables. No source, no secrets baked in. |
| `docker/entrypoint.sh` | root: raise firewall, chown the config volume → drop to `node` (uid 1000 = host user) → exec the session |
| `docker/init-firewall.sh` | default-deny egress (v4 allowlist via ipset, v6 rejected outright), self-verifying — the container refuses to start if example.com is reachable or api.anthropic.com is not |
| `docker/allowed-domains.txt` | the egress allowlist — bind-mounted read-only, **edit + relaunch, no rebuild** |
| `compose.yaml` | mounts, ports, env. Bridge `:3791` published to host `127.0.0.1` only (say.sh); `host.docker.internal` for the console API; named volume `tng-claude-config` holds session OAuth |

## Day-to-day

```bash
make computer          # the normal way to run the brain (builds image on first use)
make computer-image    # rebuild (new Claude Code release / Dockerfile change)
make computer-bare     # pre-container direct launch — fallback only, NO fence
```

- **First run ever**: the session asks for a Claude login (browser + paste
  code) — credentials persist in the `tng-claude-config` volume after that.
  The channels "local development" dialog appears every launch, same as before.
- **Only one bridge can own host :3791.** Stop a bare session before starting
  the containerized one (and vice versa), or compose fails with
  "ports are not available".
- The bridge takes ~8s to come up inside (pnpm/tsx cold start) — `make health`
  shows bridge DOWN until then.

## Widening / narrowing the fence

- **Let the Computer reach a new site** (WebFetch): add the hostname to
  `docker/allowed-domains.txt`, relaunch the session. Domains resolve to IPs
  at container start — a very long-lived session can go stale against CDN
  rotations; relaunch fixes that too. WebSearch is server-side
  (api.anthropic.com) and needs nothing.
- **Host services**: only `host.docker.internal:3789` (console API + working
  badge) is open. The TTS front and vite are host-side concerns the session
  never talks to directly.

## Troubleshooting

- **"ports are not available … 3791"** → a bare-session bridge (or orphan)
  holds the port: `fuser -k 3791/tcp` on the host, or stop the bare session.
- **Firewall FAIL at start** → DNS hiccup at resolve time; relaunch. If
  api.anthropic.com genuinely can't resolve, the box's network is the problem.
- **Login loop / corrupt session state** → `docker volume rm
  tng-computer_tng-claude-config` and log in fresh.
- **Windows binaries** (`ipconfig.exe` etc.) don't exist inside the container —
  that's the fence working, not a bug. Host-side diagnostics (`make lan`)
  run on the host.

## What the fence does NOT cover (accepted residual risk)

- The session's own OAuth token lives in the container volume: theft = quota
  burn until revoked at claude.ai.
- Anyone with a valid Tricorder login can still use the Computer's legitimate
  capabilities (speak on the wall, browse allowlisted sites, read/edit this
  repo). TNGC-15's door defenses — random passwords, guest TTL, one-tap
  rotation, cooldown — remain the first layer.
