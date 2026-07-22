#!/usr/bin/env bash
# Event-loop safety net (TNGC-13): if the Computer ends a turn without a
# pending bridge await_message call, block the stop once and tell it to
# re-arm. The loop's primary driver is the persona rule in CLAUDE.md — this
# hook only catches the drops.
set -uo pipefail

input=$(cat)

dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Manual escape hatch for heavy dev sessions: touch claude/.no-loop
[ -f "$dir/.no-loop" ] && exit 0

# Never block twice in a row (prevents an infinite stop loop if the model
# can't comply for some reason).
case "$input" in
  *'"stop_hook_active":true'*) exit 0 ;;
esac

# Only enforce when the bridge is actually up (session without MCP, orphaned
# port, etc. → allow the stop).
curl -sf -m 1 "http://127.0.0.1:${TNG_BRIDGE_PORT:-3791}/health" >/dev/null 2>&1 || exit 0

printf '%s' '{"decision":"block","reason":"Event loop not armed. Call the bridge await_message tool now (timeout_seconds: 600); service whatever it returns and re-arm. If a developer needs the terminal instead, they can `touch .no-loop` in the claude/ directory to pause this enforcement."}'
