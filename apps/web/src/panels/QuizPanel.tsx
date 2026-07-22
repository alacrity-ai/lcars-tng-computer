import type { QuizPanelProps } from "@tng/shared";

/** Letter-pill accents cycled per choice, like the results panel numbers. */
const ACCENTS = ["bg-gold", "bg-lavender", "bg-blue", "bg-peach", "bg-cream"];
const LETTERS = "ABCDE";

function ChoiceRow({
  text,
  index,
  revealed,
  isSelected,
  isCorrect,
}: {
  text: string;
  index: number;
  revealed: boolean;
  isSelected: boolean;
  isCorrect: boolean;
}) {
  let stateClass = "";
  let tag: string | undefined;
  if (revealed) {
    if (isCorrect) {
      stateClass = "is-correct";
      tag = isSelected ? "Your answer — correct" : "Correct answer";
    } else if (isSelected) {
      stateClass = "is-wrong";
      tag = "Your answer";
    } else {
      stateClass = "is-dim";
    }
  }
  return (
    <div className={`quiz-choice ${stateClass}`}>
      <div className={`quiz-letter ${ACCENTS[index % ACCENTS.length]}`}>
        {LETTERS[index] ?? index + 1}
      </div>
      <div className="quiz-choice-text">{text}</div>
      {tag && <div className="quiz-tag">{tag}</div>}
    </div>
  );
}

export function QuizPanel({
  subject,
  questionNumber,
  question,
  choices,
  score,
  selectedIndex,
  correctIndex,
  explanation,
}: QuizPanelProps) {
  const list = Array.isArray(choices) ? choices : [];
  // Reveal keys on correctIndex alone: a pass ("I don't know") reveals the
  // answer with no selection to mark.
  const revealed = typeof correctIndex === "number";
  const missed = revealed && selectedIndex !== correctIndex;
  return (
    <div className="quiz-panel">
      <div className="quiz-head">
        <div className="quiz-subject">{subject}</div>
        <div className="quiz-sub">Question {questionNumber || 1}</div>
        {score && (
          <div className="quiz-score">
            Score {score.correct}/{score.answered}
          </div>
        )}
      </div>
      <div className="quiz-question">{question}</div>
      <div className="quiz-choices">
        {list.map((text, i) => (
          <ChoiceRow
            key={i}
            text={text}
            index={i}
            revealed={revealed}
            isSelected={revealed && selectedIndex === i}
            isCorrect={revealed && correctIndex === i}
          />
        ))}
      </div>
      {revealed && missed && explanation && <div className="quiz-explain">{explanation}</div>}
      {!revealed && <div className="quiz-hint">Say a letter — or say stop to end the quiz</div>}
    </div>
  );
}
