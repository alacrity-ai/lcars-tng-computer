import type { StepItem, StepsPanelProps } from "@tng/shared";

function railState(index: number, current: number | undefined): string {
  if (current === undefined) return "todo";
  if (index < current) return "done";
  if (index === current) return "current";
  return "todo";
}

export function StepsPanel({ title, subtitle, steps, currentStep, caption }: StepsPanelProps) {
  const list: StepItem[] = Array.isArray(steps) ? steps : [];
  if (!list.length) {
    return <div className="steps-panel-empty">No steps to display.</div>;
  }

  const current =
    typeof currentStep === "number"
      ? Math.max(0, Math.min(list.length - 1, currentStep))
      : undefined;
  const active = current !== undefined ? list[current] : undefined;

  return (
    <div className="steps-panel">
      <div className="steps-head">
        {title && <div className="steps-title">{title}</div>}
        {subtitle && <div className="steps-subtitle">{subtitle}</div>}
      </div>
      <div className={`steps-body${active ? " steps-body-focus" : ""}`}>
        <ol className="steps-rail">
          {list.map((step, i) => (
            <li key={i} className={`steps-rail-item ${railState(i, current)}`}>
              <span className="steps-rail-num">{i < (current ?? -1) ? "✓" : i + 1}</span>
              <span className="steps-rail-text">{step.text}</span>
            </li>
          ))}
        </ol>
        {active && (
          <div className="steps-focus">
            <div className="steps-focus-count">
              STEP {current! + 1} OF {list.length}
            </div>
            <div className="steps-focus-text">{active.text}</div>
            {active.detail && <div className="steps-focus-detail">{active.detail}</div>}
          </div>
        )}
      </div>
      {caption && <div className="steps-caption">{caption}</div>}
    </div>
  );
}
