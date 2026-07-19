/**
 * rematch.test.ts — the round-start protocol (01-DIAGNOSIS §3).
 *
 * Every case here maps to a way a player got "ejected" at round start: a roster
 * frozen from the host's half-formed view, a start that never reached a peer
 * whose channel opened late, and a vote lost in the same window.
 *
 * Driven through a fake Net so the protocol is tested without a transport; the
 * election itself is covered in net.test.ts against the real createNet.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Net, PeerId, Unsubscribe } from '../src/net';
import { createRounds, ROSTER_SETTLE_MS, type RoundInfo } from '../src/rematch';

const SELF = 'peer-M';
const P2 = 'peer-Z';
const P3 = 'peer-Q';

interface Sent {
  name: string;
  data: unknown;
  to?: PeerId | PeerId[];
}

/** A Net whose roster, host and inbound messages the test drives directly. */
class FakeNet implements Net {
  readonly selfId = SELF;
  sent: Sent[] = [];
  private list: PeerId[] = [SELF];
  private hostId: PeerId | null = SELF;
  private chans = new Map<string, Set<(d: never, f: PeerId) => void>>();
  private subs = new Set<(p: PeerId[]) => void>();

  peers = () => [...this.list].sort();
  host = () => this.hostId;
  isHost = () => this.hostId === SELF;
  hostSettled = () => this.hostId !== null;
  hostEpoch = () => 1;
  count = () => this.list.length;
  ping = async () => 0;
  takeover = () => {};
  netDiag = () => ({
    selfId: SELF,
    host: this.hostId,
    epoch: 1,
    settled: true,
    peers: this.peers(),
    relaySockets: {},
    turn: false,
  });
  leave = async () => {};

  onPeersChange(cb: (peers: PeerId[]) => void): Unsubscribe {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  channel<T>(name: string, onReceive: (data: T, from: PeerId) => void) {
    if (!this.chans.has(name)) this.chans.set(name, new Set());
    const set = this.chans.get(name)!;
    const h = onReceive as unknown as (d: never, f: PeerId) => void;
    set.add(h);
    const send = ((data: T, to?: PeerId | PeerId[]) => {
      this.sent.push({ name, data, to });
    }) as ((data: T, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
    send.off = () => {
      set.delete(h);
    };
    return send;
  }

  // ── test drivers ──────────────────────────────────────────────────────────
  setHost(id: PeerId | null): void {
    this.hostId = id;
  }
  addPeer(id: PeerId): void {
    this.list.push(id);
    for (const cb of [...this.subs]) cb(this.peers());
  }
  removePeer(id: PeerId): void {
    this.list = this.list.filter((p) => p !== id);
    for (const cb of [...this.subs]) cb(this.peers());
  }
  deliver(name: string, data: unknown, from: PeerId): void {
    for (const cb of [...(this.chans.get(name) ?? [])]) cb(data as never, from);
  }
  sentOn(name: string): Sent[] {
    return this.sent.filter((s) => s.name === name);
  }
}

let net: FakeNet;
let rounds: ReturnType<typeof createRounds>;
let started: RoundInfo[];

/** Vote arriving from a remote peer, for the round after `cur`. */
const remoteVote = (from: PeerId, round = 1, isIn = true): void =>
  net.deliver('rv', { round, name: from, in: isIn }, from);

const make = (over: Partial<Parameters<typeof createRounds>[0]> = {}) => {
  started = [];
  rounds = createRounds({
    net,
    playerName: 'me',
    minPlayers: 2,
    onRound: (i) => started.push(i),
    ...over,
  });
  return rounds;
};

/** Advance past the roster-settle window and let the 1.5s poll re-attempt. */
const settleRoster = () => vi.advanceTimersByTime(ROSTER_SETTLE_MS + 1600);

beforeEach(() => {
  vi.useFakeTimers();
  net = new FakeNet();
});
afterEach(() => {
  rounds?.destroy();
  vi.useRealTimers();
});

describe('§3a — the roster must settle before an automatic start', () => {
  it('does NOT start while the roster is still changing', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    // Everyone the host can see has voted — the old build started right here,
    // freezing a roster that excluded anyone one handshake behind.
    expect(started).toHaveLength(0);
    expect(net.sentOn('rs')).toHaveLength(0);
  });

  it('starts once the roster has held still', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();
    expect(started).toHaveLength(1);
    expect(started[0]!.players.map((p) => p.id).sort()).toEqual([SELF, P2].sort());
  });

  it('a late joiner resets the window and lands in the roster', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    vi.advanceTimersByTime(ROSTER_SETTLE_MS - 500);

    net.addPeer(P3); // the peer the old build would have excluded
    remoteVote(P3);
    vi.advanceTimersByTime(ROSTER_SETTLE_MS - 500);
    expect(started).toHaveLength(0); // window restarted

    settleRoster();
    expect(started).toHaveLength(1);
    expect(started[0]!.players.map((p) => p.id).sort()).toEqual([P3, P2, SELF].sort());
  });

  it("the host's explicit go() overrides the window — a human decided", () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    rounds.go();
    expect(started).toHaveLength(1);
  });

  it('starts without a non-voter once the grace countdown elapses', () => {
    net.addPeer(P2);
    net.addPeer(P3);
    make({ graceMs: 2000 });
    rounds.vote();
    remoteVote(P2); // quorum of 2, but P3 never votes
    settleRoster(); // window passes; the grace countdown begins here
    expect(started).toHaveLength(0);
    vi.advanceTimersByTime(2100);
    expect(started).toHaveLength(1);
    expect(started[0]!.players.map((p) => p.id).sort()).toEqual([SELF, P2].sort());
  });

  it('a peer arriving mid-countdown resets the window and defers the start', () => {
    // A long grace makes the timing explicit: the countdown must not be able to
    // freeze a partial roster just because it was armed before the peer arrived.
    net.addPeer(P2);
    net.addPeer(P3);
    make({ graceMs: 10_000 });
    rounds.vote();
    remoteVote(P2); // quorum, but P3 has not voted

    vi.advanceTimersByTime(4600); // window passes at the 4500ms poll -> grace armed, ends ~14500
    expect(started).toHaveLength(0);

    vi.advanceTimersByTime(9000); // ~13600: still counting down
    expect(started).toHaveLength(0);

    net.addPeer('peer-late'); // resets the roster-settle window
    vi.advanceTimersByTime(1000); // ~14600: the countdown EXPIRES in here…
    expect(started).toHaveLength(0); // …and is refused, because the roster just moved

    vi.advanceTimersByTime(20_000); // window clears, a fresh countdown runs out
    expect(started).toHaveLength(1);
  });

  it('a non-host never starts a round', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();
    expect(started).toHaveLength(0);
    expect(net.sentOn('rs')).toHaveLength(0);
  });
});

describe('§3b — the start must reach peers that connect late', () => {
  it('the host re-broadcasts the current start to a peer that just connected', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();
    expect(started).toHaveLength(1);

    const before = net.sentOn('rs').length;
    net.addPeer(P3); // arrives mid-round
    const rebroadcast = net.sentOn('rs').slice(before);
    expect(rebroadcast).toHaveLength(1);
    expect(rebroadcast[0]!.to).toBe(P3); // unicast to the newcomer
    expect((rebroadcast[0]!.data as { round: number }).round).toBe(1);
  });

  it('does not re-broadcast to peers that were already here', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();
    const before = net.sentOn('rs').length;
    net.removePeer(P3); // a roster change that adds nobody
    expect(net.sentOn('rs')).toHaveLength(before);
  });

  it('a client applies a re-broadcast start exactly once', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    const start = { round: 1, seed: 7, roster: [{ id: SELF, name: 'me' }, { id: P2, name: 'b' }] };
    net.deliver('rs', start, P2);
    net.deliver('rs', start, P2); // the re-broadcast duplicate
    net.deliver('rs', start, P2);
    expect(started).toHaveLength(1);
    expect(started[0]!.seed).toBe(7);
  });

  it('a peer excluded from the roster is seated:false, not dead', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    // A round that started without us — we connected mid-round.
    net.deliver('rs', { round: 3, seed: 1, roster: [{ id: P2, name: 'b' }] }, P2);
    expect(started).toHaveLength(1);
    expect(started[0]!.seated).toBe(false);
    expect(rounds.state().phase).toBe('playing');
    expect(rounds.state().seated).toBe(false);
  });

  it('a seated peer reports seated:true', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    net.deliver('rs', { round: 1, seed: 1, roster: [{ id: SELF, name: 'me' }] }, P2);
    expect(started[0]!.seated).toBe(true);
    expect(rounds.state().seated).toBe(true);
  });

  it('only the elected host may start a round', () => {
    net.setHost(P2);
    net.addPeer(P2);
    net.addPeer(P3);
    make();
    net.deliver('rs', { round: 1, seed: 1, roster: [{ id: SELF, name: 'me' }] }, P3); // impostor
    expect(started).toHaveLength(0);
  });

  it('survives host migration: a promoted host still holds lastStart', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    net.deliver('rs', { round: 4, seed: 9, roster: [{ id: SELF, name: 'me' }] }, P2);
    expect(started).toHaveLength(1);

    net.removePeer(P2);
    net.setHost(SELF); // we are promoted mid-round
    const before = net.sentOn('rs').length;
    net.addPeer(P3); // a newcomer arrives after the migration
    const rebroadcast = net.sentOn('rs').slice(before);
    expect(rebroadcast).toHaveLength(1);
    expect((rebroadcast[0]!.data as { round: number }).round).toBe(4);
  });
});

describe('§3c — acks and the retry ladder', () => {
  it('a peer acknowledges the start it applied', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    net.deliver('rs', { round: 1, seed: 1, roster: [{ id: SELF, name: 'me' }] }, P2);
    const acks = net.sentOn('rk');
    expect(acks).toHaveLength(1);
    expect(acks[0]!.data).toEqual({ round: 1 });
    expect(acks[0]!.to).toBe(P2);
  });

  it('re-acknowledges a duplicate, in case the first ack was what got lost', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    const start = { round: 1, seed: 1, roster: [{ id: SELF, name: 'me' }] };
    net.deliver('rs', start, P2);
    net.deliver('rs', start, P2);
    expect(net.sentOn('rk')).toHaveLength(2);
    expect(started).toHaveLength(1); // but still only one round
  });

  it('the host retries an unacked start, at most ACK_MAX_RETRIES times', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();

    vi.advanceTimersByTime(10_000); // far beyond the ladder
    // go() broadcasts (no `to`); every retry is a unicast to the silent peer, so
    // counting unicasts is unambiguous regardless of when the ladder started
    // relative to the poll tick that triggered go().
    const retries = net.sentOn('rs').filter((r) => r.to === P2);
    expect(retries).toHaveLength(5);
  });

  it('the host stops retrying the moment the peer acks', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();
    const afterStart = net.sentOn('rs').length;

    vi.advanceTimersByTime(1100); // one retry
    net.deliver('rk', { round: 1 }, P2);
    vi.advanceTimersByTime(10_000);
    expect(net.sentOn('rs').slice(afterStart)).toHaveLength(1);
  });

  it('does not chase a peer that has left the room', () => {
    net.addPeer(P2);
    net.addPeer(P3);
    make();
    rounds.vote();
    remoteVote(P2);
    remoteVote(P3);
    settleRoster();
    const afterStart = net.sentOn('rs').length;

    net.removePeer(P3);
    vi.advanceTimersByTime(10_000);
    const retries = net.sentOn('rs').slice(afterStart);
    expect(retries.some((r) => r.to === P3)).toBe(false);
    expect(retries.some((r) => r.to === P2)).toBe(true);
  });
});

describe('round bookkeeping', () => {
  it('rounds are monotonic — a replayed old start is ignored', () => {
    net.setHost(P2);
    net.addPeer(P2);
    make();
    net.deliver('rs', { round: 5, seed: 1, roster: [{ id: SELF, name: 'me' }] }, P2);
    net.deliver('rs', { round: 3, seed: 2, roster: [{ id: SELF, name: 'me' }] }, P2);
    expect(started).toHaveLength(1);
    expect(started[0]!.round).toBe(5);
  });

  it('finish() reopens voting and resets the settle window', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();
    expect(rounds.state().phase).toBe('playing');

    rounds.finish();
    expect(rounds.state().phase).toBe('waiting');
    expect(rounds.state().votes).toHaveLength(0);
    // The window was reset, so a rematch cannot start on a stale roster read.
    rounds.vote();
    remoteVote(P2, 2);
    expect(started).toHaveLength(1);
    settleRoster();
    expect(started).toHaveLength(2);
  });

  it('destroy() detaches every receiver and timer', () => {
    net.addPeer(P2);
    make();
    rounds.vote();
    remoteVote(P2);
    settleRoster();
    const total = net.sent.length;
    rounds.destroy();
    vi.advanceTimersByTime(20_000);
    expect(net.sent).toHaveLength(total);
  });
});
