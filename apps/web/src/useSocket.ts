import { useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  PanelProps,
  PanelView,
  ServerMessage,
  Widget,
} from "@tng/shared";
import { playChime, voiceAudio } from "./audio";
import { videoFullscreen } from "./videoFullscreen";

export interface ScreenState {
  view: PanelView;
  props: PanelProps;
}

export interface VoiceLine {
  utteranceId: string;
  text: string;
  /** false = audio plays but the text is not overlaid on the panel. */
  caption: boolean;
}

/** Estimated caption dwell time while TTS is offline (Phase 2 replaces with real audio). */
function captionMs(text: string): number {
  return Math.min(8000, Math.max(1200, 250 + text.length * 55));
}

export function useSocket(displayName: string | null) {
  const [screen, setScreen] = useState<ScreenState>({ view: "boot", props: {} });
  const [voice, setVoice] = useState<VoiceLine | null>(null);
  const [connected, setConnected] = useState(false);
  /** TNGC-35: the display name the SERVER confirmed for this socket (post-
      normalization / rename) — what the corner label shows and localStorage
      persists. */
  const [confirmedDisplay, setConfirmedDisplay] = useState<{ name: string; primary: boolean } | null>(null);
  const displayRef = useRef<string | null>(displayName);
  /** Only a name this client DECLARED (param/storage/picker) persists — the
      server confirming the implicit primary fallback must not brand a fresh
      screen as "main" forever. */
  const declaredRef = useRef(displayName !== null);
  /** True when the browser blocked audio autoplay (tab opened without the
      kiosk's --autoplay-policy flag); a tap/keypress unlocks it. */
  const [audioLocked, setAudioLocked] = useState(false);
  /** "Request heard, Computer is thinking" — set by the harness hook the
      moment a prompt is submitted; cleared by real activity or timeout. */
  const [working, setWorking] = useState(false);
  /** Overlay widgets (timers, alarms) — full list, server is authoritative. */
  const [widgets, setWidgets] = useState<Widget[]>([]);
  /** TNGC-26: what the persistent PlaybackLayer is playing — set by youtube
      displays and `playback track` messages, cleared by stop. */
  const [playback, setPlayback] = useState<PanelProps | null>(null);
  /** TNGC-27: the voice setting as React state (drives the muted badge) and
      a transient flash shown for a few seconds after any CHANGE. */
  const [voiceState, setVoiceState] = useState({ volume: 100, muted: false });
  const [voiceFlash, setVoiceFlash] = useState<{ volume: number; muted: boolean } | null>(null);
  const voiceFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const workingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Kills in-flight speech (audio or caption timer) and reports speak_done. */
  const stopSpeechRef = useRef<(() => void) | null>(null);
  /** Last displayed screen — merged with map view-sync echoes so the server's
      screen_state stays truthful after voice-driven pans/zooms. */
  const screenRef = useRef<ScreenState>({ view: "boot", props: {} });

  useEffect(() => {
    let disposed = false;
    let retry = 0;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      const send = (msg: ClientMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      };

      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        // TNGC-35: declare which viewscreen this client is. Empty/absent =
        // the server's primary wall (legacy behavior, invisible upgrade).
        send({ type: "hello", role: "display", display: displayRef.current ?? undefined });
      };

      // True while the playing utterance is caption-less reading audio — that
      // audio is meaningless once its text leaves the screen, so any display
      // change kills it (page turns during a reading session arrive only
      // after the previous page's audio has finished, so they're unaffected).
      let readingAloud = false;

      const clearWorking = () => {
        if (workingTimerRef.current) clearTimeout(workingTimerRef.current);
        workingTimerRef.current = null;
        setWorking(false);
      };

      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        // Only a display — actual content landing on the wall — counts as the
        // request being fulfilled. Speech does NOT clear the badge: a spoken
        // "Looking up records…" acknowledgment is the START of the work, and
        // clearing on it made long research phases look frozen. Turns that end
        // with speech alone are cleared by the Stop hook (working:false).
        if (msg.type === "display") {
          clearWorking();
        }
        if (msg.type === "working") {
          if (msg.active) {
            if (workingTimerRef.current) clearTimeout(workingTimerRef.current);
            setWorking(true);
            // Backstop only — the Stop hook is the real end-of-turn signal.
            // Generous because deep research turns legitimately run minutes.
            workingTimerRef.current = setTimeout(() => setWorking(false), 300_000);
          } else {
            clearWorking();
          }
        } else if (msg.type === "display") {
          if (readingAloud) {
            stopSpeechRef.current?.();
            readingAloud = false;
          }
          // Full-bleed video is a youtube-panel mode, not a wall mode: any
          // other panel taking the screen exits it. Queue advances re-display
          // youtube, so they sail through with the flag intact.
          if (msg.view !== "youtube") videoFullscreen.value = false;
          // A youtube display IS the playback session (TNGC-26); any other
          // panel merely backgrounds it — the PlaybackLayer keeps going.
          if (msg.view === "youtube") setPlayback(msg.props);
          screenRef.current = { view: msg.view, props: msg.props };
          setScreen({ view: msg.view, props: msg.props });
          send({ type: "screen_state", view: msg.view, props: msg.props });
        } else if (msg.type === "playback") {
          // Background track swap / session teardown — panel untouched.
          setPlayback(msg.action === "track" ? (msg.props ?? null) : null);
        } else if (msg.type === "voice_state") {
          // Flash the new level only when something actually CHANGED — the
          // sync a reconnect re-delivers must not ghost-flash the wall.
          const changed = msg.volume !== voiceAudio.volume || msg.muted !== voiceAudio.muted;
          voiceAudio.volume = msg.volume;
          voiceAudio.muted = msg.muted;
          setVoiceState({ volume: msg.volume, muted: msg.muted });
          if (changed) {
            setVoiceFlash({ volume: msg.volume, muted: msg.muted });
            if (voiceFlashTimer.current) clearTimeout(voiceFlashTimer.current);
            voiceFlashTimer.current = setTimeout(() => setVoiceFlash(null), 3000);
          }
        } else if (msg.type === "display_id") {
          // The server's word on who we are — persist it so this screen keeps
          // its identity across reloads (renames flow through here too).
          displayRef.current = msg.name;
          setConfirmedDisplay({ name: msg.name, primary: msg.primary });
          if (declaredRef.current) {
            try {
              localStorage.setItem("tng.display", msg.name);
            } catch {
              // storage unavailable (private mode) — identity lasts the session
            }
          }
        } else if (msg.type === "widgets") {
          setWidgets(msg.widgets);
        } else if (msg.type === "chime") {
          void playChime(msg.name);
        } else if (msg.type === "media") {
          // "stop" also halts any in-flight speech AND ends the playback
          // session (the server clears its record in the same stroke).
          if (msg.action === "stop") {
            stopSpeechRef.current?.();
            setPlayback(null);
          }
          // Record full-bleed transitions before the event fires so a panel
          // mounting later (queue advance, error swap) adopts the right mode.
          if (msg.action === "fullscreen") videoFullscreen.value = true;
          if (msg.action === "windowed") videoFullscreen.value = false;
          // Loose coupling: whichever panel is playing media listens for this.
          window.dispatchEvent(
            new CustomEvent("tng-media", { detail: { action: msg.action, rate: msg.rate, level: msg.level } }),
          );
        } else if (msg.type === "map_control") {
          // Same loose coupling: the live MapPanel animates in place.
          window.dispatchEvent(
            new CustomEvent("tng-map-control", {
              detail: {
                action: msg.action,
                amount: msg.amount,
                lat: msg.lat,
                lng: msg.lng,
                zoom: msg.zoom,
                title: msg.title,
              },
            }),
          );
        } else if (msg.type === "sky_control") {
          // Same loose coupling: the live NightSkyPanel steers itself.
          const { type: _type, ...detail } = msg;
          window.dispatchEvent(new CustomEvent("tng-sky-control", { detail }));
        } else if (msg.type === "speak") {
          const { utteranceId, text, audioUrl, caption = true, timing, highlightBase = 0, alarm } = msg;
          // A new utterance supersedes any still-playing one.
          stopSpeechRef.current?.();
          readingAloud = !caption;
          setVoice({ utteranceId, text, caption });
          // TNGC-27: muted voice = captions are the channel. Alarms bypass
          // mute (their job is noise) but still respect the volume setting.
          const silenced = voiceAudio.muted && !alarm;

          // Karaoke: when reading on-screen content (caption off) with timing
          // data, animate the current panel's highlightIndex locally — the
          // agent makes one speak call per page, the wall does the sweep.
          let highlightTimer: number | undefined;
          const clearHighlight = () => {
            if (highlightTimer !== undefined) {
              clearInterval(highlightTimer);
              highlightTimer = undefined;
              setScreen((s) => {
                const { highlightIndex: _drop, ...rest } = s.props;
                return { ...s, props: rest };
              });
            }
          };
          // Keyed to the audio element's own clock, not wall time: currentTime
          // is 0 until playback truly starts and freezes if it stalls, so the
          // highlight can't run ahead of the voice.
          const startHighlight = (elapsedMs: () => number) => {
            if (caption || !timing || timing.length === 0) return;
            const starts: { at: number; char: number }[] = [];
            let acc = 0;
            for (const t of timing) {
              starts.push({ at: acc, char: t.char });
              acc += t.duration_ms;
            }
            let idx = 0;
            highlightTimer = window.setInterval(() => {
              const elapsed = elapsedMs();
              while (idx < starts.length - 1 && starts[idx + 1].at <= elapsed) idx++;
              const char = highlightBase + starts[idx].char;
              setScreen((s) =>
                s.props.highlightIndex === char
                  ? s
                  : { ...s, props: { ...s.props, highlightIndex: char } },
              );
            }, 50);
          };

          let finished = false;
          const done = () => {
            if (finished) return;
            finished = true;
            // restore any speech-ducked background playback (TNGC-26)
            window.dispatchEvent(new CustomEvent("tng-duck", { detail: { on: false } }));
            clearHighlight();
            stopSpeechRef.current = null;
            setVoice((v) => (v?.utteranceId === utteranceId ? null : v));
            send({ type: "speak_done", utteranceId });
          };
          if (audioUrl && !silenced) {
            const audio = new Audio(audioUrl);
            // voice volume (TNGC-27) + duck any background music under the
            // utterance (TNGC-26) — restored in done()
            audio.volume = voiceAudio.volume / 100;
            window.dispatchEvent(new CustomEvent("tng-duck", { detail: { on: true } }));
            const unlock = () => {
              void audio.play().then(() => setAudioLocked(false)).catch(() => {});
            };
            const removeUnlockListeners = () => {
              window.removeEventListener("pointerdown", unlock);
              window.removeEventListener("keydown", unlock);
            };
            audio.onended = () => {
              removeUnlockListeners();
              done();
            };
            audio.onerror = () => {
              removeUnlockListeners();
              done();
            };
            stopSpeechRef.current = () => {
              removeUnlockListeners();
              setAudioLocked(false);
              audio.pause();
              done();
            };
            startHighlight(() => audio.currentTime * 1000);
            void audio.play().catch((err: unknown) => {
              const name = err instanceof Error ? err.name : "";
              if (name === "NotAllowedError") {
                // Autoplay blocked — the tab lacks the kiosk's autoplay flag.
                // Completing the utterance here would silently race a reading
                // loop through every page; instead surface it and retry on the
                // first user gesture. (speak_done still fires via the server's
                // 60s per-utterance timeout if nobody ever taps.)
                console.warn("[tng] audio autoplay blocked — tap the display or launch via `pnpm kiosk`");
                setAudioLocked(true);
                window.addEventListener("pointerdown", unlock);
                window.addEventListener("keydown", unlock);
              } else {
                done();
              }
            });
          } else {
            // TTS offline OR voice muted (TNGC-27): caption-only. With timing
            // data the dwell is the real utterance length and the karaoke
            // sweep runs on wall clock — muted article reading still turns
            // its pages on schedule.
            const ms = timing?.length
              ? timing.reduce((total, t) => total + t.duration_ms, 0) + 300
              : captionMs(text);
            const t0 = performance.now();
            startHighlight(() => performance.now() - t0);
            const timer = setTimeout(done, ms);
            stopSpeechRef.current = () => {
              clearTimeout(timer);
              done();
            };
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!disposed) setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      };
    }

    connect();

    // The map announces its settled view after every animation; echo it as
    // screen_state so relative voice commands ("go west" then "zoom in")
    // always compose against where the map actually is.
    const onMapView = (e: Event) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (screenRef.current.view !== "map") return;
      const props = { ...screenRef.current.props, ...((e as CustomEvent).detail ?? {}) };
      screenRef.current = { view: "map", props };
      ws.send(JSON.stringify({ type: "screen_state", view: "map", props }));
    };
    window.addEventListener("tng-map-view", onMapView);

    // The night-sky panel announces its settled view the same way (including
    // simulated time), so "zoom in" after a time-lapse composes correctly.
    const onSkyView = (e: Event) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (screenRef.current.view !== "night-sky") return;
      const props = { ...screenRef.current.props, ...((e as CustomEvent).detail ?? {}) };
      screenRef.current = { view: "night-sky", props };
      ws.send(JSON.stringify({ type: "screen_state", view: "night-sky", props }));
    };
    window.addEventListener("tng-sky-view", onSkyView);

    // YouTube player errors relay to the server, which auto-advances to the
    // next viable search result.
    const onVideoError = (e: Event) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const { videoId, code, audio } = ((e as CustomEvent).detail ?? {}) as {
        videoId?: string;
        code?: number;
        audio?: boolean;
      };
      if (!videoId) return;
      ws.send(JSON.stringify({ type: "video_error", videoId, code, audio }));
    };
    window.addEventListener("tng-video-error", onVideoError);

    // Natural video end relays to the server, which advances the play queue.
    // Unlike the other relays this one retries through a reconnect window:
    // it fires exactly once per video, so dropping it strands the queue.
    const onVideoEnded = (e: Event) => {
      const { videoId } = ((e as CustomEvent).detail ?? {}) as { videoId?: string };
      if (!videoId) return;
      let attempts = 0;
      const trySend = () => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "video_ended", videoId }));
        } else if (attempts++ < 15) {
          setTimeout(trySend, 1000);
        }
      };
      trySend();
    };
    window.addEventListener("tng-video-ended", onVideoEnded);

    return () => {
      disposed = true;
      window.removeEventListener("tng-map-view", onMapView);
      window.removeEventListener("tng-sky-view", onSkyView);
      window.removeEventListener("tng-video-error", onVideoError);
      window.removeEventListener("tng-video-ended", onVideoEnded);
      wsRef.current?.close();
    };
  }, []);

  /** Re-designate this screen live ("the box moved to the den") — the server
      migrates state when the move empties the old display, then answers with
      display_id, which persists the new name. */
  const setDisplay = (name: string) => {
    declaredRef.current = true;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_display", name }));
    } else {
      displayRef.current = name; // applied at the next (re)connect hello
    }
  };

  return {
    screen, voice, connected, audioLocked, working, widgets, playback, voiceState, voiceFlash,
    confirmedDisplay, setDisplay,
  };
}
