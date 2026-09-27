/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The transcript, written down and read back.
//
// Upstream keeps nothing: `ControlPanel`'s messages live and die with the
// process, and the only way to keep a copy is to ask for one (`/savemsgs`,
// CommandsImplementation.cxx:778). That is enough there because the process is
// long-lived -- an upstream client sits through a server restart, a leave and a
// rejoin with its window intact. bzo's process is the tab, and bzo reloads the
// tab on its own whenever the server ships new client code
// (`checkClientBuild`), which while something is being worked on is many times
// an hour. So the transcript needs writing down here to buy what upstream gets
// for free.
//
// Both halves live in this module rather than in client.js because neither
// needs the DOM: one turns the tab arrays into something `JSON.stringify` can
// take, the other turns it back, and `/savemsgs` formats the same entries as
// text. client.js owns the state, the storage and the file.

// Bumped when the stored shape changes; a cache written by an older shape is
// dropped rather than guessed at.
export const CHAT_CACHE_VERSION = 1;

// How many lines are written down, counting a line once however many tabs it is
// in. Far short of `CHAT_SCROLLBACK_LIMIT`, because this answers "what did I
// miss" rather than "what was ever said", and every line costs part of a
// `JSON.stringify` on a client that may be CPU bound.
export const CHAT_CACHE_LIMIT = 200;

// The debug tab is deliberately absent. Those lines already reach the server
// and land in server.log, which outlives the tab by more than any cache does;
// keeping them here as well would spend the whole budget on the noisiest tab
// and evict the chat this exists for.
export const CHAT_CACHE_TABS = Object.freeze(['all', 'chat', 'server', 'misc']);

// A line is one object shared by every tab it appears in, so which tabs those
// are is found by identity, and the order comes from `seq` -- the counter
// client.js stamps each entry with. Ordering on `ts` instead would shuffle the
// lines of a burst that landed on the same millisecond.
export function packChatCache(messagesByTab, limit = CHAT_CACHE_LIMIT) {
  const seen = new Map();
  CHAT_CACHE_TABS.forEach((tab) => {
    const list = messagesByTab?.[tab];
    if (!Array.isArray(list)) return;
    list.forEach((entry) => {
      if (!entry) return;
      let record = seen.get(entry);
      if (!record) {
        record = { entry, tabs: [] };
        seen.set(entry, record);
      }
      record.tabs.push(tab);
    });
  });
  const records = [...seen.values()];
  // A stable sort, so entries that never got a `seq` keep the order the tabs
  // were walked in rather than an arbitrary one.
  records.sort((a, b) => (a.entry.seq ?? 0) - (b.entry.seq ?? 0));
  const lines = records.slice(Math.max(0, records.length - limit)).map(({ entry, tabs }) => {
    const line = { text: String(entry.text ?? ''), kind: entry.kind, tabs };
    if (Number.isFinite(entry.ts)) line.ts = entry.ts;
    if (Array.isArray(entry.segments) && entry.segments.length > 0) line.segments = entry.segments;
    return line;
  });
  return { v: CHAT_CACHE_VERSION, lines };
}

function unpackSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const clean = segments
    .filter((segment) => segment && typeof segment.text === 'string')
    .map((segment) => (segment.color === undefined
      ? { text: segment.text }
      : { text: segment.text, color: segment.color }));
  return clean.length > 0 ? clean : null;
}

// What comes back out of storage is treated as untrusted: it was written by
// whichever version of bzo the tab ran before the reload, and a line that does
// not make sense is dropped rather than allowed to reach the renderer.
export function unpackChatCache(saved, limit = CHAT_CACHE_LIMIT) {
  if (!saved || saved.v !== CHAT_CACHE_VERSION || !Array.isArray(saved.lines)) return [];
  const lines = saved.lines.slice(Math.max(0, saved.lines.length - limit));
  const restored = [];
  lines.forEach((line) => {
    if (!line || typeof line.text !== 'string') return;
    const tabs = Array.isArray(line.tabs)
      ? [...new Set(line.tabs.filter((tab) => CHAT_CACHE_TABS.includes(tab)))]
      : [];
    if (tabs.length === 0) return;
    restored.push({
      text: line.text,
      kind: typeof line.kind === 'string' ? line.kind : 'misc',
      segments: unpackSegments(line.segments),
      ts: Number.isFinite(line.ts) ? line.ts : null,
      tabs,
    });
  });
  return restored;
}

// `/savemsgs -t`, which is upstream's `[%04d-%02d-%02d %02d:%02d:%02d] `
// (`ControlPanelMessage::formatTimestamp` mode 2), in local time as upstream's
// own is.
export function formatTranscriptTimestamp(ms) {
  const at = new Date(ms);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `[${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}] `;
}

// The same instant without the brackets, which is what both the file's header
// and its name are built from.
function plainTimestamp(ms) {
  return formatTranscriptTimestamp(ms).slice(1, -2);
}

// Upstream's own name for the file it writes into the config dir
// (CommandsImplementation.cxx:778); here it is what the browser is asked to
// call the download.
export function transcriptFilename(at = Date.now()) {
  return `msglog-${plainTimestamp(at).replace(' ', '_').replace(/:/g, '-')}.txt`;
}

// The All tab as text, with upstream's own header and rule
// (`ControlPanel::saveMessages`). Upstream's `-s` has nothing to do here: bzo
// carries a line's colours in its segments rather than in ANSI escapes inside
// the text, so what is written is already stripped.
export function formatTranscript(messages, { timestamps = false, savedAt = Date.now() } = {}) {
  const rule = '----------------------------------------';
  const head = `\n${rule}\nMessages saved: ${plainTimestamp(savedAt)}\n${rule}\n\n`;
  const body = (messages ?? []).map((entry) => {
    const stamp = timestamps && Number.isFinite(entry?.ts) ? formatTranscriptTimestamp(entry.ts) : '';
    return `${stamp}${String(entry?.text ?? '')}\n`;
  }).join('');
  return head + body;
}
