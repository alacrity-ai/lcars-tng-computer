# TNG Computer — one-command operations
# `make` or `make help` lists targets.

export PATH := $(HOME)/.local/bin:$(PATH)

PIPER_VOICE ?= en_US-lessac-medium

.PHONY: help setup dev down kiosk lan computer health demo earcons clean

help:
	@echo "TNG Computer"
	@echo "  make setup     - install everything (pnpm, tts deps, piper voice model)"
	@echo "  make dev       - run the stack: server :3789, web :5173, tts :3790 (foreground)"
	@echo "  make down      - stop everything (server, web, tts, dev orchestrator)"
	@echo "  make kiosk     - open the LCARS display fullscreen (run 'make dev' first)"
	@echo "  make lan       - status/instructions for the TV-room kiosk (LAN exposure)"
	@echo "  make computer  - launch the Claude session that IS the Computer"
	@echo "  make health    - check server / tts / display status"
	@echo "  make demo      - drive the display without Claude (panels, speech, chimes)"
	@echo "  make earcons   - regenerate the placeholder earcon WAVs"

setup:
	pnpm install
	uv sync --project apps/tts
	@test -f voice/piper/$(PIPER_VOICE).onnx || \
		uv run --project apps/tts python -m piper.download_voices $(PIPER_VOICE) --data-dir voice/piper
	@echo "✔ setup complete — next: make dev (one terminal), make kiosk (another)"

dev:
	pnpm dev

# Kill the orchestrator first so it can't respawn/react, then anything on the ports.
down:
	@-pkill -f "scripts/dev.mjs" 2>/dev/null && echo "orchestrator: stopped" || echo "orchestrator: not running"
	@-fuser -k -TERM 3789/tcp 2>/dev/null && echo "server  (:3789): stopped" || echo "server  (:3789): not running"
	@-fuser -k -TERM 5173/tcp 2>/dev/null && echo "web     (:5173): stopped" || echo "web     (:5173): not running"
	@-fuser -k -TERM 3790/tcp 2>/dev/null && echo "tts     (:3790): stopped" || echo "tts     (:3790): not running"
	@echo "✔ stack down"

kiosk:
	bash scripts/kiosk.sh

# TV-room kiosk: full SOP in docs/sops/tv-room-kiosk.md
lan:
	@echo "TV kiosk: Chrome on the TV PC -> http://<office-windows-IP>:5173, then F11 + tap ENGAGE"
	@echo "One-time Windows step (admin PowerShell): scripts/expose-lan.ps1"
	@printf "vite LAN bind:  " && { ss -tln 2>/dev/null | grep -E '(\*|0\.0\.0\.0):5173 ' >/dev/null \
		&& echo "0.0.0.0:5173 OK" \
		|| { ss -tln 2>/dev/null | grep -q ':5173 ' \
			&& echo "loopback only — restart 'make dev' to pick up the vite host config" \
			|| echo "not running — run 'make dev' first"; }; }
	@echo "windows IPv4 candidates (use one of these on the TV):" && \
		{ ipconfig.exe 2>/dev/null | tr -d '\r' | grep -i 'IPv4' | sed 's/^ */  /' || echo "  (couldn't query — run ipconfig on Windows)"; }

computer:
	cd claude && claude --dangerously-skip-permissions

health:
	@printf "server:  " && (curl -sf --max-time 2 http://127.0.0.1:3789/health || echo "DOWN") && echo
	@printf "tts:     " && (curl -sf --max-time 2 http://127.0.0.1:3790/health || echo "DOWN (speak degrades to captions)") && echo
	@printf "display: " && (curl -sf --max-time 2 http://127.0.0.1:3789/api/console/screen || echo "unknown") && echo

# A guided tour of everything working, no Claude session needed.
demo:
	@echo "— status board —" && curl -sf -X POST http://127.0.0.1:3789/api/console/display \
		-H 'content-type: application/json' -d '{"view":"status"}' >/dev/null && sleep 3
	@echo "— chime + spoken line —" && curl -sf -X POST http://127.0.0.1:3789/api/console/chime \
		-H 'content-type: application/json' -d '{"name":"acknowledge"}' >/dev/null
	@curl -sf -X POST http://127.0.0.1:3789/api/console/speak \
		-H 'content-type: application/json' \
		-d '{"text":"All systems functioning within normal parameters."}' >/dev/null
	@echo "— text panel —" && curl -sf -X POST http://127.0.0.1:3789/api/console/display \
		-H 'content-type: application/json' \
		-d '{"view":"text","props":{"title":"Message","body":"Hello, Number One."}}' >/dev/null && sleep 3
	@echo "— red alert —" && curl -sf -X POST http://127.0.0.1:3789/api/console/chime \
		-H 'content-type: application/json' -d '{"name":"red-alert"}' >/dev/null
	@curl -sf -X POST http://127.0.0.1:3789/api/console/display \
		-H 'content-type: application/json' \
		-d '{"view":"alert","props":{"level":"red","message":"Intruder alert — Deck 8"}}' >/dev/null && sleep 4
	@echo "— back to status —" && curl -sf -X POST http://127.0.0.1:3789/api/console/display \
		-H 'content-type: application/json' -d '{"view":"status"}' >/dev/null
	@echo "✔ demo complete"

earcons:
	node scripts/gen-earcons.mjs

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/tts/.venv
