/**
 * relay-health.test.ts — a write-restricted relay is a dead relay.
 *
 * The failure this pins, measured live during the turntide build: two peers on
 * the same machine could not discover each other, because half the curated relay
 * list was unusable in a way NO connection check can see. `nostr.wine` accepted
 * sockets and answered reads while refusing published events; peers ANNOUNCE
 * over writes, so it passed every liveness probe while silently killing
 * discovery. The `?netdebug=1` overlay showed it as connected.
 *
 * So the engine now reads the relay's own answer. Nostr replies to a published
 * event with `["OK", <id>, <accepted>, <reason>]`, and the reason on a rejection
 * is the relay saying in plain words that it will not carry our traffic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const relaySockets: Record<string, FakeSocket> = {};

class FakeSocket {
  readyState = 1;
  private listeners: Array<(ev: { data: string }) => void> = [];
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    if (type === 'message') this.listeners.push(fn);
  }
  /** Simulate a frame arriving from the relay. */
  emit(frame: unknown): void {
    for (const fn of this.listeners) fn({ data: JSON.stringify(frame) });
  }
  /** How many message listeners are attached — proves we do not double-watch. */
  get watchers(): number {
    return this.listeners.length;
  }
}

vi.mock('trystero', () => ({
  selfId: 'self-peer',
  joinRoom: () => ({
    makeAction: () => [() => Promise.resolve(), () => {}, () => {}],
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    getPeers: () => ({}),
    leave: () => Promise.resolve(),
  }),
}));

vi.mock('trystero/nostr', () => ({ getRelaySockets: () => relaySockets }));

let net: typeof import('../src/net');

beforeEach(async () => {
  vi.useFakeTimers();
  for (const k of Object.keys(relaySockets)) delete relaySockets[k];
  vi.resetModules();
  net = await import('../src/net');
  net.resetNetStats();
  net.resetRelayHealth();
});

afterEach(() => {
  vi.useRealTimers();
});

const OK = (accepted: boolean, reason = '') => ['OK', 'evt-id', accepted, reason];

describe('the curated relay list', () => {
  it('no longer ships the three relays measured as unusable', () => {
    // nostr.band and snort.social timed out 3/3; damus.io errored 2/3;
    // nostr.wine was field-reported as write-restricted on a signed event.
    for (const dead of [
      'wss://relay.nostr.band',
      'wss://relay.snort.social',
      'wss://relay.damus.io',
      'wss://nostr.wine',
    ]) {
      expect(net.DEFAULT_RELAYS, `${dead} is still in the list`).not.toContain(dead);
    }
  });

  it('keeps enough redundancy to survive one relay having a bad day', () => {
    expect(net.DEFAULT_RELAYS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(net.DEFAULT_RELAYS).size).toBe(net.DEFAULT_RELAYS.length);
    for (const u of net.DEFAULT_RELAYS) expect(u).toMatch(/^wss:\/\//);
  });
});

describe('reading what a relay does with our writes', () => {
  function joinWithSockets(urls: string[], roomId = 'R1'): void {
    for (const u of urls) relaySockets[u] = new FakeSocket();
    net.createNet({ appId: 'test@1', roomId });
    vi.advanceTimersByTime(1100); // let the watcher poll attach
  }

  it('marks a relay ok when it accepts a published event', () => {
    joinWithSockets(['wss://a.example']);
    relaySockets['wss://a.example'].emit(OK(true));
    expect(net.relayWriteStates()['wss://a.example']).toBe('ok');
    expect(net.demotedRelays()).toEqual([]);
  });

  it('marks a relay rejected when it refuses writes', () => {
    joinWithSockets(['wss://paid.example']);
    relaySockets['wss://paid.example'].emit(
      OK(false, 'restricted: sign up at https://paid.example to write events'),
    );
    expect(net.relayWriteStates()['wss://paid.example']).toBe('rejected');
    expect(net.demotedRelays()).toEqual(['wss://paid.example']);
  });

  it('recognises every flavour of refusal', () => {
    const reasons = [
      'auth-required: we only accept events from authenticated users',
      'blocked: you are not on the whitelist',
      'pow: difficulty 28 required',
      'rate-limited: slow down',
      'payment-required: 1000 sats',
    ];
    reasons.forEach((reason, i) => {
      const url = `wss://r${i}.example`;
      relaySockets[url] = new FakeSocket();
      net.createNet({ appId: 'test@1', roomId: `room-${i}` });
      vi.advanceTimersByTime(1100);
      relaySockets[url].emit(OK(false, reason));
      expect(net.relayWriteStates()[url], reason).toBe('rejected');
    });
  });

  it('does NOT condemn a relay for rejecting a malformed event', () => {
    // "invalid: bad signature" says nothing about willingness to carry traffic —
    // it is the relay doing its job. Only a policy refusal is a demotion.
    joinWithSockets(['wss://strict.example']);
    relaySockets['wss://strict.example'].emit(OK(false, 'invalid: bad event id'));
    expect(net.relayWriteStates()['wss://strict.example']).toBeUndefined();
    expect(net.demotedRelays()).toEqual([]);
  });

  it('reads a NOTICE refusal too', () => {
    joinWithSockets(['wss://notice.example']);
    relaySockets['wss://notice.example'].emit(['NOTICE', 'restricted: not authorized']);
    expect(net.relayWriteStates()['wss://notice.example']).toBe('rejected');
  });

  it('survives a frame that is not JSON, or not an array', () => {
    joinWithSockets(['wss://noise.example']);
    const s = relaySockets['wss://noise.example'];
    expect(() => {
      for (const fn of [(): void => s.emit({ not: 'an array' }), (): void => s.emit(['EVENT', {}])]) fn();
    }).not.toThrow();
    expect(net.demotedRelays()).toEqual([]);
  });

  it('watches each socket exactly once however often it polls', () => {
    joinWithSockets(['wss://once.example']);
    vi.advanceTimersByTime(6000);
    expect(relaySockets['wss://once.example'].watchers).toBe(1);
  });
});

describe('demotion', () => {
  it('drops a refusing relay from the NEXT room joined', () => {
    const url = net.DEFAULT_RELAYS[0];
    relaySockets[url] = new FakeSocket();
    net.createNet({ appId: 'test@1', roomId: 'first' });
    vi.advanceTimersByTime(1100);
    relaySockets[url].emit(OK(false, 'restricted: nope'));

    expect(net.demotedRelays()).toContain(url);
    // The next join must not carry it. (Trystero pools sockets and offers no way
    // to re-dial a live room, so the demotion lands on the next room — which in
    // practice is the game room, because presence/board join first.)
    net.createNet({ appId: 'test@1', roomId: 'second' });
    expect(net.demotedRelays()).toContain(url);
  });

  it('never demotes the last relay standing', () => {
    // A thin list beats an empty one: with no relays at all there is no
    // signalling and no game, which is strictly worse than one bad relay.
    for (const u of net.DEFAULT_RELAYS) {
      relaySockets[u] = new FakeSocket();
    }
    net.createNet({ appId: 'test@1', roomId: 'all-bad' });
    vi.advanceTimersByTime(1100);
    for (const u of net.DEFAULT_RELAYS) relaySockets[u].emit(OK(false, 'restricted: nope'));
    expect(net.demotedRelays()).toHaveLength(net.DEFAULT_RELAYS.length);
    expect(() => net.createNet({ appId: 'test@1', roomId: 'next' })).not.toThrow();
  });
});

describe('netDiag exposes it', () => {
  it('reports write state alongside socket state', () => {
    relaySockets['wss://a.example'] = new FakeSocket();
    relaySockets['wss://b.example'] = new FakeSocket();
    const n = net.createNet({ appId: 'test@1', roomId: 'diag' });
    vi.advanceTimersByTime(1100);
    relaySockets['wss://a.example'].emit(OK(true));
    relaySockets['wss://b.example'].emit(OK(false, 'restricted: paid relay'));

    const d = n.netDiag();
    // The socket says both are fine. Only the write state tells them apart.
    expect(d.relaySockets['wss://a.example']).toBe(1);
    expect(d.relaySockets['wss://b.example']).toBe(1);
    expect(d.relayWrites?.['wss://a.example']).toBe('ok');
    expect(d.relayWrites?.['wss://b.example']).toBe('rejected');
  });
});
