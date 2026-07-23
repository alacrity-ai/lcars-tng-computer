# SOPs — tng-computer

Standard Operating Procedures for **building and maintaining** the Computer —
read while editing the repo.

> **Looking for how the Computer should *behave*?** That's runtime knowledge and
> it lives in `claude/.claude/skills/` — one skill per capability (directions,
> weather, charts, maps, subjects, quotes, media, articles). Those load
> on demand during a live interaction. This folder is for development work.

## When you need to…

| Situation | SOP | TL;DR |
|-----------|-----|-------|
| **Add a new panel to the wall** | [adding-new-panels.md](adding-new-panels.md) | Define props in shared → build component → register it. Type system enforces compile-time safety. |
| **Add a widget (overlay badge: timers, alarms…)** | [adding-widgets.md](adding-widgets.md) | Widgets are panel-independent overlay state. Server owns lifecycle, full-state sync via hub, wall renders dumb. |
| **Implement karaoke mode (reading with highlighting)** | [karaoke-mode-implementation.md](karaoke-mode-implementation.md) | Phased approach: phase 1 is ready (UI done), phase 2 adds TTS timing, phase 3 handles multi-page sync. |
| **Put the wall on the TV / fix the TV kiosk** | [tv-room-kiosk.md](tv-room-kiosk.md) | Only :5173 is exposed (same-origin proxy). One-time `scripts\expose-lan.ps1` on Windows; TV Chrome + F11 + one ENGAGE tap. |
| **Deploy / debug the Tricorder cloud, mint device tokens** | [../../apps/tricorder/README.md](../../apps/tricorder/README.md) | wrangler deploy w/ agentsecrets creds; queue lives in the TenantHub DO; tokens hashed in D1; `wrangler tail` shows stale-drops. |
| **Run / rebuild / debug the Computer's Docker fence** | [computer-container.md](computer-container.md) | `make dev` + `make computer` = stack and session each in a Docker fence; repo code never executes on the host. Fence-config paths are read-only inside. `-bare` targets = unfenced fallbacks. |
