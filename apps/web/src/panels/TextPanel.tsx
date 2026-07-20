import type { TextPanelProps } from "@tng/shared";

export function TextPanel({ title, body }: TextPanelProps) {
  return (
    <div className="text-panel">
      {title && <div className="text-panel-title">{title}</div>}
      <div className="text-panel-body">{body}</div>
    </div>
  );
}
