import type { TimelinePanelProps } from "@tng/shared";

/* Card accent colors, cycled — LCARS blocks are never all one hue. */
const ACCENTS = ["accent-gold", "accent-lavender", "accent-blue", "accent-peach"];

export function TimelinePanel({ title, events, caption }: TimelinePanelProps) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    return <div className="timeline-panel-empty">No events to display.</div>;
  }

  return (
    <div className="timeline-panel">
      {title && <div className="timeline-title">{title}</div>}
      <div
        className="timeline-band"
        style={{ gridTemplateColumns: `repeat(${list.length}, 1fr)` }}
      >
        {list.map((event, i) => (
          <div
            key={i}
            className={`timeline-card ${i % 2 === 0 ? "above" : "below"} ${ACCENTS[i % ACCENTS.length]}`}
            style={{ gridColumn: i + 1, gridRow: i % 2 === 0 ? 1 : 3 }}
          >
            <div className="timeline-when">{event.when}</div>
            <div className="timeline-event-title">{event.title}</div>
            {event.detail && <div className="timeline-detail">{event.detail}</div>}
          </div>
        ))}
        {list.map((_, i) => (
          <div
            key={`node-${i}`}
            className={`timeline-node${i === 0 ? " first" : ""}${i === list.length - 1 ? " last" : ""}`}
            style={{ gridColumn: i + 1, gridRow: 2 }}
          >
            <span className="timeline-dot" />
          </div>
        ))}
      </div>
      {caption && <div className="timeline-caption">{caption}</div>}
    </div>
  );
}
