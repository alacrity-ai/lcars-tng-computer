# TNG Computer — one-command operations
# `make` or `make help` lists targets.

export PATH := $(HOME)/.local/bin:$(PATH)

PIPER_VOICE ?= en_US-lessac-medium

# Plugins (TNGC-33): TNG_PLUGINS=lighting make dev/computer chains each
# enabled plugin's compose file so its sidecars ride the same lifecycle.
comma := ,
PLUGIN_IDS := $(strip $(subst $(comma), ,$(TNG_PLUGINS)))
PLUGIN_COMPOSE := $(foreach p,$(PLUGIN_IDS),$(if $(wildcard plugins/$(p)/compose.yaml),-f plugins/$(p)/compose.yaml,$(warning plugin '$(p)' has no plugins/$(p)/compose.yaml)))
COMPOSE := docker compose -f compose.yaml $(PLUGIN_COMPOSE)

.PHONY: help setup dev down kiosk lan computer health demo earcons clean

help:
	@echo "TNG Computer"
	@echo "  make setup     - install everything (pnpm, tts deps, piper voice model)"
	@echo "  make dev       - run the stack in Docker: server :3789, web :5173, tts :3790"
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

# The dev stack, containerized (TNGC-20): server + wall + TTS run inside the
# stack container — repo code executes in there, never on the host. Foreground
# with streaming logs, Ctrl+C stops it. First run builds the image and uv
# downloads the TTS deps into a volume (a minute or two).
dev:
	$(COMPOSE) up stack

# Rebuild the stack image (Dockerfile change / new node base).
stack-image:
	$(COMPOSE) build stack

# The pre-TNGC-20 host launch — NO container. Fallback only.
dev-bare:
	pnpm dev

# Containers first, then any bare-mode leftovers on the ports.
down:
	@-$(COMPOSE) down --remove-orphans 2>/dev/null || true
	@-pkill -f "[s]cripts/dev.mjs" 2>/dev/null && echo "orchestrator: stopped" || echo "orchestrator (bare): not running"
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

# The Computer session, containerized (TNGC-19): the whole process tree —
# session, file tools, hooks, console+bridge MCP — lives inside the Docker
# fence (default-deny egress, host secrets absent, repo bind-mounted rw so
# the self-improvement loop is untouched). Tricorder creds injected from
# agentsecrets on the HOST; only the token crosses into the container env.
# --service-ports is what publishes the bridge to host 127.0.0.1:3791.
# The dev-channels flag is required: without it the bridge's channel
# notifications are dropped SILENTLY (research-preview behavior). Expect the
# one-time "local development" confirmation dialog at launch (and a browser
# login on the very first run — credentials persist in a named volume).
computer:
	TNG_TRICORDER_TOKEN="$${TNG_TRICORDER_TOKEN:-$$(agentsecrets get tricorder_service_token 2>/dev/null)}" \
	$(COMPOSE) run --rm --service-ports computer

# Rebuild the session image (new Claude Code release, Dockerfile edits).
# Allowlist edits (docker/allowed-domains.txt) do NOT need a rebuild — just
# relaunch the session.
computer-image:
	$(COMPOSE) build computer

# The pre-TNGC-19 direct launch — NO container, NO fence. Fallback only
# (Docker broken, or debugging the container itself).
computer-bare:
	cd claude && \
	TNG_TRICORDER_URL="$${TNG_TRICORDER_URL:-wss://myhome.computer/link}" \
	TNG_TRICORDER_TOKEN="$${TNG_TRICORDER_TOKEN:-$$(agentsecrets get tricorder_service_token 2>/dev/null)}" \
	claude --dangerously-skip-permissions --dangerously-load-development-channels server:bridge

health:
	@printf "server:  " && (curl -sf --max-time 2 http://127.0.0.1:3789/health || echo "DOWN") && echo
	@printf "tts:     " && (curl -sf --max-time 2 http://127.0.0.1:3790/health || echo "DOWN (speak degrades to captions)") && echo
	@printf "bridge:  " && (curl -sf --max-time 2 http://127.0.0.1:3791/health || echo "DOWN (no event loop — is the Computer session running?)") && echo
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
