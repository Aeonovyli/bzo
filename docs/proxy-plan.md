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

## Coming back from the dead

Death itself is built (`docs/proxy.md`, "Dying is the browser's to declare"),
and so is the respawn: the proxy asks for one the moment it sees its own
player die, and bzfs holds the spawn for `_explodeTime` by itself. What is
left is the *other* wait, which is not about dying at all.

`RejoinList` adds a player on part if they had ever spawned
(`bzfs.cxx:2943`) and refuses `MsgAlive` for `_rejoinTime` seconds
(`bzfs.cxx:4851`), which defaults to `_explodeTime` and is locked
(`global.cxx:126`). It exists to stop quitting to dodge a shot.

**That collides with bzo's auto-reconnect.** A browser that drops its
WebSocket and comes back is, if the proxy re-enters, a fresh `MsgEnter`
straight into the rejoin list -- so a mobile network blip is
indistinguishable from quit-dodging and benches the player through no fault
of their own. The proxy must hold the bzfs connection open across a browser
reconnect, keyed on the session, rather than tearing it down and re-entering.

That is the same fix a reconnect needs to stay verified -- bzflag.org answers
a token once -- so the two are one piece of work rather than two.

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

1. **Holding the bzfs connection across a browser reconnect**, above. It is
   what a proxied player loses most visibly today -- a network blip costs
   verification and benches them on the rejoin list -- and death, which makes
   leaving and coming back an ordinary event, is now built.

2. **Voice**, above. No protocol work, and the largest thing a proxied player
   is missing that has nothing to do with dying.

3. **`MsgExit`**, to announce leaving rather than dropping the socket. The
   last sender missing.

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
