#!/bin/bash
# Appliance brain entrypoint (TNGC-30). Root for exactly three jobs — egress
# firewall, volume ownership, persona merge — then waits for pairing if
# needed and drops to the unprivileged node user.
set -euo pipefail

# ---- egress fence (default-deny; baked allowlist + env additions) ------------
MERGED=/etc/tng/allowed-domains.txt
cp /etc/tng/allowed-domains-baked.txt "$MERGED"
if [ -n "${TNG_EXTRA_ALLOWED_DOMAINS:-}" ]; then
  echo "# extra domains from TNG_EXTRA_ALLOWED_DOMAINS" >> "$MERGED"
  echo "${TNG_EXTRA_ALLOWED_DOMAINS}" | tr ', ' '\n' | sed '/^$/d' >> "$MERGED"
fi
/usr/local/bin/init-firewall.sh

# ---- volumes ------------------------------------------------------------------
mkdir -p /home/node/.claude /var/lib/tng
chown -R node:node /home/node/.claude /var/lib/tng

# Pre-trust the baked workspace: it is OUR shipped code, and without this the
# session ignores claude/settings.json permissions until someone happens to
# answer the trust dialog interactively.
CJ=/home/node/.claude/.claude.json
if [ ! -f "$CJ" ] || ! jq -e '.projects["/opt/tng/claude"].hasTrustDialogAccepted == true' "$CJ" >/dev/null 2>&1; then
  tmp=$(mktemp)
  if [ -f "$CJ" ]; then
    jq '.projects["/opt/tng/claude"].hasTrustDialogAccepted = true' "$CJ" > "$tmp"
  else
    echo '{"projects":{"/opt/tng/claude":{"hasTrustDialogAccepted":true}}}' > "$tmp"
  fi
  mv "$tmp" "$CJ"
  chown node:node "$CJ"
fi

# ---- learned-knowledge merge (TNGC-30) ----------------------------------------
# claude/.claude is a named volume: runtime-authored skills/assets persist
# across image updates. Shipped skills WIN on update — re-copy the seed over
# the volume every boot (overwrites shipped files, never deletes extras).
if [ -d /opt/tng-persona-seed ]; then
  cp -a /opt/tng-persona-seed/. /opt/tng/claude/.claude/
  chown -R node:node /opt/tng/claude/.claude
fi

# ---- pairing gate + onboarding wizard (TNGC-30/31) -----------------------------
# Token precedence: env (dev/ops override) > pairing volume. Unpaired boxes
# WAIT here, visibly — in the terminal AND on the wall — until
# `tng pair <code>` writes the token.
SERVER="${TNG_SERVER_URL:-http://stack:3789}"
REG_HOST="$(echo "${TNG_TRICORDER_URL:-wss://tricorder.lalalimited.com/link}" | sed -E 's#^wss?://##; s#/link$##')"

show_pair_panel() {
  curl -sf -X POST "$SERVER/api/console/display" -H 'content-type: application/json' -d @- <<EOF >/dev/null 2>&1 || true
{"view":"steps","props":{"title":"PAIR YOUR COMPUTER","steps":[
  {"text":"Register your household","detail":"On your phone: https://$REG_HOST"},
  {"text":"Get a pairing code","detail":"Admin console -> Pair your Computer"},
  {"text":"Pair this box","detail":"docker compose exec computer tng pair <CODE>"}
],"caption":"The Computer starts by itself once paired."}}
EOF
}

if [ -z "${TNG_TRICORDER_TOKEN:-}" ] && [ -f /var/lib/tng/token ]; then
  TNG_TRICORDER_TOKEN="$(cat /var/lib/tng/token)"
  export TNG_TRICORDER_TOKEN
fi
if [ -z "${TNG_TRICORDER_TOKEN:-}" ]; then
  cat <<EOF
==========================================================
  TNG COMPUTER — NOT PAIRED
  1. Register your household:  https://$REG_HOST
  2. Admin console -> "Pair your Computer" -> get a code
  3. On this box:  docker compose exec computer tng pair <CODE>
  Waiting for pairing...
==========================================================
EOF
  # Keep re-asserting the wall panel while waiting: the stack may boot after
  # us, and the panel should survive a kiosk refresh.
  until [ -f /var/lib/tng/token ]; do
    show_pair_panel
    for _ in 1 2 3 4 5 6; do [ -f /var/lib/tng/token ] && break; sleep 5; done
  done
  TNG_TRICORDER_TOKEN="$(cat /var/lib/tng/token)"
  export TNG_TRICORDER_TOKEN
  echo "[tng] paired — starting the Computer"
fi

# First-contact moment (TNGC-31): once per pairing, greet by voice and land on
# the status board. Best-effort — a dark wall never blocks the session.
if [ ! -f /var/lib/tng/greeted ] && [ -f /var/lib/tng/token ]; then
  (
    for _ in $(seq 1 30); do
      if curl -sf "$SERVER/health" >/dev/null 2>&1; then
        curl -sf -X POST "$SERVER/api/console/display" -H 'content-type: application/json' \
          -d '{"view":"status"}' >/dev/null 2>&1 || true
        curl -sf -X POST "$SERVER/api/console/speak" -H 'content-type: application/json' \
          -d '{"text":"Pairing complete. This unit is now the ship'\''s computer. Say: Computer, what can you do."}' \
          >/dev/null 2>&1 || true
        touch /var/lib/tng/greeted
        break
      fi
      sleep 2
    done
  ) &
fi

exec setpriv --reuid=node --regid=node --init-groups "$@"
