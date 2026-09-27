# Observer

What an observer cannot do yet. AGENTS.md's Observer section is what it does:
the roaming views, how the eye and the roster work, and where bzo deliberately
differs from upstream's `Roaming`.

Nothing here has an issue of its own.

## Switching teams on the live connection

Any team to any team, including in and out of observer and rogue, without
reconnecting. Stock BZFlag has no team switch at all -- `JoinMenu` runs before
the connection exists -- but a page reload is a much worse price than a menu.

Most of it exists: `joinGame` handles a second arrival on the same connection,
reading `previousTeam`, resetting and retiring team flags either side of the
move, resetting the score, and refreshing the voice roster.
`applyXRJoinSelection()` already re-sends it, so the XR Player Options screen
is wired for it today. What is missing is the 2D path, which never re-sends:
`maybeSendPendingJoinRequest()` returns early once `gameplayJoinConfirmed` is
set.

**A join always respawns and zeroes the score, even onto the same team.** That
matches a rejoin upstream, but Player Options carries name, team and tank on
one screen and re-sends all three, so a *tank-only* change costs the player
their position and score. The carried flag already survives it, because the
flag drop keys off `previousTeam !== assignedTeam` rather than off the join.
The fix is for Player Options to route an unchanged team through
`setTankModel`, which touches neither flags nor position.

Also unsettled: switching to observer while alive must not become a way to
dodge an incoming shot. Upstream's answer is the rejoin wait, which bzo has no
equivalent of; losing the score may be disincentive enough.

## Smaller things

- **No target list in XR.** Observers keep upstream's scoreboard order
  (`obsLast`), but the XR menu panel has no list of who to watch, so in a
  headset the cycle and `identify` are the only pickers.
- **`follow` does not reuse the death camera rig** (`render.js`), which is the
  same look-at-a-moving-target shape.
- **`XR_HELP_ITEMS` is one flat frozen list**, so it cannot show the observer
  meanings of grip and A. That wants observer-conditional rows. Issue #27,
  "Rework menus", is closed, so nothing tracks this now.
- **Whether continuous stick yaw is comfortable in XR roam.** It matches what
  bzo already ships when driving; a comfort option is a measurement, not a
  guess.
