import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findPublicServer } = require('../server/remote-world-import.cjs');

const publicServers = [
  { host: 'example.org', port: 5154, title: 'Example' },
  { host: 'alternate.example.org', port: 4200, title: 'Alternate' },
];

assert.equal(findPublicServer(publicServers, 'example.org', 5154), publicServers[0]);
assert.equal(findPublicServer(publicServers, 'EXAMPLE.ORG', 5154), publicServers[0],
  'DNS hostnames are case-insensitive and the public record is returned as the canonical target');
assert.equal(findPublicServer(publicServers, 'example.org', 4200), null,
  'a listed hostname on an unlisted port is refused');
assert.equal(findPublicServer(publicServers, 'private.example.org', 5154), null,
  'an unlisted hostname is refused');
assert.equal(findPublicServer(publicServers, 'example.org', '5154'), null,
  'the parsed numeric port is required');
assert.equal(findPublicServer(null, 'example.org', 5154), null);
assert.equal(findPublicServer([{ host: null, port: 5154 }], 'example.org', 5154), null,
  'malformed public-list entries are ignored');

console.log('remote world import tests passed');