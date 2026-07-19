/**
 * Template test for the deterministic RNG — copy into a game's tests/.
 *
 * The single most important P2P invariant: two peers seeded identically must
 * produce byte-identical streams, shuffles, and picks. If this ever fails, every
 * client desyncs. Games that rely on shared randomness MUST keep a test like
 * this green.
 */
import { describe, expect, it } from 'vitest';
import { makeRng, hashSeed, randInt, shuffle, pick } from '../src/rng';

describe('makeRng determinism (P2P sync invariant)', () => {
  it('produces an identical stream for the same numeric seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const seqA = Array.from({ length: 100 }, () => a());
    const seqB = Array.from({ length: 100 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces an identical stream for the same string seed', () => {
    const a = makeRng('room-AB12');
    const b = makeRng('room-AB12');
    expect(Array.from({ length: 50 }, () => a())).toEqual(Array.from({ length: 50 }, () => b()));
  });

  it('diverges for different seeds', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    expect(a()).not.toEqual(b());
  });

  it('stays within [0,1)', () => {
    const r = makeRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  it('is stable and unsigned 32-bit', () => {
    const h = hashSeed('hello');
    expect(h).toBe(hashSeed('hello'));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('shuffle / randInt / pick are deterministic per seed', () => {
  it('shuffles identically across two peers', () => {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const p1 = shuffle(makeRng('seed'), deck);
    const p2 = shuffle(makeRng('seed'), deck);
    expect(p1).toEqual(p2);
    // is a true permutation, not a no-op
    expect([...p1].sort((x, y) => x - y)).toEqual(deck);
    expect(p1).not.toEqual(deck);
  });

  it('randInt stays in range and matches across peers', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 100; i++) {
      const x = randInt(a, 1, 6);
      expect(randInt(b, 1, 6)).toBe(x);
      expect(x).toBeGreaterThanOrEqual(1);
      expect(x).toBeLessThanOrEqual(6);
    }
  });

  it('pick agrees across peers', () => {
    const opts = ['red', 'green', 'blue', 'gold'];
    const a = makeRng('x');
    const b = makeRng('x');
    expect(pick(a, opts)).toBe(pick(b, opts));
  });
});
