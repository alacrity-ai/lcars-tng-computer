import { useEffect, useState } from "react";
import type { Widget } from "@tng/shared";

/** 9:41 / 12:05:33 — hours appear only when needed. */
function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * Overlay badges stacked below the header at the content area's left edge —
 * timers and alarms that persist independently of the active panel. The
 * server owns the list; this just renders it, ticking the countdowns locally
 * from each widget's endsAt (no per-second network traffic).
 */
export function WidgetLayer({ widgets }: { widgets: Widget[] }) {
  const countdowns = widgets.some((w) => w.kind === "timer" || w.kind === "alarm");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!countdowns) return;
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [countdowns]);

  if (widgets.length === 0) return null;
  const now = Date.now();

  return (
    <div className="widget-layer">
      {widgets.map((w) => {
        if (w.kind === "queue") {
          return (
            <div key={w.id} className="widget-badge widget-queue">
              <span className="widget-label">Up Next</span>
              <span className="widget-queue-title">{w.nextTitle ?? "Queued video"}</span>
              {w.count > 1 && <span className="widget-sub">+{w.count - 1} queued</span>}
            </div>
          );
        }
        const ringing = w.state === "ringing";
        return (
          <div
            key={w.id}
            className={`widget-badge widget-${w.kind}${ringing ? " widget-ringing" : ""}`}
          >
            <span className="widget-label">
              {w.label ?? (w.kind === "alarm" ? "Alarm" : "Timer")}
            </span>
            <span className="widget-time">
              {w.kind === "alarm" ? fmtClock(w.endsAt) : fmtRemaining(w.endsAt - now)}
            </span>
            {/* alarms also show time-to-go small; a fired one shows neither */}
            {w.kind === "alarm" && !ringing && (
              <span className="widget-sub">{fmtRemaining(w.endsAt - now)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
