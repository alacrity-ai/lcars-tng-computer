# Audio Fallback — Implementation Design (final)

**Ticket:** TNGC-24 · **Date:** 2026-07-23
**Supersedes:** the Computer's `docs/HANDOFF_AUDIO_EXTRACTION.md` (consumed and deleted per handoff lifecycle)
**Prereq reading:** `apps/server/src/routes/youtube.ts`, `apps/web/src/panels/YouTubePanel.tsx`, `claude/.claude/skills/media/SKILL.md`

## 1. Problem

Many YouTube videos — including most major-label music (Madonna, etc.) —
disable embedding. The wall's only playback surface was the iframe embed, so
search silently dropped those results and the runtime substituted *different*
videos. At a party, a guest who queues a specific track wants **that track**;
embed restrictions bind only the iframe player, not the underlying media, and
the server already runs yt-dlp. So: resolve and proxy the audio, show an LCARS
now-playing card, and make the whole thing invisible.

## 2. The efficiency requirement (Leif, verbatim intent)

The fallback must be **automatic and fast — no MCP back-and-forth, no model
evaluation**. The Computer's handoff had the right building blocks but two
architectural misses, both fixed here:

1. **It was purely reactive.** Fallback only triggered after a broadcast embed
   visibly failed on the wall (dead frame → error event → round trip). But
   embeddability is already known at search time — `isEmbeddable()` runs in
   parallel for every result. Cache those verdicts and consult the cache at
   **broadcast time**: a known-blocked track starts as audio on the first
   render. Reactive handling remains only as the backstop for what oEmbed
   can't see (age gates, region locks).
2. **It substituted before falling back.** Its error-handler order was: next
   search result → queue → audio retry. For the party case that plays a
   *different* video instead of the requested song. Flipped: **audio of the
   SAME video first**, substitution only if audio also fails.

All three layers are pure server-side. The model's flow is byte-identical to
today (`youtube_search` → pick → `display`/`queue add`); it never reasons
about embeddability or audio at all.

## 3. Layered fallback

```
LAYER 0 — proactive (no failure ever visible)
  search: isEmbeddable() verdicts → embedCache (Map videoId→bool, ~6h TTL)
  every youtube broadcast (display route, queue advance, substitution)
    → decorateYoutubeProps():
        cache hit "blocked"  → audioOnly: true, prewarm audio URL
        cache hit "ok"       → unchanged embed
        cache miss           → one inline oEmbed check (~200ms, 1.5s timeout,
                               fail-open to embed) → cached
LAYER 1 — reactive (same track, as audio)
  wall reports embed error {videoId, audio: false}
    → mark blocked in cache → re-broadcast SAME videoId audioOnly + prewarm
LAYER 2 — substitution (last resort, existing chain)
  wall reports AUDIO error {videoId, audio: true} (or Layer 1 already tried)
    → next candidate from last search (decorated — a blocked candidate plays
      as audio, no longer skipped) → queue → yellow alert
```

Loop safety: the `video_error` event now carries `audio: boolean`; an audio
failure never re-enters Layer 1.

## 4. Server — `apps/server/src/routes/youtube.ts`

- **`embedCache`**: `Map<videoId, {ok, at}>`, 6h TTL, LRU-capped at 500. Fed
  by search checks, inline display checks, and runtime error reports.
- **`decorateYoutubeProps(props)`** (exported; the display route in
  `console.ts` awaits it for `view === "youtube"`): resolves embeddability as
  above; when audio, sets `audioOnly: true` and fire-and-forgets
  `prewarmAudio(videoId)`.
- **Audio URL cache + prewarm**: `resolveAudioUrl(videoId)` memoizes an
  in-flight/settled promise per id; runs
  `yt-dlp --no-warnings -f "bestaudio[ext=m4a]/bestaudio" -g <watch-url>`
  (30s timeout — longer than search's 25s, so `runYtdlp` gains an options
  param). Expiry parsed from the googlevideo URL's `expire` query param
  (fallback 4h); expired/failed entries drop from the cache.
- **`GET /api/console/audio/:videoId`** — the stream proxy. **Proxy, never
  redirect**: googlevideo URLs are IP-bound, and proxying centralizes
  retries. Validates the 11-char id, awaits the (usually prewarmed) URL,
  forwards the client's `Range` header, passes through
  `content-type`/`content-length`/`content-range`/`accept-ranges` and the
  200/206 status, and pipes the body. On upstream 403/410 (URL expired
  early): invalidate, re-resolve once, retry; then 502 — the audio element's
  error event feeds Layer 2.
- **Search**: stop dropping blocked results. Every result returns with
  `embeddable: boolean`, in **relevance order** (the handoff proposed
  ranking embeddable first — rejected: for "madonna like a prayer" that
  buries the official track under embeddable covers, and blocked results
  are now fully playable anyway. The skill steers explicit *video* requests
  toward `embeddable: true` instead).
- **Error handler**: implements Layers 1–2 per §3; substitution broadcasts
  through `decorateYoutubeProps` so blocked candidates play as audio.
- **Ended handler**: unchanged (audio path emits the same `video_ended`).

## 5. Contract & event plumbing

- `@tng/shared` `YouTubePanelProps` += `audioOnly?: boolean`,
  `channel?: string` (now-playing card). `YoutubeSearchResult` +=
  `embeddable?: boolean`. `video_error` ws message += `audio?: boolean`.
- `useSocket.ts` forwards the `audio` flag; `hub.ts` passes it to the error
  handler. `@tng/contract` (cloud) is untouched.
- Reusing the `youtube` view keeps the queue, ended-advance, media transport,
  recall, and the Library (a saved youtube item is still `{videoId, title}`)
  working unchanged.

## 6. Wall — `YouTubePanel.tsx` + `lcars.css`

`audioOnly` renders `<YouTubeAudio>` (sibling component — keeps hooks clean)
instead of the iframe:

- `<audio src="/api/console/audio/<id>" autoplay>` (vite proxies `/api` to
  the server already; the kiosk's autoplay policy covers audio too).
- **Now-playing card**: title, channel, `AUDIO` tag, elapsed/total time,
  progress bar, and a CSS equalizer animation that pauses with playback and
  dies under `prefers-reduced-motion`.
- `tng-media` wiring: `play`/`pause`/`stop`→pause; `speed`→`playbackRate`;
  `volume`/`volume_up`/`volume_down`/`mute`/`unmute` → element
  `volume`/`muted` with the same 0–100, ±15-nudge semantics as the embed.
- `ended` → `tng-video-ended {videoId}` (queue advances server-side);
  `error` → `tng-video-error {videoId, audio: true}` (Layer 2).
- `startSeconds` → `currentTime` at `loadedmetadata`; the proxy's Range
  support makes native seeking work.
- `fullscreen`/`windowed` reuse the existing full-bleed class (card enlarges).

## 7. MCP + skill

- `display` youtube schema: note `audioOnly`/`channel` — and that the model
  almost never needs to set `audioOnly` itself (the server decides).
- `youtube_search` description: results are no longer pre-filtered; every
  result is playable (blocked → automatic audio). Pick the best *match*; for
  explicitly-video requests prefer `embeddable: true`.
- `media` SKILL.md: same guidance; "play X (audio only)" → pass
  `audioOnly: true` explicitly.

## 8. Latency budget (the party path)

Queue advance to first sound, blocked track, warm caches: embeddability
decision **0ms** (cache) + broadcast + audio URL already resolving since
prewarm — yt-dlp resolution (~1–3s) overlaps panel render and is the only
real cost; subsequent seeks/replays reuse the cached URL for ~6h. Cold-cache
worst case adds one oEmbed round trip (~200ms, capped 1.5s, fail-open). No
model tokens, no MCP calls, in any path.

## 9. Risks

- googlevideo may 403 odd clients; the proxy centralizes fixes
  (`--extractor-args "youtube:player_client=..."` if needed) — server-only.
- yt-dlp breakage (YouTube churn): self-provisioned binary already re-downloads
  latest; worst case the audio path 502s and Layer 2 substitutes. The embed
  path is untouched by construction.
- Single-household personal use; streaming only, nothing persisted.
