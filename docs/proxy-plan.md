# Proxying a real bzfs server -- what is left

Only what bzo does *not* yet do for a browser on a real BZFlag server.
`docs/proxy.md` is what it does, and anything built is deleted from here
rather than marked done -- a plan that describes working code is a second
place for it to go stale. Decisions are kept only where the reasoning still
constrains what is left to build.

This is the rest of issue #82. The largest piece is **dying**. Upstream
references are paths under `$HOME/bzflag/`.

## An instance that proxies rather than hosts

Today a bzo both hosts its own game and proxies a target. The instance worth
building is one that does only the second: configured with servers rather than
a map, offering several at once -- the bzo on `bz.rikers.org` carrying the
bzfs on `bz.rikers.org:5154` over `127.0.0.1:5154`, a second test bzfs on
another loopback port, and a third on `192.168.12.x`, each listed and joined
separately. Hosting a game *and* proxying others needs a per-player world,
config, roster and clock, and buys nothing this does not.

Several targets cost little because a proxy holds no game state to partition.
The globals a second local map would force into a `Game` object (below) are
exactly the ones proxy mode deletes: no obstacles, no teleporter graph, no
zones, no world weapons, no bases, no clock, because none of it is simulated
for a proxied connection. What is per-target is a world to serve and a
connection to dial, and both of those already work.

## What death costs that the rest did not

bzo is server-authoritative: the client sends inputs and the server decides.
bzfs is the other way round for exactly the things left -- the victim decides
it died and says so (`playing.cxx:3967`).

Position, shots and flags turned out to cost almost nothing, because bzo's
client already spoke in the messages upstream declares and the proxy was
dropping them. **Death is not like that.** It is the one conclusion the
client has never had to reach, so the estimate for it should not be read down
from how cheaply the others landed.

## Every way a proxied tank dies

Six of them, and the client owns all six. `gotBlowedUp` sends `MsgKilled` for
exactly `GotShot`, `GotRunOver`, `GenocideEffect`, `SelfDestruct`,
`WaterDeath` and `DeathTouch` (`playing.cxx:3963-3967`); the other two reasons
it knows are the ones it must stay quiet about. `GotKilledMsg` is bzfs telling
the client, so echoing it would be a loop, and `GotCaptured` is the target's
own conclusion from `MsgCaptureFlag` -- a capture kills the team at bzfs.

bzo decides five of the six server-side today and the client sends only the
sixth. `killPlayer` is called with `PHYSICS_DRIVER` and `WATER` from the
motion step (`server.js`), `RUN_OVER` from the roller check and `GENOCIDE`
from the shot code, and hits come out of the shot simulation; `selfDestruct`
is the single client to server death message that exists. So the client
already carries the geometry for all of it -- `collision.mjs` is the shared
file, and it runs the same physics-driver and water tests for prediction --
and none of the callers.

Three details that bite:

- **The outbound message is not the inbound one.** What a client sends is
  killer, reason, shot id and the *killer's* flag, with the physics driver
  appended only for `DeathTouch` (`ServerLink.cxx:757-774`). There is no
  victim field -- bzfs takes the victim from the connection -- so
  `decodeKilled`'s layout is the broadcast's and not a template for a sender.
- **A wrong one is a kick, not a shrug.** `invalidPlayerAction(..., "die")`
  removes the player outright for a death claimed as an observer or before
  first spawn (`bzfs.cxx:4352-4374`, `4874`). Paused is the one exception, so
  that self destruct works. A mode flag that leaks one `killed` from a
  watching browser ejects it from the match.
- **The flag drops first.** `gotBlowedUp` sends `MsgDropFlag` at the victim's
  position before the kill (`playing.cxx:3898`), so the order on the wire is
  drop then killed, not killed alone.

## A dead-and-waiting state, and the rejoin cooldown

Upstream leaves a dead player dead until they act. On death bzfs sets
`setSpawnDelay(_explodeTime)` (`bzfs.cxx:3371`); the client's `restart`
command sends `MsgAlive` (`clientCommands.cxx:379`), guarded by not-game-over,
not-observer, not-alive and not-exploding. bzo instead respawns on a timer and
never asks.

So a proxied player needs somewhere to sit between dying and asking again,
with a prompt. It cannot be built before there is a way to die, and it is not
from nothing: the roam camera already knows how to sit somewhere and look
around.

Separately there is a real cooldown, and it is for re-entering the *server*
rather than for dying. `RejoinList` adds a player on part if they had ever
spawned (`bzfs.cxx:2943`) and refuses `MsgAlive` for `_rejoinTime` seconds
(`bzfs.cxx:4851`), which defaults to `_explodeTime` and is locked
(`global.cxx:126`). It exists to stop quitting to dodge a shot.

**That collides with bzo's auto-reconnect.** A browser that drops its
WebSocket and comes back is, if the proxy re-enters, a fresh `MsgEnter`
straight into the rejoin list -- so a mobile network blip is
indistinguishable from quit-dodging and benches the player through no fault
of their own. The proxy must hold the bzfs connection open across a browser
reconnect, keyed on the session, rather than tearing it down and re-entering.
A design constraint, not a refinement.

## A row on the list server

The entry dialog's destination selector is built (`docs/proxy.md`). The other
way in is not: a proxied target as a row on `/list`, so a player who has never
seen one instance's dialog can still find it. That is the list server's own
work and is planned in `docs/list-server-plan.md`; it is last here for the
reason given there.

## A proxy-only instance

Proxy mode already deletes server-side game state, so an instance with
`proxies` set and no `mapFile` would have no map, no tick and no anti-cheat to
configure -- but bzo still requires a map and still runs a game loop, so that
install does not exist yet. It is the distribution story for #82: a bzfs
operator installs bzo beside the servers they already run, adds an entry per
server, points `listServerUrl` at the designated instance and registers one
key. bzo spreads as an add-on to bzfs servers rather than needing anyone to
run a bzo game.

## Voice

**Nothing of it is wired on a proxied connection.** The proxy accepts ten
message types and drops the rest, so no signalling reaches it -- and an
observer's `m`, which is where bzo learns a watcher is standing, is dropped
too, so Nearby has no distance to work from.

None of that is protocol work. Voice never touches the bzfs wire: browsers
connect to bzo, the proxy owns the roster and the signalling, and the media is
peer to peer between browsers. Nothing to translate and no new messages.

**"All" is a half-truth on a proxy.** It reaches every bzo client on this
proxy, not every player in the match, because native clients have no voice --
so voice All and chat All stop meaning the same set. Fix the label, not the
meaning: changing what a channel *means* per mode is worse than changing what
it *says*.

**Nearby is the one to show people.** The proxy forwards everyone's positions
anyway, native clients included, so distance is known for all of them. Two bzo
users on Nearby get spatialized voice inside a real BZFlag match, which no
BZFlag client has had; for two observers roaming the same match it also means
"we are looking at the same corner of the map."

**Scoping is what actually needs building**, and an instance offering more than
one target needs it from the start -- it is the one piece several targets
genuinely force. A channel belongs to a target, not to an instance:
`areVoicePeers` already has two symmetric preconditions -- same channel, then
the channel's own rule -- and same-target becomes a third, with `getVoicePeers`
filtering the roster by target first. Voice is what forces the question first,
because All's hint is a literal promise ("Every player on the server, however
far away") that becomes false the moment one instance carries two matches.
Chat needs the same cut, and gets it for free: it all goes to bzfs and comes
back down the connection it belongs to.

Cross-game voice is deliberately out of scope. It breaks "voice comes from
where the speaker is standing" -- no shared space, so it has nowhere to come
from and would have to be flat. If it is ever wanted it is a fourth, explicitly
non-spatial channel, additive rather than a change to the three.

## Multi-world is a fork, not a next step

Proxy mode makes per-player game state *unnecessary*, so several proxied
targets on one instance are not multi-world and bring nothing toward hosting
several local maps at once. The two designs pull apart:

- **Proxy mode** -- delete server-side game state, and several targets follow
  for the price of a lookup and a world hash. The cheapest path to issue #82.
- **Multi-world** -- every piece of game state becomes a member of a `Game`,
  and one kind of `Game` is a proxy. Both features fall out, plus one host
  running several local maps.

Multi-world concretely means moving most of `server.js`'s top-level mutable
state (`OBSTACLES`, `TELEPORTER_GRAPH`, `MAP_ZONES`, `WORLD_WEAPONS`,
`BASES_BY_TEAM`, `matchClock`, `rabbitPlayerId`, `worldTime` and the rest) plus
`players`, `projectiles`, `flags` and `GAME_CONFIG` into an object, and turning
every `broadcastAll` into `game.broadcast`. That part is large but mechanical.
The parts that are not: one tick per game against one tick over games, chat
scoping, proximity voice across worlds, what the list server advertises, which
game the operator panel's `/countdown` reaches, and the join dialog becoming a
game browser. High regression surface across a server written against those
globals, for a payoff -- one host, two maps -- that nothing is currently
asking for.

## Order of work

The list server comes last. It is discovery for something that has to work
first, it needs both ends of a bzo pair updated before a row appears, and
every step before it is cheaper against one hardcoded loopback target than
against a registry.

1. **Death.** The one conclusion the client has never had to reach. Its shape
   is settled in "Every way a proxied tank dies" above; what is not settled is
   the hit test, which lives in `server.js` rather than in the shared
   `collision.mjs` and tests every tank rather than only your own -- upstream
   never has that to decide, because each client tests one tank by
   construction.

   **`MsgShotEnd` belongs here, not with the senders below.** It is not what
   stops a shot at a wall -- each client traces and expires its own copy, and
   no message says so. Upstream sends it from two places only
   (`playing.cxx:4169`, `GuidedMissleStrategy.cxx:464`): the victim ending
   *the shot that hit them* -- `hit->getPlayer()`, somebody else's shot id --
   so it cannot hit again after a shield drops, and a guided missile ending.

   The anti-cheat shows the same shape. `endShotCredit` rises on every
   `MsgShotEnd` and falls only when the sender **dies** (`bzfs.cxx:4899`) or
   fires a GM, and above `_endShotDetection` (default 2) the player is kicked.
   So ends and deaths are paired by construction, and sending ends without the
   `MsgKilled` that pays for them would disconnect the player on the third
   shot.

   The **rejoin cooldown** and **holding the bzfs connection across a browser
   reconnect** belong with it: both are about a player who leaves and comes
   back, which only matters once leaving can happen by dying.

2. **Voice**, above. No protocol work, and the largest thing a proxied player
   is missing that has nothing to do with dying.

3. **The senders still missing.** `MsgTeleport`, for the effect at both ends.
   `MsgExit`, to announce leaving rather than dropping the socket.

   Untested rather than missing: shot slots cycle up to the target's
   `maxShots` without enforcing reload timing, so `addShot` may refuse one
   reused too soon.

4. **Pause, if the countdown is worth converging.** Upstream's *client* owns
   it -- five seconds, cancellable, refused in a building or in the air
   (`clientCommands.cxx:451`, `playing.cxx:6872`) -- where bzo's *server*
   does, as `pause.mjs` says outright. A proxied pause therefore takes effect
   at once, with no countdown and no location checks, because no bzo game is
   in the loop to run them. Converging means moving the clock to the client,
   which is upstream's shape and collapses this to one path; bzo's server
   keeps validating by elapsed time, the way it already validates a sticky
   flag's shake timeout.

5. **Multi-world only if something wants two local maps on one host** -- never
   a prerequisite for any of the above, since several proxied targets are not
   multi-world.
