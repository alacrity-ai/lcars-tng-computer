/**
 * Password + token primitives for the Tricorder identity plane (TNGC-15).
 *
 * Passwords: PBKDF2-SHA256, 100k iterations (the Workers runtime cap), 16-byte
 * salt, stored as `pbkdf2$<iterations>$<saltHex>$<hashHex>`. Session tokens:
 * 32 random bytes, stored as SHA-256 hex — same at-rest rule as the service
 * token in `tenants`.
 */

const PBKDF2_ITERATIONS = 100_000;

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (hex: string): Uint8Array =>
  new Uint8Array(hex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []);

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return toHex(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltHex, expected] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterStr || !saltHex || !expected) return false;
  const actual = await pbkdf2(password, fromHex(saltHex), Number(iterStr));
  // Both sides are derived hex of fixed length; timing here is not attacker-observable
  // enough to matter, but compare full length anyway.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `tri_${b64}`;
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

// Word-pair guest passwords: easy to read off a screen at a party, easy to
// rotate afterwards. ~48^2 * 90 combos — brute force is handled by the login
// cooldown, rotation is the real defense.
const WORDS = [
  "warp", "nebula", "photon", "quasar", "pulsar", "comet", "orbit", "cosmos",
  "vector", "plasma", "ion", "nova", "astro", "lunar", "solar", "stellar",
  "galaxy", "meteor", "saturn", "vulcan", "andor", "rigel", "deneb", "vega",
  "altair", "sirius", "helios", "titan", "europa", "callisto", "phoebe", "atlas",
  "aurora", "zenith", "apogee", "cosmic", "radiant", "quantum", "tachyon", "sensor",
  "beacon", "signal", "relay", "console", "deck", "shuttle", "starbase", "impulse",
];

export function guestPassword(): string {
  const rand = crypto.getRandomValues(new Uint32Array(3));
  const a = WORDS[rand[0] % WORDS.length];
  const b = WORDS[rand[1] % WORDS.length];
  const n = 10 + (rand[2] % 90);
  return `${a}-${b}-${n}`;
}
