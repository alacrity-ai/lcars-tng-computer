# Tricorder Library — PWA Navigation & Browsing Design

**Ticket:** TNGC-23 · **Companion to:** `TRICORDER_LIBRARY_IMPLEMENTATION_DESIGN.md` (architecture, API, storage)
**Scope:** how the Library *feels* on the phone — navigation, browsing, search, and how it holds up after months of use with hundreds of saved artifacts.

---

## 1. Design premise

The Library is a **retrieval instrument, not a feed**. After six months a household
member has 300 saved items and opens the Library for exactly one of two reasons:

1. **"That thing from the other day"** — recency. The answer must be on screen in
   one tap, zero typing.
2. **"My bread recipe" / "the warp core diagram"** — a *named* memory. The answer
   must be reachable by typing 3–4 characters.

Everything below optimizes those two paths. Browsing-for-pleasure is supported but
never at their expense. The governing rules:

- **One tap to recency, four keystrokes to anything.** The list opens newest-first
  (path 1 solved by position zero); the search field is always visible at the top,
  never hidden behind an icon (path 2 solved without a mode switch).
- **The phone renders metadata; the cloud does the finding.** Search, family
  filter, and pagination are all server-side (D1 indexed by
  `owner, created_at DESC`). The PWA never holds more than the rows on screen —
  at 300 items or 3,000, the DOM and the payloads are the same size.
- **No polling.** Unlike the queue screen, a library is inert — fetch on entry,
  on filter change, on scroll, after a mutation. Nothing ticks in the background.

## 2. Information architecture

```
main ──────────── LIBRARY (full-width bar, above the foot links)
  │
  └─ library list ──── tap row ────► item view
       ▲    search + chips + rows        │  Display on wall / Send / Delete
       └──────── back (state kept) ◄─────┘
```

Three levels, never more. Back from the item view returns to the **exact** list
state — scroll position, active chip, search text — because the list view's DOM is
kept alive (the item view is a separate `.view` layered on the same stack, like
queue/admin today). Back from the list returns to main. The Android/iOS PWA back
gesture maps to the same transitions via a tiny history-state hook, so the app
never exits from a back-swipe inside the Library.

**Entry point:** a full-width lavender LCARS bar button labeled `LIBRARY` sits
between the type-row and the foot links on main — a first-class instrument, unlike
the buried admin link. No badge, no count; the Library has no "unread" urgency
except received items (§5).

## 3. The list screen

Anatomy, top to bottom (header sticks; only rows scroll):

```
◄ BACK        LIBRARY
┌─────────────────────────────────┐
│ 🔍 search my library…           │   ← always visible, never collapsed
└─────────────────────────────────┘
( ALL )( VISUAL )( PROSE )( DATA )( PROCEDURE )( NOTATION )( MEDIA )( RECEIVED )
┌─────────────────────────────────┐
│▌ Warp Core Cutaway              │   ▌= family color bar (visual = gold)
│▌ diagram · 2h ago               │
├─────────────────────────────────┤
│▌ No-Knead Bread                 │   (procedure = lavender)
│▌ steps · 3d ago                 │
├─────────────────────────────────┤
│▌ Enterprise Crew Compare        │   (data = blue)
│▌ table · Jan 12 · from ariel    │   ← received badge, sender named
└─────────────────────────────────┘
              · · ·                   ← sentinel row: auto-loads next page
```

- **Search** filters server-side (`?q=` LIKE on title) with a 250 ms debounce and
  request-generation guard (a stale response never overwrites a newer one). Search
  spans the user's *entire* library, not the loaded rows — typing "bre" at 800
  items finds the bread recipe even though it was never scrolled to. Clearing the
  field restores the previous chip + scroll context.
- **Family chips** are a single horizontal scroll row; one active at a time
  (families are disjoint, multi-select buys nothing). `RECEIVED` is a chip, not a
  separate screen — "what did Leif send me" is a filter question. Chips combine
  with search (q + family both apply).
- **Rows** are metadata-only and fixed-height (~64 px): title (one line,
  ellipsized), then `view · relative age` (absolute date past 7 days — "3d ago"
  decays into "Jan 12" because relative time stops meaning anything at month
  scale) and `from <handle>` when received. The left color bar carries the family
  at a glance; no thumbnails in v1 (a thumbnail would mean fetching payloads —
  exactly what the architecture forbids on the list path).
- **Pagination:** cursor-based infinite scroll — `?before=<created_at>&limit=30`,
  an IntersectionObserver on the sentinel row loads the next page. No page
  buttons, no "load more" taps. 30 rows ≈ 3 screens; a month of heavy use loads in
  two fetches. Ordering by immutable `created_at` means the cursor never skips or
  duplicates rows when items are added mid-scroll.
- **Row count label** under the chips ("214 items · 12 match") after any
  filter/search — quiet feedback that the filter actually ran, essential once the
  library outgrows one screen.

**States:** empty library → "Nothing saved yet — say *save to my tricorder* while
something is on the wall." No matches → "No matches for 'brad'." (with the query
echoed); network error → inline red line + the rows already loaded stay usable.
While a page loads, 3 skeleton rows shimmer (CSS only, honors
`prefers-reduced-motion`).

## 4. The item view

Opens instantly with the metadata already in hand (title, family, age, sender)
while `GET /api/library/:id` fetches the payload; the render area shows a skeleton
until it lands. Layout:

- Header: back, then title (wraps, never ellipsized here), meta line
  (`diagram · saved Jan 12 · from ariel`). `data`-family items add a prominent
  staleness stamp — **"CAPTURED 6 WEEKS AGO"** in peach — because a stock quote or
  forecast is an artifact of its moment.
- **Native render** (phase 1): `diagram` (inline SVG, scaled to width), `image`,
  `text`, `article` (paragraphs), `code` (monospace, h-scroll), `table`, `steps`
  (numbered list), `results`/`news` (link list), `media` (YouTube thumbnail +
  title, opens youtube.com). Phase 2: `math`, `chart`. `map`/`night-sky`/`quiz`
  and anything unrecognized fall back to a family-colored placard: "Live panel —
  view on the wall."
- **Actions** (fixed bottom row, always reachable without scrolling past a long
  render): `DISPLAY ON WALL` (gold — the star action), `SEND` (blue), `DELETE`
  (red, confirm dialog).
  - *Display on wall* posts `/api/library/:id/display`; success toast
    "On the wall." / queued toast "Queued — the Computer is busy." (from the 202
    vs. queue state); offline → "Computer offline" toast, button stays enabled.
  - *Send* slides up a bottom sheet listing household members
    (`GET /api/users`, guests excluded) as tap targets; confirm toast
    "Sent to Ariel." No compose step — the artifact *is* the message.
  - *Delete* confirms ("Delete 'No-Knead Bread'? The wall copy is unaffected."),
    then returns to the list with the row gone.

## 5. Received items

Passive by design (no push, no badge on main — the wall chime debate is deferred):
a received item is simply a row that names its sender, surfaced three ways —
newest-first position, the `RECEIVED` chip, and the `from <handle>` line. The
first Library visit after a send therefore shows it at the top of ALL anyway.

## 6. Motion & feel

Same vocabulary as the rest of the app — `fade-rise` on view entry, `pill-pop` on
chip activation, `modal-pop` on the send sheet — plus one new element: rows
stagger-fade in 25 ms steps on first page load only (subsequent pages append
without ceremony; stagger on every scroll would read as lag, not polish). All
motion dies under `prefers-reduced-motion`. Touch targets ≥ 44 px throughout;
the search input is `font-size: 17px` so iOS never auto-zooms.

## 7. What we deliberately did NOT build

- **Folders/tags/favorites** — organization taxes every save with a filing
  decision. Family + search + recency is zero-effort and covers both retrieval
  paths. Revisit only if real usage shows a third path.
- **Thumbnails in the list** — requires payload fetches on the browse path.
- **Client-side search index** — duplicates what D1 already does, and dies at
  the exact scale it was meant to serve.
- **FTS / fuzzy search** — LIKE-on-title is right at household scale; titles are
  short and human-authored (the wall's summary line). Revisit past ~2k items.
- **Pull-to-refresh** — entry, filter, and mutation already refetch; the library
  doesn't change under you while you look at it.
