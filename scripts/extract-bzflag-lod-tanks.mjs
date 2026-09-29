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
const PART_NAMES = {
  body: 'body',
  turret: 'turret',
  barrel: 'barrel',
  ltread: 'ltread',
  rtread: 'rtread',
};

function buildObj(parts, label) {
  let out = `# BZFlag ${label} tank, extracted from the BZFlag source tree by\n`;
  out += '# scripts/extract-bzflag-lod-tanks.mjs. The geometry is upstream\'s own,\n';
  out += `# from src/geometry/models/tank (BZFlag, LGPL 2.1).\n`;
  let vOffset = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  for (const [part, triangles] of Object.entries(parts)) {
    out += `\no ${PART_NAMES[part]}\n`;
    const flat = triangles.flat();
    for (const vertex of flat) {
      out += `v ${vertex.position.map((n) => n.toFixed(6)).join(' ')}\n`;
      for (let axis = 0; axis < 3; axis += 1) {
        bounds.min[axis] = Math.min(bounds.min[axis], vertex.position[axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], vertex.position[axis]);
      }
    }
    for (const vertex of flat) out += `vt ${vertex.texcoord.map((n) => n.toFixed(6)).join(' ')}\n`;
    for (const vertex of flat) out += `vn ${vertex.normal.map((n) => n.toFixed(6)).join(' ')}\n`;
    for (let i = 0; i < flat.length; i += 3) {
      const a = vOffset + i + 1;
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
