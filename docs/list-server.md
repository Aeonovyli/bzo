# List server

bzo's own server directory, built to answer issue #46: `my.bzflag.org`'s list
server dials a row's `host:port` directly with bzfs's binary protocol
(`ServerList.cxx`), which has no HTTPS/SNI connection for a browser to make and
no way to validate a bzo server either. A designated bzo instance answers
that instead -- every other instance reports to it over plain HTTPS/JSON, the
same shape bzfs's `ADD`/`REMOVE` have but none of the binary transport
underneath. `server/list-server.cjs` holds the registry and the HMAC
challenge; the routes and the reporting client live in `server.js`. For what
is not built yet, see `docs/list-server-plan.md`.

## Which instance is designated

`listServerUrl` (`server.json`) names it -- unset, it defaults to
`https://bz.rikers.org`, the same way bzfs itself defaults `-list` to
`my.bzflag.org` rather than shipping with nothing to report to. An operator
who wants the feature off sets it to `""`.

Every instance decides for itself whether *it* is the designated one by
comparing its own `publicUrl` against `listServerUrl`
(`IS_DESIGNATED_LIST_SERVER`, `server.js:1914`) -- a derived fact, not a
second flag that could disagree with the first. The designated instance runs
the account UI and the registry endpoints below; every other instance is
only ever a reporting client.

## Keys

Modeled on bzfs's `-publickey`, which is also per-server: a shared key could
not tell two of an operator's servers apart, and a leaked one would
compromise everything they run.

A logged-in bzflag.org user registers a key on the designated instance
(`POST /api/list-server/keys`, `server.js:2045`) by naming that server's own
`publicUrl` up front, from their own session -- not a new decision, since
it's the same value already required for the admin-whitelist proxy probe.
One key per URL: a second request for a URL that already has an active
registration is refused (409). The record is `{ id, bzid, callsign, url,
key, dateRequested, lastChecked, failCount, lastError }`
(`server/list-server.cjs`) -- `id` is an opaque, non-secret UUID the account
page revokes by; `key` is the 48-character lowercase-hex bearer credential
(alphanumeric only, so a double-click in the table selects the whole thing,
unlike base64url's `-`/`_`).

`GET /api/list-server/keys` (`server.js:2106`) hands the key back **in
full**, not masked, to its own owner and to an admin --
otherwise an owner who didn't copy it from the one-time creation flash would
have no way to retrieve it, and an admin who can already revoke any row is
already trusted with what it is. The row's URL links to itself; a real
(numeric) BZID links to that user's `forums.bzflag.org` profile.

The operator pastes the key into that server's Operator panel (List Server
Key row, `input.js`/`client.js`), which sends `setListServerKey`
(`server.js:15155`) -- deliberately not the panel's generic
`setOperatorConfig`, whose state rides in `init.operatorConfig` and is sent
to *every* connecting player. This credential is admin-only: `init` carries
it as `listServer.keyConfigured` (a boolean, never the key itself) behind
`player.admin` (`server.js:14014`). Applying it needs no restart and no new
auth surface -- gated by the same `refuseNonOperator` check as every other
operator action.

An admin here is either a bzflag.org session in a group `adminGroups` names,
or a request from an address `adminWhitelist` covers with `localAdmin` on --
the same test a player's join already makes. The whitelist stands in for a
login when *reading* or *revoking* a key, which is an operator's housekeeping
on a server they demonstrably run; creating one still needs the login,
because a key is attributed to a BZID and an address is not one.

Revoking a key (`DELETE /api/list-server/keys/:id`) drops only that row; an
operator running several bzo instances holds several keys, one per server.
Registration is open to any registered bzflag.org forum user for now --
restricting it to a forum group, the same shape `adminGroups` already reads
for admin, is a real thing to add later if abuse or noise makes it worth
doing.

## Reporting

The reporting client (`reportToListServer`, `server.js:10715`) posts JSON,
not bzfs's form-encoded body -- both ends are bzo, so there's no reason to
mimic a wire format that predates JSON everywhere. It fires on boot, every
~15 minutes after (`ListServerReAddTime`'s own cadence), on every join and
part (for live counts), and once more as a REMOVE-equivalent on `SIGTERM`/
`SIGINT`. Payload: `key`, `reason`, title/description, player and max
counts, `version`, the shot limit and game style (`maxShots`, `style` --
`GAME_CONFIG.SHOT_MAX_ACTIVE`, `GAME_TYPE`), and the game-option bits
(`computeLocalGameOptionsBits`, `server.js:10699`) -- the same fields `/list`
already draws for a remote bzfs row's Shots/Style columns and option bits,
read off this server's own resolved config instead of decoded off the wire.
Also `map`, the world being played -- `mapFile`, or `random` for a generated
one -- which is the `?viewmap=` name on that instance. Changing the map is a
restart today, so the row follows on the next boot; anything that changes it
*without* one, a rotation on a timer say, has to report as well, or the
column quietly starts lying. The readout pane's own fields ride along with these -- per-team counts and
maxima in `-mp` order, the shake timeout and win count, and the time, team
score and player score limits -- so a bzo row's pane says as much as a bzfs
row's, which gets all of it free from its ping packet. An instance too old
to report them shows the lines it has and leaves the rest out, rather than
reading as a server with no teams. And `voiceEnabled`
(`VOICE_ICE_SERVERS.length > 0`) -- not whether the
client feature exists (it always does), but whether at least one ICE
server is configured, since a peer connection across anything but a LAN
typically never completes without one.

And `proxies`: one entry per real BZFlag server this instance carries a
browser to (`docs/proxy.md`), each carrying that target's own counts, shot
limit, style, option bits, title and reachability -- everything a native row
carries about its own game, because a proxied target is a whole game too.
The instance dials each target directly for them -- `MsgQueryGame` and
`MsgWantSettings` on a connection that never enters the game -- on the
report's own cadence rather than per join or part. Registration is
unchanged: one key per instance however many targets it carries, and one
challenge callback proves them all.

The designated instance never reports to itself over HTTP: it writes
straight into its own registry (still keyed by URL, so a restart finds the
same row rather than creating a new one) and is attributed to
`listServerOwnerBzid`/`listServerOwnerCallsign` if set, or a plain "self"
placeholder otherwise -- see "Config" below.

## Uptime

Issue #106. A `boot` report is the one reason that means "this server just
started", so the list server stamps `upSince` on the key record when one
arrives and leaves it alone on every other reason -- periodic, join, part, and
the status that rides along with a validation. A clean shutdown calls
`unreport`, which drops `live` and stops the clock; the next boot starts a new
one.

It is **observed, not claimed**: `sanitizeListServerStatus` deliberately does
not read an uptime out of a payload, because a server asserting its own is the
thing the issue said was worthless, and the key's registration date measures
the wrong thing -- a key registered a year ago on a server restarted an hour
ago reads a year.

On the key record rather than in `live`, so it survives the list server's own
restart, which `live` deliberately does not (see "Speeding up a restart"). It
shows as one line in a bzo row's pane, coarse on purpose -- days, or hours and
minutes -- since a report cadence cannot support a figure more exact than
that. A bzfs row can never have it: that server holds no key, sends no report,
and the public BZFlag list carries no uptime.

## Validation

`server.js:2021`, `validateListServerKey`. The list server never trusts a URL
an ADD payload itself supplies -- it calls back the URL already on file for
that key, with a nonce the target has to sign with the key it has configured
(`GET /api/list-server/challenge`, `server.js:2189`; HMAC-SHA256,
`signListServerChallenge`/`verifyListServerChallenge` in
`server/list-server.cjs`). Only a `boot`/`periodic` report triggers this --
never a bare join/part, so an active game never costs an outbound HTTPS
round trip per player. A daily poll (`setInterval`, 24h) is a second trigger
for the same check, initiated by the list server itself as a backstop for a
server that has gone quiet on the push side but is actually still
reachable.

A few consecutive failures (`STALE_FAIL_THRESHOLD = 3`), not one, mark a row
stale -- a single missed push or poll is noise. A stale row leaves the
servers table: every row there is a game somebody can join right now, and an
instance this list has stopped hearing from is not one. It does not vanish
without explanation, though. The key table at the bottom of the same page
shows every key's last check and last error to whoever owns it, and to an
admin, which is where an operator asking "why is my server not listed" should
be looking anyway.

## Key lifetime

Unused keys expire after 30 days, from `lastChecked` (`KEY_MAX_AGE_MS`,
`server/list-server.cjs`) -- bumped by whichever check last succeeded, a
push-triggered validation or the daily poll, never by a bare join/part
report. A key never checked expires 30 days after `dateRequested` instead,
so a key generated and never pasted anywhere ages out the same way an
abandoned one does. A failed check only marks a row stale; only this 30-day
rule ever deletes a registration, which keeps "temporarily unreachable" and
"abandoned a month ago" two honestly different states. An expired key is
refused on its next report with a clear reason to regenerate.

## Speeding up a restart

A restart of the designated instance loses every row's `live` state at once
-- it is never persisted (see "Keys" above) -- and normally that repairs
itself gradually as each reporting instance's own boot/~15-minute/join-part
cadence catches up, one row at a time. On a designated instance that itself
restarts often, that meant every registered server blinking off `/list` on
every restart, not just once.

The validation callback (`GET /api/list-server/challenge`) answers with the
same fields a report would have -- `computeListServerStatus()` builds both
-- since a caller who already holds the shared key to verify the signature
against is exactly who a report would trust anyway. `validateListServerKey`
folds that status straight into `live` on a successful check, and on boot
the designated instance immediately validates every key checked within the
last two days (`LIST_SERVER_RECENT_CHECK_WINDOW_MS`), rather than waiting
for the daily poll or for each target's own next push. This needs both
sides updated to take effect for a given row -- an older reporting instance's
challenge response has no `status` field, and is treated the same as a
successful validation with nothing new to report.

## `/list`

One page, top to bottom: a nav line of jump links (bzo, bzflag, maps, keys),
then this instance's own login state; the bzo servers table (read from the
designated instance's public read endpoint, `GET /api/list-server/list`,
`server.js:2164`); the public bzfs list; local maps; and, at the bottom,
this instance's key admin -- the key table first, the register-a-key form
after it, since the table is what an operator came for and registering a
new key is the occasional case.

Each of the two server lists is one line per server with a readout pane
above it -- upstream's own server menu rather than a wide table
(`ServerMenu.cxx`). A row carries the player and observer counts, a game-type
`*` whose colour says which of the four it is, `J F R` for jumping,
superflags and ricochet, and then the address and title, the title's *colour*
being the shot count: purple for zero through yellow for three, graded orange
into red above that. The bzfs list has a fourth letter, `I`, which is bzo's
own: whether this server already holds an import of that map, the one fact in
a row that is about *this* server rather than that one.

The pane is two columns, as upstream's panel is: who is playing on the left
-- the player count and each team's own count and maximum -- and what the
game is on the right, being shots, style, the option words, the shake
conditions, the score and time limits, and for a bzo row its map, version,
voice and URL. A map overview is meant to become a third
(`docs/list-server-plan.md`).

A bzo row shows the team lines only if that instance reported them: an
instance older than the release that added `teamCounts`/`teamMaximums` to a
report has no figures to show, and its pane leaves those lines out rather
than printing zeroes that would read as "no teams offered". Its observer
count in the list is blank for the same reason.

The filter box takes upstream's own filter language
(`src/bzflag/ServerListFilter.cxx`), and the `?` beside it opens the whole
syntax table -- the same one upstream's in-client help menu prints, in the
place the person typing is looking. Plain text is a glob over address and
description, a leading `/` starts comma-separated filters combined with
*and*, a second `/` starts another set joined with *or*, and a filter is
`+name`/`-name`, `name` with `< <= > >= =` and a number, or `name)glob` /
`name]regex`. `scripts/test-server-filter.mjs` pins the bounds, which are
exclusive the way upstream's are. Two deliberate differences: `F` is
free-for-all here (upstream's own table gives the letter to both `ffa` and
`favorite`, so the second wins and the documented meaning stops working, and
bzo has no favourites to collide with), and `i` and `I` both mean inertia
(upstream's parser takes the lowercase letter while its help page prints the
capital). A filter naming a per-team figure leaves out any row bzo has no
figure for, rather than counting it as zero.

Clicking a row selects it rather than following it, because the pane is
where the detail is and the bar above it holds the way in. Arrow keys move
the selection and Enter takes it, as upstream's menu does. Ten rows show at
a time in a scroll box, which is upstream's own page size
(`ServerMenu.cxx:34`) and the reason its PageUp/PageDown paging was not
worth copying. The one-character header over each column sorts by that
column; the list arrives sorted by player count, the only order upstream
ever shows (`ServerItem::getSortFactor`). Each heading says how many servers
are under it and how many people are playing on them -- observers are
counted as neither, here or anywhere else on the page.

A bzo row's link enters that game directly: each row is its own origin and
its own websocket, not something to import a map from. An instance that
proxies contributes a row per target as well as its own, so the list is one
row per *game* rather than per instance -- such a row names the target and
links to that instance's `?proxy=` for it. The selected row's own buttons sit on the filter bar rather than in the pane,
so the way in stays in one place instead of moving as a pane grows or
shrinks. A bzfs row offers **View map** and **Import**, plus a **Watch** link
for a signed-in admin: the same test the in-client View list makes
(`canWatchRemoteServers`), because watching sends that server a callsign bzo
has verified (`docs/proxy.md`).

Sorting, selection and the filter parser are `public/list-page.js`, served as
a file rather than inlined in the page: the parser is long enough that
escaping it into `server.js`'s template literal would be the hardest part of
reading it. What each row is judged by rides in a JSON block beside the list,
one entry per row, so sorting and filtering never refetch anything.

The local maps list below the two has the same shape, and shares the same
code: a row carries the three numbers the in-client View picker shows in
columns -- obstacles, mesh faces and world size -- and its pane carries the
rest, being the style the map sets, its boxes, pyramids, meshes, bases and
teleporters, whether it has water, weather or custom ground, and then the
hash, the mtime and the two file sizes. Those stats are `MAP_REGISTRY`'s own
(`entry.stats`, the same ones `getViewableMapsList` sends the client), so the
page computes nothing to show them. Only the glob half of the filter language
means anything on that list, which is why it has no `?` beside its box.
`random` is a world generated at boot rather than a file, so it has no counts,
hash or sizes and says so.

With scripting off, every row is still a plain link to what it always went
to, and the first row's pane is the one on show.

Key admin only exists on the designated instance (`app.get('/list', ...)`,
`server.js:1171`); a non-designated instance's own `/list` shows a short
redirect notice there instead, and the nav's own "keys" link on a
non-designated instance skips that notice and goes straight to
`<listServerUrl>/list#keys`.

`/view` and the standalone `/list-server` page that predated this are both
301 redirects to `/list` now (`/list-server` lands on `/list#keys`), in case
either was bookmarked (`server.js:1197`). `/login` grew an optional
`/login/list` form (an allowlisted path segment, `LOGIN_RETURN_PATHS`) so
the bzflag.org round trip started from `/list` returns there instead of to
`/`.

## URL handling

Stored and validated as a full URL (origin plus optional path), never a bare
host -- what makes a future path-prefixed deployment (`https://example.com/
bzo1`, issue #105) just another row with its own key, once that is built.
An IPv6-only `publicUrl` validates and lists fine: bzo's callback and player
connections are HTTPS/WebSocket, not bzfs's IPv4-only raw socket, so nothing
here requires a v4 address the way a bzfs row does -- though a player
without v6 connectivity still can't reach that row, the same as any v6-only
web service.

## Config

`server.json` / Operator panel:

- `listServerUrl` -- which instance is designated. `""` disables the
  feature entirely.
- `listServerKey` -- this server's own credential, live-editable via the
  Operator panel's List Server Key row.
- `listServerOwnerBzid` / `listServerOwnerCallsign` -- boot-time only, and
  only meaningful on the designated instance: who its own self-report row is
  attributed to on the key admin table's Owner column. Unset, that row
  falls back to a "self" placeholder rather than a broken forum-profile
  link.

## Abuse resistance

Key-generation and reporting carry the same rate limit `/login` already
does: ten requests a minute per address, keyed on the address the proxy
names (`listServerRateLimit`). Both are places an anonymous or logged-in
caller can make the list server do outbound work -- the verification
callback -- so both carry the ceiling from day one.

## What's not built yet

See `docs/list-server-plan.md`.
