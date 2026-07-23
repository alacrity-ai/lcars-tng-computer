# TNG Computer — Appliance Install (TNGC-30)

The whole house side — LCARS wall, voice, speech, and the fenced Claude brain —
from one downloaded compose file pulling prebuilt images. No git clone, no
node, no package managers.

## What you need

- A PC that stays on: **~4 GB RAM, any 4-core x86 or ARM box. No GPU** —
  speech is CPU-only (Piper).
- **Docker** (Docker Desktop on Windows/macOS, `docker` + compose plugin on Linux).
- A **Claude subscription** (Pro/Max) — the brain runs on YOUR hardware against
  YOUR account; nothing is hosted for you.
- A TV or wall display with a browser, on the same LAN.

## Install (three human actions)

```bash
mkdir tng-computer && cd tng-computer
curl -O https://raw.githubusercontent.com/alacrity-ai/lcars-tng-computer/main/appliance/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/alacrity-ai/lcars-tng-computer/main/appliance/.env.example
docker compose up -d
```

1. **Pair.** Register your household at https://myhome.computer
   (phone or laptop). In the admin console tap **Pair your Computer** to get a
   code, then on the box:

   ```bash
   docker compose exec computer tng pair ABCD-EFGH
   ```

2. **Claude login** (first run only):

   ```bash
   docker compose attach computer     # follow the login URL, then Ctrl-P Ctrl-Q to detach
   ```

   The login persists in a volume — you never do this again.

3. **TV.** Open `http://<box-ip>:5173` in the TV's browser, press F11, tap
   ENGAGE. Add the Tricorder site to your phone's home screen for
   push-to-talk.

Sanity check anytime:

```bash
docker compose exec computer tng doctor
```

## The LAN step (the #1 setup trap)

The TV must reach port **5173** on the box.

- **Windows + Docker Desktop (WSL2):** Docker Desktop publishes to Windows
  automatically, but Windows Firewall may still block LAN peers. Allow it once
  (admin PowerShell):
  `New-NetFirewallRule -DisplayName "TNG wall" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow`
- **Linux:** usually nothing to do; with ufw: `sudo ufw allow 5173/tcp`.
- **macOS:** allow Docker in System Settings → Network/Firewall if prompted.

Find the box's IP: `ipconfig` (Windows) / `ip a` (Linux) / `ifconfig` (macOS).

## Updating

```bash
docker compose pull && docker compose up -d
```

Your Claude login, pairing, settings, and everything the Computer has learned
(household skills) live in named volumes and survive updates. Shipped skills
win on conflict; your own additions are never deleted.

## Notes

- Everything restarts unattended (`restart: unless-stopped`) — a power cut or
  reboot brings the whole system back, session included.
- The brain container runs behind a default-deny egress firewall. To let it
  reach an extra service (e.g. a home-automation bridge), add the hostname to
  `TNG_EXTRA_ALLOWED_DOMAINS` in `.env` and `docker compose up -d computer`.
- Music that blocks embedding can play as extracted audio — off by default;
  set `TNG_AUDIO_FALLBACK=1` in `.env` to opt in.
- Dev installs (bind-mounted repo, `make dev`) are a separate flow and stay
  exactly as documented in the main README. `TNG_MODE` tells the Computer
  which world it lives in; appliance images set it for you.

## Plugins

Optional integrations (lighting, and whatever comes next) install as
folders — never shipped enabled. To add one: drop its folder into the
`tng-plugins` volume, follow its README to add its compose file to
`COMPOSE_FILE` in `.env`, set `TNG_PLUGINS=<id>`, then
`docker compose up -d`. `tng doctor` shows every enabled plugin's health.
Disable by removing it from `TNG_PLUGINS` — no other trace remains.
