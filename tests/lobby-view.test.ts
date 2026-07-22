// @vitest-environment jsdom
/**
 * lobby-view.test.ts — the join QR must survive a caller that repaints.
 *
 * The reported failure, from the ballast build: the QR panel vanished about a
 * second after every tap. The engine was already careful here — `qrOpen` is in
 * the 600ms repaint key precisely so a scan is not interrupted — but the game's
 * net handlers called `createLobby` again on every roster/vote change, and a
 * fresh lobby starts closed. From the player's seat it looks like the QR is
 * broken; from the code's seat everything is behaving as written.
 *
 * Two fixes, and both are tested here because they cover different callers:
 *   1. `repaint()` on the handle — what a game SHOULD do.
 *   2. view state remembered per container — what rescues the ~10 shipped games
 *      that already rebuild and will never be edited.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLobby,
  createRoomEntry,
  createListing,
  roomAd,
  type BoardAccess,
  type ListingState,
} from '../src/lobby';
import type { PublicRoom, RoomAd } from '../src/noticeboard';
import type { Net } from '../src/net';
import type { Rounds, RoundsState } from '../src/rematch';

function fakeNet(overrides: Partial<Net> = {}): Net {
  return {
    selfId: 'self',
    peers: () => ['self', 'other'],
    host: () => 'self',
    isHost: () => true,
    hostSettled: () => true,
    hostEpoch: () => 1,
    count: () => 2,
    onPeersChange: () => () => {},
    channel: () => Object.assign(() => {}, { off: () => {} }),
    ping: async () => 0,
    takeover: () => {},
    netDiag: () => ({
      selfId: 'self',
      host: 'self',
      epoch: 1,
      settled: true,
      peers: ['self', 'other'],
      relaySockets: {},
      turn: false,
    }),
    leave: async () => {},
    ...overrides,
  } as Net;
}

function fakeRounds(state: Partial<RoundsState> = {}): Rounds {
  const s: RoundsState = {
    round: 0,
    phase: 'waiting',
    votes: [],
    present: [
      { id: 'self', name: 'You' },
      { id: 'other', name: 'Them' },
    ],
    voted: false,
    isHost: true,
    canStart: true,
    seated: true,
    hostOpts: null,
    startsInMs: null,
    ...state,
  };
  return {
    vote: () => {},
    unvote: () => {},
    go: () => {},
    finish: () => {},
    state: () => s,
    destroy: () => {},
  };
}

let container: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

const qrVisible = (): boolean => !!container.querySelector('.lobby-qr');
const toggle = (): HTMLElement => container.querySelector<HTMLElement>('.lobby-qr-toggle')!;

describe('the QR toggle', () => {
  it('starts closed and opens on tap', () => {
    createLobby({ container, net: fakeNet(), rounds: fakeRounds(), roomCode: 'AAAA' });
    expect(qrVisible()).toBe(false);
    toggle().click();
    expect(qrVisible()).toBe(true);
  });

  it('survives the engine\'s own 600ms repaint loop', () => {
    createLobby({ container, net: fakeNet(), rounds: fakeRounds(), roomCode: 'AAAA' });
    toggle().click();
    vi.advanceTimersByTime(3000);
    expect(qrVisible()).toBe(true);
  });

  it('survives repaint() — the in-place option a game should use', () => {
    const lobby = createLobby({ container, net: fakeNet(), rounds: fakeRounds(), roomCode: 'AAAA' });
    toggle().click();
    expect(qrVisible()).toBe(true);
    for (let i = 0; i < 10; i++) lobby.repaint();
    expect(qrVisible()).toBe(true);
  });

  it('survives a caller REBUILDING the lobby — the ballast bug', () => {
    // This is the one that shipped. A game whose net handlers call createLobby
    // on every roster/vote change used to close the QR under the player mid-scan.
    const cfg = { container, net: fakeNet(), rounds: fakeRounds(), roomCode: 'AAAA' };
    const first = createLobby(cfg);
    toggle().click();
    expect(qrVisible()).toBe(true);

    first.destroy();
    createLobby(cfg); // "repaint" the way a game naively does it
    expect(qrVisible(), 'the QR closed itself on rebuild').toBe(true);
  });

  it('does NOT carry state into a different room', () => {
    const net = fakeNet();
    const rounds = fakeRounds();
    createLobby({ container, net, rounds, roomCode: 'AAAA' }).destroy();
    toggle().click();
    expect(qrVisible()).toBe(true);

    // Leaving and entering a different room is a fresh lobby, not a resumed one.
    createLobby({ container, net, rounds, roomCode: 'BBBB' });
    expect(qrVisible()).toBe(false);
    expect(container.querySelector('.lobby-code')?.textContent).toBe('BBBB');
  });

  it('closes again on a second tap', () => {
    createLobby({ container, net: fakeNet(), rounds: fakeRounds(), roomCode: 'AAAA' });
    toggle().click();
    toggle().click();
    expect(qrVisible()).toBe(false);
  });
});

describe('the "host this room" offer', () => {
  const alone = () =>
    fakeNet({
      peers: () => ['self'],
      count: () => 1,
      host: () => null,
      isHost: () => false,
      hostSettled: () => false,
    });

  it('is not offered before the wait has elapsed', () => {
    createLobby({ container, net: alone(), rounds: fakeRounds(), roomCode: 'AAAA' });
    vi.advanceTimersByTime(5000);
    expect(container.querySelector('.lobby-host')).toBeNull();
    expect(container.textContent).toContain('Connecting');
  });

  it('is offered once the player has waited alone long enough', () => {
    createLobby({ container, net: alone(), rounds: fakeRounds(), roomCode: 'AAAA' });
    vi.advanceTimersByTime(16000);
    expect(container.querySelector('.lobby-host')).not.toBeNull();
  });

  it('does not have its clock reset by a caller that rebuilds', () => {
    // Without sticky state, a game rebuilding the lobby every second would reset
    // `openedAt` forever and the offer would never appear — a lone player stuck
    // on a spinner permanently.
    const cfg = { container, net: alone(), rounds: fakeRounds(), roomCode: 'AAAA' };
    let lobby = createLobby(cfg);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000);
      lobby.destroy();
      lobby = createLobby(cfg);
    }
    expect(container.querySelector('.lobby-host')).not.toBeNull();
  });
});

describe('the netdebug overlay', () => {
  it('distinguishes a relay that is OPEN but refusing writes', () => {
    // The whole point of the write-state work: an OPEN socket that will not
    // carry announcements used to be indistinguishable from a healthy relay.
    const net = fakeNet({
      netDiag: () => ({
        selfId: 'self',
        host: 'self',
        epoch: 1,
        settled: true,
        peers: ['self'],
        relaySockets: { 'wss://good.example': 1, 'wss://paid.example': 1 },
        relayWrites: { 'wss://good.example': 'ok', 'wss://paid.example': 'rejected' },
        turn: false,
      }),
    });
    const search = window.location.search;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?netdebug=1' },
      writable: true,
    });
    createLobby({ container, net, rounds: fakeRounds(), roomCode: 'AAAA' });
    const overlay = document.querySelector('.net-debug')!;
    expect(overlay.textContent).toContain('OPEN write:ok wss://good.example');
    expect(overlay.textContent).toContain('OPEN write:REFUSED wss://paid.example');
    Object.defineProperty(window, 'location', { value: { ...window.location, search }, writable: true });
  });
});

describe('the mode slot', () => {
  it('renders the host\'s picker and re-wires it after every repaint', () => {
    // The lobby re-renders itself on a 600ms poll, which strips listeners off
    // whatever the game injected. Without onModeMount a host's mode picker
    // silently stops responding after the first roster change.
    let mounts = 0;
    const lobby = createLobby({
      container,
      net: fakeNet(),
      rounds: fakeRounds(),
      roomCode: 'AAAA',
      modeSlot: () => '<button class="pick">Blitz</button>',
      onModeMount: () => {
        mounts++;
      },
    });
    expect(container.querySelector('.pick')).not.toBeNull();
    expect(mounts).toBe(1);
    lobby.repaint();
    // Cheap by design: an unchanged paint key returns early, so no re-mount.
    expect(mounts).toBe(1);
  });

  it('repaints when the slot\'s own content changes', () => {
    // The paint key includes the slot, so a host switching mode updates even
    // though the roster is identical.
    let mode = 'Blitz';
    const lobby = createLobby({
      container,
      net: fakeNet(),
      rounds: fakeRounds(),
      roomCode: 'AAAA',
      modeSlot: () => `<span class="mode">${mode}</span>`,
    });
    expect(container.querySelector('.mode')?.textContent).toBe('Blitz');
    mode = 'Marathon';
    lobby.repaint();
    expect(container.querySelector('.mode')?.textContent).toBe('Marathon');
  });
});

describe('public rooms', () => {
  const board = (rooms: PublicRoom[] = []) => {
    const calls = { open: 0, close: 0, ads: [] as RoomAd[] };
    const access: BoardAccess = {
      open: async (onRooms) => {
        calls.open++;
        onRooms(rooms);
      },
      announce: async (ad) => {
        calls.ads.push(ad);
      },
      close: () => {
        calls.close++;
      },
    };
    return { access, calls };
  };

  it('shows NO public UI at all when the game passes no board', () => {
    // A game without public rooms must not grow a privacy surface it never asked
    // for. Private-only is the default and it is total.
    createRoomEntry({ container, onSubmit: () => {} });
    expect(container.querySelector('.vis-chip')).toBeNull();
    expect(container.querySelector('.re-browse')).toBeNull();
    expect(container.textContent).not.toContain('IP address');
  });

  it('is PRIVATE by default and says what public costs', () => {
    const { access } = board();
    createRoomEntry({ container, onSubmit: () => {}, board: access });
    const chips = [...container.querySelectorAll<HTMLElement>('.vis-chip')];
    expect(chips[0].getAttribute('aria-checked')).toBe('true'); // private
    expect(chips[1].getAttribute('aria-checked')).toBe('false');
    // The disclosure is AT the opt-in, not buried in About.
    expect(container.textContent).toContain('see your IP address');
  });

  it('never joins the board until the player explicitly browses', () => {
    const { access, calls } = board();
    createRoomEntry({ container, onSubmit: () => {}, board: access });
    expect(calls.open).toBe(0); // not on load
    container.querySelector<HTMLElement>('.re-browse')!.click();
    expect(calls.open).toBe(1);
  });

  it('reports isPublic only for a room this player created', () => {
    const { access } = board();
    const seen: Array<[string, boolean, boolean]> = [];
    createRoomEntry({
      container,
      board: access,
      onSubmit: (code, created, isPublic) => seen.push([code, created, isPublic]),
    });
    container.querySelectorAll<HTMLElement>('.vis-chip')[1].click(); // public
    container.querySelector<HTMLElement>('.re-create')!.click();
    expect(seen[0][1]).toBe(true);
    expect(seen[0][2]).toBe(true);
  });

  it('joins someone else\'s listed room as a GUEST, never as its host', () => {
    // created=false is what keeps claimHost false, so we adopt the incumbent
    // rather than racing a stranger for their own room.
    const rooms: PublicRoom[] = [
      { code: 'ZZZZ', host: 'Ann', players: 1, max: 4, playing: false, seenAt: Date.now() },
    ];
    const { access } = board(rooms);
    const seen: Array<[string, boolean, boolean]> = [];
    createRoomEntry({
      container,
      board: access,
      onSubmit: (c, cr, pub) => seen.push([c, cr, pub]),
    });
    container.querySelector<HTMLElement>('.re-browse')!.click();
    container.querySelector<HTMLElement>('.re-room')!.click();
    expect(seen[0]).toEqual(['ZZZZ', false, false]);
  });

  it('leaves the board the moment browsing stops', () => {
    const { access, calls } = board();
    createRoomEntry({ container, onSubmit: () => {}, board: access });
    container.querySelector<HTMLElement>('.re-browse')!.click();
    container.querySelector<HTMLElement>('.re-back')!.click();
    expect(calls.close).toBeGreaterThan(0);
  });

  it('does not call an empty list "empty" before the mesh has settled', async () => {
    // Being ON the board is not being connected to anyone on it. Saying "nobody
    // is here" too early is a lie the player acts on — they leave, and never see
    // the room that was advertised the whole time.
    const { access } = board([]);
    createRoomEntry({ container, onSubmit: () => {}, board: access, settleMs: 3000 });
    container.querySelector<HTMLElement>('.re-browse')!.click();
    expect(container.textContent).toContain('Joining the public list');
    // browse() awaits board.open() before arming the settle timer, so the
    // microtask queue has to drain before the clock is any use.
    await vi.advanceTimersByTimeAsync(3100);
    expect(container.textContent).toContain('Nobody has a public room open');
  });
});

describe('roomAd — the single rule for "is this room listed?"', () => {
  const base: ListingState = {
    isPublic: true,
    isHost: true,
    inLobby: true,
    playing: false,
    code: 'AAAA',
    host: 'Ann',
    players: 2,
    max: 4,
  };

  it('advertises a public room a host is sitting in', () => {
    expect(roomAd(base)).toMatchObject({ code: 'AAAA', players: 2, max: 4, playing: false });
  });

  it('NEVER advertises a private room', () => {
    expect(roomAd({ ...base, isPublic: false })).toBeNull();
  });

  it('does not advertise from a guest, a started round, or a left lobby', () => {
    expect(roomAd({ ...base, isHost: false })).toBeNull();
    expect(roomAd({ ...base, playing: true })).toBeNull();
    expect(roomAd({ ...base, inLobby: false })).toBeNull();
  });

  it('gets the room off the board as soon as it stops qualifying', () => {
    let closed = 0;
    const ads: RoomAd[] = [];
    const listing = createListing({
      open: async () => {},
      announce: async (ad) => {
        ads.push(ad);
      },
      close: () => {
        closed++;
      },
    });
    listing.sync(base);
    expect(ads).toHaveLength(1);
    listing.sync(base); // unchanged — must not re-announce
    expect(ads).toHaveLength(1);
    listing.sync({ ...base, playing: true }); // round started
    expect(closed).toBe(1);
  });
});
