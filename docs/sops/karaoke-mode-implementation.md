# Karaoke mode — reading with letter-by-letter highlighting

Karaoke mode reads text/article panels aloud with synchronized character highlighting. The Computer reads one page at a time; the wall animates the highlight locally from TTS timing data.

**Status:** ✅ Implemented (wall-driven highlighting, page-by-page reading)

## Architecture — the wall animates, the agent orchestrates

The critical design decision: **highlight animation lives in the webapp, not the agent loop.**

An early version had Claude drive highlighting by issuing one `display` call per character. That's thousands of MCP round trips per page — unusable. Likewise, synthesizing a whole multi-page article in one `speak` call blocks the TTS sidecar for minutes and trips its 15s fetch timeout (this is what a "hung" read of a long article looks like).

The shipped design:

1. Claude calls `speak(pageText, { caption: false })` — **one call per page**
2. The server synthesizes that page (a page is ~1100 chars ≈ seconds of synth) and broadcasts the `speak` WebSocket message **including the timing array**
3. The webapp (`useSocket.ts`) sees `caption: false` + timing and runs a local 50ms interval that sweeps `highlightIndex` through the current panel's props in sync with audio playback
4. When the utterance ends (or is stopped), the webapp clears the highlight and reports `speak_done`, which resolves Claude's `speak` call
5. Claude turns the page (`open_url` with `page: N+1`) and speaks the next one

## The reading session (server-driven — one MCP call)

Article reading is fully server-side: the Computer makes ONE `read_article`
call and the server (`apps/server/src/reading.ts`) runs the whole session:

1. Fetch + display page 1
2. **Fast start:** on a cold page, synthesize just the first sentence (<1s) and play it while the rest of the page synthesizes (`highlightBase` keeps the caret page-relative across the two utterances)
3. While page N plays (~1 min of audio), **prefetch** page N+1's synthesis (~seconds) — page turns are gapless
4. On `speak_done` from the wall, auto-advance: display page N+1, play its cached audio
5. Repeat to the end; bail if the wall disconnects

Latency extras (board-wide, not just articles):
- **Text-keyed synth cache** (`tts.ts`, 40 entries, LRU): repeated phrases and re-read pages skip synthesis entirely. Measured: cold short speak ~170ms, cache hit ~40ms.
- **Boot warmup** (`warmSynthCache`, called from `index.ts`): the stock acknowledgments from CLAUDE.md ("Working.", "Acknowledged.", "Unable to comply.", …) pre-synthesize at server start (retries up to 60s for the sidecar), so instant-acknowledgment is truly instant from the first interaction.
- **Chunked ordinary speak** (`console.ts`): any `speak` ≥180 chars that isn't cached splits at the first sentence boundary — the head plays (~200ms to broadcast) while the tail synthesizes concurrently. `highlightBase` keeps text-panel karaoke aligned across chunks. A `speechGeneration` counter guards interleaving: a newer speak, a reading session, or `media stop` invalidates any in-flight chunk loop so stale audio can never talk over new audio.
- **Summarized screen_state**: article props return `{page, pages, pageText}` (~700 bytes) instead of every paragraph (~50KB / 12k tokens) — agent round trips stay fast and context stays clean.
- Playback timeouts scale to measured audio duration + 20s slack (a fixed 60s cap used to truncate long pages).

Interruption semantics — ANY of these cancels the active session:
- `media stop` ("stop reading") — article stays on screen
- any external `speak` (the Computer answering a question never talks over the reading)
- any `display` or `open_url` (new content supersedes the read)
- `read_article` again (e.g. "skip to page 5" → `page: 5` restarts there)

The wall also kills caption-less reading audio whenever the display changes — audio for text that left the screen is never left playing.

`open_url` remains the view-without-reading path (returns `pageText` for the shown page). Never pull article text via `screen_state` (it returns every page, ~12k tokens for a long article).

## Key pieces

| File | Role |
|------|------|
| `apps/tts/src/tng_tts/server.py` | Piper synth + per-char timing (60ms/char estimate), JSON response |
| `apps/server/src/tts.ts` | Decodes sidecar response; `SynthResult` carries `timing` |
| `apps/server/src/routes/console.ts` | Broadcasts `speak` with `caption` + `timing`; returns timing to the agent too |
| `apps/server/src/routes/article.ts` | `open_url` returns `pageText` for the current page |
| `apps/web/src/useSocket.ts` | Local highlight animation (50ms interval), stoppable speech, caption suppression |
| `apps/web/src/panels/ArticlePanel.tsx` | Page-relative `highlightIndex` render (no auto-paging) |
| `apps/web/src/panels/TextPanel.tsx` | `highlightIndex` render |
| `apps/web/src/lcars.css` | `.article-highlight` / `.text-highlight` (peach bg, black text), `.voice-caption-quiet` |
| `packages/console-mcp/src/index.ts` | Tool schemas: `speak.caption`, `media.stop`, `open_url` → `pageText` |
| `claude/CLAUDE.md` | Behavioral rules: page-by-page, caption off, stay on panel, stop handling |

## Semantics

- `highlightIndex` is **relative to the currently displayed page** (paragraphs joined with single spaces, `+1` char between paragraphs). It is injected into the panel's props by the webapp during playback and removed when done.
- A new `speak` supersedes a still-playing one (audio stopped, highlight cleared, `speak_done` sent) — no overlapping utterances.
- TTS-offline fallback: no timing → no highlighting, caption timer estimates reading time; everything else still works.

## Timing accuracy

Timing is **measured, not estimated**:

- The sidecar splits the text into sentence spans (contiguous — every char belongs to exactly one span), synthesizes each sentence separately, and measures its real duration from the audio sample count (including the 220ms inter-sentence pause it inserts). The timing array's total always equals the WAV duration exactly.
- Within a sentence, characters share the measured duration evenly — so the cursor can drift only *within* one sentence, and resyncs at every sentence boundary.
- The webapp keys the sweep to `audio.currentTime`, not wall time: the highlight starts when playback actually starts, freezes if the audio stalls, and can never run ahead of the voice.

## Known limitations

- **Within-sentence distribution is even:** true phoneme→character alignment would need mapping Piper's `phoneme_alignments` back to input characters (espeak phonemization loses offsets). Sentence-boundary sync makes this invisible in practice.
- **Single character cursor:** one char at a time by design. Word-level highlighting would be a natural upgrade (highlight the word containing the current char).
- **No pause/resume for speech:** `stop` is terminal for the current utterance; resuming means re-speaking the page.
