import type { ScheduleDayPanelProps } from "@tng/shared";
import { byDay, catClass, longTime, MONTHS, parseDay, WEEKDAYS, weekdayOf } from "./calendarUtil";

const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

export function ScheduleDayPanel({ date, events, today, title }: ScheduleDayPanelProps) {
  const p = parseDay(date);
  const heading =
    title ||
    (p
      ? `${date === today ? "TODAY · " : ""}${DAY_NAMES[weekdayOf(date)]} · ${MONTHS[p.m - 1]} ${p.d}`
      : "SCHEDULE");
  const dayEvents = byDay(events).get(date) ?? [];

  return (
    <div className="cal-panel">
      <div className="cal-title">{heading}</div>
      {dayEvents.length ? (
        <div className="day-list">
          {dayEvents.map((ev) => (
            <div key={ev.id} className={`day-row ${catClass(ev.category)}`}>
              <div className="day-time">
                {ev.time ? longTime(ev.time) : "ALL DAY"}
                {ev.time && ev.endTime ? <span className="day-time-end">– {longTime(ev.endTime)}</span> : null}
              </div>
              <div className="day-body">
                <div className="day-title">{ev.title}</div>
                {ev.location || ev.category ? (
                  <div className="day-meta">
                    {ev.location ?? ""}
                    {ev.location && ev.category ? " · " : ""}
                    {ev.category ?? ""}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="day-none">Nothing scheduled.</div>
      )}
      <div className="cal-foot">{WEEKDAYS[weekdayOf(date)]} · FAMILY CALENDAR</div>
    </div>
  );
}
