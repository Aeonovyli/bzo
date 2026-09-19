import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  KEY_BYTES,
  KEY_MAX_AGE_MS,
  STALE_FAIL_THRESHOLD,
  generateListServerKey,
  signListServerChallenge,
  verifyListServerChallenge,
  isKeyExpired,
  isKeyStale,
  maskKey,
  createKeyStore,
} = require('../server/list-server.cjs');

// 192 bits, 48 hex characters -- alphanumeric only, so a double-click in the
// key admin table selects the whole thing rather than stopping at a `-`/`_`.
assert.equal(KEY_BYTES, 24);
const key = generateListServerKey();
assert.equal(key.length, 48, 'hex of 24 bytes is 48 characters');
assert.match(key, /^[0-9a-f]+$/);
assert.notEqual(generateListServerKey(), generateListServerKey());

// The signed challenge: both sides compute the same signature from the same
// key and nonce, and nothing else does.
const sig = signListServerChallenge('shared-secret', 'nonce-1');
assert.equal(verifyListServerChallenge('shared-secret', 'nonce-1', sig), true);
assert.equal(verifyListServerChallenge('shared-secret', 'nonce-2', sig), false, 'a different nonce');
assert.equal(verifyListServerChallenge('other-secret', 'nonce-1', sig), false, 'a different key');
assert.equal(verifyListServerChallenge('shared-secret', 'nonce-1', 'not-hex'), false, 'garbage signature');
assert.equal(verifyListServerChallenge('shared-secret', 'nonce-1', ''), false, 'empty signature');

// Masking: only the last four characters ever survive, so a listing can show
// "this is registered" without showing the credential itself.
assert.equal(maskKey('abcdefgh'), '****efgh');
assert.equal(maskKey('ab'), '****', 'too short to show any of it');
assert.equal(maskKey(''), '****');

// Expiry: 30 days, from `lastChecked`, or `dateRequested` if never checked.
assert.equal(KEY_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
assert.equal(isKeyExpired({ dateRequested: 0, lastChecked: null }, KEY_MAX_AGE_MS - 1), false);
assert.equal(isKeyExpired({ dateRequested: 0, lastChecked: null }, KEY_MAX_AGE_MS), true);
assert.equal(isKeyExpired({ dateRequested: 0, lastChecked: 1000 }, 1000 + KEY_MAX_AGE_MS - 1), false);
assert.equal(isKeyExpired({ dateRequested: 0, lastChecked: 1000 }, 1000 + KEY_MAX_AGE_MS), true);
assert.equal(isKeyExpired(undefined, 0), true, 'no record is an expired record');

// Staleness: a few consecutive failures, not one.
assert.equal(STALE_FAIL_THRESHOLD, 3);
assert.equal(isKeyStale({ failCount: 2 }), false);
assert.equal(isKeyStale({ failCount: 3 }), true);
assert.equal(isKeyStale(undefined), false);

// The store itself. `now` is injected throughout so expiry is tested rather
// than waited for.
{
  let changes = 0;
  const store = createKeyStore({ onChange: () => { changes++; } });
  const record = store.requestKey({ bzid: '42', callsign: 'Op', url: 'https://a.example.com' }, 1000);
  assert.equal(changes, 1, 'a new key is a change worth persisting');
  assert.equal(store.size, 1);
  assert.match(record.id, /^[0-9a-f-]{36}$/, 'a UUID, not the bearer key itself');
  assert.notEqual(record.id, record.key, 'the row id and the credential are never the same value');

  // Lookup by id (the account UI's handle on the row) and by key (what an
  // incoming report or challenge validation is handed) both find it.
  assert.equal(store.get(record.id, 1000).url, 'https://a.example.com');
  assert.equal(store.getByKey(record.key, 1000).id, record.id);
  assert.equal(store.getByKey('not-a-real-key', 1000), undefined);
  assert.equal(store.get('not-a-real-id', 1000), undefined);
  assert.equal(store.get('', 1000), undefined);

  // A fresh registration has never been checked, and carries no live report.
  assert.equal(record.lastChecked, null);
  assert.equal(record.live, null);

  // Reporting records live state; unreporting (a clean shutdown) clears it
  // without touching the registration itself.
  store.report(record, { title: 'Test', players: 2, maxPlayers: 8 }, 2000);
  assert.deepEqual(store.get(record.id, 2000).live,
    { title: 'Test', players: 2, maxPlayers: 8, lastReportAt: 2000 });
  store.unreport(record);
  assert.equal(store.get(record.id, 2000).live, null);
  assert.equal(store.size, 1, 'the registration itself survives a REMOVE-equivalent');

  // A successful check bumps lastChecked and clears any failure streak; a
  // failure only increments the streak and records why.
  store.markChecked(record, false, 'timeout', 3000);
  assert.equal(store.get(record.id, 3000).failCount, 1);
  assert.equal(store.get(record.id, 3000).lastError, 'timeout');
  store.markChecked(record, true, null, 4000);
  const checked = store.get(record.id, 4000);
  assert.equal(checked.lastChecked, 4000);
  assert.equal(checked.failCount, 0);
  assert.equal(checked.lastError, null);

  // Revocation drops the row from both indexes -- neither lookup finds it
  // again, and it is gone from a listing too.
  assert.equal(store.revoke(record.id), true);
  assert.equal(store.get(record.id, 4000), undefined);
  assert.equal(store.getByKey(record.key, 4000), undefined);
  assert.equal(store.revoke(record.id), false, 'revoking twice is not an error, just nothing to do');
  assert.equal(store.size, 0);
}

// listForBzid / listAll, and expiry sweeping them.
{
  const store = createKeyStore();
  const mine = store.requestKey({ bzid: '1', callsign: 'Me', url: 'https://mine.example.com' }, 0);
  store.requestKey({ bzid: '2', callsign: 'Someone else', url: 'https://theirs.example.com' }, 1000);
  assert.equal(store.listForBzid('1', 1000).length, 1);
  assert.equal(store.listForBzid('1', 1000)[0].id, mine.id);
  assert.equal(store.listAll(1000).length, 2);

  // Never checked, and older than the max age since it was requested: gone
  // from every listing, and swept for good.
  assert.equal(store.listForBzid('1', KEY_MAX_AGE_MS).length, 0);
  assert.equal(store.listAll(KEY_MAX_AGE_MS).length, 1, 'only the other bzid\'s key is left');
  assert.equal(store.sweepExpired(KEY_MAX_AGE_MS), 0, 'listAll already swept the expired one');
}

// Serialize/load: live report state never persists, and a malformed or
// already-expired entry is dropped rather than repaired.
{
  const store = createKeyStore();
  const record = store.requestKey({ bzid: '9', callsign: 'Op', url: 'https://a.example.com' }, 1000);
  store.report(record, { title: 'Test', players: 1, maxPlayers: 4 }, 1000);
  const serialized = store.serialize(1000);
  assert.equal(serialized.version, 1);
  assert.equal(serialized.keys[record.id].key, record.key);
  assert.equal('live' in serialized.keys[record.id], false, 'live report state is not durable');

  const reloaded = createKeyStore();
  assert.equal(reloaded.load(serialized, 1000), 1);
  const restored = reloaded.get(record.id, 1000);
  assert.equal(restored.url, 'https://a.example.com');
  assert.equal(restored.key, record.key);
  assert.equal(restored.live, null);
  assert.equal(reloaded.getByKey(record.key, 1000).id, record.id);

  assert.equal(reloaded.load({ keys: { bad: { bzid: '1' } } }, 1000), 0, 'missing fields are dropped');
  assert.equal(reloaded.load(null, 1000), 0);
  assert.equal(reloaded.load({}, 1000), 0);
}

console.log('list-server tests passed');
