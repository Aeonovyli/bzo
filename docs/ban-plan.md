# Address bans

`/ban`, `/unban`, `/banlist` and `/checkip` on IPv4 and IPv6 addresses and
CIDR blocks, and `/poll ban` on them. BZID bans and `/kick` are built (see
**Kicks and bans** in [installation.md](installation.md)); upstream
references are paths under `$HOME/bzflag/`.

## An address worth banning

A ban on an address is only worth having if a client cannot choose the
address. The startup probe (`probeAdminWhitelist` in `server.js`) answers
that for `adminWhitelist`: it fetches the server's own public URL once plain
and once with a forged `X-Forwarded-For`, and sets `forwardedForPolicy`:

- `trust-first`: the proxy replaces the header, so it holds one entry.
- `trust-last`: the proxy appends, so a forged value sits in front and the
  last entry is the address the proxy saw. bz.rikers.org is this case.
- `distrust`: anything else, or no answer. No forwarded address is used.

Address bans rest on the same answer, with two changes first.

### Read the address through the policy

`player.clientIP` (what `/playerlist` shows and a ban would match) and
`requestAddress` (the login rate limit's key) take the header's *first*
entry whatever the probe found. Behind an appending proxy that is the
client's own choice. Both should read it as `isLocalAdminRequest`
(`server/sessions.cjs`) does: the last entry under `trust-last`, and no
forwarded address under `distrust`. One function for all three.

### Make the probe refuse a second proxy

An appending proxy behind another one -- a CDN in front of Apache -- passes
the probe as it stands: the last entry is the CDN's edge, the same on both
requests, and the forged value never reaches the end. Every player would
then have the CDN's address, and banning one would ban them all.

The probe's own request comes from this server, so the last entry should be
this server's address. Trust the proxy only when it is one of:

- an address on this machine (`os.networkInterfaces()`), and
- the public addresses `https://ip4.me/api/` and `https://ip6.me/api/` report
  for this machine.

Otherwise `distrust`, logging both addresses. If neither lookup answers,
compare against the local addresses alone, which a CDN still fails.

Both kinds are needed. Measured on bz.rikers.org:

| Probe over | Last entry | Matches |
|---|---|---|
| IPv6 | `2607:fa18:9fff:0:db23:fe42:e45a:affa` | ip6.me, and a local address |
| IPv4 | `192.168.12.5` | a local address only; ip4.me says `166.70.97.196` |

Over IPv4 the request hairpins inside the LAN, so the proxy sees the
machine's LAN address. A home network or Azure, whose request leaves and
comes back through the router, matches the ip4.me/ip6.me answer instead.

## The ban list

- A ban is an IPv4 or IPv6 CIDR block, parsed and matched by
  `adminWhitelist`'s own `parseWhitelistEntry` and `addressMatchesWhitelist`.
  A bare address is `/32` or `/128`.
- Upstream's wildcards (`AccessControlList::convert`) are taken and turned
  into CIDR: `1.2.*.*` is `1.2.0.0/16`. A `*` that is not a whole trailing
  octet (`1.2*.3.4`, `1.*.3.4`) is refused.
- Kept in `bans.json` with the BZID bans (`server/bans.cjs`): who, until
  when, by whom, why.
- `/ban` takes a player as well as an address, as upstream's does, and bans
  that player's address.

## Where it is checked

- A browser, when it connects, on the address read through the policy.
- A BZFlag client, when it connects and before `MsgEnter`, on its socket's
  address, which needs no proxy trust. Refused with `RejectIPBanned` and
  upstream's `REFUSED:` text.
- Everybody on at the time of a ban.

## Then

- `/poll ban`, which bans the target's address for `banTime`, as upstream's
  (`bzfs.cxx`, the poll's `ban` action).
- `/hostban` (reverse DNS names) and `/masterban` (the list server's shared
  list).
