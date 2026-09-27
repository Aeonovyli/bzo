import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  MAX_SHOT_SLOTS,
  normalizeShotSlotCount,
  WORLD_WEAPON_PLAYER_ID,
  WORLD_WEAPON_NAME,
  WORLD_WEAPON_TEAM,
  WORLD_WEAPON_DEFAULT_DELAY,
  WORLD_WEAPON_MIN_DELAY,
  normalizeWorldWeaponDelays,
  getWorldWeaponDirection,
  SHOT_TAP_SPACING_MS,
  getWorldReloadSeconds,
  getSlotReloadSeconds,
  findFreeShotSlot,
  getShotSlotProgress,
} from '../public/shots.mjs';

const require = createRequire(import.meta.url);
const serverLimits = require('../server/shots.cjs');

assert.equal(MAX_SHOT_SLOTS, 64);
assert.equal(serverLimits.MAX_SHOT_SLOTS, MAX_SHOT_SLOTS);
assert.equal(normalizeShotSlotCount(1), 1);
assert.equal(normalizeShotSlotCount(3), 3);
assert.equal(normalizeShotSlotCount('3'), 3);
assert.equal(normalizeShotSlotCount(MAX_SHOT_SLOTS), MAX_SHOT_SLOTS);
assert.equal(normalizeShotSlotCount(MAX_SHOT_SLOTS + 1), MAX_SHOT_SLOTS);
// `-ms 0` is upstream's "tanks cannot shoot", so zero is a count like any
// other. Only a negative one is clamped, which is upstream's own split.
assert.equal(normalizeShotSlotCount(0), 0);
assert.equal(normalizeShotSlotCount('0'), 0);
assert.equal(normalizeShotSlotCount(-1), 1);
assert.equal(normalizeShotSlotCount(1.5), 1);
assert.equal(normalizeShotSlotCount(Number.POSITIVE_INFINITY), 1);
assert.equal(normalizeShotSlotCount(Number.MAX_SAFE_INTEGER + 1), 1);
// Absence is not a stated zero, even though `Number` turns all of these into
// one: a missing setting still means one shot.
assert.equal(normalizeShotSlotCount(null), 1);
assert.equal(normalizeShotSlotCount(undefined), 1);
assert.equal(normalizeShotSlotCount(''), 1);
assert.equal(normalizeShotSlotCount('   '), 1);
assert.equal(normalizeShotSlotCount(false), 1);

for (const value of [1, 3, '3', MAX_SHOT_SLOTS, MAX_SHOT_SLOTS + 1, 0, '0', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined, '', '   ', false]) {
  assert.equal(
    serverLimits.normalizeShotSlotCount(value),
    normalizeShotSlotCount(value),
    `client/server normalization diverged for ${String(value)}`
  );
}

// --- World weapons -----------------------------------------------------------
{
  // PlayerId ServerPlayer (Address.h:75), which is what upstream stamps on every
  // shot nobody fired -- 253, and not the 252 next to it, which is the admin
  // channel.
  assert.equal(WORLD_WEAPON_PLAYER_ID, 253);
  assert.equal(serverLimits.WORLD_WEAPON_PLAYER_ID, WORLD_WEAPON_PLAYER_ID);

  // CustomWeapon's defaults and its floor on a delay.
  assert.equal(WORLD_WEAPON_DEFAULT_DELAY, 10);
  assert.equal(WORLD_WEAPON_MIN_DELAY, 0.1);
  assert.deepEqual(normalizeWorldWeaponDelays([]), [10], 'no delay is ten seconds');
  assert.deepEqual(normalizeWorldWeaponDelays(undefined), [10]);
  assert.deepEqual(normalizeWorldWeaponDelays(['6']), [6], 'stated as text in a BZW');
  assert.deepEqual(normalizeWorldWeaponDelays([2, 1, 3]), [2, 1, 3], 'a rhythm, not a rate');
  // Under the floor is dropped, and dropping every entry leaves the default.
  assert.deepEqual(normalizeWorldWeaponDelays([0.05, 4]), [4]);
  assert.deepEqual(normalizeWorldWeaponDelays([0.05]), [10]);
  assert.deepEqual(normalizeWorldWeaponDelays([0.1]), [0.1], 'the floor itself is allowed');
  assert.deepEqual(normalizeWorldWeaponDelays(['x', -3, null]), [10]);

  // WorldPlayer's collective identity: one pseudo-player for every world weapon
  // on the map, on the rogue team, and no name per weapon because a BZW cannot
  // give one.
  assert.equal(WORLD_WEAPON_NAME, 'world weapon');
  assert.equal(WORLD_WEAPON_TEAM, 'rogue');
  assert.equal(serverLimits.WORLD_WEAPON_NAME, WORLD_WEAPON_NAME);
  assert.equal(serverLimits.WORLD_WEAPON_TEAM, WORLD_WEAPON_TEAM);

  // bz_vectorFromRotations, in bzo's axes. A weapon at rotation 0 fires along
  // BZFlag +x, which is bzo +x.
  const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} != ${b}`);
  const east = getWorldWeaponDirection(0, 0);
  close(east.x, 1, 'rotation 0 is +x');
  close(east.y, 0, 'and level');
  close(east.z, 0, 'and nothing across');

  // BZFlag +y is north, which is bzo -z, so rotation 90 fires at bzo -z. That is
  // what aims `fountains.bzw`'s lasers down the length of the map: the one at
  // BZW y -190 has rotation 90 and has to fire towards the middle.
  const north = getWorldWeaponDirection(Math.PI / 2, 0);
  close(north.x, 0, 'rotation 90 has nothing along x');
  close(north.z, -1, 'and fires towards bzo -z');
  const south = getWorldWeaponDirection(3 * Math.PI / 2, 0);
  close(south.z, 1, 'rotation 270 fires the other way');
  const west = getWorldWeaponDirection(Math.PI, 0);
  close(west.x, -1, 'rotation 180 is -x');

  // Tilt is the vertical angle, and it is bzo's +y.
  const up = getWorldWeaponDirection(0, Math.PI / 2);
  close(up.y, 1, 'straight up');
  close(up.x, 0, 'with nothing left along the ground');
  const half = getWorldWeaponDirection(0, Math.PI / 4);
  close(half.y, Math.SQRT1_2, 'and a unit vector at any tilt');
  close(half.x, Math.SQRT1_2);
  for (const [rotation, tilt] of [[0, 0], [1, 0.3], [2.5, -0.7], [Math.PI, 1.2]]) {
    const dir = getWorldWeaponDirection(rotation, tilt);
    close(Math.hypot(dir.x, dir.y, dir.z), 1, `unit length at ${rotation}/${tilt}`);
    assert.deepEqual(serverLimits.getWorldWeaponDirection(rotation, tilt), dir,
      'client/server weapon aim diverged');
  }
}

// --- Shot slots as a clock ---------------------------------------------------
{
  // `_reloadTime` defaults to `_shotRange / _shotSpeed` (global.cxx:127), and a
  // map that states its own replaces the whole basis.
  assert.equal(getWorldReloadSeconds({ SHOT_RANGE: 350, SHOT_SPEED: 100 }), 3.5);
  assert.equal(getWorldReloadSeconds({ SHOT_DISTANCE: 350, SHOT_SPEED: 100 }), 3.5,
    'SHOT_DISTANCE is the same number under the client/radar name');
  assert.equal(
    getWorldReloadSeconds({ SHOT_RANGE: 350, SHOT_SPEED: 100, SHOT_LIFETIME: 7000 }), 7,
    "a map's own _reloadTime replaces the derived basis");
  assert.equal(getWorldReloadSeconds({}), 3.5, 'upstream defaults when nothing is stated');
  assert.equal(serverLimits.getWorldReloadSeconds({ SHOT_RANGE: 350, SHOT_SPEED: 100 }), 3.5);

  // `setReloadTime(reload / adRate)`. Rapid Fire's slots come back twice as
  // fast, Laser's half as fast -- `_laserAdRate` is 0.5, which is a *slower*
  // reload, and getting that backwards is the whole reason this is a test.
  assert.equal(getSlotReloadSeconds(3.5, 2), 1.75, 'F reloads twice as fast');
  assert.equal(getSlotReloadSeconds(3.5, 0.5), 7, 'L reloads half as fast');
  assert.equal(getSlotReloadSeconds(3.5, 1), 3.5, 'an ordinary shot is the world reload');
  assert.equal(getSlotReloadSeconds(3.5, 0), 3.5, 'a rate of zero is no scaling, not a divide by zero');
  assert.equal(serverLimits.getSlotReloadSeconds(3.5, 12), getSlotReloadSeconds(3.5, 12),
    'client/server slot reload diverged');

  // An untouched slot is free, and slots are handed out lowest first.
  assert.equal(findFreeShotSlot([], 3, 1000), 0);
  assert.equal(findFreeShotSlot([2000], 3, 1000), 1, 'slot 0 is still reloading');
  assert.equal(findFreeShotSlot([2000, 2000, 2000], 3, 1000), -1, 'every slot is busy');
  assert.equal(findFreeShotSlot([2000, 2000, 2000], 3, 2000), 0,
    'a slot is free the instant its reload is up, not a tick later');
  assert.equal(findFreeShotSlot([500], 3, 1000), 0, 'a reload already past frees the slot');
  assert.equal(findFreeShotSlot([9e9, 9e9], 0, 1000), -1, '-ms 0 has no slot to find');
  assert.equal(serverLimits.findFreeShotSlot([2000], 3, 1000), 1,
    'client/server slot search diverged');

  // The shell is not the slot. Firing fills the slot for a full reload, and
  // nothing that happens to the shell afterwards shortens it -- which is the
  // behaviour issue #141 is about: upstream reaps a slot on `isReloaded()` and
  // never on `isExpired()`, and bzfs's `removeShot` leaves `expireTime` alone.
  const slots = [];
  slots[0] = 1000 + (getSlotReloadSeconds(3.5, 1) * 1000);
  assert.equal(findFreeShotSlot(slots, 1, 1200), -1,
    'a shot that stopped early does not hand its slot back');
  assert.equal(findFreeShotSlot(slots, 1, 4500), 0, 'the slot comes back on its own reload');

  // The bars beside the control box: full when free, and filling across the
  // slot's own reload rather than the shell's flight.
  assert.equal(getShotSlotProgress([], 0, 3500, 1000), 1, 'a slot never fired reads full');
  assert.equal(getShotSlotProgress([4500], 0, 3500, 1000), 0, 'just fired reads empty');
  assert.equal(getShotSlotProgress([4500], 0, 3500, 2750), 0.5, 'half way through the reload');
  assert.equal(getShotSlotProgress([4500], 0, 3500, 4500), 1, 'and full again when it is up');
  assert.equal(getShotSlotProgress([4500], 0, 0, 1000), 1, 'no reload to wait out');

  // bzo's own floor on the tap path, which upstream has no equivalent of --
  // its BZDB table carries `_reloadTime` and the per-flag rates and nothing
  // about the trigger. Client-side only, so it is deliberately absent from the
  // server copy.
  assert.equal(SHOT_TAP_SPACING_MS, 100);
  assert.equal(serverLimits.SHOT_TAP_SPACING_MS, undefined,
    'the tap floor is input ergonomics and is never enforced on the wire');
}

console.log('Shot slot limit tests passed');
