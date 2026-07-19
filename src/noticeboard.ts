/**
 * noticeboard.ts — a list of open public rooms, with no server.
 *
 * There is no backend to hold a lobby list, so the rooms advertise themselves.
 * Every peer that cares joins ONE well-known extra room per game (roomId
 * `__board`) and hosts of public rooms announce `{code, host, players, …}` into
 * it every couple of seconds. Browsers listen and render whatever is still
 * fresh. Entries expire on silence, so a host that closes its tab simply falls
 * off the list — nothing to clean up, and no stale rooms to click into.
 *
 *   const board = createNoticeboard({ appId: 'my-slug', onRooms: render });
 *   board.announce({ code, host: name, players: 2, max: 6, playing: false });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE USING IT: the noticeboard has a privacy cost that a private
 * room does not.
 *
 * This is WebRTC. Connecting to a peer means exchanging ICE candidates, which
 * carry IP addresses. In a private room that is fine — you invited those people.
 * The noticeboard is a room full of STRANGERS, so both listing a public game and
 * browsing the list expose your IP to everyone else doing the same.
 *
 * So: it must be opt-in on both sides, and say so where the player opts in.
 * Never join the board just because someone opened the game — a player who only
 * ever plays with friends should never touch it. Private rooms must not announce
 * at all; that is the whole distinction between public and private here.
 *
 * The second cost is shape: Trystero builds a FULL MESH, so N browsers on the
 * board is N² connections. Fine for a handful, not for a crowd — `maxPeers`
 * gives up and reports the board as full rather than melting a phone.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * COPY THIS FILE into src/engine/ alongside net.ts.
 */

import { createNet, type Net } from './net';

/** What a host advertises. Keep it small — this is broadcast every 2s. */
export interface RoomAd {
  /** The room code a browser would join. */
  code: string;
  /** Host's display name, so the list reads like people not codes. */
  host: string;
  players: number;
  max: number;
  /** True once a round is in progress — joiners land in the lobby, not mid-game. */
  playing: boolean;
  /** Optional one-liner: the mode, the round length, whatever fits. */
  note?: string;
}

export interface PublicRoom extends RoomAd {
  /** When we last heard from it (ms, local clock). */
  seenAt: number;
}

export interface NoticeboardConfig {
  appId: string;
  /** Fires whenever the visible list changes. */
  onRooms: (rooms: PublicRoom[]) => void;
  /** Drop a room after this long without an ad. Default 7s (~3 missed ads). */
  staleMs?: number;
  /** Refuse to keep meshing past this many peers. Default 24. */
  maxPeers?: number;
}

export interface Noticeboard {
  /** Start (or update) advertising this room. Host only. */
  announce(ad: RoomAd): void;
  /** Stop advertising — the room went private, started, or closed. */
  unannounce(): void;
  rooms(): PublicRoom[];
  /** True once the mesh is too crowded to keep growing (see maxPeers). */
  crowded(): boolean;
  destroy(): Promise<void>;
}

const ROOM_ID = '__board';

export function createNoticeboard(config: NoticeboardConfig): Noticeboard {
  const staleMs = config.staleMs ?? 7000;
  const maxPeers = config.maxPeers ?? 24;

  // A second Net, deliberately: the board is its own room, and the game room
  // must never be entangled with it. net.ts's registry keys on appId+roomId, so
  // holding both at once is fine.
  const net: Net = createNet({ appId: config.appId, roomId: ROOM_ID });

  const seen = new Map<string, PublicRoom>();
  let mine: RoomAd | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sendAd = net.channel<RoomAd>('ad', (ad, from) => {
    if (!ad?.code) return;
    // Key on the sender, not the advertised code: otherwise anyone could
    // overwrite (or evict) someone else's listing by claiming their code.
    seen.set(from, { ...ad, seenAt: Date.now() });
    publish();
  });

  // A newcomer should not wait out a whole announce cycle to see the list.
  const sendPing = net.channel<null>('adq', (_d, from) => {
    if (mine) sendAd(mine, from);
  });

  function live(): PublicRoom[] {
    const now = Date.now();
    for (const [id, r] of seen) if (now - r.seenAt > staleMs) seen.delete(id);
    return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  let last = '';
  function publish(): void {
    const rooms = live();
    // Only wake the UI on a real change — this ticks every second.
    const key = JSON.stringify(rooms.map((r) => [r.code, r.players, r.playing]));
    if (key === last) return;
    last = key;
    config.onRooms(rooms);
  }

  const sweep = setInterval(publish, 1000);
  sendPing(null);

  return {
    announce(ad: RoomAd) {
      mine = ad;
      sendAd(ad);
      if (!timer) timer = setInterval(() => mine && sendAd(mine), 2000);
    },

    unannounce() {
      mine = null;
      if (timer) clearInterval(timer);
      timer = undefined;
      // No "withdraw" message: silence IS the withdrawal, and it is the only
      // signal that also covers a closed tab, a dead network, or a crash.
    },

    rooms: live,
    crowded: () => net.count() > maxPeers,

    async destroy() {
      clearInterval(sweep);
      if (timer) clearInterval(timer);
      seen.clear();
      await net.leave();
    },
  };
}
