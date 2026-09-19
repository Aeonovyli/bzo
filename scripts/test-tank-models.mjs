#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The part contract, checked against the models that ship. There is no generic
// tank to fall back on, so a model in public/obj that misses a part is a model
// the picker drops and a player cannot choose -- which is worth catching here
// rather than in play.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  missingTankParts,
  readObjObjectNames,
  tankRunningGear,
} from '../public/tank-parts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const objDir = path.join(__dirname, '..', 'public', 'obj');

// tank.obj is upstream's own single-object mesh, the source split-bzflag-tank
// reads. The server hides it from the picker, so it is not held to the contract.
const HIDDEN = new Set(['tank.obj']);

const offered = readdirSync(objDir)
  .filter((name) => name.toLowerCase().endsWith('.obj'))
  .filter((name) => !HIDDEN.has(name.toLowerCase()));

assert.ok(offered.length > 0, 'public/obj should carry at least one tank model');

for (const fileName of offered) {
  const names = readObjObjectNames(readFileSync(path.join(objDir, fileName), 'utf8'));
  assert.deepEqual(
    missingTankParts(names),
    [],
    `${fileName} is offered in the picker but the renderer cannot build it`,
  );
}

// Upstream's five names are enough on their own -- ltread and rtread stand in
// for all three tread parts on their side.
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'ltread', 'rtread']), []);

// So is a wheeled layout with no treads at all, at whatever wheel count.
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'leftWheel1', 'rightWheel1']), []);
assert.deepEqual(missingTankParts([
  'body', 'turret', 'barrel',
  'wheel_left1', 'wheel_left2', 'wheel_left3',
  'wheel_right1', 'wheel_right2', 'wheel_right3',
]), []);

// A model naming nothing is missing everything, in the words the docs use.
assert.deepEqual(missingTankParts([]), ['body', 'turret', 'barrel', 'treads or wheels on both sides']);

// Blender's default object names carry no roles, which is what a model exported
// without renaming its objects looks like.
assert.deepEqual(
  missingTankParts(['Cube', 'Cube.001', 'Cylinder', 'Sphere', 'Plane']),
  ['body', 'turret', 'barrel', 'treads or wheels on both sides'],
);

// Running gear on one side only is not running gear.
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'ltread']), ['treads or wheels on both sides']);
assert.deepEqual(missingTankParts(['body', 'turret', 'barrel', 'leftWheel1']), ['treads or wheels on both sides']);

// A tread trio split into its own parts is tracked on that side, and one part
// short of the trio is not.
const split = tankRunningGear([
  'leftTreadMiddle', 'leftTreadFrontCap', 'leftTreadRearCap',
  'rightTreadMiddle', 'rightTreadFrontCap',
]);
assert.equal(split.leftTread, true);
assert.equal(split.rightTread, false);

// A loose `l` edge mixed into an otherwise normal object taints the whole
// block: OBJLoader.js builds it as a LineSegments node, not a Mesh, so the
// renderer's `child.isMesh` lookup can never find it. `readObjObjectNames`
// has to drop a part like that the same way it drops one with no faces --
// bzship.obj shipped exactly this defect (four stray `l` lines at the tail
// of its barrel block) and the server offered it anyway because it only
// checked for the name.
const taintedBarrel = [
  'o body',
  'f 1 2 3',
  'o turret',
  'f 1 2 3',
  'o barrel',
  'f 1 2 3',
  'l 1 2',
  'o ltread',
  'f 1 2 3',
  'o rtread',
  'f 1 2 3',
].join('\n');
assert.deepEqual(
  missingTankParts(readObjObjectNames(taintedBarrel)),
  ['barrel'],
  'a barrel block with a stray loose edge should not count as a usable barrel',
);

// public/client.js keeps a hardcoded TANK_MODELS array as the tank it renders
// before /api/tank-models answers (and if that call ever fails), falling back
// to server.js's live directory scan once it does. Nothing else keeps that
// array in sync with public/obj, so a renamed or removed file here would
// silently break the very first frame until the async fetch corrects it.
const clientSource = readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
const arrayLiteral = clientSource.match(/let TANK_MODELS = (\[[\s\S]*?\]);/)?.[1];
assert.ok(arrayLiteral, 'public/client.js should declare a TANK_MODELS fallback array');
const fallbackModels = new Function(`return ${arrayLiteral}`)();

const offeredLower = new Set(offered.map((name) => name.toLowerCase()));
for (const model of fallbackModels) {
  const fileName = path.basename(model.path);
  assert.ok(
    offeredLower.has(fileName.toLowerCase()),
    `client.js fallback model ${model.id} points at ${model.path}, which public/obj no longer offers`,
  );
  assert.equal(
    model.id,
    fileName.slice(0, -path.extname(fileName).length).toLowerCase(),
    `client.js fallback model id ${model.id} does not match the id server.js derives from ${fileName}`,
  );
}

console.log(`tank model parts OK (${offered.join(', ')})`);
