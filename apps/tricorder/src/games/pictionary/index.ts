/**
 * Pictionary (TNGC-62) — the first game.
 *
 * One drawer with a secret word, everyone else typing guesses, a wall showing
 * the canvas. All rules are deterministic code; the brain is not in the loop
 * and never will be for judging — a game that pauses two seconds to ask a
 * model whether "boat" is "boat" is not a game.
 *
 * THE SECRET. `project` attaches `word` only when the viewer is the drawer,
 * and `wallProps` has no branch that can emit it during a turn. Those are the
 * only two places the word can escape; everything else in this file works with
 * the mask. If you add a third exit, you have broken the game.
 *
 * COORDINATES. Points are integers on a 0–999 grid, not pixels — the phone
 * captures in it and the wall's SVG viewBox is it, so neither end scales
 * anything and the payload stays small enough to poll.
 */
import type { PanelView, PictionaryPanelProps, PictionaryStroke } from "@tng/shared";
import {
  type Actor,
  type GameModule,
  type GameMode,
  type Match,
  type ModuleResult,
  drawOrder,
  editDistance,
  findPlayer,
  newId,
  normalize,
  shuffle,
} from "../engine";
import { maskWord, pickWord } from "./words";

const TURN_MS = 90_000;
const REVEAL_MS = 8_000;
const OVER_LINGER_MS = 5 * 60_000;
const MAX_TURNS = 12;

/** A canvas is unbounded input from a phone, so every dimension has a ceiling
    and going past one is an ERROR, not a silent truncation. */
const MAX_STROKES = 400;
const MAX_POINTS_PER_STROKE = 200;
const MAX_POINTS_TOTAL = 6000;
const MAX_STROKES_PER_OP = 40;
const MAX_GUESS_LEN = 60;
const KEEP_GUESSES = 40;

/** Randomness lives behind one indirection so tests can make a match
    deterministic without threading a generator through the module contract. */
let RAND: () => number = () => Math.random();

const COLOR_COUNT = 6;
const WIDTH_COUNT = 3;
const GRID = 999;

interface Guess {
  /** handle */
  h: string;
  /** display name */
  n: string;
  t: string;
  ts: number;
  ok: boolean;
}

interface Turn {
  id: string;
  drawer: string;
  team: 0 | 1 | null;
  /** THE SECRET. */
  word: string;
  strokes: PictionaryStroke[];
  guesses: Guess[];
  solvedBy: string | null;
  solvedAt: number | null;
  /** Points awarded this turn, for the reveal card. */
  points: number;
  startedAt: number;
  /** Set when the drawer gave up, so the reveal can say so. */
  skipped: boolean;
}

export interface PictionaryState {
  /** 1-based. */
  round: number;
  rounds: number;
  /** Handles, in draw order. Teams mode interleaves sides. */
  order: string[];
  turn: Turn | null;
  /** Co-op: the only score that matters. */
  shared: number;
  teamScores: [number, number];
  used: string[];
  history: { word: string; drawer: string; solvedBy?: string }[];
}

type M = Match<PictionaryState>;

const bad = (status: number, error: string): ModuleResult => ({ status, body: { error } });

function nameOf(m: M, handle: string): string {
  return findPlayer(m, handle)?.name ?? handle;
}

/** Points scale with the clock: 20 for an instant read, 10 as it runs out. */
function guessPoints(now: number, endsAt: number): number {
  const left = Math.max(0, Math.floor((endsAt - now) / 1000));
  return 10 + Math.min(10, Math.floor(left / 9));
}

function award(m: M, handle: string, points: number): M {
  const players = m.players.map((p) => (p.handle === handle ? { ...p, score: p.score + points } : p));
  const player = findPlayer(m, handle);
  const state = { ...m.state };
  if (m.mode === "coop") {
    state.shared += points;
  } else if (player?.team === 0 || player?.team === 1) {
    const scores: [number, number] = [state.teamScores[0], state.teamScores[1]];
    scores[player.team] += points;
    state.teamScores = scores;
  }
  return { ...m, players, state };
}

/** Start turn `round`, or finish the match if there are no turns left. */
function beginTurn(m: M, round: number, now: number, rand: () => number): ModuleResult {
  const state = m.state;
  if (round > state.rounds) return finish(m, now);
  const drawer = state.order[(round - 1) % state.order.length];
  if (!findPlayer(m, drawer)) {
    // The drawer left between turns — skip their slot rather than stall.
    const pruned: M = { ...m, state: { ...state, order: state.order.filter((h) => findPlayer(m, h)) } };
    if (pruned.state.order.length === 0) return finish(pruned, now);
    return beginTurn(pruned, round, now, rand);
  }
  const word = pickWord(round, state.rounds, state.used, rand);
  const turn: Turn = {
    id: newId(),
    drawer,
    team: findPlayer(m, drawer)?.team ?? null,
    word,
    strokes: [],
    guesses: [],
    solvedBy: null,
    solvedAt: null,
    points: 0,
    startedAt: now,
    skipped: false,
  };
  return {
    match: {
      ...m,
      phase: "turn",
      endsAt: now + TURN_MS,
      updatedAt: now,
      state: { ...state, round, turn, used: [...state.used, word] },
    },
  };
}

function finish(m: M, now: number): ModuleResult {
  const over: M = { ...m, phase: "over", endsAt: now + OVER_LINGER_MS, updatedAt: now, state: { ...m.state, turn: null } };
  const solved = over.state.history.filter((h) => h.solvedBy).length;
  const total = over.state.history.length;
  const names = over.players.map((p) => p.name);
  const summary =
    over.mode === "coop"
      ? `${names.join(" & ")} — ${solved} of ${total} for ${over.state.shared}`
      : `Team 1 ${over.state.teamScores[0]} — ${over.state.teamScores[1]} Team 2`;
  return {
    match: over,
    finished: {
      game: "pictionary",
      mode: over.mode,
      players: over.players.length,
      summary,
      detail: {
        mode: over.mode,
        shared: over.state.shared,
        teamScores: over.state.teamScores,
        solved,
        turns: total,
        players: over.players.map((p) => ({ handle: p.handle, name: p.name, team: p.team, score: p.score })),
        history: over.state.history,
      },
      startedAt: over.startedAt ?? over.createdAt,
      endedAt: now,
    },
  };
}

/** End the current turn and show the reveal card. */
function toReveal(m: M, now: number): ModuleResult {
  const turn = m.state.turn;
  if (!turn) return finish(m, now);
  return {
    match: {
      ...m,
      phase: "reveal",
      endsAt: now + REVEAL_MS,
      updatedAt: now,
      state: {
        ...m.state,
        history: [
          ...m.state.history,
          { word: turn.word, drawer: nameOf(m, turn.drawer), ...(turn.solvedBy ? { solvedBy: nameOf(m, turn.solvedBy) } : {}) },
        ],
      },
    },
  };
}

/** Validate and REBUILD an incoming stroke. Nothing from the phone is stored
    as it arrived: indexes are range-checked, coordinates are clamped to the
    grid and rounded, and a stroke that overflows any cap is refused. */
function cleanStrokes(raw: unknown, existing: PictionaryStroke[]): { error: string } | { strokes: PictionaryStroke[] } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "strokes must be a non-empty array" };
  if (raw.length > MAX_STROKES_PER_OP) return { error: `at most ${MAX_STROKES_PER_OP} strokes per request` };
  if (existing.length + raw.length > MAX_STROKES) return { error: "the canvas is full — clear it to keep drawing" };
  let total = existing.reduce((n, s) => n + s.p.length / 2, 0);
  const out: PictionaryStroke[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { error: "malformed stroke" };
    const s = item as { c?: unknown; w?: unknown; p?: unknown };
    const c = typeof s.c === "number" && Number.isInteger(s.c) && s.c >= 0 && s.c < COLOR_COUNT ? s.c : 0;
    const w = typeof s.w === "number" && Number.isInteger(s.w) && s.w >= 0 && s.w < WIDTH_COUNT ? s.w : 1;
    if (!Array.isArray(s.p) || s.p.length < 2 || s.p.length % 2 !== 0) return { error: "malformed stroke points" };
    if (s.p.length / 2 > MAX_POINTS_PER_STROKE) return { error: `at most ${MAX_POINTS_PER_STROKE} points per stroke` };
    total += s.p.length / 2;
    if (total > MAX_POINTS_TOTAL) return { error: "the canvas is full — clear it to keep drawing" };
    const p: number[] = [];
    for (const n of s.p) {
      if (typeof n !== "number" || !Number.isFinite(n)) return { error: "malformed stroke points" };
      p.push(Math.max(0, Math.min(GRID, Math.round(n))));
    }
    out.push({ c, w, p });
  }
  return { strokes: out };
}

export const pictionary: GameModule<PictionaryState> = {
  id: "pictionary",
  name: "Pictionary",
  blurb: "One of you draws on your phone, the rest type guesses. The wall is the board.",
  minPlayers: 2,
  maxPlayers: 8,
  modes: [
    {
      id: "coop",
      name: "Co-op",
      minPlayers: 2,
      maxPlayers: 3,
      hint: "No teams — every point goes into one shared score. Two players is you and the clock.",
    },
    {
      id: "teams",
      name: "Teams",
      minPlayers: 4,
      maxPlayers: 8,
      hint: "Two shuffled teams. Only the drawer's own team may guess; the other team watches.",
    },
  ],

  defaultMode(count: number): GameMode {
    return count >= 4 ? "teams" : "coop";
  },

  begin(m: M, now: number): ModuleResult {
    const rand = RAND;
    const order = drawOrder(m.players, m.mode, rand);
    const rounds = Math.max(2, Math.min(MAX_TURNS, m.players.length * 2));
    const seeded: M = {
      ...m,
      state: { round: 0, rounds, order, turn: null, shared: 0, teamScores: [0, 0], used: [], history: [] },
    };
    return beginTurn(seeded, 1, now, rand);
  },

  act(m: M, actor: Actor, body: Record<string, unknown>, now: number): ModuleResult {
    const turn = m.state.turn;
    if (!turn) return bad(409, "nothing is being drawn right now");
    const op = typeof body.op === "string" ? body.op : "";
    const isDrawer = actor.handle === turn.drawer;

    switch (op) {
      case "stroke": {
        if (!isDrawer) return bad(403, "only the drawer can draw");
        if (m.phase !== "turn") return bad(409, "the turn is over");
        const cleaned = cleanStrokes(body.strokes, turn.strokes);
        if ("error" in cleaned) return bad(400, cleaned.error);
        return {
          match: {
            ...m,
            updatedAt: now,
            state: { ...m.state, turn: { ...turn, strokes: [...turn.strokes, ...cleaned.strokes] } },
          },
          body: { ok: true, strokeCount: turn.strokes.length + cleaned.strokes.length },
        };
      }

      case "undo": {
        if (!isDrawer) return bad(403, "only the drawer can undo");
        if (m.phase !== "turn") return bad(409, "the turn is over");
        if (!turn.strokes.length) return { body: { ok: true, strokeCount: 0 } };
        const strokes = turn.strokes.slice(0, -1);
        return {
          match: { ...m, updatedAt: now, state: { ...m.state, turn: { ...turn, strokes } } },
          body: { ok: true, strokeCount: strokes.length },
        };
      }

      case "clear": {
        if (!isDrawer) return bad(403, "only the drawer can clear");
        if (m.phase !== "turn") return bad(409, "the turn is over");
        return {
          match: { ...m, updatedAt: now, state: { ...m.state, turn: { ...turn, strokes: [] } } },
          body: { ok: true, strokeCount: 0 },
        };
      }

      case "skip": {
        if (!isDrawer) return bad(403, "only the drawer can pass");
        if (m.phase !== "turn") return bad(409, "the turn is over");
        const passed: M = { ...m, state: { ...m.state, turn: { ...turn, skipped: true } } };
        return toReveal(passed, now);
      }

      case "guess": {
        if (m.phase !== "turn") return bad(409, "too late");
        if (isDrawer) return bad(403, "you are the one drawing");
        const raw = typeof body.text === "string" ? body.text.slice(0, MAX_GUESS_LEN).trim() : "";
        if (!raw) return bad(400, "say something");
        const player = findPlayer(m, actor.handle);
        // Teams: only the drawer's own side is playing this turn.
        if (m.mode === "teams" && player?.team !== turn.team) {
          return bad(403, "it is the other team's turn — enjoy the show");
        }
        const guess = normalize(raw);
        const target = normalize(turn.word);
        const correct = guess === target;
        const entry: Guess = {
          h: actor.handle,
          n: player?.name ?? actor.handle,
          // A correct guess is never echoed verbatim into the shared feed
          // before the reveal — the feed is public and that would hand the
          // word to everyone still thinking.
          t: correct ? "got it!" : raw,
          ts: now,
          ok: correct,
        };
        const withGuess: M = {
          ...m,
          updatedAt: now,
          state: { ...m.state, turn: { ...turn, guesses: [...turn.guesses, entry].slice(-KEEP_GUESSES) } },
        };
        if (!correct) {
          const dist = editDistance(guess, target);
          return {
            match: withGuess,
            body: { ok: true, correct: false, ...(dist >= 1 && dist <= 2 ? { close: true, note: "so close!" } : {}) },
          };
        }
        const points = guessPoints(now, m.endsAt);
        const scored = award(award(withGuess, actor.handle, points), turn.drawer, 5);
        const solved: M = {
          ...scored,
          state: {
            ...scored.state,
            turn: { ...scored.state.turn!, solvedBy: actor.handle, solvedAt: now, points: points + 5 },
          },
        };
        const revealed = toReveal(solved, now);
        return { ...revealed, body: { ok: true, correct: true, points } };
      }

      default:
        return bad(400, "unknown action");
    }
  },

  expire(m: M, now: number): ModuleResult {
    if (m.phase === "turn") return toReveal(m, now);
    if (m.phase === "reveal") {
      return beginTurn(m, m.state.round + 1, now, RAND);
    }
    return finish(m, now);
  },

  /** Called whenever the match ends, however it ends. A turn cut short still
      counts as a turn — it goes into the history unsolved rather than
      vanishing, so the final board matches what people watched. */
  conclude(m: M, now: number): ModuleResult {
    const closed = m.state.turn ? ((toReveal(m, now).match as M) ?? m) : m;
    return finish(closed, now);
  },

  project(m: M, viewer: string, since: number): unknown {
    const s = m.state;
    const turn = s.turn;
    const base: Record<string, unknown> = {
      round: s.round,
      rounds: s.rounds,
      shared: s.shared,
      teamScores: s.teamScores,
      history: m.phase === "over" ? s.history : undefined,
    };
    if (!turn) return base;

    const isDrawer = viewer === turn.drawer;
    // Incremental strokes: the client sends how many it has, we send what it
    // is missing. `strokeBase === 0` means "replace"; anything else, append.
    const from = Number.isInteger(since) && since > 0 && since <= turn.strokes.length ? since : 0;
    const revealed = m.phase === "reveal" || m.phase === "over";
    const canGuess = m.mode !== "teams" || findPlayer(m, viewer)?.team === turn.team;

    return {
      ...base,
      turn: {
        id: turn.id,
        drawer: turn.drawer,
        drawerName: nameOf(m, turn.drawer),
        team: turn.team,
        isDrawer,
        canGuess: !isDrawer && canGuess,
        mask: maskWord(turn.word),
        strokeCount: turn.strokes.length,
        strokeBase: from,
        strokes: turn.strokes.slice(from),
        guesses: turn.guesses.map((g) => ({ name: g.n, text: g.t, ok: g.ok })),
        solvedBy: turn.solvedBy ? nameOf(m, turn.solvedBy) : null,
        skipped: turn.skipped,
        points: turn.points,
        // ---- THE ONLY PLACE THE WORD LEAVES THE SERVER FOR A PLAYER ----
        ...(isDrawer || revealed ? { word: turn.word } : {}),
      },
    };
  },

  wallProps(m: M): { view: PanelView; props: PictionaryPanelProps } | null {
    const s = m.state;
    const turn = s.turn;
    const revealed = m.phase === "reveal" || m.phase === "over";
    const props: PictionaryPanelProps = {
      phase: m.phase,
      mode: m.mode,
      round: s.round ?? 0,
      rounds: s.rounds ?? 0,
      endsAt: m.endsAt,
      players: m.players.map((p) => ({
        name: p.name,
        team: p.team,
        score: p.score,
        ...(turn && p.handle === turn.drawer && m.phase === "turn" ? { drawing: true } : {}),
      })),
      ...(m.mode === "coop" ? { shared: s.shared ?? 0 } : { teamScores: s.teamScores ?? [0, 0] }),
      ...(m.phase === "over" ? { history: s.history } : {}),
    };
    if (turn) {
      props.drawer = nameOf(m, turn.drawer);
      props.mask = maskWord(turn.word);
      props.strokes = turn.strokes;
      props.guesses = turn.guesses.map((g) => ({ name: g.n, text: g.t, ...(g.ok ? { ok: true } : {}) }));
      if (turn.solvedBy) props.solvedBy = nameOf(m, turn.solvedBy);
      // ---- THE ONLY PLACE THE WORD REACHES THE WALL ----
      // Guarded on phase, never on a viewer: there is no viewer here.
      if (revealed) {
        props.word = turn.word;
        props.points = turn.points;
      }
    }
    return { view: "pictionary", props };
  },
};

/** Exported for tests only — the shuffle helper the module leans on. */
export const __testing = {
  shuffle,
  cleanStrokes,
  guessPoints,
  setRand: (r: () => number) => {
    RAND = r;
  },
  TURN_MS,
  REVEAL_MS,
  MAX_TURNS,
};
