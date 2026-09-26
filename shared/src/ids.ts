/**
 * Central id generation. All identifiers in the lab come from here so a
 * captured session and its replay share one comparable key space
 * (determinism / traceability invariants — see docs/01-architecture.md).
 *
 * The format is a lexicographically-sortable, ULID-like id: a 48-bit
 * millisecond timestamp (Crockford base32, 10 chars) + 80 bits of randomness
 * (16 chars) = 26 chars. Sortable by creation time, collision-resistant.
 *
 * Zero dependencies. Randomness comes from an injectable source so tests are
 * deterministic.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Injectable clock + randomness for deterministic tests. */
export interface IdEnv {
  now: () => number;
  /** Fill the given array with random bytes (Web Crypto compatible). */
  randomBytes: (n: number) => Uint8Array;
}

/** Minimal structural type for the Web Crypto RNG (avoids depending on DOM lib). */
interface RandomSource {
  getRandomValues: (array: Uint8Array) => Uint8Array;
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // globalThis.crypto is available in Node >=18 and in browsers/extensions.
  const c = (globalThis as { crypto?: RandomSource }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(out);
    return out;
  }
  // Deterministic-but-non-crypto fallback (should not happen in supported runtimes).
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export const defaultIdEnv: IdEnv = {
  now: () => Date.now(),
  randomBytes: defaultRandomBytes,
};

function encodeTime(ms: number): string {
  let t = Math.max(0, Math.floor(ms));
  const chars: string[] = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[t % 32] as string;
    t = Math.floor(t / 32);
  }
  return chars.join("");
}

function encodeRandom(bytes: Uint8Array): string {
  // 16 base32 chars = 80 bits; use 10 bytes.
  let out = "";
  for (let i = 0; i < 16; i++) {
    const byte = bytes[i % bytes.length] ?? 0;
    out += CROCKFORD[byte % 32] as string;
  }
  return out;
}

/** Generate a new sortable id. */
export function newId(env: IdEnv = defaultIdEnv): string {
  return encodeTime(env.now()) + encodeRandom(env.randomBytes(16));
}

/** Prefix-tagged id, e.g. `session_01J...` — handy for logs/debugging. */
export function newPrefixedId(prefix: string, env: IdEnv = defaultIdEnv): string {
  return `${prefix}_${newId(env)}`;
}

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True if the string is a well-formed bare id (no prefix). */
export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}
