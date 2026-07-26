# claudeops — remote control of the host's claude-ops session (TNGC-54)

The TNG Computer pattern (tmux + channels + hooks + bridge), applied to the
claude-ops session in `~/lets-get-rich/claude_ops`. From the tricorder's
**Claude Ops** plugin screen an admin can send commands into the session,
watch idle/working/compacting truth, read the result of each turn, set
model/effort, and trigger memory consolidation.

## Topology

```
tricorder PWA ──> Worker (admin-only, whitelist, control_log)
                    └─> TenantHub `control` frame
                          └─> TNG bridge (computer container)
                                └─> ops-agent  http://host.docker.internal:7102
                                      ├─ channel event ─> claude-ops session (tmux)
                                      ├─ tmux send-keys: /compact /model /effort
                                      └─ /state: status, context, last result
```

Unlike lighting, there are **no sidecars**: the agent (`agent.mjs`, zero
dependencies) runs on the HOST, spawned as the `opsbridge` MCP server by the
session that `make claude-ops` (in the claude_ops repo) opens. This plugin
only carries the bridge's side: `compose.yaml` sets `TNG_CLAUDEOPS_URL` on
the computer container (which is also the bridge's enable flag) and
`plugin.json` declares the pinpoint fence hole to `host.docker.internal:7102`.

## Activation

- House side: `TNG_PLUGINS=lighting,claudeops make computer`
- Ops side (claude_ops repo): `make claude-ops` (attach/detach: it's tmux,
  `C-b d`), `make claude-ops-down`, `make claude-ops-health`
- Tenant switch: admin console → Enable plugins → Claude Ops (pre-enabled
  for `home`)

## Truth model

- **working/idle** come from the session's own hooks (UserPromptSubmit /
  Stop in claude_ops `.claude/settings.json`, gated on `TNG_OPS=1` so plain
  interactive sessions in that repo never cross-talk).
- The **result** is the transcript's last assistant text, captured at Stop
  (with short retries — the hook can beat the transcript flush).
- The Stop hook forwards `transcript_path` (the TNG bridge's doesn't need
  to): channel-delivered turns never fire UserPromptSubmit, so turn-end is
  the only reliable re-bind point.
- Compact rides the TNGC-32 rails: PreCompact hook is the ack, pane-watch
  catches "not enough messages" aborts, 10-min failsafe.

## Security

Remote instruction of a `--dangerously-skip-permissions` session on the
host: **admin-only at the Worker on both state and control** (member/guest
403, row hidden in the PWA), args whitelist-rebuilt at Worker, bridge, AND
agent; the only keystrokes tmux can ever receive are the three validated
slash commands. The agent binds loopback; the only remote path in is the
authenticated cloud control plane. Every accepted op lands in `control_log`.
