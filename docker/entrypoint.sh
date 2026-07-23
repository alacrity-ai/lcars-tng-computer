#!/bin/bash
# Root for exactly two jobs — raise the egress firewall, fix volume ownership —
# then drop privileges to the node user and exec the session.
set -euo pipefail

# Plugin loader (TNGC-33) — must run BEFORE the firewall (it writes the
# fence's plugin files). Dev paths: the repo is bind-mounted.
/usr/local/bin/plugin-merge.sh /home/node/tng-computer/plugins /home/node/tng-computer/claude

/usr/local/bin/init-firewall.sh

mkdir -p /home/node/.claude
chown -R node:node /home/node/.claude

exec setpriv --reuid=node --regid=node --init-groups "$@"
