# The Computer session container (TNGC-19): Claude Code + the tools the brain
# needs to work on its own repo. The repo itself is bind-mounted at runtime —
# this image carries no source, no credentials, no host secrets.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      iptables ipset dnsutils curl git jq procps psmisc \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10 @anthropic-ai/claude-code

COPY entrypoint.sh init-firewall.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/init-firewall.sh

# CLAUDE_CONFIG_DIR keeps ALL session state (OAuth included) in one directory,
# which compose maps to a named volume — isolated from the host's ~/.claude.
ENV HOME=/home/node \
    CLAUDE_CONFIG_DIR=/home/node/.claude

WORKDIR /home/node/tng-computer/claude

# Entrypoint runs as root just long enough to raise the firewall, then drops
# to the unprivileged node user (uid 1000 = the host user, so bind-mounted
# repo writes keep their ownership).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude", "--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:bridge"]
