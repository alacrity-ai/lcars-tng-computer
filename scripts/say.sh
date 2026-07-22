#!/usr/bin/env bash
# Office push-to-talk: enqueue a transcript for the Computer's event loop.
# Usage: scripts/say.sh "play some jazz" [user] [device]
set -euo pipefail

TEXT="${1:?usage: say.sh \"text\" [user] [device]}"
U="${2:-leif}"
D="${3:-office}"

BODY=$(node -e 'const [t,u,d]=process.argv.slice(1);process.stdout.write(JSON.stringify({transcript:t,user:u,device:d}))' "$TEXT" "$U" "$D")

curl -sf -X POST "http://127.0.0.1:${TNG_BRIDGE_PORT:-3791}/message" \
  -H 'content-type: application/json' -d "$BODY" \
  || { echo "bridge unreachable on :${TNG_BRIDGE_PORT:-3791} — is the Computer session running?" >&2; exit 1; }
echo
