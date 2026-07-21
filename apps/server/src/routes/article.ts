import type { FastifyInstance } from "fastify";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { OpenUrlRequest, OpenUrlResponse } from "@tng/shared";
import { paginateArticle } from "@tng/shared";
import type { DisplayHub } from "../hub.js";
import { cancelActiveReading, displayArticlePage } from "../reading.js";

const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
/** Some sites 403 the default undici UA; look like the kiosk's own Chrome. */
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface CachedArticle {
  title: string;
  byline?: string;
  siteName?: string;
  paragraphs: string[];
  fetchedAt: number;
}

/** Small LRU so "next page" doesn't refetch; Map iteration order is insertion order. */
const CACHE_MAX = 10;
const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map<string, CachedArticle>();

function cacheGet(url: string): CachedArticle | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) {
    cache.delete(url);
    return undefined;
  }
  // refresh recency
  cache.delete(url);
  cache.set(url, hit);
  return hit;
}

function cachePut(url: string, article: CachedArticle) {
  cache.delete(url);
  cache.set(url, article);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function fetchAndExtract(url: string): Promise<CachedArticle> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`site answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html")) throw new Error(`not an HTML page (${type || "unknown type"})`);
  const html = await res.text();
  if (html.length > MAX_HTML_BYTES) throw new Error("page too large to parse");

  // jsdom logs every CSS parse error to console by default; silence it.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url, virtualConsole });
  const doc = dom.window.document;

  // Elements that turn to garbage when linearized for reading aloud: data
  // tables (Wikipedia infoboxes/taxoboxes flatten to "Kingdom: Animalia…"
  // fragments), figures and their captions, nav/hatnote furniture, and
  // citation superscripts. Readability keeps many of these; strip them first
  // so page 1 starts at the article's actual lead paragraph.
  const JUNK_SELECTORS = [
    "table",
    "figure",
    "figcaption",
    "sup.reference",
    '[role="navigation"]',
    ".hatnote",
    ".infobox",
    ".sidebar",
    ".navbox",
    ".metadata",
    ".mw-editsection",
    "aside",
  ];
  for (const el of doc.querySelectorAll(JUNK_SELECTORS.join(","))) el.remove();

  const parsed = new Readability(doc).parse();
  if (!parsed || !parsed.textContent?.trim()) {
    throw new Error("no readable article content on this page");
  }

  const paragraphs = parsed.textContent
    .split(/\n+/)
    // Drop leftover citation markers like [12] that survive as plain text.
    .map((p) => p.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim())
    // Repair run-on sentences ("…a sentence.And here…") left by removed inline
    // markup — TTS reads the bare period as "dot". Requires two word chars
    // before the punctuation so abbreviations like "Ph.D." and "U.S." survive.
    .map((p) => p.replace(/([a-z0-9]{2}[.!?][")\]”’']*)([A-Z])/g, "$1 $2"))
    .filter((p) => p.length > 0);

  return {
    title: parsed.title?.trim() || new URL(url).hostname,
    byline: parsed.byline?.trim() || undefined,
    siteName: parsed.siteName?.trim() || undefined,
    paragraphs,
    fetchedAt: Date.now(),
  };
}

/** Normalize + validate; throws on bad input. */
export function parseArticleUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http(s) urls");
  }
  return parsed;
}

/** Cache-aware article fetch — shared by open_url and the reading session. */
export async function getArticle(href: string): Promise<CachedArticle> {
  let article = cacheGet(href);
  if (!article) {
    article = await fetchAndExtract(href);
    cachePut(href, article);
  }
  return article;
}

/**
 * Reader mode: fetch a URL server-side, extract the article, put it on the
 * wall. Server-side fetching sidesteps X-Frame-Options entirely — no framing
 * happens. The extracted article is cached so page turns are instant.
 */
export function registerArticleRoutes(app: FastifyInstance, hub: DisplayHub) {
  app.post<{ Body: OpenUrlRequest }>("/api/console/open-url", async (req, reply) => {
    const { url, page } = req.body ?? {};
    if (!url) return reply.code(400).send({ error: "url is required" });
    let parsedUrl: URL;
    try {
      parsedUrl = parseArticleUrl(url);
    } catch {
      return reply.code(400).send({ error: "invalid url" });
    }

    let article: CachedArticle;
    try {
      article = await getArticle(parsedUrl.href);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `could not open page: ${message}` });
    }

    const pages = paginateArticle(article.paragraphs);
    const currentPage = Math.min(Math.max(page ?? 1, 1), pages.length);

    // Manual navigation supersedes any in-flight reading session.
    cancelActiveReading();
    displayArticlePage(hub, parsedUrl.href, article, currentPage);

    const body: OpenUrlResponse = {
      ok: true,
      url: parsedUrl.href,
      title: article.title,
      byline: article.byline,
      siteName: article.siteName,
      page: currentPage,
      pages: pages.length,
      excerpt: article.paragraphs.join(" ").slice(0, 500),
      pageText: pages[currentPage - 1].join(" "),
    };
    return body;
  });
}
