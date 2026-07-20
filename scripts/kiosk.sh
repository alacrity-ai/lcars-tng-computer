#!/usr/bin/env bash
# Launch the LCARS display fullscreen in Chrome kiosk mode.
# --autoplay-policy removes the "engage tap" requirement for TTS/earcon audio.
set -euo pipefail

URL="${TNG_WEB_URL:-http://127.0.0.1:5173}"
CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"

exec "$CHROME" \
  --kiosk "$URL" \
  --autoplay-policy=no-user-gesture-required \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --user-data-dir="${HOME}/.tng-computer-kiosk"
