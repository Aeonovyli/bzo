#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Builds public/obj/bzflag-medium.obj and bzflag-low.obj from the BZFlag
// source tree, which is where upstream's tank actually lives.
//
// misc/tank.obj -- which bzflag.obj was made from -- is packaged but never
// read by the client: nothing compiles or loads it. What upstream draws is
// built in C++, one function per part per level of detail, in
// src/geometry/models/tank/. Those functions are immediate-mode OpenGL with
// the geometry written out as literals, so they can be read as data.
//
// Set BZFLAG_SRC to point at a BZFlag checkout; it defaults to ~/bzflag.
//
//   BZFLAG_SRC=~/bzflag node scripts/extract-bzflag-lod-tanks.mjs
//
// The high LOD is deliberately not extracted. bzflag.obj already stands in for
// it, and the point of this is the two cheaper tanks that upstream falls back
// to at distance, which bzo has no equivalent of at all.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = process.env.BZFLAG_SRC || join(homedir(), 'bzflag');
const modelDir = join(srcRoot, 'src/geometry/models/tank');

if (!existsSync(modelDir)) {
  console.error(`No BZFlag tank models at ${modelDir}.`);
  console.error('Set BZFLAG_SRC to a BZFlag checkout.');
  process.exit(1);
}

// TankGeometryMgr.cxx: the medium barrel is the low one. Upstream substitutes
// it rather than building a third, so this does too instead of inventing one.
const LODS = {
  medium: {
    body: 'medium_body.cxx',
    turret: 'medium_turret.cxx',
    barrel: 'low_barrel.cxx',
    ltread: 'medium_ltread.cxx',
    rtread: 'medium_rtread.cxx',
  },
  low: {
    body: 'low_body.cxx',
    turret: 'low_turret.cxx',
    barrel: 'low_barrel.cxx',
    ltread: 'low_ltread.cxx',
    rtread: 'low_rtread.cxx',
  },
};

// The tank is modelled with +X toward the muzzle, +Y to the left and +Z up.
// bzo's models are +X left, +Y up, +Z toward the rear -- the same conversion
// split-bzflag-tank.mjs makes for misc/tank.obj, so the two agree about which
// way a tank faces.
const toBzo = ([x, y, z]) => [-y, z, -x];

// A normal is a direction, so it takes the rotation but not any translation.
// This conversion has no translation in it, so it is the same arithmetic.
const toBzoNormal = toBzo;

const NUMBER = '(-?[0-9]*\\.?[0-9]+(?:e-?[0-9]+)?)f?';
const reNormal = new RegExp(`doNormal3f\\s*\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)`);
const reTexCoord = new RegExp(`doTexCoord2f\\s*\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)`);
const reVertex = new RegExp(`doVertex3f\\s*\\(\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*,\\s*${NUMBER}\\s*\\)`);

// Immediate mode carries the last normal and texcoord forward onto every
// vertex until they are set again, so they are state rather than per-vertex
// data and have to be tracked that way.
function readPart(file) {
  const text = readFileSync(join(modelDir, file), 'utf-8');
  const triangles = [];
  let mode = null;
  let strip = [];
  let normal = [0, 0, 1];
  let texcoord = [0, 0];

  const emitStrip = () => {
    if (mode === 'GL_TRIANGLES') {
      for (let i = 0; i + 2 < strip.length; i += 3) {
        triangles.push([strip[i], strip[i + 1], strip[i + 2]]);
      }
    } else if (mode === 'GL_TRIANGLE_STRIP') {
      // Every vertex after the second closes a triangle with the two before
      // it, and every other one is wound backwards.
      for (let i = 0; i + 2 < strip.length; i += 1) {
        triangles.push(i % 2 === 0
          ? [strip[i], strip[i + 1], strip[i + 2]]
          : [strip[i + 1], strip[i], strip[i + 2]]);
      }
    } else if (mode === 'GL_TRIANGLE_FAN') {
      for (let i = 1; i + 1 < strip.length; i += 1) {
        triangles.push([strip[0], strip[i], strip[i + 1]]);
      }
    }
    strip = [];
    mode = null;
  };

  for (const line of text.split('\n')) {
    const begin = line.match(/glBegin\s*\(\s*(GL_\w+)\s*\)/);
    if (begin) {
      mode = begin[1];
      strip = [];
      continue;
    }
    if (/glEnd\s*\(\s*\)/.test(line)) {
      emitStrip();
      continue;
    }
    if (mode === null) continue;

    const n = line.match(reNormal);
    if (n) {
      normal = toBzoNormal([Number(n[1]), Number(n[2]), Number(n[3])]);
      continue;
    }
    const t = line.match(reTexCoord);
    if (t) {
      texcoord = [Number(t[1]), Number(t[2])];
      continue;
    }
    const v = line.match(reVertex);
    if (v) {
      strip.push({
        position: toBzo([Number(v[1]), Number(v[2]), Number(v[3])]),
        normal,
        texcoord,
      });
    }
  }

  if (triangles.length === 0) throw new Error(`${file} produced no triangles`);
  return triangles;
}

// bzo's own part names, which TANK_PART_ALIASES in client.js matches on.
// `ltread`/`rtread` are the one-piece spelling: they alias to the middle band
// and to both caps at once, which is how render.js recognises a tread that is
// a single casing rather than a band with two caps bolted on.
const PART_NAMES = {
  body: 'body',
  turret: 'turret',
  barrel: 'barrel',
  ltread: 'ltread',
  rtread: 'rtread',
};

// One tread tile per this many world units, matching TREAD_UNITS_PER_TILE in
// render.js. Two copies of the number would let the LOD tanks' tread links
// come out a different size from every other tank's.
const TREAD_UNITS_PER_TILE = 6.4;

// The casing's two materials, in the order render.js binds them: the band the
// tread pattern runs along, then the flat plates on either side of it.
const TREAD_MATERIAL = 'tread';
const TREAD_SIDE_MATERIAL = 'treadSide';

// A face pointing along the tank's width is a side plate; anything else is on
// the belt. Upstream draws the whole casing from one tank skin, so its own
// texture coordinates index an atlas bzo does not have and cannot be reused.
const isSideFace = (normal) => Math.abs(normal[0]) >= Math.max(Math.abs(normal[1]), Math.abs(normal[2]));

// Texture coordinates for one casing.
//
// The belt is a loop, so the pattern has to advance by the same amount per
// unit of track all the way round -- an angle measured about the middle would
// spend most of its range rounding the two ends and bunch the links there.
// So `u` is arc length around the casing's own silhouette: the outline is
// sampled by angle once, turned into a running total of distance, and each
// vertex reads its distance back out of that table. `v` runs across the width.
//
// The side plates are not on the belt and do not move with it. They take a
// flat mapping of the same silhouette, at the same units per tile, and the
// renderer gives them the tread's end texture, which never scrolls.
function casingUVs(triangles) {
  const vertices = triangles.flat();
  const ys = vertices.map((vertex) => vertex.position[1]);
  const zs = vertices.map((vertex) => vertex.position[2]);
  const xs = vertices.map((vertex) => vertex.position[0]);
  const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const centreZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  const minX = Math.min(...xs);
  const widthX = (Math.max(...xs) - minX) || 1;

  // The silhouette, as the furthest point from the middle at each angle.
  const SAMPLES = 180;
  const radius = new Array(SAMPLES).fill(0);
  const angleOf = (y, z) => {
    const a = Math.atan2(y - centreY, z - centreZ);
    return a < 0 ? a + (Math.PI * 2) : a;
  };
  for (const vertex of vertices) {
    const [, y, z] = vertex.position;
    const bucket = Math.min(SAMPLES - 1, Math.floor((angleOf(y, z) / (Math.PI * 2)) * SAMPLES));
    const r = Math.hypot(y - centreY, z - centreZ);
    if (r > radius[bucket]) radius[bucket] = r;
  }
  // A bucket no vertex landed in borrows its neighbours, so the outline has no
  // gaps to integrate across.
  for (let i = 0; i < SAMPLES; i += 1) {
    if (radius[i] > 0) continue;
    let back = i;
    let forward = i;
    while (radius[(back + SAMPLES) % SAMPLES] === 0) back -= 1;
    while (radius[forward % SAMPLES] === 0) forward += 1;
    radius[i] = (radius[(back + SAMPLES) % SAMPLES] + radius[forward % SAMPLES]) / 2;
  }

  // Running total of distance around that outline.
  const arc = new Array(SAMPLES + 1).fill(0);
  const step = (Math.PI * 2) / SAMPLES;
  for (let i = 0; i < SAMPLES; i += 1) {
    const a = i * step;
    const b = (i + 1) * step;
    const ra = radius[i];
    const rb = radius[(i + 1) % SAMPLES];
    const ay = centreY + (ra * Math.sin(a));
    const az = centreZ + (ra * Math.cos(a));
    const by = centreY + (rb * Math.sin(b));
    const bz = centreZ + (rb * Math.cos(b));
    arc[i + 1] = arc[i] + Math.hypot(by - ay, bz - az);
  }

  const distanceAt = (y, z) => {
    const a = angleOf(y, z) / step;
    const i = Math.min(SAMPLES - 1, Math.floor(a));
    return arc[i] + ((arc[i + 1] - arc[i]) * (a - i));
  };

  return (vertex) => {
    const [x, y, z] = vertex.position;
    if (isSideFace(vertex.normal)) {
      return [z / TREAD_UNITS_PER_TILE, y / TREAD_UNITS_PER_TILE];
    }
    return [distanceAt(y, z) / TREAD_UNITS_PER_TILE, (x - minX) / widthX];
  };
}

function buildObj(parts, label) {
  let out = `# BZFlag ${label} tank, extracted from the BZFlag source tree by\n`;
  out += '# scripts/extract-bzflag-lod-tanks.mjs. The geometry is upstream\'s own,\n';
  out += `# from src/geometry/models/tank (BZFlag, LGPL 2.1).\n`;
  let vOffset = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (const [part, triangles] of Object.entries(parts)) {
    const isCasing = part === 'ltread' || part === 'rtread';
    // A casing's texture coordinates are bzo's, not upstream's: upstream draws
    // the whole tank from one skin and its own coordinates index an atlas bzo
    // does not have.
    const uvOf = isCasing ? casingUVs(triangles) : ((vertex) => vertex.texcoord);
    // The belt faces are written first and the side plates after, so each ends
    // up one run of faces the loader can turn into one material group.
    const ordered = isCasing
      ? [...triangles].sort((left, right) =>
        Number(isSideFace(left[0].normal)) - Number(isSideFace(right[0].normal)))
      : triangles;

    out += `\no ${PART_NAMES[part]}\n`;
    const flat = ordered.flat();
    for (const vertex of flat) {
      out += `v ${vertex.position.map((n) => n.toFixed(6)).join(' ')}\n`;
      for (let axis = 0; axis < 3; axis += 1) {
        bounds.min[axis] = Math.min(bounds.min[axis], vertex.position[axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], vertex.position[axis]);
      }
    }
    for (const vertex of flat) out += `vt ${uvOf(vertex).map((n) => n.toFixed(6)).join(' ')}\n`;
    for (const vertex of flat) out += `vn ${vertex.normal.map((n) => n.toFixed(6)).join(' ')}\n`;

    let material = null;
    for (let i = 0; i < ordered.length; i += 1) {
      if (isCasing) {
        const wanted = isSideFace(ordered[i][0].normal) ? TREAD_SIDE_MATERIAL : TREAD_MATERIAL;
        if (wanted !== material) {
          material = wanted;
          out += `usemtl ${material}\n`;
        }
      }
      const a = vOffset + (i * 3) + 1;
      out += `f ${a}/${a}/${a} ${a + 1}/${a + 1}/${a + 1} ${a + 2}/${a + 2}/${a + 2}\n`;
    }
    vOffset += flat.length;
  }

  return { out, bounds, vOffset };
}

for (const [label, files] of Object.entries(LODS)) {
  const parts = {};
  for (const [part, file] of Object.entries(files)) parts[part] = readPart(file);
  const { out, bounds, vOffset } = buildObj(parts, label);

  // The nav lights bzo hangs on every tank. Upstream draws these from
  // TankSceneNode rather than from the model, so there is nothing to extract
  // and they are placed here -- resting on the deck in their own column, which
  // is what test-tank-models.mjs measures. A light sunk into the hull is
  // depth-tested away and one floating over it reads as detached.
  const CLEARANCE = 0.03;
  const surfaceUnder = (x, z) => {
    let best = null;
    for (const triangle of Object.values(parts).flat()) {
      const [a, b, c] = triangle.map((vertex) => vertex.position);
      // Barycentric containment in the XZ plane, then the plane's height there.
      const d = ((b[2] - c[2]) * (a[0] - c[0])) + ((c[0] - b[0]) * (a[2] - c[2]));
      if (Math.abs(d) < 1e-9) continue;
      const u = (((b[2] - c[2]) * (x - c[0])) + ((c[0] - b[0]) * (z - c[2]))) / d;
      const v = (((c[2] - a[2]) * (x - c[0])) + ((a[0] - c[0]) * (z - c[2]))) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
      const y = (u * a[1]) + (v * b[1]) + (w * c[1]);
      if (best === null || y > best) best = y;
    }
    return best;
  };

  let text = out;
  text += '\n# Navigation lights. One `p` vertex each, read by the renderer for its\n';
  text += '# position only; see docs/tank-model-format.md.\n';
  const light = (name, x, z) => {
    const surface = surfaceUnder(x, z);
    if (surface === null) throw new Error(`${label}: ${name} at ${x},${z} is over empty space`);
    const y = surface + CLEARANCE;
    text += `\no ${name}\nv ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\np -1\n`;
  };
  const halfWidth = Math.max(Math.abs(bounds.min[0]), Math.abs(bounds.max[0]));
  const rear = bounds.max[2];
  // Aft on the centreline, and one on each side of the deck. Port is -X and
  // starboard +X, which is the tank's own left and right given it faces -Z.
  light('lightRear', 0, rear * 0.75);
  light('lightPort', -halfWidth * 0.55, -0.1);
  light('lightStarboard', halfWidth * 0.55, -0.1);

  const path = resolve(__dirname, `../public/obj/bzflag-${label}.obj`);
  writeFileSync(path, `${text}\n`, 'utf-8');
  const size = bounds.max.map((max, axis) => (max - bounds.min[axis]).toFixed(2));
  console.log(`${label}: ${vOffset} vertices, ${vOffset / 3} triangles, `
    + `w ${size[0]} h ${size[1]} len ${size[2]} -> ${path}`);
}
