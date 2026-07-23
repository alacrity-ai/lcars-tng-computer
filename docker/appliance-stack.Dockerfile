# tng-stack appliance image (TNGC-30): server + BUILT wall (served statically
# by the server, one port) + Piper TTS with the default voice baked in.
# Code is COPIED — this is the immutable product artifact; the dev flow
# (compose.yaml bind mounts) is unchanged and separate.
#
# Build from the REPO ROOT:  docker build -f docker/appliance-stack.Dockerfile .

FROM node:24-bookworm AS build
RUN npm install -g pnpm@10
WORKDIR /opt/tng
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
# Only the projects this image runs (+ their workspace deps). The tricorder
# worker (wrangler et al) never ships in the appliance.
RUN pnpm install --frozen-lockfile --filter "@tng/web..." --filter "@tng/server..."
RUN pnpm --filter @tng/web build

FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git jq procps psmisc python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
# yt-dlp for the (opt-in, TNG_AUDIO_FALLBACK=1) audio-extraction fallback
RUN curl -LsSf -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    && chmod 755 /usr/local/bin/yt-dlp

COPY --from=build --chown=node:node /opt/tng /opt/tng
RUN mkdir -p /opt/venvs && chown node:node /opt/venvs

ENV HOME=/home/node \
    UV_PROJECT_ENVIRONMENT=/opt/venvs/tts \
    UV_CACHE_DIR=/opt/venvs/uv-cache

USER node
WORKDIR /opt/tng
# TTS env + default voice baked at build time — first boot speaks immediately,
# no downloads. Extra language voices land in the tng-voices volume at runtime.
RUN uv sync --project apps/tts \
    && uv run --project apps/tts python -m piper.download_voices en_US-lessac-medium \
         --data-dir voice/piper

ENV TNG_SERVER_HOST=0.0.0.0 \
    TNG_TTS_HOST=0.0.0.0 \
    TNG_WALL_DIST=/opt/tng/apps/web/dist \
    TNG_MODE=appliance

EXPOSE 3789 3790
CMD ["node", "scripts/appliance-stack.mjs"]
