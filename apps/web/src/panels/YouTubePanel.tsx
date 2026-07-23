import { useEffect, useRef, useState } from "react";
import type { MediaAction, YouTubePanelProps } from "@tng/shared";
import { videoFullscreen } from "../videoFullscreen";

/**
 * Official YouTube embed — the one "real web" surface that beats reader mode,
 * because video wants actual pixels. youtube.com/embed permits framing (unlike
 * youtube.com proper), and the kiosk's --autoplay-policy flag lets autoplay
 * start with sound.
 *
 * enablejsapi=1 lets us drive playback over postMessage, so "computer, pause"
 * works on a wall with no pointing device (useSocket rebroadcasts media
 * messages as tng-media DOM events).
 *
 * TNGC-24: `audioOnly` renders the extracted-audio player instead — embed
 * restrictions bind only the iframe, so blocked music streams through the
 * server proxy with an LCARS now-playing card. Separate component so each
 * branch keeps its own hooks.
 */
export function YouTubePanel(props: YouTubePanelProps) {
  return props.audioOnly ? <YouTubeAudio {...props} /> : <YouTubeEmbed {...props} />;
}

function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Audio-only branch: <audio> against the server's stream proxy + an LCARS
    now-playing card. Speaks the same tng-media transport and emits the same
    ended/error events as the embed, so the queue and the server's fallback
    chain treat both branches identically (error carries audio: true so the
    server never loops back into this path). */
function YouTubeAudio({ videoId, title, channel, autoplay = true, startSeconds }: YouTubePanelProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [fullscreen, setFullscreen] = useState(videoFullscreen.value);
  const [playing, setPlaying] = useState(autoplay);
  const [clock, setClock] = useState({ t: 0, d: NaN });

  useEffect(() => {
    function onMedia(ev: Event) {
      const el = audioRef.current;
      if (!el) return;
      const { action, rate, level } = (
        ev as CustomEvent<{ action: MediaAction; rate?: number; level?: number }>
      ).detail;
      if (action === "fullscreen" || action === "windowed") {
        setFullscreen(action === "fullscreen");
      } else if (action === "play") {
        void el.play().catch(() => {});
      } else if (action === "pause" || action === "stop") {
        el.pause();
      } else if (action === "speed") {
        el.playbackRate = rate ?? 1;
      } else if (action === "mute") {
        el.muted = true;
      } else if (action === "unmute") {
        el.muted = false;
      } else if (action === "volume" || action === "volume_up" || action === "volume_down") {
        // same 0–100 / ±15-nudge semantics as the embed; element is 0–1
        const current = Math.round(el.volume * 100);
        const target = Math.max(
          0,
          Math.min(
            100,
            action === "volume" ? Math.round(level ?? current) : current + (action === "volume_up" ? 15 : -15),
          ),
        );
        el.muted = false; // setting a level implies wanting to hear it
        el.volume = target / 100;
      }
    }
    window.addEventListener("tng-media", onMedia);
    return () => window.removeEventListener("tng-media", onMedia);
  }, []);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    let errorReported = false;
    let endedReported = false;
    const onLoaded = () => {
      if (startSeconds && startSeconds > 0) el.currentTime = startSeconds;
      setClock({ t: el.currentTime, d: el.duration });
    };
    const onTime = () => setClock({ t: el.currentTime, d: el.duration });
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      if (endedReported) return;
      endedReported = true;
      window.dispatchEvent(new CustomEvent("tng-video-ended", { detail: { videoId } }));
    };
    const onError = () => {
      if (errorReported) return;
      errorReported = true;
      window.dispatchEvent(
        new CustomEvent("tng-video-error", { detail: { videoId, audio: true } }),
      );
    };
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
    };
  }, [videoId, startSeconds]);

  const progress = Number.isFinite(clock.d) && clock.d > 0 ? clock.t / clock.d : 0;
  return (
    <div className={fullscreen ? "youtube-panel youtube-panel-full" : "youtube-panel"}>
      <div className={playing ? "audio-card playing" : "audio-card"}>
        <div className="audio-eq" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
        <div className="audio-info">
          <div className="audio-title">{title ?? "Audio"}</div>
          {channel && <div className="audio-channel">{channel}</div>}
          <div className="audio-progress">
            <div className="audio-progress-fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
          <div className="audio-clock">
            <span>{fmtClock(clock.t)}</span>
            <span className="audio-tag">AUDIO</span>
            <span>{fmtClock(clock.d)}</span>
          </div>
        </div>
        <audio ref={audioRef} src={`/api/console/audio/${encodeURIComponent(videoId)}`} autoPlay={autoplay} />
      </div>
    </div>
  );
}

function YouTubeEmbed({ videoId, title, autoplay = true, startSeconds }: YouTubePanelProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // CSS full-bleed, not the browser Fullscreen API — requestFullscreen()
  // needs a user gesture, and the wall has no pointing device. Seeded from
  // module scope so a remount mid-queue keeps the wall full screen.
  const [fullscreen, setFullscreen] = useState(videoFullscreen.value);
  // Live volume as reported by the player's infoDelivery stream — the ground
  // truth "louder"/"quieter" nudge from (starts at YouTube's default).
  const volumeRef = useRef(100);

  useEffect(() => {
    const send = (func: string, args: unknown[] = []) =>
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func, args }),
        "https://www.youtube.com",
      );
    function onMedia(ev: Event) {
      const { action, rate, level } = (
        ev as CustomEvent<{ action: MediaAction; rate?: number; level?: number }>
      ).detail;
      if (action === "fullscreen" || action === "windowed") {
        setFullscreen(action === "fullscreen");
        return;
      }
      if (action === "mute") {
        send("mute");
        return;
      }
      if (action === "unmute") {
        send("unMute");
        return;
      }
      if (action === "volume" || action === "volume_up" || action === "volume_down") {
        const target = Math.max(
          0,
          Math.min(
            100,
            action === "volume"
              ? Math.round(level ?? volumeRef.current)
              : volumeRef.current + (action === "volume_up" ? 15 : -15),
          ),
        );
        // Setting a level implies wanting to hear it.
        send("unMute");
        send("setVolume", [target]);
        volumeRef.current = target;
        return;
      }
      // "stop" pauses rather than resumes (it used to fall through to
      // playVideo); stopVideo would unload the player entirely.
      const command: { func: string; args: unknown[] } =
        action === "play"
          ? { func: "playVideo", args: [] }
          : action === "speed"
            ? { func: "setPlaybackRate", args: [rate ?? 1] }
            : { func: "pauseVideo", args: [] };
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", ...command }),
        "https://www.youtube.com",
      );
    }
    window.addEventListener("tng-media", onMedia);
    return () => window.removeEventListener("tng-media", onMedia);
  }, []);

  // Subscribe to the player's event stream so embed failures (101/150 =
  // embedding disabled, 100 = not found) are reported instead of leaving a
  // dead "Video unavailable" frame — the server swaps in the next result —
  // and so natural end advances the play queue.
  useEffect(() => {
    const subscribe = () =>
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: videoId }),
        "https://www.youtube.com",
      );
    // The player honors "listening" only once booted, and playback works fine
    // without the subscription — so a failed handshake is silent and costs us
    // end/error events. Retry until the player's first message proves the
    // stream is live (a slow embed boot outlasts any fixed window).
    let acked = false;
    let timer: number | undefined;
    const startHandshake = () => {
      acked = false;
      if (timer !== undefined) clearInterval(timer);
      timer = window.setInterval(() => {
        if (acked) {
          clearInterval(timer);
          timer = undefined;
        } else {
          subscribe();
        }
      }, 700);
    };
    startHandshake();

    let reported = false;
    let endedReported = false;
    const reportEnded = () => {
      if (endedReported) return;
      endedReported = true;
      window.dispatchEvent(new CustomEvent("tng-video-ended", { detail: { videoId } }));
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== "https://www.youtube.com") return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      } catch {
        return;
      }
      acked = true;
      if (data?.event === "onError" && !reported) {
        reported = true;
        window.dispatchEvent(
          new CustomEvent("tng-video-error", {
            detail: { videoId, code: Number(data.info) || undefined },
          }),
        );
      }
      // Natural end: the server advances the play queue. Once per mount —
      // replays after a seek don't re-fire. Detected two ways, because the
      // discrete ENDED state change is a single message that can be missed:
      // the periodic infoDelivery stream also carries playerState.
      if (data?.event === "onStateChange" && Number(data.info) === 0) reportEnded();
      if (data?.event === "infoDelivery") {
        const info = data.info as { playerState?: number; volume?: number } | undefined;
        if (typeof info?.volume === "number") volumeRef.current = info.volume;
        if (info?.playerState === 0) reportEnded();
      }
    };
    window.addEventListener("message", onMessage);
    // Re-handshake whenever the iframe (re)loads — a reload resets the
    // player's listener list even though our effect never re-ran.
    const frame = frameRef.current;
    const onLoad = () => startHandshake();
    frame?.addEventListener("load", onLoad);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      frame?.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
    };
  }, [videoId]);

  const params = new URLSearchParams({ rel: "0", enablejsapi: "1", origin: location.origin });
  if (autoplay) params.set("autoplay", "1");
  if (startSeconds && startSeconds > 0) params.set("start", String(Math.floor(startSeconds)));

  return (
    <div className={fullscreen ? "youtube-panel youtube-panel-full" : "youtube-panel"}>
      {title && <div className="youtube-title">{title}</div>}
      <iframe
        ref={frameRef}
        className="youtube-frame"
        src={`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`}
        title={title ?? "Video"}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
