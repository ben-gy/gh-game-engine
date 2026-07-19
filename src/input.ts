/**
 * input.ts — unified keyboard + touch + pointer input for games.
 *
 * Games must be playable on a phone. This module normalizes:
 *  - keyboard (WASD/arrows/space + custom keys)
 *  - an on-screen virtual D-pad + action buttons injected for touch devices
 *  - pointer position (mouse/touch) for aim
 * into a single polled `state` object plus edge-triggered "pressed this frame"
 * events. Poll `input.state` inside your fixed update; call `input.endFrame()`
 * once per frame to clear just-pressed edges.
 *
 * IMPORT from '@ben-gy/game-engine/input' and map the keys your game needs
 * through its config — do not copy it in.
 */

export interface Axis {
  x: number; // -1..1
  y: number; // -1..1
}

export interface InputState {
  axis: Axis;
  /** Held actions by name (e.g. 'fire','jump'). */
  down: Set<string>;
  /** Actions that transitioned to pressed since last endFrame(). */
  pressed: Set<string>;
  /** Pointer in CSS pixels relative to the target element. null if none. */
  pointer: { x: number; y: number } | null;
  pointerDown: boolean;
}

export interface InputConfig {
  /** Element to attach pointer listeners to (usually the canvas). */
  target: HTMLElement;
  /** Map KeyboardEvent.code -> action name. */
  keys: Record<string, string>;
  /** Show the touch overlay. Default: auto (coarse pointer / no hover). */
  touch?: boolean;
  /** Touch action buttons to render (besides the D-pad), left→right. */
  buttons?: { action: string; label: string }[];
}

export interface Input {
  readonly state: InputState;
  /** Call once at the END of each frame to clear `pressed` edges. */
  endFrame(): void;
  /** Remove all listeners and the touch overlay. */
  destroy(): void;
}

const AXIS_KEYS: Record<string, keyof Axis | 'nx' | 'ny'> = {};

export function createInput(config: InputConfig): Input {
  const state: InputState = {
    axis: { x: 0, y: 0 },
    down: new Set(),
    pressed: new Set(),
    pointer: null,
    pointerDown: false,
  };

  // Track raw directional intents so opposing keys cancel cleanly.
  const dir = { up: false, down: false, left: false, right: false };
  const DIR_ACTIONS = new Set(['up', 'down', 'left', 'right']);

  function applyAxis(): void {
    state.axis.x = (dir.right ? 1 : 0) - (dir.left ? 1 : 0);
    state.axis.y = (dir.down ? 1 : 0) - (dir.up ? 1 : 0);
  }

  function press(action: string): void {
    if (DIR_ACTIONS.has(action)) {
      (dir as Record<string, boolean>)[action] = true;
      applyAxis();
      return;
    }
    if (!state.down.has(action)) state.pressed.add(action);
    state.down.add(action);
  }
  function release(action: string): void {
    if (DIR_ACTIONS.has(action)) {
      (dir as Record<string, boolean>)[action] = false;
      applyAxis();
      return;
    }
    state.down.delete(action);
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const action = config.keys[e.code];
    if (!action) return;
    e.preventDefault();
    if (!e.repeat) press(action);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const action = config.keys[e.code];
    if (!action) return;
    release(action);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const rectPoint = (e: { clientX: number; clientY: number }) => {
    const r = config.target.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerMove = (e: PointerEvent) => {
    state.pointer = rectPoint(e);
  };
  const onPointerDown = (e: PointerEvent) => {
    state.pointer = rectPoint(e);
    state.pointerDown = true;
  };
  const onPointerUp = () => {
    state.pointerDown = false;
  };
  config.target.addEventListener('pointermove', onPointerMove);
  config.target.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);

  // Touch overlay (D-pad + action buttons). Injected only on coarse pointers.
  let overlay: HTMLElement | null = null;
  const wantTouch =
    config.touch ?? (matchMedia('(pointer: coarse)').matches || !matchMedia('(hover: hover)').matches);
  if (wantTouch) {
    overlay = buildTouchOverlay(config.buttons ?? [{ action: 'fire', label: '●' }], {
      onDir: (d, active) => {
        (dir as Record<string, boolean>)[d] = active;
        applyAxis();
      },
      onAction: (action, active) => (active ? press(action) : release(action)),
    });
    document.body.appendChild(overlay);
  }

  return {
    state,
    endFrame() {
      state.pressed.clear();
    },
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      config.target.removeEventListener('pointermove', onPointerMove);
      config.target.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      overlay?.remove();
    },
  };
}

void AXIS_KEYS; // reserved for future analog-key mapping

interface TouchCallbacks {
  onDir: (dir: 'up' | 'down' | 'left' | 'right', active: boolean) => void;
  onAction: (action: string, active: boolean) => void;
}

/** Minimal, dependency-free virtual controls. Style via .vpad / .vbtn in CSS. */
function buildTouchOverlay(
  buttons: { action: string; label: string }[],
  cb: TouchCallbacks,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'vcontrols';
  root.style.cssText =
    'position:fixed;inset:auto 0 0 0;display:flex;justify-content:space-between;' +
    'align-items:flex-end;padding:16px;pointer-events:none;z-index:50;touch-action:none;';

  const pad = document.createElement('div');
  pad.className = 'vpad';
  pad.style.cssText =
    'display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);' +
    'gap:4px;pointer-events:auto;';
  const dirs: [string, 'up' | 'down' | 'left' | 'right'][] = [
    ['↑', 'up'],
    ['←', 'left'],
    ['→', 'right'],
    ['↓', 'down'],
  ];
  const cells: Record<string, HTMLElement> = {};
  const slot = (r: number, c: number, el?: HTMLElement) => {
    const d = document.createElement('div');
    d.style.gridArea = `${r} / ${c}`;
    if (el) d.appendChild(el);
    return d;
  };
  for (const [label, d] of dirs) {
    const b = mkBtn(label);
    cells[d] = b;
    const bind = (active: boolean) => (e: Event) => {
      e.preventDefault();
      b.classList.toggle('active', active);
      cb.onDir(d, active);
    };
    b.addEventListener('touchstart', bind(true), { passive: false });
    b.addEventListener('touchend', bind(false), { passive: false });
    b.addEventListener('touchcancel', bind(false), { passive: false });
  }
  pad.append(
    slot(1, 2, cells.up),
    slot(2, 1, cells.left),
    slot(2, 3, cells.right),
    slot(3, 2, cells.down),
  );

  const acts = document.createElement('div');
  acts.style.cssText = 'display:flex;gap:12px;pointer-events:auto;';
  for (const { action, label } of buttons) {
    const b = mkBtn(label, 60);
    const bind = (active: boolean) => (e: Event) => {
      e.preventDefault();
      b.classList.toggle('active', active);
      cb.onAction(action, active);
    };
    b.addEventListener('touchstart', bind(true), { passive: false });
    b.addEventListener('touchend', bind(false), { passive: false });
    b.addEventListener('touchcancel', bind(false), { passive: false });
    acts.appendChild(b);
  }

  root.append(pad, acts);
  return root;
}

function mkBtn(label: string, size = 44): HTMLElement {
  const b = document.createElement('button');
  b.className = 'vbtn';
  b.textContent = label;
  b.style.cssText =
    `width:${size}px;height:${size}px;border-radius:50%;border:1px solid rgba(255,255,255,.3);` +
    'background:rgba(255,255,255,.12);color:#fff;font-size:20px;user-select:none;' +
    'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  return b;
}
