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
full**, not masked, to its own owner and to a local admin (`adminGroups`) --
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

The designated instance never reports to itself over HTTP: it writes
straight into its own registry (still keyed by URL, so a restart finds the
same row rather than creating a new one) and is attributed to
`listServerOwnerBzid`/`listServerOwnerCallsign` if set, or a plain "self"
placeholder otherwise -- see "Config" below.

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

A few consecutive failures (`STALE_FAIL_THRESHOLD = 3`), not one, flip a row
to stale on `/list` -- a single missed push or poll is noise. A stale row
says why (the last error, as a tooltip), the same way `/list` already
reports "could not reach the list server" rather than going silent, rather
than dropping from the table.

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

## `/list`

One page, top to bottom: a nav line of jump links (bzo, bzflag, maps, keys),
then this instance's own login state; the bzo servers table (read from the
designated instance's public read endpoint, `GET /api/list-server/list`,
`server.js:2164`); the public bzfs list; local maps; and, at the bottom,
this instance's key admin -- the key table first, the register-a-key form
after it, since the table is what an operator came for and registering a
new key is the occasional case.

Clicking a bzo-server row navigates the browser there directly
(`location.href`), unlike a bzfs row's Import button -- each row is its own
origin and its own websocket, not something to import a map from. A bzo
row's columns match a bzfs row's exactly (players/max, shots, style, the
option columns, title) plus the two a bzfs row doesn't carry -- version and
the URL itself -- so a visitor can see at a glance whether a listed server
is running something current.

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
