/**
 * drag.ts — one pointer-gesture classifier for DOM cards, tiles and handles.
 *
 * Card and board UIs beg to be dragged and flicked, but a naive "drag on
 * pointerdown" destroys the tap that everything else relies on. This separates
 * the three gestures cleanly off a single Pointer Events stream (mouse, touch
 * and pen on one code path):
 *
 *   TAP    — released within TAP_SLOP of where it started → the element's normal
 *            activate action. Tap ALWAYS stays a first-class fallback.
 *   DRAG   — moved past DRAG_SLOP → onDragStart, then onDragMove(dx,dy) until
 *            release → onDrop(dx,dy). The game decides what the delta means
 *            (follow the finger, preview a shift, hit-test a drop zone).
 *   SWIPE  — a fast flick (far enough, quick enough) → onSwipe(dir). Direction is
 *            locked to the dominant axis. A swipe suppresses the drop.
 *
 * Thresholds are the verified defaults from patterns/MOBILE_CONTROLS.md
 * (@use-gesture / Android touch-slop). The element must set `touch-action: none`
 * (and ideally `user-select:none`) or the page scroll steals the gesture.
 *
 * IMPORT from '@ben-gy/game-engine/drag' — do not copy it into the game.
 */

export type SwipeDir = 'up' | 'down' | 'left' | 'right';

export interface GestureThresholds {
  /** Release within this of the start = tap. */
  tapSlop: number;
  /** Min flick distance. */
  swipeDist: number;
  /** Min flick speed (px/ms). */
  swipeVel: number;
  /** Slower than this ⇒ a drag, not a swipe (ms). */
  swipeMaxMs: number;
}

export type Gesture = { kind: 'tap' } | { kind: 'drag' } | { kind: 'swipe'; dir: SwipeDir };

/**
 * Classify a released pointer gesture from its total delta, duration and whether
 * it ever crossed the drag threshold. Pure — the single source of truth for the
 * tap/drag/swipe decision, so it can be tested exhaustively without event timing.
 */
export function classifyRelease(
  dx: number,
  dy: number,
  dt: number,
  dragging: boolean,
  t: GestureThresholds,
): Gesture {
  if (!dragging) return { kind: 'tap' };
  const dist = Math.hypot(dx, dy);
  if (dist <= t.tapSlop) return { kind: 'tap' };
  const speed = dist / Math.max(dt, 1);
  if (dt < t.swipeMaxMs && (speed > t.swipeVel || dist > t.swipeDist)) {
    const dir: SwipeDir =
      Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    return { kind: 'swipe', dir };
  }
  return { kind: 'drag' };
}

export interface DragHandlers {
  /** Released without ever dragging — the normal activate/play action. */
  onTap?: (e: PointerEvent) => void;
  /** Crossed the drag threshold. */
  onDragStart?: (e: PointerEvent) => void;
  /** Total delta from the start point, every move while dragging. */
  onDragMove?: (dx: number, dy: number, e: PointerEvent) => void;
  /** Released after a (non-swipe) drag, with the final delta. */
  onDrop?: (dx: number, dy: number, e: PointerEvent) => void;
  /** A fast flick. If provided and matched, onDrop is NOT called. */
  onSwipe?: (dir: SwipeDir, dx: number, dy: number) => void;
  /** Pointer was cancelled mid-gesture (call, notification) — abort/snap back. */
  onCancel?: () => void;
}

export interface DragConfig extends DragHandlers {
  /** Release within this of the start = tap. Default 3px. */
  tapSlop?: number;
  /** Promote press→drag past this. Default 8px (touch) / 4px (mouse). */
  dragSlop?: number;
  /** Min flick distance. Default 50px. */
  swipeDist?: number;
  /** Min flick speed. Default 0.5 px/ms. */
  swipeVel?: number;
  /** Slower than this ⇒ a drag, not a swipe. Default 250ms. */
  swipeMaxMs?: number;
  /** setPointerCapture so an off-element drag still tracks. Default true. */
  capture?: boolean;
}

export interface Draggable {
  destroy(): void;
}

export function makeDraggable(el: HTMLElement, config: DragConfig): Draggable {
  const tapSlop = config.tapSlop ?? 3;
  const swipeDist = config.swipeDist ?? 50;
  const swipeVel = config.swipeVel ?? 0.5;
  const swipeMaxMs = config.swipeMaxMs ?? 250;
  const capture = config.capture ?? true;

  let id: number | null = null;
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let dragging = false;

  const dragSlopFor = (e: PointerEvent): number =>
    config.dragSlop ?? (e.pointerType === 'mouse' ? 4 : 8);
  let slop = 8;

  const onDown = (e: PointerEvent): void => {
    if (id !== null) return;
    id = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startT = performance.now();
    dragging = false;
    slop = dragSlopFor(e);
    if (capture) {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < slop) return;
      dragging = true;
      config.onDragStart?.(e);
    }
    config.onDragMove?.(dx, dy, e);
    e.preventDefault(); // block native image/text drag & scroll during a drag
  };

  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    id = null;
    if (capture) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dt = performance.now() - startT;

    const g = classifyRelease(dx, dy, dt, dragging, { tapSlop, swipeDist, swipeVel, swipeMaxMs });
    if (g.kind === 'tap') config.onTap?.(e);
    else if (g.kind === 'swipe' && config.onSwipe) config.onSwipe(g.dir, dx, dy);
    else config.onDrop?.(dx, dy, e);
  };

  const onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    id = null;
    const wasDragging = dragging;
    dragging = false;
    if (wasDragging) config.onCancel?.();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);

  return {
    destroy() {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    },
  };
}

// ── the stepped rail ────────────────────────────────────────────────────────

/**
 * A RAIL: continuous travel along one axis converted into discrete STEPS.
 *
 * `makeDraggable` emits a *gesture*; a rail emits a *stream of axis steps*, and
 * a game that moves a piece column by column needs the latter. Ballast built it
 * game-side (`src/touch.ts`) because the engine had no answer, which is exactly
 * the kind of gap that keeps a fork alive.
 *
 * The three things that are easy to get wrong, and are handled here:
 *
 *  - **Steps are emitted against a running total, not per move event.** A slow
 *    drag back and forth must NET OUT to zero rather than ratcheting up a count
 *    in each direction. `emitted` tracks what has already been reported, so the
 *    rail is always "where the finger is now" minus "what the game already knows".
 *  - **The grab offset is preserved.** The rail measures from where the finger
 *    went down, so the piece never jumps to the thumb on the first move.
 *  - **Tap and swipe stay first-class**, on the same thresholds as
 *    `makeDraggable`, so tap-to-rotate and swipe-to-drop keep working over the
 *    same surface as the rail without a second gesture layer to disagree with.
 *
 * Positions come from `clientX/Y` minus the element rect — never `offsetX/offsetY`,
 * which scales oddly under DPR and page zoom.
 */
export interface RailConfig {
  /** Travel per step. Ballast ships 26px for a tetromino column. */
  stepPx: number;
  /** Which axis the rail runs along. Default 'x'. */
  axis?: 'x' | 'y';
  /** One call per step, `dir` being -1 or +1. May fire several times a move. */
  onStep: (dir: -1 | 1, e: PointerEvent) => void;
  /** Released without ever dragging. */
  onTap?: (e: PointerEvent) => void;
  /** A fast flick, on either axis. */
  onSwipe?: (dir: SwipeDir, dx: number, dy: number) => void;
  /** Press held still — repeats until release. */
  onHold?: () => void;
  /** Delay before a hold starts repeating. Default 260ms. */
  holdStartMs?: number;
  /** Interval between hold repeats. Default 45ms. */
  holdRepeatMs?: number;
  onCancel?: () => void;
  /** Promote press→drag past this. Default 8px. */
  dragSlop?: number;
  tapSlop?: number;
  swipeDist?: number;
  swipeVel?: number;
  swipeMaxMs?: number;
}

export interface Rail {
  /** True while a finger is down — a HUD can dim its hint text. */
  active(): boolean;
  destroy(): void;
}

interface RailPointer {
  startX: number;
  startY: number;
  emitted: number;
  startT: number;
  promoted: boolean;
  holdStart?: ReturnType<typeof setTimeout>;
  holdRepeat?: ReturnType<typeof setInterval>;
}

export function makeRail(el: HTMLElement, config: RailConfig): Rail {
  const axis = config.axis ?? 'x';
  const dragSlop = config.dragSlop ?? 8;
  const thresholds: GestureThresholds = {
    tapSlop: config.tapSlop ?? 3,
    swipeDist: config.swipeDist ?? 50,
    swipeVel: config.swipeVel ?? 0.5,
    swipeMaxMs: config.swipeMaxMs ?? 250,
  };
  const pointers = new Map<number, RailPointer>();

  const clearHold = (p: RailPointer): void => {
    if (p.holdStart) clearTimeout(p.holdStart);
    if (p.holdRepeat) clearInterval(p.holdRepeat);
    p.holdStart = undefined;
    p.holdRepeat = undefined;
  };

  const onDown = (e: PointerEvent): void => {
    // Ignore a second finger mid-gesture rather than interleaving two rails.
    if (pointers.size > 0) return;
    const rect = el.getBoundingClientRect();
    const p: RailPointer = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      emitted: 0,
      startT: e.timeStamp,
      promoted: false,
    };
    pointers.set(e.pointerId, p);
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      // Not an active pointer (a synthetic event, or one already released).
      // Capture is an optimisation; move/up are bound below regardless.
    }
    if (config.onHold) {
      p.holdStart = setTimeout(() => {
        if (p.promoted) return;
        config.onHold!();
        p.holdRepeat = setInterval(() => config.onHold!(), config.holdRepeatMs ?? 45);
      }, config.holdStartMs ?? 260);
    }
  };

  const onMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - rect.left - p.startX;
    const dy = e.clientY - rect.top - p.startY;
    if (!p.promoted && Math.hypot(dx, dy) > dragSlop) {
      p.promoted = true;
      clearHold(p); // a drag is not a hold
    }
    if (!p.promoted) return;

    const travel = axis === 'x' ? dx : dy;
    // Steps OWED = where the finger is, minus what the game already knows about.
    // This is what makes a drag back and forth net out instead of ratcheting.
    const want = Math.trunc(travel / config.stepPx);
    let owed = want - p.emitted;
    while (owed !== 0) {
      const dir: -1 | 1 = owed > 0 ? 1 : -1;
      config.onStep(dir, e);
      p.emitted += dir;
      owed -= dir;
    }
  };

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    clearHold(p);
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already gone */
    }
    if (cancelled) {
      config.onCancel?.();
      return;
    }
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - rect.left - p.startX;
    const dy = e.clientY - rect.top - p.startY;
    const g = classifyRelease(dx, dy, e.timeStamp - p.startT, p.promoted, thresholds);
    if (g.kind === 'tap') config.onTap?.(e);
    else if (g.kind === 'swipe') config.onSwipe?.(g.dir, dx, dy);
  };

  const onUp = (e: PointerEvent): void => finish(e, false);
  const onCancelEv = (e: PointerEvent): void => finish(e, true);

  el.addEventListener('pointerdown', onDown);
  // move/up/cancel on WINDOW so a drag that leaves the element still resolves.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancelEv);

  return {
    active: () => pointers.size > 0,
    destroy() {
      for (const p of pointers.values()) clearHold(p);
      pointers.clear();
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancelEv);
    },
  };
}
