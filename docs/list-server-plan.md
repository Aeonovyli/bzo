# List server

Design for bzo's own server directory. Issue #46 is the tracker; the wire-level
findings about *why* bzo cannot use `my.bzflag.org` are in
`docs/game-modes-plan.md` under "Publishing to the list server", and the login
this reuses is built and documented in `docs/login-plan.md` and AGENTS.md
"Admins and the admin channel".

## The problem

`my.bzflag.org`'s list server is a directory of raw `host:port` rows: a client
that reads one dials it directly with bzfs's binary protocol
(`ServerList.cxx`), and the server it finds writes eight bytes of `BZFS0221`
before any message. There is no HTTPS/SNI connection in that path for a
browser to make, and no way to make the list server validate a bzo server
either -- it has nothing to dial back with. Publishing bzo there is possible
(one HTTPS POST, a 58-character `gameinfo` string) but being listed is not: a
client that finds the row would try to connect the one way it cannot.

The fix is not to make bzo compatible with that protocol. It is to run bzo's
own list server -- a designated bzo instance -- and have every other instance
report to it over plain HTTPS/JSON, the same shape bzfs's `ADD`/`REMOVE` have
but none of the binary transport underneath.

## Accounts: reuse the existing login

No new login system. The designated list server uses the bzflag.org global
login bzo already has -- BZID-keyed sessions, `server/sessions.cjs`, the
`/login` round trip -- exactly as it stands today. Only the designated instance
needs the account UI; every other instance's `/view` links out to it rather
than duplicating login and key management locally.

## Keys are per server, not per account

Modeled on bzfs's `-publickey`, which is also per-server: a shared key could
not tell two of an operator's servers apart, and a leaked one would compromise
everything they run.

- A logged-in user "adds a key" on the list server and enters that server's
  URL **up front**, from their own authenticated session. This is not a new
  decision for them -- it is the same value they already have as `publicUrl` in
  `server.json`, required today for the admin-whitelist proxy probe
  (`server.js:1587`). Asking for it now, rather than trusting whatever URL a
  later report claims, is what stops a leaked or guessed key from pointing the
  list server's verification callback at a URL its holder does not control.
- The list server generates a unique key and stores `{ bzid, url, key,
  dateRequested, lastChecked }`.
- The operator pastes the key into that instance's Operator panel
  (`listServerKey`), which goes through the panel's existing
  `setOperatorConfig` / `applyServerConfigChanges` path: no restart, no new
  auth surface, gated the same as every other operator-only setting.
- Revoking one key drops only that key's row. An operator running several bzo
  instances holds several keys, one per server.
- **Open for now**: any registered bzflag.org forum user may generate a key.
  Restricting it to a specific forum group -- the same shape `adminGroups`
  already reads for admin -- is worth doing later if abuse or noise makes it
  worth doing, not before.

## Reporting

A JSON POST, not bzfs's form-encoded body -- both ends are bzo, so there is no
reason to mimic the wire format bzfs uses to talk to a server that predates
JSON everywhere. Cadence follows bzfs's own:

- On boot, and every ~15 minutes after (`ListServerReAddTime`,
  `bzfs.cxx:84`), and again on every join and part, for live counts.
- A REMOVE-equivalent on clean shutdown.

Payload: `key`, version, title/description, player and max counts, and the
same game-option bits `/view` already computes for the `my.bzflag.org` table
(`GAME_OPTION_BITS` -- jumping, flags, ricochet, antidote, handicap, no team
kills).

## Validation

The list server never trusts a URL an ADD payload itself supplies -- it calls
back the URL already on file for that key.

- **Only on the periodic ADD**, not on every join/part. An active game
  should not cost an outbound HTTPS round trip per player.
- **A daily poll is a second trigger for the same check**, initiated by the
  list server itself rather than waited for -- a backstop for a server that has
  gone quiet on the push side (a blocked outbound leg, a missed restart) but is
  still actually reachable. Either kind of check succeeding bumps the same
  timestamp; see "Key lifetime" below for why it is named for that rather than
  for either trigger.
- **The callback is a signed challenge, not a round trip of the raw key.** The
  list server sends a nonce; the target signs it with the key it has
  configured (HMAC) and returns the signature. An unauthenticated GET that
  just echoed a secret back to whoever asked would be one bug away from
  leaking it.
- **A few consecutive failures, not one**, before a row flips to stale on
  `/view`. A single missed push or poll on an otherwise-solid server is noise;
  flapping the public list off one blip is worse than staying a few minutes
  stale.
- **A stale row says why**, the same way `/view` already reports "could not
  reach the list server" rather than going silent: "no response from
  `<url>`," not just an absence.

## Key lifetime

Unused keys expire after 30 days, to start. The field is **`lastChecked`**,
not "last used" -- it is bumped by whichever of the two checks above last
succeeded, a push-triggered validation or the daily poll, and it is the list
server's own confirmation rather than a claim of operator activity.

- A key expires 30 days after `lastChecked`, or 30 days after
  `dateRequested` if it was never used at all -- a key generated and never
  pasted anywhere ages out the same way an abandoned one does.
- **A failed check marks the row stale. It does not expire the key.** Only
  the 30-day rule deletes a key registration. That keeps "temporarily
  unreachable" and "abandoned a month ago" as two honestly different states
  instead of one.
- An expired key is refused on its next ADD with a clear reason to
  regenerate, and its row drops from `/view`.

## `/view`

Every instance keeps its two existing tables (the public bzfs list, local
maps) and gains a third: bzo servers, read from the designated instance's
public read endpoint.

- **Only the designated instance hosts the account UI**: an editable panel
  for a logged-in user's own keys, and a complete list for admins (the same
  `adminGroups` gate bzo already has elsewhere) who can unlist anyone's row.
  A non-designated instance's `/view` links out to the designated one for key
  management instead of duplicating that UI.
- **Clicking a bzo-server row navigates the browser there directly**
  (`location.href = url`), unlike a bzfs row's Import button. Each row is its
  own origin and its own websocket, not something to dial into or fetch a map
  from.
- The version bzo reports rides in the same row (host, title, players/max,
  the option columns `/view` already draws, plus version), so a viewer can see
  at a glance whether a listed server is running something current.

## URL handling

Stored and validated as a **full URL** (origin plus optional path), never a
bare host:

- This is what makes a future path-prefixed deployment (`https://example.com/
  bzo1`, `.../bzo2` -- issue #105) just another row with its own key, once that
  is built. It is not needed for this plan; the plan only has to avoid
  assuming a URL is origin-only, and the callback already builds its target
  the way `probeAdminWhitelist` does today (`PUBLIC_URL.replace(/\/+$/, '') +
  '/api/...'`), which path-joins correctly either way.
- **An IPv6-only `publicUrl` validates and lists fine.** bzo's callback and
  player connections are HTTPS/WebSocket, not bzfs's IPv4-only raw socket, so
  there is nothing here that requires a v4 address the way a bzfs row does.
  Worth saying plainly in an operator-facing doc, though: some players without
  v6 connectivity simply cannot reach that row, the same as any v6-only web
  service. Contrast with bzfs's own list server, which cannot represent an
  IPv6 row **at all** -- that is `ServerList.cxx`'s client-side dial being
  IPv4-only and bzfs not listening on v6 either, an implementation limit of
  that specific client and server, not something inherent to a `host:port`
  address. It does not carry over to bzo's URL-based rows.

## Config additions

`server.json` / Operator panel:

- `listServerUrl` -- which instance is designated. Empty disables the feature
  entirely; nothing here is hardcoded to any one deployment.
- `listServerKey` -- this server's own credential, editable live via the
  Operator panel like any other operator setting.

## Abuse resistance

Rate limit key-generation and reporting the same way `/login` already is (ten
requests a minute per address, keyed on the address the proxy names). Both are
new places an anonymous or logged-in caller can make the list server do
outbound work -- the verification callback -- so they should carry the same
ceiling from day one rather than added after something abuses it.

## Out of scope here

**Issue #105** (relative asset paths so one bzo process can serve under a
path prefix, e.g. behind a reverse proxy routing `/bzo1/*` and `/bzo2/*` to
different instances on one domain) is separate, larger work. This plan only
avoids assuming a listed URL is origin-only; it does not need #105 built
first.

## Still open

- Exact admin capabilities beyond revoke -- force-unlist a live row, edit
  someone else's registered URL?
- Whether a row that has gone stale (consecutive check failures, not yet
  expired) should still appear on `/view` marked as such, or drop from the
  table immediately and only reappear once it checks out again.
