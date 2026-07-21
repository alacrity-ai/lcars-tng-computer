import type { FastifyInstance } from "fastify";
import type { DisplayHub } from "../hub.js";
import { cancelActiveReading } from "../reading.js";

/**
 * "Tell me about Nero" in ONE call: fetch the Wikipedia summary (blurb +
 * lead image together), put a library-record panel on the wall, and hand the
 * extract back so the Computer can speak it. Distinct from read_article:
 * this is the quick conversational record, that is the full reader.
 */

const UA = "tng-computer/0.1 (home LCARS wall; leif@lalalimited.com)";

interface WikiSummary {
  title: string;
  extract: string;
  type?: string;
  thumbnail?: { source: string; width: number; height: number };
  originalimage?: { source: string; width: number; height: number };
  content_urls?: { desktop?: { page?: string } };
}

interface FoundImage {
  url: string;
  source: string;
}

/** Keyless image search #1: Wikimedia Commons full-text file search. */
async function searchCommonsImage(query: string): Promise<FoundImage | null> {
  try {
    const u = new URL("https://commons.wikimedia.org/w/api.php");
    u.searchParams.set("action", "query");
    u.searchParams.set("format", "json");
    u.searchParams.set("generator", "search");
    u.searchParams.set("gsrsearch", `filetype:bitmap ${query}`);
    u.searchParams.set("gsrnamespace", "6");
    u.searchParams.set("gsrlimit", "8");
    u.searchParams.set("prop", "imageinfo");
    u.searchParams.set("iiprop", "url");
    u.searchParams.set("iiurlwidth", "1200");
    const res = await fetch(u, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      query?: { pages?: Record<string, { index?: number; imageinfo?: { url?: string; thumburl?: string }[] }> };
    };
    const pages = Object.values(data.query?.pages ?? {});
    pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99)); // relevance order
    for (const p of pages) {
      const info = p.imageinfo?.[0];
      const url = info?.thumburl ?? info?.url;
      if (url && /\.(jpe?g|png|webp)(\?|$)/i.test(url)) {
        return { url, source: "Wikimedia Commons" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Keyless image search #2: Openverse (CC-licensed aggregate; Flickr etc.). */
async function searchOpenverseImage(query: string): Promise<FoundImage | null> {
  try {
    const u = new URL("https://api.openverse.org/v1/images/");
    u.searchParams.set("q", query);
    u.searchParams.set("page_size", "5");
    const res = await fetch(u, {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { url?: string; source?: string }[] };
    for (const r of data.results ?? []) {
      if (typeof r.url === "string") {
        return { url: r.url, source: r.source ? `Openverse · ${r.source}` : "Openverse" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Commons first (better for encyclopedic queries), Openverse as backstop. */
export async function findImage(query: string): Promise<FoundImage | null> {
  return (await searchCommonsImage(query)) ?? (await searchOpenverseImage(query));
}

async function fetchWikiSummary(subject: string): Promise<WikiSummary | null> {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(subject.replace(/\s+/g, "_"))}?redirect=true`,
      {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as WikiSummary;
  } catch {
    return null;
  }
}

/** A named subject's canonical picture: wiki lead image (the portrait/landmark
    shot editors chose) → Commons search → Openverse. Generic phrases miss the
    wiki step and fall straight through to search. */
export async function resolveImage(query: string): Promise<FoundImage | null> {
  const summary = await fetchWikiSummary(query);
  if (summary && summary.type !== "disambiguation") {
    const url = await pickImage(summary);
    if (url) return { url, source: "Wikipedia" };
  }
  return findImage(query);
}

async function urlOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wall-sized image URL. Wikimedia's thumbnailer only renders certain width
 * buckets per file (arbitrary widths 400) — so fabricated sizes are verified
 * with a HEAD before use, and the API's own guaranteed URLs are the fallback.
 */
async function pickImage(data: WikiSummary): Promise<string | undefined> {
  const orig = data.originalimage;
  if (orig?.source && (orig.width ?? Infinity) <= 2200) return orig.source;
  if (data.thumbnail?.source) {
    const rescaled = data.thumbnail.source.replace(/\/\d+px-/, "/1280px-");
    if (rescaled !== data.thumbnail.source && (await urlOk(rescaled))) return rescaled;
  }
  // originalimage.source is API-generated and always servable, even if big.
  return orig?.source ?? data.thumbnail?.source;
}

export function registerProfileRoutes(app: FastifyInstance, hub: DisplayHub) {
  app.post<{ Body: { subject?: string } }>("/api/console/show-profile", async (req, reply) => {
    const subject = req.body?.subject?.trim();
    if (!subject) return reply.code(400).send({ error: "subject is required" });

    let data: WikiSummary;
    try {
      const res = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(subject.replace(/\s+/g, "_"))}?redirect=true`,
        {
          headers: { "user-agent": UA, accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) {
        return reply.code(502).send({ error: `no record found for "${subject}" (${res.status})` });
      }
      data = (await res.json()) as WikiSummary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `lookup failed: ${message}` });
    }

    if (data.type === "disambiguation") {
      return reply.code(409).send({
        error: `"${subject}" is ambiguous — retry with a more specific subject, e.g. "Nero (emperor)"`,
      });
    }

    let imageUrl = await pickImage(data);
    let imageSource = "Wikipedia";
    if (!imageUrl) {
      // Article has no lead image — fall back to image search so the record
      // still gets a picture (Commons, then Openverse).
      const found = await findImage(data.title);
      if (found) {
        imageUrl = found.url;
        imageSource = found.source;
      }
    }

    cancelActiveReading();
    hub.broadcast({
      type: "display",
      view: imageUrl ? "image" : "text",
      props: imageUrl
        ? { url: imageUrl, title: data.title, body: data.extract, source: imageSource }
        : { title: data.title, body: data.extract },
    });

    return {
      ok: true,
      title: data.title,
      extract: data.extract,
      imageUrl,
      imageSource: imageUrl ? imageSource : undefined,
      page: data.content_urls?.desktop?.page,
    };
  });

  app.post<{
    Body: { query?: string; title?: string; items?: { query?: string; caption?: string }[] };
  }>("/api/console/show-image", async (req, reply) => {
    const { title } = req.body ?? {};
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rawItems
      .map((i) => ({ query: i?.query?.trim() ?? "", caption: i?.caption }))
      .filter((i) => i.query)
      .slice(0, 9);

    // Mosaic: several subjects resolved in parallel, one display.
    if (items.length >= 2) {
      const resolved = await Promise.all(
        items.map(async (item) => ({ ...item, found: await resolveImage(item.query) })),
      );
      const images = resolved
        .filter((r) => r.found)
        .map((r) => ({
          url: r.found!.url,
          caption: r.caption ?? r.query,
          source: r.found!.source,
        }));
      if (images.length === 0) {
        return reply.code(404).send({ error: "no images found for any of the queries" });
      }
      cancelActiveReading();
      hub.broadcast({ type: "display", view: "image", props: { title, images } });
      return {
        ok: true,
        shown: images.length,
        missing: resolved.filter((r) => !r.found).map((r) => r.query),
      };
    }

    const query = (req.body?.query ?? items[0]?.query)?.trim();
    if (!query) return reply.code(400).send({ error: "query (or 2+ items) is required" });
    const found = await resolveImage(query);
    if (!found) {
      return reply.code(404).send({ error: `no image found for "${query}"` });
    }
    cancelActiveReading();
    hub.broadcast({
      type: "display",
      view: "image",
      props: { url: found.url, title: title ?? query, source: found.source },
    });
    return { ok: true, url: found.url, source: found.source };
  });
}
