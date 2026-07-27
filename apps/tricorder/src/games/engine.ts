/**
 * The games engine (TNGC-61) — the match lifecycle every game gets for free,
 * as a PURE REDUCER.
 *
 * `reduce(match, request, now) → Outcome` has no clock, no I/O and no
 * randomness it wasn't handed. The TenantHub DO is a thin transactional shell
 * around it (see hub.ts `/game/*`), which buys two things:
 *
 *  - **exact ordering for free.** The DO is single-threaded per tenant, so two
 *    guesses 4 ms apart are serialized by arrival. No client timestamps to
 *    trust, no tie to break, no lock to take.
 *  - **the whole rules engine is unit-testable** with no miniflare, no network
 *    and no wall clock — `now` is an argument.
 *
 * One active match per tenant, under DO storage key `game:match`. A household
 * plays one game at a time, and pretending otherwise would buy nothing but
 * bugs.
 *
 * `endsAt` is universal: EVERY phase has a deadline, so the DO's alarm handling
 * is one line (`alarmAt = match?.endsAt ?? null`) instead of a per-phase
 * switch. A lobby nobody starts, and a finished board nobody clears, both get
 * reaped by the same mechanism that ends a turn.
 */
import type { PanelView } from "@tng/shared";

export type Phase = "lobby" | "turn" | "reveal" | "over";
export type GameMode = "coop" | "teams";
export type Role = "admin" | "member" | "guest";

/** Who is acting. Always derived from the session — never from a request body,
    so a player can't act as someone else (the rule calendar.ts already sets). */
export interface Actor {
  handle: string;
  name: string;
  role: Role;
}

export interface Player {
  handle: string;
  name: string;
  /** 0/1 in teams mode, null in co-op. */
  team: 0 | 1 | null;
  score: number;
  joinedAt: number;
}

export interface Match<S = unknown> {
  id: string;
  game: string;
  mode: GameMode;
  phase: Phase;
  /** Handle of whoever may start/end it. Reassigned if they leave. */
  host: string;
  /** The wall this match paints — the host's selected viewscreen at creation.
      "" means the house default. */
  wall: string;
  players: Player[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  /** When the current phase expires. Always set. */
  endsAt: number;
  /** Game-specific state, owned entirely by the game module. */
  state: S;
}

export interface FinishedMatch {
  game: string;
  mode: GameMode;
  players: number;
  /** One human line for the timeline: "Leif & Ariel — 7 of 10". */
  summary: string;
  detail: unknown;
  startedAt: number;
  endedAt: number;
}

/** What the reducer decided. Distinguishes "unchanged" from "deleted", because
    conflating them silently drops matches. */
export interface Outcome {
  /** undefined = leave storage alone; null = delete the match. */
  match?: Match | null;
  status: number;
  body: unknown;
  /** A frame for the wall. The DO throttles and drops it when offline. */
  wall?: { view: PanelView; props: unknown };
  /** A completed match to archive in D1. */
  finished?: FinishedMatch;
}

export interface GameModeSpec {
  id: GameMode;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  hint: string;
}

/** What the module returns from begin/act/expire: the next match (or null to
    end it), plus what the caller is told. */
export interface ModuleResult {
  match?: Match | null;
  status?: number;
  body?: unknown;
  finished?: FinishedMatch;
}

/**
 * One game. This interface is the WHOLE contract — a new game is this file's
 * shape in a folder, plus one line in registry.ts.
 *
 * `project` and `wallProps` are deliberately two functions rather than one
 * with a flag. They are the only places a secret may be dropped, and each is
 * named after who is looking, so a reviewer can check both in ten seconds.
 */
export interface GameModule<S = unknown> {
  /** Matches the folder name. */
  id: string;
  name: string;
  /** One line in the submenu. */
  blurb: string;
  minPlayers: number;
  maxPlayers: number;
  modes: GameModeSpec[];
  /** The mode to preselect for this headcount. */
  defaultMode(playerCount: number): GameMode;
  /** Fresh state when the host starts. Sets phase, endsAt and state. */
  begin(m: Match<S>, now: number): ModuleResult;
  /** One player action. Pure; trusts nothing but `actor`. */
  act(m: Match<S>, actor: Actor, body: Record<string, unknown>, now: number): ModuleResult;
  /** The phase deadline fired. */
  expire(m: Match<S>, now: number): ModuleResult;
  /** End the match for ANY reason — turns exhausted, the host called it, the
      roster collapsed. Must always return `finished`, because a match that
      ends is a match that gets a result row; relying on `expire` to notice
      loses the record of every game anyone stopped early. */
  conclude(m: Match<S>, now: number): ModuleResult;
  /** What THIS viewer may see. One of the two secret-dropping points. */
  project(m: Match<S>, viewer: string, since: number): unknown;
  /** What the wall may see. Never viewer-specific. The other one. */
  wallProps(m: Match<S>): { view: PanelView; props: unknown } | null;
}

export type GameRequest =
  | { kind: "read"; actor: Actor; since: number }
  | { kind: "create"; actor: Actor; game: string; mode?: GameMode; wall?: string }
  | { kind: "join"; actor: Actor }
  | { kind: "leave"; actor: Actor }
  | { kind: "shuffle"; actor: Actor }
  | { kind: "start"; actor: Actor; mode?: GameMode }
  | { kind: "end"; actor: Actor }
  | { kind: "act"; actor: Actor; body: Record<string, unknown> }
  | { kind: "expire" };

/** A lobby nobody starts is litter. */
export const LOBBY_IDLE_MS = 30 * 60_000;
/** How long a finished board stays on the wall before the match is reaped. */
export const OVER_LINGER_MS = 5 * 60_000;
/** Backstop: no match lives longer than this, whatever its phase says. */
export const MATCH_MAX_MS = 3 * 60 * 60_000;

const MAX_NAME = 40;

const err = (status: number, error: string): Outcome => ({ status, body: { error } });

/** Deterministic-enough shuffle. `crypto.getRandomValues` is available in
    workers and in node ≥19, and shuffling is the one place the engine is
    allowed to be non-pure — tests pass a seeded `rand` instead. */
export function shuffle<T>(items: T[], rand: () => number = defaultRand): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function defaultRand(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Fold a guess or a word down to what actually matters: case, accents,
    punctuation and runs of whitespace. Deliberately does NOT join words —
    "firetruck" is not "fire truck", and pretending otherwise would let a
    one-word stab win a two-word round. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edit distance, capped: anything past `max` returns max + 1, so the common
    "nowhere near" case exits early instead of filling a 40×40 matrix. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

export function findPlayer(m: Match, handle: string): Player | undefined {
  return m.players.find((p) => p.handle === handle);
}

/** Two teams, alternating, from a shuffled roster — so team strength isn't
    join order. Turn order interleaves the teams, which is what makes turns
    alternate sides without a separate scheduler. */
export function assignTeams(players: Player[], rand?: () => number): Player[] {
  const order = shuffle(players, rand);
  return order.map((p, i) => ({ ...p, team: (i % 2) as 0 | 1 }));
}

/** Draw order. Teams mode interleaves sides; co-op is just shuffled. */
export function drawOrder(players: Player[], mode: GameMode, rand?: () => number): string[] {
  if (mode !== "teams") return shuffle(players, rand).map((p) => p.handle);
  const a = players.filter((p) => p.team === 0).map((p) => p.handle);
  const b = players.filter((p) => p.team === 1).map((p) => p.handle);
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/**
 * The reducer. `modules` is the registry, injected so tests can pass a fake
 * game and so this file never imports a concrete one.
 */
export function reduce(
  match: Match | null,
  req: GameRequest,
  now: number,
  modules: Record<string, GameModule<never>>,
  rand?: () => number,
): Outcome {
  // A match past the hard ceiling is gone regardless of what its phase claims.
  if (match && now - match.createdAt > MATCH_MAX_MS) {
    match = null;
  }

  const mod = match ? modules[match.game] : undefined;
  if (match && !mod) {
    // The game was removed from the registry under a live match (a deploy
    // mid-game). Drop it rather than serve a match nothing can advance.
    return { match: null, status: 200, body: { match: null } };
  }

  switch (req.kind) {
    // ---- reads -----------------------------------------------------------
    case "read": {
      if (!match || !mod) return { status: 200, body: { match: null } };
      return { status: 200, body: { match: project(match, mod, req.actor.handle, req.since, now) } };
    }

    // ---- lifecycle -------------------------------------------------------
    case "create": {
      if (match && match.phase !== "over") {
        return err(409, `a ${modules[match.game]?.name ?? match.game} match is already running`);
      }
      const target = modules[req.game];
      if (!target) return err(404, "no such game");
      const mode = req.mode ?? target.defaultMode(1);
      if (!target.modes.some((m) => m.id === mode)) return err(400, "no such mode");
      const created: Match = {
        id: newId(),
        game: target.id,
        mode,
        phase: "lobby",
        host: req.actor.handle,
        wall: typeof req.wall === "string" ? req.wall.slice(0, 32) : "",
        players: [
          {
            handle: req.actor.handle,
            name: req.actor.name.slice(0, MAX_NAME),
            team: null,
            score: 0,
            joinedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
        endsAt: now + LOBBY_IDLE_MS,
        state: {},
      };
      return {
        match: created,
        status: 201,
        body: { match: project(created, target, req.actor.handle, 0, now) },
      };
    }

    case "join": {
      if (!match || !mod) return err(404, "no match to join");
      if (findPlayer(match, req.actor.handle)) {
        // Rejoin: a phone that died mid-game comes back to exactly its seat.
        return { status: 200, body: { match: project(match, mod, req.actor.handle, 0, now) } };
      }
      if (match.phase !== "lobby") return err(409, "that game has already started");
      if (match.players.length >= mod.maxPlayers) {
        return err(409, `${mod.name} tops out at ${mod.maxPlayers} players`);
      }
      const next: Match = {
        ...match,
        players: [
          ...match.players,
          {
            handle: req.actor.handle,
            name: req.actor.name.slice(0, MAX_NAME),
            team: null,
            score: 0,
            joinedAt: now,
          },
        ],
        updatedAt: now,
        endsAt: now + LOBBY_IDLE_MS,
      };
      return {
        match: next,
        status: 200,
        body: { match: project(next, mod, req.actor.handle, 0, now) },
        wall: mod.wallProps(next as Match<never>) ?? undefined,
      };
    }

    case "leave": {
      if (!match || !mod) return err(404, "no match");
      if (!findPlayer(match, req.actor.handle)) return err(409, "you are not in this match");
      const players = match.players.filter((p) => p.handle !== req.actor.handle);
      if (players.length === 0) return { match: null, status: 200, body: { match: null } };
      let next: Match = {
        ...match,
        players,
        host: match.host === req.actor.handle ? players[0].handle : match.host,
        updatedAt: now,
      };
      // Mid-game, dropping under the floor ends it — a two-player game with
      // one player left is not a game.
      if (next.phase !== "lobby" && next.phase !== "over" && players.length < mod.minPlayers) {
        const ended = mod.conclude(next as Match<never>, now);
        const over = forceOver(ended.match ?? next, now);
        return {
          match: over,
          status: 200,
          body: { match: null, note: "not enough players left — match ended" },
          wall: mod.wallProps(over as Match<never>) ?? undefined,
          finished: ended.finished,
        };
      }
      if (next.phase === "lobby") next = { ...next, endsAt: now + LOBBY_IDLE_MS };
      return {
        match: next,
        status: 200,
        body: { match: null },
        wall: mod.wallProps(next as Match<never>) ?? undefined,
      };
    }

    case "shuffle": {
      if (!match || !mod) return err(404, "no match");
      if (match.host !== req.actor.handle) return err(403, "only the host can shuffle teams");
      if (match.phase !== "lobby") return err(409, "teams are locked once the game starts");
      if (match.mode !== "teams") return err(409, "co-op has no teams to shuffle");
      const next: Match = {
        ...match,
        players: assignTeams(match.players, rand),
        updatedAt: now,
        endsAt: now + LOBBY_IDLE_MS,
      };
      return { match: next, status: 200, body: { match: project(next, mod, req.actor.handle, 0, now) } };
    }

    case "start": {
      if (!match || !mod) return err(404, "no match");
      if (match.host !== req.actor.handle) return err(403, "only the host can start the game");
      if (match.phase !== "lobby") return err(409, "already started");
      const mode = req.mode ?? match.mode;
      const spec = mod.modes.find((m) => m.id === mode);
      if (!spec) return err(400, "no such mode");
      const count = match.players.length;
      if (count < spec.minPlayers) {
        return err(409, `${spec.name} needs at least ${spec.minPlayers} players — you have ${count}`);
      }
      if (count > spec.maxPlayers) {
        return err(409, `${spec.name} tops out at ${spec.maxPlayers} players`);
      }
      const seeded: Match = {
        ...match,
        mode,
        players: mode === "teams" ? assignTeams(match.players, rand) : match.players.map((p) => ({ ...p, team: null })),
        startedAt: now,
        updatedAt: now,
      };
      const res = mod.begin(seeded as Match<never>, now);
      const started = res.match ?? seeded;
      return {
        match: started,
        status: 200,
        body: { match: project(started, mod, req.actor.handle, 0, now) },
        wall: mod.wallProps(started as Match<never>) ?? undefined,
      };
    }

    case "end": {
      if (!match || !mod) return err(404, "no match");
      if (match.host !== req.actor.handle && req.actor.role !== "admin") {
        return err(403, "only the host or an admin can end the game");
      }
      // A lobby nobody played has no result worth keeping; anything further
      // along gets concluded properly so the score survives the decision to
      // stop.
      const res =
        match.phase === "over" || match.phase === "lobby"
          ? ({} as ReturnType<typeof mod.conclude>)
          : mod.conclude(match as Match<never>, now);
      const over = forceOver(res.match ?? match, now);
      return {
        match: over,
        status: 200,
        body: { match: null },
        wall: mod.wallProps(over as Match<never>) ?? undefined,
        finished: res.finished,
      };
    }

    // ---- play ------------------------------------------------------------
    case "act": {
      if (!match || !mod) return err(404, "no match");
      if (!findPlayer(match, req.actor.handle)) return err(403, "you are not in this match");
      if (match.phase === "lobby" || match.phase === "over") {
        return err(409, "nothing to do in this phase");
      }
      const res = mod.act(match as Match<never>, req.actor, req.body, now);
      const next = res.match === undefined ? undefined : res.match;
      const view = next ?? match;
      return {
        ...(next !== undefined ? { match: next } : {}),
        status: res.status ?? 200,
        body:
          res.body ??
          (view ? { match: project(view, mod, req.actor.handle, 0, now) } : { match: null }),
        wall: next && next !== null ? (mod.wallProps(next as Match<never>) ?? undefined) : undefined,
        finished: res.finished,
      };
    }

    // ---- the clock -------------------------------------------------------
    case "expire": {
      if (!match || !mod) return { match: null, status: 200, body: { ok: true } };
      if (now < match.endsAt) return { status: 200, body: { ok: true, early: true } };
      if (match.phase === "lobby") {
        // Nobody ever started it.
        return { match: null, status: 200, body: { ok: true, reaped: "lobby" } };
      }
      if (match.phase === "over") {
        return { match: null, status: 200, body: { ok: true, reaped: "over" } };
      }
      const res = mod.expire(match as Match<never>, now);
      const next = res.match === undefined ? match : res.match;
      return {
        match: next,
        status: 200,
        body: { ok: true },
        wall: next ? (mod.wallProps(next as Match<never>) ?? undefined) : undefined,
        finished: res.finished,
      };
    }
  }
}

/** Force a match into `over` without asking the module twice — used when the
    host bails or the roster collapses. */
function forceOver(m: Match, now: number): Match {
  return { ...m, phase: "over", updatedAt: now, endsAt: now + OVER_LINGER_MS };
}

/** The envelope every projection shares, plus the module's own view. `now` is
    included so a phone with a wrong clock still renders the right countdown. */
function project(m: Match, mod: GameModule<never>, viewer: string, since: number, now: number): unknown {
  const you = findPlayer(m, viewer);
  return {
    id: m.id,
    game: m.game,
    gameName: mod.name,
    mode: m.mode,
    phase: m.phase,
    host: m.host,
    isHost: m.host === viewer,
    joined: !!you,
    endsAt: m.endsAt,
    now,
    minPlayers: mod.minPlayers,
    maxPlayers: mod.maxPlayers,
    modes: mod.modes,
    players: m.players.map((p) => ({ handle: p.handle, name: p.name, team: p.team, score: p.score })),
    ...(mod.project(m as Match<never>, viewer, since) as Record<string, unknown>),
  };
}
