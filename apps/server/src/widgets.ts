import { randomUUID } from "node:crypto";
import type { TimerWidget, TimerWidgetKind } from "@tng/shared";
import type { DisplayHub } from "./hub.js";

/** A fired widget flashes on the wall this long before removing itself. */
const RING_LINGER_MS = 60_000;
/** Widget-spam backstop; the stack is a wall overlay, not a task manager. */
const MAX_WIDGETS = 8;

/**
 * Server-side lifecycle for timer/alarm widgets. The server — not the Claude
 * session — must own firing: the session is idle between requests, but "alarm
 * at 2pm" has to ring at 2pm regardless. On fire the widget flips to
 * "ringing" (the wall flashes it), the announce callback chimes + speaks,
 * and after a linger the widget removes itself.
 *
 * All mutations push this engine's list into the hub's composed widget
 * broadcast (setWidgets), which also keeps hub.state.widgets — and thus
 * screen_state — truthful.
 */
export class TimerEngine {
  private widgets: TimerWidget[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Model-composed announcement per widget, spoken on fire. */
  private announcements = new Map<string, string>();
  /** TNGC-35: which viewscreen each widget's badge shows on. Announcements
      still sound on EVERY wall — an alarm's job is noise. */
  private walls = new Map<string, string>();
  /** Walls we've ever pushed to, so removals clear their lists too. */
  private touchedWalls = new Set<string>();

  constructor(
    private hub: DisplayHub,
    /** Unprompted speech path: chime `complete` + speak, superseding any
        in-flight utterance (an alarm outranks whatever is being said). */
    private announce: (text: string) => Promise<void>,
  ) {}

  private push() {
    for (const wall of this.touchedWalls) {
      this.hub.setWidgets(
        "timers",
        this.widgets.filter((w) => this.walls.get(w.id) === wall),
        wall,
      );
    }
  }

  set(kind: TimerWidgetKind, endsAt: number, label?: string, announceText?: string, wall?: string): TimerWidget {
    if (this.widgets.length >= MAX_WIDGETS) {
      throw new Error(`widget limit reached (${MAX_WIDGETS}) — clear one first`);
    }
    const widget: TimerWidget = {
      id: randomUUID().slice(0, 8),
      kind,
      label,
      endsAt,
      createdAt: Date.now(),
      state: "running",
    };
    const target = wall ?? this.hub.primary;
    this.walls.set(widget.id, target);
    this.touchedWalls.add(target);
    this.widgets.push(widget);
    if (announceText) this.announcements.set(widget.id, announceText);
    this.timers.set(
      widget.id,
      setTimeout(() => this.fire(widget.id), Math.max(0, endsAt - Date.now())),
    );
    this.push();
    return widget;
  }

  /** Clear one widget by id, or all of them. Returns how many were removed. */
  clear(id?: string): number {
    const targets = id ? this.widgets.filter((w) => w.id === id) : [...this.widgets];
    for (const w of targets) {
      const timer = this.timers.get(w.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(w.id);
      this.announcements.delete(w.id);
    }
    if (targets.length > 0) {
      const gone = new Set(targets.map((w) => w.id));
      this.widgets = this.widgets.filter((w) => !gone.has(w.id));
      this.push();
      for (const id of gone) this.walls.delete(id);
    }
    return targets.length;
  }

  list(): TimerWidget[] {
    return [...this.widgets];
  }

  private fire(id: string) {
    const widget = this.widgets.find((w) => w.id === id);
    if (!widget) return;
    widget.state = "ringing";
    this.push();

    const fallback =
      widget.kind === "alarm"
        ? widget.label
          ? `Alarm: ${widget.label}.`
          : "Alarm."
        : widget.label
          ? `${widget.label} timer complete.`
          : "Timer complete.";
    void this.announce(this.announcements.get(id) ?? fallback);
    this.announcements.delete(id);

    // Linger flashing, then self-remove (reuses the fire slot in `timers` so
    // an explicit clear during the linger cancels the removal cleanly too).
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.widgets = this.widgets.filter((w) => w.id !== id);
        this.push();
        this.walls.delete(id);
      }, RING_LINGER_MS),
    );
  }
}
