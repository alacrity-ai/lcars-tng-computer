# Voice Volume — Implementation Design (final)

**Ticket:** TNGC-27 · **Date:** 2026-07-23
**Supersedes:** the Computer's `docs/TNGC-27-voice-volume-control.md` (consumed and deleted)
**Related:** TNGC-26 ducking lowers *media* during speech; this controls the *voice itself*. The two planes never touch.

## 1. Behavior

- "Lower your voice" / "speak up" → ±15 nudges, **floored at 10** (an accidental
  "quieter ×5" never becomes a mute; only explicit mute or `level: 0` silences).
- "Voice at fifty percent" → absolute 0–100; setting a level implicitly unmutes.
- "Mute your voice" → the Computer keeps working: panels display, captions
  render (they become the answer channel), `speak_done` still reports so
  nothing upstream blocks. "Unmute" restores the prior level.
- Disambiguation lives in the media skill: "turn it down" while media plays =
  the media (unchanged); explicit "voice" phrasing = the voice; "quieter" with
  nothing playing = the voice.

## 2. Persistence — the fix over the draft

The Computer's draft said "store it in hub state" — memory-only, so a stack
restart would un-whisper the sleeping household. Final: hub holds the runtime
values, and every change writes `apps/server/.cache/settings.json` (gitignored,
same .cache as yt-dlp), reloaded at boot. A *setting*, not a session value.

## 3. Exceptions (decided)

- **Chimes** scale with voice volume and obey mute — except **red-alert**,
  which always plays at full volume (it's an alarm, not a pleasantry).
- **Timer/alarm announcements**: the server-fired speak broadcasts carry
  `alarm: true` and play **at the set voice volume even when muted** — the
  entire job of an alarm is to make noise; a muted voice shouldn't eat your
  tea timer. (The draft's timer-vs-alarm split was dropped as an
  indistinguishable-at-the-wall complication.)

## 4. Mechanics

- **Shared**: `SpeakMessage += alarm?`; new `VoiceStateMessage {type:
  "voice_state", volume, muted}` (broadcast on change and to late joiners via
  `hub.add()`); `ScreenStateResponse += voice` so the agent knows it's
  speaking into silence.
- **Server**: `voiceVolume`/`voiceMuted` on the hub + settings file;
  `POST /api/console/voice {action: volume|volume_up|volume_down|mute|unmute,
  level?}` mirroring the media route's validation.
- **Wall**: a module-scope `voiceAudio {volume, muted}` (videoFullscreen
  pattern) updated from `voice_state`. The speak handler applies
  `audio.volume`; muted non-alarm utterances skip audio and take the existing
  caption-timer path (duration = timing sum when present) with the karaoke
  sweep driven by wall clock, so reading pages still turn. `playChime` scales
  by the same state; red-alert bypasses.
- **MCP**: a separate `voice` tool (the media tool's description already
  strains). **Skill**: a "The Computer's voice" section in media SKILL.md.
