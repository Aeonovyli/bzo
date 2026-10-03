// Holds bzo's generated worlds (server/world-generator.cjs) to upstream's
// generators: the counts `defineRandomWorld` and `defineTeamWorld` make, the
// bases a team world gives the colours with slots, and -- where bzfs is
// installed -- that bzfs reads the same `.bzw` to the same bytes bzo's own
// compiler writes for a BZFlag client. Seeded, so every run checks the same
// worlds.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateWorldBzw, seededRandom } = require('../server/world-generator.cjs');
const { compileBzwWorld } = require('../server/bzw-compile.cjs');
const { packWorldBody } = require('../server/bzflag-world.cjs');
const { parseWorldDatabase } = require('../server/remote-world-import.cjs');

const count = (text, kind) => text.split('\n').filter((line) => line === kind || line.startsWith(`${kind} `)).length;

const cases = [
  ['random', {}],
  ['random, dense, flat, no teleporters', { options: { density: 8, randomHeights: false, teleporters: false } }],
  ['team world, four colours', { teamWorld: true, teams: [1, 2, 3, 4] }],
  ['team world, red and green', { teamWorld: true, teams: [1, 2] }],
  ['mirrored random team world, four colours', { teamWorld: true, teams: [1, 2, 3, 4], options: { randomCtf: true } }],
  ['mirrored random team world, blue and purple', { teamWorld: true, teams: [3, 4], options: { randomCtf: true } }],
];

const worlds = cases.map(([name, args], index) => {
  const text = generateWorldBzw({ ...args, rand: seededRandom(index + 1) });
  return { name, args, text };
});

for (const { name, args, text } of worlds) {
  const teams = args.teams || [];
  const teleporters = args.options?.teleporters !== false;
  // Every world is upstream's 800 wide unless `_worldSize` says otherwise.
  assert.match(text, /^world\n {2}size 400\nend$/m, `${name}: an 800-wide world`);
  assert.equal(count(text, 'base'), args.teamWorld ? teams.length : 0, `${name}: a base per colour with slots`);
  assert.equal(count(text, 'zone'), args.teamWorld ? teams.length * 2 : 0, `${name}: two flag safety points per base`);
  if (!args.teamWorld) {
    // `(0.5 to 1.2) * citySize^2` each, citySize 5 or 8.
    const city = (args.options?.density || 5) ** 2;
    for (const kind of ['box', 'pyramid']) {
      const n = count(text, kind);
      assert.ok(n >= Math.trunc(0.5 * city) && n <= Math.trunc(1.2 * city), `${name}: ${n} ${kind}es`);
    }
  }
  if (teleporters) {
    const n = count(text, 'teleporter');
    assert.ok(n >= 2 && n <= 16, `${name}: ${n} teleporters`);
    // Every face of every teleporter goes somewhere.
    assert.ok(count(text, 'link') >= n, `${name}: its teleporters are linked`);
  } else {
    assert.equal(count(text, 'teleporter'), 0, `${name}: none without -t`);
  }
  // The classic team city: upstream's fixed twelve pyramids and four around
  // each base, and boxes four at a time.
  if (args.teamWorld && !args.options?.randomCtf) {
    assert.equal(count(text, 'pyramid'), 12 + (4 * teams.length), `${name}: pyramids`);
    assert.equal(count(text, 'box') % 4, 0, `${name}: boxes four at a time`);
  }
  // And bzo's compiler reads every one.
  assert.ok(packWorldBody(compileBzwWorld(text, {})).length > 0, `${name}: compiles`);
}

// The same seed, the same world.
assert.equal(generateWorldBzw({ rand: seededRandom(9) }), generateWorldBzw({ rand: seededRandom(9) }));

let compared = 0;
let bzfs = true;
try {
  execFileSync('bzfs', ['-version'], { stdio: 'ignore' });
} catch {
  bzfs = false;
}
if (bzfs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzo-worldgen-'));
  for (const { name, text } of worlds) {
    const bzw = path.join(dir, 'world.bzw');
    const bwc = path.join(dir, 'world.bwc');
    fs.writeFileSync(bzw, text);
    fs.rmSync(bwc, { force: true });
    // bzfs writes the world and then tries to listen, which fails where a
    // server already holds its port; the file is what is wanted.
    try {
      execFileSync('bzfs', ['-world', bzw, '-cacheout', bwc, '-p', '0'], { stdio: 'ignore', timeout: 30000 });
    } catch { /* see above */ }
    assert.ok(fs.existsSync(bwc), `${name}: bzfs read the .bzw`);
    const reference = fs.readFileSync(bwc);
    const inflated = zlib.inflateSync(reference.subarray(14, 14 + reference.readUInt32BE(10)));
    assert.equal(Buffer.compare(packWorldBody(compileBzwWorld(text, {})), inflated), 0,
      `${name}: byte-identical to bzfs`);
    assert.ok(parseWorldDatabase(reference).world.obstacles.wall.length === 4, `${name}: walled`);
    compared += 1;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`test-world-generator: ${worlds.length} world(s) checked`
  + (bzfs ? `, ${compared} byte-identical to bzfs` : ', bzfs not installed so not compared'));
