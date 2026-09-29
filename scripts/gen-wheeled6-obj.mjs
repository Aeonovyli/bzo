#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

import * as THREE from 'three';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync } from 'fs';
import { tileTankUVsByPosition } from '../public/tank-uv.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

class OBJBuilder {
  constructor() {
    this.vOffset = 0;
    this.vtOffset = 0;
    this.vnOffset = 0;
    this.out = '';
  }


  // A nav light is a single point, not a surface: it marks where render.js
  // hangs a light on the model and has no geometry of its own. `p -1` is the
  // OBJ spelling for "the vertex just written", which keeps a point
  // independent of how many vertices came before it.
  addComment(text) {
    this.out += `\n# ${text}\n`;
  }

  addPoint(name, x, y, z) {
    this.out += `\no ${name}\n`;
    this.out += `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`;
    this.out += 'p -1\n';
    this.vOffset += 1;
  }

  addObject(name, geo, matNames) {
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const indexed = geo.index !== null;

    this.out += `\no ${name}\n`;

    for (let i = 0; i < pos.count; i += 1) {
      this.out += `v ${pos.getX(i).toFixed(6)} ${pos.getY(i).toFixed(6)} ${pos.getZ(i).toFixed(6)}\n`;
    }
    if (uv) {
      for (let i = 0; i < uv.count; i += 1) {
        this.out += `vt ${uv.getX(i).toFixed(6)} ${uv.getY(i).toFixed(6)}\n`;
      }
    }
    if (nor) {
      for (let i = 0; i < nor.count; i += 1) {
        this.out += `vn ${nor.getX(i).toFixed(6)} ${nor.getY(i).toFixed(6)} ${nor.getZ(i).toFixed(6)}\n`;
      }
    }

    const hasUV = !!uv;
    const hasNor = !!nor;
    const vOff = this.vOffset;
    const vtOff = this.vtOffset;
    const vnOff = this.vnOffset;

    const fRef = (i) => {
      const v = i + 1 + vOff;
      const vt = i + 1 + vtOff;
      const vn = i + 1 + vnOff;
      if (hasUV && hasNor) return `${v}/${vt}/${vn}`;
      if (hasUV) return `${v}/${vt}`;
      if (hasNor) return `${v}//${vn}`;
      return `${v}`;
    };

    const groups = (geo.groups && geo.groups.length > 0)
      ? geo.groups
      : [{ start: 0, count: indexed ? geo.index.count : pos.count, materialIndex: 0 }];

    const useGroups = matNames && matNames.length > 1;
    const indexArr = indexed ? geo.index.array : null;

    for (const group of groups) {
      if (useGroups) {
        const mName = matNames[group.materialIndex] ?? matNames[0];
        this.out += `usemtl ${mName}\n`;
      }
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const a = indexArr ? indexArr[i] : i;
        const b = indexArr ? indexArr[i + 1] : i + 1;
        const c = indexArr ? indexArr[i + 2] : i + 2;
        this.out += `f ${fRef(a)} ${fRef(b)} ${fRef(c)}\n`;
      }
    }

    this.vOffset += pos.count;
    if (uv) this.vtOffset += uv.count;
    if (nor) this.vnOffset += nor.count;
  }

  build() {
    return this.out;
  }
}

function transformedGeometry(geometry, {
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
} = {}) {
  const geo = geometry.clone();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  const position = new THREE.Vector3(x, y, z);
  const scale = new THREE.Vector3(sx, sy, sz);
  matrix.compose(position, quaternion, scale);
  geo.applyMatrix4(matrix);
  geo.computeVertexNormals();
  return geo;
}

function makeBodyGeometry() {
  const profile = new THREE.Shape();
  profile.moveTo(-0.95, 0.12);
  profile.lineTo(0.95, 0.12);
  profile.lineTo(1.48, 0.42);
  profile.lineTo(1.60, 0.72);
  profile.lineTo(1.15, 1.02);
  profile.lineTo(0.25, 1.14);
  profile.lineTo(-0.55, 1.12);
  profile.lineTo(-1.15, 0.95);
  profile.lineTo(-1.55, 0.52);
  profile.lineTo(-1.48, 0.24);
  profile.lineTo(-0.95, 0.12);

  const body = new THREE.ExtrudeGeometry(profile, {
    depth: 6.2,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });

  body.translate(0, 0, -3.1);
  body.computeVertexNormals();
  return body;
}

function makeTurretGeometry() {
  const turretShape = new THREE.Shape();
  turretShape.moveTo(-0.55, 0.0);
  turretShape.lineTo(0.40, 0.0);
  turretShape.lineTo(0.78, 0.22);
  turretShape.lineTo(0.88, 0.48);
  turretShape.lineTo(0.52, 0.74);
  turretShape.lineTo(-0.18, 0.82);
  turretShape.lineTo(-0.72, 0.62);
  turretShape.lineTo(-0.84, 0.28);
  turretShape.lineTo(-0.55, 0.0);

  const turret = new THREE.ExtrudeGeometry(turretShape, {
    depth: 2.45,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 8,
  });

  turret.translate(0, 0, -1.225);
  turret.computeVertexNormals();
  return turret;
}

function makeBarrelGeometry() {
  const barrel = new THREE.CylinderGeometry(0.12, 0.16, 3.5, 12, 1, false);
  barrel.rotateX(Math.PI / 2);
  barrel.computeVertexNormals();
  return barrel;
}

function makeWheelGeometry() {
  const wheel = new THREE.CylinderGeometry(0.62, 0.62, 0.34, 24);
  wheel.rotateZ(Math.PI / 2);
  wheel.computeVertexNormals();
  return wheel;
}

const WHEEL_MATS = ['tread_side', 'tread_cap', 'tread_cap'];

const builder = new OBJBuilder();
builder.out = `# Wheeled6 geometry for BZO
# Generated by scripts/gen-wheeled6-obj.mjs
# Six-wheeled armored car inspired by modern reconnaissance vehicles.
# Naming contract used by render.js template-driven assembly.
`;


// The camo-skinned parts take their texture coordinates from the shared rule
// rather than from whatever the primitive handed back, so a patch is the same
// size on every part of every tank. See public/tank-uv.mjs.
function tileCamo(geometry) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  geometry.setAttribute('uv', new THREE.BufferAttribute(
    tileTankUVsByPosition(position.array, normal ? normal.array : null), 2,
  ));
  return geometry;
}

builder.addObject('body', tileCamo(transformedGeometry(makeBodyGeometry(), { y: 0.18 })));

builder.addObject('turret', tileCamo(transformedGeometry(makeTurretGeometry(), { y: 1.0, z: -0.15 })));
builder.addObject('barrel', transformedGeometry(makeBarrelGeometry(), { y: 1.72, z: -1.68 }));

const wheelZ = [2.1, 0, -2.1];
for (let i = 0; i < wheelZ.length; i += 1) {
  builder.addObject(`leftWheel${i + 1}`, transformedGeometry(makeWheelGeometry(), {
    x: -1.17,
    y: 0.62,
    z: wheelZ[i],
  }), WHEEL_MATS);
  builder.addObject(`rightWheel${i + 1}`, transformedGeometry(makeWheelGeometry(), {
    x: 1.17,
    y: 0.62,
    z: wheelZ[i],
  }), WHEEL_MATS);
}

// The nav lights render.js hangs on the model. Points rather than
// geometry, and last so they cannot disturb a face index.
builder.addComment('Navigation lights. One `p` vertex each, read by the renderer for its');
builder.addComment('position only; see docs/tank-model-format.md.');
builder.addPoint('lightRear', 0.0, 1.82, 1.0);
builder.addPoint('lightPort', -0.7, 1.65, -0.1);
builder.addPoint('lightStarboard', 0.7, 1.65, -0.1);

const objText = builder.build();
const outPath = resolve(__dirname, '../public/obj/wheeled6.obj');
writeFileSync(outPath, objText, 'utf-8');

console.log(`Written: ${outPath}`);
console.log(`Objects: ${(objText.match(/^o /mg) || []).length}`);
console.log(`usemtl groups: ${(objText.match(/^usemtl /mg) || []).length}`);
