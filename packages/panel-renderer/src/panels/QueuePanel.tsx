import type { QueueItem, QueuePanelProps } from "@tng/shared";

/** Now-playing + up-next (TNGC-66). Props are server-composed and re-pushed
    on every queue/playback change, so this renders dumb: no timers, no
    fetches — the truth arrives as fresh props. */
const MAX_ROWS = 14;

function fmtDuration(s?: number): string | null {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function Row({ item, position }: { item: QueueItem; position: number }) {
  const dur = fmtDuration(item.durationSeconds);
  return (
    <div className="mq-row">
      <span className="mq-pos">{position}</span>
      <span className="mq-track">
        <span className="mq-track-title">{item.title ?? item.videoId}</span>
        {item.channel && <span className="mq-track-channel">{item.channel}</span>}
      </span>
      {dur && <span className="mq-dur">{dur}</span>}
    </div>
  );
}

export function QueuePanel({ nowPlaying, queue }: QueuePanelProps) {
  const shown = queue.slice(0, MAX_ROWS);
  const overflow = queue.length - shown.length;
  const known = queue
    .map((q) => q.durationSeconds)
    .filter((d): d is number => typeof d === "number" && d > 0);
  const totalKnown = known.reduce((a, b) => a + b, 0);
  const nowDur = fmtDuration(nowPlaying?.durationSeconds);

  return (
    <div className="mq-panel">
      <div className="mq-now">
        <div className="mq-section-label">NOW PLAYING</div>
        {nowPlaying ? (
          <div className="mq-now-body">
            <div className="mq-now-title">{nowPlaying.title ?? nowPlaying.videoId}</div>
            <div className="mq-now-meta">
              {nowPlaying.channel && <span className="mq-now-channel">{nowPlaying.channel}</span>}
              {nowPlaying.audioOnly && <span className="mq-tag">AUDIO</span>}
              {nowPlaying.backgrounded && <span className="mq-tag mq-tag-bg">BACKGROUND ♫</span>}
              {nowDur && <span className="mq-dur">{nowDur}</span>}
            </div>
          </div>
        ) : (
          <div className="mq-now-empty">NOTHING PLAYING</div>
        )}
      </div>
      <div className="mq-up">
        <div className="mq-section-label">
          UP NEXT
          <span className="mq-count">
            {queue.length === 0
              ? "EMPTY"
              : `${queue.length} QUEUED${totalKnown > 0 ? ` · ${fmtDuration(totalKnown)}` : ""}`}
          </span>
        </div>
        {queue.length === 0 ? (
          <div className="mq-queue-empty">
            QUEUE EMPTY
            <span>&ldquo;Computer, play X next&rdquo; to add something.</span>
          </div>
        ) : (
          <div className="mq-rows">
            {shown.map((item, i) => (
              <Row key={`${item.videoId}-${i}`} item={item} position={i + 1} />
            ))}
            {overflow > 0 && <div className="mq-more">+{overflow} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}
