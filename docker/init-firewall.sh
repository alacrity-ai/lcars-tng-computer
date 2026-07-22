#!/bin/bash
# Default-deny egress for the Computer container (TNGC-19), self-verifying.
#
# Allowed out: loopback, established flows, DNS, the host's console API
# (:3789 via host.docker.internal), and the IPs of the domains listed in
# allowed-domains.txt (resolved once, at container start — relaunch the
# session to pick up DNS changes or allowlist edits).
# Allowed in: loopback, established, and the bridge port (:3791) that Docker
# publishes back to the host's 127.0.0.1 for say.sh.
set -euo pipefail

DOMAINS_FILE="${TNG_ALLOWED_DOMAINS_FILE:-/etc/tng/allowed-domains.txt}"
HOST_API_PORT="${TNG_HOST_API_PORT:-3789}"

iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -F INPUT
iptables -F OUTPUT
ipset destroy tng-allowed 2>/dev/null || true
ipset create tng-allowed hash:ip

resolved=0
while read -r domain; do
  [[ -z "$domain" || "$domain" == \#* ]] && continue
  ips=$(dig +short A "$domain" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
  if [[ -z "$ips" ]]; then
    echo "[firewall] WARN: $domain did not resolve — it will be unreachable" >&2
    continue
  fi
  for ip in $ips; do ipset add tng-allowed "$ip" -exist; resolved=$((resolved + 1)); done
done < "$DOMAINS_FILE"

HOST_GW=$(getent ahostsv4 host.docker.internal | awk '{print $1; exit}' || true)

iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 3791 -j ACCEPT
iptables -P INPUT DROP

iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
if [[ -n "$HOST_GW" ]]; then
  iptables -A OUTPUT -d "$HOST_GW" -p tcp --dport "$HOST_API_PORT" -j ACCEPT
else
  echo "[firewall] WARN: host.docker.internal unresolved — console API will be unreachable" >&2
fi
iptables -A OUTPUT -m set --match-set tng-allowed dst -j ACCEPT
iptables -P OUTPUT DROP

# IPv6: no allowlist, no exceptions — REJECT (not DROP) so dual-stack clients
# fall back to IPv4 instantly instead of hanging on connect timeouts.
if ip6tables -L >/dev/null 2>&1; then
  ip6tables -P INPUT ACCEPT
  ip6tables -P OUTPUT ACCEPT
  ip6tables -F INPUT
  ip6tables -F OUTPUT
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A INPUT -j REJECT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -j REJECT
fi

# Self-check: default-deny must hold, the allowlist must actually work.
if curl -s -m 4 https://example.com >/dev/null 2>&1; then
  echo "[firewall] FAIL: example.com reachable — default-deny is NOT in effect" >&2
  exit 1
fi
if ! curl -s -o /dev/null -m 8 https://api.anthropic.com 2>/dev/null; then
  echo "[firewall] FAIL: api.anthropic.com unreachable — allowlist broken" >&2
  exit 1
fi
echo "[firewall] default-deny active: ${resolved} allowlisted IPs, host API via ${HOST_GW:-<unresolved>}:${HOST_API_PORT}"
