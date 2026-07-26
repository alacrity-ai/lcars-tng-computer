---
name: calendar
description: The family calendar — "show the calendar", "what's scheduled today / this week", "schedule X tomorrow at 2pm", "do I have any doctor's appointments coming up", moving or cancelling events.
---

# Family calendar

One `calendar` tool does everything. Dates are `YYYY-MM-DD`, times `HH:MM`
24-hour, **house-local**. The calendar is shared by the whole household —
"my" and "our" both mean the family calendar.

## Resolve relative dates YOURSELF, before calling

You know today's date from your environment. Do the date math explicitly and
pass concrete dates — the tool never interprets "tomorrow":

- "tomorrow at 2pm" → tomorrow's `YYYY-MM-DD`, `time: "14:00"`
- "next Tuesday" → the Tuesday of NEXT week (if today is Tuesday, that's +7)
- "the 11th of next month, same time" → next month's `-11`, reuse the prior
  event's time
- "this weekend" → the coming Saturday (and Sunday if they ask broadly)

When a spoken date is genuinely ambiguous ("Friday" said on a Friday), ask
one short question. Never silently guess a year: dates without one mean the
NEXT occurrence.

## Showing the calendar

`display {view, date?, wall?}` — events are fetched and composed
server-side; you never pass them. Panel choice:

| Request | Call |
|---|---|
| "Show the calendar", "family calendar" | `display {view: "month"}` |
| "Calendar for next month" | `display {view: "month", date: <any day in that month>}` |
| "What's scheduled today?" | `display {view: "day"}` — then SPEAK the day's events briefly |
| "What's on this week?" | `display {view: "week"}` — then speak the highlights |

Display before speak, as always. For "what's scheduled" questions the panel
is the detail and your voice is the summary — call `list` for the same range
if you need the events' contents to speak them.

## Creating events

`create {title, date, time?, endTime?, location?, category?, notes?, user}`

- `user` = the channel event's user — attribution matters.
- Title: short and concrete ("Dentist — ABC Medical"); put the address or
  clinic in `location`, not the title, when both are given.
- `category` (optional, set it when obvious): `medical | school | work |
  social | travel | birthday | family | chore | other`. It colors the panels
  and helps later searches — but don't interrogate the user for one.
- Confirm naturally: "Dentist appointment scheduled for Tuesday the
  twenty-eighth at two p-m." If a calendar panel is currently on screen,
  re-`display` it so the new event appears.

## Answering questions over events

"Do I have any doctor's appointments coming up?", "when is X?", "what's on
the 11th?" → `list` (defaults to today through +60 days; widen `to` for
"this year" style questions), then read the returned events and answer from
their **titles, locations, notes AND categories** — category is optional
metadata, so a dentist visit without `category: medical` must still be
found by its title. Speak dates naturally ("Tuesday the twenty-eighth"),
never ISO strings, never ids.

## Changing and cancelling

`update {id, ...}` / `remove {id}` — get the id from `list` first, matched
by title + date. "Move the dentist to 3pm" → update `time`. Cancelling more
than one event at once: confirm before removing.
