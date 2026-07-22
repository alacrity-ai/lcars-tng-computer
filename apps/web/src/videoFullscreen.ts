/** Whether the youtube panel is in full-bleed ("full screen") mode.
 *
 * Module-scoped rather than React state so the flag survives a panel remount:
 * a queue advance replaces the videoId — and may replace the component
 * instance, depending on how the panel tree is keyed — but the wall must stay
 * full screen. useSocket owns the transitions (media fullscreen/windowed sets
 * it, displaying any non-youtube panel clears it); YouTubePanel reads it at
 * mount and follows tng-media events from there.
 */
export const videoFullscreen = { value: false };
