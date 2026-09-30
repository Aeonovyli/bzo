/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Which map file produced which cached world, so a restart can tell at once
// what it already has (issue #147).
//
// `MAP_REGISTRY` is rebuilt at boot by re-parsing every `.bzw`, which takes
// minutes once a server has imported a hundred worlds. Everything those parses
// produce is already on disk under the map's hash -- the world JSON and the
// overview picture both -- but nothing recorded *which* hash belongs to which
// file, so for those minutes the server could not answer "do I have this one
// already?" and the world tracker re-downloaded maps it was still in the
// middle of reading back (`server/bzfs-worlds.cjs`).
//
// This is only an index. It is never the source of a map's contents, and a
// wrong or stale entry costs a re-import rather than a wrong world: an entry
// counts only while the `.bzw` it names still has the size and mtime it had
// when the hash was computed, and only while the hashed files are still there.
const fs = require('fs');
const path = require('path');

function createMapIndex({ statePath, mapCacheDir, log, logError }) {
  // mapFileName -> { hash, mtimeMs, size }
  let entries = new Map();
  let writeTimer = null;

  // Debounced: a boot pass touches every map, and nothing waits on this file.
  function save() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(Object.fromEntries(entries), null, 1));
      } catch (error) {
        logError(`Could not write ${statePath}:`, error);
      }
    }, 5000);
    if (writeTimer.unref) writeTimer.unref();
  }

  function statOf(filePath) {
    if (!filePath) return null;
    try {
      const { mtimeMs, size } = fs.statSync(filePath);
      return { mtimeMs, size };
    } catch {
      return null;
    }
  }

  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        for (const [name, value] of Object.entries(parsed || {})) {
          if (value && typeof value.hash === 'string') entries.set(name, value);
        }
        log(`[MAPS] restored an index of ${entries.size} cached world(s)`);
      } catch {
        // No index yet, or an unreadable one. Either way the boot pass below
        // rebuilds it from what it parses, which is where it came from.
        entries = new Map();
      }
    },

    // Called as each map registers, with the file it was read from.
    note(fileName, hash, filePath) {
      const stat = statOf(filePath);
      if (!stat) return;
      const existing = entries.get(fileName);
      if (existing && existing.hash === hash
        && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return;
      entries.set(fileName, { hash, ...stat });
      save();
    },

    // Whether this server already holds a parsed, drawn copy of `fileName` --
    // answerable before the boot pass has re-read it. Both hashed files have
    // to be there: an index entry whose world or picture was swept is a
    // promise this cannot keep.
    has(fileName, filePath) {
      const entry = entries.get(fileName);
      if (!entry) return false;
      const stat = statOf(filePath);
      if (!stat || stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) return false;
      return fs.existsSync(path.join(mapCacheDir, `${entry.hash}.json`))
        && fs.existsSync(path.join(mapCacheDir, `${entry.hash}.svg`));
    },

    // Drops what no current map file names, so a removed map does not keep an
    // entry for ever. Run from the same sweep that clears the cache itself.
    prune(knownFileNames) {
      let removed = 0;
      for (const name of [...entries.keys()]) {
        if (!knownFileNames.has(name)) { entries.delete(name); removed += 1; }
      }
      if (removed > 0) save();
      return removed;
    },
  };
}

module.exports = { createMapIndex };
