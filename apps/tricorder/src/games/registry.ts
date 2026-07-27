/**
 * The game registry (TNGC-61).
 *
 * ADDING A GAME IS TWO THINGS: a folder under `games/` exporting a
 * `GameModule`, and one line here. Nothing else in the codebase needs to know
 * a new game exists — the routes, the DO shell, the alarm, the wall push and
 * the submenu all read from this map.
 *
 * The wall panel is the one exception: a game with its own board also needs a
 * panel view (see docs/sops/adding-new-panels.md) and a line in MACHINE_VIEWS
 * so the model can't display it out of nowhere.
 */
import type { GameModule } from "./engine";
import { pictionary } from "./pictionary";

export const GAME_REGISTRY: Record<string, GameModule<never>> = {
  [pictionary.id]: pictionary as unknown as GameModule<never>,
};

/** What the submenu lists. */
export function catalog(): Array<{
  id: string;
  name: string;
  blurb: string;
  minPlayers: number;
  maxPlayers: number;
  modes: GameModule["modes"];
}> {
  return Object.values(GAME_REGISTRY).map((g) => ({
    id: g.id,
    name: g.name,
    blurb: g.blurb,
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
    modes: g.modes,
  }));
}
