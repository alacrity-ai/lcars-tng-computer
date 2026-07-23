# tng-computer appliance image (TNGC-30): the fenced brain — Claude Code
# (VERSION-PINNED: channels delivery is research-preview; a silent CLI upgrade
# must never brick a household) + bridge + console-mcp + the persona, code
# COPIED in. The TNGC-19 egress fence is the DEFAULT: default-deny, baked
# allowlist + TNG_EXTRA_ALLOWED_DOMAINS env override, NET_ADMIN entrypoint
# dropping to non-root.
#
# Build from the REPO ROOT:  docker build -f docker/appliance-computer.Dockerfile .

FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      iptables ipset iproute2 dnsutils curl git jq procps psmisc \
    && rm -rf /var/lib/apt/lists/*

# The pin. Bump deliberately, test channels delivery, then ship a new tag.
RUN npm install -g pnpm@10 @anthropic-ai/claude-code@2.1.218

WORKDIR /opt/tng
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages ./packages
COPY claude ./claude
RUN pnpm install --frozen-lockfile --filter "@tng/bridge..." --filter "@tng/console-mcp..." \
    && chown -R node:node /opt/tng

# Pristine persona seed: the learned-knowledge volume mounts over
# claude/.claude; on every boot the entrypoint re-asserts shipped skills from
# this copy (shipped-skill-wins) while leaving runtime-authored ones alone.
RUN cp -a /opt/tng/claude/.claude /opt/tng-persona-seed

COPY docker/allowed-domains.txt /etc/tng/allowed-domains-baked.txt
COPY docker/init-firewall.sh docker/appliance-computer-entrypoint.sh /usr/local/bin/
COPY docker/tng-cli.mjs /usr/local/bin/tng
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/appliance-computer-entrypoint.sh /usr/local/bin/tng \
    && mkdir -p /var/lib/tng && chown node:node /var/lib/tng

ENV HOME=/home/node \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    TNG_MODE=appliance

WORKDIR /opt/tng/claude

ENTRYPOINT ["/usr/local/bin/appliance-computer-entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:bridge"]
