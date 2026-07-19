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
  "@ben-gy/game-engine": "github:ben-gy/gh-game-engine#v1.1.0"
}
```

```ts
import { createNet } from '@ben-gy/game-engine/net';
import { createRounds } from '@ben-gy/game-engine/rematch';
```

## Wiring a multiplayer game

```ts
import { setTurnConfig, createNet, roomAppId } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds } from '@ben-gy/game-engine/rematch';

// ONCE at boot, before ANY mesh is created — see the warning below.
setTurnConfig(await getTurnConfig());

const net = createNet(
  { appId: roomAppId('my-game'), roomId: code, claimHost: iMintedTheCode },
  { onHostChange: (id, isSelf) => repaint() },
);

const rounds = createRounds({
  net,
  playerName,
  minPlayers: 2,
  onRound: ({ seed, players, seated, opts }) => {
    if (!seated) return renderSpectator();   // the round started without us
    startGame(seed, players, opts);
  },
});
```

> **`setTurnConfig()` must run before the first mesh on the page.** Trystero
> pre-builds one global pool of 20 connections from the config of the *first*
> `joinRoom`, and every later room draws its outbound offers from that pool. Open
> a turnless `__presence` or `__board` mesh first and the game room's initiating
> half is STUN-only — TURN silently working in one direction only, for roughly
> half of all pairs. `getTurnConfig()` is session-cached and fails open, so this
> costs one request and can never block a join.

Never pass a raw slug as `appId`; `roomAppId()` stamps the wire revision so a
player on a cached old build partitions cleanly instead of half-connecting.

Ships raw TypeScript — every consumer is Vite + TS, so the source compiles in the
consumer and there is no build step to drift. The only runtime dependency is
`trystero` (pinned exact; upgraded deliberately via engine releases).

> **v1.1.0** hardens the netcode against three field failures: peers never
> appearing in a room (no TURN + flaky public relays), a joiner stealing host
> from a live incumbent, and players "ejected" when a round starts. See
> [CHANGELOG.md](./CHANGELOG.md).

## Modules

| Module | What it gives you | When to use |
|------|-------------------|--------------|
| `net.ts` | Zero-backend P2P mesh (Trystero/WebRTC). Peer roster, **epoch-based host election**, typed channels with fan-out, latency ping, `netDiag()`, and a join registry that makes the leave/rejoin trap throw. | Every multiplayer game. |
| `rematch.ts` | Multi-round sessions inside ONE living room: ready/play-again votes, quorum + auto-start on a **settled roster**, monotonic round numbers, a host-frozen roster so player indices match on every peer, **start re-broadcast + ack retries**, and a `seated` flag. | Every multiplayer game. |
| `turn.ts` | `getTurnConfig()` — short-lived TURN credentials from the shared infra Worker, session-cached, **fail-open**. Rescues CGNAT/mobile and locked-down networks. | Every multiplayer game. |
| `lobby.ts` | Drop-in lobby **view** over `rematch.ts`: room code, invite link + Web Share, player roster, ready states, host-only Start, connecting spinner, the *"Host this room"* offer, the unseated *"round in progress"* state, and the `?netdebug=1` overlay. | Every multiplayer game. |
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

Every entry is a subpath export: `@ben-gy/game-engine/net`, `/rematch`, `/turn`, …

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

**Host-authoritative star** is the default and fits almost every casual game:

1. Everyone joins the same Trystero room (`appId` = `roomAppId(slug)`, `roomId` =
   the shareable room code). Trystero does the WebRTC handshake over public Nostr
   relays, with TURN from `getTurnConfig()` for pairs that cannot form a direct
   path — **no per-game server**, which is exactly what GitHub Pages needs.
2. The host is decided by **incumbency with terms**, NOT by an election on every
   join. The full model is below; the one-line version is: *the host announces,
   everyone else adopts, and the role moves only when the host leaves.*
3. The **host owns authoritative state**, advances the simulation, and broadcasts
   snapshots on a channel (e.g. `'snap'`). **Clients send inputs** to the host
   (e.g. `'in'`) and render the snapshots they receive (interpolating with
   `loop.ts`'s `alpha`).
4. Shared randomness comes from a **seed the host broadcasts at start**
   (`rematch.ts` does this, alongside the frozen roster) fed into `rng.ts`, so no
   random outcome ever needs syncing.

### How the host is decided (and why not min-id)

Announcements carry a **term**: `{ host, epoch }`.

- **The host announces every 2s; everyone else adopts.** A peer that has heard
  nothing is `unsettled` — `isHost()` is false and `host()` is null — so nobody
  acts as host on a mesh that has not formed.
- **A higher epoch always wins.** Equal epoch falls back to min-id (both sides
  compute the same winner). A lower epoch is ignored, and an incumbent that
  receives one unicasts a correction so the stale claimant capitulates at once.
- **A peer never self-elects while alone.** Silence on a roster of one is
  evidence of no mesh, not of an empty room. It stays unsettled and the lobby
  says "connecting", then offers an explicit *"Host this room"* after 15s.
- **The only automatic transfer is the host leaving.** Survivors all run the same
  min-id election and adopt at `epoch + 1`.

> **The retired model — "host = smallest peer id, re-elected on every join" — is
> gone. Do not reintroduce it.** It handed a live room to whoever arrived next if
> their id happened to sort lower: a coin flip on every join, with the new host
> holding none of the game state. Plain incumbency alone was not enough either,
> because a joiner that timed out at 2.5s elected *itself* on an empty roster and
> then won the min-id tie-break against the real host. Terms are what let two
> sincere claimants be ranked.

### Rounds start on a settled roster

`rematch.ts` will not auto-start within `ROSTER_SETTLE_MS` (4s) of a roster
change, because a host that freezes the roster mid-handshake freezes out whoever
was one connection behind. The host also re-broadcasts the current start to any
peer that connects mid-round, and retries it up to 5 times for anyone who does
not acknowledge — Trystero only delivers to channels that are *already* open, so
without this a peer whose channel opened a second late never learns the round
began. `RoundInfo.seated` tells a peer whether it is actually in the frozen
roster; when it is false, render a spectator view, not a dead screen.

### Diagnosing a broken room

Append `?netdebug=1` to any game URL for an overlay showing self/host/epoch/
settled, peer list, whether TURN is active, and per-relay socket state. That
turns "it didn't connect" into a specific, actionable fact. `net.netDiag()`
returns the same data programmatically.

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
