/**
 * The pictionary word list (TNGC-62).
 *
 * Built in on purpose: the game has to be complete with the Computer switched
 * off, so the words ship with the Worker rather than coming from the brain.
 * Model-generated themed packs are a later ticket, and they would generate a
 * whole pack BEFORE a match — never inside the loop.
 *
 * The bar for a word here is "someone can draw this in ninety seconds with a
 * finger". Abstractions, proper nouns and anything that needs writing are out.
 */

export type Band = "easy" | "medium" | "hard";

export const WORDS: Record<Band, string[]> = {
  easy: [
    "cat", "dog", "house", "tree", "sun", "moon", "star", "fish", "boat", "car",
    "hat", "shoe", "cup", "book", "chair", "table", "door", "key", "clock", "ball",
    "apple", "banana", "cake", "pizza", "egg", "cheese", "bread", "carrot", "flower", "leaf",
    "cloud", "rain", "snowman", "fire", "mountain", "river", "bridge", "ladder", "hammer", "pencil",
    "glasses", "umbrella", "balloon", "kite", "drum", "guitar", "bell", "candle", "spoon", "fork",
    "sock", "shirt", "crown", "ring", "bed", "lamp", "window", "phone", "camera", "rocket",
    "train", "bicycle", "bus", "plane", "duck", "bird", "snake", "spider", "bee", "frog",
    "bone", "eye", "hand", "foot", "smile", "heart", "arrow", "box", "brush", "wheel",
  ],
  medium: [
    "lighthouse", "windmill", "treehouse", "campfire", "waterfall", "volcano", "island", "desert", "cactus", "igloo",
    "castle", "pyramid", "tent", "barn", "mailbox", "fence", "swing", "slide", "seesaw", "hammock",
    "telescope", "microscope", "hourglass", "compass", "anchor", "lantern", "toolbox", "wrench", "screwdriver", "magnet",
    "octopus", "jellyfish", "seahorse", "starfish", "penguin", "owl", "peacock", "flamingo", "hedgehog", "squirrel",
    "elephant", "giraffe", "kangaroo", "dolphin", "whale", "shark", "crab", "turtle", "butterfly", "ladybug",
    "sandwich", "popcorn", "pancakes", "spaghetti", "ice cream", "donut", "pineapple", "watermelon", "strawberry", "mushroom",
    "backpack", "suitcase", "wallet", "toothbrush", "hairbrush", "mirror", "scissors", "stapler", "envelope", "stamp",
    "skateboard", "surfboard", "parachute", "helicopter", "submarine", "tractor", "ambulance", "fire truck", "traffic light", "roundabout",
    "snowflake", "rainbow", "tornado", "iceberg", "beehive", "birdcage", "fishbowl", "sandcastle", "scarecrow", "wheelbarrow",
  ],
  hard: [
    "escalator", "revolving door", "vending machine", "washing machine", "microwave", "printer", "keyboard", "satellite", "wind turbine", "solar panel",
    "roller coaster", "ferris wheel", "carousel", "trampoline", "diving board", "bowling alley", "chess board", "dartboard", "pinball", "jigsaw puzzle",
    "chandelier", "fireplace", "staircase", "elevator", "balcony", "greenhouse", "aquarium", "observatory", "drawbridge", "watchtower",
    "stethoscope", "wheelchair", "crutches", "bandage", "syringe", "thermometer", "first aid kit", "fire extinguisher", "life jacket", "megaphone",
    "typewriter", "gramophone", "accordion", "trombone", "harp", "xylophone", "metronome", "conductor", "orchestra", "marching band",
    "avalanche", "earthquake", "eclipse", "constellation", "galaxy", "black hole", "space station", "moon landing", "time machine", "hot air balloon",
    "traffic jam", "queue", "recycling", "laundry day", "spring cleaning", "moving house", "camping trip", "birthday party", "graduation", "wedding cake",
  ],
};

/** Turn count decides how hard the words get: openers are easy, the last third
    is where you earn it. */
export function bandForTurn(turn: number, total: number): Band {
  const p = total <= 1 ? 0 : (turn - 1) / (total - 1);
  if (p < 0.34) return "easy";
  if (p < 0.72) return "medium";
  return "hard";
}

/**
 * Pick a word for this turn, avoiding everything already used. Falls back
 * across bands (and finally to the whole list) rather than ever returning
 * nothing — a match longer than one band is normal.
 */
export function pickWord(turn: number, total: number, used: string[], rand: () => number): string {
  const seen = new Set(used);
  const first = bandForTurn(turn, total);
  const order: Band[] = first === "easy" ? ["easy", "medium", "hard"] : first === "medium" ? ["medium", "hard", "easy"] : ["hard", "medium", "easy"];
  for (const band of order) {
    const pool = WORDS[band].filter((w) => !seen.has(w));
    if (pool.length) return pool[Math.floor(rand() * pool.length)];
  }
  // Every word in the list used — a 240-turn match. Repeat rather than fail.
  const all = [...WORDS.easy, ...WORDS.medium, ...WORDS.hard];
  return all[Math.floor(rand() * all.length)];
}

/** Underscores for letters, spaces and hyphens kept, so the mask still shows
    the shape: "fire truck" → "____ _____". */
export function maskWord(word: string): string {
  return word.replace(/[^\s-]/g, "_");
}
