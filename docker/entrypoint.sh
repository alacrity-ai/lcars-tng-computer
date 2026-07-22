#!/bin/bash
# Root for exactly two jobs — raise the egress firewall, fix volume ownership —
# then drop privileges to the node user and exec the session.
set -euo pipefail

/usr/local/bin/init-firewall.sh

mkdir -p /home/node/.claude
chown -R node:node /home/node/.claude

exec setpriv --reuid=node --regid=node --init-groups "$@"
