# Widgets — overlay badges, and how to add a new kind

A **widget** is screen state parallel to the panel: an overlay badge stacked
top-left (below the header, right of the sidebar) that survives panel changes
and idle-revert, disappearing only when it finishes or is cleared. First
resident: timers/alarms.

## Architecture

```
TimerEngine (server)  ──►  hub.broadcast({type:"widgets", widgets})  ──►  WidgetLayer (wall)
     owns lifecycle           full-state sync, stored in hub               dumb render
```

- **Full-state sync, not deltas.** Every mutation broadcasts the whole widget
  list (`WidgetsMessage`). Idempotent; late joiners get it in `hub.add()`;
  `hub.state.widgets` keeps `screen_state` truthful for the agent.
- **The server owns time.** The Claude session is idle between requests, so
  anything that must *happen later* (a timer firing) is scheduled server-side
  — see `apps/server/src/widgets.ts` (`TimerEngine`). On fire it uses the
  unprompted-announce path in `routes/console.ts`: bump `speechGeneration`,
  cancel any reading, chime, synthesize, broadcast speak.
- **The wall renders dumb.** `apps/web/src/components/WidgetLayer.tsx` ticks
  countdowns locally from `endsAt` — no per-second network traffic. CSS:
  `.widget-*` in `lcars.css`.
- **The model composes language.** Announcement text is passed in at
  `set_timer` time (`announce`); the server only falls back to a generic
  phrase. Intelligence stays in the session.

## Adding a new widget kind

1. **Shared** (`packages/shared/src/index.ts`): define `FooWidget` with an
   `id` plus its own fields; add it to the `Widget` union. Widgets section
   sits next to Chimes.
2. **Server**: extend `TimerEngine` or add an engine module owning the
   kind's lifecycle; broadcast via `hub.broadcast({type:"widgets", ...})`.
   Add REST routes in `routes/console.ts` following `/api/console/timer`.
3. **MCP** (`packages/console-mcp/src/index.ts`): add the tool(s). Write the
   description for the model-as-Computer: what user phrases map to it, what
   to confirm, what NOT to compute itself (e.g. wall-clock time).
4. **Wall**: render the new kind in `WidgetLayer.tsx` (discriminate on
   `kind`), style in `lcars.css`. Add any flashing class to the
   reduced-motion block.
5. **Skill**: runtime usage → `claude/.claude/skills/<name>/SKILL.md` + a row
   in `claude/CLAUDE.md`'s capability table. A widget without a skill will
   never be used (see adding-new-panels.md, same rule).

## Design rules

- Badges must stay badges: one line, label + value. Anything bigger is a
  panel, not a widget.
- Cap concurrent widgets (`MAX_WIDGETS` in widgets.ts, currently 8) — the
  stack overlays content.
- A widget that "finishes" should linger visibly (ringing/flash state), then
  remove itself; both the linger timer and explicit clears must cancel each
  other cleanly.
