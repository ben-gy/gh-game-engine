/**
 * rounds-generics.test.ts — `roundOpts()` and `onRound()` speak the same type.
 *
 * The gap: `RoundInfo<O>` was generic but `createRounds` never threaded `O`
 * through, so a game supplying `roundOpts: () => ({ mode })` received `unknown`
 * in `onRound` and had to cast. Bidstorm went as far as redeclaring
 * `RoundOpts = Record<string, unknown>` locally.
 *
 * Most of the value here is at COMPILE time — `tsc --noEmit` over tests/ is what
 * actually proves the threading, and the assignments below would not compile if
 * it regressed. The runtime assertions confirm the value survives the trip.
 */

import { describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo } from '../src/rematch';
import type { Net } from '../src/net';

interface GameOpts {
  mode: string;
  rounds: number;
}

function soloNet(): Net {
  return {
    selfId: 'self',
    peers: () => ['self'],
    host: () => 'self',
    isHost: () => true,
    hostSettled: () => true,
    hostEpoch: () => 1,
    count: () => 1,
    onPeersChange: () => () => {},
    channel: () => Object.assign(() => {}, { off: () => {} }),
    ping: async () => 0,
    takeover: () => {},
    netDiag: () => ({
      selfId: 'self',
      host: 'self',
      epoch: 1,
      settled: true,
      peers: ['self'],
      relaySockets: {},
      turn: false,
    }),
    leave: async () => {},
  } as unknown as Net;
}

describe('the opts type threads from roundOpts to onRound', () => {
  it('hands the game back its OWN type, with no cast', () => {
    vi.useFakeTimers();
    const seen: GameOpts[] = [];

    const rounds = createRounds<GameOpts>({
      net: soloNet(),
      playerName: 'Ann',
      minPlayers: 1,
      roundOpts: () => ({ mode: 'marathon', rounds: 3 }),
      onRound: (info: RoundInfo<GameOpts>) => {
        // The whole point: `.mode` and `.rounds` resolve without a cast. If the
        // generic stopped threading, `info.opts` would be `unknown` and these
        // two lines would not compile.
        const mode: string = info.opts.mode;
        const n: number = info.opts.rounds;
        seen.push({ mode, rounds: n });
      },
    });

    rounds.vote();
    rounds.go();
    expect(seen).toEqual([{ mode: 'marathon', rounds: 3 }]);

    // `state().hostOpts` is typed too, and is the host's own choice when hosting.
    const hostOpts: GameOpts | null = rounds.state().hostOpts;
    expect(hostOpts).toEqual({ mode: 'marathon', rounds: 3 });

    rounds.destroy();
    vi.useRealTimers();
  });

  it('still works untyped, for the games that never cared', () => {
    // `O` defaults to `unknown`, so every existing call site compiles unchanged.
    vi.useFakeTimers();
    let fired = 0;
    const rounds = createRounds({
      net: soloNet(),
      playerName: 'Ann',
      minPlayers: 1,
      onRound: () => {
        fired++;
      },
    });
    rounds.vote();
    rounds.go();
    expect(fired).toBe(1);
    expect(rounds.state().hostOpts).toBeNull();
    rounds.destroy();
    vi.useRealTimers();
  });
});
