# Proxying a real bzfs server

What bzo supports for letting a browser watch a match on an ordinary BZFlag
server. `docs/network.md` is the wire this rests on -- what bzo says, what
bzfs says, and where the two differ -- and `docs/proxy-plan.md` is what is
still unbuilt, playing above all. Upstream references are paths under
`$HOME/bzflag/`.

## The link

`?proxy=<host:port>` points the ordinary client at a proxied server:

```
https://<this bzo>/?proxy=example.org:5154
```

The name is a key of the `proxies` map below. It is a GET parameter because
the whole value of such a link is that it can be sent to somebody, and it
names the *match* rather than the wire: which address bzo dials to reach it is
the operator's business and appears nowhere a player can see.

A target bzo does not proxy is refused on the WebSocket with one sentence, not
quietly joined to this server's own game. The page itself is the ordinary
client, served from `/` as always, which is why the parameter is a query
rather than a path: the page is one file of relative asset references, and a
`/proxy/<target>` URL resolves every one of them a directory deep.

`?view=` and `?follow=` work on a proxy link as they do anywhere
(AGENTS.md, "`?follow=leader` is the link to hand somebody who wants to
watch"), and both survive a login.

## Which servers an instance may proxy

`proxies` in `server.json`, from the name a player sees to the address bzo
dials:

```json
"proxies": {
  "example.org:5154": "127.0.0.1:5154",
  "my-test:5155":     "192.168.12.20:5155"
}
```

Both are needed because they are different addresses. The key is the
identity: for a publicized target it is exactly the `host:port` the public
BZFlag list carries -- its own `-publicaddr` -- so the bzo row and the bzflag
row read the same string and a player comparing them sees one server. It is
also what the world is filed under (`import-<host>_<port>.bzw`), so a shared
`?viewmap=` link names something another bzo could re-ask; a dial address
would not, since every proxy's is `127.0.0.1` and names nothing. A target with
no published identity -- a second loopback port, a LAN address -- has no
`-publicaddr` to borrow, so its key is whatever label the operator wants
shown, and its title and settings still come from the target itself.

The map is the allowlist, and the only thing that makes a target nameable:
`?proxy=`, `/login/<name>` and `/logout/<name>` all refuse a name that is not
a key, so a client cannot aim this instance at a host the operator did not
choose. An entry whose name or address is not `<host>:<port>` is refused at
boot and logged; an entry whose dial address is not private is kept and
warned about, since a target that is not publicized never checks a token
anyway.

The import a proxy makes is authorized by this map rather than by the public
BZFlag list: the name comes from the key, the address from the value, and the
permission from the config. Map Viewer's own `?viewmap=` import is unchanged
and still refuses a host the public list does not carry -- that address comes
from a client, and the check is what stands between it and an arbitrary
outbound connection.

## A proxy runs inside its target's network

**Not a preference -- the only deployment where a forwarded login works.**
bzfs does not check a token itself. It hands it to the list server along with
the address it saw on the player's connection, and my.bzflag.org compares that
with the address the token was issued to -- the browser's. A proxy breaks that
comparison by construction.

`isPrivate()` is the way through (`Address.cxx:121`): 127.0.0.0/8, 10.0.0.0/8,
172.16.0.0/12 and 192.168.0.0/16, hardcoded. For a peer on one of those, bzfs
omits the address from its question entirely (`ListServerConnection.cxx:413`)
and the list server checks the token with no address at all. Confirmed against
a real server: an unmodified bzfs answers "Global login approved!" to a token
forwarded from `127.0.0.1`.

Three consequences, and they are the shape of the feature rather than details:

- Same host is `127.0.0.1:5154`; same LAN or a VPN peer is a 10/8 or
  192.168/16 address. Same datacenter is not enough when both machines carry
  public addresses -- what counts is the peer address bzfs sees on `accept()`.
  Dialling the target's *public* name from the same host fails too, since the
  kernel picks a public source address for a public destination: the private
  address has to be configured, not resolved.
- **Only a server whose own operator installs the proxy can be proxied.** A
  stranger's public bzfs cannot carry a forwarded token in the first place --
  a far stronger consent property than a ban list, and it needs no
  coordination.
- The added hop is sub-millisecond by construction, so a proxied player's
  latency is browser-to-proxy, the same order as a native client reaching a
  distant server.

Where the check fails it is not a kick. The player loses their global identity
and plays unverified, which on a registered callsign also earns bzfs's "This
callsign is registered. You must use global authentication."

## What a target operator sees

Every proxied player arrives from the same private address, so a target
operator cannot tell them apart by address at all: `/kick` and `/mute` are
per-`PlayerId` and still reach one player, but `/ban` reaches all of them or
none. `/idban`, `/idunban` and `/idbanlist` (`BanCommands.cxx:209-213`) ban by
BZID and survive a callsign change, which is the per-player lever -- and it
works precisely because a co-located proxy is where a forwarded token
verifies. A proxy that admitted only verified players would therefore make
every one of them individually accountable, which is a stronger guarantee than
a native client gives, since bzfs otherwise admits unregistered players.

`MsgEnter` carries a client version string (`getAppVersion()`,
`ServerLink.cxx:690`), and a proxy puts its own there, so who arrived by bzo
is visible without anybody inventing a mechanism. The motto beside the
callsign says which bzo they came through.

## What a proxy connection is

**Not a player in this server's game.** A proxied socket is never in
`players`, so nothing here simulates for it, broadcasts to it or scores it.
bzo stops being a game server for that connection and becomes a codec: no shot
simulation, no hit detection, no flag logic, no scores, no clock, no rabbit,
no anti-cheat. Each browser gets its own `BzfsSession`
(`server/bzfs-session.cjs`) and therefore its own connection to the target,
because bzfs allots a `PlayerId` per connection and has no multiplexing.

**Ids are the target's.** bzo numbers players out of upstream's own space
(`docs/network.md`, "Player ids"), so the slot the target calls 3 is the slot
bzo calls 3 -- no table, no translation, and an id-taking command names the
same player on both.

**The world is the target's, through the existing importer.** It is the same
`import-<host>_<port>.bzw` cache and the same hashed delivery Map Viewer
serves, so a target imported within the hour costs a second viewer nothing.

**The callsign is never the client's to choose.** In order: the one the
weblogin callback named, for a browser that has just signed in; then the
session's, which is that same name on every connection after the first; then
a numbered `bzo-view-N` for a browser that has never signed in. The motto the
target's player list shows is `via https://<this bzo>`, which is the one thing
the operator on the other end cannot work out for themselves.

## What crosses

The connection is held open, and `init` is synthesized from what bzfs tells a
joining player -- the roster, the team scores, the flags, the clock, the
server's own greeting -- rather than from anything bzo holds.

| From the target | To the browser |
|---|---|
| `MsgAddPlayer` / `MsgRemovePlayer` | `playerJoined` / `playerLeft` |
| `MsgPlayerUpdate`, `MsgPlayerUpdateSmall` | `pmBatch`, one batch per 20Hz tick |
| `MsgAlive` / `MsgKilled` / `MsgPause` | `alive` / `killed` / `playerPaused` |
| `MsgFlagUpdate` / `MsgGrabFlag` / `MsgDropFlag` / `MsgTransferFlag` / `MsgCaptureFlag` | the same names bzo already uses |
| `MsgShotBegin` / `MsgShotEnd` | `shotBegin` / `shotEnd` |
| `MsgScore` | `playerUpdated` -- bzo carries scores on the record |
| `MsgPlayerInfo` | the `-`, `+` and `@` beside a callsign |
| `MsgTeamUpdate` / `MsgTimeUpdate` / `MsgNewRabbit` | `teamUpdate` / `timeUpdate` / `newRabbit` |
| `MsgMessage` | `message` |
| `MsgLagPing` | answered, not forwarded |

The browser sends only chat. Everything else a client can say is about
playing, and is dropped rather than answered.

**Chat out is converted to ASCII.** bzfs reads a message a byte at a time and
asks `TextUtils::isVisible` of each (`isSpamOrGarbage`, `bzfs.cxx:4474`),
whose character classes stop at 126 -- so a single accent is enough to be
kicked for "a garbage message". A native client never meets this because its
own text input cannot produce one; a browser can type anything. So accents are
folded to their letters (`está` leaves as `esta`) and anything with no ASCII
spelling is dropped, and the player is told once per connection rather than
disconnected. bzo's own chat is untouched by this: it is JSON over a
WebSocket, and it carries whatever you type.

## The two conversions

**Coordinates.** bzfs is right-handed with +Y north and +Z up; bzo is
three.js's, -Z north and +Y up. `x` is `x`, `y` is bzfs's `z`, `z` is minus
bzfs's `y` -- the same change the world importer makes as it reads a `.bzw`
(`docs/bzw.md`, "Coordinates"). A heading is a quarter turn apart: bzfs
measures counter-clockwise from +X, and a bzo rotation is a three.js rotation
about Y whose zero faces -Z.

**Inputs, not velocities.** bzfs sends the velocity a tank has; bzo's `fs` and
`rs` are the *inputs* a client would have held, as a fraction of the tank's
top speed and turn rate, because that is what the receiving client
dead-reckons with between updates. So the fraction is recovered against the
very numbers that client will multiply back by: this server's config with the
target's own map laid over it, which is where the target's `-set` lines
already are.

## Where one end is silent

Upstream expects every client to simulate a shot for itself, so it says less
than bzo's client needs to hear, and the proxy keeps the clock for it.

- **A shot that runs out of life ends with no message at all.** Every upstream
  client stops drawing it when its `lifetime` is up, where bzo's client
  removes a projectile only when the server ends it. The proxy sends the
  ending itself, at the shot's own lifetime or the world's edge, whichever
  comes first, and sends it as reason 1 -- both wires spend that byte the same
  way, `0` meaning "show the explosion", so a shock wave fades rather than
  going off.
- **A liveness change is not in a position update.** A `pmBatch` says where a
  tank is and not whether it is in the game, so a tank already alive when a
  connection opened -- one whose `MsgAlive` nobody here was present for --
  would stay dead on the roster, and the roaming views follow only living
  tanks. A change of state sends a roster update.
- **A flag's owner is stale on the wire.** bzfs leaves the packed owner where
  the last carrier left it, so carried is read off the *status*, as upstream's
  own client reads it. The same test decides which superflags are
  unidentified: bzfs masks those as Phantom Zone for everybody, admin or not,
  and bzo shows them as unidentified exactly as it does its own. What names
  them is `/flag show`, whose reply is text and nothing else on both servers
  -- and the client reads that text either way, so a proxied operator's map
  fills in like anyone else's.

## Transport

The proxy terminates one WebSocket and dials both of bzfs's transports: TCP,
and a UDP link on the same port opened by sending `MsgUDPLinkRequest` from the
socket that will receive on it. The link is up before the join finishes, not
because watching needs it but because a good client has one -- bzfs
disconnects any non-bot player who fires over TCP (`bzfs.cxx:5596`), and the
bulk messages are the ones that ride it. Co-location is what makes it cheap:
over loopback there is neither the loss nor the head-of-line blocking UDP
exists to dodge.

Lag pings are answered rather than forwarded. bzfs counts the ones that come
back and kicks a client that stops answering (`lagKick`, `bzfs.cxx:4378`).

## Signing in to a proxied server

`/login/<host_port>` runs the bzflag.org weblogin and **deliberately does not
call `CHECKTOKENS`**. A token is answered once, so checking it here would
spend the very thing the target needs. bzo holds it in memory against a
short-lived `bzo_proxy_login` cookie and returns the browser to the match; the
next WebSocket to that target carries it into `MsgEnter`, and bzfs verifies it
with the list server. The verdict arrives as a chat message the player is
already reading.

The token is deliberately not in a bzo session: sessions are written to
`sessions.json`, and a live credential does not belong in a file. The
**callsign** is a session, with no BZID on it, because a name is not a
credential -- it is what this browser is called over there, and it should
survive a reconnect and a restart even though the verification cannot. A
session with no BZID grants nothing in bzo's own game, which is the whole
point: bzo checked nothing, so bzo claims nothing. For the same reason the
`-`/`+`/`@` marks come from the target's `MsgPlayerInfo` rather than from bzo
assuming its token worked.

`/login/<host_port>[/<view>]` and `/logout/<host_port>[/<view>]` return to the
match being watched rather than to this server's own game, carrying the roam
view in the path because bzflag.org's callback may hold only one query
parameter. `/login/probe-<host_port>` is the diagnostic that proves a new
target will accept a forwarded token at all: it joins, reads the verdict, and
prints it as plain text without creating a session.

## What is not supported

- **Playing.** A proxied browser watches. Nothing a client says about moving,
  shooting or grabbing is forwarded, because bzfs is client-authoritative for
  exactly those things and bzo's client has never had to say them. That is the
  bulk of `docs/proxy-plan.md`.
- **A shot's path.** Tracing a shot against the world is client-side work
  upstream, and bzo's client does not do it, so a proxied shot passes through
  a wall it should have stopped at, and a Laser arrives without the segments
  bzo draws a beam from.
- **A reconnect stays verified.** bzflag.org answers a token once, so the
  browser's next connection rejoins under the same callsign but unverified --
  which a registered callsign earns bzfs's "You must use global
  authentication" for. Holding the bzfs connection across a browser reconnect
  is what fixes it, and it is in `docs/proxy-plan.md` with the rest of play.
- **Choosing a target anywhere but in the URL.** The `proxies` map may name
  as many as an operator likes, but a player reaches one by link: there is no
  picker in the entry dialog and no row on `/list`.
- **An operator surface that knows it is proxied.** A proxied admin is shown
  bzo's own operator panel because the target says they are an admin. It is
  display only -- those messages are dropped -- but it should not be offered.
