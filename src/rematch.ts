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
 *     onRound: ({ round, seed, players, isHost }) => startGame(...) });
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
 *     live game, and two peers pressing at once cannot double-fire.
 *
 * COPY THIS FILE into src/engine/ alongside net.ts.
 */

import type { Net, PeerId, Unsubscribe } from './net';

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
      hostOpts: net.isHost() ? config.roundOpts?.() : (opts.get(net.host() ?? '') ?? null),
      startsInMs: graceEndsAt ? Math.max(0, graceEndsAt - now()) : null,
    };
  }

  const changed = (): void => config.onChange?.(state());

  // ── wire ──────────────────────────────────────────────────────────────────
  // 'rv' vote, 'rs' host start, 'rq' resync request. All <= 12 bytes.

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
    if (from === net.host() && phase !== 'playing' && msg.cur != null && msg.cur > round) {
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
    begin(msg);
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

  function begin(msg: StartMsg): void {
    // Monotonic guard: ignore duplicates, replays, and late deliveries. This is
    // what makes two peers pressing "Play again" at the same instant safe.
    if (msg.round <= round) return;
    clearGrace();
    round = msg.round;
    phase = 'playing';
    votes.clear();
    for (const p of msg.roster) names.set(p.id, p.name);
    changed();
    onRound({
      round: msg.round,
      seed: msg.seed,
      // Frozen host roster — NOT a local re-derivation. Identical indices everywhere.
      players: msg.roster,
      isHost: net.isHost(),
      // Likewise the settings: whatever the host chose, byte-identical for all.
      opts: msg.opts,
    });
  }

  function go(): void {
    if (!net.isHost() || phase === 'playing') return;
    const roster = voters();
    if (roster.length < minPlayers) return;
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const msg: StartMsg = { round: next(), seed, roster, opts: config.roundOpts?.() };
    sendStart(msg); // tell everyone…
    begin(msg); // …and start locally from the identical payload
  }

  function maybeAutoStart(): void {
    if (!autoStart || !net.isHost() || phase === 'playing') return;
    const yes = voters();
    if (yes.length < minPlayers) return clearGrace();
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
      if (net.isHost() && phase !== 'playing' && voters().length >= minPlayers) go();
    }, graceMs);
    changed();
  }

  function clearGrace(): void {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = undefined;
    graceEndsAt = 0;
  }

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
      if (phase === 'playing') return;
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
      changed();
    },

    state,

    destroy() {
      clearInterval(poll);
      clearGrace();
      // Detach OUR receivers only — the Net outlives this and may host another
      // Rounds later. Leaking these is how a dead screen keeps answering peers.
      (sendVote as unknown as { off: Unsubscribe }).off();
      (sendStart as unknown as { off: Unsubscribe }).off();
      (sendResync as unknown as { off: Unsubscribe }).off();
    },
  };
}
