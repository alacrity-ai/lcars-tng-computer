#!/bin/bash
# Plugin loader (TNGC-33) — boot-time merging, the whole runtime of the
# plugin system. Runs as root in BOTH computer entrypoints (dev + appliance)
# BEFORE init-firewall.sh (it writes the fence's plugin files) and before the
# privilege drop.
#
#   plugin-merge.sh <PLUGINS_DIR> <CLAUDE_DIR>
#
# For each id in TNG_PLUGINS (comma/space separated), from
# <PLUGINS_DIR>/<id>/plugin.json:
#   - mcp entry        -> merged into <CLAUDE_DIR>/.mcp.json (generated from
#                         .mcp.base.json every boot; never hand-edited)
#   - skills/*         -> synced to <CLAUDE_DIR>/.claude/skills/plugin-<id>-<name>
#                         (namespaced: disabled plugins are cleanly removed,
#                         household-authored skills are never touched)
#   - allowedDomains   -> /etc/tng/allowed-domains-plugins.txt (external egress)
#   - services[].internalEndpoints -> /etc/tng/internal-endpoints.txt
#                         (pinpoint host:port holes, resolved by the firewall)
#
# A broken plugin is SKIPPED loudly — it must never brick boot.
set -uo pipefail

PLUGINS_DIR="${1:?usage: plugin-merge.sh <plugins-dir> <claude-dir>}"
CLAUDE_DIR="${2:?usage: plugin-merge.sh <plugins-dir> <claude-dir>}"

MCP_BASE="$CLAUDE_DIR/.mcp.base.json"
MCP_OUT="$CLAUDE_DIR/.mcp.json"
SKILLS_DIR="$CLAUDE_DIR/.claude/skills"
FENCE_PLUGINS="/etc/tng/allowed-domains-plugins.txt"
ENDPOINTS_OUT="/etc/tng/internal-endpoints.txt"

mkdir -p /etc/tng "$SKILLS_DIR"

# Regenerate from scratch every boot: enabled set = exactly TNG_PLUGINS.
if [ -f "$MCP_BASE" ]; then cp "$MCP_BASE" "$MCP_OUT"; else echo '{"mcpServers":{}}' > "$MCP_OUT"; fi
: > "$FENCE_PLUGINS"
: > "$ENDPOINTS_OUT"
find "$SKILLS_DIR" -maxdepth 1 -type d -name 'plugin-*' -exec rm -rf {} + 2>/dev/null || true

IFS=', ' read -r -a IDS <<< "${TNG_PLUGINS:-}"
loaded=0
for id in "${IDS[@]:-}"; do
  [ -z "$id" ] && continue
  case "$id" in *[!a-z0-9_-]*) echo "[plugins] '$id': invalid id — SKIPPED"; continue ;; esac
  dir="$PLUGINS_DIR/$id"
  mf="$dir/plugin.json"
  if [ ! -f "$mf" ]; then
    echo "[plugins] $id: no plugin.json under $dir — SKIPPED"
    continue
  fi
  if ! jq -e . "$mf" >/dev/null 2>&1; then
    echo "[plugins] $id: plugin.json is not valid JSON — SKIPPED"
    continue
  fi
  ver=$(jq -r '.version // "?"' "$mf")

  # MCP server
  mcp="—"
  if jq -e '.mcp.name and .mcp.command' "$mf" >/dev/null 2>&1; then
    tmp=$(mktemp)
    if jq --slurpfile p "$mf" \
        '.mcpServers[$p[0].mcp.name] = {command: $p[0].mcp.command, args: ($p[0].mcp.args // [])}' \
        "$MCP_OUT" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$MCP_OUT"
      mcp=$(jq -r '.mcp.name' "$mf")
    else
      rm -f "$tmp"
      echo "[plugins] $id: mcp entry malformed — mcp skipped"
    fi
  fi

  # Skills (namespaced)
  skills=0
  if [ -d "$dir/skills" ]; then
    for s in "$dir"/skills/*/; do
      [ -d "$s" ] || continue
      base=$(basename "$s")
      cp -a "$s" "$SKILLS_DIR/plugin-$id-$base"
      skills=$((skills + 1))
    done
  fi

  # Fence: external domains + pinpoint internal endpoints
  domains=$(jq -r '.allowedDomains[]? // empty' "$mf" 2>/dev/null | sed '/^$/d')
  d=0
  if [ -n "$domains" ]; then
    { echo "# plugin: $id"; echo "$domains"; } >> "$FENCE_PLUGINS"
    d=$(echo "$domains" | wc -l)
  fi
  eps=$(jq -r '.services[]?.internalEndpoints[]? | "\(.host):\(.port)"' "$mf" 2>/dev/null | sed '/^$/d')
  e=0
  if [ -n "$eps" ]; then
    echo "$eps" >> "$ENDPOINTS_OUT"
    e=$(echo "$eps" | wc -l)
  fi

  echo "[plugins] $id v$ver — mcp: $mcp, skills: $skills, fence: +$d domain(s), +$e internal endpoint(s)"
  loaded=$((loaded + 1))
done

chown node:node "$MCP_OUT" 2>/dev/null || true
chown -R node:node "$SKILLS_DIR" 2>/dev/null || true
if [ "$loaded" -eq 0 ]; then
  if [ -z "${TNG_PLUGINS:-}" ]; then echo "[plugins] none enabled"; else echo "[plugins] 0 of the requested plugin(s) loaded"; fi
fi
exit 0
