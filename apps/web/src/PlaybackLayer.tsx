import { useEffect, useRef, useState } from "react";
import type { MediaAction, PanelProps, PanelView } from "@tng/shared";
import { videoFullscreen } from "./videoFullscreen";

/**
 * The persistent playback layer (TNGC-26): the ONE place a YouTube iframe or
 * extracted-audio element lives. It sits outside the panel tree, so panel
 * churn never unmounts the player — music survives "what's the weather".
 *
 * Render modes, derived from the visible view + the track's intent:
 *   docked   view === "youtube": fills the content area (the classic panel,
 *            visually unchanged — the registry's youtube entry renders null)
 *   pip      backgrounded watch-mode video: corner thumbnail, audio continues
 *   hidden   backgrounded ambient audio/music: 1px + opacity 0 (NOT
 *            display:none — the media pipeline must keep running)
 * The player element is keyed by videoId+audioOnly+startSeconds: re-docking
 * the same track never remounts it, so position/volume/rate survive; a seek
 * (new startSeconds) or an audio flip intentionally reloads.
 *
 * Speech ducking: `tng-duck` events (from the speak handler) scale playback
 * to 30% for the utterance, then restore. Wall-side only.
 */

const DUCK = 0.3;

export function PlaybackLayer({ playback, view }: { playback: PanelProps | null; view: PanelView }) {
  const [fullscreen, setFullscreen] = useState(videoFullscreen.value);
  useEffect(() => {
    function onMedia(ev: Event) {
      const { action } = (ev as CustomEvent<{ action: MediaAction }>).detail;
      if (action === "fullscreen" || action === "windowed") setFullscreen(action === "fullscreen");
    }
    window.addEventListener("tng-media", onMedia);
    return () => window.removeEventListener("tng-media", onMedia);
  }, []);

  if (!playback || typeof playback.videoId !== "string") return null;
  const videoId = playback.videoId;
  const audioOnly = playback.audioOnly === true;
  const title = typeof playback.title === "string" ? playback.title : undefined;
  const channel = typeof playback.channel === "string" ? playback.channel : undefined;
  const startSeconds = typeof playback.startSeconds === "number" ? playback.startSeconds : undefined;
  const ambient = (playback.mode ?? (audioOnly ? "ambient" : "watch")) === "ambient";
  const docked = view === "youtube";

  const cls = docked
    ? fullscreen
      ? "playback-layer youtube-panel youtube-panel-full"
      : "playback-layer playback-docked youtube-panel"
    : ambient
      ? "playback-layer playback-hidden"
      : "playback-layer playback-pip";

  const key = `${videoId}:${audioOnly}:${startSeconds ?? ""}`;
  return (
    <div className={cls}>
      {docked && title && !audioOnly && <div className="youtube-title">{title}</div>}
      {audioOnly ? (
        <AudioPlayer key={key} videoId={videoId} title={title} channel={channel} startSeconds={startSeconds} />
      ) : (
        <EmbedPlayer key={key} videoId={videoId} title={title} startSeconds={startSeconds} />
      )}
    </div>
  );
}

interface PlayerProps {
  videoId: string;
  title?: string;
  channel?: string;
  startSeconds?: number;
}

/**
 * Official YouTube embed — youtube.com/embed permits framing, the kiosk's
 * --autoplay-policy flag lets autoplay start with sound, and enablejsapi=1
 * drives playback over postMessage for a wall with no pointing device.
 */
function EmbedPlayer({ videoId, title, startSeconds }: PlayerProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Ground-truth volume from the player's infoDelivery stream; duck scales
  // the live player without touching this base (and infoDelivery updates are
  // ignored while ducked so the base can't get corrupted).
  const volumeRef = useRef(100);
  const duckedRef = useRef(false);

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
      if (action === "mute") send("mute");
      else if (action === "unmute") send("unMute");
      else if (action === "volume" || action === "volume_up" || action === "volume_down") {
        const target = Math.max(
          0,
          Math.min(
            100,
            action === "volume"
              ? Math.round(level ?? volumeRef.current)
              : volumeRef.current + (action === "volume_up" ? 15 : -15),
          ),
        );
        send("unMute"); // setting a level implies wanting to hear it
        send("setVolume", [target]);
        volumeRef.current = target;
      } else if (action === "play") send("playVideo");
      else if (action === "pause" || action === "stop") send("pauseVideo");
      else if (action === "speed") send("setPlaybackRate", [rate ?? 1]);
      // fullscreen/windowed are the layer's concern
    }
    function onDuck(ev: Event) {
      const { on } = (ev as CustomEvent<{ on: boolean }>).detail;
      if (on === duckedRef.current) return;
      duckedRef.current = on;
      send("setVolume", [on ? Math.round(volumeRef.current * DUCK) : volumeRef.current]);
    }
    window.addEventListener("tng-media", onMedia);
    window.addEventListener("tng-duck", onDuck);
    return () => {
      window.removeEventListener("tng-media", onMedia);
      window.removeEventListener("tng-duck", onDuck);
    };
  }, []);

  // Event-stream subscription: embed failures report (server fallback/
  // substitution) and natural end advances the queue. Retried handshake —
  // the player honors "listening" only once booted.
  useEffect(() => {
    const subscribe = () =>
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: videoId }),
        "https://www.youtube.com",
      );
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
      // ENDED detected two ways — the discrete state change can be missed;
      // the periodic infoDelivery stream also carries playerState.
      if (data?.event === "onStateChange" && Number(data.info) === 0) reportEnded();
      if (data?.event === "infoDelivery") {
        const info = data.info as { playerState?: number; volume?: number } | undefined;
        if (typeof info?.volume === "number" && !duckedRef.current) volumeRef.current = info.volume;
        if (info?.playerState === 0) reportEnded();
      }
    };
    window.addEventListener("message", onMessage);
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
  params.set("autoplay", "1");
  if (startSeconds && startSeconds > 0) params.set("start", String(Math.floor(startSeconds)));

  return (
    <iframe
      ref={frameRef}
      className="youtube-frame"
      src={`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`}
      title={title ?? "Video"}
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
    />
  );
}

function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Extracted-audio branch (TNGC-24): <audio> against the server's stream
    proxy + the LCARS now-playing card. Same transport, same ended/error
    events (error carries audio: true so the server never loops). */
function AudioPlayer({ videoId, title, channel, startSeconds }: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(true);
  const [clock, setClock] = useState({ t: 0, d: NaN });
  // Base volume 0–100; the element's real volume = base × duck factor.
  const baseVolume = useRef(100);
  const ducked = useRef(false);

  useEffect(() => {
    const apply = () => {
      const el = audioRef.current;
      if (el) el.volume = (baseVolume.current / 100) * (ducked.current ? DUCK : 1);
    };
    function onMedia(ev: Event) {
      const el = audioRef.current;
      if (!el) return;
      const { action, rate, level } = (
        ev as CustomEvent<{ action: MediaAction; rate?: number; level?: number }>
      ).detail;
      if (action === "play") void el.play().catch(() => {});
      else if (action === "pause" || action === "stop") el.pause();
      else if (action === "speed") el.playbackRate = rate ?? 1;
      else if (action === "mute") el.muted = true;
      else if (action === "unmute") el.muted = false;
      else if (action === "volume" || action === "volume_up" || action === "volume_down") {
        baseVolume.current = Math.max(
          0,
          Math.min(
            100,
            action === "volume"
              ? Math.round(level ?? baseVolume.current)
              : baseVolume.current + (action === "volume_up" ? 15 : -15),
          ),
        );
        el.muted = false; // setting a level implies wanting to hear it
        apply();
      }
    }
    function onDuck(ev: Event) {
      ducked.current = (ev as CustomEvent<{ on: boolean }>).detail.on;
      apply();
    }
    window.addEventListener("tng-media", onMedia);
    window.addEventListener("tng-duck", onDuck);
    return () => {
      window.removeEventListener("tng-media", onMedia);
      window.removeEventListener("tng-duck", onDuck);
    };
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
      window.dispatchEvent(new CustomEvent("tng-video-error", { detail: { videoId, audio: true } }));
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
      <audio ref={audioRef} src={`/api/console/audio/${encodeURIComponent(videoId)}`} autoPlay />
    </div>
  );
}
