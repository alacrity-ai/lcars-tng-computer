import type { ScheduleWeekPanelProps } from "@tng/shared";
import { addDays, byDay, catClass, MONTHS, parseDay, shortTime, WEEKDAYS, weekdayOf } from "./calendarUtil";

function headline(start: string): string {
  const a = parseDay(start);
  const b = parseDay(addDays(start, 6));
  if (!a || !b) return "THIS WEEK";
  const from = `${MONTHS[a.m - 1].slice(0, 3)} ${a.d}`;
  const to = a.m === b.m ? `${b.d}` : `${MONTHS[b.m - 1].slice(0, 3)} ${b.d}`;
  return `WEEK OF ${from} – ${to}`;
}

export function ScheduleWeekPanel({ start, events, today, title }: ScheduleWeekPanelProps) {
  const origin = parseDay(start) ? start : (today ?? "1970-01-01");
  const map = byDay(events);
  const days = Array.from({ length: 7 }, (_, i) => addDays(origin, i));

  return (
    <div className="cal-panel">
      <div className="cal-title">{title || headline(origin)}</div>
      <div className="week-grid">
        {days.map((date) => {
          const p = parseDay(date);
          const dayEvents = map.get(date) ?? [];
          return (
            <div key={date} className={`week-col${date === today ? " week-col-today" : ""}`}>
              <div className="week-col-head">
                <span className="week-dow">{WEEKDAYS[weekdayOf(date)]}</span>
                <span className="week-date">{p ? p.d : ""}</span>
              </div>
              <div className="week-col-body">
                {dayEvents.map((ev) => (
                  <div key={ev.id} className={`week-event ${catClass(ev.category)}`}>
                    <span className="week-event-time">{ev.time ? shortTime(ev.time) : "all day"}</span>
                    <span className="week-event-title">{ev.title}</span>
                  </div>
                ))}
                {!dayEvents.length ? <div className="week-empty">—</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
