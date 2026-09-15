/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Speaks just enough of the real BZFS wire protocol to fetch a live server's
// world database and turn it into a `.bzw` bzo can load -- the guts behind
// both `scripts/survey-live-maps.mjs` (a CLI survey across many servers) and
// server.js's `importMap` (one operator, one server, loaded straight into
// bzo's own maps/ for Map Viewer). This file is the single source of truth
// for the wire format so the two never drift apart; see the script for the
// long version of how the protocol and the binary world format work.
//
// It never sends MsgEnter, so it never occupies a player slot -- bzfs answers
// MsgQueryGame/MsgWantSettings/MsgWantWHash/MsgGetWorld to any connection,
// entered or not, same as bzfquery.py.

const net = require('node:net');
const zlib = require('node:zlib');

const PROTOCOL_VERSION = 'BZFS0221';
const DEFAULT_LIST_SERVER = 'https://my.bzflag.org/db/';

// A malformed or hostile "server" could claim an endless `bytesLeft` on every
// MsgGetWorld reply; this is the only thing standing between that and
// unbounded memory growth in the live bzo process (the CLI script has no such
// guard -- a runaway `node` process there is the user's own problem to Ctrl-C).
const MAX_WORLD_DATABASE_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wire-format reader: a cursor over a Buffer, matching nboUnpack* semantics
// (big-endian, as bzflag's `nbo` -- network byte order -- helpers pack them).
// ---------------------------------------------------------------------------

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.o = 0;
  }

  u8() { const v = this.buf.readUInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.buf.readUInt16BE(this.o); this.o += 2; return v; }
  i32() { const v = this.buf.readInt32BE(this.o); this.o += 4; return v; }
  u32() { const v = this.buf.readUInt32BE(this.o); this.o += 4; return v; }
  f32() { const v = this.buf.readFloatBE(this.o); this.o += 4; return v; }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  skip(n) { this.o += n; }
  bytes(n) { const b = this.buf.subarray(this.o, this.o + n); this.o += n; return b; }

  str() {
    const len = this.u32();
    const s = this.buf.toString('utf8', this.o, this.o + len);
    this.o += len;
    return s;
  }

  flagAbbv() {
    return this.bytes(2).toString('latin1').replace(/\0+$/, '');
  }

  get remaining() { return this.buf.length - this.o; }
}

// ---------------------------------------------------------------------------
// Server list: POST action=LIST to the list server and parse the plain-text
// reply ($HOME/bzflag/src/game/ServerList.cxx, readServerList/checkEchos).
// Each line is "host:port version pingInfoHex address title...". The hex
// blob is PingPacket::packHex ($HOME/bzflag/src/net/Ping.cxx) -- 8 uint16's
// then 13 uint8's -- which already carries game type, options and every
// team's current/max player count. Decoding it here means the whole running
// server list, with live player counts, comes from one HTTP request; no
// server in the list is actually connected to until an operator picks one.
// ---------------------------------------------------------------------------

function decodePingHex(hex) {
  if (typeof hex !== 'string' || hex.length !== 58) return null;
  let o = 0;
  const u16 = () => { const v = parseInt(hex.slice(o, o + 4), 16); o += 4; return v; };
  const u8 = () => { const v = parseInt(hex.slice(o, o + 2), 16); o += 2; return v; };
  const gameType = u16();
  const gameOptionsBits = u16();
  const maxShots = u16();
  const shakeWins = u16();
  const shakeTimeout = u16();
  const maxPlayerScore = u16();
  const maxTeamScore = u16();
  const maxTime = u16();
  const maxPlayers = u8();
  // Rogue, red, green, blue, purple, observer -- the same order `-mp
  // a,b,c,d,e,f` already takes (`BZFLAG_MP_TEAM_ORDER`, server/teams.cjs),
  // so `teamMaximums` can be written back out unchanged.
  const rogueCount = u8(); const rogueMax = u8();
  const redCount = u8(); const redMax = u8();
  const greenCount = u8(); const greenMax = u8();
  const blueCount = u8(); const blueMax = u8();
  const purpleCount = u8(); const purpleMax = u8();
  const observerCount = u8(); const observerMax = u8();
  if (Number.isNaN(gameType) || Number.isNaN(observerMax)) return null;
  const players = rogueCount + redCount + greenCount + blueCount + purpleCount;
  return {
    style: GAME_STYLES[gameType] || `type${gameType}`,
    gameOptionsBits, maxShots, shakeWins, shakeTimeout,
    maxPlayerScore, maxTeamScore, maxTime, maxPlayers,
    players, observerCount,
    teamMaximums: [rogueMax, redMax, greenMax, blueMax, purpleMax, observerMax],
  };
}

async function fetchServerList(url, version) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `action=LIST&version=${encodeURIComponent(version)}`,
  });
  const text = await res.text();
  const servers = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('NOTICE:')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const [nameport, ver, infoHex, , ...titleParts] = parts;
    if (ver !== version) continue;
    let host = nameport;
    let port = 5154;
    const idx = nameport.lastIndexOf(':');
    if (idx !== -1) {
      host = nameport.slice(0, idx);
      port = parseInt(nameport.slice(idx + 1), 10) || 5154;
    }
    servers.push({ host, port, title: titleParts.join(' '), info: decodePingHex(infoHex) });
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Protocol: connect, skip MsgEnter entirely (bzfs answers world-download
// messages before a player has entered -- see the `!isCompletelyAdded()`
// switch in bzfs.cxx's handleCommand), and page through the world database.
// ---------------------------------------------------------------------------

function sendFrame(socket, codeStr, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(payload.length, 0);
  header.write(codeStr, 2, 2, 'ascii');
  socket.write(Buffer.concat([header, payload]));
}

function fetchWorldFromServer(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    const waiters = [];
    let settled = false;

    const watchdog = setTimeout(() => fail(new Error('timed out')), timeout);

    function cleanup() {
      clearTimeout(watchdog);
      socket.destroy();
    }
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function succeed(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function pump() {
      while (waiters.length && buffer.length >= waiters[0].n) {
        const w = waiters.shift();
        const out = buffer.subarray(0, w.n);
        buffer = buffer.subarray(w.n);
        w.resolve(out);
      }
    }
    function readExact(n) {
      return new Promise((res) => {
        waiters.push({ n, resolve: res });
        pump();
      });
    }
    async function readFrame() {
      const header = await readExact(4);
      const len = header.readUInt16BE(0);
      const code = header.toString('ascii', 2, 4);
      const payload = len > 0 ? await readExact(len) : Buffer.alloc(0);
      return { code, payload };
    }

    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      pump();
    });
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('connection closed')));

    socket.on('connect', async () => {
      try {
        socket.write('BZFLAG\r\n\r\n');
        const version = (await readExact(8)).toString('ascii');
        const playerId = (await readExact(1)).readUInt8(0);
        if (version !== PROTOCOL_VERSION) {
          throw new Error(`protocol ${version} (bzo speaks ${PROTOCOL_VERSION})`);
        }
        if (playerId === 0xff) throw new Error('rejected (full, banned, or closed)');

        // MsgQueryGame is the same admin-style query bzfquery.py uses (also
        // without ever sending MsgEnter) -- it carries maxPlayerScore/
        // maxTeamScore/maxTime and the game style, none of which are in
        // MsgGameSettings below.
        sendFrame(socket, 'qg');
        let queryGame = null;
        for (;;) {
          const { code, payload } = await readFrame();
          if (code === 'qg') { queryGame = payload; break; }
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} querying game`);
        }

        // Declare zero known flag types; we never look at the server's reply,
        // so it does not matter that it will call every flag "missing".
        sendFrame(socket, 'nf');
        for (;;) {
          const { code } = await readFrame();
          if (code === 'nf') break;
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} negotiating flags`);
        }

        sendFrame(socket, 'ws');
        let gameSettings = null;
        for (;;) {
          const { code, payload } = await readFrame();
          if (code === 'gs') { gameSettings = payload; break; }
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} requesting settings`);
        }

        sendFrame(socket, 'wh');
        for (;;) {
          const { code } = await readFrame();
          if (code === 'wh') break;
          if (code === 'cu') continue; // cache URL offered; we always pull direct
          if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} requesting world hash`);
        }

        const parts = [];
        let ptr = 0;
        for (;;) {
          const req = Buffer.alloc(4);
          req.writeUInt32BE(ptr, 0);
          sendFrame(socket, 'gw', req);
          let chunk, bytesLeft;
          for (;;) {
            const { code, payload } = await readFrame();
            if (code === 'gw') { bytesLeft = payload.readUInt32BE(0); chunk = payload.subarray(4); break; }
            if (code === 'sk' || code === 'rj') throw new Error(`server sent ${code} downloading world`);
          }
          parts.push(chunk);
          ptr += chunk.length;
          if (ptr > MAX_WORLD_DATABASE_BYTES) throw new Error('world database exceeded the size limit');
          if (bytesLeft === 0) break;
        }

        succeed({ worldDatabase: Buffer.concat(parts), gameSettings, queryGame });
      } catch (err) {
        fail(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Game settings and rules: MsgGameSettings (makeGameSettings in bzfs.cxx) and
// MsgQueryGame (sendQueryGame; the same message bzfquery.py's queryGame()
// reads). Between the two we get everything an `options` block in a bzw file
// can express: which flag/physics switches are on, shot count, superflag
// count, shake timeout/wins, world acceleration, and the score/time limits
// that only MsgQueryGame carries.
// ---------------------------------------------------------------------------

const GAME_STYLES = ['TeamFFA', 'ClassicCTF', 'OpenFFA', 'RabbitChase'];
const GAME_OPTION_BITS = {
  flags: 0x0002, jumping: 0x0008, inertia: 0x0010, ricochet: 0x0020,
  shaking: 0x0040, antidote: 0x0080, handicap: 0x0100, noTeamKills: 0x0400,
};

function decodeGameSettings(buf) {
  const r = new Reader(buf);
  const worldSize = r.f32();
  const gameType = r.u16();
  const gameOptionsBits = r.u16();
  r.u16(); // PlayerSlot -- a client-side workaround value, not a real player count
  const maxShots = r.u16();
  const numFlags = r.u16();
  const linearAcceleration = r.f32();
  const angularAcceleration = r.f32();
  const shakeTimeout = r.u16();
  const shakeWins = r.u16();
  return {
    worldSize, gameType, gameOptionsBits, maxShots, numFlags,
    linearAcceleration, angularAcceleration, shakeTimeout, shakeWins,
  };
}

function decodeQueryGame(buf) {
  const r = new Reader(buf);
  const style = r.u16();
  r.u16(); // options (duplicate of MsgGameSettings' bitmask)
  r.u16(); // maxPlayers (duplicate of decodePingHex's own, and just the sum
  // of teamMaximums below plus its own observer slot -- CmdLineOptions.cxx:458)
  r.u16(); // maxShots (duplicate)
  for (let i = 0; i < 6; i++) r.u16(); // per-team current sizes -- live player
  // counts at the moment of the query, not a map property, so left unread
  // the same way a snapshot of who is playing right now always is.
  // Rogue, red, green, blue, purple, observer, in that order -- the same
  // order `-mp a,b,c,d,e,f` already takes (`BZFLAG_MP_TEAM_ORDER`,
  // server/teams.cjs), so this can be written back out unchanged.
  const teamMaximums = Array.from({ length: 6 }, () => r.u16());
  r.u16(); // shakeWins (duplicate)
  r.u16(); // shakeTimeout (duplicate)
  const maxPlayerScore = r.u16();
  const maxTeamScore = r.u16();
  const maxTime = r.u16();
  return {
    style, maxPlayerScore, maxTeamScore, maxTime, teamMaximums,
  };
}

// ---------------------------------------------------------------------------
// World database parser. Field order and widths follow, in this order:
// WorldBuilder::unpack, DynamicColorManager/TextureMatrixManager/
// BzMaterialManager/PhysicsDriverManager/MeshTransformManager::unpack,
// GroupDefinitionMgr/GroupDefinition/GroupInstance::unpack, LinkManager::unpack,
// Weapon::unpack, EntryZone::unpack (all under $HOME/bzflag/src). Every field
// that survives is kept (not just tallied), so the same tree can drive both
// a feature-usage report and the .bzw re-export.
// ---------------------------------------------------------------------------

const OBSTACLE_ORDER = ['wall', 'box', 'pyr', 'base', 'tele', 'mesh', 'arc', 'cone', 'sphere', 'tetra'];

function parseDynamicColor(r) {
  const name = r.str();
  const channels = [];
  for (let c = 0; c < 4; c++) {
    const min = r.f32();
    const max = r.f32();
    const sinCount = r.u32();
    const sinusoids = Array.from({ length: sinCount }, () => ({ period: r.f32(), offset: r.f32(), weight: r.f32() }));
    const upCount = r.u32();
    const clampUps = Array.from({ length: upCount }, () => ({ period: r.f32(), offset: r.f32(), width: r.f32() }));
    const downCount = r.u32();
    const clampDowns = Array.from({ length: downCount }, () => ({ period: r.f32(), offset: r.f32(), width: r.f32() }));
    const seqCount = r.u32();
    let sequence = { period: 0, offset: 0, list: [] };
    if (seqCount > 0) {
      const period = r.f32();
      const offset = r.f32();
      const list = Array.from({ length: seqCount }, () => r.u8());
      sequence = { period, offset, list };
    }
    channels.push({ min, max, sinusoids, clampUps, clampDowns, sequence });
  }
  return { name, channels };
}

function parseTextureMatrix(r) {
  const name = r.str();
  const state = r.u8();
  const useStatic = !!(state & 1);
  const useDynamic = !!(state & 2);
  const t = { name, useStatic, useDynamic };
  if (useStatic) {
    t.rotation = r.f32();
    t.uFixedShift = r.f32(); t.vFixedShift = r.f32();
    t.uFixedScale = r.f32(); t.vFixedScale = r.f32();
    t.uFixedCenter = r.f32(); t.vFixedCenter = r.f32();
  }
  if (useDynamic) {
    t.spinFreq = r.f32();
    t.uShiftFreq = r.f32(); t.vShiftFreq = r.f32();
    t.uScaleFreq = r.f32(); t.vScaleFreq = r.f32();
    t.uScale = r.f32(); t.vScale = r.f32();
    t.uCenter = r.f32(); t.vCenter = r.f32();
  }
  return t;
}

function parseMaterial(r) {
  const name = r.str();
  const mode = r.u8();
  const dynamicColor = r.i32();
  const ambient = [r.f32(), r.f32(), r.f32(), r.f32()];
  const diffuse = [r.f32(), r.f32(), r.f32(), r.f32()];
  const specular = [r.f32(), r.f32(), r.f32(), r.f32()];
  const emission = [r.f32(), r.f32(), r.f32(), r.f32()];
  const shininess = r.f32();
  const alphaThreshold = r.f32();
  const textureCount = r.u8();
  const textures = [];
  for (let i = 0; i < textureCount; i++) {
    const texName = r.str();
    const matrix = r.i32();
    const combineMode = r.i32();
    const texState = r.u8();
    textures.push({
      name: texName, matrix, combineMode,
      useAlpha: !!(texState & 1), useColor: !!(texState & 2), useSphereMap: !!(texState & 4),
    });
  }
  const shaderCount = r.u8();
  const shaders = Array.from({ length: shaderCount }, () => ({ name: r.str() }));
  return {
    name,
    noCulling: !!(mode & 1), noSorting: !!(mode & 2), noRadar: !!(mode & 4), noShadow: !!(mode & 8),
    occluder: !!(mode & 16), groupAlpha: !!(mode & 32), noLighting: !!(mode & 64),
    dynamicColor, ambient, diffuse, specular, emission, shininess, alphaThreshold, textures, shaders,
  };
}

function parsePhysicsDriver(r) {
  const name = r.str();
  const linear = r.vec3();
  const angularVel = r.f32();
  const angularPos = [r.f32(), r.f32()];
  const radialVel = r.f32();
  const radialPos = [r.f32(), r.f32()];
  const slideTime = r.f32();
  const deathMsg = r.str();
  return { name, linear, angularVel, angularPos, radialVel, radialPos, slideTime, deathMsg };
}

// MeshTransform::unpack: a named, ordered list of shift/scale/shear/spin/index
// operations. Used both for the manager's own named transforms and inline
// wherever an arc/cone/sphere/tetra/group carries its own anonymous one.
function parseTransform(r) {
  const name = r.str();
  const count = r.u32();
  const ops = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    if (type === 4) { ops.push({ type, index: r.i32() }); continue; }
    const data = r.vec3();
    const spin = type === 3 ? r.f32() : 0;
    ops.push({ type, data, spin });
  }
  return { name, ops };
}

function parseBoxLike(r) {
  const pos = r.vec3();
  const angle = r.f32();
  const size = r.vec3();
  const state = r.u8();
  return {
    pos, angle, size,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2),
    flipZ: !!(state & 4), ricochet: !!(state & 8),
  };
}

function parseBase(r) {
  const team = r.u16();
  return { team, ...parseBoxLike(r) };
}

function parseTeleporter(r) {
  const name = r.str();
  const pos = r.vec3();
  const angle = r.f32();
  const size = r.vec3();
  const border = r.f32();
  const horizontal = r.u8() !== 0;
  const state = r.u8();
  return {
    name, pos, angle, size, border, horizontal,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2), ricochet: !!(state & 8),
  };
}

function parseWall(r) {
  const pos = r.vec3();
  const angle = r.f32();
  const y = r.f32();
  const z = r.f32();
  const state = r.u8();
  return { pos, angle, y, z, ricochet: !!(state & 8) };
}

function parseMeshFace(r) {
  const state = r.u8();
  const useNormals = !!(state & 1);
  const useTexcoords = !!(state & 2);
  const vcount = r.i32();
  const vertexIdx = Array.from({ length: vcount }, () => r.i32());
  const normalIdx = useNormals ? Array.from({ length: vcount }, () => r.i32()) : null;
  const texcoordIdx = useTexcoords ? Array.from({ length: vcount }, () => r.i32()) : null;
  const matindex = r.i32();
  const phydrv = r.i32();
  return {
    vertexIdx, normalIdx, texcoordIdx, matindex, phydrv,
    driveThrough: !!(state & 4), shootThrough: !!(state & 8),
    smoothBounce: !!(state & 16), noclusters: !!(state & 32), ricochet: !!(state & 64),
  };
}

function parseMesh(r) {
  const checkCount = r.i32();
  const checks = Array.from({ length: checkCount }, () => ({ type: r.u8(), point: r.vec3() }));
  const vertexCount = r.i32();
  const vertices = Array.from({ length: vertexCount }, () => r.vec3());
  const normalCount = r.i32();
  const normals = Array.from({ length: normalCount }, () => r.vec3());
  const texcoordCount = r.i32();
  // Usually literal (u,v) pairs; a mesh built with drawInfo optimization hides
  // extra binary data in this same region, which we don't attempt to detect --
  // we still consume the right number of bytes either way, so nothing downstream
  // of the mesh is affected, but such a mesh's last texcoord line or two may be
  // bogus rather than real UVs.
  const texcoords = Array.from({ length: texcoordCount }, () => [r.f32(), r.f32()]);
  const faceSize = r.i32();
  const faces = Array.from({ length: faceSize }, () => parseMeshFace(r));
  const state = r.u8();
  return {
    checks, vertices, normals, texcoords, faces,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2),
    smoothBounce: !!(state & 4), noclusters: !!(state & 8), ricochet: !!(state & 32),
  };
}

function parseCurved(r, kind) {
  const transform = parseTransform(r);
  const pos = r.vec3();
  const size = r.vec3();
  const angle = r.f32();
  const sweepAngle = kind === 'sphere' ? null : r.f32();
  const ratio = kind === 'arc' ? r.f32() : null;
  const divisions = r.i32();
  const phydrv = r.i32();
  const texCount = kind === 'arc' ? 4 : 2;
  const texsize = Array.from({ length: texCount }, () => r.f32());
  const materialCount = kind === 'arc' ? 6 : kind === 'cone' ? 4 : 2;
  const materials = Array.from({ length: materialCount }, () => r.i32());
  const state = r.u8();
  const hemisphere = kind === 'sphere' ? !!(state & 16) : false;
  const ricochet = kind === 'sphere' ? !!(state & 32) : !!(state & 16);
  return {
    transform, pos, size, angle, sweepAngle, ratio, divisions, phydrv, texsize, materials,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2), smoothBounce: !!(state & 4),
    useNormals: !!(state & 8), hemisphere, ricochet,
  };
}

function parseTetra(r) {
  const state = r.u8();
  const transform = parseTransform(r);
  const vertices = Array.from({ length: 4 }, () => r.vec3());
  const useNormalsByte = r.u8();
  const normals = [];
  for (let v = 0; v < 4; v++) normals.push((useNormalsByte & (1 << v)) ? Array.from({ length: 3 }, () => r.vec3()) : null);
  const useTexByte = r.u8();
  const texcoords = [];
  for (let v = 0; v < 4; v++) texcoords.push((useTexByte & (1 << v)) ? Array.from({ length: 3 }, () => [r.f32(), r.f32()]) : null);
  const materials = Array.from({ length: 4 }, () => r.i32());
  return {
    transform, vertices, normals, texcoords, materials,
    driveThrough: !!(state & 1), shootThrough: !!(state & 2), ricochet: !!(state & 4),
  };
}

function parseGroupInstance(r) {
  const groupdef = r.str();
  const nameLen = r.u32();
  r.skip(nameLen); // instance name; may hide a material remap table, irrelevant here
  const transform = parseTransform(r);
  const bits = r.u8();
  const inst = {
    groupdef, transform,
    modifyTeam: !!(bits & 1), modifyColor: !!(bits & 2),
    modifyPhysicsDriver: !!(bits & 4), modifyMaterial: !!(bits & 8),
    driveThrough: !!(bits & 16), shootThrough: !!(bits & 32), ricochet: !!(bits & 64),
  };
  if (inst.modifyTeam) inst.team = r.u16();
  if (inst.modifyColor) inst.tint = [...r.vec3(), r.f32()];
  if (inst.modifyPhysicsDriver) inst.phydrv = r.i32();
  if (inst.modifyMaterial) inst.material = r.i32();
  return inst;
}

const OBSTACLE_PARSERS = {
  wall: parseWall, box: parseBoxLike, pyr: parseBoxLike, base: parseBase, tele: parseTeleporter,
  mesh: parseMesh, arc: (r) => parseCurved(r, 'arc'), cone: (r) => parseCurved(r, 'cone'),
  sphere: (r) => parseCurved(r, 'sphere'), tetra: parseTetra,
};

function parseGroupDefinition(r, isWorld) {
  const name = r.str();
  const obstacles = {};
  for (const kind of OBSTACLE_ORDER) {
    const count = r.u32();
    obstacles[kind] = Array.from({ length: count }, () => OBSTACLE_PARSERS[kind](r));
  }
  const groupInstanceCount = r.u32();
  const groupInstances = Array.from({ length: groupInstanceCount }, () => parseGroupInstance(r));
  return { name, isWorld, obstacles, groupInstances };
}

function parseGroupDefinitionMgr(r) {
  const world = parseGroupDefinition(r, true);
  const count = r.u32();
  const groupDefs = Array.from({ length: count }, () => parseGroupDefinition(r, false));
  return { world, groupDefs };
}

function parseWeapon(r) {
  const flagAbbv = r.flagAbbv();
  const pos = r.vec3();
  const dir = r.f32();
  const initDelay = r.f32();
  const delayCount = r.u16();
  const delay = Array.from({ length: delayCount }, () => r.f32());
  return { flagAbbv, pos, dir, initDelay, delay };
}

function parseEntryZone(r) {
  const pos = r.vec3();
  const size = r.vec3();
  const rot = r.f32();
  const flagCount = r.u16();
  const teamCount = r.u16();
  const safetyCount = r.u16();
  const flags = Array.from({ length: flagCount }, () => r.flagAbbv());
  const teams = Array.from({ length: teamCount }, () => r.u16());
  const safety = Array.from({ length: safetyCount }, () => r.u16());
  return { pos, size, rot, flags, teams, safety };
}

function parseWorldDatabase(fullBuf) {
  const header = new Reader(fullBuf);
  header.u16(); // length (legacy field, unused by this reader)
  const code = header.u16();
  if (code !== 0x6865) throw new Error('missing world header (not a WorldBuilder blob)');
  const mapVersion = header.u16();
  const uncompressedSize = header.u32();
  const compressedSize = header.u32();
  const compressed = header.bytes(compressedSize);
  const inflated = zlib.inflateSync(compressed);
  if (inflated.length !== uncompressedSize) {
    throw new Error(`decompressed to ${inflated.length} bytes, expected ${uncompressedSize}`);
  }

  const r = new Reader(inflated);

  const dynamicColors = Array.from({ length: r.u32() }, () => parseDynamicColor(r));
  const textureMatrices = Array.from({ length: r.u32() }, () => parseTextureMatrix(r));
  const materials = Array.from({ length: r.u32() }, () => parseMaterial(r));
  const physicsDrivers = Array.from({ length: r.u32() }, () => parsePhysicsDriver(r));
  const meshTransforms = Array.from({ length: r.u32() }, () => parseTransform(r));

  const { world, groupDefs } = parseGroupDefinitionMgr(r);

  const links = Array.from({ length: r.u32() }, () => ({ src: r.str(), dst: r.str() }));

  const waterLevel = r.f32();
  const waterMaterial = waterLevel >= 0 ? r.i32() : -1;

  const weapons = Array.from({ length: r.u32() }, () => parseWeapon(r));
  const zones = Array.from({ length: r.u32() }, () => parseEntryZone(r));

  return {
    mapVersion,
    trailingBytes: r.remaining,
    managers: { dynamicColors, textureMatrices, materials, physicsDrivers, meshTransforms },
    world, groupDefs, links, waterLevel, waterMaterial, weapons, zones,
  };
}

// ---------------------------------------------------------------------------
// .bzw re-export -- mirrors what each obstacle/manager's own print() writes
// in the upstream client (BoxBuilding::print, MeshObstacle::print,
// BzMaterial::print, GroupDefinition::printGrouped, World::writeWorld, ...),
// which is the same text BZFlag's "Save World" menu item produces.
// ---------------------------------------------------------------------------

function fmt(n) {
  if (Object.is(n, -0)) n = 0;
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toFixed(6)));
}
function fmt3(v) { return `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`; }

// Everything an `options` block can carry that parseBZWServerOptions in
// server.js actually reads, derived from the server's own MsgGameSettings/
// MsgQueryGame answers -- so a map loaded into bzo plays by close to the same
// rules it was surveyed under, not just the same geometry.
function buildOptionsLines(gameSettings, queryGame, listInfo) {
  const lines = [];
  const has = (bit) => (gameSettings.gameOptionsBits & bit) !== 0;
  // GameType (`include/global.h:94`) is its own axis from the GameOptions
  // bitmask below, and bzo's own parser already reads all three switches
  // that select it (docs/bzw.md, "The `options` block"; how bzo reaches
  // each type from them is in docs/game-modes-plan.md, "What bzo has").
  // TeamFFA (0) is upstream's own default and needs no switch -- and, like
  // upstream itself, there is no switch to *force* it either, so a TeamFFA
  // source loaded onto a server whose own config defaults elsewhere plays
  // by that config's default instead, the same gap a real bzfs's own "Save
  // World" has.
  if (gameSettings.gameType === 1) lines.push('  -c');
  else if (gameSettings.gameType === 2) lines.push('  -offa');
  else if (gameSettings.gameType === 3) lines.push('  -rabbit');
  if (has(GAME_OPTION_BITS.jumping)) lines.push('  -j');
  if (has(GAME_OPTION_BITS.ricochet)) lines.push('  +r');
  if (has(GAME_OPTION_BITS.antidote)) lines.push('  -sa');
  if (has(GAME_OPTION_BITS.shaking)) {
    lines.push(`  -st ${fmt(gameSettings.shakeTimeout / 10)}`);
    lines.push(`  -sw ${gameSettings.shakeWins}`);
  }
  // `-handicap` (`CmdLineOptions.cxx:830-833`) -- recorded faithfully even
  // though bzo does not act on it yet (`docs/game-modes-plan.md`,
  // "Handicap"): the source server's own setting belongs in the file
  // regardless of whether bzo's own parser does anything with it today.
  if (has(GAME_OPTION_BITS.handicap)) lines.push('  -handicap');
  if (has(GAME_OPTION_BITS.noTeamKills)) lines.push('  -noTeamKills');
  if (gameSettings.linearAcceleration !== 0 || gameSettings.angularAcceleration !== 0) {
    lines.push(`  -a ${fmt(gameSettings.linearAcceleration)} ${fmt(gameSettings.angularAcceleration)}`);
  }
  lines.push(`  -ms ${gameSettings.maxShots}`);
  if (has(GAME_OPTION_BITS.flags) && gameSettings.numFlags > 0) {
    lines.push(`  -s ${gameSettings.numFlags}`);
  } else if (has(GAME_OPTION_BITS.antidote) || has(GAME_OPTION_BITS.shaking)) {
    // Antidote and Shakable only mean anything with a bad flag actually in
    // play, so the source server must have superflags on even when this
    // snapshot's `numFlags` came back 0 or the `flags` bit itself did not --
    // upstream's own default count for a bare `+s`/`-s 0`
    // (`CmdLineOptions.cxx:1174-1178`). The exact count isn't known, but
    // that flags exist at all is, from these two bits alone.
    lines.push('  -s 16');
  }
  // `-mp a,b,c,d,e,f` (rogue, red, green, blue, purple, observer -- the same
  // order `BZFLAG_MP_TEAM_ORDER` in `server/teams.cjs` already expects).
  // `queryGame`'s own live answer is preferred; the list server's cached
  // ping-hex (`listInfo`) is the fallback for a server that did not answer
  // `MsgQueryGame` on this particular import.
  const teamMaximums = queryGame?.teamMaximums || listInfo?.teamMaximums || null;
  if (teamMaximums && teamMaximums.some((n) => n > 0)) {
    lines.push(`  -mp ${teamMaximums.join(',')}`);
  }
  if (queryGame) {
    if (queryGame.maxPlayerScore > 0) lines.push(`  -mps ${queryGame.maxPlayerScore}`);
    if (queryGame.maxTeamScore > 0) lines.push(`  -mts ${queryGame.maxTeamScore}`);
    if (queryGame.maxTime > 0) lines.push(`  -time ${fmt(queryGame.maxTime / 10)}`);
  }
  return lines;
}

function buildBZWText(serverMeta, tree, fetchedAt) {
  const {
    managers, world, groupDefs, links, waterLevel, waterMaterial, weapons, zones, worldSize,
    gameSettings, queryGame,
  } = tree;
  const { dynamicColors, textureMatrices, materials, physicsDrivers, meshTransforms } = managers;

  function ref(list, idx) {
    if (idx == null || idx < 0) return '-1';
    const item = list[idx];
    return item && item.name ? item.name : String(idx);
  }

  function printTransformOps(lines, ops, indent) {
    for (const op of ops) {
      if (op.type === 0) lines.push(`${indent}  shift ${fmt3(op.data)}`);
      else if (op.type === 1) lines.push(`${indent}  scale ${fmt3(op.data)}`);
      else if (op.type === 2) lines.push(`${indent}  shear ${fmt3(op.data)}`);
      else if (op.type === 3) lines.push(`${indent}  spin ${fmt(op.spin * 180 / Math.PI)} ${fmt3(op.data)}`);
      else if (op.type === 4) lines.push(`${indent}  xform ${ref(meshTransforms, op.index)}`);
    }
  }

  function printBoxLike(lines, keyword, o, indent) {
    lines.push(`${indent}${keyword}`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    if (keyword === 'pyramid' && o.flipZ) lines.push(`${indent}  flipz`);
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  drivethrough`);
      if (o.shootThrough) lines.push(`${indent}  shootthrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printBase(lines, o, indent) {
    lines.push(`${indent}base`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    lines.push(`${indent}  color ${o.team}`);
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  drivethrough`);
      if (o.shootThrough) lines.push(`${indent}  shootthrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printTeleporter(lines, o, indent) {
    lines.push(`${indent}teleporter${o.name ? ` ${o.name}` : ''}`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    lines.push(`${indent}  border ${fmt(o.border)}`);
    if (o.horizontal) lines.push(`${indent}  horizontal`);
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printMeshFace(lines, f, indent) {
    lines.push(`${indent}  face`);
    lines.push(`${indent}    vertices ${f.vertexIdx.join(' ')}`);
    if (f.normalIdx) lines.push(`${indent}    normals ${f.normalIdx.join(' ')}`);
    if (f.texcoordIdx) lines.push(`${indent}    texcoords ${f.texcoordIdx.join(' ')}`);
    lines.push(`${indent}    matref ${ref(materials, f.matindex)}`);
    if (f.phydrv >= 0 && physicsDrivers[f.phydrv]) lines.push(`${indent}    phydrv ${ref(physicsDrivers, f.phydrv)}`);
    if (f.noclusters) lines.push(`${indent}    noclusters`);
    if (f.smoothBounce) lines.push(`${indent}    smoothBounce`);
    if (f.driveThrough && f.shootThrough) lines.push(`${indent}    passable`);
    else {
      if (f.driveThrough) lines.push(`${indent}    driveThrough`);
      if (f.shootThrough) lines.push(`${indent}    shootThrough`);
    }
    if (f.ricochet) lines.push(`${indent}    ricochet`);
    lines.push(`${indent}  endface`);
  }

  function printMesh(lines, o, indent) {
    lines.push(`${indent}mesh`);
    for (const c of o.checks) lines.push(`${indent}  ${c.type === 0 ? 'inside' : 'outside'} ${fmt3(c.point)}`);
    for (const v of o.vertices) lines.push(`${indent}  vertex ${fmt3(v)}`);
    for (const n of o.normals) lines.push(`${indent}  normal ${fmt3(n)}`);
    for (const t of o.texcoords) lines.push(`${indent}  texcoord ${fmt(t[0])} ${fmt(t[1])}`);
    if (o.noclusters) lines.push(`${indent}  noclusters`);
    if (o.smoothBounce) lines.push(`${indent}  smoothBounce`);
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  driveThrough`);
      if (o.shootThrough) lines.push(`${indent}  shootThrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    for (const f of o.faces) printMeshFace(lines, f, indent);
    lines.push(`${indent}end`);
  }

  function printCurved(lines, kind, o, indent) {
    lines.push(`${indent}${kind}`);
    lines.push(`${indent}  position ${fmt3(o.pos)}`);
    lines.push(`${indent}  size ${fmt3(o.size)}`);
    lines.push(`${indent}  rotation ${fmt(o.angle * 180 / Math.PI)}`);
    if (o.sweepAngle != null) lines.push(`${indent}  angle ${fmt(o.sweepAngle)}`);
    if (o.ratio != null) lines.push(`${indent}  ratio ${fmt(o.ratio)}`);
    lines.push(`${indent}  divisions ${o.divisions}`);
    if (kind === 'sphere' && o.hemisphere) lines.push(`${indent}  hemisphere`);
    printTransformOps(lines, o.transform.ops, indent);
    lines.push(`${indent}  texsize ${o.texsize.map(fmt).join(' ')}`);
    const sideNames = kind === 'arc' ? ['top', 'bottom', 'inside', 'outside', 'startside', 'endside']
      : kind === 'cone' ? ['edge', 'bottom', 'startside', 'endside'] : ['edge', 'bottom'];
    sideNames.forEach((side, i) => lines.push(`${indent}  ${side} matref ${ref(materials, o.materials[i])}`));
    if (o.phydrv >= 0 && physicsDrivers[o.phydrv]) lines.push(`${indent}  phydrv ${ref(physicsDrivers, o.phydrv)}`);
    if (o.smoothBounce) lines.push(`${indent}  smoothBounce`);
    if (o.driveThrough) lines.push(`${indent}  driveThrough`);
    if (o.shootThrough) lines.push(`${indent}  shootThrough`);
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    if (!o.useNormals) lines.push(`${indent}  flatshading`);
    lines.push(`${indent}end`);
  }

  function printTetra(lines, o, indent) {
    lines.push(`${indent}tetra`);
    printTransformOps(lines, o.transform.ops, indent);
    for (let i = 0; i < 4; i++) {
      lines.push(`${indent}  vertex ${fmt3(o.vertices[i])}`);
      if (o.normals[i]) for (const n of o.normals[i]) lines.push(`${indent}  normal ${fmt3(n)}`);
      if (o.texcoords[i]) for (const t of o.texcoords[i]) lines.push(`${indent}  texcoord ${fmt(t[0])} ${fmt(t[1])}`);
      lines.push(`${indent}  matref ${ref(materials, o.materials[i])}`);
    }
    if (o.driveThrough && o.shootThrough) lines.push(`${indent}  passable`);
    else {
      if (o.driveThrough) lines.push(`${indent}  drivethrough`);
      if (o.shootThrough) lines.push(`${indent}  shootthrough`);
    }
    if (o.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
  }

  function printGroupInstance(lines, inst, indent) {
    lines.push(`${indent}group ${inst.groupdef}`);
    printTransformOps(lines, inst.transform.ops, indent);
    if (inst.modifyTeam) lines.push(`${indent}  team ${inst.team}`);
    if (inst.modifyColor) lines.push(`${indent}  tint ${inst.tint.map(fmt).join(' ')}`);
    if (inst.modifyPhysicsDriver) lines.push(`${indent}  phydrv ${ref(physicsDrivers, inst.phydrv)}`);
    if (inst.modifyMaterial) lines.push(`${indent}  matref ${ref(materials, inst.material)}`);
    if (inst.driveThrough) lines.push(`${indent}  driveThrough`);
    if (inst.shootThrough) lines.push(`${indent}  shootThrough`);
    if (inst.ricochet) lines.push(`${indent}  ricochet`);
    lines.push(`${indent}end`);
    lines.push('');
  }

  function printGroupDefinitionBody(lines, def, indent) {
    for (const kind of OBSTACLE_ORDER) {
      if (kind === 'wall') continue; // the world border, never a mapper-placed obstacle
      for (const o of def.obstacles[kind]) {
        if (kind === 'box') printBoxLike(lines, 'box', o, indent);
        else if (kind === 'pyr') printBoxLike(lines, 'pyramid', o, indent);
        else if (kind === 'base') printBase(lines, o, indent);
        else if (kind === 'tele') printTeleporter(lines, o, indent);
        else if (kind === 'mesh') printMesh(lines, o, indent);
        else if (kind === 'arc' || kind === 'cone' || kind === 'sphere') printCurved(lines, kind, o, indent);
        else if (kind === 'tetra') printTetra(lines, o, indent);
        lines.push('');
      }
    }
    for (const inst of def.groupInstances) printGroupInstance(lines, inst, indent);
  }

  function printDynamicColorBlock(lines, d) {
    lines.push('dynamicColor');
    if (d.name) lines.push(`  name ${d.name}`);
    const names = ['red', 'green', 'blue', 'alpha'];
    d.channels.forEach((p, c) => {
      const label = names[c];
      if (p.min !== 0 || p.max !== 1) lines.push(`  ${label} limits ${fmt(p.min)} ${fmt(p.max)}`);
      if (p.sequence.list.length) lines.push(`  ${label} sequence ${fmt(p.sequence.period)} ${fmt(p.sequence.offset)} ${p.sequence.list.join(' ')}`);
      for (const s of p.sinusoids) lines.push(`  ${label} sinusoid ${fmt(s.period)} ${fmt(s.offset)} ${fmt(s.weight)}`);
      for (const c2 of p.clampUps) lines.push(`  ${label} clampup ${fmt(c2.period)} ${fmt(c2.offset)} ${fmt(c2.width)}`);
      for (const c2 of p.clampDowns) lines.push(`  ${label} clampdown ${fmt(c2.period)} ${fmt(c2.offset)} ${fmt(c2.width)}`);
    });
    lines.push('end');
    lines.push('');
  }

  function printTextureMatrixBlock(lines, t) {
    lines.push('textureMatrix');
    if (t.name) lines.push(`  name ${t.name}`);
    if (t.useStatic) {
      if (t.rotation !== 0) lines.push(`  fixedspin ${fmt(t.rotation)}`);
      if (t.uFixedShift !== 0 || t.vFixedShift !== 0) lines.push(`  fixedshift ${fmt(t.uFixedShift)} ${fmt(t.vFixedShift)}`);
      if (t.uFixedScale !== 1 || t.vFixedScale !== 1) lines.push(`  fixedscale ${fmt(t.uFixedScale)} ${fmt(t.vFixedScale)}`);
      if (t.uFixedCenter !== 0.5 || t.vFixedCenter !== 0.5) lines.push(`  fixedcenter ${fmt(t.uFixedCenter)} ${fmt(t.vFixedCenter)}`);
    }
    if (t.useDynamic) {
      if (t.spinFreq !== 0) lines.push(`  spin ${fmt(t.spinFreq)}`);
      if (t.uShiftFreq !== 0 || t.vShiftFreq !== 0) lines.push(`  shift ${fmt(t.uShiftFreq)} ${fmt(t.vShiftFreq)}`);
      if (t.uScaleFreq !== 0 || t.vScaleFreq !== 0 || t.uScale !== 1 || t.vScale !== 1) {
        lines.push(`  scale ${fmt(t.uScaleFreq)} ${fmt(t.vScaleFreq)} ${fmt(t.uScale)} ${fmt(t.vScale)}`);
      }
      if (t.uCenter !== 0.5 || t.vCenter !== 0.5) lines.push(`  center ${fmt(t.uCenter)} ${fmt(t.vCenter)}`);
    }
    lines.push('end');
    lines.push('');
  }

  function printMaterialBlock(lines, m) {
    lines.push('material');
    if (m.name) lines.push(`  name ${m.name}`);
    if (m.dynamicColor >= 0) lines.push(`  dyncol ${ref(dynamicColors, m.dynamicColor)}`);
    lines.push(`  ambient ${m.ambient.map(fmt).join(' ')}`);
    lines.push(`  diffuse ${m.diffuse.map(fmt).join(' ')}`);
    lines.push(`  specular ${m.specular.map(fmt).join(' ')}`);
    lines.push(`  emission ${m.emission.map(fmt).join(' ')}`);
    lines.push(`  shininess ${fmt(m.shininess)}`);
    lines.push(`  alphathresh ${fmt(m.alphaThreshold)}`);
    if (m.occluder) lines.push('  occluder');
    if (m.groupAlpha) lines.push('  groupAlpha');
    if (m.noRadar) lines.push('  noradar');
    if (m.noShadow) lines.push('  noshadow');
    if (m.noCulling) lines.push('  noculling');
    if (m.noSorting) lines.push('  nosorting');
    if (m.noLighting) lines.push('  nolighting');
    for (const tex of m.textures) {
      lines.push(`  addtexture ${tex.name}`);
      if (tex.matrix !== -1) lines.push(`    texmat ${ref(textureMatrices, tex.matrix)}`);
      if (!tex.useAlpha) lines.push('    notexalpha');
      if (!tex.useColor) lines.push('    notexcolor');
      if (tex.useSphereMap) lines.push('    spheremap');
    }
    for (const sh of m.shaders) lines.push(`  addshader ${sh.name}`);
    lines.push('end');
    lines.push('');
  }

  function printPhysicsDriverBlock(lines, p) {
    lines.push('physics');
    if (p.name) lines.push(`  name ${p.name}`);
    if (p.linear.some((v) => v !== 0)) lines.push(`  linear ${fmt3(p.linear)}`);
    if (p.angularVel !== 0) lines.push(`  angular ${fmt(p.angularVel / (Math.PI * 2))} ${fmt(p.angularPos[0])} ${fmt(p.angularPos[1])}`);
    if (p.radialVel !== 0) lines.push(`  radial ${fmt(p.radialVel)} ${fmt(p.radialPos[0])} ${fmt(p.radialPos[1])}`);
    if (p.slideTime !== 0) lines.push(`  slide ${fmt(p.slideTime)}`);
    if (p.deathMsg) lines.push(`  death ${p.deathMsg}`);
    lines.push('end');
    lines.push('');
  }

  function printMeshTransformBlock(lines, t) {
    lines.push('transform');
    if (t.name) lines.push(`  name ${t.name}`);
    printTransformOps(lines, t.ops, '');
    lines.push('end');
    lines.push('');
  }

  const lines = [];
  lines.push(`# downloaded by bzo (https://github.com/timriker/bzo) from ${serverMeta.host}:${serverMeta.port}${serverMeta.title ? ` -- ${serverMeta.title}` : ''}`);
  lines.push(`# fetched ${fetchedAt}`);
  lines.push('#');
  lines.push('# this is a reconstruction of the world bzfs sent over the wire, not the');
  lines.push('# original .bzw source -- the server never transmits map file text, only the');
  lines.push('# compiled obstacle/material data (same as BZFlag\'s own "Save World" menu item,');
  lines.push('# World::writeWorld), so no comments or authorship from the original map survive.');
  lines.push('');

  if (worldSize != null) {
    lines.push('world');
    lines.push(`  size ${fmt(worldSize / 2)}`);
    lines.push('end');
    lines.push('');
  }

  if (gameSettings) {
    lines.push('options');
    for (const line of buildOptionsLines(gameSettings, queryGame, serverMeta.listInfo)) lines.push(line);
    lines.push('end');
    lines.push('');
  }

  for (const d of dynamicColors) printDynamicColorBlock(lines, d);
  for (const t of textureMatrices) printTextureMatrixBlock(lines, t);
  for (const m of materials) printMaterialBlock(lines, m);
  for (const p of physicsDrivers) printPhysicsDriverBlock(lines, p);
  for (const t of meshTransforms) printMeshTransformBlock(lines, t);

  for (const def of groupDefs) {
    lines.push(`define ${def.name}`);
    printGroupDefinitionBody(lines, def, '  ');
    lines.push('enddef');
    lines.push('');
  }

  printGroupDefinitionBody(lines, world, '');

  for (const link of links) {
    lines.push('link');
    lines.push(`  from ${link.src}`);
    lines.push(`  to   ${link.dst}`);
    lines.push('end');
    lines.push('');
  }

  if (waterLevel >= 0) {
    lines.push('waterLevel');
    lines.push(`  height ${fmt(waterLevel)}`);
    lines.push(`  matref ${ref(materials, waterMaterial)}`);
    lines.push('end');
    lines.push('');
  }

  for (const w of weapons) {
    lines.push('weapon');
    if (w.flagAbbv) lines.push(`  type ${w.flagAbbv}`);
    lines.push(`  position ${fmt3(w.pos)}`);
    lines.push(`  rotation ${fmt(w.dir * 180 / Math.PI)}`);
    lines.push(`  initdelay ${fmt(w.initDelay)}`);
    if (w.delay.length) lines.push(`  delay ${w.delay.map(fmt).join(' ')}`);
    lines.push('end');
    lines.push('');
  }

  for (const z of zones) {
    lines.push('zone');
    lines.push(`  position ${fmt3(z.pos)}`);
    lines.push(`  size ${fmt3(z.size)}`);
    lines.push(`  rotation ${fmt(z.rot * 180 / Math.PI)}`);
    if (z.flags.length) lines.push(`  flag ${z.flags.join(' ')}`);
    if (z.teams.length) lines.push(`  team ${z.teams.join(' ')}`);
    if (z.safety.length) lines.push(`  safety ${z.safety.join(' ')}`);
    lines.push('end');
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  PROTOCOL_VERSION,
  DEFAULT_LIST_SERVER,
  OBSTACLE_ORDER,
  GAME_STYLES,
  GAME_OPTION_BITS,
  decodePingHex,
  fetchServerList,
  fetchWorldFromServer,
  decodeGameSettings,
  decodeQueryGame,
  parseWorldDatabase,
  buildBZWText,
};
