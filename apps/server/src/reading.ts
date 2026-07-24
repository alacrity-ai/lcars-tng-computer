import { paginateArticle } from "@tng/shared";
import type { DisplayHub } from "./hub.js";
import type { CachedArticle } from "./routes/article.js";
import { splitFastStart, synthesize, type SynthResult } from "./tts.js";

/** Broadcast one article page to a viewscreen. Lives here (not article.ts) so
    the route module can import it without a circular runtime dependency. */
export function displayArticlePage(
  hub: DisplayHub,
  wall: string,
  href: string,
  article: CachedArticle,
  page: number,
) {
  hub.broadcast({
    type: "display",
    view: "article",
    props: {
      title: article.title,
      url: href,
      byline: article.byline,
      siteName: article.siteName,
      paragraphs: article.paragraphs,
      page,
    },
  }, wall);
}

/**
 * Server-driven article reading session. One read_article call starts it;
 * from then on the server displays each page, plays its audio (with karaoke
 * timing), prefetches the NEXT page's audio while the current one is being
 * read, and auto-advances until the article ends or something interrupts.
 *
 * The agent is out of the hot path entirely: no per-page MCP round trips,
 * and page turns are gapless because synthesis (~seconds) hides inside
 * playback (~a minute per page).
 *
 * Interruptions: any external console activity — a speak, a display, an
 * open_url, or media stop — cancels the active session. The Computer never
 * reads over its own voice or a new panel.
 */

/** Extra slack past the audio duration before giving up on a page. */
const PLAYBACK_TIMEOUT_SLACK_MS = 20_000;

class ReadingSession {
  private cancelled = false;
  private prefetches = new Map<number, Promise<SynthResult | null>>();

  constructor(
    private hub: DisplayHub,
    private wall: string,
    private href: string,
    private article: CachedArticle,
    private pages: string[][],
    private startPage: number,
  ) {}

  cancel() {
    this.cancelled = true;
  }

  private pageText(page: number): string {
    return this.pages[page - 1].join(" ");
  }

  private synthPage(page: number): Promise<SynthResult | null> {
    let p = this.prefetches.get(page);
    if (!p) {
      p = synthesize(this.pageText(page));
      this.prefetches.set(page, p);
    }
    return p;
  }

  /** Play one utterance on the wall and wait for it to finish. */
  private async play(synth: SynthResult, text: string, highlightBase: number): Promise<void> {
    this.hub.broadcast({
      type: "speak",
      utteranceId: synth.utteranceId,
      text,
      audioUrl: synth.audioUrl,
      caption: false,
      timing: synth.timing,
      highlightBase,
    }, this.wall);
    await this.hub.waitForSpeakDone(
      synth.utteranceId,
      synth.durationMs + PLAYBACK_TIMEOUT_SLACK_MS,
    );
  }

  async run(): Promise<void> {
    for (let page = this.startPage; page <= this.pages.length; page++) {
      if (this.cancelled) return;
      displayArticlePage(this.hub, this.wall, this.href, this.article, page);

      const text = this.pageText(page);
      const alreadySynthing = this.prefetches.has(page);
      const fastStart = alreadySynthing ? null : splitFastStart(text);

      if (fastStart) {
        // Cold page: get the first sentence out fast, synth the rest while
        // it plays. highlightBase keeps the caret page-relative.
        const [head, tail] = fastStart;
        const headSynth = await synthesize(head);
        if (this.cancelled) return;
        if (!headSynth) return; // TTS down — bail rather than race silently
        const tailPromise = synthesize(tail);
        await this.play(headSynth, head, 0);
        if (this.cancelled) return;
        const tailSynth = await tailPromise;
        if (!tailSynth) return;
        // Prefetch the next page as soon as the bulk of this one is playing.
        if (page < this.pages.length) void this.synthPage(page + 1);
        await this.play(tailSynth, tail, head.length);
      } else {
        const synth = await this.synthPage(page);
        if (this.cancelled) return;
        if (!synth) return;
        if (page < this.pages.length) void this.synthPage(page + 1);
        await this.play(synth, text, 0);
      }

      // A wall that lost its link mid-read shouldn't spin through pages.
      if (!this.hub.hasClients(this.wall)) return;
    }
  }
}

let active: ReadingSession | null = null;

/** Cancel whatever is being read; safe to call when nothing is. */
export function cancelActiveReading() {
  active?.cancel();
  active = null;
}

/**
 * Start reading an article aloud from the given page. Cancels any prior
 * session. Resolves as soon as the session is launched — reading continues
 * in the background.
 */
export function startReading(
  hub: DisplayHub,
  wall: string,
  href: string,
  article: CachedArticle,
  page: number,
): { page: number; pages: number } {
  cancelActiveReading();
  const pages = paginateArticle(article.paragraphs);
  const startPage = Math.min(Math.max(page, 1), pages.length);
  const session = new ReadingSession(hub, wall, href, article, pages, startPage);
  active = session;
  void session.run().finally(() => {
    if (active === session) active = null;
  });
  return { page: startPage, pages: pages.length };
}
