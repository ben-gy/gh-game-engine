# Changelog

## v1.1.0 — netcode reliability

Closes the three field failures traced in the multiplayer engine handoff. **Wire
protocol is now rev 2** (`roomAppId(slug)` → `"<slug>@2"`), so players on cached
old builds partition cleanly instead of half-connecting.

### Peers never appearing in a room

- **TURN support.** `NetConfig.turnConfig`, `rtcConfig`, `relayUrls` and
  `relayRedundancy` pass through to Trystero. Without TURN, ICE is STUN-only and
  any pair that cannot form a direct path — a phone on carrier CGNAT, a
  locked-down office or school network — never opens a data channel, so
  `onPeerJoin` never fires.
- **`setTurnConfig()` — call this once at boot, before ANY mesh.** Trystero
  allocates one global pool of 20 pre-built connections per page, from the config
  of the *first* `joinRoom`. A turnless mesh created first (`__presence` or
  `__board` on a menu, neither of which takes a `turnConfig`) leaves the game
  room's *initiating* half STUN-only — and since Trystero picks the initiator by
  peer id, that silently gives you one-directional TURN for about half of all
  pairs. Passing `turnConfig` per room is not sufficient on its own.
- **New `turn.ts`.** `getTurnConfig()` fetches short-lived credentials from the
  shared infra Worker, caches them in `sessionStorage` for half their lifetime,
  times out at 3s, and **fails open to `[]`** — a join is never blocked or
  delayed by infra. Defensively drops port-53 ICE URLs, which browsers refuse.
- **Curated `DEFAULT_RELAYS`.** Six high-uptime Nostr relays, shared by the
  fleet, so two peers are no longer at the mercy of non-overlapping live relay
  subsets. One update fixes every game.

### A joiner stealing host from a live incumbent

- **Election terms.** Announcements are `{ host, epoch }`. Higher epoch always
  wins; equal epoch falls back to min-id; a lower epoch is ignored *and*
  answered with a unicast correction so a stale claimant capitulates in one
  message. `hostEpoch()` is exposed on `Net`.
- **No self-election on an empty roster.** Silence with no peers connected is
  evidence of no mesh, not of an empty room. The peer stays unsettled instead of
  becoming a phantom host that later wins a min-id coin flip against the real
  one. This is the fix; terms are what make it safe.
- **Settle window 2.5s → 6s**, restarted on every new connection while
  unsettled, so an incumbent always gets a full window to be heard.
- **`takeover()`** — explicit, user-driven hosting for a peer that has waited
  alone, surfaced by `lobby.ts` after 15s. Never automatic.
- **Host transfer** on leave now adopts at `epoch + 1`, and cannot elect the peer
  that just left.

### Players "ejected" when a round starts

- **Roster-settle window.** `rematch.ts` will not auto-start within
  `ROSTER_SETTLE_MS` (4s) of a roster change — a host that freezes the roster
  mid-handshake freezes out whoever was one connection behind. The host's
  explicit `go()` is deliberately not gated. The grace countdown re-checks it too.
- **Start re-broadcast.** The host unicasts the current `StartMsg` to any peer
  that connects mid-round. Trystero only delivers to channels that are *already*
  open, so without this a peer whose handshake finished a second late never
  learned the round began. Every peer retains `lastStart`, so this survives
  mid-round host migration.
- **Start acks + retry ladder.** New `'rk'` channel; the host retries an unacked
  start up to 5 times at 1s intervals, and stops as soon as a peer confirms or
  leaves. A duplicate start is re-acked, in case the first ack was what was lost.
- **`RoundInfo.seated` / `RoundsState.seated`.** A peer excluded from the frozen
  roster now knows it, and `lobby.ts` renders "round in progress — you're in the
  next one" with a live ready toggle instead of a silent dead screen.

### Found by adversarial review, before shipping

A multi-agent review of the above (six independent lenses, every finding put to a
refutation pass) confirmed five defects in the first cut — three of them
room-breaking, and two present in the handoff's own reference implementation:

- **A promotion nobody else made stranded the promoter.** Trystero drops a peer
  on a *transient* `connectionState === 'disconnected'`, per connection, so a
  Wi-Fi-to-cellular handover can make one peer the only one that "saw" the host
  leave. It promoted a survivor that never learned it won, then dropped the live
  host's announces as stale — settled forever on a peer that was not hosting,
  receiving no round starts. Promotions of *other* peers are now provisional
  (rule 7): unclaimed within a settle window, we drop back to unsettled and heal.
- **Min-id pinned peers to a host nobody was hosting from.** Rosters differ
  between peers during a transfer, so a locally-elected host is a belief, not a
  fact. At equal term a real claim now beats an unclaimed local election
  (rule 6); min-id decides only between two genuine claims.
- **A promoted host that was behind deadlocked the whole room.** The `cur`
  catch-up only trusted `from === net.host()`, and a promoted host's only trusted
  peer is itself — so it sat at round 0 while everyone voted for round N+1, every
  vote dropped as stale, and no peer could ever start another round.
- **The spectator's ready button did nothing.** `vote()` bailed on
  `phase === 'playing'`, which is true for an unseated peer too, so a player
  excluded from one round was excluded from every round for the life of the
  room — the "I got ejected" failure made permanent by the code meant to fix it.
- **TURN was one-sided** (the `setTurnConfig` item above).

Each has a regression test that has been verified to fail when the fix is reverted.

### Diagnostics and hygiene

- **`netDiag()`** and the **`?netdebug=1`** overlay: self, host, epoch, settled,
  peers, TURN on/off, and per-relay socket state.
- **`net.onPeersChange(cb)`** — fan-out roster subscription, so rematch, a lobby
  and a HUD can all observe the roster without fighting over the single
  `onPeers` handler slot.
- Fire-and-forget sends no longer produce unhandled promise rejections when a
  targeted peer vanishes mid-send.
- `presence.ts` / `noticeboard.ts` document that their second mesh must never be
  created while a game room is still connecting.
- Docs: the retired "smallest peer id" model is gone from the README, and every
  module now says *import the package* rather than *copy this file*.

## v1.0.0 — extraction

Pure extraction of `gh-game-factory/patterns/` into a versioned package. Every
`src/*.ts` byte-identical to its `patterns/` original; zero behaviour change.
