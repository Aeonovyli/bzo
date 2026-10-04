/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Where a tank can get to, and how (docs/bots-plan.md, step 4): a route graph
// over the world for a pilot to follow. Upstream has nothing to copy here --
// Roger looks three ways and goes whichever is most open, and RobotPlayer's
// region graph is flat -- so this is bzo's own.
//
// The world is cut into square columns. A column holds a node for every
// surface a tank fits on there: the ground, and each flat top above it. The
// moves between nodes are the only ways a tank changes level in BZFlag, and
// none of them is a ramp -- a slope holds a tank up but is never driven up:
//
//   walk   to a neighbouring column on the same level, or up a step no taller
//          than `_maxBumpHeight`
//   drop   off an edge, to the highest surface below
//   bridge straight over a gap one column wide, which a tank longer than it
//          drives across without falling
//   jump   up onto a surface one jump reaches, from where a full-speed jump
//          comes down on its edge
//
// Teleporters are not followed yet.
//
// Built once per world. The moves are worked out the first time a route is
// asked for, and each destination gets one backwards search, kept; a route
// from anywhere to it is then a walk downhill.

import {
  findTankObstacle,
  getColliderLocalPoint,
  isPyramidFlatTop,
  getPyramidHeight,
  meshFlatTopYsAt,
} from './collision.mjs';

export const NAV_CELL = 4;
const BUCKET = 32;
// A tank standing still, turned any way: a circle a little under its half
// length, which is what a corridor has to fit for a tank to turn in it.
const STAND_RADIUS = 1.6;
// A tank driving, rather than standing, sweeps out to its half length as it
// turns. A node with something solid inside that is tight -- passable, as a
// standing tank fits, but a corner a tank turning round it catches and
// wedges on, as on the ribs of hix's support trusses -- and a route pays to
// pass through one, so it goes round with room where it has the choice.
const TIGHT_RADIUS = 3;
const TIGHT_COST = 0.25;
// Straightening a route: how far ahead it looks, and how often a line is
// sampled.
const SMOOTH_LOOKAHEAD = 40;
const STRAIGHT_SAMPLE = 1;
// The room a straightened leg keeps from anything solid either side of it:
// the tight radius, so it is no closer than the grid route allows itself.
const STRAIGHT_CLEARANCE = TIGHT_RADIUS;
const STEP_UP = 0.33;
// Flights: the forward speeds tried, the step an arc is flown in, how far
// one can reach and how long it can last, the tank's height against what it
// flies over, and the seconds a jump or a drive-off costs to set up -- a jump
// most, since it is taken square and from a standstill, and in the air a tank
// cannot dodge.
const FLIGHT_SPEEDS = [1, 0.6, 0.3];
const FLIGHT_STRIDE = 2;
const FLIGHT_STEP = NAV_CELL / 2;
const FLIGHT_MAX_STEP_SECONDS = 0.1;
// How far above an edge a jumping tank's nose has to be as it gets there.
const JUMP_NOSE_CLEARANCE = 1;
const FLIGHT_REACH = 120;
const FLIGHT_MAX_SECONDS = 6;
const TANK_TALL = 2;
const JUMP_SETUP_SECONDS = 1;
const FLIGHT_SETUP_SECONDS = 0.25;
const BRIDGE_COST = 0.05;
// Fields kept at once, and the longest route walked.
const MAX_FIELDS = 32;
const MAX_ROUTE_NODES = 4000;
// How much a unit of height counts against a unit across, choosing the node a
// point stands on.
const NODE_HEIGHT_WEIGHT = 10;
const NODE_SEARCH_RINGS = 3;
const DIRECTIONS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

// Jumping onto something `rise` up from `edge` away, at a forward speed of
// the tank's own choosing -- a jump keeps whatever speed it left with, so the
// speed is the one thing a jumper decides. Two things must both hold: the
// tank's front reaches the edge only once its underside is above the top, on
// the way up; and it is over the top, `JUMP_LAND_MARGIN` past the edge, before
// it falls back below it. `jump` is { velocity, gravity, tankSpeed }.
export const JUMP_FRONT = 3;
export const JUMP_LAND_MARGIN = 4;

function jumpTimes(jump, rise) {
  const v = jump.velocity;
  const g = jump.gravity;
  const disc = (v * v) - (2 * g * rise);
  if (!(g > 0) || disc < 0) return null;
  const root = Math.sqrt(disc);
  return { up: Math.max(0, (v - root) / g), down: (v + root) / g };
}

// The distances from an edge a jump onto it can be made from, or null where
// none can.
export function jumpRange(jump, rise, longest = Infinity) {
  const times = jumpTimes(jump, rise);
  if (!times) return null;
  const { up, down } = times;
  const min = up > 0
    ? ((JUMP_LAND_MARGIN / down) + (JUMP_FRONT / up)) / ((1 / up) - (1 / down))
    : JUMP_FRONT;
  const max = Math.min((jump.tankSpeed * down) - JUMP_LAND_MARGIN, longest);
  return min <= max ? { min, max } : null;
}

// The forward speed, as a fraction of the tank's, to jump at from `edge` away:
// just enough to land past the margin, with a little to spare. `tooClose` or
// `tooFar` when no speed does it from here.
export function planJump(jump, rise, edge) {
  const times = jumpTimes(jump, rise);
  if (!times) return null;
  const lowest = (edge + JUMP_LAND_MARGIN) / times.down;
  const highest = Math.min(times.up > 0 ? (edge - JUMP_FRONT) / times.up : Infinity, jump.tankSpeed);
  if (lowest > highest) return lowest > jump.tankSpeed ? { tooFar: true } : { tooClose: true };
  const chosen = Math.min(highest, lowest * JUMP_SPEED_SPARE);
  return { speed: chosen / jump.tankSpeed };
}
const JUMP_SPEED_SPARE = 1.1;

// The heights the obstacles over (x, z) fill, a tank's radius out from it, as
// [bottom, top] pairs. A box, a base or a teleporter by its own footprint; a
// pyramid as its whole height; a mesh by its bounds -- generous for both,
// which only ever costs a flight that would have worked.
function solidsAt(obstacles, x, z) {
  const out = [];
  for (const obs of obstacles) {
    if (obs.driveThrough) continue;
    const b = obstacleBounds(obs);
    if (x < b.minX - STAND_RADIUS || x > b.maxX + STAND_RADIUS
      || z < b.minZ - STAND_RADIUS || z > b.maxZ + STAND_RADIUS) continue;
    let bottom = obs.baseY || 0;
    let top;
    if (obs.type === 'mesh') {
      bottom = b.minY ?? bottom;
      top = b.maxY;
    } else {
      const local = getColliderLocalPoint(x, z, obs);
      if (Math.abs(local.x) > (obs.w / 2) + STAND_RADIUS || Math.abs(local.z) > (obs.d / 2) + STAND_RADIUS) continue;
      top = bottom + (obs.type === 'pyramid' ? getPyramidHeight(obs) : (obs.h || 0));
    }
    if (Number.isFinite(top) && top > bottom) out.push([bottom, top]);
  }
  return out;
}

function obstacleBounds(obs) {
  if (obs.bounds) return obs.bounds;
  const reach = Math.hypot(obs.w || 0, obs.d || 0) / 2;
  return { minX: obs.x - reach, maxX: obs.x + reach, minZ: obs.z - reach, maxZ: obs.z + reach };
}

// The flat tops an obstacle offers over (x, z), as heights.
function topsAt(obs, x, z) {
  if (obs.driveThrough || obs.kind === 'teleporter') return [];
  if (obs.type === 'mesh') return meshFlatTopYsAt(obs, x, z);
  const local = getColliderLocalPoint(x, z, obs);
  if (Math.abs(local.x) > obs.w / 2 || Math.abs(local.z) > obs.d / 2) return [];
  if (obs.type === 'pyramid') {
    return isPyramidFlatTop(obs) ? [(obs.baseY || 0) + getPyramidHeight(obs)] : [];
  }
  return [(obs.baseY || 0) + (obs.h || 0)];
}

// `world`: { obstacles, mapSize, waterLevel?, jump: { velocity, gravity,
// tankSpeed } | null }. `jump` null is a world nobody jumps in.
export function buildNavGraph(world) {
  const { obstacles, mapSize } = world;
  const half = mapSize / 2;
  const columns = Math.floor(mapSize / NAV_CELL);
  const origin = -half + (NAV_CELL / 2);
  const water = Number.isFinite(world.waterLevel) ? world.waterLevel : -Infinity;

  // Obstacles by area, so a standing test asks only the ones near it.
  const bucketCount = Math.ceil(mapSize / BUCKET);
  const buckets = Array.from({ length: bucketCount * bucketCount }, () => []);
  const bucketOf = (value) => Math.max(0, Math.min(bucketCount - 1, Math.floor((value + half) / BUCKET)));
  for (const obs of obstacles) {
    const b = obstacleBounds(obs);
    for (let bx = bucketOf(b.minX - STAND_RADIUS); bx <= bucketOf(b.maxX + STAND_RADIUS); bx++) {
      for (let bz = bucketOf(b.minZ - STAND_RADIUS); bz <= bucketOf(b.maxZ + STAND_RADIUS); bz++) {
        buckets[(bz * bucketCount) + bx].push(obs);
      }
    }
  }
  const near = (x, z) => buckets[(bucketOf(z) * bucketCount) + bucketOf(x)];

  // Every node, and each column's nodes from lowest to highest.
  const nodes = [];
  const columnNodes = new Array(columns * columns);
  // The heights each column's obstacles fill, as bottom, top pairs, so an
  // arc through the air asks a lookup rather than a collision test. One
  // packed table for the whole grid: column `c`'s pairs run from
  // `solidStart[c]` to `solidStart[c + 1]`.
  const solidStart = new Int32Array((columns * columns) + 1);
  const solidPairs = [];
  const edgeMargin = STAND_RADIUS + 0.5;
  for (let cz = 0; cz < columns; cz++) {
    for (let cx = 0; cx < columns; cx++) {
      const x = origin + (cx * NAV_CELL);
      const z = origin + (cz * NAV_CELL);
      solidStart[(cz * columns) + cx] = solidPairs.length;
      if (Math.abs(x) > half - edgeMargin || Math.abs(z) > half - edgeMargin) continue;
      const local = near(x, z);
      const levels = new Set([0]);
      for (const obs of local) for (const top of topsAt(obs, x, z)) levels.add(Math.round(top * 100) / 100);
      for (const [bottom, top] of solidsAt(local, x, z)) solidPairs.push(bottom, top);
      const here = [];
      for (const y of [...levels].sort((a, b) => a - b)) {
        if (y <= water) continue;
        if (findTankObstacle(local, x, y + 0.01, z, { radius: STAND_RADIUS })) continue;
        const id = nodes.length;
        nodes.push({ id, cx, cz, x, y, z });
        here.push(id);
      }
      if (here.length) columnNodes[(cz * columns) + cx] = here;
    }
  }
  solidStart[columns * columns] = solidPairs.length;
  const solidData = Float64Array.from(solidPairs);

  const jump = world.jump;
  const tankSpeed = world.tankSpeed ?? jump?.tankSpeed ?? 25;
  const gravity = world.gravity ?? jump?.gravity ?? 9.8;
  const column = (cx, cz) => (cx < 0 || cz < 0 || cx >= columns || cz >= columns
    ? null
    : columnNodes[(cz * columns) + cx] || null);

  // The moves out of a node, worked out the first time a search reaches it
  // and kept: the jump scan is the expensive part of a search, and the world
  // does not change under it. A big map has hundreds of thousands, so they
  // are packed rather than an object each: one row per move across the
  // `move*` arrays, a node's rows running from `moveStart` for `moveCount`,
  // and a flight's details in the `flight*` arrays at the row's `moveFlight`.
  const moveStart = new Int32Array(nodes.length).fill(-1);
  const moveCount = new Uint16Array(nodes.length);
  const moveTable = new PackedRows({ to: Int32Array, cost: Float64Array, kind: Uint8Array, flight: Int32Array });
  const flightTable = new PackedRows({
    speed: Float64Array, dx: Float64Array, dz: Float64Array, launch: Float64Array, air: Float64Array,
  });
  const ensureMoves = (id) => {
    if (moveStart[id] >= 0) return;
    const out = computeMoves(nodes[id]);
    moveStart[id] = moveTable.length;
    moveCount[id] = out.length;
    for (const move of out) {
      let flight = -1;
      if (move.flight) {
        flight = flightTable.length;
        flightTable.push(move.flight.speed, move.flight.dx, move.flight.dz, move.flight.launch, move.flight.air);
      }
      moveTable.push(move.to, move.cost,
        (move.jump ? MOVE_JUMP : 0) | (move.bridge ? MOVE_BRIDGE : 0), flight);
    }
  };
  // A move row as the route reports it.
  const moveStep = (row) => {
    const kind = moveTable.columns.kind[row];
    const f = moveTable.columns.flight[row];
    const flights = flightTable.columns;
    return {
      jump: (kind & MOVE_JUMP) !== 0,
      bridge: (kind & MOVE_BRIDGE) !== 0,
      flight: f < 0 ? null : {
        jump: (kind & MOVE_JUMP) !== 0,
        speed: flights.speed[f],
        dx: flights.dx[f],
        dz: flights.dz[f],
        launch: flights.launch[f],
        air: flights.air[f],
      },
    };
  };
  // Whether a node is tight, asked the first time a move onto it is costed:
  // unknown, no or yes.
  const tightKnown = new Int8Array(nodes.length).fill(-1);
  const tight = (id) => {
    if (tightKnown[id] < 0) {
      const n = nodes[id];
      tightKnown[id] = findTankObstacle(near(n.x, n.z), n.x, n.y + 0.01, n.z, { radius: TIGHT_RADIUS }) ? 1 : 0;
    }
    return tightKnown[id] === 1;
  };
  const computeMoves = (node) => {
    const out = [];
    for (const [dx, dz] of DIRECTIONS) {
      const diagonal = dx !== 0 && dz !== 0;
      const ahead = column(node.cx + dx, node.cz + dz);
      if (ahead) {
        const step = NAV_CELL * (diagonal ? Math.SQRT2 : 1);
        // Same level or a step up: walk. A diagonal may not cut a corner.
        for (const id of ahead) {
          const rise = nodes[id].y - node.y;
          if (rise > STEP_UP || rise < -STEP_UP) continue;
          if (diagonal && !(levelNear(column(node.cx + dx, node.cz), node.y)
            && levelNear(column(node.cx, node.cz + dz), node.y))) continue;
          out.push({ to: id, cost: (step / tankSpeed) + (tight(id) ? TIGHT_COST : 0), jump: false });
        }
      }
      // Across a gap: a tank is held up while any of its box is over a
      // surface, so one longer than the gap drives straight over it. One
      // empty column, open air at this level, to the same level beyond.
      if (!diagonal && !levelNear(ahead, node.y)) {
        const beyond = column(node.cx + (dx * 2), node.cz + (dz * 2));
        const gapX = node.x + (dx * NAV_CELL);
        const gapZ = node.z + (dz * NAV_CELL);
        if (beyond && !findTankObstacle(near(gapX, gapZ), gapX, node.y + 0.01, gapZ, { radius: STAND_RADIUS })) {
          for (const id of beyond) {
            if (Math.abs(nodes[id].y - node.y) > STEP_UP) continue;
            out.push({ to: id, cost: ((2 * NAV_CELL) / tankSpeed) + BRIDGE_COST, jump: false, bridge: true });
          }
        }
      }
      flights(node, dx, dz, out);
    }
    return out;
  };

  // The flights out of a node along one of the eight directions: jumps from
  // where it stands, and drives off the edge ahead, each at a few forward
  // speeds -- a flight keeps the speed it left with, so the speed is the one
  // thing a pilot decides. Each arc is flown against the columns' solids and
  // lands on the first surface it comes down onto; one that runs into
  // anything on the way is no flight. A direction with nothing but the same
  // floor ahead has no flight worth taking and is not flown at all.
  const flights = (node, dx, dz, out) => {
    // Neighbouring columns fly nearly the same arcs, so flights leave from
    // every other column each way, and a route walks to one.
    if (node.cx % FLIGHT_STRIDE !== 0 || node.cz % FLIGHT_STRIDE !== 0) return;
    const length = Math.hypot(dx, dz);
    const ux = dx / length;
    const uz = dz / length;
    const columnAt = (d) => {
      const cx = Math.round((node.x + (ux * d) - origin) / NAV_CELL);
      const cz = Math.round((node.z + (uz * d) - origin) / NAV_CELL);
      return { cx, cz, ids: column(cx, cz), solid: inGrid(cx, cz) ? (cz * columns) + cx : -1 };
    };
    // Where the surface underfoot ends along this line, and whether anything
    // different lies within a flight's reach at all.
    let edge = null;
    let different = false;
    for (let d = FLIGHT_STEP; d <= FLIGHT_REACH; d += FLIGHT_STEP) {
      const { ids } = columnAt(d);
      const level = ids && ids.some((id) => Math.abs(nodes[id].y - node.y) <= STEP_UP);
      if (!level) {
        if (edge === null) edge = d;
        different = true;
        break;
      }
      if (ids.some((id) => Math.abs(nodes[id].y - node.y) > STEP_UP)) different = true;
    }
    if (!different) return;
    const best = new Map();
    const launches = jump ? [false, true] : [false];
    for (const jumping of launches) {
      if (!jumping && edge === null) continue;
      for (const share of FLIGHT_SPEEDS) {
        const u = share * tankSpeed;
        // A drive-off leaves when the tank's back clears the edge; a jump,
        // from where it stands.
        const launch = jumping ? 0 : edge - (NAV_CELL / 2) + JUMP_FRONT;
        const vy = jumping ? jump.velocity : 0;
        // A step across, or a tenth of a second where that is shorter: a
        // slow jump climbs a couple of metres in one step across, which is
        // clean over a floor slab hanging above the takeoff.
        const dt = Math.min(FLIGHT_STEP / u, FLIGHT_MAX_STEP_SECONDS);
        let previous = node.y;
        let landed = null;
        let time = 0;
        for (let t = dt; t <= FLIGHT_MAX_SECONDS; t += dt) {
          const y = node.y + (vy * t) - (0.5 * gravity * t * t);
          const at = columnAt(launch + (u * t));
          if (!inGrid(at.cx, at.cz)) break;
          if (vy - (gravity * t) < 0 && at.ids) {
            for (const id of at.ids) {
              const level = nodes[id].y;
              if (level <= previous + 0.01 && level >= y) landed = id;
            }
          }
          if (landed !== null) {
            time = t;
            break;
          }
          // The tank's front too, half a tank ahead of where its centre is,
          // and with room to spare: a jump onto a box whose centre clears
          // the edge can still meet the box's face with its nose, and one
          // that clears it by a hair from the planned spot does not from a
          // pace further on, which is as close as a pilot takes off.
          const nose = columnAt(launch + (u * t) + JUMP_FRONT);
          if (y < -1 || isBlocked(at.solid, y)
            || (vy - (gravity * t) > 0 && isBlocked(nose.solid, y - JUMP_NOSE_CLEARANCE))) break;
          previous = y;
        }
        if (landed === null || landed === node.id) continue;
        if (!jumping && nodes[landed].y >= node.y - STEP_UP) continue;
        const cost = (launch / u) + time + (jumping ? JUMP_SETUP_SECONDS : FLIGHT_SETUP_SECONDS);
        if ((best.get(landed)?.cost ?? Infinity) <= cost) continue;
        best.set(landed, {
          to: landed,
          cost,
          jump: jumping,
          flight: {
            jump: jumping, speed: share, dx: ux, dz: uz, launch, air: time,
          },
        });
      }
    }
    for (const move of best.values()) out.push(move);
  };

  const inGrid = (cx, cz) => cx >= 0 && cz >= 0 && cx < columns && cz < columns;
  const isBlocked = (cell, bottom) => {
    if (cell < 0) return false;
    for (let i = solidStart[cell]; i < solidStart[cell + 1]; i += 2) {
      if (bottom < solidData[i + 1] - 0.01 && bottom + TANK_TALL > solidData[i]) return true;
    }
    return false;
  };

  function levelNear(ids, y) {
    if (!ids) return false;
    return ids.some((id) => Math.abs(nodes[id].y - y) <= STEP_UP);
  }

  // The node a point is standing on: the surface nearest it, within a column
  // either side. Height counts for far more than distance across, because a
  // surface too narrow for a node of its own in this column -- a bridge, a
  // beam -- still has them in the next, and the ground under it is not where
  // the tank is.
  const nodeAt = (x, y, z) => {
    const cx = Math.round((x - origin) / NAV_CELL);
    const cz = Math.round((z - origin) / NAV_CELL);
    // Ring by ring: a tank against a wall stands where no column fits a
    // node, and the nearest that does may be a couple of columns off.
    let best = null;
    for (let ring = 1; ring <= NODE_SEARCH_RINGS && !best; ring++) {
      for (let ox = -ring; ox <= ring; ox++) {
        for (let oz = -ring; oz <= ring; oz++) {
          const ids = column(cx + ox, cz + oz);
          if (!ids) continue;
          for (const id of ids) {
            const node = nodes[id];
            if (node.y > y + STEP_UP) continue;
            const dist = Math.hypot(node.x - x, node.z - z) + (NODE_HEIGHT_WEIGHT * Math.abs(node.y - y));
            if (!best || dist < best.dist) best = { id, dist };
          }
        }
      }
    }
    return best ? best.id : null;
  };

  // Every move into each node, built the first time a field is asked for:
  // a field searches backwards from its destination. Packed the same way as
  // the moves: node `id`'s run from `start[id]` to `start[id + 1]`.
  let incoming = null;
  const buildIncoming = () => {
    for (let id = 0; id < nodes.length; id++) ensureMoves(id);
    const { to, cost } = moveTable.columns;
    const start = new Int32Array(nodes.length + 1);
    for (let row = 0; row < moveTable.length; row++) start[to[row] + 1]++;
    for (let id = 0; id < nodes.length; id++) start[id + 1] += start[id];
    const from = new Int32Array(moveTable.length);
    const into = new Float64Array(moveTable.length);
    const next = start.slice(0, nodes.length);
    for (let id = 0; id < nodes.length; id++) {
      for (let row = moveStart[id]; row < moveStart[id] + moveCount[id]; row++) {
        const slot = next[to[row]]++;
        from[slot] = id;
        into[slot] = cost[row];
      }
    }
    return { start, from, cost: into };
  };

  // How far every node is from one destination, by the cheapest way there:
  // one backwards search, kept, so following a route from anywhere is a walk
  // downhill rather than a search of its own. Destinations are few -- bases,
  // and flags while they lie still -- and every tank going to one shares it.
  const fields = new Map();
  const fieldTo = (goal) => {
    let field = fields.get(goal);
    if (field) return field;
    if (!incoming) incoming = buildIncoming();
    field = new Float64Array(nodes.length).fill(Infinity);
    const closed = new Uint8Array(nodes.length);
    const open = new MinHeap();
    field[goal] = 0;
    open.push(goal, 0);
    while (open.size) {
      const current = open.pop();
      if (closed[current]) continue;
      closed[current] = 1;
      const base = field[current];
      for (let i = incoming.start[current]; i < incoming.start[current + 1]; i++) {
        const from = incoming.from[i];
        const cost = base + incoming.cost[i];
        if (cost >= field[from]) continue;
        field[from] = cost;
        open.push(from, cost);
      }
    }
    if (fields.size >= MAX_FIELDS) fields.delete(fields.keys().next().value);
    fields.set(goal, field);
    return field;
  };

  // The nodes to drive through from where a tank is to a place, each with
  // whether it is reached by a jump, or null when nothing reaches.
  const findRoute = (from, to) => {
    const start = nodeAt(from.x, from.y, from.z);
    const goal = nodeAt(to.x, to.y, to.z);
    if (start === null || goal === null) return null;
    const field = fieldTo(goal);
    if (!Number.isFinite(field[start])) return null;
    const route = [];
    for (let id = start; id !== goal && route.length < MAX_ROUTE_NODES;) {
      ensureMoves(id);
      const { to, cost } = moveTable.columns;
      let best = -1;
      let bestTotal = Infinity;
      for (let row = moveStart[id]; row < moveStart[id] + moveCount[id]; row++) {
        const total = cost[row] + field[to[row]];
        if (best < 0 || total < bestTotal) {
          best = row;
          bestTotal = total;
        }
      }
      if (best < 0 || !Number.isFinite(bestTotal)) return null;
      id = to[best];
      route.push({ id, x: nodes[id].x, y: nodes[id].y, z: nodes[id].z, ...moveStep(best) });
    }
    return route;
  };

  // Whether a tank drives straight from `a` to `b` on one level: every point
  // along the line is over a column with a node on that level -- floor, room
  // to stand -- and none of them is tight. The line itself is enough: a tank
  // leans out over an edge and stays up. A line through open floor, then,
  // which is what a grid route across a base or a field zigzags over.
  const straightWalk = (a, b) => {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const steps = Math.ceil(Math.hypot(dx, dz) / STRAIGHT_SAMPLE);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (dx * t);
      const z = a.z + (dz * t);
      const ids = column(Math.round((x - origin) / NAV_CELL), Math.round((z - origin) / NAV_CELL));
      if (!ids) return false;
      const level = ids.find((id) => Math.abs(nodes[id].y - a.y) <= STEP_UP);
      if (level === undefined) return false;
      // Clear where the line actually runs, not at the column's centre, which
      // can be two units off it -- enough to shave a rib a column test passes.
      if (findTankObstacle(near(x, z), x, a.y + 0.01, z, { radius: STRAIGHT_CLEARANCE })) return false;
    }
    return true;
  };

  // A route with the zigzag taken out: from each point kept, on to the
  // furthest of the next few that a straight drive reaches. A jump, a drive-off
  // or a gap is kept as planned, and so is the node it leaves from.
  const smoothRoute = (route, from) => {
    if (!route || route.length < 2) return route;
    const startId = nodeAt(from.x, from.y, from.z);
    let anchor = startId === null ? from : nodes[startId];
    const out = [];
    let i = 0;
    while (i < route.length) {
      const node = route[i];
      if (node.jump || node.bridge || node.flight) {
        out.push(node);
        anchor = node;
        i++;
        continue;
      }
      let j = i;
      for (let k = i + 1; k < Math.min(route.length, i + SMOOTH_LOOKAHEAD); k++) {
        const next = route[k];
        if (next.jump || next.bridge || next.flight) break;
        // Where the grid route went close by something it is kept: its many
        // short legs are a curve round it, and a straight leg there is a
        // sharp corner a tank at speed swings wide of, into what it was
        // going round.
        if (tight(route[k - 1].id) || tight(next.id)) break;
        if (Math.abs(next.y - anchor.y) > STEP_UP || !straightWalk(anchor, next)) break;
        j = k;
      }
      out.push(route[j]);
      anchor = route[j];
      i = j + 1;
    }
    return out;
  };

  return { nodes, nodeAt, findRoute, smoothRoute };
}

const MOVE_JUMP = 1;
const MOVE_BRIDGE = 2;

// Rows of numbers, one typed array per column, grown by doubling.
class PackedRows {
  constructor(types) {
    this.length = 0;
    this.capacity = 1024;
    this.names = Object.keys(types);
    this.columns = {};
    for (const name of this.names) this.columns[name] = new types[name](this.capacity);
  }

  push(...values) {
    if (this.length === this.capacity) {
      this.capacity *= 2;
      for (const name of this.names) {
        const grown = new this.columns[name].constructor(this.capacity);
        grown.set(this.columns[name]);
        this.columns[name] = grown;
      }
    }
    for (let i = 0; i < values.length; i++) this.columns[this.names[i]][this.length] = values[i];
    this.length += 1;
  }
}

class MinHeap {
  constructor() {
    this.ids = [];
    this.keys = [];
  }

  get size() {
    return this.ids.length;
  }

  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= keys[i]) break;
      [ids[parent], ids[i]] = [ids[i], ids[parent]];
      [keys[parent], keys[i]] = [keys[i], keys[parent]];
      i = parent;
    }
  }

  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const lastId = ids.pop();
    const lastKey = keys.pop();
    if (ids.length) {
      ids[0] = lastId;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = (2 * i) + 1;
        const r = l + 1;
        let m = i;
        if (l < ids.length && keys[l] < keys[m]) m = l;
        if (r < ids.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [ids[m], ids[i]] = [ids[i], ids[m]];
        [keys[m], keys[i]] = [keys[i], keys[m]];
        i = m;
      }
    }
    return top;
  }
}
