---
name: quiz
description: Quiz and trivia games — "quiz me on X", "trivia about X", "test my knowledge of X", "ask me questions about X". Runs a multiple-choice question loop on the quiz panel with a running score, until the user says stop or changes the subject.
---

# Quiz — the question loop

"Quiz me on X" → the `quiz` panel. The panel renders ONE question at a time and
is stateless; you carry the quiz state (question list, score) in the
conversation and re-display to advance. The view never idle-reverts to status —
the user can think as long as they like.

## The loop

Repeat until the user says stop or asks for something else:

1. **Ask** — display the question phase, then speak it:

```
display({ view: "quiz", props: {
  subject: "Thermodynamics",
  questionNumber: 3,
  question: "Which law of thermodynamics forbids a perpetual motion machine of the first kind?",
  choices: ["The zeroth law", "The first law", "The second law", "The third law"],
  score: { correct: 2, answered: 2 }
}})
```

Speak the question AND read out each choice with its letter ("A, the zeroth
law. B, the first law…") — the user answers by voice and may not be looking
at the wall. Then end your turn and wait for the answer.

2. **Reveal** — when the user answers (a letter, or the choice's wording),
   re-display the SAME question with `selectedIndex` and `correctIndex` added,
   and `score` updated to include this question:
   - **Correct**: chime `complete`, brief spoken confirmation ("Correct."),
     then move on — display the next question after a beat.
   - **Wrong**: no chime, add `explanation` to the props (the panel shows it
     under the choices), and speak the correction: state the right answer and
     the one-or-two-sentence why. Then move on.

3. **Next question** — display question phase N+1 with the updated score.

## Composing questions

- Generate questions yourself from your own knowledge; WebSearch only for
  current-events subjects. Aim mid-difficulty, then adapt: streaks of right
  answers → harder; struggling → easier.
- 4 choices is the sweet spot (2–5 supported). Exactly one correct answer.
  Vary the position of the correct letter.
- Never repeat a question within a session; vary the angle (definitions,
  applications, history, numbers).
- Keep question + choices tight — the wall letters the choices itself, so
  don't prefix "A)" in the choice text.

## Ending

- "Stop", "I'm done", or any unrelated request ends the quiz. Speak the final
  score with a one-line verdict ("Seven of ten. Commendable."), then return
  the screen to `status` — or handle the new request.
- An answer like "I don't know" counts as wrong: reveal with `selectedIndex`
  omitted but `correctIndex` and `explanation` present, speak the answer,
  move on. (The panel shows the correct row and dims the rest.)
