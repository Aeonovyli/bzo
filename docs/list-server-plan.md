# List server -- what's left

What bzo supports today is `docs/list-server.md`. This is the remainder:
issues #147 (the list itself, and what it could show) and #106 (uptime), plus
one gap left open in #46's design discussion. Upstream references are paths
under `$HOME/bzflag/`.

## The list has too many columns, and upstream already answered this

`/list` runs to fifteen columns on the bzo table and fourteen on the BZFlag
one, and the View dialog's server table is not far behind. Eight of them are
single booleans -- jumping, superflags, ricochet, antidote, handicap, team
kills, and so on -- each paying for a header.

Upstream spends one line per server: a game-type `*`, then `J F R` for
jumping, superflags and ricochet, bright when on and dim when off, then the
description -- with the *text colour* carrying the shot count, purple for
zero through to yellow for three (`ServerMenu.cxx:424-476`). Everything else
moves to a readout panel for the highlighted row only: per-team counts, max
shots, style, antidote, shaking time and wins, inertia, time limit, max team
and player score, and how old the cached answer is (`:214-238`). Ten rows a
page with PageUp/PageDown, and `ServerListFilter` over the top.

So the fix is not fewer facts, it is facts in two places. A row says what
distinguishes it; the pane says everything about the one you are looking at.
That is also what makes room for the things below, none of which fit as a
sixteenth column.

## Uptime, from the report that already announces it (#106)

The issue's own worry is right -- a server's self-reported uptime is worth
nothing -- and its fallback, the key's registration date, measures the wrong
thing: a server registered a year ago and restarted an hour ago reads a year.

There is a third answer already on the wire. A report carries a `reason`,
and the set is `boot | periodic | join | part | shutdown` (`server.js`). So
the list server records `upSince` when a **`boot`** report arrives and leaves
it alone on the others. That is list-server-observed rather than claimed, it
needs no new field, and `report()` already stamps `lastReportAt` beside where
it would live (`server/list-server.cjs`). A clean `shutdown` already calls
`unreport`, so a stopped server leaves a gap rather than a running clock.

**It is a pane field, not a column**, which is the whole of the objection
raised on the issue: not worth a column, worth a line. And it is a *bzo-rows
only* field -- a bzfs server holds no key and sends no report, and the public
BZFlag list carries no uptime, so that table can never have it. A column
empty for most rows is exactly what the section above is about.

The sharper metric is availability over a window ("up 99% of the last week"),
and that is the one that needs history rather than a timestamp. `failCount`
and `lastChecked` from `validateListServerKey` are a crude version already.
See the database question below, for which this is the concrete test.

## An overview image per map

Cheaper than it sounds, and the cost is not the drawing. bzo already turns
obstacles into two-dimensional shapes for the radar
(`public/radar-geometry.mjs`), and a map is already stored as JSON. An **SVG**
built from that needs no canvas library, no raster and no GPU, is small
enough to inline, and caches by the hash the map already has.

What needs deciding is coverage. An image for a remote server needs its world
imported first, and importing every listed server on a schedule means the
list server connects to all of them, repeatedly. That is scanning behaviour
and it should be chosen deliberately rather than arrived at. The alternative
is what already happens: import on demand, and a server nobody has looked at
has no picture yet.

## Watch: the import connection, held open

`performRemoteMapImport` already opens a real bzfs connection to any server on
the public list (`server.js`, which refuses a host the list does not carry),
joins as an observer, takes the world and leaves. Watching is that same
connection not hung up, forwarded to a browser the way a proxied one is.

So this needs no change to `proxies`: that allowlist governs `?proxy=`, which
is *playing* on a target the operator configured. Watching is governed by the
rule the importer already uses -- on the public list or not at all -- and
travels as its own `?watch=host:port` so the two policies never blur. It is a
third destination kind beside local and proxy, and like them it is a
navigation, because a target is fixed before the socket opens.

**It requires a bzo login, and the remote sees the verified forum name.** Not
for the target's benefit -- it cannot check the claim -- but because bzo will
only send a name it verified itself. The motto names the instance that
vouched, which is the one thing the operator cannot work out alone and the
only place a complaint can be aimed.

This is knowingly weaker than the play path, and the plan should not pretend
otherwise:

- bzfs marks the player unverified in `MsgPlayerInfo`, so the scoreboard shows
  `-` rather than `+`. A player who looks can tell the difference between a
  name and an authenticated name.
- A modified bzo could send any name. The trust sits with the instance, which
  is where the proxy already puts it.
- Bans stay collective. With no token there is no BZID on the remote, so
  `/idban` cannot single out one watcher the way it can one proxied player --
  only an address ban, which takes every watcher from that instance.

It is still better than `bzo-watch-2`, which offers the operator nothing at
all. The ceiling here is upstream's authentication model rather than a choice
of ours: a token only verifies when bzfs sees the peer at a private address
(`docs/proxy.md`), so a stranger's server can never verify a watcher. If
upstream ever gains OAuth2 or anything that survives a relay, this improves
without the design changing.

**What a watcher can do is settled by bzfs, not by us.** Chat is relayed with
no verification check (`bzfs.cxx:5024`). Spawning is refused --
`isAllowedToEnter()` is `verified || !isRegistered()` and gates `playerAlive`
(`Permissions.cxx:129`, `bzfs.cxx:3199`) -- and a watch connection never sends
`MsgAlive` anyway, so it does not provoke a kick it would then have to
explain. Permissions come from groups, and groups are granted only inside
`if (verified)` after the list server approves a token
(`ListServerConnection.cxx:263-276`), so a watcher holds none. `/` lines pass
straight through and the target answers: `/msg`, `/serverquery` and `/uptime`
work, while `/report`, `/clientquery`, `/playerlist` and `/set` are refused in
bzfs's own words.

**Whether observers are accepted is free from the list.** `observerMax` is the
sixth entry of the ping's `teamMaximums` (`decodePingHex`), so a Watch action
can be offered or withheld per row with no probing at all. Measured against
the live list: 235 of 235 accept observers, none with the slots full. That
does not make it permanent -- the row should read the field, and a refusal at
connect should be a sentence rather than a broken page.

Deliberately unresolved: whether a watcher may chat at all. It works, so it is
a choice. A silent watcher bothers nobody; a talking one under a name the
target cannot verify is the thing an operator would object to first.

## Player counts, rosters, and who is where

Counts are nearly free and already decoded. `queryServerStatus` returns
per-team sizes and maxima, `maxPlayerScore`, `maxTeamScore` and `maxTime` --
most of upstream's own readout panel -- from a ping-level query that joins
nothing.

Player *names and scores* are not. They need a join, which every operator sees
as a `bzo-*` observer arriving and leaving, and `/playerlist` is permission-
gated so a watcher cannot ask for them either. Presence has to come from the
connection itself. These two want separating in any build: one is polite, the
other is visible.

**Cross-server presence is a new kind of data**, and the plan should say so
before collecting it. "Who is online and where" means the list server
continuously knows where each player is. Upstream's list server does not do
this; bzstats builds it by scraping. If bzo wants it, it wants an opt-out and
a sentence explaining itself, not a cache that happened to grow.

## JSON or a database

The store holds three records of eight fields plus the *latest* status, and
nothing historical (`server/list-server.cjs`). JSON is fine for that
indefinitely.

What it cannot grow into is history: scores over time, availability over a
window, a presence trail. That is append-only time series and it is the only
requirement here that forces the question. So the decision is not JSON versus
SQLite in the abstract -- it is whether history is wanted, with uptime the
cheapest concrete case. `upSince` is one timestamp and needs nothing; "up 99%
of the last week" needs a session log.

## Admin capabilities beyond revoke

A local admin (`adminGroups`) can revoke any registered key
(`DELETE /api/list-server/keys/:id`), which drops that row from `/list`'s
bzo-servers table the next time it would have reported. Two related things an
admin cannot do:

- **Force-unlist a live row without revoking its key.** Revoking is the only
  lever today, and it also ends that server's ability to report at all --
  there is no "hide this row but leave the registration alone" action.
- **Edit someone else's registered URL.** An admin can only revoke and let the
  operator re-register; there is no in-place edit.

Neither came up as a real need while building this -- they were open questions
in the original design discussion, not requests from an actual operator.
Worth adding if either becomes one.

## Order of work

1. **The two-pane list.** It fixes the stated complaint, it is self-contained,
   and everything below wants somewhere to be shown that is not another
   column. One line per row, a pane for the selected one, paged and filtered.

2. **Uptime from `boot`.** One timestamp on the key record and one line in the
   pane, once the pane exists.

3. **Watch.** The plumbing rather than the policy: a `?watch=` destination,
   the public-list rule, the verified callsign and vouching motto, and the
   chat decision above made explicitly.

4. **SVG overviews**, with the scanning question answered rather than assumed.

5. **Presence and history**, behind the database decision, which availability-
   over-a-window is the test for.
