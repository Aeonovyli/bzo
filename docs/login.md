# Global login

What bzo supports for signing a player in with their bzflag.org global
callsign, and what that identity grants. Upstream references are paths under
`$HOME/bzflag/`. For the two token flows this is built on and the findings
that shaped it, see AGENTS.md, "Admins and the admin channel"; for what is
still unbuilt, see `docs/login-plan.md`.

## The round trip

The entry dialog's login row (`input.js:1487`, beside Name, Team and Choose
Tank) sends a signed-out player to `/login`. With no `t` parameter that
redirects to `https://my.bzflag.org/weblogin.php`; bzflag.org sends the player
back to `/login?t=<token>:<callsign>`, and the server asks `CHECKTOKENS`
whether the token is real. A real token verifies with no IP supplied, group
membership comes back for the groups named in `adminGroups` and no others, and
the reply carries a `BZID` -- a small stable integer that survives a callsign
change on the forum.

On a verified token `/login` creates a session, sets the cookie and redirects
to `/`, which opens a fresh socket -- there is no identity to migrate onto a
live connection. On anything else it clears the cookie and redirects to
`/#login=failed`; the fragment never reaches the server, so a forged one
achieves nothing.

`/login` is rate limited to ten requests a minute per address, keyed on the
address the proxy names rather than `req.ip`. It is the one public route that
spends something -- a callback with a token makes bzo ask my.bzflag.org about
it.

## Session and cookie

The browser holds one opaque value and nothing else: 32 random bytes
(`crypto.randomBytes(32).toString('base64url')`) in a `bzoSession` cookie,
`HttpOnly; Secure; SameSite=Lax; Path=/`. Every attribute -- BZID, callsign,
groups, whether either grants admin -- lives in a server-side record the
cookie is a key to (`server/sessions.cjs`); a player can write their own
cookies, so an invented id simply matches no record.

A session lasts 8 hours, absolute. Group membership is a snapshot -- the
token is spent at `/login` and cannot be re-asked -- so 8 hours bounds how
long a demotion at bzflag.org can go unnoticed. Sessions persist to
`sessions.json` under the runtime directory and are read back at boot, because
this server restarts on every edit and each login is a full bounce through
my.bzflag.org. Writes are debounced, expired records are pruned on read and on
a periodic sweep, and the store is capped at 500 so it cannot grow without
bound -- the oldest is evicted first, and its owner simply logs in again.

## Where identity binds

The cookie rides the WebSocket handshake, so the session is looked up once in
`wss.on('connection')` and hung on the `Player`. `/` and the `init` payload
only *tell* the client its name and status -- the entry dialog shows the field
locked for a logged-in player, the same rule bzo already follows for `admin`,
where a greyed-out button reads an answer rather than keeping a second copy of
the question.

`isAdmin` re-reads the session on every privileged action (`server.js:7697`)
rather than trusting a flag set at connect, because an 8 hour session can
expire mid-game.

## Name collisions

A verified callsign outranks a typed one. When an authenticating player's
callsign is already held by another connected player, the arriving
authenticated player always takes the name:

- **Not authenticated** -- renamed in place to the `Player <n>` fallback
  `nameCheck` already uses, and told why.
- **Authenticated as the same callsign** -- which can only be the same account
  on a second device -- disconnected, and the newest device keeps the
  identity and whatever admin rights it logged in for. Its superseded session
  is invalidated at the same moment: bzo clients rejoin without waiting for a
  click, so a kicked device would otherwise reconnect on its own stale cookie
  and kick right back, trading the identity forever.

## Indicators

`@` admin, `+` verified, `-` registered but not authenticated -- upstream's
three booleans (`MsgPlayerInfo`), drawn beside the callsign rather than inside
it (`ScoreboardRenderer.cxx:718`). bzo can only ever reach `@` and `+`, since
it learns nothing about a callsign unless a token verifies, which means
registered *and* authenticated. A leading `@`, `+` or `-` is refused on any
name a client asks for, so nobody can fake one in plain text -- a chat line,
the server log.

## Admin

`isAdmin` answers yes for either of two things: an authenticated player who is
a member of at least one group named in `adminGroups` (server.json), or a
connection from this machine with `localAdmin: true` set (see AGENTS.md,
"Admins and the admin channel", for why that is not "the peer is loopback").
There is no other gate -- a player who never logs in is never an admin, and a
name that merely isn't the default placeholder grants nothing.
`example-server.json` ships `DEVELOPERS` and `BZADMIN`, bzflag's own project
groups, so a fresh install has somebody able to operate it; the site roles a
bzflag.org account may also carry (`WEBSITE.ADMINS`, `BBMODERATORS`) and other
people's server groups are deliberately left out of the default.

## Logging out

The same entry-dialog row that opens `/login` when signed out sends a
signed-in player to `/logout`, which removes the stored session and clears the
cookie before redirecting back to `/` -- the same page-navigation shape as
`/login` itself.

## Inside an immersive session

Logging in or out is a page navigation, which ends a WebXR session. Rather
than doing that silently, the row refuses while in XR and says why ("Global
login leaves VR. Exit the headset session first." -- `client.js:2833`), so a
player has to leave the headset deliberately before it happens.

## What's not built yet

See `docs/login-plan.md`.
