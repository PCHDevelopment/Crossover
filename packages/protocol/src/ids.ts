import { randomFillSync } from "node:crypto";

/** Entity ID prefixes (ENGINEERING.md, T105). */
export const ID_PREFIXES = [
  "room",
  "ws",
  "part",
  "task",
  "dec",
  "mem",
  "msg",
  "inbox",
  "cs",
  "conf",
  "rev",
  "inv",
  "usr",
  "cmd",
  "evt",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

let lastTime = -1;
let lastRandom: number[] = [];

function randomChars(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  randomFillSync(bytes);
  return Array.from(bytes, (b) => b % 32);
}

/** Add one to a base-32 digit array in place; false on overflow. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i]! < 31) {
      digits[i]!++;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

function encodeTime(time: number): string {
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[time % 32]! + out;
    time = Math.floor(time / 32);
  }
  return out;
}

/**
 * Monotonic ULID: IDs generated within the same millisecond (in one process)
 * increment the random part, so they sort in creation order.
 */
function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ULID timestamp out of range: ${now}`);
  }
  if (now <= lastTime) {
    // Same ms (or the clock stepped back): keep ordering by bumping the last value.
    if (!increment(lastRandom)) {
      lastTime++;
      lastRandom = randomChars();
    }
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET[d]).join("");
}

/** Generate a prefixed ULID, e.g. `room_01J…`. */
export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${ulid()}`;
}

/** True when `value` is a well-formed ID with exactly the given prefix. */
export function isId<P extends IdPrefix>(value: unknown, prefix: P): value is Id<P> {
  if (typeof value !== "string") return false;
  const sep = value.indexOf("_");
  if (sep === -1 || value.slice(0, sep) !== prefix) return false;
  return ULID_RE.test(value.slice(sep + 1));
}
