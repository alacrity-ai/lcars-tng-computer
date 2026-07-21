/**
 * The wire protocol between the API server and the LCARS webapp, and the
 * REST shapes the console MCP server posts to the API server.
 *
 * Server → webapp messages ride the WebSocket; the webapp answers with
 * ClientMessage. Every panel the webapp can render is a PanelView; its props
 * are typed here so Claude-side tools, server, and webapp agree.
 */

// ---------- Panels ----------

/**
 * The panels that actually exist in the webapp registry — the single source of
 * truth for what `display` will accept. The webapp's REGISTRY is typed as a
 * total Record over this union, so adding a name here without building the
 * component is a compile error, and the MCP tool derives its enum from it.
 * Grow this list only when the panel lands.
 *
 * Roadmap panels (now-playing, calendar, web) are deliberately absent:
 * advertising them let `display` succeed while the wall showed a stub.
 */
export const PANEL_VIEWS = [
  "boot",
  "status",
  "text",
  "alert",
  "blank",
  "weather",
  "youtube",
  "results",
  "article",
  "news",
  "chart",
  "map",
  "image",
  "quote",
] as const;

export type PanelView = (typeof PANEL_VIEWS)[number];

export interface TextPanelProps {
  title?: string;
  body: string; // markdown-ish plain text; webapp renders line breaks
  /** Character index to highlight during karaoke mode (0-based). */
  highlightIndex?: number;
}

export interface AlertPanelProps {
  level: "yellow" | "red";
  title?: string;
  message?: string;
}

export interface StatusPanelProps {
  /** Optional lines to show on the idle board; webapp fills defaults. */
  lines?: string[];
  /** Injected by the wall itself (from the harness working indicator), never
      sent by the agent: swaps the idle lines for a processing readout. */
  working?: boolean;
}

export interface WeatherDay {
  /** Day label as spoken/read: "Today", "Tuesday". */
  name: string;
  high: number;
  low?: number;
  /** Short human phrase: "Showers and thunderstorms". */
  conditions: string;
  /** Percent, 0–100. Drives the precipitation bar. */
  precip?: number;
}

export interface WeatherPanelProps {
  location: string;
  days: WeatherDay[];
  /** Degree suffix on the display; defaults to F. */
  units?: "F" | "C";
}

export interface YouTubePanelProps {
  videoId: string;
  /** Shown above the frame; also the iframe title. */
  title?: string;
  /** Defaults to true — the kiosk launches Chrome with autoplay allowed. */
  autoplay?: boolean;
  startSeconds?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface ResultsPanelProps {
  query: string;
  /** Rendered numbered so the user can say "open the third one". */
  results: SearchResult[];
}

export interface ArticlePanelProps {
  title: string;
  url?: string;
  byline?: string;
  siteName?: string;
  /** Extracted body text, one entry per paragraph. */
  paragraphs: string[];
  /** 1-based page to show; the panel clamps out-of-range values. */
  page?: number;
  /** Character index to highlight during karaoke mode (0-based). */
  highlightIndex?: number;
}

export interface NewsHeadline {
  /** Headline title. */
  title: string;
  /** News source: "BBC News", "Reuters", etc. */
  source: string;
  /** Brief summary, one or two sentences. */
  summary?: string;
  /** URL to the full article. */
  url?: string;
  /** ISO 8601 timestamp or human-readable "2 hours ago" style. */
  time?: string;
}

export interface NewsPanelProps {
  /** Typically "Breaking News", "Top Headlines", "Technology" — shows at the top. */
  title?: string;
  /** Numbered 1-based; user can say "open the third one" to drill into article. */
  headlines: NewsHeadline[];
}

export interface ChartPoint {
  /** Category / x-axis label: "1925", "Q3", "Housing". */
  label: string;
  value: number;
}

export interface ChartSeries {
  /** Series name — shown in the legend when there are multiple series. */
  name?: string;
  points: ChartPoint[];
}

export interface ChartPanelProps {
  title: string;
  kind: "line" | "bar" | "pie";
  /** line: one or more series (comparisons). bar/pie: series[0] only. */
  series: ChartSeries[];
  /** Value unit — "$"/"€"/"£" render as prefixes, anything else as suffix. */
  unit?: string;
  xLabel?: string;
  yLabel?: string;
  /** Small attribution line under the chart, e.g. "Source: BLS CPI data". */
  source?: string;
}

export interface ImageItem {
  url: string;
  /** Cell label in a mosaic: "Empire State Building". */
  caption?: string;
  /** Attribution: "Wikipedia", "Wikimedia Commons". */
  source?: string;
}

export interface ImagePanelProps {
  /** Single image URL (any host the wall can reach; Wikimedia works well). */
  url?: string;
  /** 2+ entries render as a mosaic grid instead — comparisons, galleries. */
  images?: ImageItem[];
  title?: string;
  /** Single-image only: short line under the image. */
  caption?: string;
  /** Single-image only: blurb beside the image ("library record" layout).
      Without it the image goes full-bleed. */
  body?: string;
  /** Single-image only: attribution line. */
  source?: string;
}

export type QuoteRange = "daily" | "weekly" | "monthly" | "yearly";

export interface QuotePoint {
  /** Epoch ms. */
  t: number;
  v: number;
}

export interface QuotePanelProps {
  symbol: string;
  /** "Apple Inc.", "Bitcoin USD". */
  name?: string;
  price: number;
  /** ISO code: "USD". */
  currency?: string;
  /** Absolute + percent change over the shown range (vs previous close for daily). */
  change: number;
  changePercent: number;
  range: QuoteRange;
  points: QuotePoint[];
  exchange?: string;
  /** Epoch ms of the latest quote. */
  asOf?: number;
}

export interface MapMarker {
  lat: number;
  lng: number;
  /** Short label pinned above the marker: "Burj Khalifa". */
  label?: string;
}

export interface MapPanelProps {
  /** Center of the view. */
  lat: number;
  lng: number;
  /** Leaflet zoom: 0 = world … 18 = street. Scale guide lives in the maps skill
      (claude/.claude/skills/maps/SKILL.md). */
  zoom?: number;
  /** Headline above the map: "The Mediterranean Sea". */
  title?: string;
  /** Point markers (LCARS gold rings). Regions usually need none. */
  markers?: MapMarker[];
}

/**
 * Split article paragraphs into wall-sized pages. Lives in shared because the
 * server reports "page N of M" from the same math the webapp renders with —
 * if these disagreed, the spoken page count would lie.
 *
 * Deliberately conservative: this is a character-count estimate of rendered
 * height, and a page that overflows the wall gets its last line clipped AND
 * read aloud while invisible. Undershooting costs a few extra page turns;
 * overshooting hides text.
 */
export const ARTICLE_PAGE_CHAR_BUDGET = 950;

function splitLongParagraph(p: string, budget: number): string[] {
  if (p.length <= budget) return [p];
  const out: string[] = [];
  let rest = p;
  while (rest.length > budget) {
    // Prefer a sentence boundary; fall back to any space; worst case hard-cut.
    let cut = rest.lastIndexOf(". ", budget);
    if (cut < budget * 0.5) cut = rest.lastIndexOf(" ", budget);
    if (cut <= 0) cut = budget;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function paginateArticle(
  paragraphs: string[],
  budget = ARTICLE_PAGE_CHAR_BUDGET,
): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const raw of paragraphs) {
    for (const p of splitLongParagraph(raw, budget)) {
      const cost = p.length + 80; // + inter-paragraph gap
      if (used > 0 && used + cost > budget) {
        pages.push(current);
        current = [];
        used = 0;
      }
      current.push(p);
      used += cost;
    }
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [[]];
}

/** Not yet registered — kept for the music phase. See PANEL_VIEWS. */
export interface NowPlayingPanelProps {
  track: string;
  artist: string;
  album?: string;
  artUrl?: string;
  positionMs?: number;
  durationMs?: number;
  playing?: boolean;
}

/** Panels not yet built take free-form props. */
export type PanelProps = Record<string, unknown>;

/** Per-character speech timing for karaoke highlighting. */
export interface CharTiming {
  char: number;
  duration_ms: number;
}

// ---------- Chimes ----------

export type ChimeName = "acknowledge" | "complete" | "error" | "red-alert";

// ---------- Widgets ----------
// Widgets are overlay badges stacked top-left on the wall, independent of the
// active panel: they survive panel changes and idle-revert, and disappear only
// when they finish or are cleared. The server owns their lifecycle (a timer
// must fire even while the Claude session is idle between requests).

/** timer = countdown from now; alarm = fires at a wall-clock time. */
export type TimerWidgetKind = "timer" | "alarm";

/** running = counting down; ringing = fired, lingering on screen briefly. */
export type TimerWidgetState = "running" | "ringing";

export interface TimerWidget {
  id: string;
  kind: TimerWidgetKind;
  /** Badge label: "TEA", "ALARM". Wall falls back to the kind name. */
  label?: string;
  /** Epoch ms when it fires — the wall computes remaining time locally. */
  endsAt: number;
  /** Epoch ms when created. */
  createdAt: number;
  state: TimerWidgetState;
}

/** Up-next badge for the YouTube play queue — present iff the queue is
    non-empty. Singleton (id "queue"); the server rebuilds it on every queue
    mutation, including automatic advancement. */
export interface QueueWidget {
  id: string;
  kind: "queue";
  /** Videos waiting (excludes the one playing). */
  count: number;
  /** Title of the next video to play. */
  nextTitle?: string;
}

/** Union grows as new widget kinds land (weather badge, now-playing, …). */
export type Widget = TimerWidget | QueueWidget;

// ---------- Server → webapp ----------

export interface DisplayMessage {
  type: "display";
  view: PanelView;
  props: PanelProps;
}

export interface SpeakMessage {
  type: "speak";
  utteranceId: string;
  text: string;
  /** URL the webapp streams/plays; absent while TTS is offline (webapp shows caption only). */
  audioUrl?: string;
  /** false = don't overlay the spoken text on screen (used when reading content
      that is already displayed, e.g. an article); voice bars still show. */
  caption?: boolean;
  /** When present and caption is false, the webapp animates the current panel's
      highlightIndex locally in sync with playback — no per-character round trips. */
  timing?: CharTiming[];
  /** Added to every timing char index before highlighting. Lets one page be
      spoken as several consecutive utterances (fast-start first sentence, then
      the rest) while highlight positions stay page-relative. */
  highlightBase?: number;
}

export interface ChimeMessage {
  type: "chime";
  name: ChimeName;
}

/** Playback control: youtube panel ("computer, pause") and speech ("stop"). */
export type MediaAction = "pause" | "play" | "stop";

export interface MediaMessage {
  type: "media";
  action: MediaAction;
}

/** Voice nudges for the live map panel ("zoom in", "go west", "go to
    Damascus"). Animates the existing Leaflet view in place — no panel
    re-creation, no tile flash; goto flies a cinematic arc. */
export type MapControlAction =
  | "zoom_in"
  | "zoom_out"
  | "north"
  | "south"
  | "east"
  | "west"
  | "goto";

export interface MapControlMessage {
  type: "map_control";
  action: MapControlAction;
  /** Zoom: steps (default 1). Pan: viewport-halves to travel (default 1). */
  amount?: number;
  /** goto only: destination (lat/lng required, zoom defaults to current). */
  lat?: number;
  lng?: number;
  zoom?: number;
  /** goto only: replaces the panel headline ("Damascus"). */
  title?: string;
}

/** Instant "request heard" indicator, fired by a Claude Code hook the moment
    the user submits a prompt — before any model thinking. The wall shows a
    non-destructive PROCESSING badge and clears it on real activity. */
export interface WorkingMessage {
  type: "working";
  active: boolean;
}

/** Full-state widget sync: replaces the wall's widget list wholesale.
    Idempotent and order-preserving — no add/remove deltas to get wrong. */
export interface WidgetsMessage {
  type: "widgets";
  widgets: Widget[];
}

export type ServerMessage =
  | DisplayMessage
  | SpeakMessage
  | ChimeMessage
  | MediaMessage
  | MapControlMessage
  | WorkingMessage
  | WidgetsMessage;

// ---------- Webapp → server ----------

export interface HelloMessage {
  type: "hello";
  role: "display";
}

export interface SpeakDoneMessage {
  type: "speak_done";
  utteranceId: string;
}

export interface ScreenStateMessage {
  type: "screen_state";
  view: PanelView;
  props: PanelProps;
}

/** The wall's YouTube player failed (101/150 = embedding disabled, 100 = not
    found). The server auto-advances to the next viable search result. */
export interface VideoErrorMessage {
  type: "video_error";
  videoId: string;
  code?: number;
}

/** The wall's YouTube player reached the natural end of its video
    (onStateChange → ENDED). The server starts the next queued video, if any. */
export interface VideoEndedMessage {
  type: "video_ended";
  videoId: string;
}

export type ClientMessage =
  | HelloMessage
  | SpeakDoneMessage
  | ScreenStateMessage
  | VideoErrorMessage
  | VideoEndedMessage;

// ---------- Console REST API (MCP server → API server) ----------

export interface DisplayRequest {
  view: PanelView;
  props?: PanelProps;
}

export interface SpeakRequest {
  text: string;
  /** Wait for playback to finish before the HTTP call returns (default true). */
  waitForPlayback?: boolean;
  /** false = suppress the on-screen caption overlay (default true). Use when
      reading text that is already visible on the display. */
  caption?: boolean;
}

export interface ChimeRequest {
  name: ChimeName;
}

export interface MediaRequest {
  action: MediaAction;
}

export interface MapControlRequest {
  action: MapControlAction;
  amount?: number;
  lat?: number;
  lng?: number;
  zoom?: number;
  title?: string;
}

/** Fired by harness hooks (UserPromptSubmit / Stop), not by the model. */
export interface WorkingRequest {
  /** true = show the PROCESSING indicator (default); false = clear it. */
  active?: boolean;
  /** Play the acknowledge earcon alongside (default true when activating). */
  chime?: boolean;
}

export interface ScreenStateResponse {
  view: PanelView;
  props: PanelProps;
  connectedDisplays: number;
  /** Active overlay widgets (timers, alarms) — includes each widget's id for clear_timer. */
  widgets: Widget[];
  /** Videos waiting to play after the current one ends, in play order. */
  queue: QueueItem[];
}

/** set_timer: create a countdown or wall-clock alarm widget. */
export interface SetTimerRequest {
  kind: TimerWidgetKind;
  /** Countdown length. Give this OR time. */
  seconds?: number;
  /** Wall-clock fire time, "HH:MM" 24-hour, server-local. The server picks
      today if that's still in the future, otherwise tomorrow. */
  time?: string;
  /** Short badge label: "TEA". */
  label?: string;
  /** Natural sentence the server speaks when it fires ("Your tea is ready.").
      Falls back to a generic announcement. */
  announce?: string;
}

export interface SetTimerResponse {
  ok: true;
  id: string;
  endsAt: number;
  /** Human-readable fire time: "2:00 PM". */
  fires: string;
  /** Human-readable delta: "in 10 minutes". */
  in: string;
}

/** clear_timer: no id clears every timer/alarm widget. */
export interface ClearTimerRequest {
  id?: string;
}

// ---------- YouTube queue ----------
// Server-owned play queue: when the wall reports a video ended (or the user
// says "skip"), the server plays the next entry — the session can be idle.

export interface QueueItem {
  videoId: string;
  title?: string;
  channel?: string;
  durationSeconds?: number;
}

export interface QueueRequest {
  action: "add" | "skip" | "clear" | "list";
  /** add only. */
  videoId?: string;
  title?: string;
  channel?: string;
  durationSeconds?: number;
}

export interface QueueResponse {
  ok: true;
  /** Queue AFTER the action, in play order. */
  queue: QueueItem[];
  /** skip: what just started playing. */
  nowPlaying?: QueueItem;
}

/** read_article: one call starts a server-driven reading session — display,
    synthesize, play, prefetch the next page, auto-advance until the end. */
export interface ReadArticleRequest {
  url: string;
  /** 1-based page to start reading from (default 1). */
  page?: number;
}

export interface ReadArticleResponse {
  ok: true;
  url: string;
  title: string;
  /** Page the session started reading from. */
  page: number;
  pages: number;
}

/** open_url: server fetches the page, extracts the article, displays it. */
export interface OpenUrlRequest {
  url: string;
  /** 1-based page of an already-opened article (served from cache). */
  page?: number;
}

export interface OpenUrlResponse {
  ok: true;
  url: string;
  title: string;
  byline?: string;
  siteName?: string;
  page: number;
  pages: number;
  /** First ~500 chars of body text so the Computer can speak about the page. */
  excerpt: string;
  /** Full text of the CURRENT page (paragraphs joined with single spaces) —
      exactly what karaoke highlighting indexes against. Speak this to read
      the page aloud. */
  pageText: string;
}

/** youtube_search: native YouTube search on the server via yt-dlp. */
export interface YoutubeSearchRequest {
  query: string;
  /** Max results to return (default 6, max 10). */
  limit?: number;
}

export interface YoutubeSearchResult {
  videoId: string;
  title: string;
  channel?: string;
  /** Length in seconds; absent for livestreams. */
  durationSeconds?: number;
  viewCount?: number;
  url: string;
}

export interface YoutubeSearchResponse {
  ok: true;
  query: string;
  results: YoutubeSearchResult[];
}

export const DEFAULT_SERVER_PORT = 3789;
export const WS_PATH = "/ws";
