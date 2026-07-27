import type { ListPanelProps } from "@tng/shared";

/** Family list checklist (TNGC-63). Unchecked first — the glanceable
    question is "what's left" — then completed items, struck but visible
    (a list you can't watch shrink isn't satisfying). Caps rows to keep the
    wall readable; the tricorder plugin is the place to scroll. */
const MAX_ROWS = 24;

export function ListPanel({ title, category, items }: ListPanelProps) {
  const open = items.filter((i) => !i.checked);
  const done = items.filter((i) => i.checked);
  const ordered = [...open, ...done];
  const shown = ordered.slice(0, MAX_ROWS);
  const hidden = ordered.length - shown.length;

  return (
    <div className={`list-panel ${category ? `list-cat-${category}` : ""}`}>
      <div className="list-head">
        <span className="list-title">{title}</span>
        <span className="list-count">
          {items.length === 0
            ? "EMPTY"
            : done.length === items.length
              ? "ALL DONE"
              : `${done.length} OF ${items.length} DONE`}
        </span>
      </div>
      {shown.length ? (
        <div className="list-rows">
          {shown.map((item, idx) => (
            <div key={idx} className={`list-row ${item.checked ? "done" : ""}`}>
              <span className="list-box">{item.checked ? "▣" : "□"}</span>
              <span className="list-text">{item.text}</span>
              {item.checked && item.checkedBy ? <span className="list-by">{item.checkedBy}</span> : null}
            </div>
          ))}
          {hidden > 0 ? <div className="list-more">+{hidden} more</div> : null}
        </div>
      ) : (
        <div className="list-empty">Nothing here yet.</div>
      )}
      <div className="list-foot">{category ? `${category.toUpperCase()} · ` : ""}FAMILY LISTS</div>
    </div>
  );
}
