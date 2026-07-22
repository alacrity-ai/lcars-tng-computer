import { useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  PanelProps,
  PanelView,
  ServerMessage,
  Widget,
} from "@tng/shared";
import { playChime } from "./audio";
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

export function useSocket() {
  const [screen, setScreen] = useState<ScreenState>({ view: "boot", props: {} });
  const [voice, setVoice] = useState<VoiceLine | null>(null);
  const [connected, setConnected] = useState(false);
  /** True when the browser blocked audio autoplay (tab opened without the
      kiosk's --autoplay-policy flag); a tap/keypress unlocks it. */
  const [audioLocked, setAudioLocked] = useState(false);
  /** "Request heard, Computer is thinking" — set by the harness hook the
      moment a prompt is submitted; cleared by real activity or timeout. */
  const [working, setWorking] = useState(false);
  /** Overlay widgets (timers, alarms) — full list, server is authoritative. */
  const [widgets, setWidgets] = useState<Widget[]>([]);
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
        send({ type: "hello", role: "display" });
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
          screenRef.current = { view: msg.view, props: msg.props };
          setScreen({ view: msg.view, props: msg.props });
          send({ type: "screen_state", view: msg.view, props: msg.props });
        } else if (msg.type === "widgets") {
          setWidgets(msg.widgets);
        } else if (msg.type === "chime") {
          void playChime(msg.name);
        } else if (msg.type === "media") {
          // "stop" also halts any in-flight speech; pause/play stay panel-scoped.
          if (msg.action === "stop") stopSpeechRef.current?.();
          // Record full-bleed transitions before the event fires so a panel
          // mounting later (queue advance, error swap) adopts the right mode.
          if (msg.action === "fullscreen") videoFullscreen.value = true;
          if (msg.action === "windowed") videoFullscreen.value = false;
          // Loose coupling: whichever panel is playing media listens for this.
          window.dispatchEvent(
            new CustomEvent("tng-media", { detail: { action: msg.action, rate: msg.rate } }),
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
          const { utteranceId, text, audioUrl, caption = true, timing, highlightBase = 0 } = msg;
          // A new utterance supersedes any still-playing one.
          stopSpeechRef.current?.();
          readingAloud = !caption;
          setVoice({ utteranceId, text, caption });

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
            clearHighlight();
            stopSpeechRef.current = null;
            setVoice((v) => (v?.utteranceId === utteranceId ? null : v));
            send({ type: "speak_done", utteranceId });
          };
          if (audioUrl) {
            const audio = new Audio(audioUrl);
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
            // TTS offline: caption only, report done after a reading-time estimate
            const timer = setTimeout(done, captionMs(text));
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
      const { videoId, code } = ((e as CustomEvent).detail ?? {}) as {
        videoId?: string;
        code?: number;
      };
      if (!videoId) return;
      ws.send(JSON.stringify({ type: "video_error", videoId, code }));
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

  return { screen, voice, connected, audioLocked, working, widgets };
}
