#!/usr/bin/env node
/**
 * Console MCP server — the Computer's hands.
 * Thin stdio MCP wrapper over the @tng/server console REST API.
 * All intelligence stays in the Claude session; this just forwards.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_SERVER_PORT, PANEL_VIEWS } from "@tng/shared";

const BASE = process.env.TNG_SERVER_URL ?? `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

// Prebuilt diagram SVGs live beside the diagrams skill (authored session-side).
// The MCP — the Computer's hands, in the same fence — reads them so a big,
// deterministic diagram renders WITHOUT its ~30k characters ever transiting the
// model's context. Override the location with TNG_DIAGRAM_ASSETS_DIR.
const DIAGRAM_ASSETS_DIR =
  process.env.TNG_DIAGRAM_ASSETS_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../claude/.claude/skills/diagrams/assets");

/** Load a prebuilt diagram by slug. The slug is restricted to a safe kebab
    charset so it can never escape the assets dir (no `/`, `.`, `..`). Throws a
    user-legible error the display handler surfaces to the model. */
async function loadDiagramAsset(slug: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`invalid svgAsset "${slug}" — use a kebab-case slug like "periodic-table"`);
  }
  const path = join(DIAGRAM_ASSETS_DIR, `${slug}.svg`);
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`no prebuilt diagram "${slug}" (looked in ${DIAGRAM_ASSETS_DIR})`);
  }
}

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
      "night-sky {lat, lng, title?, time?, azimuth?, altitude?, fov?, constellations?, labels?, " +
      "planets?} — live planetarium computed on the wall (stars, constellations, Moon phase, " +
      "planets) for the observer at lat/lng; defaults to the whole-sky dome at the present " +
      "moment; steer it afterwards with sky_control, never by re-displaying, " +
      "image {url, title?, caption?, body?, source?} — framed image; with body it becomes a " +
      "library record (blurb beside image). For wiki subjects prefer show_profile instead, " +
      "diagram {title?, svg | svgAsset, caption?} — compose complete inline SVG (viewBox " +
      "required, the wall scales it) for visual explanations the chart panel can't express: " +
      "recursion trees, flow diagrams, geometry, architectures. For a PREBUILT diagram pass " +
      "svgAsset: '<slug>' (e.g. 'periodic-table') INSTEAD of svg — the server-side hands read " +
      "the saved SVG so its bytes never pass through you; never read the .svg file and inline " +
      "it yourself, " +
      "quiz {subject, questionNumber, question, choices: [string], score?: {correct, answered}, " +
      "selectedIndex?, correctIndex?, explanation?} — one multiple-choice question; redisplay " +
      "with correctIndex (+ selectedIndex) to reveal the answer (explanation shown when missed), " +
      "code {title?, code?, language?, caption?, panes?: [{title?, code, language?, caption?}]} — " +
      "monospace source with syntax highlighting and line numbers; use instead of text whenever " +
      "the body is code (language: python, javascript, bash, sql… defaults to a generic C-like " +
      "highlighter). panes renders 2–3 sources side-by-side (same algorithm in different " +
      "languages); pass either code or panes, " +
      "table {title?, columns: [string], rows: [[string]], alignRight?: [colIdx], " +
      "highlightRows?: [rowIdx], caption?} — structured rows/columns (comparisons, standings, " +
      "specs); pre-format numbers, right-align numeric columns, " +
      "steps {title?, subtitle?, steps: [{text, detail?}], currentStep?, caption?} — ordered " +
      "procedure (recipes, repairs); omit currentStep for an overview, set it (0-based) to blow " +
      "up that step large; re-display with currentStep±1 on 'next step', " +
      "timeline {title?, events: [{when, title, detail?}], caption?} — horizontal era band, " +
      "4–8 chronological events (history, biographies), " +
      "scoreboard {title?, games: [{away: {name, abbrev?, score?, record?}, home: {…}, status, " +
      "live?, note?}], caption?} — game scores; one game = hero card, several = grid; winner " +
      "bolds itself, live pulses the status chip, " +
      "math {title?, lines: [{latex, note?}], caption?} — KaTeX-rendered formulas or a worked " +
      "derivation, one line per step with notes explaining each move. " +
      "Props are view-specific.",
    // Derived from the webapp's installed panels — never offer a view the wall
    // would render as a "not yet installed" stub.
    inputSchema: {
      view: z.enum(PANEL_VIEWS),
      props: z.record(z.unknown()).optional(),
    },
  },
  async ({ view, props }) => {
    // Resolve a prebuilt diagram reference to its SVG here, in the hands, so
    // the markup is never something the model had to carry. svgAsset is a
    // convenience the wall never sees — it only ever receives `svg`.
    let resolved = props;
    if (view === "diagram" && props && typeof props.svgAsset === "string") {
      const { svgAsset, ...rest } = props;
      const svg = await loadDiagramAsset(svgAsset); // throws → surfaced to the model
      resolved = { ...rest, svg };
    }
    return textResult(await call("/api/console/display", { view, props: resolved }));
  },
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
      "or panel is displayed. 'fullscreen' expands the video to fill the entire wall; " +
      "'windowed' returns it to the framed panel.",
    inputSchema: {
      action: z.enum(["pause", "play", "stop", "speed", "fullscreen", "windowed"]),
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
  "sky_control",
  {
    description:
      "Steer the night-sky panel currently on screen — smooth in-place animation, no redraw. " +
      "SPACE: 'zoom in/out' → zoom_in/zoom_out (amount = steps); pan left|right|up|down " +
      "(amount = half-view steps); 'show me Mars' / 'go to Orion' → goto with target " +
      "(planet, Sun, Moon, bright star, or constellation name — resolved on the wall), or " +
      "explicit ra/dec, or az/alt for a compass direction ('look east' → az: 90, alt: 25); " +
      "fov changes the field of view (10–180, 180 = whole-sky dome); title retitles. " +
      "TIME: set_time {time: ISO} jumps to a moment (omit time = return to the present); " +
      "advance_time {hours} steps (+24 = tomorrow night); timelapse {rate} runs simulated " +
      "seconds per real second (600 ≈ 10 min/s watches stars wheel; rate: 0 stops). " +
      "track {target} keeps an object centered while time runs (track with no target stops). " +
      "toggle {layer: constellations|labels|planets, on?} shows/hides a layer. " +
      "Fails with 409 if no night sky is displayed — then display view:night-sky first.",
    inputSchema: {
      action: z.enum([
        "zoom_in", "zoom_out", "left", "right", "up", "down",
        "goto", "set_time", "advance_time", "timelapse", "track", "toggle",
      ]),
      amount: z.number().positive().optional(),
      target: z.string().optional(),
      ra: z.number().min(0).max(360).optional(),
      dec: z.number().min(-90).max(90).optional(),
      az: z.number().min(0).max(360).optional(),
      alt: z.number().min(-20).max(90).optional(),
      fov: z.number().min(10).max(180).optional(),
      title: z.string().optional(),
      time: z.string().optional(),
      hours: z.number().optional(),
      rate: z.number().min(0).optional(),
      layer: z.enum(["constellations", "labels", "planets"]).optional(),
      on: z.boolean().optional(),
    },
  },
  async (args) => textResult(await call("/api/console/sky-control", args)),
);

server.registerTool(
  "speak",
  {
    description:
      "Speak text aloud through the display's speakers in the Computer's voice. " +
      "Returns when playback completes. Keep utterances short and in-character. " +
      "Set caption: false when reading text that is already visible on the display " +
      "(e.g. an article) so the spoken words are not overlaid on top of the panel. " +
      "Speaking any language other than English? Set lang (ISO 639-1, e.g. 'fr') so a " +
      "native voice model pronounces it. The first utterance in a new language may fall " +
      "back to the English voice while its model downloads in the background. " +
      "MIXED-language lines (a foreign word inside an English sentence) → pass segments " +
      "instead of text: [{text: 'What does ', lang: 'en'}, {text: 'شكراً', lang: 'ar'}, " +
      "{text: ' mean?', lang: 'en'}] — one stitched utterance, each segment in its " +
      "language's native voice. Include leading/trailing spaces in the segment texts; " +
      "their concatenation is the caption.",
    inputSchema: {
      text: z.string().min(1).optional(),
      waitForPlayback: z.boolean().optional(),
      caption: z.boolean().optional(),
      lang: z.string().optional(),
      segments: z
        .array(z.object({ text: z.string().min(1), lang: z.string().optional() }))
        .min(1)
        .optional(),
    },
  },
  async ({ text, waitForPlayback, caption, lang, segments }) =>
    textResult(await call("/api/console/speak", { text, waitForPlayback, caption, lang, segments })),
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
  "display_history",
  {
    description:
      "List panels previously shown on the wall, newest first — the replay history " +
      "(last 50 content panels; status/blank not recorded). Entries are {id, ts, view, " +
      "summary}; full props stay server-side. Use when the user asks for something AGAIN " +
      "('show that diagram again', 'play that video again', 'go back to the article'): " +
      "find the matching entry, then redisplay its id — instant, nothing regenerated. " +
      "'New/another/different X' means generate fresh — don't consult history. No " +
      "matching entry → silently make the content normally.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ limit }) => textResult(await call("/api/console/display-history", { limit })),
);

server.registerTool(
  "redisplay",
  {
    description:
      "Replay a panel from display_history verbatim by id: the stored view and props " +
      "broadcast as-is in one round trip. A replayed youtube panel restarts its video " +
      "from the beginning. Confirm briefly ('On screen.').",
    inputSchema: {
      id: z.string(),
    },
  },
  async ({ id }) => textResult(await call("/api/console/redisplay", { id })),
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
