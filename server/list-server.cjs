/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bzo's own list server: docs/list-server-plan.md, issue #46. my.bzflag.org's
// list server dials a row's host:port with bzfs's binary protocol, which has
// no HTTPS/SNI connection for it to make and no way to validate a bzo server
// either. The fix is a designated bzo instance that every other instance
// reports to over plain HTTPS/JSON -- this module is the designated
// instance's half: the key registry (per server, not per account, modeled on
// bzfs's own `-publickey`) and the HMAC challenge both sides use to validate
// a registered URL without ever sending the key itself over the wire.
//
// Server-only, like sessions.cjs: a key row is an authority question, so it
// lives here and nowhere the client can read it.

const crypto = require('crypto');

// 192 bits, 48 hex characters -- pasted by hand into an Operator panel field
// rather than carried in a cookie, so alphanumeric only: base64url's `-` and
// `_` are exactly the characters a double-click word-select stops at in most
// browsers, which would turn "select the key" into "select a piece of it."
const KEY_BYTES = 24;

// A key unused for 30 days expires, whether or not it was ever pasted
// anywhere -- see docs/list-server-plan.md "Key lifetime". `lastChecked` is
// bumped by whichever validation last succeeded (a push-triggered check or
// the daily poll), never by a bare join/part report, so this reads as "30
// days since we last *confirmed* this server", not "30 days since some
// packet arrived."
const KEY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// A few consecutive failures, not one, before a row flips to stale on
// `/view` -- a single missed push or poll is noise.
const STALE_FAIL_THRESHOLD = 3;

// A cap for the same reason sessions.cjs has one: an unbounded registry is an
// unbounded file and an unbounded broadcast to every /view visitor. Oldest
// (by dateRequested) is dropped first, which is also whichever key expiry
// would have reached soonest.
const MAX_KEYS = 2000;

function generateListServerKey(randomBytes = crypto.randomBytes) {
  return randomBytes(KEY_BYTES).toString('hex');
}

// HMAC-SHA256 over the nonce, keyed by the shared secret both sides hold.
// This is what "signed challenge, not a round trip of the raw key" means in
// the plan: the list server sends a nonce, the target signs it with the key
// already configured, and only the signature crosses the wire.
function signListServerChallenge(key, nonce) {
  return crypto.createHmac('sha256', String(key)).update(String(nonce)).digest('hex');
}

// Timing-safe, the same reasoning as any secret comparison: a byte-by-byte
// `===` leaks how many leading bytes matched through response latency.
function verifyListServerChallenge(key, nonce, signature) {
  const expected = signListServerChallenge(key, nonce);
  const given = typeof signature === 'string' ? signature : '';
  const expectedBuf = Buffer.from(expected, 'hex');
  const givenBuf = Buffer.from(given, 'hex');
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

function isKeyExpired(record, now = Date.now()) {
  if (!record) return true;
  const since = record.lastChecked ?? record.dateRequested;
  return !(since + KEY_MAX_AGE_MS > now);
}

function isKeyStale(record) {
  return !!record && record.failCount >= STALE_FAIL_THRESHOLD;
}

// A masked view of the key -- not used by `GET /api/list-server/keys` today
// (an owner or admin sees the real value there, see docs/list-server-plan.md
// "Keys are per server"), kept for any context that should name a
// registration without being trusted with the credential itself.
function maskKey(key) {
  const value = String(key || '');
  return value.length <= 4 ? '****' : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

// One registry, keyed by `id` -- an opaque, non-secret row identifier, safe
// to hand back in a listing and to revoke by. The actual bearer credential
// (`key`, what gets pasted into another server's Operator panel) lives inside
// the record but is only ever indexed for lookup, never listed: a UI that
// could revoke-by-key would have to be shown the key to do it, which is the
// one thing a listing must never do after the row is created.
//
// `dateRequested`/`url`/`bzid`/`callsign`/`lastChecked`/`failCount`/
// `lastError` persist (serialize/load, the same shape sessions.cjs uses);
// `live` -- the last report's title/description/players/maxPlayers/version/
// gameOptionsBits/lastReportAt -- does not, the same as bzfs's own list
// server forgets ADDs across a restart. A row with no `live` yet is a
// registered key that has never reported.
function createKeyStore({ maxKeys = MAX_KEYS, onChange = () => {}, randomUUID = crypto.randomUUID } = {}) {
  const byId = new Map();
  const idByKey = new Map();

  function prune() {
    let dropped = 0;
    // Insertion order is request order, so the oldest are at the front --
    // same cap shape as sessions.cjs's MAX_SESSIONS.
    while (byId.size > maxKeys) {
      const [id, record] = byId.entries().next().value;
      byId.delete(id);
      idByKey.delete(record.key);
      dropped++;
    }
    if (dropped > 0) onChange();
    return dropped;
  }

  function drop(record) {
    byId.delete(record.id);
    idByKey.delete(record.key);
  }

  return {
    // Returns the new record (plaintext key included) -- the one and only
    // time the caller sees it, matching an ordinary API-key flow.
    requestKey({ bzid, callsign, url }, now = Date.now(), randomBytes) {
      const record = {
        id: randomUUID(),
        bzid: String(bzid),
        callsign: String(callsign || ''),
        url: String(url),
        key: generateListServerKey(randomBytes),
        dateRequested: now,
        lastChecked: null,
        failCount: 0,
        lastError: null,
        live: null,
      };
      byId.set(record.id, record);
      idByKey.set(record.key, record.id);
      prune();
      onChange();
      return record;
    },

    // Undefined for an id that is unknown *or* expired, so a caller cannot
    // accidentally honour a stale registration by forgetting to check --
    // the same contract as sessions.cjs's `get`. Used by the account UI
    // (revoke by row id).
    get(id, now = Date.now()) {
      if (typeof id !== 'string' || id === '') return undefined;
      const record = byId.get(id);
      if (!record) return undefined;
      if (isKeyExpired(record, now)) {
        drop(record);
        onChange();
        return undefined;
      }
      return record;
    },

    // The same lookup, keyed by the plaintext bearer credential instead --
    // used only by the report and validation paths, which are handed the key
    // and never the id.
    getByKey(key, now = Date.now()) {
      if (typeof key !== 'string' || key === '') return undefined;
      const id = idByKey.get(key);
      return id === undefined ? undefined : this.get(id, now);
    },

    // Revocation is an owner or admin action; the caller decides which and
    // this just drops the row.
    revoke(id) {
      if (typeof id !== 'string') return false;
      const record = byId.get(id);
      if (!record) return false;
      drop(record);
      onChange();
      return true;
    },

    listForBzid(bzid, now = Date.now()) {
      const owned = [...byId.values()].filter((record) => record.bzid === String(bzid));
      return owned.filter((record) => {
        if (!isKeyExpired(record, now)) return true;
        drop(record);
        return false;
      });
    },

    listAll(now = Date.now()) {
      for (const record of [...byId.values()]) {
        if (isKeyExpired(record, now)) drop(record);
      }
      return [...byId.values()];
    },

    // Either kind of check succeeding bumps `lastChecked` and clears the
    // failure streak; a failure only increments the streak and records why
    // -- "a failed check marks the row stale, it does not expire the key."
    // Takes the row itself (callers already hold it from `getByKey`/`get`),
    // not another lookup key, so there is only one spelling of "find the
    // record" in this module.
    markChecked(record, ok, error, now = Date.now()) {
      if (!record || !byId.has(record.id)) return;
      if (ok) {
        record.lastChecked = now;
        record.failCount = 0;
        record.lastError = null;
      } else {
        record.failCount += 1;
        record.lastError = error ? String(error) : 'no response';
      }
      onChange();
    },

    // ADD-equivalent. `reason` distinguishes a periodic push (which also
    // gates validation, above the caller) from a bare join/part count update.
    report(record, payload, now = Date.now()) {
      if (!record || !byId.has(record.id)) return false;
      record.live = { ...payload, lastReportAt: now };
      return true;
    },

    // REMOVE-equivalent, on clean shutdown. The key registration itself
    // outlives this -- only the live listing goes away.
    unreport(record) {
      if (!record || !byId.has(record.id)) return false;
      record.live = null;
      return true;
    },

    sweepExpired(now = Date.now()) {
      let dropped = 0;
      for (const record of [...byId.values()]) {
        if (isKeyExpired(record, now)) {
          drop(record);
          dropped++;
        }
      }
      if (dropped > 0) onChange();
      return dropped;
    },

    prune,

    get size() {
      return byId.size;
    },

    // Live report state is deliberately left out -- it is not operator
    // state, it is the last thing a running game said, and belongs no more
    // in a restart-durable file than the roster a game server holds does.
    serialize(now = Date.now()) {
      const out = {};
      for (const [id, record] of byId) {
        if (isKeyExpired(record, now)) continue;
        out[id] = {
          bzid: record.bzid, callsign: record.callsign, url: record.url, key: record.key,
          dateRequested: record.dateRequested, lastChecked: record.lastChecked,
          failCount: record.failCount, lastError: record.lastError,
        };
      }
      return { version: 1, keys: out };
    },

    // Anything malformed is dropped rather than repaired -- a registration
    // that cannot be read is one regeneration, not a guess at who held it.
    load(data, now = Date.now()) {
      let loaded = 0;
      const entries = data && typeof data === 'object' ? data.keys : null;
      if (!entries || typeof entries !== 'object') return 0;
      for (const [id, record] of Object.entries(entries)) {
        if (typeof id !== 'string' || !record || typeof record !== 'object') continue;
        if (typeof record.bzid !== 'string' || typeof record.url !== 'string') continue;
        if (typeof record.key !== 'string' || record.key === '') continue;
        if (!Number.isFinite(record.dateRequested)) continue;
        const restored = {
          id,
          bzid: record.bzid,
          callsign: typeof record.callsign === 'string' ? record.callsign : '',
          url: record.url,
          key: record.key,
          dateRequested: record.dateRequested,
          lastChecked: Number.isFinite(record.lastChecked) ? record.lastChecked : null,
          failCount: Number.isInteger(record.failCount) ? record.failCount : 0,
          lastError: typeof record.lastError === 'string' ? record.lastError : null,
          live: null,
        };
        if (isKeyExpired(restored, now)) continue;
        byId.set(id, restored);
        idByKey.set(restored.key, id);
        loaded++;
      }
      prune();
      return loaded;
    },
  };
}

module.exports = {
  KEY_BYTES,
  KEY_MAX_AGE_MS,
  STALE_FAIL_THRESHOLD,
  MAX_KEYS,
  generateListServerKey,
  signListServerChallenge,
  verifyListServerChallenge,
  isKeyExpired,
  isKeyStale,
  maskKey,
  createKeyStore,
};
