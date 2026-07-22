---
name: steps
description: Step-by-step procedures on the wall — "how do I make X", recipes, "walk me through Y", DIY repairs, first aid, then "next step" / "go back" / "start over" to move through them. Covers the steps panel's overview and focus modes and the voice-advance loop.
---

# Steps — guided procedures on the wall

The `steps` panel renders an ordered procedure. It has two modes, driven by
one prop:

- **Overview** (no `currentStep`) — a numbered list of every step. Use it to
  present the whole procedure first.
- **Focus** (`currentStep` set, 0-based) — that step dominates the screen in
  kitchen-readable type with its `detail`; the full list shrinks to a
  progress rail with done steps checked off and dimmed.

```
display({ view: "steps", props: {
  title: "Pancakes",
  subtitle: "Serves 4 · 25 minutes",
  steps: [
    { text: "Whisk dry ingredients", detail: "2 cups flour, 2 tbsp sugar, 2 tsp baking powder, 1 tsp salt." },
    { text: "Add wet ingredients", detail: "1½ cups milk, 2 eggs, 3 tbsp melted butter. Stir until just combined — lumps are fine." },
    { text: "Cook on a hot griddle", detail: "Medium heat. Flip when bubbles pop and stay open, about 2 minutes per side." }
  ]
}})
```

## The voice-advance loop

The panel is stateless — you re-display to move. On:

- **"start" / "first step"** → re-display with `currentStep: 0` and speak the
  step (text + the gist of detail).
- **"next step"** → same props, `currentStep + 1`. Speak the new step.
- **"go back" / "previous step"** → `currentStep - 1`.
- **"start over"** → `currentStep: 0`. **"show all steps"** → omit `currentStep`.
- Past the last step → speak a completion line ("Procedure complete.") and
  return the display to `status`.

Keep the full `steps` array identical across re-displays — only
`currentStep` changes. Track where you are in the conversation; the panel
doesn't remember for you.

Steps with durations pair naturally with `set_timer` — offer one when a step
says "bake 25 minutes".

## Sizing

- `text` is the short imperative (≤ ~8 words); quantities and technique live
  in `detail`, which only shows while the step is current.
- ~10 steps max on the rail. A longer procedure: group into phases and show
  one phase at a time.

## Voice

In focus mode, speak each step as you display it — the user's hands are
busy; the wall is confirmation, the voice is primary.
