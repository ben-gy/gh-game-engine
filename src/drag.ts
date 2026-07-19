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
 * COPY THIS FILE into src/engine/.
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
