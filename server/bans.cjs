/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bans.cjs - the server's ban list, as upstream's AccessControlList keeps
// its BZID bans (src/bzfs/AccessControlList.cxx): who, until when, banned by
// whom and why. Persisted by the caller through `onChange` and `serialize`,
// as sessions.json is. `now` is milliseconds, injected so a test can run the
// clock.

// TextUtils::parseDuration (src/common/TextUtils.cxx:221), in minutes:
// `short`/`default` is -1 (the server's ban time), `forever`/`max` is 0,
// otherwise digits each followed by w, d, h or m, a bare number being
// minutes. null for anything else.
function parseDuration(text) {
  const value = String(text || '').trim();
  if (/^(short|default)$/i.test(value)) return -1;
  if (/^(forever|max)$/i.test(value)) return 0;
  if (!/^(\d+[hwdm]?)+$/i.test(value)) return null;
  const unit = { w: 10080, d: 1440, h: 60, m: 1 };
  let minutes = 0;
  for (const [, digits, letter] of value.matchAll(/(\d+)([hwdm]?)/gi)) {
    minutes += Number(digits) * (letter ? unit[letter.toLowerCase()] : 1);
  }
  return minutes;
}

// makeGlobPattern and glob_match: upper case, `*` and `?`, and a pattern with
// no `*` in it matched anywhere.
function globMatcher(pattern) {
  const text = String(pattern || '').trim().toUpperCase();
  if (!text) return () => true;
  const glob = text.includes('*') ? text : `*${text}*`;
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const regex = new RegExp(`^${source}$`, 's');
  return (value) => regex.test(String(value || '').toUpperCase());
}

function createBanStore({ onChange = () => {}, now = () => Date.now() } = {}) {
  // BZID to { bannedBy, reason, until (0 is forever), at }.
  const idBans = new Map();

  function expire() {
    const time = now();
    let changed = false;
    for (const [bzid, ban] of idBans) {
      if (ban.until && ban.until <= time) {
        idBans.delete(bzid);
        changed = true;
      }
    }
    if (changed) onChange();
  }

  // `minutes` 0 is forever.
  function idBan(bzid, { bannedBy = '', minutes = 0, reason = '' } = {}) {
    const id = String(bzid || '').trim();
    if (!id) return false;
    idBans.set(id, {
      bannedBy, reason, until: minutes > 0 ? now() + (minutes * 60000) : 0, at: now(),
    });
    onChange();
    return true;
  }

  function idUnban(bzid) {
    const removed = idBans.delete(String(bzid || '').trim());
    if (removed) onChange();
    return removed;
  }

  // The ban that keeps this BZID out, or null.
  function idBanned(bzid) {
    if (!bzid) return null;
    expire();
    const ban = idBans.get(String(bzid));
    return ban ? { bzid: String(bzid), ...ban } : null;
  }

  // sendIdBans: each matching ban as upstream lists it.
  function listIdBans(pattern = '') {
    expire();
    const matches = globMatcher(pattern);
    const lines = ['BZID Ban List', '-------------'];
    for (const [bzid, ban] of idBans) {
      if (!matches(bzid) && !matches(ban.reason) && !matches(ban.bannedBy)) continue;
      let line = /[ \t]/.test(bzid) ? `"${bzid}"` : bzid;
      const remaining = ban.until ? (ban.until - now()) / 1000 : Infinity;
      if (remaining < 365 * 24 * 3600) line += ` (${(remaining / 60).toFixed(1)} minutes)`;
      if (ban.bannedBy) line += ` banned by: ${ban.bannedBy}`;
      lines.push(line);
      if (ban.reason) lines.push(`   reason: ${ban.reason}`);
    }
    return lines;
  }

  function serialize() {
    expire();
    return { idBans: [...idBans].map(([bzid, ban]) => ({ bzid, ...ban })) };
  }

  function load(data) {
    idBans.clear();
    for (const entry of data?.idBans || []) {
      if (!entry?.bzid) continue;
      idBans.set(String(entry.bzid), {
        bannedBy: String(entry.bannedBy || ''),
        reason: String(entry.reason || ''),
        until: Number(entry.until) || 0,
        at: Number(entry.at) || 0,
      });
    }
    expire();
    return idBans.size;
  }

  return { idBan, idUnban, idBanned, listIdBans, serialize, load };
}

module.exports = { parseDuration, globMatcher, createBanStore };
