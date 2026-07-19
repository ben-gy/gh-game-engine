/**
 * rng.ts — deterministic, seedable pseudo-random numbers.
 *
 * The host generates a seed once and broadcasts it in the lobby; every peer
 * constructs an identical RNG from it, so shuffled decks, spawn positions,
 * board layouts, and loot are IDENTICAL on all clients without syncing every
 * value. Essential for lockstep games and for keeping host/client agreement in
 * host-authoritative games. Never use Math.random() for anything gameplay peers
 * must agree on.
 *
 * mulberry32 is tiny, fast, and has good statistical quality for games.
 */

export type Rng = () => number;

/** Hash an arbitrary string into a 32-bit seed (xmur3). */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** A mulberry32 generator. Returns floats in [0, 1). Deterministic per seed. */
export function makeRng(seed: number | string): Rng {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Float in [min, max). */
export function randFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Pick one element. Assumes a non-empty array. */
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fisher–Yates shuffle. Returns a NEW array; input is untouched. */
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A fresh seed to broadcast from the host. Not for security — for agreement. */
export function newSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
