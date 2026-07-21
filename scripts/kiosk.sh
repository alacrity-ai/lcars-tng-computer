#!/usr/bin/env bash
# Launch the LCARS display fullscreen in Chrome kiosk mode.
# --autoplay-policy removes the "engage tap" requirement for TTS/earcon audio.
set -euo pipefail

URL="${TNG_WEB_URL:-http://127.0.0.1:5173}"
CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"

# WSLg's virtualized GPU can ghost stale rasters (text briefly drawn twice,
# worst during zoom or rapid repaints). If that shows up, launch with
#   TNG_KIOSK_GPU=off pnpm kiosk
# to fall back to software rasterization.
EXTRA_FLAGS=()
if [ "${TNG_KIOSK_GPU:-on}" = "off" ]; then
  EXTRA_FLAGS+=(--disable-gpu)
fi

exec "$CHROME" \
  --kiosk "$URL" \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-infobars \
  "${EXTRA_FLAGS[@]}" \
  --user-data-dir="${HOME}/.tng-computer-kiosk"
