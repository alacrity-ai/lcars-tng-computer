#!/usr/bin/env node
/**
 * Console MCP server — the Computer's hands.
 * Thin stdio MCP wrapper over the @tng/server console REST API.
 * All intelligence stays in the Claude session; this just forwards.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_SERVER_PORT, PANEL_VIEWS } from "@tng/shared";

const BASE = process.env.TNG_SERVER_URL ?? `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

async function call(path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`server ${res.status}: ${text}`);
  return text;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "tng-console", version: "0.1.0" });

server.registerTool(
  "display",
  {
    description:
      "Render a panel on the LCARS display. Views: status (idle board), text {title?, body}, " +
      "alert {level: yellow|red, title?, message?}, blank, " +
      "weather {location, days: [{name, high, low?, conditions, precip?}], units?}, " +
      "youtube {videoId, title?, autoplay?, startSeconds?}, " +
      "results {query, results: [{title, url, snippet?}]} (numbered — user picks by number), " +
      "article {title, paragraphs, page?, url?, byline?, siteName?} (usually via open_url instead), " +
      "chart {title, kind: line|bar|pie, series: [{name?, points: [{label, value}]}], unit?, " +
      "xLabel?, yLabel?, source?} — line supports multiple series for comparison; bar/pie use " +
      "series[0], " +
      "map {lat, lng, zoom?, title?, markers?: [{lat, lng, label?}]} — LCARS-tinted world map; " +
      "zoom 0=world…18=street; add a labeled marker for point places, none for regions, " +
      "image {url, title?, caption?, body?, source?} — framed image; with body it becomes a " +
      "library record (blurb beside image). For wiki subjects prefer show_profile instead, " +
      "diagram {title?, svg, caption?} — compose complete inline SVG (viewBox required, the " +
      "wall scales it) for visual explanations the chart panel can't express: recursion " +
      "trees, flow diagrams, geometry, architectures. " +
      "Props are view-specific.",
    // Derived from the webapp's installed panels — never offer a view the wall
    // would render as a "not yet installed" stub.
    inputSchema: {
      view: z.enum(PANEL_VIEWS),
      props: z.record(z.unknown()).optional(),
    },
  },
  async ({ view, props }) => textResult(await call("/api/console/display", { view, props })),
);

server.registerTool(
  "open_url",
  {
    description:
      "Open a web page on the display in reader mode WITHOUT reading it aloud: the server " +
      "fetches the URL, extracts the article text, and shows it on the article panel. " +
      "Returns {title, page, pages, excerpt, pageText}. Call again with page: N to turn " +
      "pages ('computer, next page'). To read an article aloud, use read_article instead. " +
      "Fails on pages with no extractable article (apps, video sites, dashboards).",
    inputSchema: {
      url: z.string().url(),
      page: z.number().int().min(1).optional(),
    },
  },
  async ({ url, page }) => textResult(await call("/api/console/open-url", { url, page })),
);

server.registerTool(
  "read_article",
  {
    description:
      "Read an article aloud on the display, hands-free. ONE call does everything: the " +
      "server opens the URL, shows page 1, speaks it with karaoke highlighting, prefetches " +
      "the next page's audio while reading, and auto-turns pages until the article ends. " +
      "Returns immediately with {title, page, pages} — do NOT also call speak or open_url; " +
      "just confirm briefly to the user. Reading stops on: media stop ('stop reading'), any " +
      "speak (answering a question stops the reading), any display change, or open_url. " +
      "'Skip to page N' / 'start from page N' → call again with page: N.",
    inputSchema: {
      url: z.string().url(),
      page: z.number().int().min(1).optional(),
    },
  },
  async ({ url, page }) => textResult(await call("/api/console/read-article", { url, page })),
);

server.registerTool(
  "youtube_search",
  {
    description:
      "Search YouTube natively (server-side yt-dlp). ALWAYS use this — never WebSearch — " +
      "when looking for a video or music to play ('play X', songs, covers, mixes, any " +
      "video request): it queries YouTube's own engine and finds small-channel uploads " +
      "web search misses. Results are pre-filtered to embeddable videos, and if a played " +
      "video still fails on the wall the server automatically plays the next result — no " +
      "action needed from you. Returns {results: [{videoId, title, channel, " +
      "durationSeconds, viewCount, url}]}. Pick the best match and display the youtube " +
      "panel with its videoId; show the results panel instead when the choice is " +
      "genuinely ambiguous.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(10).optional(),
    },
  },
  async ({ query, limit }) =>
    textResult(await call("/api/console/youtube-search", { query, limit })),
);

server.registerTool(
  "queue",
  {
    description:
      "Manage the video play queue — the server starts the next entry the moment the " +
      "current video ends (or errors), no session involvement. QUEUE ONLY ON EXPLICIT " +
      "DEFERRAL: 'play X NEXT', 'AFTER this', 'ADD X to the queue'. A plain 'play X' " +
      "while something else is playing means play X NOW (display the youtube panel, " +
      "replacing it) — never queue it. To add: youtube_search first, pick the best " +
      "result, then action 'add' with its videoId + title (title shows on the wall when " +
      "it plays; pass channel/durationSeconds when known). If nothing is playing, add " +
      "starts it immediately (nowPlaying in the response — confirm as 'Playing', not " +
      "'Queued'). 'skip' / 'next video' → action 'skip' (409 when the queue is empty). " +
      "'clear the queue' → 'clear'. 'what's queued' → 'list' (also in screen_state). " +
      "Queue survives 'play X' — the new video plays now, the queue resumes after it. " +
      "Returns the queue in play order.",
    inputSchema: {
      action: z.enum(["add", "skip", "clear", "list"]),
      videoId: z.string().optional(),
      title: z.string().optional(),
      channel: z.string().optional(),
      durationSeconds: z.number().int().positive().optional(),
    },
  },
  async ({ action, videoId, title, channel, durationSeconds }) =>
    textResult(
      await call("/api/console/queue", { action, videoId, title, channel, durationSeconds }),
    ),
);

server.registerTool(
  "media",
  {
    description:
      "Control playback: pause or play (resume) the youtube panel, or stop — which also " +
      "halts any in-progress speech immediately. Use 'stop' when the user says 'stop', " +
      "'that's enough', 'be quiet', etc. while the Computer is reading or media is playing. " +
      "'speed' sets the video playback rate (rate required, 0.25–2; 1 = normal — 'faster' → " +
      "1.5, 'double speed' → 2, 'normal speed' → 1). The rate resets whenever a new video " +
      "or panel is displayed.",
    inputSchema: {
      action: z.enum(["pause", "play", "stop", "speed"]),
      rate: z.number().min(0.25).max(2).optional(),
    },
  },
  async ({ action, rate }) => textResult(await call("/api/console/media", { action, rate })),
);

server.registerTool(
  "show_profile",
  {
    description:
      "Library record in ONE call: looks up a subject on Wikipedia, displays its lead image " +
      "beside a summary blurb, and returns {title, extract, imageUrl, page}. Use for " +
      "'tell me about X' / 'who is X' / 'show me a picture of X' (any encyclopedic subject: " +
      "person, place, animal, artwork…). Speak a condensed version of the extract afterwards. " +
      "409 = ambiguous subject; retry more specifically ('Nero (emperor)'). For the FULL " +
      "article use read_article; for arbitrary non-wiki images use display view:image.",
    inputSchema: {
      subject: z.string().min(1),
    },
  },
  async ({ subject }) => textResult(await call("/api/console/show-profile", { subject })),
);

server.registerTool(
  "show_quote",
  {
    description:
      "Display a live price panel for a stock, ETF, index, forex pair, or cryptocurrency " +
      "(keyless Yahoo Finance data): big price, change, and a sparkline of the chosen range. " +
      "Use for 'price of X' / 'how is X doing' / 'show me X stock'. symbol takes a Yahoo " +
      "ticker (AAPL, MSFT, BTC-USD, ETH-USD, ^GSPC for S&P 500, EURUSD=X) — company names " +
      "auto-resolve, but prefer exact tickers when you know them. range defaults to daily; " +
      "'show me the weekly/monthly/yearly' while a quote is up → call again with that range. " +
      "Returns {price, change, changePercent} — speak a one-liner from those numbers.",
    inputSchema: {
      symbol: z.string().min(1),
      range: z.enum(["daily", "weekly", "monthly", "yearly"]).optional(),
    },
  },
  async ({ symbol, range }) => textResult(await call("/api/console/show-quote", { symbol, range })),
);

server.registerTool(
  "show_image",
  {
    description:
      "Find and display images (Wikipedia lead image → Wikimedia Commons → Openverse; no API " +
      "key). ONE query → full-frame image ('show me a red panda'). TWO OR MORE items → a " +
      "captioned mosaic grid, resolved in parallel — comparisons ('Willem Dafoe vs Brad " +
      "Pitt' → two items) and galleries ('various roses' → 4-6 items with distinct queries " +
      "like 'red rose closeup', 'white rose', 'climbing rose garden'). Named subjects get " +
      "their canonical wiki portrait automatically. For a single wiki subject with a blurb, " +
      "show_profile is still better. Returns missing[] for queries that found nothing. " +
      "title sets the panel headline; per-item caption labels each cell (defaults to the query).",
    inputSchema: {
      query: z.string().min(1).optional(),
      title: z.string().optional(),
      items: z
        .array(z.object({ query: z.string().min(1), caption: z.string().optional() }))
        .min(2)
        .max(9)
        .optional(),
    },
  },
  async ({ query, title, items }) =>
    textResult(await call("/api/console/show-image", { query, title, items })),
);

server.registerTool(
  "map_control",
  {
    description:
      "Steer the map currently on screen — smooth in-place animation, no redraw. " +
      "'zoom in/out' → zoom_in/zoom_out (amount = zoom steps, default 1; 'way in' ≈ 3). " +
      "'go/pan north|south|east|west' → that direction (amount = half-viewport steps). " +
      "'go to Damascus' → action goto with lat/lng (+ zoom to change altitude, + title to " +
      "retitle the headline) — the map FLIES there in a cinematic arc from wherever it is. " +
      "Fails with 409 if no map is displayed — then show one with display view:map first.",
    inputSchema: {
      action: z.enum(["zoom_in", "zoom_out", "north", "south", "east", "west", "goto"]),
      amount: z.number().positive().optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      zoom: z.number().min(0).max(18).optional(),
      title: z.string().optional(),
    },
  },
  async ({ action, amount, lat, lng, zoom, title }) =>
    textResult(await call("/api/console/map-control", { action, amount, lat, lng, zoom, title })),
);

server.registerTool(
  "speak",
  {
    description:
      "Speak text aloud through the display's speakers in the Computer's voice. " +
      "Returns when playback completes. Keep utterances short and in-character. " +
      "Set caption: false when reading text that is already visible on the display " +
      "(e.g. an article) so the spoken words are not overlaid on top of the panel.",
    inputSchema: {
      text: z.string().min(1),
      waitForPlayback: z.boolean().optional(),
      caption: z.boolean().optional(),
    },
  },
  async ({ text, waitForPlayback, caption }) =>
    textResult(await call("/api/console/speak", { text, waitForPlayback, caption })),
);

server.registerTool(
  "set_timer",
  {
    description:
      "Spawn a timer or alarm WIDGET — an overlay badge stacked top-left on the wall, " +
      "independent of whatever panel is showing. It persists across panel changes and the " +
      "server fires it on time even while this session is idle: chime + spoken announcement, " +
      "then the badge flashes for a minute and removes itself. kind 'timer' counts down " +
      "('set a timer for 10 minutes' → seconds: 600); kind 'alarm' fires at a wall-clock " +
      "time ('set an alarm for 2pm' → time: '14:00', 24-hour, server-local — the server " +
      "picks today or tomorrow automatically; NEVER compute seconds yourself for an alarm, " +
      "you don't know the current time). label = short badge text ('TEA'). announce = the " +
      "natural sentence spoken at fire time ('Your tea is ready.' / 'It is two PM.') — " +
      "compose one; the fallback is generic. Returns {id, fires, in} — confirm briefly from " +
      "those ('Timer set: ten minutes.'). Widgets show in screen_state with their ids.",
    inputSchema: {
      kind: z.enum(["timer", "alarm"]),
      seconds: z.number().int().positive().optional(),
      time: z
        .string()
        .regex(/^\d{1,2}:\d{2}$/)
        .optional(),
      label: z.string().max(24).optional(),
      announce: z.string().optional(),
    },
  },
  async ({ kind, seconds, time, label, announce }) =>
    textResult(await call("/api/console/timer", { kind, seconds, time, label, announce })),
);

server.registerTool(
  "clear_timer",
  {
    description:
      "Remove timer/alarm widgets from the wall ('clear my alarm', 'cancel the timer'). " +
      "Omit id to clear ALL of them — right for 'clear my alarm' when only one is up. " +
      "With several active, check screen_state for widget ids and clear the one meant. " +
      "Also how to silence a fired alarm still flashing. Returns {cleared: n}.",
    inputSchema: {
      id: z.string().optional(),
    },
  },
  async ({ id }) => textResult(await call("/api/console/timer-clear", { id })),
);

server.registerTool(
  "chime",
  {
    description: "Play an earcon: acknowledge | complete | error | red-alert.",
    inputSchema: {
      name: z.enum(["acknowledge", "complete", "error", "red-alert"]),
    },
  },
  async ({ name }) => textResult(await call("/api/console/chime", { name })),
);

server.registerTool(
  "screen_state",
  {
    description:
      "What is currently on the LCARS display (view, props, connected display count). " +
      "For articles, props are summarized to {page, pages, pageText} — the current page's " +
      "text only, never the whole article.",
    inputSchema: {},
  },
  async () => textResult(await call("/api/console/screen")),
);

await server.connect(new StdioServerTransport());
