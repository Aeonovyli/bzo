#!/usr/bin/env node
/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Asks the public BZFlag list server (my.bzflag.org) which servers are
// running right now, downloads the map each one is actually playing over the
// real BZFS wire protocol, and reports which BZW features those maps use --
// so the answer to "does bzo support what's out there" comes from live
// servers instead of guesswork. With --export-dir it also writes out a
// reconstructed .bzw per server, the same thing BZFlag's own "Save World"
// menu item does (SaveWorldMenu.cxx -> World::writeWorld) -- for
// side-by-side comparison against bzo's own maps/ directory.
//
// The protocol work and the binary world-database parser live in
// server/remote-world-import.cjs, shared with the Operator panel's "Import
// Remote Map" (server.js's `importMap`/`listRemoteServers`) so there is one
// implementation of the wire format rather than two that could drift apart.
// This script is the CLI-only wrapper: fetching/picking servers, the
// feature-usage report, and writing files to --export-dir.
//
//   node scripts/survey-live-maps.mjs
//   node scripts/survey-live-maps.mjs --count 12
//   node scripts/survey-live-maps.mjs --server bzflag.example.org:5154
//   node scripts/survey-live-maps.mjs --count 8 --export-dir /tmp/live-maps

import fs from 'node:fs';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  DEFAULT_LIST_SERVER,
  OBSTACLE_ORDER,
  GAME_STYLES,
  GAME_OPTION_BITS,
  fetchServerList,
  fetchWorldFromServer,
  decodeGameSettings,
  decodeQueryGame,
  parseWorldDatabase,
  buildBZWText,
} from '../server/remote-world-import.cjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const serverCount = Number(args.get('count') || 6);
const timeoutMs = Number(args.get('timeout') || 15000);
const listServerUrl = args.get('list-server') || DEFAULT_LIST_SERVER;
const singleServer = args.get('server') || '';
const exportDir = args.get('export-dir') || '';

// ---------------------------------------------------------------------------
// Feature-usage summary, walked from the parsed tree -- bzo's own obstacle
// vocabulary (docs/bzw.md) is box/pyramid/base/teleporter -- everything else
// here is geometry or material state a live map may use that bzo currently
// drops or ignores on import.
// ---------------------------------------------------------------------------

const BZO_SUPPORTED_OBSTACLES = new Set(['box', 'pyr', 'base', 'tele']);

function summarize(tree) {
  const stats = {
    obstacles: Object.fromEntries(OBSTACLE_ORDER.map((k) => [k, 0])),
    flatTopPyramids: 0,
    meshFaces: 0,
    facesWithPhydrv: 0,
    facesWithMaterial: 0,
    curvedWithPhydrv: 0,
    groupDefs: tree.groupDefs.length,
    groupInstances: 0,
    dynamicColors: tree.managers.dynamicColors.length,
    textureMatrices: tree.managers.textureMatrices.length,
    materials: tree.managers.materials.length,
    materialsWithTexture: tree.managers.materials.filter((m) => m.textures.length > 0).length,
    materialsWithShader: tree.managers.materials.filter((m) => m.shaders.length > 0).length,
    physicsDrivers: tree.managers.physicsDrivers.length,
    teleporterLinks: tree.links.length,
    waterLevel: tree.waterLevel,
    weapons: tree.weapons.length,
    entryZones: tree.zones.length,
  };

  const walk = (def) => {
    for (const kind of OBSTACLE_ORDER) {
      const list = def.obstacles[kind];
      stats.obstacles[kind] += list.length;
      if (kind === 'pyr') stats.flatTopPyramids += list.filter((o) => o.flipZ).length;
      if (kind === 'mesh') {
        for (const m of list) {
          stats.meshFaces += m.faces.length;
          for (const f of m.faces) {
            if (f.phydrv >= 0) stats.facesWithPhydrv++;
            if (f.matindex >= 0) stats.facesWithMaterial++;
          }
        }
      }
      if (kind === 'arc' || kind === 'cone' || kind === 'sphere') {
        stats.curvedWithPhydrv += list.filter((o) => o.phydrv >= 0).length;
      }
    }
    stats.groupInstances += def.groupInstances.length;
  };
  walk(tree.world);
  for (const def of tree.groupDefs) walk(def);

  return stats;
}

function printReport(server, stats, tree) {
  if (tree.gameSettings) {
    const gs = tree.gameSettings;
    const has = (bit) => (gs.gameOptionsBits & bit) !== 0;
    const style = tree.queryGame ? (GAME_STYLES[tree.queryGame.style] || `type${tree.queryGame.style}`) : null;
    const on = Object.keys(GAME_OPTION_BITS).filter((k) => has(GAME_OPTION_BITS[k]));
    console.log(`  game settings: ${style ? `${style}, ` : ''}maxShots=${gs.maxShots}, superflags=${gs.numFlags}${on.length ? `, ${on.join('/')}` : ''}`);
  }

  const total = OBSTACLE_ORDER.reduce((sum, k) => sum + stats.obstacles[k], 0) - stats.obstacles.wall;
  const unsupported = OBSTACLE_ORDER
    .filter((k) => k !== 'wall' && !BZO_SUPPORTED_OBSTACLES.has(k))
    .reduce((sum, k) => sum + stats.obstacles[k], 0);

  console.log(`  obstacles: ${total} total (${unsupported} on shapes bzo does not read: mesh/arc/cone/sphere/tetra/group)`);
  const shapeBreakdown = OBSTACLE_ORDER
    .filter((k) => k !== 'wall' && stats.obstacles[k] > 0)
    .map((k) => `${k}=${stats.obstacles[k]}`)
    .join(' ');
  if (shapeBreakdown) console.log(`    ${shapeBreakdown}`);
  if (stats.groupDefs > 0 || stats.groupInstances > 0) {
    console.log(`    group definitions=${stats.groupDefs} instances=${stats.groupInstances} (bzo does not read \`define\`/\`group\`)`);
  }
  if (stats.meshFaces > 0) {
    console.log(`    mesh faces=${stats.meshFaces}, ${stats.facesWithPhydrv} tied to a physics driver, ${stats.facesWithMaterial} tied to a material`);
  }
  if (stats.flatTopPyramids > 0) console.log(`    flat-topped pyramids (flipz)=${stats.flatTopPyramids} (bzo reads this)`);

  const otherFeatures = [];
  if (stats.materials > 0) otherFeatures.push(`materials=${stats.materials} (${stats.materialsWithTexture} textured, ${stats.materialsWithShader} shaded)`);
  if (stats.physicsDrivers > 0 || stats.curvedWithPhydrv > 0) otherFeatures.push(`physics drivers=${stats.physicsDrivers}`);
  if (stats.dynamicColors > 0) otherFeatures.push(`dynamic colors=${stats.dynamicColors}`);
  if (stats.textureMatrices > 0) otherFeatures.push(`texture matrices=${stats.textureMatrices}`);
  if (stats.waterLevel >= 0) otherFeatures.push(`water level=${stats.waterLevel.toFixed(1)}`);
  if (otherFeatures.length) console.log(`  material/animation features bzo does not read: ${otherFeatures.join(', ')}`);

  console.log(`  bzo already reads: teleporter links=${stats.teleporterLinks}, world weapons=${stats.weapons}, entry zones=${stats.entryZones}`);
}

function mergeAggregate(agg, stats) {
  agg.servers++;
  for (const k of OBSTACLE_ORDER) agg.obstacles[k] += stats.obstacles[k];
  agg.groupDefs += stats.groupDefs;
  agg.groupInstances += stats.groupInstances;
  agg.materials += stats.materials;
  agg.physicsDrivers += stats.physicsDrivers;
  agg.dynamicColors += stats.dynamicColors;
  agg.textureMatrices += stats.textureMatrices;
  agg.meshFaces += stats.meshFaces;
  if (stats.waterLevel >= 0) agg.mapsWithWater++;
  if (stats.obstacles.mesh + stats.obstacles.arc + stats.obstacles.cone + stats.obstacles.sphere + stats.obstacles.tetra + stats.groupDefs + stats.groupInstances > 0) {
    agg.mapsUsingUnsupportedShapes++;
  }
}

function printAggregate(agg) {
  console.log(`\n=== summary across ${agg.servers} downloaded map(s) ===`);
  const total = OBSTACLE_ORDER.reduce((sum, k) => sum + agg.obstacles[k], 0) - agg.obstacles.wall;
  const unsupported = OBSTACLE_ORDER
    .filter((k) => k !== 'wall' && !BZO_SUPPORTED_OBSTACLES.has(k))
    .reduce((sum, k) => sum + agg.obstacles[k], 0);
  console.log(`obstacles across all maps: ${total}, ${unsupported} (${total ? ((100 * unsupported) / total).toFixed(1) : '0'}%) on shapes bzo does not read`);
  console.log(`maps using at least one unsupported shape or group: ${agg.mapsUsingUnsupportedShapes}/${agg.servers}`);
  console.log(`maps using materials: ${agg.materials > 0 ? 'yes' : 'no'} (${agg.materials} total), physics drivers: ${agg.physicsDrivers}, dynamic colors: ${agg.dynamicColors}, texture matrices: ${agg.textureMatrices}, maps with water: ${agg.mapsWithWater}`);
}

function exportFilename(server) {
  const safe = `${server.host}_${server.port}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}.bzw`;
}

// ---------------------------------------------------------------------------

async function main() {
  let servers;
  if (singleServer) {
    const idx = singleServer.lastIndexOf(':');
    const host = idx === -1 ? singleServer : singleServer.slice(0, idx);
    const port = idx === -1 ? 5154 : parseInt(singleServer.slice(idx + 1), 10);
    servers = [{ host, port, title: '(manual)' }];
  } else {
    console.log(`Fetching running server list from ${listServerUrl} ...`);
    const all = await fetchServerList(listServerUrl, PROTOCOL_VERSION);
    const seen = new Set();
    servers = [];
    for (const s of all) {
      const key = `${s.host}:${s.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      servers.push(s);
    }
    console.log(`${servers.length} server(s) advertising protocol ${PROTOCOL_VERSION}; trying the first ${Math.min(serverCount, servers.length)}.`);
    servers = servers.slice(0, serverCount);
  }

  if (exportDir) fs.mkdirSync(exportDir, { recursive: true });

  const agg = {
    servers: 0,
    obstacles: Object.fromEntries(OBSTACLE_ORDER.map((k) => [k, 0])),
    groupDefs: 0,
    groupInstances: 0,
    materials: 0,
    physicsDrivers: 0,
    dynamicColors: 0,
    textureMatrices: 0,
    meshFaces: 0,
    mapsWithWater: 0,
    mapsUsingUnsupportedShapes: 0,
  };

  for (const server of servers) {
    console.log(`\n=== ${server.host}:${server.port}${server.title ? ` -- ${server.title}` : ''} ===`);
    try {
      const { worldDatabase, gameSettings, queryGame } = await fetchWorldFromServer(server.host, server.port, timeoutMs);
      console.log(`  downloaded ${worldDatabase.length} bytes`);
      const tree = parseWorldDatabase(worldDatabase);
      if (gameSettings && gameSettings.length >= 30) tree.gameSettings = decodeGameSettings(gameSettings);
      if (queryGame && queryGame.length >= 44) tree.queryGame = decodeQueryGame(queryGame);
      if (tree.gameSettings) tree.worldSize = tree.gameSettings.worldSize;
      const stats = summarize(tree);
      printReport(server, stats, tree);
      mergeAggregate(agg, stats);

      if (exportDir) {
        const text = buildBZWText(server, tree, new Date().toISOString());
        const outPath = path.join(exportDir, exportFilename(server));
        fs.writeFileSync(outPath, text);
        console.log(`  wrote ${outPath}`);
      }
    } catch (err) {
      console.log(`  skip: ${err.message}`);
    }
  }

  if (agg.servers > 0) printAggregate(agg);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
