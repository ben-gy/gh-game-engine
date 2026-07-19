/**
 * loop.ts — fixed-timestep game loop with a render interpolation hook.
 *
 * A naive `requestAnimationFrame(dt)` loop makes physics frame-rate dependent
 * (different behaviour at 60Hz vs 144Hz, and a "spiral of death" after a tab
 * stalls). This loop steps the simulation at a FIXED rate (default 60Hz) with an
 * accumulator, and gives render() the interpolation `alpha` so motion stays
 * smooth on any display. Determinism from a fixed step is also what lets P2P
 * peers agree.
 *
 * COPY THIS FILE into src/ — do not re-roll the accumulator.
 *
 *   const loop = createLoop({
 *     update: (step) => world.tick(step),      // step = seconds, always constant
 *     render: (alpha) => draw(world, alpha),    // alpha in [0,1) between steps
 *   });
 *   loop.start();  // loop.stop() to pause
 */

export interface LoopConfig {
  /** Advance the simulation by exactly `step` seconds. Called 0+ times/frame. */
  update: (step: number) => void;
  /** Paint. `alpha` interpolates between the last two sim states for smoothness. */
  render: (alpha: number) => void;
  /** Simulation rate in Hz. Default 60. */
  hz?: number;
  /** Max sim steps per frame before we drop time (anti spiral-of-death). Default 5. */
  maxStepsPerFrame?: number;
  /** Optional per-frame callback with measured FPS, for a HUD. */
  onFps?: (fps: number) => void;
}

export interface Loop {
  start(): void;
  stop(): void;
  running(): boolean;
}

export function createLoop(config: LoopConfig): Loop {
  const hz = config.hz ?? 60;
  const step = 1 / hz;
  const maxSteps = config.maxStepsPerFrame ?? 5;

  let raf = 0;
  let last = 0;
  let acc = 0;
  let alive = false;

  // FPS smoothing.
  let fpsAccum = 0;
  let frames = 0;

  const frame = (now: number) => {
    if (!alive) return;
    raf = requestAnimationFrame(frame);

    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25; // clamp huge gaps (tab was backgrounded)
    acc += dt;

    let steps = 0;
    while (acc >= step && steps < maxSteps) {
      config.update(step);
      acc -= step;
      steps++;
    }
    // If we blew the budget, discard leftover time rather than spiral.
    if (steps >= maxSteps) acc = 0;

    config.render(acc / step);

    if (config.onFps) {
      fpsAccum += dt;
      frames++;
      if (fpsAccum >= 0.5) {
        config.onFps(frames / fpsAccum);
        fpsAccum = 0;
        frames = 0;
      }
    }
  };

  return {
    start() {
      if (alive) return;
      alive = true;
      last = performance.now();
      acc = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      alive = false;
      cancelAnimationFrame(raf);
    },
    running: () => alive,
  };
}
