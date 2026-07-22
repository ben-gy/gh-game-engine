# Changelog

## v1.3.0 — closing the six gaps that kept games on forks

Every item here existed as a logged "engine gap" that a game had already worked
around locally. A fork does not just duplicate code — it stops receiving engine
fixes, so each of these was quietly compounding. The measure of this release is
how many forked files can now be deleted, not how many features were added.

### `sound.ts` takes game patches (retires 7 forks)

`createSfx({ muted?, patches? })` merges game cues over the defaults, `SfxName`
is now `string`, and `play(name, { pitch, gain })` transposes a patch. Seven
games kept a local `sound.ts` for exactly this, and two had hand-rolled their own
pitch argument. The old positional `createSfx(muted)` still works — roughly
thirty games call it that way.

`beat` and `go` are now built in, because principle #15 makes a 3-2-1-GO
countdown mandatory and six of the forks had defined their own pair. An unknown
cue name is now silent rather than a crash: audio is juice, and a typo in a cue
name must not be able to take a game down.

### Relays: the list was half dead, and nothing could see it

Three of the six curated relays were unusable, re-measured by probing each one
three times with a deliberately unsigned event and reading the `OK` frame
(a relay answering "invalid: bad event id" was willing to take a write; one
answering "restricted:" was not; one that never answers is gone):

| relay | verdict |
|---|---|
| `relay.nostr.band` | TIMEOUT 3/3 — removed |
| `relay.snort.social` | TIMEOUT 3/3 — removed |
| `relay.damus.io` | socket error 2/3 — removed |
| `nostr.wine` | probe says open, but a field report saw a real `restricted: sign up…` on a SIGNED event — removed |

New list: `nos.lol`, `relay.primal.net`, `offchain.pub`, `nostr.mom`,
`nostr-pub.wellorder.net`, `nostr.oxtr.dev` — all write-open and answering
within ~2.3s across three runs.

Worth noting: `relay.snort.social` was itself the *recommended replacement* in
the note that prompted this work, and was already dead by the time the work
happened. Any hard-coded relay list is perishable, which is why the rest of this
section exists.

The engine now **reads what a relay does with writes**. It watches the `OK` and
`NOTICE` frames, marks a relay that answers `restricted` / `auth-required` /
`blocked` / `pow` / `rate-limited` / `payment-required` as `rejected`, and drops
it from the next room joined. A rejection for a malformed event is NOT a
demotion — that is the relay doing its job. It never demotes the last relay
standing: a thin list beats no signalling at all.

`netDiag().relayWrites` exposes this and `?netdebug=1` renders it, so a relay
that is `OPEN write:REFUSED` no longer reads as healthy. This is the failure that
made two peers on the same machine unable to find each other.

`relayWrites` is optional on `NetDiag` purely so the ~10 games that hand-roll a
`FakeNet` in their host-transfer tests keep compiling.

### `lobby.ts` survives a caller that repaints (retires the QR bug)

`createLobby` now returns `repaint()` — the in-place option a game should reach
for instead of rebuilding. And because roughly ten shipped games already rebuild
on every roster/vote change and will never be edited, view state is now
remembered per container, so a rebuild behaves like a repaint: the join QR stays
open mid-scan, and the "Host this room" offer does not reset its 15s clock every
time a peer readies up.

### `lobby.ts` has public rooms and a mode slot (retires 6 forks)

The opt-in noticeboard surface moves into the engine, verbatim from the fork that
six games shared: `BoardAccess`, `roomAd()`, `createListing()`, the browse UI,
and — the part that must not drift — the `P2P_IP_NOTE` / `BROWSE_IP_NOTE`
disclosures, which were six copies deep. Rooms stay **private by default**, the
board is joined **only** on an explicit browse, and a game that passes no `board`
grows no privacy surface at all.

`modeSlot` / `onModeMount` are first-class lobby options. The slot's HTML is part
of the paint key, so a host changing mode repaints even though the roster has not
moved.

`RoomEntryConfig.onSubmit` gains a third `isPublic` argument; existing two-arg
callbacks are unaffected.

### `drag.ts` has a stepped rail

`makeRail(el, { stepPx, axis, onStep })` converts travel along one axis into
discrete steps, sharing `makeDraggable`'s promote/tap/swipe thresholds so
tap-to-rotate and swipe-to-drop stay first-class over the same surface. Steps are
owed against a running total, so a drag out and back **nets out** instead of
ratcheting — the bug the naive per-event implementation always has.

### `rematch.ts` threads the opts type

`createRounds<O>()` carries `O` from `roundOpts()` through to `onRound()` and
`state().hostOpts`, so games stop casting. `O` defaults to `unknown`, so every
existing call site compiles untouched.

### Also

- jsdom added as a devDependency; the engine ships DOM code and had no DOM tests.
- 104 tests -> 171.

## v1.2.1 — QR toggle moved out of the invite row

**Use this, not v1.2.0.** v1.2.0 put the QR toggle inside `.lobby-invite`. That
row is `display:flex` with exactly two children in every game's stylesheet and
several pin it `flex-wrap:nowrap`, so a third button pushed the row past the
lobby card and clipped it — measured in turntide at 399px inside a 383px card,
with the toggle's label wrapping and running off the viewport.

The toggle is now its own centred element below the row, styled inline and
carrying no `.lobby-btn` class, so it cannot inherit a width meant for a row it
no longer sits in. The engine must never change the shape of markup that ~40
games' stylesheets already own.

## v1.2.0 — join by QR

> Superseded by v1.2.1 — the toggle placement clips the invite row. Do not pin
> this tag.

Getting a friend in the room took reading a code aloud or sending a link. Now
the host shows a QR and the phone in the room points at it.

- **New `qr.ts`.** `toSvg(text)` / `encodeQr(text)` — byte mode, versions 1–10,
  all four ECC levels, automatic smallest-version selection and full mask
  scoring. Returns `null` rather than throwing when text will not fit, so a
  caller always degrades to the invite link.
- **Zero dependencies, and no QR image service.** A hosted endpoint would put
  the invite link — which identifies the room — through a third party's server
  on every lobby render, breaking the no-tracking promise the catalogue makes.
  Output is inline SVG, so it is CSP-safe under `default-src 'self'` and stays
  crisp at any size.
- **`lobby.ts` gained a QR toggle** next to Invite. The panel is styled inline,
  not by a new `.lobby-*` class, so it renders correctly in the ~40 games that
  predate it without any stylesheet change. The card is always light: an
  inverted QR is not readable by most phone cameras.
- **Verified against an independent decoder.** `tests/qr.test.ts` round-trips
  every output through `jsqr` (a dev dependency; it never ships) across all ECC
  levels, lengths 1–200, and random byte content — because the failure that
  matters is "renders beautifully, does not scan". The rendered SVG was also
  rasterised in a browser and compared module-by-module against the matrix
  (1089/1089 exact).

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
