/**
 * lobby.ts — a drop-in peer-to-peer lobby view built on net.ts + rematch.ts.
 * Room code, invite link + Web Share, live roster with ready toggles, host-only
 * Start gated on min players.
 *
 * This file is a VIEW. It owns no protocol: presence, readiness, quorum, the
 * shared seed and the frozen roster all come from rematch.ts, so starting the
 * first round and starting a rematch are the same code path. The lobby used to
 * run its own 'pres'/'preq'/'go' channels, which meant two ways to start a game
 * and a 'go' that carried a seed but no roster — leaving peers free to disagree
 * about who player 0 was.
 */

import type { Net, PeerId } from './net';
import type { Rounds } from './rematch';

export interface LobbyPlayer {
  id: PeerId;
  name: string;
  ready: boolean;
  isHost: boolean;
  isSelf: boolean;
}

export interface LobbyConfig {
  container: HTMLElement;
  net: Net;
  /** The round protocol driving this room. Owns start; the lobby just renders. */
  rounds: Rounds;
  roomCode: string;
  minPlayers?: number;
  maxPlayers?: number;
  onCancel?: () => void;
}

/** Read ?room= from the URL, or mint a fresh 4-char code and push it into the URL. */
export function getOrCreateRoomCode(): string {
  const url = new URL(location.href);
  const existing = url.searchParams.get('room');
  if (existing) return normalizeRoomCode(existing);
  const code = mintCode();
  url.searchParams.set('room', code);
  history.replaceState(null, '', url.toString());
  return code;
}

export function mintCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/O/0/1/L ambiguity
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** Canonicalise a hand-typed / linked code so peers agree on the room id. */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** Push a chosen room code into the URL so the invite link + a refresh both work. */
export function setRoomInUrl(roomCode: string): void {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  url.hash = '';
  history.replaceState(null, '', url.toString());
}

/**
 * Drop ?room= on the way out of a room. Without this the code outlives the
 * session: reopen the page — from history, or a home-screen icon — and the stale
 * parameter drags you straight back into a room you have left, with no way to
 * start a fresh one. "It always spawns the same game room no matter what."
 */
export function clearRoomInUrl(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has('room')) return;
  url.searchParams.delete('room');
  url.hash = '';
  history.replaceState(null, '', url.toString());
}

export function inviteLink(roomCode: string): string {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  url.hash = '';
  return url.toString();
}

export interface RoomEntryConfig {
  container: HTMLElement;
  /** `created` is true for a fresh hosted room, false when a code was typed in. */
  onSubmit: (roomCode: string, created: boolean) => void;
  onCancel?: () => void;
  title?: string;
  subtitle?: string;
}

/**
 * "Create or join a room" screen shown before the lobby, so a friend can TYPE
 * the code instead of needing the invite link. Skip it when ?room= is present.
 */
export function createRoomEntry(config: RoomEntryConfig): { destroy: () => void } {
  const { container } = config;
  const title = config.title ?? 'Play with friends';
  const subtitle = config.subtitle ?? 'Start a new room, or enter a code to join a friend.';

  container.innerHTML = `
    <div class="room-entry">
      <div class="re-head">
        <h2 class="re-title">${escapeHtml(title)}</h2>
        <p class="re-sub">${escapeHtml(subtitle)}</p>
      </div>
      <button class="lobby-btn primary re-create" type="button">Create a room</button>
      <div class="re-divider"><span>or join a friend</span></div>
      <form class="re-join" novalidate>
        <input class="re-input" type="text" inputmode="latin" autocomplete="off"
          autocapitalize="characters" spellcheck="false" maxlength="8"
          placeholder="Enter room code" aria-label="Room code" />
        <button class="lobby-btn re-go" type="submit">Join</button>
      </form>
      <p class="re-error" role="alert" aria-live="polite"></p>
      ${config.onCancel ? '<button class="lobby-btn ghost re-cancel" type="button">Back</button>' : ''}
    </div>`;

  const input = container.querySelector<HTMLInputElement>('.re-input')!;
  const errEl = container.querySelector<HTMLElement>('.re-error')!;
  const showErr = (msg: string) => {
    errEl.textContent = msg;
  };

  input.addEventListener('input', () => {
    const caretAtEnd = input.selectionStart === input.value.length;
    input.value = normalizeRoomCode(input.value);
    if (caretAtEnd) input.setSelectionRange(input.value.length, input.value.length);
    if (errEl.textContent) showErr('');
  });

  container.querySelector('.re-create')?.addEventListener('click', () => {
    config.onSubmit(mintCode(), true);
  });

  container.querySelector<HTMLFormElement>('.re-join')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeRoomCode(input.value);
    if (code.length < 3) {
      showErr('Enter the room code your host shared (e.g. K7QP).');
      input.focus();
      return;
    }
    config.onSubmit(code, false);
  });

  if (config.onCancel) {
    container.querySelector('.re-cancel')?.addEventListener('click', () => config.onCancel!());
  }

  return {
    destroy() {
      container.innerHTML = '';
    },
  };
}

/**
 * How long a peer sits alone and unsettled before the lobby offers to host.
 *
 * net.ts deliberately never self-elects on a roster of one (01-DIAGNOSIS §2a):
 * silence is evidence of no mesh, not of an empty room, and a peer that assumed
 * otherwise became a phantom host that later stole a live room. But a player who
 * genuinely minted a code and is waiting alone must not be stuck on a spinner
 * forever, so after this long we offer the takeover as an explicit choice.
 * Hosting an invite-link room is a UX decision, never a transport one.
 */
const OFFER_HOST_MS = 15000;

export function createLobby(config: LobbyConfig): { destroy: () => void } {
  const { net, rounds, container } = config;
  const minPlayers = config.minPlayers ?? 2;
  const maxPlayers = config.maxPlayers ?? 8;
  const openedAt = Date.now();
  /** Set once the player accepts the offer, so it cannot be re-offered. */
  let tookOver = false;

  /** Alone, unsettled, and waiting long enough that we should offer to host. */
  function shouldOfferHost(): boolean {
    return (
      !tookOver &&
      !net.hostSettled() &&
      net.count() === 1 &&
      Date.now() - openedAt > OFFER_HOST_MS
    );
  }

  // The lobby renders; it does not decide. Presence, readiness, quorum and the
  // start signal all live in rematch.ts, so the first round and every rematch
  // travel the identical code path — including the frozen roster that keeps
  // player indices identical on every peer.
  function players(): LobbyPlayer[] {
    const s = rounds.state();
    // Null until the room settles. Painting a host badge before then is how both
    // players ended up looking like the host of a room that never connected.
    const host = net.hostSettled() ? net.host() : null;
    const ready = new Set(s.votes.map((v) => v.id));
    return s.present
      .map((p) => ({
        id: p.id,
        name: p.name,
        ready: ready.has(p.id),
        isHost: p.id === host,
        isSelf: p.id === net.selfId,
      }))
      .sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.id.localeCompare(b.id)));
  }

  async function share(): Promise<void> {
    const link = inviteLink(config.roomCode);
    const shareData = { title: 'Join my game', text: `Room ${config.roomCode}`, url: link };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* user cancelled — fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      flash('Invite link copied');
    } catch {
      flash(link);
    }
  }

  function flash(msg: string): void {
    const el = container.querySelector<HTMLElement>('.lobby-flash');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1800);
    }
  }

  /** Repaint only on a real change — a blind interval would fight the user for
   *  focus on the invite-link field. */
  let painted = '';

  function render(): void {
    const s = rounds.state();
    if (s.phase === 'playing') {
      // Seated: the game owns the screen. UNSEATED is the case that used to be a
      // silent dead end (01-DIAGNOSIS §3b) — a peer that connected mid-round, or
      // whose vote never reached the host, watched the round start without it and
      // had nothing to look at and no way back in. Now it gets an honest status
      // and a live ready toggle for the next round.
      if (s.seated) return;
      renderSpectating(s.round);
      return;
    }
    const ps = players();
    const key = JSON.stringify([
      ps,
      s.canStart,
      s.voted,
      net.hostSettled(),
      shouldOfferHost(),
      'lobby',
    ]);
    if (key === painted) return;
    painted = key;

    const link = inviteLink(config.roomCode);
    container.innerHTML = `
      <div class="lobby">
        <div class="lobby-head">
          <h2 class="lobby-title">Room <span class="lobby-code">${escapeHtml(config.roomCode)}</span></h2>
          <p class="lobby-sub">${ps.length}/${maxPlayers} players · peer-to-peer, no server</p>
        </div>
        <div class="lobby-invite">
          <input class="lobby-link" readonly value="${escapeHtml(link)}" aria-label="Invite link" />
          <button class="lobby-btn lobby-share" type="button">Invite</button>
        </div>
        <ul class="lobby-players">
          ${ps
            .map(
              (p) => `<li class="lobby-player${p.isSelf ? ' is-self' : ''}">
                <span class="lobby-dot ${p.ready ? 'ready' : ''}"></span>
                <span class="lobby-name">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</span>
                ${p.isHost ? '<span class="lobby-badge">HOST</span>' : ''}
                ${p.ready ? '<span class="lobby-badge ok">READY</span>' : ''}
              </li>`,
            )
            .join('')}
        </ul>
        ${
          shouldOfferHost()
            ? `<div class="lobby-searching lobby-offer">
                 <span>Nobody's here yet. If you minted this code, you can host the room.</span>
                 <button class="lobby-btn lobby-host" type="button">Host this room</button>
               </div>`
            : !net.hostSettled()
              ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Connecting to the room…</span></div>`
              : ps.length < minPlayers
              ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
                 <span>Looking for ${minPlayers - ps.length} more player${minPlayers - ps.length === 1 ? '' : 's'}… share the invite link</span></div>`
              : ''
        }
        <div class="lobby-actions">
          <button class="lobby-btn primary lobby-ready" type="button" ${net.hostSettled() ? '' : 'disabled'}>${s.voted ? 'Not ready' : "I'm ready"}</button>
          ${
            net.isHost()
              ? `<button class="lobby-btn lobby-start" type="button" ${s.canStart ? '' : 'disabled'}>
                   ${ps.length < minPlayers ? `Waiting for ${minPlayers - ps.length} more…` : 'Start now'}
                 </button>`
              : `<p class="lobby-wait"><span class="spinner sm" aria-hidden="true"></span> Waiting for the host to start…</p>`
          }
          ${config.onCancel ? '<button class="lobby-btn ghost lobby-cancel" type="button">Leave room</button>' : ''}
        </div>
        <div class="lobby-flash" role="status" aria-live="polite"></div>
      </div>`;

    container.querySelector('.lobby-host')?.addEventListener('click', () => {
      tookOver = true;
      net.takeover();
      render();
    });
    container.querySelector('.lobby-share')?.addEventListener('click', () => void share());
    container.querySelector('.lobby-ready')?.addEventListener('click', () => {
      if (rounds.state().voted) rounds.unvote();
      else rounds.vote();
      render();
    });
    container.querySelector('.lobby-start')?.addEventListener('click', () => rounds.go());
    container.querySelector('.lobby-cancel')?.addEventListener('click', () => config.onCancel?.());
    container.querySelector<HTMLInputElement>('.lobby-link')?.addEventListener('focus', (e) => {
      (e.target as HTMLInputElement).select();
    });
  }

  /**
   * A round is running that we are not in. Keep the ready toggle live so the
   * player is queued for the next one the moment it opens, instead of having to
   * notice the game ended and tap in time.
   */
  function renderSpectating(round: number): void {
    const s = rounds.state();
    const key = JSON.stringify([round, s.voted, s.present.length, 'spectating']);
    if (key === painted) return;
    painted = key;

    container.innerHTML = `
      <div class="lobby lobby-spectating">
        <div class="lobby-head">
          <h2 class="lobby-title">Round ${round} in progress</h2>
          <p class="lobby-sub">You're in the next one — ${s.present.length} in the room</p>
        </div>
        <div class="lobby-searching">
          <span class="spinner" aria-hidden="true"></span>
          <span>Waiting for this round to finish…</span>
        </div>
        <div class="lobby-actions">
          <button class="lobby-btn primary lobby-ready" type="button">${
            s.voted ? "You're in for the next round" : "Ready me for the next round"
          }</button>
          ${config.onCancel ? '<button class="lobby-btn ghost lobby-cancel" type="button">Leave room</button>' : ''}
        </div>
        <div class="lobby-flash" role="status" aria-live="polite"></div>
      </div>`;

    container.querySelector('.lobby-ready')?.addEventListener('click', () => {
      if (rounds.state().voted) rounds.unvote();
      else rounds.vote();
      render();
    });
    container.querySelector('.lobby-cancel')?.addEventListener('click', () => config.onCancel?.());
  }

  /**
   * `?netdebug=1` overlay. Field reports used to arrive as vibes ("it didn't
   * connect"); this turns them into the four facts that actually diagnose a
   * room: who we think hosts, at what term, who we can see, and whether
   * signaling sockets are even open.
   */
  const netdebug = new URLSearchParams(location.search).get('netdebug') === '1';
  let debugEl: HTMLElement | undefined;
  if (netdebug) {
    debugEl = document.createElement('pre');
    debugEl.className = 'net-debug';
    debugEl.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:9999;margin:0;padding:8px 10px;' +
      'max-width:min(92vw,420px);max-height:40vh;overflow:auto;font:11px/1.45 ui-monospace,monospace;' +
      'background:rgba(0,0,0,.82);color:#0f0;border-radius:8px;white-space:pre-wrap;pointer-events:none';
    document.body.appendChild(debugEl);
  }

  function renderDebug(): void {
    if (!debugEl) return;
    const d = net.netDiag();
    const s = rounds.state();
    const relays = Object.entries(d.relaySockets)
      .map(([url, st]) => `  ${['connecting', 'OPEN', 'closing', 'CLOSED'][st] ?? st} ${url}`)
      .join('\n');
    debugEl.textContent =
      `self    ${d.selfId}\n` +
      `host    ${d.host ?? '—'}${d.host === d.selfId ? ' (me)' : ''}\n` +
      `epoch   ${d.epoch}   settled=${d.settled}\n` +
      `turn    ${d.turn ? 'yes' : 'NO (stun only)'}\n` +
      `peers   ${d.peers.length}: ${d.peers.join(', ')}\n` +
      `round   ${s.round} ${s.phase}${s.phase === 'playing' ? ` seated=${s.seated}` : ''}\n` +
      `votes   ${s.votes.length}/${s.present.length}\n` +
      `relays\n${relays || '  (none)'}`;
  }

  // Spot a host transfer (net.ts re-elects when the host leaves) so a newly
  // promoted peer learns the Start button is now theirs.
  let lastHost = net.host();
  const poll = setInterval(() => {
    render();
    renderDebug();
    const host = net.host();
    if (host !== lastHost) {
      const wasHost = lastHost === net.selfId;
      lastHost = host;
      if (net.isHost() && !wasHost) flash("The host left — you're the host now");
    }
  }, 600);

  render();
  renderDebug();

  return {
    destroy() {
      clearInterval(poll);
      debugEl?.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
