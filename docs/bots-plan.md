# Autopilot and bots

Plan for issue #151: upstream's autopilot first, then bots a server launches,
then bots a tutorial sets off. Upstream references are paths under
`$HOME/bzflag/`.

Steps 1 and 2 are built. Everything from step 3 down is a plan.

## What upstream has

- **Autopilot** (`src/bzflag/AutoPilot.cxx`, "Roger"). Client-side only. Each
  frame `doAutoPilot(rotation, speed)` (`playing.cxx:1031`) replaces the
  stick, so the tank moves through ordinary physics. Priority order: drop a
  flag it cannot use, dodge the nearest incoming shot, back off a wall, chase
  the nearest foe, fetch a flag, wander. Then two checks every frame: don't
  drive into water, and fire when the aim is lined up. `teachAutoPilot` scores
  flags by kills minus deaths.
- **Toggle**: key `9`, at most once every five seconds. MsgAutoPilot tells the
  server, which tells everyone ("Roger taking controls"). `-disableBots` kicks
  anyone who turns it on (`bzfs.cxx:2820`).
- **Robots** (`src/bzflag/RobotPlayer.cxx`): extra players run by one client
  over its own connection, with their own region-graph path finding. A
  separate engine from the autopilot.
- **Server-side players** (`bz_ServerSidePlayerHandler`,
  `src/bzfs/ServerSidePlayer.cxx`): a plugin API that has join, spawn,
  `setMovement`, `fireShot`, `jump`, `dropFlag` and event callbacks. The only
  plugin that ships with it (`plugins/serverSidePlayerSample`) just chats.
  Upstream has the plumbing for a server bot but no behaviour for one.

## Step 1: the autopilot (built)

`public/autopilot.mjs` holds two pilots:

- **Roger** is AutoPilot.cxx, decision for decision, in upstream's frame,
  including its quirks. He is the reference.
- **Ace** extends Roger, and is where improvements go. Each one overrides a
  single Roger decision.

Neither reads the client. `think(view)` returns `{ rotation, speed, jump,
fire, dropFlag, targetId, shotTargetId }`. `public/client.js` feeds that
through `gatherDriveInput` and the fire and drop paths, exactly where a stick
would go, so the server's movement checks see an ordinary tank.

**Choosing one**: Settings -> Autopilot is a `pick` row like Hunt. Left and
right step through `None`, `Roger` and `Ace`. Select flies the pilot shown,
and on `None` or the one already flying it lands. `9` toggles the pilot the
row is on. `/autopilot [roger|ace]` picks one by name. The row covers touch
and XR, where there is no `9`.

**The view is the contract a server bot fills in:**

- `now` in seconds. `self`: position, heading, flag and its slot, team colour,
  zoned, in air, whether a shot slot is free.
- `players`: position, velocity, team, alive, paused, flag and slot. `shots`:
  position, velocity, flag, owner. `flags`: slot, type if known, team,
  on ground, position.
- `world` constants. `isFoe`, `myBase`.
- Four probes against the solids a shot meets: `openDistance`, `isObscured`,
  `firstHit` and `firstBuilding`. The client answers them with
  `findShotSegmentImpact` from the `collision` pair plus the world's walls.

**It works through a proxy too.** The browser flies the tank either way; the
proxy forwards MsgAutoPilot both ways and reads `_disableBots` off the target.

**A shot always rides with a move.** Upstream sends a player update before
every shot (`LocalPlayer.cxx:1268`), and bzo does the same for every tank, not
only a piloted one. Without it, a tank that turned since its last move fires
from somewhere the server's extrapolation does not put it, and the shot is
refused as too far from the barrel.

Where Roger differs from upstream, because bzo makes him:

- **Guided Missile lock.** Upstream sets the lock to whoever it is chasing
  (`setTarget`), with no sights check. bzo's server only allows a lock on a
  tank in your sights, so Roger presses Identify just before a GM shot. He
  only fires inside a cone narrower than the lock's, so it takes.
- **No kick.** bzo has no kick, and its own client never asks while
  `DISABLE_BOTS` is set. So the server refuses the request with upstream's
  words instead.
- **Edge of a roof.** Upstream's look-ahead reads a collision point the ray
  never set when it meets nothing. Roger does nothing there.

What Ace changes:

- **Flag memory.** It remembers every flag type it carried or saw someone
  carry, by slot, so it won't drive back over a flag it dropped. On top of
  that it skips a bad flag, a flag it drops, or one its record says is worse
  than average.
- **Home is the base.** Roger drops his own team's flag if the base's x
  coordinate is no more than 2 units below his, which is true across half the
  map. Ace drops it on the base.
- **A team flag goes home first.** Roger chases foes while carrying a flag,
  and a chase that ends on an enemy base captures his own flag there, which
  kills him and his team. Ace drives home, and still fires on the way.
- **Edge of a roof.** With water below it stops; otherwise it halves its
  speed.

### Who counts as a bot

Upstream's: a player that joined as a robot tank (`ComputerPlayer`,
`PlayerInfo::isBot`). Autopilot does not make a player a bot. In bzo that is
the `bot` field of `joinGame`, which `?bot` sets; `scripts/headless-client.mjs`
and `scripts/crowd-client.mjs` always join that way. The list's `players`,
which it sorts on, leaves bots out. The team counts keep them, as upstream's
ping does. A bzo row reports `bots` beside them, and `/list` shows a Bots line
in the row's pane and in the table's heading when there are any. Through a
proxy `?bot` reaches the target too, and the join is a `ComputerPlayer` there
-- except an observer, which bzfs refuses as a robot ("This game is full",
`bzfs.cxx:2333`), so a watching bot enters as a person.

## Step 2: server-launched bots (built)

A bot is a client whose socket never leaves the process. `acceptConnection`
in `server.js` takes it like a browser's, and it joins, moves and shoots with
the messages a browser sends. So validation, anti-cheat, broadcast, scoring
and the list treat it as any player, and nothing about it is special-cased.
`server/bots.cjs` holds what a browser would do for itself: `BotDriver` steps
the tank with the `motion` and `collision` pairs and reports the result as
move packets, and `planBotFill` is the fill rule. `server.js` builds the
pilot's view from its own state and loads `public/autopilot.mjs` with a
dynamic `import()`, so there is one copy of the decisions.

What a bot leaves out, for now: teleporters (it drives through a portal
without teleporting) and flags that change how a tank drives.

`docs/installation.md` has the configuration: `bots.fill`, `bots.pilot` and
`/bot`. The rule is `max(0, fill - people)`, where people are joined players
on a team who are neither server bots nor clients that joined with `?bot`. A
person joining removes a bot from the biggest team, and a person leaving adds
one through the usual team balancing. With no real connection at all, bots
idle: each sends a last stop, then nothing runs until somebody connects.

The plan this was built from, kept for its reasoning: upstream's
`bz_ServerSidePlayerHandler` with Roger or Ace as its brain:

- **Join** through the normal path: a slot, a team and a callsign, marked as a
  bot on the roster so the scoreboard can say so. Respawn on the usual timer.
- **Think** on the server tick. The server builds the view from its own state
  (`players`, projectiles, flags, `OBSTACLES`) and calls the `collision` pair's
  `findShotSegmentImpact`. `server.js` loads `public/autopilot.mjs` with a
  dynamic `import()`, so there is one copy of the decisions and no new pair.
- **Move** with `resolveTankMotion` from the `motion` pair. The bot's own
  updates skip the anti-cheat. Then broadcast as for any other player, and
  shoot and drop through the same functions a packet reaches.
- **Fair information.** The view gets only what a client would get: a
  superflag's type on the ground stays hidden, and the pilot's own flag memory
  is all it knows. Same for stealth and cloak: the view is the place to hide
  what a player couldn't see.
- **Commands**: `/bot add [pilot] [team] [count]` and `/bot remove`, operator
  tier. `-disableBots` blocks them, as upstream's option name ("autopilot or
  robots") says it should.

This is also cheap, realistic test traffic: `scripts/crowd-client.mjs` fakes
packets today, and a few bots would play properly.

## Step 3: tutorial triggers

A map or lesson file names zones and what happens there: "entering this box
spawns a bot at that spawn point, with this skill". Triggers run on the server,
against positions it already validates. Nothing on the client decides
anything. This is the online half of `docs/tutorial-plan.md`'s lessons.

Lessons want a few knobs the pilot doesn't have yet:

- **Skill**: reaction delay, aim error, turn rate. A slow opponent, then a
  faster one.
- **Behaviour**: a stationary target, a patrol, or a chaser.

## Step 4: a smarter bot

Roger stays upstream's; these go into Ace. In order of payoff:

1. **Path finding (started).** `public/nav.mjs`: a grid of 4-unit columns,
   a node for each surface a tank fits on in each, and the only moves that
   change a tank's level -- a step no taller than `_maxBumpHeight`, a drop,
   and a jump -- plus a bridge straight over a gap one column wide, which a
   tank longer than the gap drives across. There are no ramps: a slope holds
   a tank up but is never driven up, pyramid or mesh. Each destination gets
   one backwards search, kept, so a route from anywhere is a walk downhill:
   about 1ms, after about 90ms for a new destination and about 2s for the
   first one in a world, which builds the graph and flies its flights. Ace uses it to
   fetch team flags and the antidote, and to carry a flag home.

   How fast he drives one is measured, not guessed: `npm run bench:pilot`
   (`scripts/bench-pilot.mjs`) runs every base-to-base pair of a map with
   the server bot's physics and Ace's driving strategies side by side --
   `ACE_TUNING` in `public/autopilot.mjs` holds the choices. On hix the
   defaults arrive 12 of 12, in 28 to 41 seconds: the straight line a
   person drives -- jump down onto the box in front of the base, drive off
   it, jump onto the box in front of the other base, and up again.

   That route exists because the graph flies its jumps and drops rather than
   assuming them. From every other column, each of the eight ways, it flies
   a jump and a drive off the edge at three forward speeds -- a flight keeps
   the speed it left with, so the speed is the pilot's one choice -- against
   each column's solid heights, landing on the first surface it comes down
   onto. Routes are priced in seconds, flights by their air time. Ace flies
   one as planned: square to it at its takeoff, at its speed, and with the
   turn for the next leg put on as he leaves, since a tank keeps turning
   through the air.

   Not yet: teleporters; surfaces narrower than a tank, which a person
   drives along hanging over both edges; building off the main thread, which
   the first route on the Orin will feel; and Ace using routes to chase or
   to wander.
   Roger only looks three ways and goes whichever is most open, and stays
   that way.
2. **Aiming.** Lead the target from shot speed instead of a fixed 300ms, and
   use the shot tracer for ricochet bank shots.
3. **Skill knobs.** As in step 3.
4. **Dodging.** Trace each enemy shot against the bot's own planned path,
   rather than reacting to the nearest shot only.
5. **Choosing.** Score each option (threat, flag value, team goal) rather than
   follow a fixed priority list.
6. **Team roles** for capture-the-flag: attack, defend, escort.
7. **Fairness.** Ace sees everything the view holds -- every tank and shot,
   through walls, at any range -- and is meant to be as capable as he can be.
   How hard a bot plays against people is a setting for later: what a player
   in its seat could know (radar and window), going after whoever is winning,
   easing off someone far behind, and all-out for bot-against-bot games.

## Offline play

An offline bot needs kills, flags and scores decided in the browser.
`docs/tutorial-plan.md` stage 4 covers that cost. The pilot itself already
runs in the browser; what is missing is something to rule on what it does.
