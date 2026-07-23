#!/usr/bin/env bash
# PreToolUse gate (TNGC-22): when someone cancelled the active command from a
# tricorder, the bridge arms /abort-check and this hook denies every further
# NON-console tool call until the turn ends (Stop clears the flag). Console
# tools stay allowed so the Computer can wind down audibly. Fail-open on any
# error — a broken hook must never block normal operation.
set -u

input=$(cat 2>/dev/null || true)

resp=$(curl -s -m 0.5 "http://127.0.0.1:${TNG_BRIDGE_PORT:-3791}/abort-check" 2>/dev/null) || exit 0
case "$resp" in *'"abort":true'*) ;; *) exit 0 ;; esac

tool=$(printf %s "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
case "$tool" in mcp__console__*) exit 0 ;; esac

by=$(printf %s "$resp" | jq -r '.by // "a tricorder user"' 2>/dev/null || echo "a tricorder user")
cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"CANCELLED: $by cancelled this command from the Tricorder. Abandon the current task immediately — speak one short acknowledgment ('Belayed.') and end the turn. Do not retry tools or continue working."}}
EOF
exit 0
