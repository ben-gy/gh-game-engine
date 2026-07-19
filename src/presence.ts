/**
 * presence.ts — "how many people are around right now", with no server.
 *
 * Social proof drives drop-in play: a live "3 playing · 5 looking" is the single
 * strongest nudge to join. With no backend, presence is a heartbeat: every peer
 * that has opted into public play joins ONE well-known extra room (`__presence`)
 * and beats `{id, room}` every few seconds. Everyone counts whoever they have
 * heard from recently; an entry expires on silence (TTL), so a closed tab, a
 * crash or a dead network simply drops off — the count self-heals without any
 * unreliable leave event.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAME PRIVACY COST AS THE NOTICEBOARD — READ IT.
 *
 * This is WebRTC. Joining `__presence` meshes you with the other people online,
 * and connecting exchanges ICE candidates that carry IP addresses. So presence
 * is a room of STRANGERS: it must be OPT-IN and disclosed. NEVER create it on
 * page load — a player who only plays with friends must never touch it. Create
 * it only once the player has chosen public play and seen the disclosure.
 *
 * Trystero is a full mesh (N² connections), so this is for tens of peers, not a
 * crowd — the same `maxPeers` ceiling as the noticeboard applies at scale.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * COPY THIS FILE into src/engine/ alongside net.ts.
 *
 *   const pres = createPresence({ appId: 'morsel', onChange: paintCounts });
 *   pres.setRoom(publicRoomCode);   // gossip which game room you're in
 *   // ...paintCounts({ online, rooms }) renders the numbers
 */

import { createNet, type Net } from './net';

export interface PresenceSnapshot {
  /** Distinct peers heartbeating right now, including yourself. */
  online: number;
  /** Live head-count per game-room code that peers report being in. */
  rooms: Record<string, number>;
}

export interface PresenceConfig {
  appId: string;
  /** Fires whenever the counts change. */
  onChange: (s: PresenceSnapshot) => void;
  /** The game room this peer starts in (or null: online but not in a room). */
  room?: string | null;
  /** Heartbeat interval. Default 5s. */
  beatMs?: number;
  /** Drop a peer after this long without a beat. Default 15s (~3 missed). */
  ttlMs?: number;
}

interface Beat {
  room: string | null;
}

interface Seen extends Beat {
  at: number;
}

export interface Presence {
  /** Report which game room you are in now — null when idle in the menu. */
  setRoom(room: string | null): void;
  snapshot(): PresenceSnapshot;
  /** Live count of peers reporting a given room code. */
  inRoom(room: string): number;
  destroy(): Promise<void>;
}

const ROOM_ID = '__presence';

export function createPresence(config: PresenceConfig): Presence {
  const beatMs = config.beatMs ?? 5000;
  const ttlMs = config.ttlMs ?? 15000;

  // A second Net, deliberately separate from any game room (net.ts keys its
  // registry on appId+roomId, so holding both at once is fine).
  const net: Net = createNet({ appId: config.appId, roomId: ROOM_ID });

  const seen = new Map<string, Seen>();
  let myRoom: string | null = config.room ?? null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sendBeat = net.channel<Beat>('beat', (b, from) => {
    seen.set(from, { room: b?.room ?? null, at: Date.now() });
    publish();
  });

  // A newcomer should not wait a whole beat to be counted, or to count others.
  const sendPing = net.channel<null>('preq', (_d, from) => {
    sendBeat({ room: myRoom }, from);
  });

  function prune(): void {
    const now = Date.now();
    for (const [id, s] of seen) if (now - s.at > ttlMs) seen.delete(id);
  }

  function snapshot(): PresenceSnapshot {
    prune();
    const rooms: Record<string, number> = {};
    // Count yourself, so a lone opener sees "1 online" not "0".
    if (myRoom) rooms[myRoom] = 1;
    for (const s of seen.values()) {
      if (s.room) rooms[s.room] = (rooms[s.room] ?? 0) + 1;
    }
    return { online: seen.size + 1, rooms };
  }

  let last = '';
  function publish(): void {
    const snap = snapshot();
    const key = JSON.stringify([snap.online, snap.rooms]);
    if (key === last) return;
    last = key;
    config.onChange(snap);
  }

  function beat(): void {
    sendBeat({ room: myRoom });
    publish();
  }

  timer = setInterval(beat, beatMs);
  const sweep = setInterval(publish, 1000);
  sendPing(null);
  beat();

  return {
    setRoom(room) {
      if (room === myRoom) return;
      myRoom = room;
      beat(); // announce the move immediately
    },
    snapshot,
    inRoom(room) {
      prune();
      let n = myRoom === room ? 1 : 0;
      for (const s of seen.values()) if (s.room === room) n++;
      return n;
    },
    async destroy() {
      if (timer) clearInterval(timer);
      clearInterval(sweep);
      seen.clear();
      await net.leave();
    },
  };
}
