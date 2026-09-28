# Proxying a real bzfs server -- what is left

What bzo does *not* yet do for a browser on a real BZFlag server.
`docs/proxy.md` is what it does, which now includes playing: picking a team,
spawning, driving, shooting and handling flags on the target, as well as
watching. This is the rest of issue #82, and it is kept current with the code,
so anything built is deleted from here rather than marked done. Decisions are
kept, because the reasoning outlives the diff.

The largest thing left is **dying**, which is also the only place the client
gains semantics of its own; the largest thing left that a player would *notice*
is that there is no way to reach a proxy from inside a running game. Upstream
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

## Authority, and what it actually cost

bzo is server-authoritative. The client sends inputs; the server simulates
shots, decides hits and runs one `applyDeath`. bzfs is client-authoritative for
exactly these things: the victim decides it died and says so
(`playing.cxx:3967`), the shooter declares shot begin and end, the client
declares flag grabs and teleports. bzfs relays and scores; it does not
adjudicate geometry, which is why it has no `positionCorrection`.

The fear here was that the client would acquire a second set of semantics and
every gameplay feature after it would have to work both ways. **That did not
happen, and it is worth saying why**, because it changes the price of what is
left. bzo's own client already speaks in the messages upstream declares: it
names the flag index it drove over, the base team it capped on, the shot it
fired, where its tank is. Those were being *dropped* by the proxy rather than
missing. Turning them on took a handler each and no new client semantics at
all. Only four small things in the client know they are proxied: the team on
the socket URL, the team staged from `init`, the hidden tank selector, and the
team carried through login -- none of them gameplay.

What genuinely needs the client to conclude something it has never concluded
is **death**. The rest of this section is about that, and it is the reason the
estimate for it should not be read down from how cheaply the others landed.

**The target's numbers are the target's.** Anything read for arithmetic comes
off its own BZDB, which arrives as *expressions* rather than numbers --
`_reloadTime` is `_shotRange / _shotSpeed`, `_muzzleFront` is
`_tankRadius + 0.1` -- so it is evaluated (`evalBzdb`), never parsed as a float
and never handed to `eval`, since the values come from a machine this one does
not own. `shotFired` drops a shot whose lifetime misses the target's own
`_reloadTime` by more than an epsilon and says nothing, so a parsed `NaN` would
have been a shot that silently never happened.

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

## Respawn, and the rejoin cooldown

bzo respawns automatically: `applyDeath` queues `victim.respawn()` on a
`setTimeout` of `GAME_CONFIG.RESPAWN_DELAY` and broadcasts `alive`.
The client never asks, and there is no message for asking.

Upstream leaves the player dead until they act. On death bzfs sets
`setSpawnDelay(_explodeTime)` (`bzfs.cxx:3371`); the client's `restart` command
sends `MsgAlive` (`clientCommands.cxx:379`, `ServerLink.cxx:816`), guarded by
not-game-over, not-observer, not-alive and not-exploding; bzfs then queues the
spawn honoring the delay and its spawn policy.

The `alive` message exists now -- a proxied join asks for its spawn, because
where a tank starts is the target's to decide and bzo's own server spawns a
player as part of the join. What is still missing is the **dead-and-waiting
state** to sit in with a prompt, and it cannot be built before there is a way
to die. The state is not from nothing -- the roam camera already knows how to
sit somewhere and look around.

Separately there is a real cooldown, but it is for re-entering the *server*,
not for dying. `RejoinList` adds a player on part if they had ever spawned
(`bzfs.cxx:2943`) and refuses `MsgAlive` for `_rejoinTime` seconds
(`bzfs.cxx:4851`), which defaults to `_explodeTime` and is locked
(`global.cxx:126`). It exists to stop quitting to dodge a shot.

**That collides with bzo's auto-reconnect.** A browser that drops its WebSocket
and comes back is, if the proxy re-enters, a fresh `MsgEnter` straight into the
rejoin list -- so a mobile network blip is indistinguishable from quit-dodging
and benches the player through no fault of their own. The proxy must hold the
bzfs connection open across a browser reconnect, keyed on the session, rather
than tearing it down and re-entering. This is a design constraint, not a
refinement.

## A way in that is not a link

A `?proxy=` link is the way in today (`docs/proxy.md`), and it is the only
one. Two more, both of them the ones Map Viewer already has, because a proxy
is the same thing seen from further away: the same client, pointed somewhere
else.

- **One destination selector in the entry dialog**, `local | proxy... | map...`
  with local first, fed by a `proxies` list on `init` the way `viewableMaps`
  already feeds the Map Viewer one. It is the way in for a player who has
  never been handed a link -- from inside a running local game there is no
  path to a proxy at all today.
- **A row on `/list`**, which is the section below.

### How the selector behaves

- **Every destination change is one navigation.** Local clears the query,
  a proxy sets `?proxy=<key>` and its team, a map sets `?viewmap=<file>`;
  `viewMapFile` folds into the same call rather than sending its own
  `joinGame`. The target has to be fixed before the socket opens, because
  `init` is synthesized from it, so the expensive case exists regardless --
  making the cheap one match removes the branch instead of adding one.
- **The URL is the only truth about where you are.** Everything stages from
  it on load, so there is no in-session destination state to disagree with the
  connection. That disagreement is a real bug class, not a hypothetical: it
  cost us a login round trip that silently dropped the team, and a
  press-OK-and-bounce loop that needed a guard.
- **A reload is affordable here**, which is what makes the above tolerable.
  The transcript survives it -- `chat-cache.mjs` writes to `sessionStorage`
  precisely because "bzo's process is the tab" -- the world is hash-named and
  `immutable`, and what is left is the join round trip.
- **Browsing maps stays free.** The dialog already stages selections and
  applies them on OK, so cycling the list previews in-session and only the
  commit navigates. A preview is a render, not a destination.
- **Map Viewer stops being a team.** It is a client-only sentinel that
  `getJoinTeamFields` rewrites to `observer` before it reaches any wire;
  moving it into this selector retires the fake team.
- **The team selector's contents follow the destination** -- the local map's
  teams, the target's own, or observer for a map preview. That dependency
  exists today and is hidden by Map Viewer living inside the team list.
- **Reachable targets only**, the way the `/list` rows already filter on
  `proxy.reachable === true`. Shown when there is more than one destination to
  choose between, which is the rule `getDialogTeamSelections` already applies
  to Map Viewer -- "always more than one" does not hold, since a proxy-only
  instance has no local entry.

### OK and Login

On a proxy, a playing team needs a token that no live connection can be
holding: a token is single use and spent at `MsgEnter`, so **any** new proxy
connection needs a fresh one. That makes the rule local to the client with no
token state to track -- destination is a proxy and team is not observer, so OK
greys and **Login** is the enabled action beside it, carrying both.

Greying OK is right here only because there is an enabled alternative in
reach. The rejected alternative -- offering observer alone until signed in --
reads tidier and is worse: it removes the only way to stage the team the login
then carries.

**Login stays enabled on observer too, and is worth using.** A verified
observer arrives under their registered callsign rather than `bzo-view-N`,
carries the `@`/`+` the scoreboard draws, and holds whatever their BZID has in
the target's own groupdb -- operator commands already work, since chat goes
straight out including lines starting with `/`. Remote observer-admin is a use
for this, not a side effect, which is why `MsgAdminInfo` is on the list below.

**Several targets on one instance is the ordinary case, not the exotic one.**
A host running four `bzfs` on four local ports publishes one bzo and four
keys: `?proxy=example.org_5154`, `_5155`, `_5156`, `_5157`. Nothing about that
needs multi-world (below) -- the worlds are the targets', fetched and hashed
separately, and bzo hosts no game of its own.

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

Voice never touches the bzfs protocol. Browsers connect to bzo, the proxy owns
the roster and the signalling, and the media is peer to peer between browsers.
Nothing to translate and no new messages -- it is the one feature a proxy makes
no harder.

It is also not new. Players already use a separate voice app or sit in the same
room; bzo's voice is a convenience, not a capability the game lacked.

**Observers talking to each other already works.** `voice-channels.cjs` treats
Observer as a team, matching upstream's team message dispatch, and observers
report a position (`applyObserverHeartbeat`), so all three channels work for
them. A commentary channel players cannot hear is Team while on Observer.

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

## Risks

- **Shared address.** Every proxied player comes from the proxy's private
  address, so the target sees one host running many clients -- which is also
  what a cheat proxy looks like. It sees a host on its own network, though,
  which is unmistakably something its operator installed, and the global
  login every proxied player carries is what keeps them answerable.
- **Cheating, answered by accountability rather than by enforcement.** A proxy
  hands anyone a BZFlag client they can modify in devtools, and bzo's
  anti-cheat does not run in proxy mode. BZFlag's client is open source too,
  but editing JavaScript and recompiling C++ are not the same bar. Nothing on
  this side can close that, so the decision taken instead is that **playing
  requires a global login**: a connection without a token watches, whatever
  team its link asked for, and is told why.

  bzfs would admit an unregistered player itself, so this is the proxy's
  courtesy rather than the target's rule. What it buys the operator is that
  every proxied *player* is answerable by a BZID -- `/idban` reaches one of
  them where `/ban` would reach all of them, which is a stronger guarantee
  than a native client gives. An operator who disagrees edits their own bzo:
  it is a default, not a boundary, and saying so is more honest than
  pretending the client can be trusted.

  It also happens to be the only correct answer for a registered callsign,
  which cannot spawn without a token at all (`playerAlive`, bzfs.cxx:3199) --
  a bzo restart lands there, since the session outlives it and the single-use
  token held in memory does not.
- **Latency.** The proxy adds its own hop to bzfs's, and the token constraint
  pins it inside the target's network, so that hop is sub-millisecond and the
  player's total is browser-to-proxy -- the same order as a native client
  reaching a distant server. "Worst of both" describes a deployment the token
  check will not authenticate; see `docs/proxy.md`, "A proxy runs inside its
  target's network".

## Order of work

The list server comes last. It is discovery for something that has to work
first, it needs both ends of a bzo pair updated before a row appears, and
every step before it is cheaper against one hardcoded loopback target than
against a registry.

1. **The destination selector**, above. It is the only remaining way for a
   player already in a game to reach a proxy at all, so it comes before more
   of what a proxied player can do once there. `init` grows its `proxies`
   list first; everything else in that section hangs off it.

2. **Death.** The one conclusion the client has never had to reach, and the
   only place it gains semantics of its own. Its shape is settled in "Every
   way a proxied tank dies" above; what is not settled is the hit test, which
   lives in `server.js` rather than in the shared `collision.mjs` and tests
   every tank rather than only your own -- upstream never has that to decide,
   because each client tests one tank by construction.

   The **rejoin cooldown** and **holding the bzfs connection across a browser
   reconnect** belong with it: both are about a player who leaves and comes
   back, which only matters once leaving can happen by dying.

3. **The senders still missing.** `MsgGMUpdate`, so a guided missile tracks
   for the people it is chasing -- unhandled inbound too, so a native's
   missile does not track here either. `MsgTeleport`, for the effect at both
   ends. `MsgExit`, to announce leaving rather than dropping the socket. And
   `MsgAdminInfo` inbound, which carries the addresses `sendIPUpdate` sends to
   anyone holding `playerList` (`bzfs.cxx:619`) -- only of use to a *proxied
   operator*, since a watcher holds no permissions at all.

   **`MsgShotEnd` is not among them: it belongs with death.** It is not what
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
   shot. Which is why this cannot be built before death is.

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
