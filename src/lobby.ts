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
import type { PublicRoom, RoomAd } from './noticeboard';
import { toSvg } from './qr';

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
  /**
   * Optional game-settings block rendered above the actions — the host's mode /
   * arena / track picker. Returns HTML; `onModeMount` re-wires its controls after
   * each repaint, because the lobby re-renders itself and would otherwise strip
   * the listeners off whatever the game put here.
   */
  modeSlot?: () => string;
  /** Called after each repaint so the slot's controls can be re-wired. */
  onModeMount?: () => void;
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

/**
 * The QR toggle, deliberately on its own line rather than inside
 * `.lobby-invite`.
 *
 * That row is `display:flex` with two children in every game's stylesheet, and
 * several set `flex-wrap:nowrap`. Adding a third button pushed the row past the
 * lobby card and clipped it — verified in turntide, where the row ran to 399px
 * inside a 383px card. The engine cannot edit ~40 games' CSS, so it must not
 * change the shape of anything those stylesheets already own.
 *
 * Carries no `lobby-btn` class for the same reason: it would inherit a size
 * meant for a row that no longer holds it. Styled inline, so it looks right
 * with no game CSS, and games may still target `.lobby-qr-toggle` to restyle.
 */
function qrToggleHtml(open: boolean): string {
  return (
    `<button class="lobby-qr-toggle" type="button" aria-expanded="${open}" aria-controls="lobby-qr" ` +
    `style="display:block;margin:10px auto 0;padding:8px 14px;min-height:40px;background:none;` +
    `border:1px solid currentColor;border-radius:999px;color:inherit;font:inherit;font-size:13px;` +
    `opacity:.75;cursor:pointer">${open ? 'Hide QR code' : 'Show QR code'}</button>`
  );
}

/**
 * The join QR, as a self-contained block.
 *
 * Styled inline on purpose. Every game writes its own `.lobby-*` CSS, so markup
 * that depended on a new class would render as an unstyled heap in the ~40
 * games that predate this and in any new game whose stylesheet forgets it. A
 * join code nobody can scan is worse than no QR, so this one cannot be broken
 * by a missing rule.
 *
 * The card is always light regardless of theme: an inverted QR (light modules
 * on dark) is not readable by most phone cameras.
 */
export function qrPanelHtml(link: string, roomCode: string): string {
  const svg = toSvg(link, { dark: '#000', light: '#fff', margin: 2 });
  if (!svg) return '';
  return (
    `<div class="lobby-qr" style="display:flex;flex-direction:column;align-items:center;gap:10px;` +
    `margin:14px auto 0;padding:16px;background:#fff;border-radius:14px;max-width:min(300px,80vw);` +
    `box-shadow:0 6px 24px rgba(0,0,0,.22)">` +
    `<div style="width:100%;aspect-ratio:1;display:flex">${svg}</div>` +
    `<p style="margin:0;font-size:13px;line-height:1.4;color:#333;text-align:center">` +
    `Scan to join room <strong style="letter-spacing:.08em">${escapeHtml(roomCode)}</strong></p>` +
    `</div>`
  );
}

// ── public rooms ────────────────────────────────────────────────────────────
//
// Everything below exists to keep ONE promise: a private room is invisible, and
// a player who only plays with friends never touches the noticeboard at all.
// The board is WebRTC, so being on it — listing OR browsing — hands your IP to
// every stranger who is also on it. That is the cost, it is unavoidable in a
// serverless lobby, and the only honest answer is to make it opt-in on both
// sides and say so where the player opts in rather than in About.
//
// This lived in six forked lobbies before it lived here. Moving it into the
// engine is the point of the exercise: those forks were strict supersets of this
// file, so every new lobby feature had to be hand-ported six times, and the
// privacy wording — the part that must not drift — was six copies deep.

/** Shown under the public/private choice. Plain language, no euphemism. */
export const P2P_IP_NOTE =
  'Public games are peer-to-peer, so other players can see your IP address — the ' +
  'same as any P2P game, but with strangers rather than friends.';

/** Shown under the browse button. Browsing costs the same thing, so it says so. */
export const BROWSE_IP_NOTE =
  'The list is peer-to-peer too: while it is open, the other people browsing can ' +
  'see your IP address. It closes as soon as you leave this screen.';

/**
 * The noticeboard, as the room screens are allowed to see it.
 *
 * Deliberately NOT a `Noticeboard`. The board gets opened and closed repeatedly
 * over a session (browse -> back -> browse; public -> private -> public) and
 * net.ts throws if its room is rejoined while the last one is still tearing
 * down. The owner serialises that; the views just declare what they want.
 */
export interface BoardAccess {
  /** Join the board and start listening. Only ever from an explicit opt-in. */
  open(onRooms: (rooms: PublicRoom[]) => void): Promise<void>;
  /** Advertise this room, joining the board if we are not on it yet. */
  announce(ad: RoomAd): Promise<void>;
  /** Leave the board. Never hold the mesh open behind a screen nobody is on. */
  close(): void;
}

export interface ListingState {
  /** The host's choice. Private is the default, and private NEVER announces. */
  isPublic: boolean;
  isHost: boolean;
  /** False the moment the lobby is gone — a started round leaves the board. */
  inLobby: boolean;
  playing: boolean;
  code: string;
  host: string;
  players: number;
  max: number;
  note?: string;
}

/**
 * The single rule for "is this room on the public list?", returning the ad to
 * broadcast or null meaning get off the board.
 *
 * One function, so the announce tick, the round start and the way out cannot
 * answer it differently. A room still advertising after it went private is not
 * a cosmetic bug — it is the one promise this feature makes, broken.
 */
export function roomAd(s: ListingState): RoomAd | null {
  if (!s.isPublic || !s.isHost || !s.inLobby || s.playing) return null;
  return {
    code: s.code,
    host: s.host,
    players: s.players,
    max: s.max,
    playing: false,
    ...(s.note ? { note: s.note } : {}),
  };
}

export interface Listing {
  /** Feed it the room's current truth; it does the rest. Cheap to call often. */
  sync(s: ListingState): void;
  close(): void;
}

/**
 * Keeps the board's copy of this room in step with reality, and lets go of the
 * board the instant the room stops qualifying.
 */
export function createListing(board: BoardAccess): Listing {
  let last = '';
  return {
    sync(s: ListingState) {
      const ad = roomAd(s);
      // Re-announcing an unchanged ad every tick would be pure noise: the board
      // already re-broadcasts what it holds every 2s to prove the room is alive.
      const key = ad ? JSON.stringify(ad) : '';
      if (key === last) return;
      last = key;
      if (!ad) {
        board.close();
        return;
      }
      void board.announce(ad);
    },
    close() {
      last = '';
      board.close();
    },
  };
}

export interface RoomEntryConfig {
  container: HTMLElement;
  /**
   * `created` is true for a fresh hosted room, false when a code was typed in or
   * picked off the public list. `isPublic` is only ever true alongside `created`
   * — you cannot list someone else's room. Existing callers taking two
   * parameters keep working untouched.
   */
  onSubmit: (roomCode: string, created: boolean, isPublic: boolean) => void;
  onCancel?: () => void;
  title?: string;
  subtitle?: string;
  /** Omit and this game has no public rooms at all: no toggle, no browse. */
  board?: BoardAccess;
  /**
   * How long to keep saying "joining" before believing an empty list. Being ON
   * the board is not the same as being connected to anyone on it — see browse().
   */
  settleMs?: number;
}

/**
 * "Create or join a room" screen shown before the lobby, so a friend can TYPE
 * the code instead of needing the invite link. Skip it when ?room= is present.
 */
export function createRoomEntry(config: RoomEntryConfig): { destroy: () => void } {
  const { container } = config;
  const title = config.title ?? 'Play with friends';
  const subtitle = config.subtitle ?? 'Start a new room, or enter a code to join a friend.';

  // PRIVATE BY DEFAULT. A public room advertises itself to strangers, so it has
  // to be something the player reached for — never a default they never saw.
  let isPublic = false;
  let browsing = false;
  let joined = false;
  let rooms: PublicRoom[] = [];
  /** Survives the repaint that toggling public/private causes. */
  let draft = '';
  let err = '';
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  function leave(code: string, created: boolean): void {
    // Off the board before the screen changes: nothing may keep the mesh open
    // once the player has stopped browsing.
    browsing = false;
    clearTimeout(settleTimer);
    config.board?.close();
    config.onSubmit(code, created, created && isPublic);
  }

  function visChip(pub: boolean, name: string, meta: string): string {
    return `<button class="vis-chip${isPublic === pub ? ' on' : ''}" type="button"
      role="radio" aria-checked="${isPublic === pub}" data-pub="${pub ? 1 : 0}">
      <span class="vis-name">${escapeHtml(name)}</span>
      <span class="vis-meta">${escapeHtml(meta)}</span>
    </button>`;
  }

  function renderHome(): void {
    container.innerHTML = `
      <div class="room-entry">
        <div class="re-head">
          <h2 class="re-title">${escapeHtml(title)}</h2>
          <p class="re-sub">${escapeHtml(subtitle)}</p>
        </div>
        ${
          config.board
            ? `<div class="vis re-vis" role="radiogroup" aria-label="Who can join">
                 ${visChip(false, 'Private', 'Invite only')}
                 ${visChip(true, 'Public', 'Listed for anyone')}
               </div>
               <p class="re-note">${escapeHtml(P2P_IP_NOTE)}</p>`
            : ''
        }
        <button class="lobby-btn primary re-create" type="button">Create a ${
          config.board ? (isPublic ? 'public' : 'private') : ''
        } room</button>
        <div class="re-divider"><span>or join a friend</span></div>
        <form class="re-join" novalidate>
          <input class="re-input" type="text" inputmode="latin" autocomplete="off"
            autocapitalize="characters" spellcheck="false" maxlength="8"
            placeholder="Enter room code" aria-label="Room code" value="${escapeHtml(draft)}" />
          <button class="lobby-btn re-go" type="submit">Join</button>
        </form>
        <p class="re-error" role="alert" aria-live="polite">${escapeHtml(err)}</p>
        ${
          config.board
            ? `<div class="re-divider"><span>or find a game</span></div>
               <button class="lobby-btn re-browse" type="button">Browse public games</button>
               <p class="re-note">${escapeHtml(BROWSE_IP_NOTE)}</p>`
            : ''
        }
        ${config.onCancel ? '<button class="lobby-btn ghost re-cancel" type="button">Back</button>' : ''}
      </div>`;

    const input = container.querySelector<HTMLInputElement>('.re-input')!;
    const errEl = container.querySelector<HTMLElement>('.re-error')!;
    const showErr = (msg: string) => {
      err = msg;
      errEl.textContent = msg;
    };

    input.addEventListener('input', () => {
      const caretAtEnd = input.selectionStart === input.value.length;
      input.value = normalizeRoomCode(input.value);
      if (caretAtEnd) input.setSelectionRange(input.value.length, input.value.length);
      draft = input.value;
      if (errEl.textContent) showErr('');
    });

    for (const btn of container.querySelectorAll<HTMLButtonElement>('.vis-chip')) {
      btn.addEventListener('click', () => {
        isPublic = btn.dataset.pub === '1';
        renderHome();
      });
    }

    container.querySelector('.re-create')?.addEventListener('click', () => leave(mintCode(), true));

    container.querySelector<HTMLFormElement>('.re-join')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = normalizeRoomCode(input.value);
      if (code.length < 3) {
        showErr('Enter the room code your host shared (e.g. K7QP).');
        input.focus();
        return;
      }
      leave(code, false);
    });

    container.querySelector('.re-browse')?.addEventListener('click', () => void browse());

    if (config.onCancel) {
      container.querySelector('.re-cancel')?.addEventListener('click', () => {
        config.board?.close();
        config.onCancel!();
      });
    }
  }

  /** The ONLY thing that ever joins the board. Not page load, not the lobby. */
  async function browse(): Promise<void> {
    browsing = true;
    joined = false;
    rooms = [];
    renderBrowse();
    await config.board!.open((next) => {
      rooms = next;
      // Hearing any room at all proves the mesh is up — stop waiting on a clock.
      if (rooms.length) joined = true;
      if (browsing) renderBrowse();
    });
    if (!browsing) return;
    // Being ON the board is not the same as being connected to anyone on it: the
    // mesh forms through a public relay and takes seconds. An empty list in that
    // window means "we have not heard yet", not "nobody is there" — and saying
    // the latter is a lie the player acts on. They tap Back, and never see the
    // room that was being advertised the whole time.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      joined = true;
      if (browsing) renderBrowse();
    }, config.settleMs ?? 3000);
  }

  function stopBrowsing(): void {
    browsing = false;
    clearTimeout(settleTimer);
    config.board?.close();
    renderHome();
  }

  function roomRow(r: PublicRoom): string {
    const full = r.players >= r.max;
    return `<li><button class="re-room${r.playing ? ' playing' : ''}" type="button"
      data-code="${escapeHtml(r.code)}">
      <span class="re-room-host">${escapeHtml(r.host)}</span>
      <span class="re-room-code">${escapeHtml(r.code)}</span>
      <span class="re-room-note">${escapeHtml(r.note ?? 'Open room')}</span>
      <span class="re-room-meta">${r.players}/${r.max}${full ? ' · full' : ''}</span>
      ${
        r.playing
          ? '<span class="re-room-state">Round in progress — you would wait in the lobby</span>'
          : ''
      }
    </button></li>`;
  }

  function renderBrowse(): void {
    const body = !joined
      ? `<div class="lobby-searching"><span class="spinner" aria-hidden="true"></span>
           <span>Joining the public list…</span></div>`
      : rooms.length
        ? `<ul class="re-rooms">${rooms.map(roomRow).join('')}</ul>`
        : `<p class="re-empty">Nobody has a public room open right now. Rooms only
             appear here while someone is sitting in one waiting for players — so
             it is often empty. Start one and see who turns up.</p>`;

    container.innerHTML = `
      <div class="room-entry">
        <div class="re-head">
          <h2 class="re-title">Public games</h2>
          <p class="re-sub">Anyone can join these. Tap one to go in as a guest.</p>
        </div>
        ${body}
        <button class="lobby-btn${rooms.length ? '' : ' primary'} re-make" type="button">Create a room instead</button>
        <p class="re-note">${escapeHtml(BROWSE_IP_NOTE)}</p>
        <button class="lobby-btn ghost re-back" type="button">Back</button>
      </div>`;

    for (const btn of container.querySelectorAll<HTMLButtonElement>('.re-room')) {
      // A room off the list is SOMEONE ELSE'S. Guest, never host: created=false
      // is what keeps claimHost false, so we wait for the incumbent rather than
      // racing a stranger for their own room.
      btn.addEventListener('click', () => leave(normalizeRoomCode(btn.dataset.code!), false));
    }
    container.querySelector('.re-make')?.addEventListener('click', () => {
      browsing = false;
      config.board?.close();
      leave(mintCode(), true);
    });
    container.querySelector('.re-back')?.addEventListener('click', stopBrowsing);
  }

  renderHome();

  return {
    destroy() {
      browsing = false;
      clearTimeout(settleTimer);
      config.board?.close();
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

export interface Lobby {
  /** Repaint in place, preserving view state. Use this instead of rebuilding. */
  repaint(): void;
  destroy(): void;
}

/**
 * View state that must survive a caller rebuilding the lobby, keyed by the
 * container it was mounted into.
 *
 * `repaint()` is the right way for a game to update a lobby, but roughly ten
 * shipped games already call `createLobby` again on every roster or vote change
 * and will never be edited. For them, remembering the state per container turns
 * a rebuild into something indistinguishable from a repaint — the QR stays open,
 * and the "host this room" offer does not reset its 15s clock every time a peer
 * readies up (which could otherwise keep a lone player from ever being offered
 * the takeover).
 *
 * Scoped by room code as well, so entering a DIFFERENT room in the same
 * container correctly starts fresh.
 */
interface StickyView {
  roomCode: string;
  qrOpen: boolean;
  openedAt: number;
  tookOver: boolean;
}
const stickyViews = new WeakMap<HTMLElement, StickyView>();

export function createLobby(config: LobbyConfig): Lobby {
  const { net, rounds, container } = config;
  const minPlayers = config.minPlayers ?? 2;
  const maxPlayers = config.maxPlayers ?? 8;

  const prior = stickyViews.get(container);
  const resumed = prior && prior.roomCode === config.roomCode ? prior : null;

  const openedAt = resumed?.openedAt ?? Date.now();
  /** Set once the player accepts the offer, so it cannot be re-offered. */
  let tookOver = resumed?.tookOver ?? false;
  /** Whether the join QR is on screen. Must be in the paint key below, or the
   *  600ms repaint would close it under the player mid-scan. */
  let qrOpen = resumed?.qrOpen ?? false;

  const remember = (): void => {
    stickyViews.set(container, { roomCode: config.roomCode, qrOpen, openedAt, tookOver });
  };
  remember();

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
      qrOpen,
      // Without this a host toggling their mode picker would not repaint: the
      // roster has not changed, so the key would be identical and render()
      // returns early by design.
      config.modeSlot?.() ?? '',
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
        ${qrToggleHtml(qrOpen)}
        ${qrOpen ? `<div id="lobby-qr">${qrPanelHtml(link, config.roomCode)}</div>` : ''}
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
        ${config.modeSlot ? `<div class="lobby-modeslot">${config.modeSlot()}</div>` : ''}
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
      remember();
      net.takeover();
      render();
    });
    container.querySelector('.lobby-share')?.addEventListener('click', () => void share());
    container.querySelector('.lobby-qr-toggle')?.addEventListener('click', () => {
      qrOpen = !qrOpen;
      remember();
      render();
    });
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
    // The lobby re-renders itself, which strips the listeners off whatever the
    // game put in the slot. Re-wiring is the game's job, but the lobby has to
    // tell it when — otherwise a host's mode picker silently stops responding
    // after the first roster change.
    config.onModeMount?.();
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
    // Socket state AND write state. A relay showing OPEN while refusing writes
    // is the failure this overlay used to hide: peers announce over writes, so
    // "OPEN write:REFUSED" is a dead relay that looks perfectly healthy.
    const relays = Object.entries(d.relaySockets)
      .map(([url, st]) => {
        const sock = ['connecting', 'OPEN', 'closing', 'CLOSED'][st] ?? String(st);
        const w = d.relayWrites?.[url];
        const write = w === 'rejected' ? ' write:REFUSED' : w === 'ok' ? ' write:ok' : '';
        return `  ${sock}${write} ${url}`;
      })
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
    /**
     * Repaint in place, preserving view state.
     *
     * This exists because "repaint the lobby when something changes" is the
     * obvious thing for a game to do, and the obvious way to do it — calling
     * `createLobby` again — silently destroys state the player is *using*.
     * Ballast's net handlers rebuilt the lobby on every roster/vote change, so
     * the join QR closed itself about a second after every tap, mid-scan. The
     * engine already keeps `qrOpen` out of the repaint key for exactly that
     * reason; it just had no in-place option to reach for that was easier than
     * rebuilding.
     *
     * Cheap to call: `render()` diffs against a paint key and returns early when
     * nothing has changed, so calling this from a 10Hz handler is fine.
     */
    repaint() {
      render();
      renderDebug();
    },

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
