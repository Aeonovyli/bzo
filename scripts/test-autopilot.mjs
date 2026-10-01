/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The autopilots' decisions (`public/autopilot.mjs`) against a hand-built view: an open
// flat world unless a case puts something in it. Headings are bzo's, so 0 faces
// north (-z) and a positive rotation turns left.

import assert from 'node:assert/strict';
import { Ace, Roger, createWorldProbes } from '../public/autopilot.mjs';
import { findShotSegmentImpact } from '../public/collision.mjs';

function makeView(overrides = {}) {
  const view = {
    now: 100,
    self: {
      id: 'me',
      x: 0,
      y: 0,
      z: 0,
      rotation: 0,
      flag: null,
      flagIndex: null,
      flagTeam: null,
      teamColor: 0,
      zoned: false,
      inAir: false,
      canFire: true,
    },
    players: [],
    shots: [],
    flags: [],
    world: {
      allowJumping: true,
      teamFlags: false,
      waterLevel: null,
      shotSpeed: 100,
      maxShots: 1,
      tankHeight: 2.05,
      tankLength: 6,
      jumpVelocity: 19,
      gravity: 9.8,
      lockOnAngle: 0.15,
      shockOutRadius: 60,
    },
    isFoe: () => true,
    myBase: () => null,
    openDistance: () => Infinity,
    isObscured: () => false,
    firstHit: () => null,
    firstBuilding: () => null,
  };
  return {
    ...view,
    ...overrides,
    self: { ...view.self, ...overrides.self },
    world: { ...view.world, ...overrides.world },
  };
}

function enemy(x, z, extra = {}) {
  return {
    id: 'foe', x, y: 0, z, vx: 0, vy: 0, vz: 0, team: 'red',
    alive: true, paused: false, notResponding: false,
    flag: null, flagIndex: null, flagTeam: null, zoned: false, ...extra,
  };
}

// An enemy dead ahead is fired on, and chased at full speed.
{
  const out = new Roger().think(makeView({ players: [enemy(0, -150)] }));
  assert.equal(out.fire, true, 'a foe in the sights is shot');
  assert.equal(out.targetId, 'foe');
  assert.ok(out.speed > 0, 'and driven towards');
  assert.equal(out.shotTargetId, 'foe', 'the shot names who it was fired at');
}

// With a Guided Missile the height gate is off: a foe on a roof is fired on.
{
  const out = new Roger().think(makeView({
    self: { flag: 'GM', flagIndex: 4 },
    players: [enemy(0, -150, { y: 20 })],
  }));
  assert.equal(out.shotTargetId, 'foe');
  const plain = new Roger().think(makeView({ players: [enemy(0, -150, { y: 20 })] }));
  assert.equal(plain.fire, false, 'a normal shot would fly under it');
}

// An enemy off to the west turns the tank left, and is not fired on.
{
  const out = new Roger().think(makeView({ players: [enemy(-100, 0)] }));
  assert.ok(out.rotation > 0, 'west of a north-facing tank is a left turn');
  assert.equal(out.fire, false);
}

// Behind a wall nobody is shot.
{
  const out = new Roger().think(makeView({
    players: [enemy(0, -150)],
    isObscured: () => true,
  }));
  assert.equal(out.fire, false, 'an obscured foe is not fired on');
}

// A teammate is neither chased nor shot.
{
  const out = new Roger().think(makeView({
    players: [enemy(0, -150)],
    isFoe: () => false,
  }));
  assert.equal(out.fire, false);
  assert.equal(out.targetId, null);
}

// A wall close ahead backs the tank off, towards the more open side.
{
  const out = new Roger({ random: () => 0 }).think(makeView({
    openDistance: (_pos, heading) => (Math.abs(heading) < 0.1 ? 2 : (heading > 0 ? 50 : 10)),
  }));
  assert.equal(out.speed, -0.5, 'stuck on a wall reverses');
  assert.equal(out.rotation, 1, 'towards the open left');
}

// Flags Roger cannot use are dropped.
for (const flag of ['US', 'MG', 'ID']) {
  const out = new Roger().think(makeView({ self: { flag, flagIndex: 3 } }));
  assert.equal(out.dropFlag, true, `${flag} is dropped`);
}

// ...and once dropped, a flag whose type is hidden on the ground is still known
// to Ace by the slot it came from, so it does not drive back over it. Roger,
// as upstream's does, drives straight back to it.
{
  const pilot = new Ace();
  pilot.think(makeView({ self: { flag: 'US', flagIndex: 3 } }));
  const ground = { index: 3, type: null, team: null, onGround: true, x: 0, y: 0, z: -20 };
  const out = pilot.think(makeView({ now: 200, self: { rotation: Math.PI / 2 }, flags: [ground] }));
  assert.ok(Math.abs(out.rotation) < 1, 'navigates rather than turning to the flag');
  const fresh = new Ace().think(makeView({
    self: { rotation: Math.PI / 2 },
    flags: [ground],
  }));
  assert.ok(fresh.rotation < -1, 'a pilot that never saw it drives to it');
  const roger = new Roger();
  roger.think(makeView({ self: { flag: 'US', flagIndex: 3 } }));
  const back = roger.think(makeView({ now: 200, self: { rotation: Math.PI / 2 }, flags: [ground] }));
  assert.ok(back.rotation < -1, 'Roger forgets');
}

// A flag seen in someone else's hands is remembered too.
{
  const pilot = new Ace();
  pilot.think(makeView({ players: [enemy(500, 500, { alive: false, flag: 'B', flagIndex: 7 })] }));
  assert.equal(pilot.knownFlagTypes.get(7), 'B');
  assert.equal(pilot.wantsGroundFlag({ index: 7, type: null }), false, 'a bad flag is not wanted');
}

// teachAutoPilot: a flag that keeps dying is no longer worth holding.
{
  const pilot = new Roger();
  pilot.teach('V', 1);
  pilot.teach('QT', -1);
  assert.equal(pilot.isFlagUseful('V'), true);
  assert.equal(pilot.isFlagUseful('QT'), false);
  assert.equal(pilot.isFlagUseful('SB'), true, 'an untried flag is worth a go');
}

// A shot coming straight at the tank is jumped where jumping is allowed.
{
  const shot = { ownerId: 'foe', ownerZoned: false, flag: null, x: 0, y: 1, z: -10, vx: 0, vy: 0, vz: 100 };
  const out = new Roger().think(makeView({ shots: [shot] }));
  assert.equal(out.jump, true);
  const grounded = new Roger().think(makeView({ shots: [shot], world: { allowJumping: false } }));
  assert.equal(grounded.jump, false);
  assert.ok(Math.abs(grounded.rotation) > 1, 'and dodged sideways where it is not');
}

// Water below the edge of a roof stops Ace. Roger's look-ahead has nothing to
// say when it meets nothing.
{
  const view = makeView({ self: { y: 10 }, world: { waterLevel: 1 } });
  assert.equal(new Ace().think(view).speed, 0, 'does not drive off into the water');
  assert.ok(new Roger().think(view).speed > 0);
}

// Carrying its own team's flag: Roger drops it by upstream's x comparison, Ace
// only on the base.
{
  const base = { x: 100, y: 0, z: 0, radius: 15 };
  const view = makeView({
    self: { x: 50, flag: 'G*', flagIndex: 1, flagTeam: 2, teamColor: 2 },
    myBase: () => base,
  });
  assert.equal(new Roger().think(view).dropFlag, true, 'west of its base is home to Roger');
  assert.equal(new Ace().think(view).dropFlag, false, 'Ace drives home first');
  const onBase = makeView({
    self: { x: 95, flag: 'G*', flagIndex: 1, flagTeam: 2, teamColor: 2 },
    myBase: () => base,
  });
  assert.equal(new Ace().think(onBase).dropFlag, true);
}

// Carrying a team flag, Ace heads home rather than after a foe -- but still
// shoots one in its sights. Roger chases.
{
  const base = { x: 0, y: 0, z: 200, radius: 15 };
  const view = makeView({
    self: { flag: 'R*', flagIndex: 0, flagTeam: 1, teamColor: 2 },
    players: [enemy(0, -150)],
    myBase: () => base,
  });
  const ace = new Ace().think(view);
  assert.equal(ace.targetId, null, 'Ace does not chase');
  assert.equal(ace.fire, true, 'but still fires');
  assert.ok(Math.abs(ace.rotation) > 1, 'and turns for home, behind it');
  assert.equal(new Roger().think(view).targetId, 'foe', 'Roger chases');
}

// A jumper, frame by frame: Ace fires once, at the moment that puts the shot on
// the spot as the tank comes down through the muzzle's height. Roger, whose
// trigger skips a tank out of his height band, waits until it is nearly down.
{
  const g = 9.8;
  const jumpVelocity = 19;
  const muzzleHeight = 1.57;
  const shotSpeed = 100;
  const targetZ = -120;
  const frame = 1 / 30;
  const run = (pilot) => {
    const fires = [];
    // Up to just past the landing: a shot that hit would have ended it there.
    for (let t = 0; t < 4.3; t += frame) {
      const y = Math.max(0, (jumpVelocity * t) - (0.5 * g * t * t));
      const airborne = y > 0 || t === 0;
      const view = makeView({
        now: 100 + t,
        self: { muzzleHeight, muzzleForward: 3, shotSpeed },
        world: { tankAngVel: Math.PI / 4 },
        players: [enemy(0, targetZ, {
          y, airborne, gravity: g, vy: airborne ? jumpVelocity - (g * t) : 0,
        })],
      });
      if (pilot.think(view).fire) fires.push(t);
    }
    return fires;
  };
  const fires = run(new Ace());
  assert.equal(fires.length, 1, `one shot for one jump, got ${fires.length}`);
  const landsAt = (2 * jumpVelocity) / g;
  const enterAt = (jumpVelocity + Math.sqrt((jumpVelocity ** 2) - (2 * g * muzzleHeight))) / g;
  const arrival = fires[0] + ((Math.abs(targetZ) - 3 - 2) / shotSpeed);
  assert.ok(arrival >= enterAt - frame && arrival <= landsAt + 0.05,
    `shot arrives at ${arrival.toFixed(3)}s, tank is in its path from ${enterAt.toFixed(3)} to ${landsAt.toFixed(3)}`);
  const roger = run(new Roger());
  assert.ok(roger.length === 0 || roger[0] > fires[0], 'Roger fires later, if at all');
}

// A ricochet that comes straight back: a wall square across Ace's sights, the
// foe beyond its edge in plain view. With ricochet on, the shot would bounce
// off the wall into him, so he holds fire; Roger shoots and finds out.
{
  const wall = { type: 'box', name: 'wall', x: 0, z: -20, w: 60, d: 2, h: 10, baseY: 0, rotation: 0 };
  const probes = createWorldProbes({
    obstacles: () => [wall],
    colliders: () => [wall],
    mapSize: () => 800,
    findImpact: findShotSegmentImpact,
    topOf: (obs) => (obs.baseY || 0) + obs.h,
  });
  const view = (ricochet) => makeView({
    self: { muzzleHeight: 1.57, muzzleForward: 3, shotSpeed: 100, shotLifetime: 3.5, ricochet },
    players: [enemy(0, -150)],
    ...probes,
    isObscured: () => false,
  });
  assert.equal(new Ace().think(view(true)).fire, false, 'Ace holds a shot that would come back');
  assert.equal(new Ace().think(view(false)).fire, true, 'without ricochet it cannot come back');
  assert.equal(new Roger().think(view(true)).fire, true, 'Roger fires anyway');
}

// Capture the flag: holding a good superflag, with a foe 100 away and the red
// flag far off to the east, Ace goes for the flag and Roger for the foe. In
// reach of it, Ace lets go of the superflag to make room.
{
  const redFlag = { index: 0, type: 'R*', team: 1, onGround: true, x: 300, y: 0, z: 0 };
  const view = (x) => makeView({
    self: { x, flag: 'V', flagIndex: 9, teamColor: 2 },
    players: [enemy(x, -100)],
    flags: [redFlag],
    world: { teamFlags: true },
    myBase: () => ({ x: -300, y: 0, z: 0, radius: 15 }),
  });
  const ace = new Ace().think(view(0));
  assert.equal(ace.targetId, null, 'Ace leaves the foe');
  assert.ok(ace.rotation < -1, 'and turns east for the flag');
  assert.equal(new Roger().think(view(0)).targetId, 'foe', 'Roger chases');
  assert.equal(new Ace().think(view(295)).dropFlag, true, 'drops V to take the flag');
}

console.log('autopilot tests passed');
