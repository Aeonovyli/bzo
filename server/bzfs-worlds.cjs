/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Keeping a picture of each listed BZFlag server's world up to date, without
// downloading worlds that have not changed (issue #147).
//
// There is nothing to draw here: an imported world is registered like any
// other map, so `registerMapFile` has already drawn its overview beside its
// JSON. What this owns is the *decision* -- whether a server's world is still
// the one bzo holds an import of, answered as cheaply as the question allows.
//
// Three signals, cheapest first:
//
//   1. **The public list entry.** Refreshed every few minutes anyway, so it
//      costs nothing. A server bzo has never seen is new; one whose listed
//      configuration has changed may have changed map with it. Either makes a
//      server due for a check ahead of its schedule.
//   2. **`MsgWantWHash`.** One short connection and four frames, on a socket
//      that never enters the game, answering "is this the same world?"
//      exactly. A `p` hash is stable across that server's restarts, so the
//      usual answer is yes and nothing further happens.
//   3. **The world itself**, which is the only expensive one and runs only
//      when the hash says the import is stale or missing.
//
// With no signal at all a server is rechecked on `RECHECK_MS`. That is the
// floor that makes a weak signal safe: a configuration change the fingerprint
// misses delays a redraw by a day rather than losing it, which is why the
// fingerprint can afford to be a guess.
const fs = require('fs');
const path = require('path');

// How long a picture is trusted with no other reason to doubt it. A day is
// what makes "your thumbnail will update tomorrow" a true answer, and at a
// couple of hundred listed servers it is about ten short dials an hour.
const RECHECK_MS = 24 * 60 * 60 * 1000;

// A server that refused, timed out or sent something unusable is not asked
// again straight away. Shorter than `RECHECK_MS` because being unreachable is
// usually the temporary one of the two.
const FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// One server per tick, and a floor between the expensive half. The dials are
// cheap enough that the tick rate is about politeness rather than load; the
// imports are what wants spacing, since the first pass over a list bzo has
// never seen would otherwise download every world on it at once.
const TICK_MS = 30 * 1000;
const IMPORT_GAP_MS = 60 * 1000;

// What the public list says about a server that is not about who happens to be
// playing. Player and observer counts move constantly and say nothing about
// the world, so they are left out; everything else here is something a change
// of map can move -- the team maxima come from the map's own bases, the option
// bits and shot count from what it sets, and the title is what an operator
// edits when they change what the server is.
//
// A guess, deliberately: it only ever makes a check happen *sooner*, never
// later, so a map change it does not notice still lands on `RECHECK_MS`.
function listEntryFingerprint(server) {
  const info = server?.info || {};
  const teamMaximums = Array.isArray(info.teamMaximums) ? info.teamMaximums.join(',') : '';
  return [
    String(server?.title || '').slice(0, 120),
    info.style, info.maxShots, info.gameOptionsBits, info.maxPlayers,
    teamMaximums, info.maxPlayerScore, info.maxTeamScore, info.maxTime,
    info.shakeTimeout, info.shakeWins,
  ].join('|');
}

function serverKey(host, port) {
  return `${host}:${port}`;
}

// `deps`: `queryServerStatus(host, port, timeout)` for the hash dial,
// `importWorld(host, port)` for the download-and-register, `isImported(host,
// port)` so a record whose map has since been swept out of the registry counts
// as missing, and `log`/`logError`.
function createBzfsWorldTracker(deps) {
  const {
    statePath, queryServerStatus, importWorld, isImported, log, logError,
  } = deps;
  // `host:port` -> { worldHash, fingerprint, checkedAt, error, errorAt }
  const records = new Map();
  // Only servers the public list currently carries are ever checked: an import
  // is refused for a server that is not listed, so there would be nothing to
  // do with the answer.
  let listed = new Map();
  let lastImportAt = 0;
  let timer = null;
  let writeTimer = null;
  let running = false;

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      for (const [key, value] of Object.entries(parsed || {})) {
        if (value && typeof value === 'object') records.set(key, value);
      }
      log(`[WORLDS] restored ${records.size} tracked BZFlag world(s)`);
    } catch (error) {
      logError(`Could not read ${statePath}:`, error);
    }
  }

  // Debounced, because a pass over a long list touches every record and this
  // is a cache nothing waits on.
  function save() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(Object.fromEntries(records), null, 1));
      } catch (error) {
        logError(`Could not write ${statePath}:`, error);
      }
    }, 5000);
    if (writeTimer.unref) writeTimer.unref();
  }

  // Called with each refresh of the public list. Cheap: it only compares
  // strings and marks records, and it is what makes a changed entry jump the
  // queue.
  function observe(servers) {
    const next = new Map();
    for (const server of Array.isArray(servers) ? servers : []) {
      if (!server?.host || !server?.port) continue;
      next.set(serverKey(server.host, server.port), server);
    }
    listed = next;
    for (const [key, server] of listed) {
      const record = records.get(key);
      if (!record) continue;
      const fingerprint = listEntryFingerprint(server);
      if (record.fingerprint !== fingerprint) {
        // Due now rather than on schedule, and the new fingerprint is not
        // stored until the check happens -- otherwise a change noticed here
        // would be forgotten if the check failed.
        record.dueNow = true;
      }
    }
  }

  // The most overdue server that is worth asking about, or null. A record with
  // `dueNow` outranks the schedule, and a recent failure outranks both.
  function pickDue(now) {
    let best = null;
    let bestAge = -Infinity;
    for (const [key, server] of listed) {
      const record = records.get(key);
      if (record?.error && now - (record.errorAt || 0) < FAILURE_COOLDOWN_MS) continue;
      const imported = isImported(server.host, server.port);
      let age;
      if (!record) age = Infinity;
      else if (record.dueNow || !imported) age = Infinity;
      else age = now - (record.checkedAt || 0);
      if (age < RECHECK_MS) continue;
      if (age > bestAge) { bestAge = age; best = server; }
    }
    return best;
  }

  async function check(server, now) {
    const key = serverKey(server.host, server.port);
    const record = records.get(key) || {};
    const fingerprint = listEntryFingerprint(server);
    let status;
    try {
      status = await queryServerStatus(server.host, server.port);
    } catch (error) {
      records.set(key, {
        ...record, fingerprint, error: error.message, errorAt: now, dueNow: false,
      });
      save();
      return;
    }

    // The whole point of the dial: a `p` world that has not changed needs no
    // download, however long ago the import was made.
    if (status.worldHash && status.worldHash === record.worldHash
      && isImported(server.host, server.port)) {
      records.set(key, {
        ...record, fingerprint, checkedAt: now, error: null, errorAt: null, dueNow: false,
      });
      save();
      return;
    }

    // Stale or missing, so the world has to come down. Spaced out rather than
    // taken now if another import was recent: the record is left due, so the
    // next tick picks it up again.
    if (now - lastImportAt < IMPORT_GAP_MS) {
      records.set(key, { ...record, dueNow: true });
      return;
    }
    lastImportAt = now;
    try {
      const { safeMapName } = await importWorld(server.host, server.port);
      records.set(key, {
        worldHash: status.worldHash || '',
        fingerprint,
        checkedAt: now,
        error: null,
        errorAt: null,
        dueNow: false,
      });
      log(`[WORLDS] ${key} world ${status.worldHash || '(unhashed)'} imported as ${safeMapName}`);
    } catch (error) {
      records.set(key, {
        ...record, fingerprint, error: error.message, errorAt: now, dueNow: false,
      });
      log(`[WORLDS] ${key} could not be imported: ${error.message}`);
    }
    save();
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const server = pickDue(now);
      if (server) await check(server, now);
    } catch (error) {
      logError('[WORLDS] tracker tick failed:', error);
    } finally {
      running = false;
    }
  }

  return {
    observe,
    start() {
      if (timer) return;
      load();
      timer = setInterval(() => { tick(); }, TICK_MS);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    // For `/list`, so a row can say why it has no picture yet.
    recordFor(host, port) {
      return records.get(serverKey(host, port)) || null;
    },
    RECHECK_MS,
  };
}

module.exports = {
  createBzfsWorldTracker,
  listEntryFingerprint,
  RECHECK_MS,
  FAILURE_COOLDOWN_MS,
};
