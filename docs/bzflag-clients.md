# BZFlag clients

Issue #174: native BZFlag clients on a bzo server. Configured by server.json's
`bzflag` block ([installation.md](installation.md)); the code is
`server/bzflag-server.cjs`.

## What works

- **The port.** bzo answers on `listen` as bzfs does on its game port: the
  `BZFLAG\r\n\r\n` handshake, `MsgQueryGame`, `MsgQueryPlayers`, and the UDP
  ping. A server browser, `bzfquery` and the list server's check all get
  their answers.
- **The list.** bzo adds itself to my.bzflag.org with the `bzfs` key, on
  start, on every join and part, and every 15 minutes, and removes itself on
  shutdown. The request goes over IPv4, since the list checks that
  `publicAddr` resolves to the address it came from.
- **The counts.** They follow bzfs's ping: humans only, the rabbit and hunters
  counted as rogues.

- **Watching.** A client that joins goes through bzfs's own sequence
  (`MsgNegotiateFlags`, `MsgWantSettings`, `MsgWantWHash`, `MsgGetWorld`,
  `MsgEnter`) and is seated as an observer, whatever team it asked for. It
  becomes an ordinary bzo player through the door a bot uses: its socket's
  `send` is `server/bzflag-native.cjs`, which turns bzo's messages into
  bzfs's -- roster, moves, spawns, deaths, shots, flags, chat, scores, the
  rabbit and the clock. Its chat reaches bzo's players.
- **The world** is compiled from the map's `.bzw` by
  `server/bzw-compile.cjs`, which follows bzfs's own reader and obstacle
  code, drawInfo meshes included, and is packed by
  `server/bzflag-world.cjs`. `npm run test:bzflag-world` holds every map in
  `maps/` to bzfs's own `-cacheout` output byte for byte where bzfs is
  installed. A construct the compiler cannot reproduce (a tinted group
  instance placing an arc, cone, sphere or tetra) falls back to bzfs
  `-cacheout`, and is turned away where bzfs is not installed. A generated
  world has no `.bzw` and is turned away.
- **Downloading it over HTTPS.** bzo sends `MsgCacheURL`, as bzfs does with
  `-cacheurl` or its `fastmap` plugin, naming its own copy at
  `<publicUrl>/bzflag/world/<md5>.bwc`. The client fetches that, checks its
  MD5 against the world hash, and falls back to `MsgGetWorld`, a kilobyte a
  round trip, if it can't. `cacheUrl` in the `bzflag` block names another URL,
  or `false` turns it off. The hash matches bzfs's for the same map, so a
  world cached from either serves both.
- **The game clock.** `MsgGameTime` at the handshake and then every second,
  stretching to every ten, as bzfs sends it; the client's texture
  animations and drawInfo spins run on it.
- **The version.** bzo calls itself `bzo-<release>-<build>` where bzfs gives
  its own version: the list server's `build` and `/serverquery`.
- **Sign-in.** The token a client sends with `MsgEnter` is checked with
  bzflag.org (`checkGlobalToken`) before it is seated, as bzfs checks every
  callsign. A good one gives the player its BZID, global callsign and admin
  groups, as a browser login does, and each answer is said in bzfs's words:
  "Global login approved!", "Global login rejected, bad token.", or "This
  callsign is not registered." Unlike bzfs, the check leaves out the
  player's address, as the browser login does. The login is a session, as a
  browser's is, removed when the client leaves; so the same account joining
  from a browser too is a second device, and the newer one wins.

A restart, which a map change is in bzo, drops every native client, and it
has to rejoin: bzfs does the same, and the client has no reconnect of its
own. Browsers rejoin by themselves; a BZFlag client does not.

## What doesn't yet

1. **Playing.** A BZFlag client decides its own deaths and bzo's server
   decides hits, so a native player's reports have to be checked rather than
   trusted.
