/**
 * The pictionary board (TNGC-62) — the wall's half of the game.
 *
 * Deliberately STATELESS: every frame carries the whole picture, so a wall
 * that wakes mid-turn draws the complete drawing on its first paint with no
 * catch-up protocol. The cloud throttles frames; this panel just renders what
 * it is handed.
 *
 * The coordinate grid is 0–999 on both axes — the same integers the phone
 * captured in — so the SVG viewBox IS the wire format and nothing scales
 * anything.
 *
 * Per the panels SOP: a panel showing something perishable must render its own
 * dead state. A recalled board from last Tuesday says so instead of counting
 * down to a moment that has passed.
 */
import { useEffect, useState } from "react";
import {
  PICTIONARY_COLORS,
  PICTIONARY_WIDTHS,
  type PictionaryPanelProps,
  type PictionaryStroke,
} from "@tng/shared";

const GRID = 1000;

/** One stroke as an SVG path. A single point becomes a dot (round caps do the
    work), which is what a tap should look like. */
function strokePath(s: PictionaryStroke): string {
  // The server only ever emits rebuilt strokes, but a panel is also rendered
  // from a recalled payload and from whatever a future client sends — a wall
  // must not go blank because one array is the wrong shape.
  const p = s?.p;
  if (!Array.isArray(p) || p.length < 2) return "";
  if (p.length === 2) return `M${p[0]} ${p[1]}h0.01`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
  return d;
}

function color(i: number): string {
  return PICTIONARY_COLORS[i] ?? PICTIONARY_COLORS[0];
}

function width(i: number): number {
  return PICTIONARY_WIDTHS[i] ?? PICTIONARY_WIDTHS[1];
}

/** Seconds left, ticking. Only runs while there is something to count. */
function useCountdown(endsAt: number | undefined, live: boolean): number | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live || !endsAt) return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [endsAt, live]);
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

export function PictionaryPanel(props: PictionaryPanelProps) {
  const {
    phase = "lobby",
    mode = "coop",
    round = 0,
    rounds = 0,
    endsAt,
    drawer,
    mask,
    strokes = [],
    guesses = [],
    players = [],
    shared,
    teamScores,
    word,
    solvedBy,
    points,
    history = [],
  } = props ?? ({} as PictionaryPanelProps);

  const live = phase === "turn";
  const left = useCountdown(endsAt, live);
  // A board recalled long after the fact: the clock is meaningless, say so
  // rather than render a frozen 0 that looks like a bug.
  const stale = live && endsAt !== undefined && endsAt < Date.now() - 60_000;

  return (
    <div className="pict-panel">
      <div className="pict-head">
        <div className="pict-title">PICTIONARY</div>
        {rounds > 0 && (
          <div className="pict-round">
            TURN {round} <span className="pict-dim">/ {rounds}</span>
          </div>
        )}
        <div className="pict-spacer" />
        {phase === "turn" && drawer && <div className="pict-drawer">{drawer} is drawing</div>}
        {phase === "turn" &&
          (stale ? (
            <div className="pict-clock pict-clock-dead">ENDED</div>
          ) : (
            <div className={`pict-clock${left !== null && left <= 10 ? " pict-clock-low" : ""}`}>{left ?? "—"}</div>
          ))}
      </div>

      <div className="pict-body">
        <div className="pict-stage">
          {phase === "lobby" && (
            <div className="pict-center">
              <div className="pict-big">WAITING FOR PLAYERS</div>
              <div className="pict-sub">
                Plugins → Games → Pictionary on your tricorder{players.length ? ` · ${players.length} in` : ""}
              </div>
            </div>
          )}

          {(phase === "turn" || phase === "reveal") && (
            <svg className="pict-canvas" viewBox={`0 0 ${GRID} ${GRID}`} preserveAspectRatio="xMidYMid meet">
              <rect x="0" y="0" width={GRID} height={GRID} className="pict-canvas-bg" />
              {(Array.isArray(strokes) ? strokes : []).map((s, i) => {
                const d = strokePath(s);
                return d ? (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke={color(s.c)}
                    strokeWidth={width(s.w)}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null;
              })}
            </svg>
          )}

          {phase === "over" && (
            <div className="pict-center">
              <div className="pict-big">GAME OVER</div>
              {mode === "coop" && shared !== undefined && <div className="pict-final">{shared}</div>}
              {mode === "teams" && teamScores && (
                <div className="pict-final">
                  {teamScores[0]} <span className="pict-dim">—</span> {teamScores[1]}
                </div>
              )}
              {history.length > 0 && (
                <div className="pict-history">
                  {history.map((h, i) => (
                    <div key={i} className={`pict-hrow${h.solvedBy ? "" : " pict-missed"}`}>
                      <span className="pict-hword">{h.word}</span>
                      <span className="pict-dim">{h.solvedBy ? `→ ${h.solvedBy}` : "nobody"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {phase === "reveal" && (
            <div className="pict-reveal">
              <div className="pict-reveal-word">{word ?? "—"}</div>
              <div className="pict-reveal-note">
                {solvedBy ? `${solvedBy} got it${points ? ` · +${points}` : ""}` : "nobody got it"}
              </div>
            </div>
          )}
        </div>

        <div className="pict-side">
          {mask && phase === "turn" && <div className="pict-mask">{mask}</div>}

          <div className="pict-scores">
            {mode === "coop" && shared !== undefined && (
              <div className="pict-shared">
                <span className="pict-dim">TOGETHER</span>
                <span className="pict-shared-n">{shared}</span>
              </div>
            )}
            {mode === "teams" && teamScores && (
              <div className="pict-teams">
                <div className="pict-team pict-team-0">
                  <span className="pict-dim">TEAM 1</span>
                  <span>{teamScores[0]}</span>
                </div>
                <div className="pict-team pict-team-1">
                  <span className="pict-dim">TEAM 2</span>
                  <span>{teamScores[1]}</span>
                </div>
              </div>
            )}
            {players.map((p, i) => (
              <div key={i} className={`pict-prow${p.drawing ? " pict-drawing" : ""}`}>
                <span className={`pict-pname${p.team === 0 ? " pict-t0" : p.team === 1 ? " pict-t1" : ""}`}>
                  {p.name}
                </span>
                <span className="pict-pscore">{p.score}</span>
              </div>
            ))}
          </div>

          <div className="pict-feed">
            {guesses.length === 0 && phase === "turn" && <div className="pict-dim">no guesses yet</div>}
            {guesses.slice(-12).map((g, i) => (
              <div key={i} className={`pict-guess${g.ok ? " pict-got" : ""}`}>
                <span className="pict-gname">{g.name}</span>
                <span className="pict-gtext">{g.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
