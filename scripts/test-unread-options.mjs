#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// A map's `options` block has two readers -- `parseBZWServerOptions` in
// server.js and `parseBZWTeamMode` in server/teams.cjs -- and the first one
// reports the options neither of them claimed. It can only do that if it
// knows what the second claims, which is a list written out by hand in
// server.js as `TEAM_MODE_OPTIONS`.
//
// This holds that list to what `parseBZWTeamMode` really reads. Without it,
// teaching teams.cjs a new option would make bzo start reporting an option it
// acts on as one it ignores -- which is exactly the kind of drift that had
// `survey-live-maps.mjs` calling half of bzo's own features unsupported.

import fs from 'node:fs';

const serverSource = fs.readFileSync('server.js', 'utf8');
const teamsSource = fs.readFileSync('server/teams.cjs', 'utf8');

const declaredMatch = serverSource.match(/const TEAM_MODE_OPTIONS = new Set\(\[([^\]]*)\]\)/);
const declared = new Set(
  (declaredMatch ? declaredMatch[1] : '').match(/'[^']+'/g)?.map((quoted) => quoted.slice(1, -1)) || [],
);

// Every option `parseBZWTeamMode` tests, read out of the function itself.
const teamModeBody = teamsSource.slice(teamsSource.indexOf('function parseBZWTeamMode'));
const actual = new Set(
  (teamModeBody.slice(0, teamModeBody.indexOf('\n}\n')).match(/option === '([^']+)'/g) || [])
    .map((match) => match.replace(/option === '|'/g, '')),
);

let failures = 0;
for (const option of actual) {
  if (!declared.has(option)) {
    console.error(`FAIL parseBZWTeamMode reads ${option}, TEAM_MODE_OPTIONS does not list it`);
    failures += 1;
  }
}
for (const option of declared) {
  if (!actual.has(option)) {
    console.error(`FAIL TEAM_MODE_OPTIONS lists ${option}, parseBZWTeamMode does not read it`);
    failures += 1;
  }
}

if (failures > 0) process.exit(1);
console.log(`unread option tally agrees with parseBZWTeamMode (${[...actual].sort().join(', ')})`);
