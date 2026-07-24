import type { AlertPanelProps } from "@tng/shared";

export function AlertPanel({ level, title, message }: AlertPanelProps) {
  return (
    <div className={`alert-panel alert-${level}`}>
      <div className="alert-title">{title ?? (level === "red" ? "Red Alert" : "Yellow Alert")}</div>
      {message && <div className="alert-message">{message}</div>}
    </div>
  );
}
