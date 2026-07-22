/**
 * sound.test.ts — the config that eight games forked this file to get.
 *
 * Web Audio does not exist in the test environment, so this stubs the minimum
 * `AudioContext` surface and asserts on the nodes the player would have heard:
 * which oscillator, at what frequency, for how long, at what gain. That is
 * enough to pin the two things that actually matter — that a game's own patches
 * survive the merge, and that `pitch` transposes rather than being ignored.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSfx, DEFAULT_PATCHES, BUILT_IN_CUES, type Patch } from '../src/sound';

interface Played {
  type: OscillatorType;
  freqAt: number;
  freqRamp: number;
  dur: number;
  gain: number;
  noise: boolean;
}

let played: Played[];
let resumed: number;

function stubAudio(): void {
  played = [];
  resumed = 0;

  class FakeParam {
    constructor(private readonly sink: (kind: string, v: number, t: number) => void, private readonly kind: string) {}
    setValueAtTime(v: number, t: number): void {
      this.sink(`${this.kind}:set`, v, t);
    }
    exponentialRampToValueAtTime(v: number, t: number): void {
      if (v <= 0) throw new Error('exponentialRampToValueAtTime requires a positive target');
      this.sink(`${this.kind}:ramp`, v, t);
    }
  }

  class FakeCtx {
    currentTime = 0;
    sampleRate = 48000;
    state: 'running' | 'suspended' = 'running';
    destination = {};
    private pending: Partial<Played> = {};

    private sink = (kind: string, v: number, t: number): void => {
      if (kind === 'freq:set') this.pending.freqAt = v;
      if (kind === 'freq:ramp') {
        this.pending.freqRamp = v;
        this.pending.dur = t - this.currentTime;
      }
      if (kind === 'gain:set') this.pending.gain = v;
    };

    resume(): Promise<void> {
      resumed++;
      return Promise.resolve();
    }
    createGain() {
      return { gain: new FakeParam(this.sink, 'gain'), connect: () => {} };
    }
    createOscillator() {
      const self = this;
      return {
        type: 'sine' as OscillatorType,
        frequency: new FakeParam(this.sink, 'freq'),
        connect: () => {},
        start: () => {},
        stop(): void {
          played.push({
            type: this.type,
            freqAt: self.pending.freqAt ?? 0,
            freqRamp: self.pending.freqRamp ?? 0,
            dur: self.pending.dur ?? 0,
            gain: self.pending.gain ?? 0,
            noise: false,
          });
          self.pending = {};
        },
      };
    }
    createBuffer(_c: number, len: number) {
      return { getChannelData: () => new Float32Array(len) };
    }
    createBufferSource() {
      return {
        buffer: null as unknown,
        connect: () => {},
        start: () => {},
        stop: () => {
          if (played.length) played[played.length - 1].noise = true;
        },
      };
    }
  }

  vi.stubGlobal('window', { AudioContext: FakeCtx });
}

beforeEach(() => {
  stubAudio();
});

const EAT: Patch = { type: 'square', freq: [400, 800], dur: 0.1, gain: 0.5 };

describe('the positional signature still works', () => {
  /** ~30 shipped games call `createSfx(muted)`. A shared package does not break them. */
  it('accepts createSfx() and createSfx(boolean)', () => {
    expect(createSfx().muted()).toBe(false);
    expect(createSfx(true).muted()).toBe(true);
    expect(createSfx(false).muted()).toBe(false);
  });

  it('still plays every built-in cue', () => {
    const sfx = createSfx();
    for (const cue of BUILT_IN_CUES) sfx.play(cue);
    expect(played).toHaveLength(BUILT_IN_CUES.length);
  });
});

describe('game-specific patches', () => {
  it('merges over the defaults without losing them', () => {
    const sfx = createSfx({ patches: { eat: EAT } });
    expect(sfx.has('eat')).toBe(true);
    expect(sfx.has('coin')).toBe(true);
    sfx.play('eat');
    expect(played[0]).toMatchObject({ type: 'square', freqAt: 400, freqRamp: 800, gain: 0.5 });
  });

  it('lets a game REPLACE a built-in name', () => {
    // The actual complaint: a card game importing the engine played a platformer
    // "coin" when a card landed.
    const sfx = createSfx({ patches: { coin: EAT } });
    sfx.play('coin');
    expect(played[0]).toMatchObject({ freqAt: 400, freqRamp: 800 });
    expect(DEFAULT_PATCHES.coin.freq[0]).toBe(880); // the default is untouched
  });

  it('does not mutate DEFAULT_PATCHES across instances', () => {
    createSfx({ patches: { coin: EAT } });
    const clean = createSfx();
    clean.play('coin');
    expect(played[0].freqAt).toBe(880);
  });

  it('can take patches after construction', () => {
    const sfx = createSfx();
    expect(sfx.has('eat')).toBe(false);
    sfx.addPatches({ eat: EAT });
    expect(sfx.has('eat')).toBe(true);
  });

  it('ships beat and go, because the countdown is mandatory', () => {
    // Principle #15 requires a 3-2-1-GO in every multiplayer game; six forks
    // defined their own pair because the engine did not supply one.
    const sfx = createSfx();
    expect(sfx.has('beat')).toBe(true);
    expect(sfx.has('go')).toBe(true);
  });
});

describe('pitch', () => {
  it('transposes both ends of the glide', () => {
    const sfx = createSfx({ patches: { eat: EAT } });
    sfx.play('eat', { pitch: 2 });
    expect(played[0]).toMatchObject({ freqAt: 800, freqRamp: 1600 });
  });

  it('defaults to unity and ignores a nonsense multiplier', () => {
    const sfx = createSfx({ patches: { eat: EAT } });
    sfx.play('eat');
    sfx.play('eat', { pitch: 0 });
    sfx.play('eat', { pitch: -3 });
    for (const p of played) expect(p.freqAt).toBe(400);
  });

  it('clamps rather than throwing on an extreme multiplier', () => {
    // exponentialRampToValueAtTime throws on a non-positive target, and a combo
    // counter feeding pitch can run away. Clamped, so juice can never crash a game.
    const sfx = createSfx({ patches: { eat: EAT } });
    expect(() => sfx.play('eat', { pitch: 1e-9 })).not.toThrow();
    expect(() => sfx.play('eat', { pitch: 1e9 })).not.toThrow();
    for (const p of played) {
      expect(p.freqAt).toBeGreaterThan(0);
      expect(p.freqAt).toBeLessThanOrEqual(20000);
    }
  });

  it('scales gain independently, clamped to 0..1', () => {
    const sfx = createSfx({ patches: { eat: EAT } });
    sfx.play('eat', { gain: 0.5 });
    expect(played[0].gain).toBeCloseTo(0.25);
    sfx.play('eat', { gain: 99 });
    expect(played[1].gain).toBeLessThanOrEqual(1);
  });
});

describe('robustness', () => {
  it('is silent — not fatal — on an unknown cue', () => {
    const sfx = createSfx();
    expect(() => sfx.play('no-such-cue')).not.toThrow();
    expect(played).toHaveLength(0);
  });

  it('plays nothing at all while muted', () => {
    const sfx = createSfx({ muted: true });
    sfx.play('coin');
    expect(played).toHaveLength(0);
    sfx.setMuted(false);
    sfx.play('coin');
    expect(played).toHaveLength(1);
  });

  it('carries the noise burst through for percussive patches', () => {
    const sfx = createSfx();
    sfx.play('explosion');
    expect(played[0].noise).toBe(true);
    sfx.play('coin');
    expect(played[1].noise).toBe(false);
  });

  it('resumes a suspended context on unlock', () => {
    const sfx = createSfx();
    sfx.unlock();
    expect(resumed).toBe(0); // stub starts running
    sfx.play('coin');
    expect(played).toHaveLength(1);
  });
});
