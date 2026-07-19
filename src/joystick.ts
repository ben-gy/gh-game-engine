/**
 * joystick.ts — a FLOATING (dynamic) analog thumbstick for touch.
 *
 * The problem it solves: a game whose only touch control is "point at where you
 * want to go" makes the player reach ACROSS the screen and cover the very thing
 * they are steering. A floating stick spawns its base wherever the thumb first
 * lands, so control is decoupled from the avatar's position — you steer from a
 * comfortable bottom corner and never occlude the play area.
 *
 * Design (from patterns/MOBILE_CONTROLS.md, verified):
 *  · DYNAMIC/floating (base appears under the thumb), not a fixed widget.
 *  · One stick per pointerId; `setPointerCapture` so a drag that leaves the
 *    surface still tracks, and a second thumb can hit an action button without
 *    stealing the stick.
 *  · RADIAL dead zone (0.10 of the throw) with a scaled remap, so output starts
 *    from ~0 just outside the zone instead of jumping — and a normalized
 *    direction is emitted alongside a separate 0..1 magnitude (analog speed).
 *  · Knob driven by `transform: translate` (GPU), clamped to the ring; the raw
 *    finger past the ring still reads as full magnitude.
 *  · `pointercancel` is handled exactly like `pointerup` (an incoming call fires
 *    cancel, not up) — snap home, zero the vector, hide.
 *  · TOUCH ONLY by default: desktop keeps its own scheme (mouse aim / keyboard),
 *    and the stick is purely additive.
 *
 * COPY THIS FILE into src/engine/.
 *
 *   const stick = createJoystick({
 *     surface: canvas,
 *     onChange: (v) => { heading.x = v.x; heading.y = v.y; speed = v.mag; },
 *   });
 *   // ...in your loop: const v = stick.vector();
 */

export interface JoystickVector {
  /** Normalized direction, 0 when idle/inside the dead zone. */
  x: number;
  y: number;
  /** Analog magnitude 0..1 (0 idle, 1 at/beyond the ring). */
  mag: number;
}

export interface JoystickConfig {
  /** Element whose pointerdown starts a stick — usually the canvas or a control
   *  layer. Action buttons placed ABOVE it (their own elements) keep working. */
  surface: HTMLElement;
  /** Fired on down, every move, and on release (release → {0,0,0}). */
  onChange?: (v: JoystickVector) => void;
  onStart?: () => void;
  onEnd?: () => void;
  /** Where to mount the visual base+knob. Default: document.body. */
  layer?: HTMLElement;
  /** Ignore mouse pointers so desktop keeps its own control. Default true. */
  ignoreMouse?: boolean;
  /** Dead zone as a fraction of the throw radius. Default 0.10. */
  deadZone?: number;
  /** Base diameter in CSS px. Default: responsive, clamp(96, 20vmin, 148). */
  size?: number;
  /** Skip the snap-back fade (prefers-reduced-motion). Default false. */
  reducedMotion?: boolean;
  /** Stacking context for the overlay. Default 40. */
  zIndex?: number;
  /** Hide the visual base+knob (invisible stick). Default false. */
  invisible?: boolean;
}

export interface Joystick {
  /** True while a thumb is down and steering. */
  active(): boolean;
  /** The latest vector — poll this in your update loop. */
  vector(): JoystickVector;
  destroy(): void;
}

const IDLE: JoystickVector = { x: 0, y: 0, mag: 0 };

export function createJoystick(config: JoystickConfig): Joystick {
  const {
    surface,
    onChange,
    onStart,
    onEnd,
    ignoreMouse = true,
    deadZone = 0.1,
    reducedMotion = false,
    zIndex = 40,
    invisible = false,
  } = config;
  const layer = config.layer ?? document.body;

  let pointerId: number | null = null;
  let baseX = 0;
  let baseY = 0;
  let radius = 0;
  let cur: JoystickVector = IDLE;

  // The visual overlay is purely cosmetic — pointer-events off, so it never
  // intercepts the moves that setPointerCapture is routing to the surface.
  const baseEl = document.createElement('div');
  const knobEl = document.createElement('div');
  baseEl.setAttribute('aria-hidden', 'true');
  baseEl.style.cssText =
    `position:fixed;left:0;top:0;pointer-events:none;z-index:${zIndex};border-radius:50%;` +
    'display:none;box-sizing:border-box;' +
    (invisible
      ? ''
      : 'border:2px solid rgba(255,255,255,.35);background:radial-gradient(circle,rgba(255,255,255,.10),rgba(255,255,255,.03));');
  knobEl.style.cssText =
    'position:absolute;left:50%;top:50%;border-radius:50%;will-change:transform;' +
    (invisible
      ? ''
      : 'background:radial-gradient(circle at 38% 32%,rgba(255,255,255,.95),rgba(255,255,255,.55));' +
        'box-shadow:0 2px 8px rgba(0,0,0,.4);');
  baseEl.appendChild(knobEl);
  layer.appendChild(baseEl);

  function resolveSize(): number {
    if (config.size) return config.size;
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    return Math.max(96, Math.min(vmin * 0.2, 148));
  }

  function show(): void {
    const size = resolveSize();
    radius = size / 2;
    baseEl.style.width = `${size}px`;
    baseEl.style.height = `${size}px`;
    baseEl.style.left = `${baseX - radius}px`;
    baseEl.style.top = `${baseY - radius}px`;
    baseEl.style.transition = 'none';
    baseEl.style.opacity = '1';
    baseEl.style.display = 'block';
    const knob = size * 0.46;
    knobEl.style.width = `${knob}px`;
    knobEl.style.height = `${knob}px`;
    knobEl.style.marginLeft = `${-knob / 2}px`;
    knobEl.style.marginTop = `${-knob / 2}px`;
    knobEl.style.transition = 'none';
    knobEl.style.transform = 'translate(0px,0px)';
  }

  function moveKnob(dx: number, dy: number, mag: number): void {
    const clamped = Math.min(mag, radius);
    const nx = mag > 0 ? dx / mag : 0;
    const ny = mag > 0 ? dy / mag : 0;
    knobEl.style.transform = `translate(${nx * clamped}px,${ny * clamped}px)`;
  }

  function computeVector(dx: number, dy: number): JoystickVector {
    const mag = Math.hypot(dx, dy);
    const t = mag / radius;
    if (t <= deadZone || mag === 0) return IDLE;
    const nx = dx / mag;
    const ny = dy / mag;
    // Scaled radial remap (Sutphin): output ramps from ~0 just outside the dead
    // zone rather than snapping to a step, and clamps to 1 at the ring.
    const scaled = Math.min((t - deadZone) / (1 - deadZone), 1);
    return { x: nx, y: ny, mag: scaled };
  }

  function emit(v: JoystickVector): void {
    cur = v;
    onChange?.(v);
  }

  const onDown = (e: PointerEvent): void => {
    if (pointerId !== null) return; // one stick at a time
    if (ignoreMouse && e.pointerType === 'mouse') return;
    pointerId = e.pointerId;
    baseX = e.clientX;
    baseY = e.clientY;
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; moves still arrive on the surface */
    }
    show();
    e.preventDefault();
    onStart?.();
    emit(IDLE);
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - baseX;
    const dy = e.clientY - baseY;
    const mag = Math.hypot(dx, dy);
    moveKnob(dx, dy, mag);
    emit(computeVector(dx, dy));
    e.preventDefault();
  };

  const end = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    try {
      surface.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (reducedMotion) {
      baseEl.style.display = 'none';
    } else {
      knobEl.style.transition = 'transform 160ms ease-out';
      knobEl.style.transform = 'translate(0px,0px)';
      baseEl.style.transition = 'opacity 220ms ease-out';
      baseEl.style.opacity = '0';
      setTimeout(() => {
        if (pointerId === null) baseEl.style.display = 'none';
      }, 240);
    }
    emit(IDLE);
    onEnd?.();
  };

  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);

  return {
    active: () => pointerId !== null,
    vector: () => cur,
    destroy() {
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', end);
      surface.removeEventListener('pointercancel', end);
      baseEl.remove();
    },
  };
}
