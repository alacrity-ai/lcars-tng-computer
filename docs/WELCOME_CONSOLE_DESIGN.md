# The Welcome Console — `/welcome` as a live LCARS session

*Design proposal, 2026-07-24. Replaces the scrolling brochure at
`myhome.computer/welcome` with a single-screen interactive console built on
the canonical wall renderer (`@tng/panel-renderer`, TNGC-37).*

## Problem

The current `/welcome` is a hand-rolled scrolling page with LCARS-*ish* CSS:
its own approximation of elbows, bars, and pills that is close enough to the
real wall to invite comparison and far enough to lose it. It's long, noisy,
and static — a brochure about a product whose whole point is a living screen.

TNGC-37 removed the excuse. The wall renderer is now a package; the landing
page can stop *describing* the product and simply *be* it.

## Thesis

**The landing page is a wall.** A visitor arriving at `/welcome` is standing
in front of a powered-up LCARS terminal that boots, greets them, and answers
questions when they press console keys. Navigation is not scrolling — it is
*asking the Computer things*. Every pixel of content area is rendered by the
exact code that renders in customers' living rooms, so the page is its own
product demo: if the landing page looks good, that is not marketing, that is
the product working.

One aesthetic risk, deliberately taken: **no scrolling, no prose columns, no
web-page furniture at all.** Body copy lives inside panels, at panel scale.
If a section can't be said in a panel, it gets cut until it can — the same
discipline the Computer itself lives under.

## Architecture — reuse the `/vs/` stage verbatim

The tricorder's Viewscreen already solved "host the wall inside another
page": the `/vs/` Vite build renders `LcarsFrame` + `Panel` + `WidgetLayer`
in a document whose viewport is sized 1280×720 by the parent and scaled with
a CSS transform, and it's driven by `{type:"tng-frame", msg}` postMessages
after a `tng-vs-ready` handshake.

The Welcome Console reuses **that exact deployed artifact**:

```
/welcome  (static shell, replaces welcome.html — plain HTML/CSS/JS, no build)
   └── <iframe src="/vs/?cursor=1">   ← the SAME build the tricorder uses
         sized 1280×720, scaled to letterbox via ResizeObserver (TNGC-37 pattern)
```

The shell holds a scripted "session" — a table of sections, each a list of
wire-true `DisplayMessage` frames — and posts them into the stage exactly as
the PWA does. Parity is structural: there is no second renderer, no second
build, nothing to drift. When a new panel lands for the wall, the landing
page can use it the same day.

**Two small renderer additions** (both inert for the PWA):

1. `?cursor=1` — lcars.css declares `cursor: none` ("it's a wall terminal").
   A real wall and the phone stage keep that; a desktop landing page must
   not. When the stage boots with `cursor=1` in its query string it injects a
   cursor-restoring style override (default cursor everywhere, pointer over
   Leaflet). Nothing else changes; the PWA never passes the flag.
2. The panel-wipe key becomes `view` + a monotonic frame stamp forwarded by
   the shell (`msg.seq`, optional), so composite→composite transitions still
   wipe. The PWA doesn't send `seq`; behavior there is unchanged.

## The console layout

Desktop (≥ ~880px wide):

```
┌────────────────────────────────────────────────────────────────────┐
│ ▊ TNG COMPUTER · MYHOME.COMPUTER          [LOG IN] [CREATE HOUSEHOLD]│  header strip
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│              ┌──────────────────────────────────┐                  │
│              │                                  │                  │
│              │      THE WALL  (iframe /vs/)     │   letterboxed    │
│              │   boots → greets → answers keys  │   16:9, max fit  │
│              │                                  │                  │
│              └──────────────────────────────────┘                  │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ ▊ GREETING │ THREE PARTS │ HOW IT CONNECTS │ SEE IT │ NEEDS │      │  command footer
│   INSTALL  │ PRIVACY                          ● contextual keys ▶ │
└────────────────────────────────────────────────────────────────────┘
```

Phone portrait: same three bands stacked — wall on top at 16:9 full width,
command keys wrap into a two-column bank below. Everything fits `100dvh`;
the page never scrolls at any size (that is the point).

The shell chrome uses the renderer's own tokens (`#ff9900` gold, `#ffcc99`
peach, `#cc99cc` lavender, `#9999cc` blue, `#cc6666` red, Antonio, uppercase,
black ground) so shell and stage read as one machine. Shell buttons are LCARS
pill keys: rectangular with one rounded end, gold for sections, lavender for
auth, blue for contextual actions; the active section key stays lit peach.
The cursor is **visible everywhere** — shell natively, stage via `?cursor=1`
— because this is a web page a stranger drives with a mouse, not a terminal.

## The session script — sections and their frames

Every section is one or more wire-true `display` frames. Between sections the
shell pulses `working: true` for ~400ms before the payload lands — the same
processing beat a live wall shows while Claude thinks. It is honest theater:
that IS what interaction feels like.

| Key (footer)        | Panel(s)    | Content |
|---------------------|-------------|---------|
| **GREETING** (boot default) | `composite` | Tagline text block ("The ship's computer, for your home"), the one-paragraph pitch, and a status column — WALL ONLINE · TRICORDER LINKED · BRAIN FENCED (docker) · RELAY OUTBOUND-ONLY — plus readouts (SETUP ≈ 15 MIN, PANELS 24, SUBSCRIPTION YOURS). |
| **THREE PARTS**     | `composite` (3 cols) | One group per organ: The Wall (TV), The Tricorder (phone), The Brain (your box) — each a text block + status lines. Same copy as today, tightened to panel scale. |
| **HOW IT CONNECTS** | `diagram`   | Authored inline SVG: PHONE → RELAY → YOUR HOUSE → WALL, with the outbound-only arrow doubling back and "held ≤ 60s · no transcripts kept" annotations. Caption carries the privacy one-liner. |
| **SEE IT WORK**     | demo reel   | Auto-advancing reel (~8s/frame, pausable, manual ◀ ▶ in contextual keys): `chart` (household energy, bar) → `weather` (authored 5-day) → `night-sky` (LIVE — computed for tonight at the visitor's approximate longitude, the panel's real astronomy engine) → `timeline` ("An evening with the Computer") → `math` (why the wall is 1280×720 — playful). Reel respects `prefers-reduced-motion` by not auto-advancing. |
| **WHAT YOU NEED**   | `table`     | 4 rows: Docker · a box that stays on (4 cores/4GB, no GPU) · Claude Pro/Max (your account) · a TV on the LAN. Caption: "about 15 minutes end to end." |
| **INSTALL**         | `steps` (stateful) | The 4 real steps (Register → Launch → Pair → Engage) using the panel's own `currentStep` stepping — visitor walks the install exactly the way the Computer walks a recipe. Contextual keys: ◀ PREV · NEXT ▶ · COPY COMMANDS (copies the current step's shell commands; toast confirms) · FULL GUIDE (APPLIANCE.md). |
| **PRIVACY**         | `text`      | The discard/outbound-only/no-transcripts copy at panel scale. Contextual keys: PRIVACY POLICY · TERMS. |

Persistent keys (always in the footer's right bank): **LOG IN** (`/?login=1`),
**CREATE HOUSEHOLD** (`/?register=1`), **GITHUB** (repo). The auth pair also
sits in the header strip so it is reachable without reading anything.

The boot is kept: on load the stage shows the wall's real boot panel for a
beat, then the shell sends GREETING. First impression = the product turning
on, not a hero image.

## Interaction details

- **Working pulse**: every key press sends `{working:true}`, then the display
  frame ~400ms later (display clears working, per the wall's own rule).
- **Install stepper**: re-sends the `steps` frame with `currentStep` ± 1 —
  the panel's designed statelessness, driven by console keys.
- **Copy**: commands live in the shell's script table (single source with the
  steps frames), copied via `navigator.clipboard` with the execCommand
  fallback and the existing toast pattern.
- **Keyboard**: all keys are real `<button>`/`<a>`, visible `:focus-visible`
  ring (gold), arrow keys also drive PREV/NEXT within Install and the reel.
- **Reduced motion**: reel doesn't auto-advance; shell blink/sweep effects
  disabled; the stage already respects it internally.
- **No JS / crawlers**: `<noscript>` block with the pitch, requirements,
  install pointer, and login/register links; meta/OG tags carried over from
  the current page. (Content otherwise lives in frames — accepted trade-off
  for an invited-beta product.)

## Out of scope (future candy)

- Attract mode: idle 90s on GREETING → start the reel unprompted.
- A "HAIL" key that speaks the greeting aloud (TTS is deferred product-wide).
- Live status: showing the actual count of active households from the relay.

## Files touched

| File | Change |
|------|--------|
| `apps/tricorder/public/welcome.html` | **replaced** — becomes the console shell (static, no build step) |
| `apps/tricorder/renderer/src/main.tsx` | `?cursor=1` override + optional `seq` in the wipe key |
| `docs/WELCOME_CONSOLE_DESIGN.md` | this document |

No worker/route changes: `/welcome` is already served from assets; the shell
iframes the already-deployed `/vs/` build (which `build:vs` produces before
every deploy, per the TNGC-37 rule).
