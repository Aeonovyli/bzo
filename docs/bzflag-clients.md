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
- **The world** comes from bzfs itself: `bzfs -world <map> -cacheout` writes
  the binary a client downloads. So only a map with a `.bzw` file, and only
  where bzfs is installed; anywhere else a join is turned away with the link
  to play in a browser.

## What doesn't yet

1. **Playing.** A BZFlag client decides its own deaths and bzo's server
   decides hits, so a native player's reports have to be checked rather than
   trusted. A native client also doesn't reconnect by itself when the server
   restarts.
2. **Sign-in.** A native client sends its token with `MsgEnter`;
   `checkGlobalToken` will check it.
3. **A world without bzfs.** Writing BZFlag's world format in JS, checked
   against what `-cacheout` writes.
