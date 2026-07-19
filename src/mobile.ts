/**
 * mobile.ts — the parts of "never zoom, never feel like a web page" that CSS
 * cannot express on its own.
 *
 * Pair with mobile.css. Call `hardenViewport()` once at boot, before the first
 * screen renders.
 *
 *   import { hardenViewport } from './engine/mobile';
 *   hardenViewport();
 *
 * Why any of this is needed: `<meta name="viewport" content="user-scalable=no">`
 * is ignored by iOS Safari (deliberately, since iOS 10). mobile.css's
 * `touch-action: manipulation` kills double-tap zoom, but PINCH zoom on iOS only
 * stops if you cancel the proprietary `gesture*` events — and a zoomed-in game
 * with no way back out is unplayable.
 *
 * IMPORT from '@ben-gy/game-engine/mobile' — do not copy it into the game.
 */

export interface HardenOptions {
  /** Block pinch-zoom. Default true. */
  pinch?: boolean;
  /** Block double-tap zoom (belt and braces over mobile.css). Default true. */
  doubleTap?: boolean;
  /**
   * Keep `--vh` in sync with the real viewport height. Default true.
   * Mobile browsers report 100vh as the height WITHOUT the collapsing URL bar,
   * so a 100vh layout is cut off until the user scrolls. Use `height:
   * calc(var(--vh) * 100)` instead of `100vh`.
   */
  vhUnit?: boolean;
}

/** Undo everything hardenViewport() installed. Mostly for tests. */
export type Unharden = () => void;

export function hardenViewport(opts: HardenOptions = {}): Unharden {
  const { pinch = true, doubleTap = true, vhUnit = true } = opts;
  const offs: (() => void)[] = [];

  const on = <K extends string>(
    target: EventTarget,
    type: K,
    fn: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, fn, options);
    offs.push(() => target.removeEventListener(type, fn, options));
  };

  if (pinch) {
    // Safari-only, and the only way to refuse a pinch. `passive: false` is what
    // makes preventDefault actually count.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      on(document, type, (e) => e.preventDefault(), { passive: false });
    }
    // Android/Chrome route pinch through multi-touch instead of gesture events.
    on(
      document,
      'touchmove',
      (e) => {
        if ((e as TouchEvent).touches.length > 1) e.preventDefault();
      },
      { passive: false },
    );
  }

  if (doubleTap) {
    // A second tap inside the double-tap window zooms on iOS even with
    // touch-action set, if the first tap landed on something non-interactive.
    let lastTap = 0;
    on(
      document,
      'touchend',
      (e) => {
        const t = Date.now();
        if (t - lastTap < 320) e.preventDefault();
        lastTap = t;
      },
      { passive: false },
    );
    on(document, 'dblclick', (e) => e.preventDefault(), { passive: false });
  }

  if (vhUnit) {
    const setVh = (): void => {
      const h = window.innerHeight;
      // A backgrounded or pre-rendered tab reports 0. Writing that through would
      // set --vh to 0px and collapse every `calc(var(--vh) * 100)` layout to a
      // blank page — leave the 1vh fallback from mobile.css in place instead.
      if (h > 0) document.documentElement.style.setProperty('--vh', `${h * 0.01}px`);
    };
    setVh();
    on(window, 'resize', setVh);
    on(window, 'orientationchange', setVh);
    // The first real measurement may only arrive once the tab is shown.
    on(document, 'visibilitychange', setVh);
  }

  return () => {
    for (const off of offs) off();
  };
}
