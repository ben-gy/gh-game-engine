/**
 * sound.ts — procedural sound effects via the Web Audio API. Zero asset files.
 *
 * Generating SFX from oscillators keeps the bundle tiny and the site offline —
 * no .mp3/.wav to host, no CDN, no CORS. Enough "juice" for arcade feel: blips,
 * zaps, explosions, coins, jumps. Call sfx.unlock() from the first user gesture
 * (browsers block audio until then), then sfx.play('coin').
 *
 * ── GAME-SPECIFIC CUES ──────────────────────────────────────────────────────
 * Pass your own patches through the config and they merge over the defaults:
 *
 *   const sfx = createSfx({ muted, patches: {
 *     eat:   { type: 'square',   freq: [520, 880], dur: 0.08, gain: 0.2 },
 *     crash: { type: 'sawtooth', freq: [220, 40],  dur: 0.4,  gain: 0.3, noise: true },
 *   }});
 *   sfx.play('eat');
 *   sfx.play('eat', { pitch: 1.5 });   // same patch, transposed
 *
 * This existed as a promise in this comment long before it existed in the code,
 * and the gap was the single biggest cause of forks in the fleet: eight games
 * kept a local copy of this file for no reason other than needing their own cue
 * names, because `SfxName` was a CLOSED union of platformer sounds and a card
 * game importing the engine would play "coin" when a card landed. Two of them
 * also hand-rolled a pitch argument. Hence `patches`, a `string` cue name, and
 * `play(name, { pitch })`.
 *
 * IMPORT from '@ben-gy/game-engine/sound' — do not copy it in.
 */

/**
 * A cue name. Deliberately `string` rather than a union: the engine cannot know
 * what a game's cues are called, and a closed union is what forced games to fork
 * this file. The built-in names are in `DEFAULT_PATCHES` / `BUILT_IN_CUES`.
 */
export type SfxName = string;

export interface Patch {
  type: OscillatorType;
  /** [startFreq, endFreq] Hz — glides between them over `dur`. */
  freq: [number, number];
  dur: number;
  /** Peak gain 0..1. */
  gain?: number;
  /** Add a short noise burst (explosions/hits). */
  noise?: boolean;
}

/**
 * The built-in cues.
 *
 * `beat` and `go` are here because principle #15 makes a 3-2-1-GO countdown
 * MANDATORY in every multiplayer game — six of the eight forked copies defined
 * their own pair, which is the engine failing to supply a sound for a thing the
 * engine requires.
 */
export const DEFAULT_PATCHES: Record<string, Patch> = {
  blip: { type: 'square', freq: [440, 620], dur: 0.06, gain: 0.2 },
  select: { type: 'triangle', freq: [520, 880], dur: 0.09, gain: 0.22 },
  coin: { type: 'square', freq: [880, 1320], dur: 0.12, gain: 0.2 },
  jump: { type: 'sine', freq: [320, 720], dur: 0.16, gain: 0.25 },
  hit: { type: 'sawtooth', freq: [300, 90], dur: 0.14, gain: 0.28, noise: true },
  explosion: { type: 'sawtooth', freq: [180, 40], dur: 0.5, gain: 0.35, noise: true },
  powerup: { type: 'square', freq: [520, 1040], dur: 0.3, gain: 0.22 },
  lose: { type: 'sawtooth', freq: [400, 120], dur: 0.5, gain: 0.3 },
  win: { type: 'triangle', freq: [520, 1040], dur: 0.5, gain: 0.28 },
  /** Countdown tick (3, 2, 1). */
  beat: { type: 'triangle', freq: [660, 660], dur: 0.09, gain: 0.2 },
  /** Countdown release (GO). */
  go: { type: 'triangle', freq: [880, 1320], dur: 0.22, gain: 0.26 },
};

/** The cue names the engine ships. A game may add to these, or override them. */
export const BUILT_IN_CUES = Object.keys(DEFAULT_PATCHES);

export interface PlayOptions {
  /**
   * Multiply every frequency in the patch. 2 is an octave up, 0.5 an octave
   * down. Lets one patch carry a rising combo, a size, or a depth without
   * defining a patch per step.
   */
  pitch?: number;
  /** Scale the patch's gain for this one play. */
  gain?: number;
}

export interface Sfx {
  unlock(): void;
  play(name: SfxName, opts?: PlayOptions): void;
  muted(): boolean;
  setMuted(m: boolean): void;
  /** Add or replace patches after construction. */
  addPatches(patches: Record<string, Patch>): void;
  /** True when a cue is known — a game can assert its own cue table at boot. */
  has(name: SfxName): boolean;
}

export interface SfxConfig {
  muted?: boolean;
  /**
   * Game cues, merged OVER the defaults. Reusing a built-in name replaces it,
   * which is how a card game stops "coin" sounding like a platformer.
   */
  patches?: Record<string, Patch>;
}

/**
 * `createSfx(true)` (the original positional signature) still works — roughly
 * thirty games call it that way and a shared package does not get to break them.
 */
export function createSfx(config: boolean | SfxConfig = false): Sfx {
  const cfg: SfxConfig = typeof config === 'boolean' ? { muted: config } : config;
  const patches: Record<string, Patch> = { ...DEFAULT_PATCHES, ...(cfg.patches ?? {}) };

  let ctx: AudioContext | null = null;
  let muted = cfg.muted ?? false;

  const ensure = (): AudioContext | null => {
    if (!ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  };

  const noiseBuffer = (ac: AudioContext, dur: number): AudioBuffer => {
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  };

  return {
    unlock() {
      ensure();
    },

    play(name, opts) {
      if (muted) return;
      const p = patches[name];
      // A cue name that does not exist is silent, never a crash. Audio is juice;
      // a typo in a cue name must not be able to take the game down with it.
      if (!p) return;
      const ac = ensure();
      if (!ac) return;

      const pitch = opts?.pitch && opts.pitch > 0 ? opts.pitch : 1;
      const gain = Math.max(0, Math.min(1, (p.gain ?? 0.25) * (opts?.gain ?? 1)));
      const t0 = ac.currentTime;

      const g = ac.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
      g.connect(ac.destination);

      const osc = ac.createOscillator();
      osc.type = p.type;
      // Clamped to the audible/representable range: exponentialRampToValueAtTime
      // throws on a non-positive target, and a wild pitch multiplier should not
      // be able to produce one.
      const f0 = Math.max(1, Math.min(20000, p.freq[0] * pitch));
      const f1 = Math.max(1, Math.min(20000, p.freq[1] * pitch));
      osc.frequency.setValueAtTime(f0, t0);
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + p.dur);
      osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + p.dur);

      if (p.noise) {
        const n = ac.createBufferSource();
        n.buffer = noiseBuffer(ac, p.dur);
        const ng = ac.createGain();
        ng.gain.setValueAtTime(gain * 0.6, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.dur);
        n.connect(ng);
        ng.connect(ac.destination);
        n.start(t0);
        n.stop(t0 + p.dur);
      }
    },

    muted: () => muted,

    setMuted(m) {
      muted = m;
    },

    addPatches(extra) {
      Object.assign(patches, extra);
    },

    has: (name) => !!patches[name],
  };
}
