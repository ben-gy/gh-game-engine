/**
 * net.ts — zero-backend P2P networking for browser games.
 *
 * Thin, game-friendly wrapper over Trystero (https://github.com/dmotz/trystero).
 * Trystero establishes an encrypted WebRTC mesh between everyone in a room using
 * FREE public infrastructure for the initial handshake — no per-game server,
 * which is exactly what GitHub Pages hosting needs. The default strategy here is
 * `nostr` (public Nostr relays); swap the import for `trystero/torrent` or
 * `trystero/mqtt` if relays are flaky in your region (see README).
 *
 * Netcode model this wrapper assumes: **host-authoritative star**. The host owns
 * authoritative game state and broadcasts snapshots; clients send inputs. For
 * deterministic lockstep games, pair this with rng.ts (shared seed) instead.
 *
 * The host is decided by INCUMBENCY WITH TERMS, not by an election on every join:
 * whoever holds the room announces `{host, epoch}`, everyone else adopts, and the
 * role only moves when the host LEAVES (survivors elect min-id at `epoch + 1`,
 * which they all compute identically). A peer that has heard nothing yet is
 * `unsettled` — isHost() is false and host() is null — so nobody can act as host
 * on a mesh that has not formed. See the host section below for why the epoch
 * matters as much as the incumbency.
 *
 * IMPORT THIS PACKAGE — do not copy this file into a game, and never edit it
 * inside node_modules. Game-specific behaviour goes in game code, via the
 * config, handlers and channels below.
 *
 * Trystero limits to remember:
 *  - Action names (channels) must be <= 12 bytes. Keep them short: 'mv','snap'.
 *  - Payloads are JSON-serialized (or ArrayBuffer/Blob for binary). Keep small.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE ROOM PER SESSION — THE RULE THAT MATTERS MOST
 *
 * Never leave a room and rejoin the same one to "reset" for a rematch. It looks
 * harmless and it is catastrophic. Trystero memoizes `joinRoom` on appId+roomId
 * (strategy.js: `if (occupiedRooms[appId]?.[roomId]) return occupiedRooms...`)
 * while `room.leave()` is ASYNC and defers its real teardown behind a ~99ms
 * timer (room.js). So `net.leave(); createNet(...)` in the same tick hands you
 * back the very room object that is about to be destroyed. Moments later the
 * deferred teardown clears the announce timer and unsubscribes from every relay
 * — your "fresh" Net is a corpse: permanently deaf, roster of one, and every
 * peer elects itself host. Both players sit in the right room code, alone.
 *
 * Keep the mesh alive and version the rounds inside it — see rematch.ts.
 * `createNet` enforces this: rejoining a room that is still tearing down throws.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Default = nostr strategy. To switch: `import { joinRoom, selfId } from 'trystero/torrent'`.
//
// `joinRoom`/`selfId` come from 'trystero' because only that module's types
// include TurnConfig — 'trystero/nostr' redeclares joinRoom as
// `BaseRoomConfig & RelayConfig` and would silently drop `turnConfig` from the
// accepted config. `getRelaySockets` is the mirror image: re-exported by
// 'trystero' at runtime (index.js does `export {getRelaySockets} from
// './nostr.js'`) but only DECLARED in 'trystero/nostr'. Both specifiers resolve
// to the same ES module instance, so this split is types-only — not two clients.
import { joinRoom, selfId } from 'trystero';
import { getRelaySockets } from 'trystero/nostr';

export type PeerId = string;

/** Cheap deep-ish JSON-safe payloads. Trystero handles ArrayBuffer/Blob too. */
export type NetData = unknown;

/**
 * Wire-protocol revision. Bump ONLY when a change to the messages on the wire
 * would make an updated build and a cached old build misunderstand each other.
 *
 * It is folded into the appId by `roomAppId()`, so bumping it partitions the two
 * builds into different signaling namespaces. That is the point: a player on a
 * cached build lands in a room where they simply never see the updated players,
 * which is honest, instead of half-connecting and desyncing in ways that read to
 * the player as "the game is broken".
 *
 * rev 2 = epoch host election + start re-broadcast (engine v1.1.0).
 */
export const PROTOCOL_REV = 2;

/**
 * The appId to hand `createNet`. ALWAYS build it with this — never pass a raw
 * slug — so a protocol bump partitions old builds automatically. It also
 * namespaces the `__presence` and `__board` meshes correctly, since those key
 * off the appId too.
 *
 *   createNet({ appId: roomAppId('tiny-tanks'), roomId: code })
 */
export function roomAppId(slug: string): string {
  return `${slug}@${PROTOCOL_REV}`;
}

/**
 * Curated Nostr relays for signaling, shared by the whole fleet so one update
 * fixes every game at once.
 *
 * Trystero's built-in defaults are fine until they are not: public relays are
 * best-effort, rate-limited, and come and go. Two peers subscribed to
 * non-overlapping live subsets never discover each other — one of the two causes
 * of "we're in the same room but I can't see them" (the other is missing TURN,
 * see `turnConfig`). These are long-running, high-uptime, open-access relays, so
 * with Trystero's redundancy a single relay having a bad day stays invisible.
 */
export const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.snort.social',
];

export interface NetConfig {
  /** Namespaces your game on the shared signaling infra. Use `roomAppId(slug)`. */
  appId: string;
  /** Room id — the shareable code. Peers with the same appId+roomId connect. */
  roomId: string;
  /** Optional shared secret — end-to-end encrypts signaling AND data channels.
   *  Derive it from a code in the invite link for private rooms. */
  password?: string;
  /**
   * True only when THIS peer minted the code ("Create a room"). It then hosts
   * immediately instead of waiting to hear from an incumbent. Anyone arriving
   * via a link, a typed code, or the public list must leave this false, or two
   * peers will race to host the same room.
   */
  claimHost?: boolean;
  /**
   * TURN relays, normally from `getTurnConfig()` (turn.ts). Without these, ICE
   * is STUN-only, and any pair that cannot form a direct path — a phone on
   * carrier CGNAT, a locked-down office or school network — sees the other in
   * signaling while the data channel never opens, so `onPeerJoin` never fires.
   * Games are mobile-first, so this is the single highest-value thing to pass.
   * Fail-open: an empty array is exactly the old STUN-only behaviour.
   */
  turnConfig?: RTCIceServer[];
  /** Full ICE override, if a game ever needs to bypass the above entirely. */
  rtcConfig?: RTCConfiguration;
  /** Signaling relays. Defaults to `DEFAULT_RELAYS`. */
  relayUrls?: string[];
  /**
   * How many of the relays to actually use. Applied by trimming the list above,
   * because Trystero ignores its own `relayRedundancy` whenever `relayUrls` is
   * supplied (utils.js `getRelays` slices to `relayUrls.length` first) — and we
   * always supply it. Leave unset to use them all.
   */
  relayRedundancy?: number;
}

export interface NetHandlers {
  /** A peer connected. */
  onPeerJoin?: (id: PeerId) => void;
  /** A peer disconnected (tab closed, network dropped). */
  onPeerLeave?: (id: PeerId) => void;
  /** Roster changed (join OR leave). Gives the full, sorted peer list + self. */
  onPeers?: (peers: PeerId[], selfId: PeerId) => void;
  /** The elected host changed (initial election, or host left). */
  onHostChange?: (hostId: PeerId, isSelfHost: boolean) => void;
}

/** Unsubscribe a receiver registered via `channel()` or `onPeersChange()`. */
export type Unsubscribe = () => void;

/** What the room looks like right now — for `?netdebug=1` HUDs and bug reports. */
export interface NetDiag {
  selfId: PeerId;
  host: PeerId | null;
  epoch: number;
  settled: boolean;
  peers: PeerId[];
  /**
   * Per-relay WebSocket readyState, so "nobody else is here" can be told apart
   * from "we never reached signaling at all".
   * 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED.
   */
  relaySockets: Record<string, number>;
  /** True when TURN relays were supplied — i.e. CGNAT pairs should connect. */
  turn: boolean;
}

export interface Net {
  /** This peer's stable id for the session. */
  readonly selfId: PeerId;
  /** All connected peers plus self, sorted — identical order on every client. */
  peers(): PeerId[];
  /** The current host, or null while the room is still settling. */
  host(): PeerId | null;
  /**
   * True when THIS peer is the authoritative host. FALSE until the room has
   * settled, so a peer whose mesh has not formed never acts as host — that is
   * what stops two players each hosting their own half of a broken room.
   */
  isHost(): boolean;
  /**
   * False for the first moments in a room, while we wait to hear from an
   * incumbent host. Render "connecting…" rather than a host badge until this is
   * true, and gate any host-only control on it.
   */
  hostSettled(): boolean;
  /**
   * The current host's term. Higher always wins, which is what stops a peer that
   * self-elected during a partition from stealing a live room when it heals.
   */
  hostEpoch(): number;
  /** How many are in the room right now (peers + self). */
  count(): number;
  /**
   * Subscribe to roster changes (join OR leave), fanning out to every caller.
   * `onPeers` in NetHandlers is a single slot owned by whoever called
   * `createNet`; this is how rematch.ts, a lobby and a debug HUD can all watch
   * the roster at once without fighting over that slot.
   */
  onPeersChange(cb: (peers: PeerId[]) => void): Unsubscribe;
  /**
   * Register a receive handler for a named channel. Returns a `send` function.
   * `send(data)` broadcasts to all; `send(data, toPeers)` targets a subset.
   *
   * Handlers FAN OUT: calling channel() twice with the same name registers both
   * receivers and both fire. (The old build memoized on name and silently threw
   * the second receiver away, which made any second subsystem on a live net —
   * a rematch lobby, a fresh round — permanently deaf.) Use `send.off()` to
   * detach one receiver without disturbing the others.
   */
  channel<T = NetData>(
    name: string,
    onReceive: (data: T, from: PeerId) => void,
  ): ((data: T, toPeers?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
  /** Round-trip latency (ms) to a peer, measured via the ping channel. */
  ping(id: PeerId): Promise<number>;
  /**
   * Explicitly take the room as host, minting a NEW term so every peer adopts
   * us. This is a UX decision, never a transport one: the only legitimate caller
   * is a deliberate user action ("Nobody's here yet — host this room?" in
   * lobby.ts) after a long unsettled wait. Calling it automatically would
   * re-create exactly the phantom-host bug the epoch model exists to kill.
   */
  takeover(): void;
  /** Room snapshot for debug overlays and bug reports. */
  netDiag(): NetDiag;
  /**
   * Tear down the room and all channels. Call on leave — NOT between rounds.
   * Resolves once Trystero has actually retired the room, so it is safe to join
   * the same room id again afterwards. Always `await` it before any rejoin.
   */
  leave(): Promise<void>;
}

/** min-id election: everyone computes the same host from the same sorted list. */
function electHost(peers: PeerId[]): PeerId {
  return peers.reduce((min, p) => (p < min ? p : min), peers[0]);
}

// ── join registry ───────────────────────────────────────────────────────────
// Tracks which rooms this page has open so the leave/rejoin trap above fails
// loudly at the call site instead of silently producing a dead mesh. Also backs
// netStats() so tests can assert the "one join per session" invariant directly,
// without needing a network, a relay model, or a browser.

type RoomPhase = 'joined' | 'leaving';
const registry = new Map<string, RoomPhase>();
let joinCount = 0;

const roomKey = (appId: string, roomId: string): string => `${appId}|${roomId}`;

export interface NetStats {
  /** Total createNet() calls since reset — the rematch invariant asserts this. */
  joins: number;
  /** Rooms currently joined or tearing down. */
  active: string[];
}

/** Introspection for tests and dev HUDs. */
export function netStats(): NetStats {
  return {
    joins: joinCount,
    active: [...registry.keys()].map((k) => k.replace('|', '/')),
  };
}

/** Test-only: clear the registry between cases. */
export function resetNetStats(): void {
  registry.clear();
  joinCount = 0;
}

/**
 * How long to wait for an incumbent to announce before considering a fallback
 * election. Three times the announce interval, so a joiner sees at least one
 * announce from a healthy host even if it arrives mid-interval and a packet is
 * lost. The old value was 2.5s, which Nostr discovery + ICE on mobile routinely
 * exceeds — that is what let a joiner self-elect on an empty roster and then
 * steal a live room. See `scheduleSettle`.
 */
export const SETTLE_MS = 6000;

/** How often the host re-announces its term. */
export const ANNOUNCE_MS = 2000;

/**
 * TURN servers every mesh on this page should use. See `setTurnConfig`.
 */
let sharedTurn: RTCIceServer[] = [];

/**
 * Set the TURN config for EVERY mesh this page creates. Call it once at boot,
 * before any `createNet` / `createPresence` / `createNoticeboard`:
 *
 *   setTurnConfig(await getTurnConfig());
 *
 * WHY THIS IS NOT JUST A PER-ROOM OPTION. Trystero allocates ONE global pool of
 * 20 pre-built RTCPeerConnections per page, from the config of whichever
 * `joinRoom` fires FIRST (strategy.js, `if (!didInit) offerPool = alloc(...)`).
 * Every later room draws its OUTBOUND offers from the head of that pool. So if a
 * turnless mesh is created first — `__presence` or `__board` on a menu, neither
 * of which takes a turnConfig — the game room's *initiating* half is STUN-only
 * however carefully the game passed `turnConfig` to `createNet`. Trystero picks
 * the initiator by peer id, so that silently leaves TURN working in one
 * direction for roughly half of all pairs, which is far harder to diagnose than
 * having no TURN at all.
 *
 * Setting it here means the first join on the page already carries TURN and the
 * secondary meshes inherit it, whatever order the game creates them in.
 */
export function setTurnConfig(servers: RTCIceServer[]): void {
  sharedTurn = servers;
}

/** The TURN config currently in force for new meshes. */
export function getSharedTurnConfig(): RTCIceServer[] {
  return sharedTurn;
}

export function createNet(config: NetConfig, handlers: NetHandlers = {}): Net {
  const key = roomKey(config.appId, config.roomId);
  const phase = registry.get(key);
  if (phase === 'leaving') {
    throw new Error(
      `net: rejoined "${config.roomId}" while it was still tearing down. Trystero ` +
        `would hand back the dying room and the mesh would never form (both peers ` +
        `become host, alone). For a rematch, keep the Net and start a new round ` +
        `(see rematch.ts). To genuinely leave and come back, "await net.leave()" first.`,
    );
  }
  if (phase === 'joined') {
    throw new Error(
      `net: already joined "${config.roomId}" — reuse the existing Net rather than ` +
        `creating a second one for the same room.`,
    );
  }
  registry.set(key, 'joined');
  joinCount++;

  // Falls back to the page-wide config so `__presence` / `__board`, which have
  // no turnConfig of their own, never poison the shared offer pool.
  const turnConfig = config.turnConfig ?? sharedTurn;
  const allRelays = config.relayUrls ?? DEFAULT_RELAYS;
  const relayUrls = config.relayRedundancy
    ? allRelays.slice(0, config.relayRedundancy)
    : allRelays;
  const room = joinRoom(
    {
      appId: config.appId,
      ...(config.password ? { password: config.password } : {}),
      // Trystero types turnConfig with its own structural shape rather than
      // RTCIceServer[]; the two are compatible, and RTCIceServer is what games
      // and getTurnConfig() naturally speak.
      ...(turnConfig.length ? { turnConfig: turnConfig as never } : {}),
      ...(config.rtcConfig ? { rtcConfig: config.rtcConfig } : {}),
      relayUrls: relayUrls,
    },
    config.roomId,
  );

  /**
   * Trystero's senders are async and reject if a targeted peer vanished between
   * our roster read and the send — which now happens routinely, because the
   * epoch protocol unicasts corrections and rematch.ts unicasts start
   * re-broadcasts and retries. One unhandled rejection per departing peer would
   * bury real errors in console noise, so every fire-and-forget send goes
   * through here. Nothing sent this way is worth failing a frame over: the
   * announce loop, the resync poll and the retry ladder all re-send anyway.
   */
  const fire = (
    send: (d: never, to?: PeerId | PeerId[]) => unknown,
    d: unknown,
    to?: PeerId,
  ): void => {
    try {
      void Promise.resolve(send(d as never, to)).catch(() => {});
    } catch {
      /* peer already gone — whichever loop sent this will retry on its next tick */
    }
  };

  /** name -> the fan-out set of receivers, plus the memoized trystero sender. */
  interface Chan {
    send: (d: NetData, to?: PeerId | PeerId[]) => void;
    handlers: Set<(data: never, from: PeerId) => void>;
  }
  const chans = new Map<string, Chan>();

  // ── host: incumbency WITH TERMS ────────────────────────────────────────────
  // The original rule was "host = smallest peer id among live peers", recomputed
  // on every join. That silently handed the room to whoever arrived next if their
  // id happened to sort lower — a coin flip on every join, and the new host held
  // none of the game state.
  //
  // Plain incumbency fixed the steady state but not the transient: a joiner that
  // heard nothing within 2.5s elected ITSELF on a roster of one, and when the
  // mesh finally formed the two claimants resolved by min-id — so about half the
  // time the newcomer took a live room, mid-game, holding no state. Incumbency
  // cannot arbitrate that on its own, because both peers sincerely believe they
  // host and neither has any way to rank the claims.
  //
  // So announcements carry a TERM. The rules, in full:
  //
  //  1. Higher epoch always wins. Equal epoch falls back to min-id, which both
  //     sides compute identically (dual-create in the same instant, or a healed
  //     partition). Lower epoch is ignored — and if WE are the incumbent we
  //     immediately unicast our own announce back, so a stale claimant
  //     capitulates within one message instead of waiting out an interval.
  //  2. A peer NEVER self-elects on an empty roster. No peers connected is not
  //     evidence that the room is empty, only that our mesh has not formed. We
  //     stay unsettled and the UI keeps saying "connecting", which is the truth.
  //     This alone kills the phantom host: the mid-game steal required a solo
  //     self-election followed by a min-id coin flip.
  //  3. The settle window is generous (SETTLE_MS) and RESTARTS on every new
  //     connection while unsettled — a just-opened channel means announces may
  //     be in flight, so the incumbent always gets a full window to be heard.
  //  4. The fallback election (peers present, total silence past the window)
  //     mints epoch 1, the lowest possible term. It therefore can never outrank
  //     a real incumbent after a transfer, and at worst ties a silent creator at
  //     epoch 1, where min-id converges them deterministically.
  //  5. A host leaving is the only legitimate transfer: every survivor runs the
  //     same min-id election and adopts at epoch + 1, and the winner announces at
  //     the new term, correcting anyone who missed the leave.
  //  6. A CLAIM beats a BELIEF at equal term. Rules 4 and 5 elect a host
  //     LOCALLY, from whatever roster we happened to hold — and rosters differ
  //     between peers during a transfer. A peer that announces is provably
  //     hosting; a peer we merely elected is not. So at equal epoch, an
  //     unclaimed local belief yields to a real claimant, and min-id decides
  //     only between two genuine claims.
  //  7. Our own leave detection is not evidence about anyone else's. Trystero
  //     tears a peer down on a transient `connectionState === 'disconnected'`,
  //     per connection, so a Wi-Fi-to-cellular handover can make us the ONLY
  //     peer that saw the host leave. A promotion of someone else is therefore
  //     provisional: if nobody claims the new term within a settle window, we
  //     drop back to unsettled and let the room tell us who hosts.
  //
  // Rules 6 and 7 exist because rules 4 and 5 assume every peer observes the
  // same events. They do not — which is how a peer ended up permanently settled
  // on a host that was not hosting, receiving no round starts at all.
  let currentHost: PeerId | null = null;
  /** The current host's term. 0 = we have never heard a host. */
  let epoch = 0;
  let settled = false;
  /**
   * Whether `currentHost` has actually CLAIMED this term to us, rather than
   * being the result of our own local election (a leave transfer or the settle
   * fallback). A locally-elected host is a belief, not a fact, and rule 6 below
   * uses that distinction to break a tie in favour of a peer that is provably
   * hosting.
   */
  let hostClaimed = false;
  let announceTimer: ReturnType<typeof setInterval> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Armed when we promote a DIFFERENT peer on a host leave, to verify that the
   * peer actually noticed it won. See rule 7 and `onPeerLeave`.
   */
  let promoteTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function clearPromotion(): void {
    if (promoteTimer) clearTimeout(promoteTimer);
    promoteTimer = undefined;
  }

  const roster = (): PeerId[] => [selfId, ...Object.keys(room.getPeers())].sort();

  /** Roster-change subscribers (see `onPeersChange`). */
  const peersSubs = new Set<(peers: PeerId[]) => void>();
  function notifyPeersChange(): void {
    const list = roster();
    handlers.onPeers?.(list, selfId);
    // Copy first so a subscriber that unsubscribes mid-dispatch is safe.
    for (const cb of [...peersSubs]) cb(list);
  }

  // A `type` alias, not an interface: Trystero constrains payloads to its
  // JsonValue-indexed DataPayload, and TypeScript only gives object *type
  // aliases* an implicit index signature — an interface would fail to satisfy it.
  type HostMsg = { host: PeerId; epoch: number };
  const [sendHost, getHost] = room.makeAction<HostMsg>('__h');

  function adopt(next: PeerId, e: number, claimed = false): void {
    clearPromotion();
    const changed = next !== currentHost || !settled;
    currentHost = next;
    epoch = e;
    settled = true;
    // Hosting ourselves is self-evidently claimed; anything we worked out
    // locally is provisional until its winner announces.
    hostClaimed = claimed || next === selfId;
    if (next === selfId) startAnnouncing();
    else stopAnnouncing();
    if (changed) handlers.onHostChange?.(next, next === selfId);
  }

  function startAnnouncing(): void {
    if (announceTimer || closed) return;
    fire(sendHost, { host: selfId, epoch });
    announceTimer = setInterval(() => fire(sendHost, { host: selfId, epoch }), ANNOUNCE_MS);
  }

  function stopAnnouncing(): void {
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = undefined;
  }

  getHost((msg, from) => {
    // Trust only a peer claiming itself, so a stale forward cannot install a
    // host nobody can see.
    if (msg.host !== from) return;
    // Wire hygiene: a malformed or pre-epoch payload must not read as term NaN
    // and win (or lose) every comparison by accident.
    if (typeof msg.epoch !== 'number' || !Number.isFinite(msg.epoch)) return;

    // The peer we promoted is claiming a term, so it did see the leave and our
    // promotion was right. Stand the verification timer down (rule 7).
    if (from === currentHost && msg.epoch >= epoch) clearPromotion();

    // Unsettled: adopt whoever announces, WHATEVER their id. This is the line
    // that kills the steal — the old code ran a min-id comparison here, so an
    // incumbent whose id happened to sort high lost the room to the peer that
    // had just walked in holding no state at all.
    if (!settled || msg.epoch > epoch) return adopt(from, msg.epoch, true);

    if (msg.epoch === epoch) {
      if (from === currentHost) {
        hostClaimed = true;
        return;
      }
      // Rule 6: a CLAIM beats a BELIEF at equal term. Our host may have been
      // elected locally — by a leave transfer or the settle fallback — from a
      // roster that differed from everyone else's. `from` is demonstrably
      // hosting, because it just said so; min-id here would pin us to a peer
      // that nobody is hosting from, and would re-pin us on every announce.
      if (!hostClaimed) return adopt(from, epoch, true);
      // Two peers both genuinely claim this term — created in the same instant,
      // or a partition just healed. Both sides apply the same rule, so they
      // converge without a negotiation.
      const win = from < currentHost! ? from : currentHost!;
      return adopt(win, epoch, win === from);
    }

    // Stale term. If we are the incumbent, correct the claimant immediately so a
    // zombie that self-elected during a partition capitulates within one message
    // instead of announcing at everyone for a full interval.
    if (currentHost === selfId) fire(sendHost, { host: selfId, epoch }, from);
  });

  function scheduleSettle(): void {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (settled || closed) return;
      // Invariant 2: never self-elect alone. Silence on a roster of one is not
      // evidence of an empty room, it is evidence of no mesh. Keep waiting —
      // lobby.ts offers an explicit "host this room?" takeover after a while.
      if (roster().length === 1) return scheduleSettle();
      // Invariant 4: peers present and total silence past the window — this room
      // genuinely has no host. Mint term 1, the lowest possible, so we can never
      // outrank a real incumbent we simply have not heard from yet.
      adopt(electHost(roster()), 1);
    }, SETTLE_MS);
  }

  if (config.claimHost) {
    // This peer minted the code, so there is no incumbent to defer to. Claiming
    // straight away keeps "Create a room" instant, at term 1.
    adopt(selfId, 1);
  } else {
    scheduleSettle();
  }

  room.onPeerJoin((id) => {
    handlers.onPeerJoin?.(id);
    notifyPeersChange();
    // Invariant 3: a channel just opened, so announces may be in flight. Give
    // the incumbent a fresh full window rather than timing out mid-handshake.
    if (!settled) scheduleSettle();
    // Deliberately NOT a re-election — incumbency is the whole point. Just tell
    // the newcomer who is in charge, and at which term, so it settles without
    // waiting out its own timer.
    if (settled && currentHost === selfId) fire(sendHost, { host: selfId, epoch }, id);
  });

  room.onPeerLeave((id) => {
    handlers.onPeerLeave?.(id);
    notifyPeersChange();
    // The one case where the host legitimately changes. Trystero deletes the
    // peer from its map before invoking this (room.js `exitPeer`), so roster()
    // already excludes it — the filter is belt and braces against that ordering
    // ever changing, because electing the peer that just left would strand the
    // whole room on a host nobody can reach.
    if (id === currentHost) {
      const survivors = roster().filter((p) => p !== id);
      if (!survivors.length) return;
      const winner = electHost(survivors);
      adopt(winner, epoch + 1);
      // Rule 7: a leave is observed PER CONNECTION. Trystero tears a peer down
      // on a transient `connectionState === 'disconnected'` (peer.js) — a Wi-Fi
      // to cellular handover is enough — so ours may be the only leave in the
      // room. If it is, the peer we just promoted never ran this election, never
      // announces, and the live host's announce now looks stale to us and is
      // dropped in silence. We would sit settled forever on a peer that is not
      // hosting, receiving no round starts: stranded, with no path back.
      //
      // So the promotion is PROVISIONAL when the winner is not us. If nobody
      // claims the new term within a settle window, we treat our own election as
      // unsound and go back to listening — the real host's next announce then
      // takes the `!settled` path and heals us.
      if (winner !== selfId) {
        promoteTimer = setTimeout(() => {
          promoteTimer = undefined;
          if (closed || !settled || currentHost === selfId) return;
          settled = false;
          hostClaimed = false;
          scheduleSettle();
        }, SETTLE_MS);
      }
    }
  });

  // Built-in ping/pong channel for latency HUDs and lag compensation.
  const pending = new Map<string, (rtt: number) => void>();
  const [sendPing, getPing] = room.makeAction<{ t: number; id: string; pong?: boolean }>('ping');
  getPing((msg, from) => {
    if (msg.pong) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(performance.now() - msg.t);
      }
    } else {
      fire(sendPing, { ...msg, pong: true }, from);
    }
  });

  return {
    selfId,
    peers: roster,
    host: () => currentHost,
    isHost: () => settled && currentHost === selfId,
    hostSettled: () => settled,
    hostEpoch: () => epoch,
    count: () => roster().length,

    onPeersChange(cb: (peers: PeerId[]) => void): Unsubscribe {
      peersSubs.add(cb);
      return () => {
        peersSubs.delete(cb);
      };
    },

    channel<T = NetData>(name: string, onReceive: (data: T, from: PeerId) => void) {
      if (name.length > 12) {
        // Trystero hard-limits action names to 12 bytes; fail loud in dev.
        throw new Error(`net channel "${name}" exceeds 12 bytes`);
      }
      let chan = chans.get(name);
      if (!chan) {
        // Trystero constrains payloads to a JSON/binary type; our channels are
        // generic JSON so we bridge through the untyped makeAction here.
        const make = room.makeAction as unknown as (
          n: string,
        ) => [
          (d: NetData, to?: PeerId | PeerId[]) => void,
          (cb: (d: NetData, from: PeerId) => void) => void,
        ];
        const [send, get] = make(name);
        const created: Chan = { send, handlers: new Set() };
        // One trystero receiver per name, fanning out to every subscriber. Copy
        // the set first so a handler that unsubscribes mid-dispatch is safe.
        get((data, from) => {
          for (const h of [...created.handlers]) (h as (d: NetData, f: PeerId) => void)(data, from);
        });
        chans.set(name, created);
        chan = created;
      }
      const handler = onReceive as (data: never, from: PeerId) => void;
      chan.handlers.add(handler);

      const send = ((data: T, to?: PeerId | PeerId[]) => {
        // Same rejection-swallowing rationale as `fire`, but preserving the
        // multi-target signature games use.
        try {
          void Promise.resolve(chan!.send(data, to)).catch(() => {});
        } catch {
          /* target vanished mid-send */
        }
      }) as ((data: T, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
      send.off = () => {
        chan!.handlers.delete(handler);
      };
      return send;
    },

    ping(id: PeerId) {
      return new Promise<number>((resolve) => {
        const pid = `${performance.now()}-${Math.floor(Math.random() * 1e6)}`;
        pending.set(pid, resolve);
        fire(sendPing, { t: performance.now(), id: pid }, id);
        setTimeout(() => {
          if (pending.delete(pid)) resolve(Infinity);
        }, 5000);
      });
    },

    takeover() {
      if (closed) return;
      // Mint a term strictly above anything we have heard, so every peer adopts
      // us rather than arguing by id. If a real incumbent IS out there but
      // unreachable, this is still the right outcome: we are now hosting the
      // half of the room that can actually see each other.
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      adopt(selfId, epoch + 1);
    },

    netDiag(): NetDiag {
      let relaySockets: Record<string, number> = {};
      try {
        relaySockets = Object.fromEntries(
          Object.entries(getRelaySockets()).map(([url, ws]) => [url, ws?.readyState ?? 3]),
        );
      } catch {
        /* a strategy without relay introspection — leave it empty */
      }
      return {
        selfId,
        host: currentHost,
        epoch,
        settled,
        peers: roster(),
        relaySockets,
        turn: turnConfig.length > 0,
      };
    },

    async leave() {
      // Mark 'leaving' BEFORE awaiting: trystero keeps the room in its own cache
      // until teardown completes, so any join in that window aliases the corpse.
      // The registry entry is what turns that silent trap into a thrown error.
      registry.set(key, 'leaving');
      closed = true;
      stopAnnouncing();
      clearPromotion();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = undefined;
      try {
        await room.leave();
      } finally {
        registry.delete(key);
        chans.clear();
        pending.clear();
        peersSubs.clear();
      }
    },
  };
}

/** Export selfId for callers that need it before createNet (e.g. UI seeds). */
export { selfId };
