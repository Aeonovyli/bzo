#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The `trace` pair: a shell's step through teleporters, and a beam's whole
// path through teleporters, off buildings and out at the world's edge.

import assert from 'node:assert/strict';
import { buildTeleporterIndex } from '../public/teleport.mjs';
import { traceBeam, traceShotThroughTeleporters } from '../public/trace.mjs';

const portal = (teleporterIndex, x, z) => ({
  type: 'box', kind: 'teleporter', name: `tp${teleporterIndex}`, teleporterIndex,
  x, z, baseY: 0, rotation: 0, w: 2, d: 9, h: 20, border: 1.12,
});
const a = portal(0, 0, 0);
const b = portal(1, 100, 50);
// Into A's back face (heading +x) and out of B's front face.
const teleports = buildTeleporterIndex([a, b], [{ sourceFaceId: 1, destFaceId: 2 }]);

// A shell steps through A and comes out of B, blocked from going straight back in.
{
  const traced = traceShotThroughTeleporters(teleports, { x: -5, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
  assert.equal(traced.teleports, 1, 'one doorway crossed');
  assert.ok(Math.hypot(traced.point.x - b.x, traced.point.z - b.z) < 10, `comes out by B, at ${JSON.stringify(traced.point)}`);
  assert.equal(traced.reentryBlockTeleporterIndex, 1, 'B cannot take it straight back');
  assert.equal(traced.frameHit, false);
}

// A shell into A's frame stops there.
{
  const traced = traceShotThroughTeleporters(teleports, { x: -5, y: 19.5, z: 0 }, { x: 1, y: 0, z: 0 }, 10);
  assert.equal(traced.frameHit, true, 'the header is a building');
  assert.equal(traced.teleports, 0);
}

// A beam through A carries on from B, and ends at the world's edge (to within
// findMapEdgeImpactPoint's bisection).
{
  const world = { colliders: [a, b], teleports, mapSize: 400 };
  const traced = traceBeam(world, { x: -5, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, 1000, { ricochet: false });
  assert.deepEqual(traced.segments.map((s) => s.end), ['teleport', 'out_of_bounds'], JSON.stringify(traced.segments.map((s) => s.end)));
  assert.ok(Math.abs(Math.abs(traced.segments[1].to.x) - 200) < 2 || Math.abs(Math.abs(traced.segments[1].to.z) - 200) < 2,
    `ends on the edge, at ${JSON.stringify(traced.segments[1].to)}`);
}

// A ricocheting beam bounces off a wall and comes back.
{
  const wall = { type: 'box', name: 'wall', x: 50, z: -100, baseY: 0, rotation: 0, w: 2, d: 40, h: 10 };
  const world = { colliders: [wall], teleports: buildTeleporterIndex([]), mapSize: 400 };
  const traced = traceBeam(world, { x: 0, y: 5, z: -100 }, { x: 1, y: 0, z: 0 }, 200, { ricochet: true });
  assert.equal(traced.segments[0].end, 'obstacle');
  assert.equal(traced.bounces, 1);
  assert.ok(traced.segments[1].to.x < 0, 'heads back the way it came');
  const through = traceBeam(world, { x: 0, y: 5, z: -100 }, { x: 1, y: 0, z: 0 }, 200, { throughBuildings: true });
  assert.equal(through.segments[0].end, 'range', 'through buildings it passes the wall');
}

// The first tank hit ends it.
{
  const world = { colliders: [], teleports: buildTeleporterIndex([]), mapSize: 400 };
  const tank = { id: 7 };
  const traced = traceBeam(world, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 100, {
    findHit: (from, to) => (to.z > 30 ? { point: { x: 0, y: 1, z: 30 }, target: tank } : null),
  });
  assert.equal(traced.hit?.target, tank, JSON.stringify(traced));
}

console.log('test-trace: shell and beam traces pass');
