// @vitest-environment jsdom
/**
 * rail.test.ts — travel converted to discrete steps, without ratcheting.
 *
 * `makeDraggable` emits a gesture; a falling-block game needs a stream of axis
 * steps. Ballast built one game-side because the engine had none.
 *
 * The invariant worth the most here is the NET-OUT one: steps are owed against a
 * running total, not counted per move event. A player who drags three columns
 * right and then back to where they started must end where they started — the
 * naive per-event implementation ratchets up six steps and the piece ends three
 * columns from where the thumb says it is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRail } from '../src/drag';

let el: HTMLElement;
let steps: number[];
let taps: number;
let swipes: string[];
let holds: number;
let cancels: number;
/** Every rail made in a test, so none survives into the next one. A rail binds
 *  move/up to WINDOW, so a leaked instance keeps stepping later tests' counters. */
let rails: Array<{ destroy(): void }>;

afterEach(() => {
  for (const r of rails) r.destroy();
});

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  el = document.createElement('div');
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 }) as DOMRect;
  document.body.appendChild(el);
  steps = [];
  taps = 0;
  swipes = [];
  holds = 0;
  cancels = 0;
  rails = [];
});

function rail(overrides = {}) {
  const r = makeRail(el, {
    stepPx: 26,
    onStep: (dir) => steps.push(dir),
    onTap: () => taps++,
    onSwipe: (dir) => swipes.push(dir),
    onCancel: () => cancels++,
    ...overrides,
  });
  rails.push(r);
  return r;
}

/** jsdom has no PointerEvent; MouseEvent plus the fields the rail reads is enough. */
function pointer(type: string, x: number, y: number, t = 0, target: EventTarget = window): void {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }) as MouseEvent & {
    pointerId: number;
    timeStamp: number;
  };
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'timeStamp', { value: t });
  target.dispatchEvent(e);
}

const down = (x: number, y = 0, t = 0): void => pointer('pointerdown', x, y, t, el);
const move = (x: number, y = 0, t = 0): void => pointer('pointermove', x, y, t);
const up = (x: number, y = 0, t = 0): void => pointer('pointerup', x, y, t);

describe('stepping', () => {
  it('emits one step per stepPx of travel', () => {
    rail();
    down(0);
    move(26);
    expect(steps).toEqual([1]);
    move(52);
    expect(steps).toEqual([1, 1]);
    move(78);
    expect(steps).toEqual([1, 1, 1]);
  });

  it('emits several steps for one big jump', () => {
    // A fast drag between move events must not lose the travel in between.
    rail();
    down(0);
    move(80);
    expect(steps).toEqual([1, 1, 1]);
  });

  it('steps in both directions', () => {
    rail();
    down(100);
    move(74);
    expect(steps).toEqual([-1]);
    move(48);
    expect(steps).toEqual([-1, -1]);
  });

  it('NETS OUT a drag that returns to where it started', () => {
    // The bug the running total exists to prevent: counting per move event gives
    // six steps here and leaves the piece three columns from the thumb.
    rail();
    down(0);
    move(78); // +3
    move(0); // back
    expect(steps.reduce((a, b) => a + b, 0)).toBe(0);
    expect(steps).toEqual([1, 1, 1, -1, -1, -1]);
  });

  it('does not step until the drag is promoted', () => {
    // Under the slop it is still a potential tap.
    rail({ dragSlop: 8 });
    down(0);
    move(5);
    expect(steps).toEqual([]);
    move(30);
    expect(steps).toEqual([1]);
  });

  it('measures from the grab point, so the piece never jumps to the thumb', () => {
    rail();
    down(137); // finger lands anywhere
    move(137); // no travel
    expect(steps).toEqual([]);
    move(163); // one step of travel from the GRAB point
    expect(steps).toEqual([1]);
  });

  it('runs on the y axis when asked', () => {
    rail({ axis: 'y' });
    down(0, 0);
    move(0, 52);
    expect(steps).toEqual([1, 1]);
    move(52, 52); // x travel is ignored
    expect(steps).toEqual([1, 1]);
  });

  it('ignores a second finger rather than interleaving two rails', () => {
    rail();
    down(0);
    const e = new MouseEvent('pointerdown', { bubbles: true, clientX: 200 }) as MouseEvent & {
      pointerId: number;
    };
    Object.defineProperty(e, 'pointerId', { value: 2 });
    el.dispatchEvent(e);
    move(26);
    expect(steps).toEqual([1]);
  });
});

describe('tap and swipe stay first-class', () => {
  it('a still press-and-release is a tap, not a drag', () => {
    rail();
    down(50, 50, 0);
    up(51, 50, 100);
    expect(taps).toBe(1);
    expect(steps).toEqual([]);
  });

  it('a fast flick is a swipe and does not also report a tap', () => {
    rail();
    down(0, 0, 0);
    move(0, 60, 50);
    up(0, 60, 60);
    expect(swipes).toEqual(['down']);
    expect(taps).toBe(0);
  });

  it('a slow long drag is NOT a swipe', () => {
    rail();
    down(0, 0, 0);
    move(0, 60, 900);
    up(0, 60, 1000);
    expect(swipes).toEqual([]);
    expect(taps).toBe(0);
  });
});

describe('hold', () => {
  it('repeats while the finger is down and still', () => {
    rail({ onHold: () => holds++ });
    down(0);
    vi.advanceTimersByTime(260);
    expect(holds).toBe(1);
    vi.advanceTimersByTime(45 * 3);
    expect(holds).toBe(4);
  });

  it('is cancelled by a drag, so steering never also soft-drops', () => {
    rail({ onHold: () => holds++ });
    down(0);
    move(30);
    vi.advanceTimersByTime(2000);
    expect(holds).toBe(0);
  });

  it('stops on release', () => {
    rail({ onHold: () => holds++ });
    down(0);
    vi.advanceTimersByTime(400);
    const before = holds;
    up(0, 0, 500);
    vi.advanceTimersByTime(1000);
    expect(holds).toBe(before);
  });
});

describe('teardown', () => {
  it('treats pointercancel as an abort, not a tap', () => {
    rail();
    down(0, 0, 0);
    pointer('pointercancel', 0, 0, 50);
    expect(cancels).toBe(1);
    expect(taps).toBe(0);
  });

  it('detaches every listener and kills any pending hold', () => {
    const r = rail({ onHold: () => holds++ });
    down(0);
    r.destroy();
    vi.advanceTimersByTime(2000);
    expect(holds).toBe(0);
    move(100);
    expect(steps).toEqual([]);
    expect(r.active()).toBe(false);
  });

  it('reports whether a finger is down', () => {
    const r = rail();
    expect(r.active()).toBe(false);
    down(0);
    expect(r.active()).toBe(true);
    up(0, 0, 10);
    expect(r.active()).toBe(false);
  });
});
