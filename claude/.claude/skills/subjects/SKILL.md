---
name: subjects
description: Encyclopedic subjects and pictures — "tell me about X", "who is/was X", "show me a picture of X", comparisons and galleries of images. Covers choosing between show_profile, show_image, and composing your own answer.
---

# Subjects: profile vs. image vs. write-up

Three tiers. Pick by what was asked for, not by habit.

## show_profile — the default for encyclopedic subjects

**"Tell me about X" / "who is/was X" / "show me a picture of X"** →
`show_profile`. One call puts image + blurb on the wall as a library record and
returns the extract. Then speak 2–3 condensed sentences from it.

This is the default for any encyclopedic subject — people, places, animals,
ships, paintings.

- **409** means ambiguous: retry with a qualifier ("Nero (emperor)").
- **404 / "no record found"** means Wikipedia has no such article. Companies,
  products, and recent things often don't. Fall back to WebSearch and the
  `results` panel, or compose your own answer.
- **`fetch failed`** is a transient upstream error, not a missing subject.
  Retry once before reporting failure.

Speak more than the extract gives you where you know it — dates, why the
subject matters, who they influenced. The extract is a starting point, not a
script.

## show_image — pictures without a wiki subject, comparisons, galleries

**Single descriptive query** ("show me a red panda", "a picture of the aurora")
→ `show_image` with `query`, full-frame.

**Two or more `items` (2–9)** → a captioned mosaic grid, resolved in parallel:

- **Comparisons** ("Dafoe vs Pitt", "the Empire State Building and the Burj
  Khalifa") — one entry per subject, short `caption` each. Named people and
  landmarks resolve to their canonical wiki portrait automatically.
- **Galleries** ("various examples of roses") — invent 4–6 *distinct* queries.
  Vary along real axes: color, species, cultivar, wild vs cultivated, part of
  the plant. "red rose closeup" / "white rose" / "Rosa canina dog rose wild" /
  "rose hips fruit" beats five near-identical queries.

Check `missing[]` in the result and mention any subject that found no image.

Profiles fall back to image search automatically when the article has no photo,
so a profile is never pictureless if a picture exists.

## Compose your own — questions with no encyclopedic subject

**"Compare Nero and Caligula's reigns" / "why did Rome fall" / "are there
light bulbs with APIs"** → `text` panel + speak. You are the Computer;
synthesis is your job.

Add `show_profile` only if a single subject dominates the answer.

Keep the panel body under ~1,200 characters. Structure it — headers, short
bullets, a closing recommendation. The wall is read at a distance, so favor
scannable lines over paragraphs.

When the answer depends on facts that may have moved since your training
cutoff, either search first or say plainly in the terminal that you answered
from knowledge and offer to verify.

## Going deeper

**"Read me the article" / "open the wikipedia page" / "more detail" after a
profile** → hand off to `open_url` / `read_article`. See the `articles` skill.
