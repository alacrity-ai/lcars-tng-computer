# Tricorder Voice — Implementation Design (final)

**Ticket:** TNGC-75 · **Date:** 2026-07-27
**Closes:** the TTS deferral carried since TNGC-36 (Viewscreen mode)
**Prereq reading:** `apps/tricorder/public/index.html` (§ Viewscreen mode),
`packages/bridge/src/index.ts` (§ tricorder viewscreens), `docs/VOICE_VOLUME_IMPLEMENTATION_DESIGN.md`

## 1. Problem

Viewscreen mode made the phone a real wall for everything except sound: a
`speak` frame routed at `tricorder-<user>` rendered as a **silent caption**, and
the bridge faked its `speak_done` the instant the frame arrived. Working on the
tricorder — in another room, in bed, away from any wall — meant the Computer
answered in writing only. It was the last piece of wall parity still missing,
and the one most often noticed.

## 2. Decision — the phone speaks in its own voice

The phone synthesizes locally with `speechSynthesis`, exactly as it already
recognizes locally with `SpeechRecognition`. The `speak` frame already carries
the text; nothing new crosses the tunnel.

The alternative — proxying Piper's WAV bridge → DO → phone — was rejected:

- it puts hundreds of kilobytes per utterance on a control channel whose whole
  design rule is that **frames stay metadata-sized** (the same rule that made
  library displays fetch-at-dispatch);
- it needs a new upload/fetch/expiry plane in the cloud for bytes that are
  played once and thrown away;
- it adds a synth → upload → notify → fetch hop to the one thing that has to
  feel immediate.

Trade accepted, explicitly: **on the phone the voice is the handset's, not
Piper's.** The wall keeps the Computer's real voice; the phone gets *a* voice,
which beats silence. If the Majel clone (TNGC-4) ever lands, this decision is
worth revisiting — a small, cacheable model could ship to the phone; streaming
per-utterance audio through the cloud still would not.

## 3. Behavior

- Any `speak` frame reaching a Viewscreen-mode phone is **spoken**, and its
  caption is on screen for as long as the voice is talking (the caption's dwell
  is now the utterance, not a character-count guess).
- **House voice state governs** (TNGC-27, wall parity): volume scales the
  utterance, mute makes captions the answer channel again, and `alarm: true`
  speaks through a mute — a tea timer is not a pleasantry.
- **A local speaker toggle** in the viewscreen header is this handset's own
  veto (persisted per device). Muting your phone must never mute the house, so
  it is deliberately NOT the `voice` MCP tool's mute.
- **Read-aloud** (`caption: false`) speaks without covering the panel it is
  reading. The karaoke highlight sweep stays a wall feature — it needs
  `timing`, which the bridge still strips (see §7).
- **Barge-in**: holding the talk button cancels speech, so the mic never hears
  the Computer. Exiting Viewscreen mode, backgrounding the app, and a
  superseding utterance all cancel too.
- **Ducking**: an utterance drops this phone's YouTube player to 30% and
  restores it after — the phone's version of TNGC-26, so the answer is audible
  over the music that prompted it.

## 4. `speak_done` becomes truthful — the load-bearing change

`speak` blocks the agent until the addressed display reports back; that report
is what paces a page-by-page article read. The bridge used to answer for the
phone the moment the frame arrived, which was honest while the phone was silent
and becomes a lie the moment it isn't: the reading loop would fire every page
in seconds while the phone spoke page one.

So completion moves to the party that now owns it:

```
hub.speak → display socket → bridge → DO → phone speaks
                  ▲                            │
                  └──── speak_done ────────────┘   (screen socket, up)
```

- **PWA** reports `{type:"speak_done", utteranceId}` up the screen socket when
  the utterance ends — and equally when it is silenced, cancelled, superseded,
  or the engine is missing. Exactly one report per utterance, always.
- **DO** whitelists `speak_done` on screen sockets alongside the player events
  (`webSocketMessage`); it relays as a `display_client` frame like the rest.
- **Bridge** stops faking the ack and arms a **backstop timer** instead
  (utterance estimate + 12s, capped at 70s — deliberately longer than the
  phone's own safety net, so a phone that is still talking always wins the
  race). Everything that can end an utterance — the report, the backstop, a
  superseding `speak`, the viewscreen closing — funnels through one
  `settleSpeak`, so the house hears about it exactly once. A killed app, a
  device on silent, or a pre-TNGC-75 PWA therefore costs one bounded wait,
  never a wedged session.

## 5. The house stops synthesizing for phones

A phone-addressed `speak` used to run the full Piper pipeline — chunk, split,
synthesize, broadcast — and only then reach a phone that throws the audio away
at the bridge. The wait was pure latency on the surface that most needs to feel
immediate. The speak route now short-circuits for `tricorder-*` walls and
broadcasts the same caption-carrying, audio-less frame the sidecar-down path
already sends (`tts: "phone"`), so the words leave the house the moment they
exist.

Article read-aloud (`reading.ts`) still synthesizes per page; its prefetch and
karaoke machinery is built around `SynthResult`, and with completion now
reported honestly the pacing is correct either way. Only the waste is left, and
it stays on the wall-shaped path where it belongs — worth revisiting if reading
to a phone becomes common.

## 6. Where the code lives

| File | Change |
|---|---|
| `apps/tricorder/public/index.html` | § "viewscreen voice (TNGC-75)": voice pick, `vsSpeak`, house `voice_state`, local toggle + icon, prime-on-enter, duck/restore, barge-in from `beginPTT` |
| `packages/bridge/src/index.ts` | relay `speak` instead of answering it; backstop timer per utterance; still strips `audioUrl`/`timing` |
| `apps/tricorder/src/hub.ts` | `speak_done` accepted on screen sockets |
| `apps/server/src/routes/console.ts` | phone-addressed `speak` skips synthesis entirely (§5) |
| `packages/shared/src/index.ts` | `isTricorderDisplay()` — one place that knows a phone viewscreen from a wall |
| `packages/contract/src/index.ts` | `display_client` doc comment: player events **+ speak completion** |
| `claude/CLAUDE.md` | the "silent caption is expected" note becomes "the phone speaks in its own voice" |
| `apps/tricorder/renderer/src/main.tsx` | stage header comment: speak stays PWA-native because the voice is |

## 7. Deliberately out of scope

- **Chimes/earcons on the phone** — the wall's sound set isn't shipped in the
  PWA bundle; the voice was the ask.
- **Karaoke sweep in Viewscreen mode** — needs per-character `timing` on every
  frame, which is exactly the payload weight §2 refuses. The stage still shows
  the page; only the highlight is missing.
- **Piper audio over the tunnel** — see §2.

## 8. Risks

- **iOS gesture requirement**: `speechSynthesis.speak()` outside a user gesture
  is ignored on Safari. Entering Viewscreen mode is a tap, so the enter handler
  spends it on a silent priming utterance. Toggling the speaker back on primes
  again. Worst case the first utterance is silent — its `speak_done` still
  fires, so nothing upstream stalls.
- **Voice quality varies by handset.** The pick prefers an en-GB female voice
  by name, falls back to any en-GB, then any English, then the default. Never
  fatal: no voice at all still speaks with the engine default.
- **Safari drops `onend`** when the app backgrounds mid-utterance; the same
  per-utterance safety timer that guards the caption fires `done()`.
