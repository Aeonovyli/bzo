/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The route graph (`public/nav.mjs`) on small built worlds: what it walks,
// what it jumps, and what it leaves alone.

import assert from 'node:assert/strict';
import { buildNavGraph } from '../public/nav.mjs';

const JUMP = { velocity: 19, gravity: 9.8, tankSpeed: 25 };
const box = (name, x, z, w, d, h, baseY = 0) => ({
  type: 'box', name, x, z, w, d, h, baseY, rotation: 0,
  bounds: { minX: x - (w / 2), maxX: x + (w / 2), minY: baseY, maxY: baseY + h, minZ: z - (d / 2), maxZ: z + (d / 2) },
});

// Flat ground: a route goes straight there, on the ground, with no jump.
{
  const nav = buildNavGraph({ obstacles: [], mapSize: 200, jump: JUMP });
  const route = nav.findRoute({ x: -60, y: 0, z: 0 }, { x: 60, y: 0, z: 0 });
  assert.ok(route && route.length > 20);
  assert.ok(route.every((node) => node.y === 0 && !node.jump));
}

// A wall in the way is gone round.
{
  const nav = buildNavGraph({ obstacles: [box('wall', 0, 0, 4, 120, 20)], mapSize: 200, jump: null });
  const route = nav.findRoute({ x: -40, y: 0, z: 0 }, { x: 40, y: 0, z: 0 });
  assert.ok(route, 'there is a way round');
  assert.ok(route.some((node) => Math.abs(node.z) > 60), 'and it goes round the end');
}

// A platform one jump reaches is jumped onto; one too high is not reached.
{
  const low = buildNavGraph({ obstacles: [box('deck', 0, 0, 40, 40, 10)], mapSize: 200, jump: JUMP });
  const up = low.findRoute({ x: -80, y: 0, z: 0 }, { x: 0, y: 10, z: 0 });
  assert.ok(up, 'a 10-high deck is reached');
  assert.equal(up.filter((node) => node.jump).length, 1, 'with one jump');
  assert.equal(up.at(-1).y, 10);
  const down = low.findRoute({ x: 0, y: 10, z: 0 }, { x: -80, y: 0, z: 0 });
  assert.ok(down && down.every((node) => !node.jump), 'and left by driving off it');

  const high = buildNavGraph({ obstacles: [box('tower', 0, 0, 40, 40, 30)], mapSize: 200, jump: JUMP });
  assert.equal(high.findRoute({ x: -80, y: 0, z: 0 }, { x: 0, y: 30, z: 0 }), null, 'a 30-high tower is not');

  const grounded = buildNavGraph({ obstacles: [box('deck', 0, 0, 40, 40, 10)], mapSize: 200, jump: null });
  assert.equal(grounded.findRoute({ x: -80, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }), null, 'nor anything, with no jumping');
}

// Two steps up: a jump to a ledge, and another from the ledge.
{
  const nav = buildNavGraph({
    obstacles: [box('ledge', 0, 0, 80, 80, 12), box('top', 0, 0, 30, 30, 12, 12)],
    mapSize: 300,
    jump: JUMP,
  });
  const route = nav.findRoute({ x: -120, y: 0, z: 0 }, { x: 0, y: 24, z: 0 });
  assert.ok(route, 'the top is reached');
  assert.equal(route.filter((node) => node.jump).length, 2);
}

// A step no taller than a bump is driven up.
{
  const nav = buildNavGraph({ obstacles: [box('kerb', 0, 0, 40, 40, 0.3)], mapSize: 200, jump: null });
  const route = nav.findRoute({ x: -60, y: 0, z: 0 }, { x: 0, y: 0.3, z: 0 });
  assert.ok(route && route.every((node) => !node.jump));
}

// A gap narrower than a tank, between a walkway and a deck at the same height,
// is driven across rather than dropped into. A wide one is not.
{
  const narrow = buildNavGraph({
    obstacles: [box('walk', -30, 0, 52, 8, 2, 20), box('deck', 26, 0, 52, 52, 2, 20)],
    mapSize: 200,
    jump: null,
  });
  const across = narrow.findRoute({ x: -50, y: 22, z: 0 }, { x: 30, y: 22, z: 0 });
  assert.ok(across, 'the deck is reached from the walkway');
  assert.ok(across.every((node) => node.y === 22), 'without leaving the level');
  assert.ok(across.some((node) => node.bridge), 'by a bridge');

  const wide = buildNavGraph({
    obstacles: [box('walk', -34, 0, 52, 8, 2, 20), box('deck', 32, 0, 52, 52, 2, 20)],
    mapSize: 200,
    jump: null,
  });
  assert.equal(wide.findRoute({ x: -50, y: 22, z: 0 }, { x: 30, y: 22, z: 0 }), null, 'a gap wider than a tank is not');
}

console.log('nav tests passed');
