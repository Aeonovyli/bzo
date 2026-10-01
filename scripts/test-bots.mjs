/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Server-run bots (`server/bots.cjs`): the fill rule, and the driver a bot's
// tank moves by, on an empty world.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planBotFill, pickBotToRemove, BotDriver } = require('../server/bots.cjs');

// The fill: bots make up the roster to `fill`, and none once people do.
assert.equal(planBotFill({ fill: 4, humans: 0, bots: 0 }), 4);
assert.equal(planBotFill({ fill: 4, humans: 1, bots: 3 }), 0);
assert.equal(planBotFill({ fill: 4, humans: 2, bots: 3 }), -1, 'a person joining takes a bot\'s place');
assert.equal(planBotFill({ fill: 4, humans: 1, bots: 2 }), 1, 'a person leaving gives one back');
assert.equal(planBotFill({ fill: 4, humans: 5, bots: 1 }), -1, 'four or more people, no bots');
assert.equal(planBotFill({ fill: 0, humans: 0, bots: 2 }), -2);

// The bot that leaves is on the biggest team.
{
  const sizes = new Map([['red', 3], ['blue', 1]]);
  const chosen = pickBotToRemove([{ id: 'a', team: 'blue' }, { id: 'b', team: 'red' }], sizes);
  assert.equal(chosen.id, 'b');
}

const CONFIG = {
  TANK_SPEED: 25,
  TANK_ROTATION_SPEED: Math.PI / 4,
  GRAVITY: 9.8,
  JUMP_VELOCITY: 19,
  ALLOW_JUMPING: true,
  MAX_BUMP_HEIGHT: 0.33,
};

function makeDriver(think) {
  const sent = [];
  const driver = new BotDriver({
    pilot: { think },
    env: {
      config: () => CONFIG,
      colliders: () => [],
      topOf: () => 0,
      state: () => ({ alive: true, x: 0, y: 0, z: 0, rotation: 0 }),
      view: (self) => ({ self }),
      send: (message) => sent.push(message),
      act: () => {},
    },
  });
  return { driver, sent };
}

// Full speed ahead for a second covers the world's tank speed, northwards, and
// says so on the wire.
{
  const { driver, sent } = makeDriver(() => ({ speed: 1, rotation: 0 }));
  for (let i = 0; i < 20; i++) driver.tick(0.05);
  assert.ok(Math.abs(driver.z + 25) < 0.01, `drove to z=${driver.z}`);
  assert.ok(Math.abs(driver.x) < 1e-9);
  const moves = sent.filter((message) => message.type === 'm');
  assert.ok(moves.length >= 1);
  assert.ok(Math.abs(moves.at(-1).fs - 1) < 0.01, 'fs reports the speed made');
}

// A jump rises and comes down where it left, and reports both ends.
{
  let jumped = false;
  const { driver, sent } = makeDriver(() => {
    const jump = !jumped;
    jumped = true;
    return { speed: 0, rotation: 0, jump };
  });
  let peak = 0;
  for (let i = 0; i < 100; i++) {
    driver.tick(0.05);
    peak = Math.max(peak, driver.y);
  }
  const expected = (CONFIG.JUMP_VELOCITY ** 2) / (2 * CONFIG.GRAVITY);
  assert.ok(Math.abs(peak - expected) < 1.5, `peak ${peak.toFixed(2)} near ${expected.toFixed(2)}`);
  assert.equal(driver.y, 0, 'back on the ground');
  assert.equal(driver.jumpDirection, null);
  const airborne = sent.filter((message) => message.type === 'm' && message.air === 1);
  assert.ok(airborne.length >= 1 && airborne[0].vv > 18, 'the take-off is reported');
}

// A shot leaves the muzzle, after a move that says where from.
{
  const { driver, sent } = makeDriver(() => ({ speed: 0, rotation: 0, fire: true }));
  driver.tick(0.05);
  const shoot = sent.findIndex((message) => message.type === 'shoot');
  assert.ok(shoot > 0 && sent[shoot - 1].type === 'm', 'a move rides ahead of the shot');
  assert.ok(Math.abs(sent[shoot].z + 3) < 1e-9 && Math.abs(sent[shoot].y - 1.57) < 1e-9);
}

console.log('bot tests passed');
