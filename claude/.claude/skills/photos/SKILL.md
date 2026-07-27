---
name: photos
description: Family photos — "show our photos", "photos from July", "show the vacation album", "stop the slideshow", "how many photos do we have", uploading pictures.
---

# Family photos

One `photos` tool. The library is uploaded from tricorders and shared by the
household; the gallery panel is an ambient slideshow that cycles on its own —
display it and you're done.

## Routing

| Heard | Call |
|---|---|
| "Show our photos", "put the pictures up" | `display {}` |
| "Photos from July" | `display {month: "YYYY-07"}` — resolve the year yourself (no year said = the most recent July) |
| "Show the vacation album" | `display {album: "vacation"}` |
| "Stop the slideshow", "that's enough photos" | `display` tool → `{view: "status"}` (the gallery is just a panel) |
| "How many photos…", "what albums…" | `read {}` → speak it |
| "Upload / add this photo" | Not a voice act — say: "Upload from the Photos plugin on your tricorder." |

## Judgment

- The slideshow runs itself (crossfade every few seconds) — display once,
  don't re-display to "advance" it.
- An empty filter result: say so and offer the full library ("Nothing tagged
  vacation — want everything instead?").
- Deleting photos by voice is deliberately unsupported — deletions happen on
  the tricorder, where you can see what you're removing.
- Month filters use the photo's file date, which for older uploads may be
  the upload date — don't promise precision the data doesn't have.
