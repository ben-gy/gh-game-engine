# Mobile controls & drop-in multiplayer — implementable spec

Standing best-practice guidance for every game this factory builds. Produced from
multi-source research and adversarially verified; every number here is a real,
widely-accepted default, not a guess. Three rules are load-bearing across all of
it: **unify input on Pointer Events + `setPointerCapture` + per-`pointerId`
state**, **apply input in the rAF loop off a snapshot (never inside the event
handler)**, and **set `touch-action: none` on every game/control surface**.

The shared modules that implement this: [`joystick.ts`](./joystick.ts),
[`drag.ts`](./drag.ts), [`presence.ts`](./presence.ts), plus the
`body.playing .site-footer` rule and `.control-layer` in [`mobile.css`](./mobile.css).

---

## 1. Floating virtual joystick — `joystick.ts`

For any game where the touch scheme is "point at where you want to go" (it makes
the player reach across and cover the avatar). Model on nipplejs `dynamic` mode.

- **Floating/dynamic**: base spawns under the thumb on `pointerdown`, never a
  fixed widget, never occludes the play area. (Fixed is only for twitch games
  needing muscle-memory placement.)
- **Base diameter ~18–22vmin**; **knob 40–50% of base**; **maxRadius = base
  radius**. Hit targets ≥ 44 CSS px.
- **Radial dead zone 0.10** of the throw + **Sutphin scaled remap** so output
  ramps from ~0 just outside the zone (never a square/per-axis zone → snaps
  diagonals; never a hard clamp → velocity jump). Emit **normalized direction +
  separate 0..1 magnitude**.
- **Knob via `transform: translate`** (GPU), clamped to the ring; raw finger past
  the ring still reads full magnitude.
- `setPointerCapture(pointerId)`; **one stick per `pointerId`**; handle
  **`pointercancel` like `pointerup`** (an incoming call fires cancel).
- **Touch only by default** — desktop keeps mouse-aim / keyboard; the stick is
  additive. WASD/arrows always live.
- Pitfalls: `offsetX/offsetY` (use `clientX − getBoundingClientRect`), DPR
  double-scaling, listening for move on the small base without capture (frozen
  stick), integrating in the event handler.

## 2. Drag / swipe for DOM cards & tiles — `drag.ts`

Unified Pointer Events; **not** the legacy HTML5 DnD API. `.card { touch-action:
none; user-select: none; -webkit-user-drag: none; }`.

| Constant | Value |
|---|---|
| tap (release displacement) | **< 3px** |
| promote press→drag | **~8px touch / ~4px mouse** |
| swipe min distance | **~50px/axis** |
| swipe min velocity | **~0.5 px/ms** |
| swipe max duration (longer ⇒ drag) | **~250ms** |

- **Don't drag on `pointerdown`** — enter a pending state, promote to drag only
  past the slop so **tap stays a first-class play action**.
- **Preserve the grab offset** (`clientX − rect.left`, not `offsetX`) so the card
  doesn't jump under the finger. Move/animate `transform` only, never `left/top`.
- Classify on `pointerup`: tap < 3px · swipe (fast+far, <250ms, dominant-axis
  lock) · else drag → resolve by drop zone (`getBoundingClientRect` hit-test,
  ~50% overlap; live-highlight valid targets). **Snap-to / snap-back 150–200ms**
  `cubic-bezier(0.2,0.8,0.2,1)`. Cache sibling rects at drag start (no
  per-move layout thrash). FLIP for hand reordering.
- **Accessibility (required):** keyboard path (Enter/Space pick up, Arrows move,
  Enter/Space drop, Escape cancel), visible non-drag buttons, `aria-live` (not
  the deprecated `aria-grabbed`). Satisfies WCAG 2.5.7 Dragging + 2.1.1 Keyboard.
  Hit targets ≥ 44×44.

## 3. Fast-action / twin-stick — `joystick.ts` + auto-steer/auto-fire

Recommended for a 60fps arena game (Brawl Stars model): **left floating analog
stick** for movement + **right attack**. Analog beats a d-pad because a d-pad is
8 discrete directions with no magnitude; analog gives a continuous 360° vector +
0..1 speed — exactly why a d-pad "feels wrong" for a fast shooter.

- Full 360° analog (snap to 16, never 8, if you must). Draggable base so a
  reversal is one short slide.
- Attack right side: tap = quick auto-aimed shot, drag-release = manual aim.
  **Always ship a one-handed auto-fire fallback**; never force two simultaneous
  sticks.
- Auto-aim: closest enemy within a 45° facing cone; keep the lock until the
  angle exceeds a 90° reset cone (hysteresis stops per-frame flicker).
- Read input first each frame; apply in **rAF × delta-time**. Acknowledge every
  touch on `pointerdown` same frame. Light velocity smoothing only (τ ≈
  0.03–0.05s); never smooth the raw knob. Added-code latency budget ~50ms.

## 4. Thumb ergonomics & anti-occlusion

- **Core rule:** never co-locate a control with the avatar it moves — it forces
  the hand to screen centre (hardest reach) AND occludes the action. Avatar
  centre/raised, controls lower-outer, relative/directional input.
- Reach zones (Hoober/Hurff): bottom third = natural (put the joystick there);
  mid/far = occasional taps; top third/corners = pause/settings only.
- Grip: 49% one-handed (67% right / 33% left of those). Never hard-code
  right-handed — a floating stick that spawns at the touch point solves
  handedness for free.
- Sizes: Apple 44×44pt · Material 48×48dp · WCAG 2.5.5 AAA 44px / 2.5.8 AA 24px.
  Hit size ≠ visual size — keep art small, expand the invisible hit area.
  ≥ 8dp spacing, 16pt+ for primary; move & fire in opposite corners.
- Safe areas: `<meta viewport … viewport-fit=cover>` (or `env(safe-area-inset-*)`
  resolves to 0). Canvas full-bleed (`100dvh`); inset only the HUD/control layer.
  Read live `env()` values; never hard-code notch/island/home-bar insets.

## 5. Drop-in public lobby + live presence — `presence.ts` + `noticeboard.ts`

Respect **ONE ROOM PER SESSION — never leave+rejoin** (it silently makes every
peer a lone host); rematch in-room via `rematch.ts`. Presence must not churn rooms.

- **Public is a first-class, opt-in shape:** a prominent "Play online" drops you
  straight into a shared room (agar.io/slither.io model) — no account, no queue.
  Keep "Play with friends" (private, invite-only) one tap away.
- **Land playable immediately vs bots**; humans swap in as they arrive — no
  blocking "waiting for players…" gate. Design the core loop fun at N=1.
- **Live counts as social proof:** app-wide online / in-room "3/8", animated.
  **Keep counts honest** — count real peers, label bots ("2 players + 2 bots");
  soften an empty count with truthful recent-activity, never a fabricated number.
- **Serverless presence:** a persistent second room + **5s heartbeat + ~15s TTL
  prune** (not `onPeerLeave`, which misses closed tabs). Count `getPeers().length
  (+1 self)` for the live room; gossip `{room}` so one presence room represents
  many game rooms. **Fill-don't-spill:** route newcomers to the most-populated
  joinable room < capacity before minting a new one. Backfill bots to the ideal
  seat count; swap bot→human on join.
- **Full mesh (O(n²)):** cap ~20–35 peers/room, shard beyond that. You cannot
  read tracker counts without joining, so presence IS an in-mesh heartbeat.
- **Privacy:** WebRTC exposes your real IP to every peer with no prompt. Disclose
  the IP tradeoff once, in plain non-blocking language, **at the public opt-in**.
  Never join a presence/board mesh on page load.

---

## 6. MOBILE CONTROLS — NON-NEGOTIABLE (routine checklist)

**Input plumbing**
- [ ] Pointer Events only (`pointerdown/move/up/cancel`), one path for
      touch/mouse/pen. Never mouse-only, never one global handler.
- [ ] `setPointerCapture(pointerId)` on down; per-`pointerId` state for multitouch.
- [ ] Handle **`pointercancel`** like an aborted gesture (zero velocity / snap back).
- [ ] `touch-action: none` + `user-select: none` on interactive surfaces.
      `<meta viewport width=device-width, initial-scale=1, viewport-fit=cover>`.
- [ ] `clientX/Y − getBoundingClientRect()`; never `offsetX/offsetY`.
- [ ] Store latest input; apply in **rAF × delta-time**, never in the handler.

**Joystick** — floating, base 18–22vmin, knob 40–50%, maxRadius = base radius;
radial dead-zone 0.10 + scaled remap; normalized dir + 0..1 magnitude; keyboard
stays live as fallback.

**Cards/tiles** — press→drag ~8px, tap <3px, swipe ≥50px & >0.5px/ms & <250ms
dominant-axis lock; preserve grab offset; snap 150–200ms; tap stays first-class;
keyboard + visible buttons for a11y.

**Twin-stick** — analog floating movement stick; auto-aim 45°/90° hysteresis;
one-handed auto-fire fallback; never two forced sticks.

**Ergonomics** — hit targets ≥44px (visual size independent); ≥8dp spacing;
avatar centre, controls lower-outer; HUD inset via `env(safe-area-inset-*)`;
`prefers-reduced-motion` honored.

**Footer** — hide the site-footer while a round is live (`body.playing`); show it
on every other screen.

**Drop-in multiplayer** — primary "Play online" = public quick-play, playable vs
bots instantly, no blocking countdown, bot→human swap on join; presence via a
persistent room + 5s beat + ~15s TTL; honest counts (label bots); cap/shard the
mesh; **never leave+rejoin**; disclose WebRTC IP exposure at the public opt-in;
keep invite-only one tap away.

---

*Primary sources: nipplejs · Sutphin dead-zones · MDN Pointer Events /
touch-action / env() · javascript.info drag'n'drop · @use-gesture defaults · FLIP
· WCAG 2.5.5/2.5.7/2.5.8 · Brawl Stars controls · Suzy Cube · MEGALOMOBILE
auto-aim · GameBench latency · Deber CHI 2015 · Smashing thumb-zone · Hoober grip
data · Trystero · security.org WebRTC IP leak.*
