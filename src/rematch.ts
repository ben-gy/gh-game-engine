/**
 * rematch.ts — multi-round sessions inside ONE living P2P room.
 *
 * The problem this exists to solve: the obvious way to write "Play again" is to
 * leave the room and rejoin it. That is a trap. Trystero memoizes joinRoom on
 * appId+roomId while room.leave() defers its teardown ~99ms, so a same-tick
 * rejoin aliases the dying room: no relay subscription, no announce loop, an
 * empty peer map. Every peer then elects ITSELF host and sits alone in a room
 * with the right code. It is deterministic, it is permanent, and it looks
 * exactly like "we're both the host and can't see each other".
 *
 * So: never leave. Keep one Net for the room's whole life and version the
 * rounds inside it. This module owns that protocol.
 *
 *   const rounds = createRounds({ net, playerName, minPlayers: 2,
 *     onRound: ({ round, seed, players, isHost, seated }) => startGame(...) });
 *
 *   rounds.vote();          // "I'm ready" / "Play again"
 *   rounds.unvote();        // backed out
 *   rounds.go();            // host only: start now with whoever has voted
 *   rounds.state();         // { round, phase, votes, canStart, ... } for rendering
 *
 * Two properties everything else depends on:
 *
 *  1. THE ROSTER TRAVELS WITH THE START. The host freezes {id,name}[] into the
 *     start message, so every peer builds identical player indices from the same
 *     bytes. Deriving the roster locally (the old 'go' carried only a seed) lets
 *     two peers disagree about who is player 0 — scores land on the wrong name.
 *
 *  2. ROUNDS ARE NUMBERED AND MONOTONIC. A start for a round we have already
 *     played is ignored, so a duplicate or late-delivered start cannot restart a
 *     live game, and two peers pressing at once cannot double-fire. Everything
 *     in the delivery hardening below leans on this: re-broadcasts and retries
 *     are free precisely because a duplicate start is a no-op.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY PLAYERS USED TO GET "EJECTED" AT ROUND START (01-DIAGNOSIS §3)
 *
 * Three defects stacked into one symptom — a player who readied up, watched the
 * round begin without them, and was left in a dead lobby:
 *
 *  3a. The host froze the roster from its OWN PARTIAL VIEW of a still-forming
 *      mesh. `maybeAutoStart()` fired the instant everyone the host could
 *      *currently see* had voted — 2 of 4 joiners is "everyone" if the other two
 *      have not connected to the host yet. Closed by ROSTER_SETTLE_MS below.
 *  3b. Trystero `makeAction` only reaches peers whose data channel is ALREADY
 *      open, and 'rs' is only trusted `from === net.host()`. A peer whose
 *      channel opened one second late received nothing and never learned a round
 *      had started. Closed by re-broadcasting `lastStart` to late connectors.
 *  3c. Votes sent before a peer's channels opened were lost, so the grace
 *      countdown excluded players who had genuinely readied up. Closed by the
 *      ack + retry ladder, with the 1.5s resync poll as the backstop.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Net, PeerId, Unsubscribe } from './net';

/**
 * How long the roster must be quiet before an automatic start is allowed.
 * Closes 01-DIAGNOSIS §3a: a mesh mid-formation produces a burst of joins, and
 * starting inside that burst freezes a roster missing whoever was one handshake
 * behind. Four seconds is comfortably longer than a WebRTC handshake between
 * peers that have already found each other in signaling, and the 1.5s resync
 * poll re-attempts the start as soon as the window passes, so the cost when the
 * room is genuinely settled is at most one poll tick.
 *
 * The host's explicit `go()` is deliberately NOT gated by this — a human
 * pressing Start has decided who is playing.
 */
export const ROSTER_SETTLE_MS = 4000;

/** How often the host retries an unacknowledged start. Closes §3b/§3c. */
const ACK_RETRY_MS = 1000;

/**
 * How many times the host re-sends a start to a peer that has not acked. Five
 * seconds of retries outlasts any plausible channel-open delay; past that the
 * peer is gone, not slow, and the re-broadcast on reconnect covers its return.
 */
const ACK_MAX_RETRIES = 5;

export interface RoundPlayer {
  id: PeerId;
  name: string;
}

export interface RoundInfo<O = unknown> {
  /** 1-based. Increments per rematch; never repeats. */
  round: number;
  /** Shared RNG seed — identical on every peer (see rng.ts). */
  seed: number;
  /** Frozen, ordered roster. Index N is player N on EVERY peer. */
  players: RoundPlayer[];
  /** True if this peer is the authoritative host for this round. */
  isHost: boolean;
  /**
   * Whether THIS peer is in the frozen roster and therefore actually playing.
   *
   * False means the round started without us — we connected mid-round, or our
   * vote never reached the host in time. The round still begins locally (phase
   * becomes 'playing') so the UI can render the game in progress, but the game
   * must not try to seat us: render spectator, and let lobby.ts show "round in
   * progress — you're in the next one" with the vote UI live. Before this flag
   * existed, an unseated peer hit a silent dead screen, which is what "I got
   * ejected" actually looked like from the player's seat.
   */
  seated: boolean;
  /**
   * The host's game settings for this round — board size, round length,
   * difficulty, whatever the game offers. Travels WITH the start for the same
   * reason the roster does: a setting each peer reads from its own UI is a
   * setting two peers can disagree about, and then they are playing different
   * games on the same board.
   */
  opts: O;
}

export type RoundPhase = 'waiting' | 'playing';

export interface RoundsState {
  /** Round currently playing, or the last one played. 0 before the first. */
  round: number;
  phase: RoundPhase;
  /** Peers who have voted for the next round, in roster order. */
  votes: RoundPlayer[];
  /** Everyone currently in the room, voted or not. */
  present: RoundPlayer[];
  /** This peer has voted for the next round. */
  voted: boolean;
  isHost: boolean;
  /** Host-only: enough votes to start (>= minPlayers). */
  canStart: boolean;
  /**
   * Whether this peer is playing the CURRENT round. Only meaningful while
   * `phase === 'playing'`; a lobby renders the "you're in the next one" state
   * when this is false. See `RoundInfo.seated`.
   */
  seated: boolean;
  /**
   * The HOST's current settings, as gossiped — what the next round will use.
   * Null until the host has been heard from. Never render a local setting as if
   * it were the host's.
   */
  hostOpts: unknown;
  /**
   * Ms until the round starts without the peers who have not voted, or null if
   * no countdown is running. Render it — a silent wait is indistinguishable from
   * a hang, which is exactly how the old unanimity rule felt.
   */
  startsInMs: number | null;
}

export interface RoundsConfig {
  net: Net;
  /** This peer's display name, gossiped with its vote. */
  playerName: string;
  /** Minimum players before a round can start. Default 2. */
  minPlayers?: number;
  /**
   * Start automatically once EVERY peer present has voted (and >= minPlayers).
   * This is what makes "both players hit Play again" just work. Default true.
   * The host can always start early with `go()`.
   */
  autoStart?: boolean;
  /**
   * Once quorum is reached but some peers still have not voted, how long to hold
   * the round for them before starting anyway. Default 8s. This is the escape
   * hatch from waiting on a player who is never going to tap.
   */
  graceMs?: number;
  /**
   * Host-only: the settings to freeze into the next round's start. Read at go()
   * time so the host's current lobby choice is what everyone plays.
   */
  roundOpts?: () => unknown;
  /** Fires on every peer, for every round, with identical seed + roster + opts. */
  onRound: (info: RoundInfo) => void;
  /** Anything changed that a lobby/results screen should repaint for. */
  onChange?: (state: RoundsState) => void;
}

export interface Rounds {
  /** Declare intent to play the next round ("ready" / "play again"). */
  vote(): void;
  /** Withdraw that intent. */
  unvote(): void;
  /** Host only: start the next round now with whoever has voted. */
  go(): void;
  /** Mark the current round finished — reopens voting for a rematch. */
  finish(): void;
  state(): RoundsState;
  /** Detach every receiver and timer. Does NOT leave the room. */
  destroy(): void;
}

/** Vote message. `name` rides along so a voter is never rendered as "…". */
interface VoteMsg {
  /** The round this vote is FOR (current + 1). Stale votes are dropped. */
  round: number;
  name: string;
  in: boolean;
  /**
   * The sender's CURRENT round number. Only the host's is trusted, and it lets a
   * peer that fell behind catch up to the host's timeline. Without it, a peer
   * that joined late — or left, was promoted away from, and rejoined — starts at
   * round 0 while the incumbent is several rounds in, so its votes are all "for"
   * the wrong round and silently dropped: it can never ready up, a soft-deadlock
   * reachable via host-transfer-then-rejoin. See the 'rv' handler.
   */
  cur?: number;
  /**
   * The sender's current game settings. Only the HOST's are ever used — this
   * rides the presence gossip so a lobby can show everyone what they are about
   * to play. Without it a guest can only render its OWN setting and call it the
   * host's, which is a confident lie.
   */
  opts?: unknown;
}

/** Host's authoritative start. Carries everything a peer needs to be in sync. */
interface StartMsg {
  round: number;
  seed: number;
  roster: RoundPlayer[];
  opts?: unknown;
}

/** Receipt for a start, so the host knows who actually got it. */
interface AckMsg {
  round: number;
}

export function createRounds(config: RoundsConfig): Rounds {
  const { net, onRound } = config;
  const minPlayers = config.minPlayers ?? 2;
  const autoStart = config.autoStart ?? true;

  const graceMs = config.graceMs ?? 8000;
  const now = (): number => Date.now();

  let round = 0;
  let phase: RoundPhase = 'waiting';
  /** peer id -> vote, for the NEXT round only. Cleared on every round start. */
  const votes = new Map<PeerId, { name: string; in: boolean }>();
  const names = new Map<PeerId, string>([[net.selfId, config.playerName]]);
  /** Set once quorum is reached but some peers still have not answered. */
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let graceEndsAt = 0;
  /** peer id -> the settings it last announced. Only the host's is ever read. */
  const opts = new Map<PeerId, unknown>();

  /**
   * The last start we applied. EVERY peer keeps it, not just the host, so that a
   * peer promoted to host mid-round can still answer a late connector — the
   * promoted host inherited no tally, but it did play this round. Closes §3b.
   */
  let lastStart: StartMsg | null = null;
  /** Whether the frozen roster of the current round includes us. */
  let seated = false;

  /** Host-only, current round: who has confirmed receipt of the start. */
  const acked = new Set<PeerId>();
  let ackTimer: ReturnType<typeof setInterval> | undefined;
  let ackTries = 0;

  /**
   * When the roster last changed. A mesh mid-formation must not have its roster
   * frozen — see ROSTER_SETTLE_MS. Seeded to construction time so the very first
   * autostart also waits out a window.
   */
  let lastRosterChangeAt = now();
  /** Previous roster, to spot which peers are NEW on a change. */
  let knownPeers = new Set<PeerId>(net.peers());

  const next = (): number => round + 1;

  function player(id: PeerId): RoundPlayer {
    return { id, name: names.get(id) ?? '…' };
  }

  function present(): RoundPlayer[] {
    return net.peers().map(player);
  }

  function voters(): RoundPlayer[] {
    // Only peers still in the room count — someone who voted and then closed
    // their tab must not hold the round open or land in the frozen roster.
    const here = new Set(net.peers());
    return net
      .peers()
      .filter((id) => here.has(id) && votes.get(id)?.in)
      .map(player);
  }

  function state(): RoundsState {
    return {
      round,
      phase,
      votes: voters(),
      present: present(),
      voted: !!votes.get(net.selfId)?.in,
      isHost: net.isHost(),
      canStart: net.isHost() && voters().length >= minPlayers,
      seated,
      hostOpts: net.isHost() ? config.roundOpts?.() : (opts.get(net.host() ?? '') ?? null),
      startsInMs: graceEndsAt ? Math.max(0, graceEndsAt - now()) : null,
    };
  }

  const changed = (): void => config.onChange?.(state());

  // ── wire ──────────────────────────────────────────────────────────────────
  // 'rv' vote, 'rs' host start, 'rq' resync request, 'rk' start ack.
  // All <= 12 bytes.

  // 'rv' doubles as presence: every peer announces itself with in:false as soon
  // as it arrives, so a lobby can render real names rather than "…" for players
  // who have not readied up yet. One protocol covers presence, the first round
  // and every rematch — there is no second start path to drift out of sync.
  const sendVote = net.channel<VoteMsg>('rv', (msg, from) => {
    names.set(from, msg.name);
    if (msg.opts !== undefined) opts.set(from, msg.opts);

    // Catch up to the host's round timeline. The host is authoritative for the
    // round number (only it calls go()), so if it reports a higher current round
    // than ours, we are the one that fell behind — adopt it. This is what heals
    // the host-transfer-then-rejoin deadlock: the returning peer would otherwise
    // sit at round 0, voting for a round the room finished long ago, and never
    // count toward quorum however many times it readies up. Only catch up while
    // waiting — never yank a peer out of a round it is playing.
    // `net.isHost()` is here because a PROMOTED host has nobody to learn from:
    // the only peer whose `cur` it would otherwise trust is itself. A host that
    // was promoted while behind the room's timeline (it joined mid-round and
    // never received a start, then won the election when the old host dropped)
    // would sit at round 0 while everyone votes for round N+1 — every vote
    // dropped as stale, quorum never reached, and no peer in the room able to
    // start another round. That is a permanent, room-wide deadlock, and it comes
    // from ordinary network events with nobody at fault.
    //
    // `msg.cur > round` keeps this strictly monotonic, so the timeline can only
    // move forward. It does trust a peer's self-report while we host; the honest
    // trade is that a malicious peer could inflate the round number, which is
    // strictly less bad than the deadlock this removes.
    const trusted = from === net.host() || net.isHost();
    if (trusted && phase !== 'playing' && msg.cur != null && msg.cur > round) {
      const mine = votes.get(net.selfId)?.in ?? false;
      round = msg.cur;
      votes.clear();
      // Preserve our own readiness across the jump and re-announce it, or the
      // catch-up would silently un-ready us and we'd have to tap again.
      if (mine) {
        votes.set(net.selfId, { name: config.playerName, in: true });
        sendVote({ round: next(), name: config.playerName, in: true, cur: round, opts: config.roundOpts?.() });
      }
      changed();
    }

    // A vote for a round we have already started is noise from a slow peer.
    if (msg.round !== next()) return;
    votes.set(from, { name: msg.name, in: msg.in });
    changed();
    maybeAutoStart();
  });

  const sendStart = net.channel<StartMsg>('rs', (msg, from) => {
    // Only the elected host may start, and only ever forwards.
    if (from !== net.host()) return;
    begin(msg, from);
  });

  const sendResync = net.channel<null>('rq', (_d, from) => {
    // Someone joined, or a new host was promoted and inherited no tally. Answer
    // unconditionally — a peer that has NOT voted is exactly what a host needs
    // to know before it decides everyone is ready.
    const mine = votes.get(net.selfId);
    sendVote(
      { round: next(), name: config.playerName, in: mine?.in ?? false, cur: round, opts: config.roundOpts?.() },
      from,
    );
  });

  // Receipts. The host stops retrying a start the moment a peer confirms it, so
  // the retry ladder costs one extra message per peer in the healthy case.
  const sendAck = net.channel<AckMsg>('rk', (msg, from) => {
    if (lastStart && msg.round === lastStart.round) acked.add(from);
  });

  function begin(msg: StartMsg, from?: PeerId): void {
    // Monotonic guard: ignore duplicates, replays, and late deliveries. This is
    // what makes two peers pressing "Play again" at the same instant safe — and
    // what makes the re-broadcast and retry ladder below free.
    if (msg.round <= round) {
      // Still acknowledge: a duplicate almost always means our first ack was the
      // message that went missing, and staying silent would burn the full ladder.
      if (from && from !== net.selfId && lastStart && msg.round === lastStart.round) {
        sendAck({ round: msg.round }, from);
      }
      return;
    }
    clearGrace();
    stopAckRetries();
    round = msg.round;
    phase = 'playing';
    votes.clear();
    acked.clear();
    lastStart = msg;
    seated = msg.roster.some((p) => p.id === net.selfId);
    for (const p of msg.roster) names.set(p.id, p.name);
    // Confirm receipt before doing any game work, so a slow onRound cannot cost
    // us a retry.
    if (from && from !== net.selfId) sendAck({ round: msg.round }, from);
    changed();
    onRound({
      round: msg.round,
      seed: msg.seed,
      // Frozen host roster — NOT a local re-derivation. Identical indices everywhere.
      players: msg.roster,
      isHost: net.isHost(),
      seated,
      // Likewise the settings: whatever the host chose, byte-identical for all.
      opts: msg.opts,
    });
  }

  /**
   * Host-only: chase anyone in the frozen roster who has not confirmed the
   * start. Belt and braces alongside the re-broadcast — this covers a peer whose
   * channel was open but dropped the message, where the re-broadcast (which only
   * fires on a NEW connection) would never trigger.
   */
  function startAckRetries(): void {
    stopAckRetries();
    ackTries = 0;
    ackTimer = setInterval(() => {
      if (!lastStart || !net.isHost()) return stopAckRetries();
      ackTries++;
      const here = new Set(net.peers());
      const missing = lastStart.roster.filter(
        (p) => p.id !== net.selfId && here.has(p.id) && !acked.has(p.id),
      );
      for (const p of missing) sendStart(lastStart, p.id);
      if (!missing.length || ackTries >= ACK_MAX_RETRIES) stopAckRetries();
    }, ACK_RETRY_MS);
  }

  function stopAckRetries(): void {
    if (ackTimer) clearInterval(ackTimer);
    ackTimer = undefined;
  }

  function go(): void {
    if (!net.isHost() || phase === 'playing') return;
    const roster = voters();
    if (roster.length < minPlayers) return;
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const msg: StartMsg = { round: next(), seed, roster, opts: config.roundOpts?.() };
    sendStart(msg); // tell everyone…
    begin(msg); // …and start locally from the identical payload
    startAckRetries(); // …then chase anyone who did not confirm
  }

  function maybeAutoStart(): void {
    if (!autoStart || !net.isHost() || phase === 'playing') return;
    const yes = voters();
    if (yes.length < minPlayers) return clearGrace();

    // §3a: never freeze a roster from a mesh that is still forming. The host's
    // view of "everyone" is only trustworthy once the roster has held still.
    // The 1.5s poll below re-attempts, so this defers the start rather than
    // cancelling it.
    if (now() - lastRosterChangeAt < ROSTER_SETTLE_MS) return;

    if (yes.length === present().length) {
      clearGrace();
      return go(); // everyone is in — no reason to wait
    }

    // Quorum, but not everyone. Waiting for unanimity forever is how the old
    // build deadlocked: one player still reading the summary, idle, or just slow
    // to tap held the whole room hostage with no way out but the menu. Give the
    // stragglers a visible countdown, then start without them.
    if (graceTimer) return;
    graceEndsAt = now() + graceMs;
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      graceEndsAt = 0;
      // Re-check the settle window here too: a peer arriving during the
      // countdown must reset it, or the grace timer becomes a way to freeze a
      // partial roster after all.
      if (
        net.isHost() &&
        phase !== 'playing' &&
        voters().length >= minPlayers &&
        now() - lastRosterChangeAt >= ROSTER_SETTLE_MS
      ) {
        go();
      }
    }, graceMs);
    changed();
  }

  function clearGrace(): void {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = undefined;
    graceEndsAt = 0;
  }

  /**
   * §3b, the one-line heal: a peer that connects while a round is playing gets
   * the current start unicast to it by the host. Without this, Trystero's
   * "deliver only to already-open channels" means a peer whose handshake
   * finished a second late never learns the round began — it sits in the lobby
   * while everyone else plays. `begin()`'s monotonic guard makes the duplicate
   * free for anyone who already had it.
   */
  const offPeers = net.onPeersChange((peers) => {
    const seen = new Set(peers);
    const fresh = peers.filter((p) => p !== net.selfId && !knownPeers.has(p));
    knownPeers = seen;
    lastRosterChangeAt = now();

    if (phase === 'playing' && lastStart && net.isHost()) {
      for (const p of fresh) sendStart(lastStart, p);
    }
    changed();
  });

  // Ask the room to re-declare itself. Cheap, and it heals three things: a peer
  // that joined mid-vote, a vote lost to a dropped packet, and — critically — a
  // freshly promoted host that inherited no vote tally when the old host left.
  const poll = setInterval(() => {
    if (phase !== 'playing') {
      sendResync(null);
      changed();
      maybeAutoStart();
    }
  }, 1500);

  // Announce ourselves immediately and ask the room to do the same.
  votes.set(net.selfId, { name: config.playerName, in: false });
  sendVote({ round: next(), name: config.playerName, in: false, cur: round, opts: config.roundOpts?.() });
  sendResync(null);

  return {
    vote() {
      // A peer that is PLAYING must not re-vote mid-round. A peer that is
      // UNSEATED is not playing — the round started without it, and queueing for
      // the next one is the entire point of the spectator state. Without the
      // `seated` qualifier the spectator's ready button is inert, its 'rq'
      // resync keeps answering `in: false`, and it is excluded from every
      // subsequent round for the life of the room: the "I got ejected" failure
      // made permanent by the very code meant to fix it.
      if (phase === 'playing' && seated) return;
      votes.set(net.selfId, { name: config.playerName, in: true });
      sendVote({ round: next(), name: config.playerName, in: true, cur: round, opts: config.roundOpts?.() });
      changed();
      maybeAutoStart();
    },

    unvote() {
      votes.set(net.selfId, { name: config.playerName, in: false });
      sendVote({ round: next(), name: config.playerName, in: false, cur: round, opts: config.roundOpts?.() });
      changed();
    },

    go,

    finish() {
      if (phase !== 'playing') return;
      phase = 'waiting';
      votes.clear();
      clearGrace();
      stopAckRetries();
      // A fresh round must not inherit a stale settle window, or the first
      // rematch after a long game starts instantly on whoever is visible.
      lastRosterChangeAt = now();
      changed();
    },

    state,

    destroy() {
      clearInterval(poll);
      clearGrace();
      stopAckRetries();
      offPeers();
      // Detach OUR receivers only — the Net outlives this and may host another
      // Rounds later. Leaking these is how a dead screen keeps answering peers.
      (sendVote as unknown as { off: Unsubscribe }).off();
      (sendStart as unknown as { off: Unsubscribe }).off();
      (sendResync as unknown as { off: Unsubscribe }).off();
      (sendAck as unknown as { off: Unsubscribe }).off();
    },
  };
}
