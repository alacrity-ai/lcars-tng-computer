# The dev-stack container (TNGC-20): server (:3789) + vite wall (:5173) +
# Piper TTS (:3790), all driven by the existing scripts/dev.mjs. This is
# where repo code EXECUTES — the point of the fence: a malicious
# "self-improvement" runs in here, not on the host. No secrets inside;
# egress is unrestricted (nothing to steal, repo is public).
#
# Piper is CPU-only onnxruntime — no GPU plumbing needed. The Python env is
# built by uv into /opt/venvs (a named volume), never into the repo's .venv,
# so the host's own venv and python version are irrelevant.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git jq procps psmisc python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10

# uv (standalone binary) builds/runs the TTS sidecar's env
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# yt-dlp for the YouTube subsystem (standalone zipapp, runs on the image's
# python3). The server can also self-provision a copy at runtime
# (apps/server/.cache) — this bake makes that a rarely-needed fallback.
RUN curl -LsSf -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp

# venv + cache volume mount point, owned by the runtime user
RUN mkdir -p /opt/venvs && chown node:node /opt/venvs

ENV HOME=/home/node \
    UV_PROJECT_ENVIRONMENT=/opt/venvs/tts \
    UV_CACHE_DIR=/opt/venvs/uv-cache \
    TNG_SERVER_HOST=0.0.0.0 \
    TNG_TTS_HOST=0.0.0.0

USER node
WORKDIR /home/node/tng-computer

CMD ["node", "scripts/dev.mjs"]
