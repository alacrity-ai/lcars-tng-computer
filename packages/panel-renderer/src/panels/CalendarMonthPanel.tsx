import type { CalendarMonthPanelProps } from "@tng/shared";
import { byDay, catClass, daysInMonth, MONTHS, shortTime, WEEKDAYS } from "./calendarUtil";

/* A month cell shows at most this many chips; the rest collapse to "+N" —
   the wall is a glanceable surface, the day/week panels carry the detail. */
const MAX_CHIPS = 3;

export function CalendarMonthPanel({ year, month, events, today, title }: CalendarMonthPanelProps) {
  const y = Number.isInteger(year) ? year : new Date().getUTCFullYear();
  const m = Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1;
  const days = daysInMonth(y, m);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const map = byDay(events);

  const cells: Array<number | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const dateOf = (d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  return (
    <div className="cal-panel">
      <div className="cal-title">
        {title || `${MONTHS[m - 1]} ${y}`}
        <span className="cal-title-count">{(events ?? []).length ? `${(events ?? []).length} EVENTS` : ""}</span>
      </div>
      <div className="cal-grid-head">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-dow">
            {w}
          </div>
        ))}
      </div>
      <div className="cal-grid" style={{ gridTemplateRows: `repeat(${cells.length / 7}, 1fr)` }}>
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="cal-cell cal-cell-blank" />;
          const date = dateOf(d);
          const dayEvents = map.get(date) ?? [];
          const extra = dayEvents.length - MAX_CHIPS;
          return (
            <div key={i} className={`cal-cell${date === today ? " cal-cell-today" : ""}`}>
              <div className="cal-daynum">{d}</div>
              {dayEvents.slice(0, MAX_CHIPS).map((ev) => (
                <div key={ev.id} className={`cal-chip ${catClass(ev.category)}`}>
                  {ev.time ? <span className="cal-chip-time">{shortTime(ev.time)}</span> : null}
                  {ev.title}
                </div>
              ))}
              {extra > 0 ? <div className="cal-chip cal-chip-more">+{extra} more</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
