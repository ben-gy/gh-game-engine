# @ben-gy/game-engine

The shared P2P game engine behind the [gh-game-factory](https://github.com/ben-gy/gh-game-factory)
fleet. Proven, production-tested building blocks: netcode, multi-round sessions,
lobby, deterministic RNG, game loop, mobile input, and audio.

**Depend and extend — never copy or edit engine files.** Add the package, import
the modules you need, and express game-specific behaviour through the engine's
config, hooks and channels.

```jsonc
// package.json
"dependencies": {
  "@ben-gy/game-engine": "github:ben-gy/gh-game-engine#v1.0.0"
}
```

```ts
import { createNet } from '@ben-gy/game-engine/net';
import { createRounds } from '@ben-gy/game-engine/rematch';
```

Ships raw TypeScript — every consumer is Vite + TS, so the source compiles in the
consumer and there is no build step to drift. The only runtime dependency is
`trystero` (pinned exact; upgraded deliberately via engine releases).

> **v1.0.0 is a pure extraction** of `gh-game-factory/patterns/` with zero
> behaviour change, so the two can be diffed line for line. The reliability work
> — epoch host election, start-protocol hardening, TURN — lands in v1.1.0.

## Modules

| File | What it gives you | When to copy |
|------|-------------------|--------------|
| `net.ts` | Zero-backend P2P mesh (Trystero/WebRTC). Peer roster, deterministic host election, typed channels with fan-out, latency ping, and a join registry that makes the leave/rejoin trap throw. | Every multiplayer game. |
| `rematch.ts` | Multi-round sessions inside ONE living room: ready/play-again votes, quorum + auto-start, monotonic round numbers, and a host-frozen roster so player indices match on every peer. | Every multiplayer game. |
| `lobby.ts` | Drop-in lobby **view** over `rematch.ts`: room code, invite link + Web Share, player roster, ready states, host-only Start, and an animated **connecting spinner** (`.spinner` + `.lobby-searching`) while waiting for peers — style these in your game's CSS. | Every multiplayer game. |
| `rng.ts` | Seedable deterministic PRNG (mulberry32) + shuffle/pick/randInt. Keeps peers in sync. | Any game with shared randomness (decks, spawns, boards). |
| `loop.ts` | Fixed-timestep loop with render interpolation. Frame-rate-independent physics, no spiral-of-death. | Any real-time / animated game. |
| `input.ts` | Unified keyboard + touch (auto virtual D-pad) + pointer, polled + edge-triggered. | Games that step in 4/8 directions or need a D-pad. |
| `joystick.ts` | **Floating analog thumbstick** for touch — spawns under the thumb, radial dead-zone + scaled magnitude, `setPointerCapture`, snaps back. Desktop keeps its own scheme. | Any game where the avatar is steered continuously (a d-pad or "tap where to go" feels wrong). |
| `drag.ts` | **Pointer gesture classifier** for DOM cards/tiles/handles: tap vs drag vs swipe off one Pointer Events stream, verified thresholds. Tap stays first-class. | Card / board / tile games that want drag-to-play + slide gestures. |
| `noticeboard.ts` | Serverless list of open **public rooms** — opt-in, hosts advertise, entries expire on silence. | Games offering public matchmaking. |
| `presence.ts` | Serverless **live head-count** ("3 playing · 5 online") via a heartbeat room + TTL prune. Opt-in only. | Drop-in public games wanting social-proof counts. |
| `sound.ts` | Procedural Web Audio SFX — zero asset files, works offline. | Any game wanting juice. |
| `storage.ts` | Namespaced, quota-safe localStorage for settings + local high-score boards. | Most games. |
| `tests/rng.test.ts` | Template proving the P2P-sync determinism invariant. | Copy + extend for any game with shared randomness. |

## Mobile controls — read `MOBILE_CONTROLS.md`

[`MOBILE_CONTROLS.md`](./MOBILE_CONTROLS.md) is the verified, cited best-practice
spec behind `joystick.ts`, `drag.ts` and `presence.ts` — exact numbers for the
floating joystick, card drag/swipe thresholds, twin-stick/auto-fire, thumb
ergonomics (44px targets, safe-area insets, anti-occlusion) and drop-in public
play. Its §6 checklist is the non-negotiable bar; follow it for every game.

**Footer convention:** the attribution `.site-footer` shows on every screen
*except* the live game. Add `playing` to `<body>` when a round starts and remove
it on the menu / results — `mobile.css` hides `body.playing .site-footer`. Nobody
wants a "more games" backlink mid-round, and on a phone it steals play area.

## The netcode model (read before building multiplayer)

> **⚠️ Point 2 below is STALE in v1.0.0 — it describes intent, not behaviour.**
> `net.ts` abandoned min-id re-election because it handed a live room to whoever
> arrived next holding none of the game state. The shipped model is **incumbency**:
> the host announces, everyone else adopts, and the role moves only when the host
> leaves. **`src/net.ts` is authoritative — read it, not this paragraph.** The doc
> is corrected (and the model hardened with election epochs) in v1.1.0; it is left
> intact here so v1.0.0 stays a byte-for-byte extraction of `patterns/`.

**Host-authoritative star** is the default and fits almost every casual game:

1. Everyone joins the same Trystero room (`appId` = repo slug, `roomId` = the
   shareable room code). Trystero does the WebRTC handshake over free public
   Nostr relays — **no server of ours**, which is exactly what GitHub Pages needs.
2. `net.ts` elects a **host** = the lexicographically smallest peer id. Every peer
   computes this independently from the same sorted roster, so they all agree with
   no handshake, and it **re-elects automatically** if the host leaves.
3. The **host owns authoritative state**, advances the simulation, and broadcasts
   snapshots on a channel (e.g. `'snap'`). **Clients send inputs** to the host
   (e.g. `'in'`) and render the snapshots they receive (interpolating with
   `loop.ts`'s `alpha`).
4. Shared randomness comes from a **seed the host broadcasts at start**
   (`rematch.ts` does this, alongside the frozen roster) fed into `rng.ts`, so no
   random outcome ever needs syncing.

### The rule that outranks the rest: one room per session

**Join the room once. Never leave and rejoin it to reset for a rematch.**

It looks harmless and it is catastrophic. Trystero memoizes `joinRoom` on
appId+roomId, but `room.leave()` is `async` and defers its real teardown behind a
~99ms timer. So `net.leave(); createNet(...)` in the same tick hands you back the
**room that is about to be destroyed**. Moments later its relay subscription and
announce loop are torn down under you: the mesh never forms, `roster()` stays
`[selfId]` forever, and every peer elects *itself* host. Both players sit in the
right room code, alone, permanently. Two shipped games had this exact bug.

So a rematch never touches the room — keep one `Net` for the room's whole life
and version the rounds inside it with `rematch.ts`. `createNet` now throws if you
re-join a room that is still tearing down; restructure rather than route around
it. If you genuinely need to leave and come back (menu → room), `await
net.leave()` first — it resolves only once Trystero has really let go.

`netStats().joins` exists so a test can assert this directly: one join per
session, no relay or browser required. Copy cipher-clash's `net-lifecycle.test.ts`.

For deterministic **lockstep** games (RTS-style, puzzle races), skip snapshots:
every peer runs the same `rng.ts` seed + the same fixed `loop.ts` step and
exchanges only inputs. Determinism does the rest.

### Channel budget

Trystero action (channel) names must be **≤ 12 bytes**. Keep them terse: `snap`,
`in`, `mv`, `chat`. `net.ts` throws in dev if you exceed it.

### Signaling strategy fallback

`net.ts` imports Trystero's default `nostr` strategy (public relays, no keys). If
connections are flaky, switch the import to `trystero/torrent` (BitTorrent
trackers) or `trystero/mqtt` (public brokers) — the wrapper API is identical.
Pass a `password` to `createNet` to end-to-end-encrypt a private room.

## Non-negotiables for every game

- **Single-player playable instantly.** Multiplayer is an *option* behind a room
  link — never a requirement to see the game. A dead lobby must never be a dead site.
- **Mobile + desktop.** Touch controls (via `input.ts`) and a responsive canvas
  are mandatory. Test at ~375px.
- **Offline-capable.** No CDN assets, no third-party fonts, procedural audio.
- **Respects `prefers-reduced-motion`** and is colour-blind-friendly.
- **The Cloudflare Web Analytics beacon is the only network call** the base game
  makes; multiplayer adds only the P2P signaling relay. Both are disclosed.
