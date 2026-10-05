/**
 * ids.ts — Persistent, sortable identifiers for everything M3GAN remembers.
 *
 * M3GAN spec §75: every entity gets a persistent id and nothing depends on a
 * visible name, which can change, repeat or be misheard. The format is
 * `<prefix>_<ULID>`: the prefix says what the id names (`person_`, `object_`,
 * `episode_`), and the ULID sorts by creation time, so logs and stores order
 * correctly without a separate timestamp.
 *
 * ULID: 48 bits of millisecond time + 80 bits of randomness, Crockford base32.
 * Within the same millisecond the random part is incremented, so ids minted in
 * a burst still sort in creation order.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_CHARS);
  return [...bytes].map((b) => b % 32);
}

/** Increment the base32 digits as one big number; on overflow start fresh. */
function increment(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i--) {
    if ((next[i] as number) < 31) {
      next[i] = (next[i] as number) + 1;
      return next;
    }
    next[i] = 0;
  }
  return freshRandom();
}

/** A ULID for `nowMs`. Monotonic within a process. */
export function ulid(nowMs: number = Date.now()): string {
  if (nowMs === lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = nowMs;
    lastRandom = freshRandom();
  }
  return encodeTime(nowMs) + lastRandom.map((d) => ALPHABET[d]).join("");
}

const PREFIX = /^[a-z][a-z0-9]*$/u;

/** `<prefix>_<ULID>`, e.g. `person_01JABCDXYZ...`. */
export function newEntityId(prefix: string, nowMs?: number): string {
  if (!PREFIX.test(prefix)) {
    throw new Error(`Invalid id prefix: ${prefix}`);
  }
  return `${prefix}_${ulid(nowMs)}`;
}

/** Milliseconds encoded in an id's ULID, or undefined when it is not one. */
export function idTimeMs(id: string): number | undefined {
  const match = /_([0-9A-HJKMNP-TV-Z]{26})$/u.exec(id);
  if (!match?.[1]) {
    return undefined;
  }
  let ms = 0;
  for (const ch of match[1].slice(0, TIME_CHARS)) {
    ms = ms * 32 + ALPHABET.indexOf(ch);
  }
  return ms;
}
