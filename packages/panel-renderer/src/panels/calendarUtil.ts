/**
 * Date helpers for the calendar panels (TNGC-46). Everything works on the
 * wall-clock strings the props carry (YYYY-MM-DD / HH:MM) — no Date-object
 * timezone semantics can leak in because days are pure string math over UTC
 * timestamps used as a day-grid, never rendered as local times.
 */
import type { CalendarEvent } from "@tng/shared";

export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
export const MONTHS = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
];

export function parseDay(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** YYYY-MM-DD for a UTC day-grid timestamp. */
export function dayString(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function dayTs(s: string): number | null {
  const p = parseDay(s);
  return p ? Date.UTC(p.y, p.m - 1, p.d) : null;
}

export function addDays(s: string, n: number): string {
  const ts = dayTs(s);
  return ts === null ? s : dayString(ts + n * 86_400_000);
}

/** 0 = Sunday, matching WEEKDAYS. */
export function weekdayOf(s: string): number {
  const ts = dayTs(s);
  return ts === null ? 0 : new Date(ts).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "14:05" → "2:05p"; "09:00" → "9a" (chip-compact). */
export function shortTime(t: string | null | undefined): string {
  const m = /^(\d{2}):(\d{2})$/.exec(t ?? "");
  if (!m) return "";
  const h24 = Number(m[1]);
  const min = m[2];
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? "a" : "p";
  return min === "00" ? `${h}${suffix}` : `${h}:${min}${suffix}`;
}

/** "14:05" → "2:05 PM" (agenda rows). */
export function longTime(t: string | null | undefined): string {
  const m = /^(\d{2}):(\d{2})$/.exec(t ?? "");
  if (!m) return "";
  const h24 = Number(m[1]);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${m[2]} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Events keyed by date, each day's list time-ordered (all-day first). */
export function byDay(events: CalendarEvent[] | undefined): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events ?? []) {
    if (!ev || typeof ev.date !== "string") continue;
    const list = map.get(ev.date) ?? [];
    list.push(ev);
    map.set(ev.date, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.title.localeCompare(b.title));
  }
  return map;
}

/** CSS accent class for a category ("" for none/unknown). */
export function catClass(category: string | null | undefined): string {
  return category && /^[a-z]+$/.test(category) ? `cal-cat-${category}` : "";
}
