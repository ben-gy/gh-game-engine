/**
 * net.test.ts — the host-election state machine, driven through the REAL
 * createNet() against a fake Trystero room.
 *
 * These cases exist because of specific field failures (01-DIAGNOSIS §2): a
 * joiner self-electing on an empty roster at 2.5s, and then taking a live room
 * from its incumbent on a min-id coin flip. Testing the real code path — not a
 * re-implementation of the rules — is the point: the bug lived in the wiring
 * between the settle timer and the announce handler, and a hand-rolled state
 * machine test would have passed while shipping the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Peer ids chosen so SELF sorts in the MIDDLE — min-id can go either way. */
const h = vi.hoisted(() => {
  const SELF = 'peer-M';
  const LOWER = 'peer-A';
  const HIGHER = 'peer-Z';

  type Recv = (data: unknown, from: string) => void;
  interface Sent {
    name: string;
    data: unknown;
    to?: string | string[];
  }

  class FakeRoom {
    peers: Record<string, unknown> = {};
    sent: Sent[] = [];
    left = false;
    private acts = new Map<string, Recv[]>();
    private joinFns: ((id: string) => void)[] = [];
    private leaveFns: ((id: string) => void)[] = [];

    makeAction = (name: string) => {
      if (!this.acts.has(name)) this.acts.set(name, []);
      const send = (data: unknown, to?: string | string[]) => {
        this.sent.push({ name, data, to });
        return Promise.resolve([]);
      };
      const recv = (cb: Recv) => {
        this.acts.get(name)!.push(cb);
      };
      return [send, recv, () => {}];
    };
    onPeerJoin = (f: (id: string) => void) => {
      this.joinFns.push(f);
    };
    onPeerLeave = (f: (id: string) => void) => {
      this.leaveFns.push(f);
    };
    getPeers = () => this.peers;
    leave = async () => {
      this.left = true;
    };

    // ── test drivers ────────────────────────────────────────────────────────
    /** A peer's data channel opened. */
    addPeer(id: string): void {
      this.peers[id] = {};
      for (const f of this.joinFns) f(id);
    }
    /** A peer vanished. Mirrors trystero: removed from the map BEFORE the callback. */
    removePeer(id: string): void {
      delete this.peers[id];
      for (const f of this.leaveFns) f(id);
    }
    /** Inbound message on a channel. */
    deliver(name: string, data: unknown, from: string): void {
      for (const cb of this.acts.get(name) ?? []) cb(data, from);
    }
    sentOn(name: string): Sent[] {
      return this.sent.filter((s) => s.name === name);
    }
  }

  const state: { room: FakeRoom | null; config: Record<string, unknown> | null } = {
    room: null,
    config: null,
  };
  return { SELF, LOWER, HIGHER, FakeRoom, state };
});

vi.mock('trystero', () => ({
  joinRoom: (config: Record<string, unknown>) => {
    h.state.config = config;
    h.state.room = new h.FakeRoom();
    return h.state.room;
  },
  selfId: h.SELF,
}));
vi.mock('trystero/nostr', () => ({
  getRelaySockets: () => ({ 'wss://relay.damus.io': { readyState: 1 } }),
}));

const { SELF, LOWER, HIGHER } = h;
import {
  createNet,
  resetNetStats,
  roomAppId,
  setTurnConfig,
  PROTOCOL_REV,
  SETTLE_MS,
} from '../src/net';

const room = () => h.state.room!;
/** The `__h` announces we have sent, newest last. */
const announces = () =>
  room()
    .sentOn('__h')
    .map((s) => s.data as { host: string; epoch: number });

let n = 0;
const join = (extra: Record<string, unknown> = {}) =>
  createNet({ appId: 'test', roomId: `R${n++}`, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  resetNetStats();
  h.state.room = null;
  h.state.config = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('appId protocol revision', () => {
  it('stamps the wire revision so cached old builds partition cleanly', () => {
    expect(roomAppId('tiny-tanks')).toBe(`tiny-tanks@${PROTOCOL_REV}`);
    expect(PROTOCOL_REV).toBe(2);
  });
});

describe('host election — creator', () => {
  it('claims term 1 immediately and starts announcing', () => {
    const net = join({ claimHost: true });
    expect(net.isHost()).toBe(true);
    expect(net.hostSettled()).toBe(true);
    expect(net.host()).toBe(SELF);
    expect(net.hostEpoch()).toBe(1);
    expect(announces()[0]).toEqual({ host: SELF, epoch: 1 });
  });

  it('re-announces on an interval so late joiners hear it', () => {
    join({ claimHost: true });
    const before = announces().length;
    vi.advanceTimersByTime(6000);
    expect(announces().length).toBeGreaterThan(before);
  });
});

describe('host election — joiner adopts the incumbent', () => {
  it('adopts an announce received inside the settle window', () => {
    const net = join();
    room().addPeer(LOWER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    expect(net.host()).toBe(LOWER);
    expect(net.isHost()).toBe(false);
    expect(net.hostEpoch()).toBe(1);
  });

  it('THE STEAL IS DEAD: adopts an incumbent whose id sorts ABOVE ours', () => {
    // The precise regression. Old code ran a min-id comparison on the unsettled
    // path, so an incumbent with a high id lost its live room to the peer that
    // had just arrived holding no state at all.
    const net = join();
    room().addPeer(HIGHER);
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    expect(net.host()).toBe(HIGHER);
    expect(net.isHost()).toBe(false);
    expect(SELF < HIGHER).toBe(true); // our id really would have won on min-id
  });

  it('never self-elects while alone, however long it waits', () => {
    const net = join();
    // The old build settled at 2.5s on a roster of one and became a phantom host.
    for (let i = 0; i < 20; i++) vi.advanceTimersByTime(SETTLE_MS);
    expect(net.hostSettled()).toBe(false);
    expect(net.host()).toBeNull();
    expect(net.isHost()).toBe(false);
    expect(announces()).toHaveLength(0);
  });

  it('restarts the settle window when a new peer connects', () => {
    const net = join();
    vi.advanceTimersByTime(SETTLE_MS - 500);
    room().addPeer(LOWER); // resets the window
    vi.advanceTimersByTime(SETTLE_MS - 500);
    expect(net.hostSettled()).toBe(false); // would have fired without the reset
    vi.advanceTimersByTime(1000);
    expect(net.hostSettled()).toBe(true);
  });

  it('ignores a claim forwarded on behalf of someone else', () => {
    const net = join();
    room().addPeer(LOWER);
    room().deliver('__h', { host: HIGHER, epoch: 9 }, LOWER); // LOWER claims HIGHER hosts
    expect(net.hostSettled()).toBe(false);
  });

  it('ignores a malformed epoch rather than letting NaN win', () => {
    const net = join();
    room().addPeer(LOWER);
    room().deliver('__h', { host: LOWER, epoch: 'soon' }, LOWER);
    room().deliver('__h', { host: LOWER }, LOWER);
    expect(net.hostSettled()).toBe(false);
  });
});

describe('host election — fallback when the room is genuinely hostless', () => {
  it('elects min-id at term 1 after silence, with peers present', () => {
    const net = join();
    room().addPeer(HIGHER); // roster: peer-M, peer-Z -> min is peer-M (self)
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(net.hostSettled()).toBe(true);
    expect(net.host()).toBe(SELF);
    expect(net.hostEpoch()).toBe(1);
  });

  it('defers to a lower-id peer, which computes the identical winner', () => {
    const net = join();
    room().addPeer(LOWER); // roster: peer-A, peer-M -> min is peer-A
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(net.host()).toBe(LOWER);
    expect(net.isHost()).toBe(false);
  });

  it('mints term 1 so it can never outrank a real incumbent', () => {
    const net = join();
    room().addPeer(HIGHER);
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(net.hostEpoch()).toBe(1);
    // A real incumbent that survived a transfer is at term >= 2 and wins.
    room().deliver('__h', { host: HIGHER, epoch: 2 }, HIGHER);
    expect(net.host()).toBe(HIGHER);
    expect(net.hostEpoch()).toBe(2);
  });
});

describe('host election — terms arbitrate conflicts', () => {
  it('a higher term always wins, even from a higher id', () => {
    const net = join({ claimHost: true });
    expect(net.hostEpoch()).toBe(1);
    room().addPeer(HIGHER);
    room().deliver('__h', { host: HIGHER, epoch: 5 }, HIGHER);
    expect(net.host()).toBe(HIGHER);
    expect(net.isHost()).toBe(false);
    expect(net.hostEpoch()).toBe(5);
  });

  it('an equal term falls back to min-id, converging both sides', () => {
    const net = join({ claimHost: true }); // self, term 1
    room().addPeer(LOWER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    expect(net.host()).toBe(LOWER); // peer-A < peer-M
    expect(net.isHost()).toBe(false);
  });

  it('an equal term from a HIGHER id leaves us hosting', () => {
    const net = join({ claimHost: true });
    room().addPeer(HIGHER);
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    expect(net.host()).toBe(SELF);
    expect(net.isHost()).toBe(true);
  });

  it('a stale term is ignored AND corrected by unicast', () => {
    const net = join({ claimHost: true });
    room().addPeer(LOWER);
    net.takeover(); // bump to term 2 so LOWER's term 1 is genuinely stale
    const before = room().sentOn('__h').length;
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    expect(net.host()).toBe(SELF); // did not lose the room to a stale claim
    const correction = room().sentOn('__h').slice(before);
    expect(correction).toHaveLength(1);
    expect(correction[0]!.to).toBe(LOWER); // unicast, not broadcast
    expect(correction[0]!.data).toEqual({ host: SELF, epoch: net.hostEpoch() });
  });

  it('greets a newcomer with the current term so it settles fast', () => {
    const net = join({ claimHost: true });
    room().addPeer(HIGHER);
    const greeting = room()
      .sentOn('__h')
      .filter((s) => s.to === HIGHER);
    expect(greeting).toHaveLength(1);
    expect(greeting[0]!.data).toEqual({ host: SELF, epoch: net.hostEpoch() });
  });
});

describe('host election — transfer on leave', () => {
  it('survivors promote min-id at epoch + 1', () => {
    const net = join();
    room().addPeer(LOWER);
    room().addPeer(HIGHER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    expect(net.host()).toBe(LOWER);

    room().removePeer(LOWER); // the host leaves
    // Survivors are peer-M (self) and peer-Z; min is peer-M.
    expect(net.host()).toBe(SELF);
    expect(net.isHost()).toBe(true);
    expect(net.hostEpoch()).toBe(2);
  });

  it('the promoted host announces at the NEW term', () => {
    join();
    room().addPeer(LOWER);
    room().addPeer(HIGHER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    room().removePeer(LOWER);
    expect(announces().at(-1)).toEqual({ host: SELF, epoch: 2 });
  });

  it('a survivor that missed the leave is corrected, not obeyed', () => {
    const net = join();
    room().addPeer(LOWER);
    room().addPeer(HIGHER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    room().removePeer(LOWER);
    expect(net.hostEpoch()).toBe(2);

    // HIGHER still thinks LOWER hosts and re-announces the old term on its behalf…
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    expect(net.host()).toBe(SELF); // …ignored
    const correction = room()
      .sentOn('__h')
      .filter((s) => s.to === HIGHER);
    expect(correction.at(-1)!.data).toEqual({ host: SELF, epoch: 2 });
  });

  it('a non-host leaving changes nothing', () => {
    const net = join();
    expect(net.hostSettled()).toBe(false);
    room().addPeer(LOWER);
    room().addPeer(HIGHER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    room().removePeer(HIGHER);
    expect(net.host()).toBe(LOWER);
    expect(net.hostEpoch()).toBe(1);
  });

  it('does not elect the peer that just left', () => {
    // Belt and braces: even if trystero ever reported the leaver as still present.
    const net = join();
    room().addPeer(LOWER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER);
    room().peers[LOWER] = {}; // simulate a stale map entry
    room().removePeer(LOWER);
    expect(net.host()).not.toBe(LOWER);
    expect(net.host()).toBe(SELF);
  });
});

describe('regressions — asymmetric observation (rules 6 and 7)', () => {
  // Rules 4 and 5 elect a host from OUR roster, assuming every peer sees the same
  // events. They do not: trystero drops a peer on a transient
  // `connectionState === 'disconnected'`, per connection, so one peer can see a
  // leave that nobody else saw. Both cases below left a peer permanently settled
  // on a host that was not hosting — receiving no round starts, forever.
  const LOW2 = 'peer-B'; // sorts below SELF, so it wins a survivor election

  it('a promotion nobody else made is provisional, and heals', () => {
    const net = join();
    room().addPeer(HIGHER);
    room().addPeer(LOW2);
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    expect(net.host()).toBe(HIGHER);

    // Only OUR link to the host blips. Everyone else still sees it fine.
    room().removePeer(HIGHER);
    expect(net.host()).toBe(LOW2); // we promote the min-id survivor…
    expect(net.hostEpoch()).toBe(2);

    // …but LOW2 never saw a leave, so it never claims the term. Before rule 7 we
    // stayed settled on it forever and dropped the real host's announces as stale.
    vi.advanceTimersByTime(SETTLE_MS + 1);
    expect(net.hostSettled()).toBe(false);

    // The link heals; the incumbent's next announce is now adopted, not ignored.
    room().addPeer(HIGHER);
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    expect(net.host()).toBe(HIGHER);
    expect(net.hostSettled()).toBe(true);
  });

  it('a promotion the winner DOES claim stands, and is not undone', () => {
    const net = join();
    room().addPeer(HIGHER);
    room().addPeer(LOW2);
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    room().removePeer(HIGHER);
    expect(net.host()).toBe(LOW2);

    room().deliver('__h', { host: LOW2, epoch: 2 }, LOW2); // the winner claims it
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(net.host()).toBe(LOW2);
    expect(net.hostSettled()).toBe(true); // never reverted
  });

  it('a real claim beats a locally-elected belief at equal term', () => {
    const net = join();
    room().addPeer(LOWER);
    room().addPeer(HIGHER);
    vi.advanceTimersByTime(SETTLE_MS + 1); // fallback elects min-id LOWER, unclaimed
    expect(net.host()).toBe(LOWER);

    // HIGHER is demonstrably hosting — it just said so. Min-id would keep us
    // pinned to LOWER, which nobody is hosting from, on every single announce.
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    expect(net.host()).toBe(HIGHER);
  });

  it('min-id still decides between two GENUINE claims', () => {
    const net = join();
    room().addPeer(LOWER);
    room().addPeer(HIGHER);
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER); // claimed
    expect(net.host()).toBe(HIGHER);
    room().deliver('__h', { host: LOWER, epoch: 1 }, LOWER); // also claimed
    expect(net.host()).toBe(LOWER); // peer-A < peer-Z
  });

  it('our own claim is never yielded to an unclaimed belief', () => {
    const net = join({ claimHost: true });
    room().addPeer(HIGHER);
    room().deliver('__h', { host: HIGHER, epoch: 1 }, HIGHER);
    expect(net.isHost()).toBe(true); // SELF < peer-Z, and we genuinely claim it
  });
});

describe('regressions — TURN must reach the shared offer pool', () => {
  // Trystero builds ONE global pool of 20 pre-made connections from the config of
  // the FIRST joinRoom on the page. A turnless mesh created first (a menu's
  // __presence or __board, neither of which takes a turnConfig) leaves the game
  // room's INITIATING half STUN-only — TURN silently working one way only.
  afterEach(() => setTurnConfig([]));

  it('a mesh with no turnConfig of its own inherits the page-wide one', () => {
    const turn = [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' }];
    setTurnConfig(turn);
    join(); // e.g. __presence, which has no turnConfig field at all
    expect(h.state.config!.turnConfig).toEqual(turn);
  });

  it('an explicit per-room turnConfig still wins', () => {
    setTurnConfig([{ urls: 'turn:shared' }]);
    join({ turnConfig: [{ urls: 'turn:specific' }] });
    expect(h.state.config!.turnConfig).toEqual([{ urls: 'turn:specific' }]);
  });

  it('reports the config actually in force via netDiag', () => {
    setTurnConfig([{ urls: 'turn:x' }]);
    expect(join().netDiag().turn).toBe(true);
  });
});

describe('takeover — explicit, user-driven hosting', () => {
  it('mints a term above anything heard so every peer adopts us', () => {
    const net = join();
    room().addPeer(HIGHER);
    room().deliver('__h', { host: HIGHER, epoch: 3 }, HIGHER);
    expect(net.host()).toBe(HIGHER);

    net.takeover();
    expect(net.isHost()).toBe(true);
    expect(net.hostEpoch()).toBe(4);
    expect(announces().at(-1)).toEqual({ host: SELF, epoch: 4 });
  });

  it('works from the unsettled-and-alone state (the lobby escape hatch)', () => {
    const net = join();
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(net.hostSettled()).toBe(false);
    net.takeover();
    expect(net.isHost()).toBe(true);
    expect(net.hostEpoch()).toBe(1);
  });
});

describe('roster subscriptions', () => {
  it('fans out to every subscriber and unsubscribes cleanly', () => {
    const net = join();
    const a: string[][] = [];
    const b: string[][] = [];
    const offA = net.onPeersChange((p) => a.push(p));
    net.onPeersChange((p) => b.push(p));

    room().addPeer(LOWER);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual([LOWER, SELF]); // sorted, includes self

    offA();
    room().addPeer(HIGHER);
    expect(a).toHaveLength(1); // detached
    expect(b).toHaveLength(2);
  });

  it('still drives the single onPeers handler slot', () => {
    const seen: string[][] = [];
    createNet({ appId: 'test', roomId: 'RP' }, { onPeers: (p) => seen.push(p) });
    room().addPeer(LOWER);
    expect(seen[0]).toEqual([LOWER, SELF]);
  });
});

describe('transport config', () => {
  it('passes TURN servers through to trystero', () => {
    const turnConfig = [{ urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c' }];
    join({ turnConfig });
    expect(h.state.config!.turnConfig).toEqual(turnConfig);
  });

  it('omits turnConfig entirely when TURN is unavailable (fail open)', () => {
    join({ turnConfig: [] });
    expect(h.state.config).not.toHaveProperty('turnConfig');
  });

  it('uses the curated relay list by default', () => {
    join();
    expect(h.state.config!.relayUrls).toContain('wss://relay.damus.io');
  });

  it('lets a game override relays and rtcConfig', () => {
    const rtcConfig = { iceTransportPolicy: 'relay' as const };
    join({ relayUrls: ['wss://only.example'], rtcConfig });
    expect(h.state.config!.relayUrls).toEqual(['wss://only.example']);
    expect(h.state.config!.rtcConfig).toEqual(rtcConfig);
  });
});

describe('netDiag', () => {
  it('reports the room state a bug report needs', () => {
    const net = join({ claimHost: true, turnConfig: [{ urls: 'turn:x' }] });
    room().addPeer(LOWER);
    const d = net.netDiag();
    expect(d).toMatchObject({ selfId: SELF, host: SELF, epoch: 1, settled: true, turn: true });
    expect(d.peers).toEqual([LOWER, SELF]);
    expect(d.relaySockets).toEqual({ 'wss://relay.damus.io': 1 });
  });

  it('reports turn:false when running STUN-only', () => {
    const net = join();
    expect(net.netDiag().turn).toBe(false);
  });
});

describe('one room per session', () => {
  it('throws rather than aliasing a room that is still tearing down', async () => {
    const net = createNet({ appId: 'test', roomId: 'DUP' });
    const leaving = net.leave();
    expect(() => createNet({ appId: 'test', roomId: 'DUP' })).toThrow(/tearing down/);
    await leaving;
  });

  it('throws on a second join of a live room', () => {
    createNet({ appId: 'test', roomId: 'LIVE' });
    expect(() => createNet({ appId: 'test', roomId: 'LIVE' })).toThrow(/already joined/);
  });

  it('stops announcing once left', async () => {
    const net = join({ claimHost: true });
    await net.leave();
    const after = announces().length;
    vi.advanceTimersByTime(10000);
    expect(announces()).toHaveLength(after);
  });
});

describe('relay redundancy', () => {
  it('trims the relay list, since trystero ignores relayRedundancy when relayUrls is set', () => {
    join({ relayRedundancy: 2 });
    expect((h.state.config!.relayUrls as string[])).toHaveLength(2);
  });

  it('uses every relay when unset', () => {
    join();
    expect((h.state.config!.relayUrls as string[]).length).toBeGreaterThan(4);
  });
});
