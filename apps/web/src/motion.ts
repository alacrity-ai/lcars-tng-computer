/** Ambient-motion guard: JS-driven animation timers respect the same
    preference the CSS `prefers-reduced-motion` block does. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
