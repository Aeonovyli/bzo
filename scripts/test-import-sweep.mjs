#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// `sweepStaleImports` deletes a remote import nobody has asked for again,
// on mtime alone. Hosting a map does not touch its file, so without an
// exception the server would delete the very map it is playing -- quietly,
// because the running match keeps the obstacles it already parsed, and the
// loss only shows up on the next restart as "Map file not found ... Reverting
// to random map".
//
// This holds the exception in place. It reads the function out of server.js
// rather than running it: the sweep reaches the real filesystem and the real
// map registry, and neither belongs in a unit test.

import fs from 'node:fs';

const source = fs.readFileSync('server.js', 'utf8');
const start = source.indexOf('function sweepStaleImports()');
if (start === -1) {
  console.error('FAIL sweepStaleImports is gone -- this test needs rewriting');
  process.exit(1);
}
const body = source.slice(start, source.indexOf('\n}\n', start));

let failures = 0;

if (!/if \(fileName === MAP_SOURCE\) continue;/.test(body)) {
  console.error('FAIL sweepStaleImports does not skip the map named by MAP_SOURCE.');
  console.error('     A server left hosting an imported map will delete it and revert');
  console.error('     to a random map on its next restart.');
  failures += 1;
}

// The skip has to come before the unlink, not merely exist somewhere in it.
const skipAt = body.indexOf('fileName === MAP_SOURCE');
const unlinkAt = body.indexOf('fs.unlinkSync');
if (skipAt !== -1 && unlinkAt !== -1 && skipAt > unlinkAt) {
  console.error('FAIL the MAP_SOURCE check comes after the unlink, so it protects nothing.');
  failures += 1;
}

if (failures > 0) process.exit(1);
console.log('sweepStaleImports leaves the hosted map alone');
