/**
 * The canonical LCARS renderer (TNGC-37). The wall and the tricorder
 * viewscreen stage both import from here — a panel exists exactly once, so
 * "renders on the wall" and "renders on the phone" can never drift apart.
 * Styling ships alongside as `@tng/panel-renderer/lcars.css`.
 */
export { Panel } from "./panels/registry";
export { LcarsFrame } from "./components/LcarsFrame";
export { WidgetLayer } from "./components/WidgetLayer";
export { DataCascade } from "./components/DataCascade";
export { prefersReducedMotion } from "./motion";
