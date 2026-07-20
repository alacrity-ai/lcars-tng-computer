# TNG Computer — one-command operations
# `make` or `make help` lists targets.

export PATH := $(HOME)/.local/bin:$(PATH)

PIPER_VOICE ?= en_US-lessac-medium

.PHONY: help setup dev kiosk computer health demo earcons clean

help:
	@echo "TNG Computer"
	@echo "  make setup     - install everything (pnpm, tts deps, piper voice model)"
	@echo "  make dev       - run the stack: server :3789, web :5173, tts :3790 (foreground)"
	@echo "  make kiosk     - open the LCARS display fullscreen (run 'make dev' first)"
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

kiosk:
	bash scripts/kiosk.sh

computer:
	cd claude && claude

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
