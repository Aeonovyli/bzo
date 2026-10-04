/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// bans.cjs - the server's ban list, as upstream's AccessControlList keeps
// its BZID and address bans (src/bzfs/AccessControlList.cxx): who, until
// when, banned by whom and why. Persisted by the caller through `onChange`
// and `serialize`, as sessions.json is. `now` is milliseconds, injected so a
// test can run the clock.

const { parseWhitelistEntry, addressMatchesWhitelist } = require('./sessions.cjs');

// An address ban's mask: an IPv4 or IPv6 address or CIDR block, parsed and
// matched as `adminWhitelist` is. Upstream's wildcards (`1.2.*.*`,
// AccessControlList::convert) are taken and become CIDR (`1.2.0.0/16`); a
// `*` that is not a whole trailing octet is refused, as is one beside a `/`.
// Returns the mask as written back, the parsed entry and a key that two
// spellings of one block share, or null.
function parseBanMask(text) {
  let mask = String(text || '').trim().replace(/^::ffff:/i, '');
  if (mask.includes('*')) {
    if (mask.includes('/')) return null;
    const octets = mask.split('.');
    if (octets.length !== 4) return null;
    const stars = octets.findIndex((octet) => octet === '*');
    if (stars === -1 || octets.slice(stars).some((octet) => octet !== '*')) return null;
    mask = `${octets.map((octet) => (octet === '*' ? '0' : octet)).join('.')}/${stars * 8}`;
  }
  const entry = parseWhitelistEntry(mask);
  if (!entry) return null;
  return { mask, entry, key: `${entry.family}:${entry.network}:${entry.mask}` };
}

// TimeKeeper::printTime: "2 days, 3 hours, 1 min, 5 secs".
function formatRemaining(seconds) {
  let left = Math.max(0, Math.floor(seconds));
  const parts = [];
  for (const [size, name] of [[86400, 'day'], [3600, 'hour'], [60, 'min'], [1, 'sec']]) {
    const count = Math.floor(left / size);
    left -= count * size;
    if (count > 0) parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

// TextUtils::parseDuration (src/common/TextUtils.cxx:221), in minutes:
// `short`/`default` is -1 (the server's ban time), `forever`/`max` is 0,
// otherwise digits each followed by w, d, h or m, a bare number being
// minutes. null for anything else.
function parseDuration(text) {
  const value = String(text || '').trim();
  if (/^(short|default)$/i.test(value)) return -1;
  if (/^(forever|max)$/i.test(value)) return 0;
  if (!value || !/^(\d+[hwdm])*\d*$/i.test(value)) return null;
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
  // A mask's key (`parseBanMask`) to { mask, entry, bannedBy, reason, until, at }.
  const ipBans = new Map();

  function expire() {
    const time = now();
    let changed = false;
    for (const list of [idBans, ipBans]) {
      for (const [key, ban] of list) {
        if (ban.until && ban.until <= time) {
          list.delete(key);
          changed = true;
        }
      }
    }
    if (changed) onChange();
  }

  // AccessControlList::ban. The mask as stored, or null for one that does
  // not parse. `minutes` 0 is forever.
  function ipBan(text, { bannedBy = '', minutes = 0, reason = '' } = {}) {
    const parsed = parseBanMask(text);
    if (!parsed) return null;
    ipBans.set(parsed.key, {
      mask: parsed.mask, entry: parsed.entry, bannedBy, reason,
      until: minutes > 0 ? now() + (minutes * 60000) : 0, at: now(),
    });
    onChange();
    return parsed.mask;
  }

  function ipUnban(text) {
    const parsed = parseBanMask(text);
    const removed = Boolean(parsed) && ipBans.delete(parsed.key);
    if (removed) onChange();
    return removed;
  }

  // The ban that keeps this address out, or null; a null address is never
  // banned, since nothing about it can be trusted.
  function ipBanned(address) {
    if (!address) return null;
    expire();
    for (const ban of ipBans.values()) {
      if (addressMatchesWhitelist(address, [ban.entry])) return ban;
    }
    return null;
  }

  // AccessControlList::sendBan: the mask, the time left under a year, who.
  function ipBanLines(ban) {
    let line = ban.mask;
    const remaining = ban.until ? (ban.until - now()) / 1000 : Infinity;
    if (remaining < 365 * 24 * 3600) line += ` (${(remaining / 60).toFixed(1)} minutes)`;
    if (ban.bannedBy) line += ` banned by: ${ban.bannedBy}`;
    return ban.reason ? [line, `   reason: ${ban.reason}`] : [line];
  }

  function listIpBans(pattern = '') {
    expire();
    const matches = globMatcher(pattern);
    const lines = ['IP Ban List', '-----------'];
    for (const ban of ipBans.values()) {
      if (!matches(ban.mask) && !matches(ban.reason) && !matches(ban.bannedBy)) continue;
      lines.push(...ipBanLines(ban));
    }
    return lines;
  }

  // rejectPlayer's words for an address ban (bzfs.cxx:2218), less the colours.
  function ipBanRefusal(ban) {
    const remaining = ban.until ? (ban.until - now()) / 1000 : Infinity;
    return `REFUSED: ${ban.reason || 'General Ban'}`
      + ` (${remaining < 365 * 24 * 3600 ? `${formatRemaining(remaining)} remaining` : 'indefinite'})`
      + `${ban.bannedBy ? ` by ${ban.bannedBy}` : ''}`;
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
    return {
      idBans: [...idBans].map(([bzid, ban]) => ({ bzid, ...ban })),
      ipBans: [...ipBans.values()].map((ban) => ({
        mask: ban.mask, bannedBy: ban.bannedBy, reason: ban.reason, until: ban.until, at: ban.at,
      })),
    };
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
    ipBans.clear();
    for (const entry of data?.ipBans || []) {
      const parsed = parseBanMask(entry?.mask);
      if (!parsed) continue;
      ipBans.set(parsed.key, {
        mask: parsed.mask,
        entry: parsed.entry,
        bannedBy: String(entry.bannedBy || ''),
        reason: String(entry.reason || ''),
        until: Number(entry.until) || 0,
        at: Number(entry.at) || 0,
      });
    }
    expire();
    return idBans.size + ipBans.size;
  }

  return {
    idBan, idUnban, idBanned, listIdBans,
    ipBan, ipUnban, ipBanned, ipBanLines, listIpBans, ipBanRefusal,
    serialize, load,
  };
}

module.exports = { parseDuration, globMatcher, parseBanMask, formatRemaining, createBanStore };
