/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */
// bzflag-native.cjs - One native BZFlag client seated in bzo's game (issue
// #174). bzo talks to it as to a browser, in its own JSON; this turns each of
// those messages into what bzfs would have sent, and the client's own
// messages back into bzo's. The proxy (`bzfs-session.cjs` and server.js's
// `proxy*` helpers) runs the same conversions the other way.

'use strict';

const CALLSIGN_LEN = 32;
const MOTTO_LEN = 128;
const TOKEN_LEN = 22;
const VERSION_LEN = 60;
const NO_PLAYER = 255;
const ALL_PLAYERS = 254;
const SERVER_PLAYER = 253;
const ADMIN_PLAYERS = 252;
// The last id a player may have (`LastRealPlayer`, global.h): ids above it
// are team and broadcast addresses.
const LAST_REAL_PLAYER = 243;
// `TankPlayer`, `ComputerPlayer` (global.h).
const TANK_PLAYER = 0;
const COMPUTER_PLAYER = 1;
// `PlayerState` status bits (PlayerState.h:25).
const STATUS_ALIVE = 1 << 0;
const STATUS_FALLING = 1 << 6;
// `BlowedUpReason` (playing.h:128).
const DEATH_REASONS = {
  shot: 1, runOver: 2, captured: 3, genocide: 4, selfDestruct: 5, water: 6,
};

// bzo is Y up, three.js style; bzfs is Z up. The proxy's `proxyPosition`
// inverted.
function toBzfsPosition(x, y, z) {
  return [x, -z, y];
}
// A bzo rotation faces -Z at zero; a bzfs azimuth is counter-clockwise from
// +X (`proxyRotation` inverted).
function toBzfsAzimuth(r) {
  return r + (Math.PI / 2);
}

class Writer {
  constructor(size = 256) {
    this.buf = Buffer.alloc(size);
    this.o = 0;
  }

  ensure(n) {
    if (this.o + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.o + n));
    this.buf.copy(next, 0, 0, this.o);
    this.buf = next;
  }

  u8(v) { this.ensure(1); this.buf.writeUInt8((Number(v) || 0) & 0xff, this.o); this.o += 1; return this; }

  u16(v) { this.ensure(2); this.buf.writeUInt16BE((Number(v) || 0) & 0xffff, this.o); this.o += 2; return this; }

  i16(v) { this.ensure(2); this.buf.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(Number(v) || 0))), this.o); this.o += 2; return this; }

  i32(v) { this.ensure(4); this.buf.writeInt32BE(Math.round(Number(v) || 0) | 0, this.o); this.o += 4; return this; }

  u32(v) { this.ensure(4); this.buf.writeUInt32BE((Number(v) || 0) >>> 0, this.o); this.o += 4; return this; }

  f32(v) { this.ensure(4); this.buf.writeFloatBE(Number.isFinite(Number(v)) ? Number(v) : 0, this.o); this.o += 4; return this; }

  vec3(v) { return this.f32(v[0]).f32(v[1]).f32(v[2]); }

  // A NUL-padded fixed field, one byte short so it always ends in NUL.
  fixed(text, length) {
    this.ensure(length);
    this.buf.fill(0, this.o, this.o + length);
    this.buf.write(String(text ?? ''), this.o, length - 1, 'latin1');
    this.o += length;
    return this;
  }

  // `FlagType::pack`: the abbreviation in two bytes, NUL padded.
  flag(abbv) {
    this.ensure(2);
    this.buf.fill(0, this.o, this.o + 2);
    if (abbv) this.buf.write(String(abbv), this.o, 2, 'latin1');
    this.o += 2;
    return this;
  }

  bytes(b) { this.ensure(b.length); b.copy(this.buf, this.o); this.o += b.length; return this; }

  done() { return this.buf.subarray(0, this.o); }
}

// `PlayerInfo::unpackEnter`: type, team, callsign, motto, token, version.
function decodeEnter(payload) {
  const text = (at, length) => payload.toString('latin1', at, at + length).replace(/\0.*$/s, '');
  if (payload.length < 4 + CALLSIGN_LEN + MOTTO_LEN + TOKEN_LEN + VERSION_LEN) return null;
  let at = 4;
  const callsign = text(at, CALLSIGN_LEN); at += CALLSIGN_LEN;
  const motto = text(at, MOTTO_LEN); at += MOTTO_LEN;
  const token = text(at, TOKEN_LEN); at += TOKEN_LEN;
  const version = text(at, VERSION_LEN);
  return {
    type: payload.readUInt16BE(0), team: payload.readInt16BE(2), callsign, motto, token, version,
  };
}

// MsgMessage from a client: to, then the text (the sender is the
// connection).
function decodeClientMessage(payload) {
  if (payload.length < 1) return null;
  return { to: payload.readUInt8(0), text: payload.toString('latin1', 1).replace(/\0.*$/s, '') };
}

// `options.teamIndex(team)` names a bzo team by upstream's number;
// `options.send(code, payload)` writes a frame; `options.selfSlot` is the id
// the handshake gave this connection; `options.config()` is the live game
// config, for speeds.
class NativeTranslator {
  constructor({ selfSlot, send, teamIndex, config }) {
    this.selfSlot = selfSlot;
    this.write = send;
    this.teamIndex = teamIndex;
    this.config = config;
    this.selfBzoId = null;
    this.players = new Map();
    this.shots = new Map();
    this.shotCounter = 0;
    this.orders = new Map();
    this.accepted = false;
    this.pending = null;
    this.startedAt = Date.now();
  }

  // A bzo player's id as a bzfs one: the same number, since bzo numbers its
  // players in upstream's PlayerId space (server/player-ids.cjs).
  slotFor(bzoId) {
    const id = Number(bzoId);
    return Number.isInteger(id) && id >= 0 && id <= LAST_REAL_PLAYER ? id : NO_PLAYER;
  }

  // An id bzo sent that names no player: the server, or nobody.
  sourceSlot(bzoId) {
    if (bzoId === SERVER_PLAYER || bzoId === String(SERVER_PLAYER)) return SERVER_PLAYER;
    if (bzoId === ALL_PLAYERS || bzoId === String(ALL_PLAYERS)) return ALL_PLAYERS;
    if (bzoId === ADMIN_PLAYERS || bzoId === String(ADMIN_PLAYERS)) return ADMIN_PLAYERS;
    return this.slotFor(bzoId);
  }

  timestamp() {
    return (Date.now() - this.startedAt) / 1000;
  }

  addPlayer(record) {
    const w = new Writer(180)
      .u8(this.slotFor(record.id))
      .u16(record.bot ? COMPUTER_PLAYER : TANK_PLAYER)
      .u16(this.teamIndex(record.team))
      .u16(record.wins)
      .u16(record.losses)
      .u16(record.tks)
      .fixed(record.name, CALLSIGN_LEN)
      .fixed(record.motto, MOTTO_LEN);
    this.write('ap', w.done());
    this.players.set(String(record.id), record);
    this.playerInfo(record);
  }

  // MsgPlayerInfo: what the scoreboard draws as `-`, `+` and `@`
  // (`PlayerAttribute`, Protocol.h:53). bzo learns nothing about a callsign
  // it did not verify, so verified means registered too.
  playerInfo(record) {
    const properties = (record.verified ? 1 | 2 : 0) | (record.admin ? 4 : 0);
    this.write('pb', new Writer(3).u8(1).u8(this.slotFor(record.id)).u8(properties).done());
  }

  removePlayer(bzoId) {
    const key = String(bzoId);
    if (!this.players.has(key)) return;
    this.write('rp', new Writer(1).u8(this.slotFor(key)).done());
    this.players.delete(key);
    this.orders.delete(key);
  }

  // `PlayerState::pack`, the full form, from bzo's own move fields.
  playerUpdate(move) {
    const r = Number(move.r) || 0;
    const config = this.config();
    const alive = this.players.get(String(move.id))?.alive !== false;
    let status = alive ? STATUS_ALIVE : 0;
    if (Number(move.vv)) status |= STATUS_FALLING;
    // `PlayerState::pack` counts every update, and a client drops one that is
    // not newer than the last it took (playing.cxx:3488).
    const key = String(move.id);
    const order = (this.orders.get(key) || 0) + 1;
    this.orders.set(key, order);
    const w = new Writer(48)
      .f32(this.timestamp())
      .u8(this.slotFor(move.id))
      .i32(order)
      .i16(status)
      .vec3(toBzfsPosition(Number(move.x) || 0, Number(move.y) || 0, Number(move.z) || 0))
      .vec3([Number(move.vx) || 0, -(Number(move.vz) || 0), Number(move.vv) || 0])
      .f32(toBzfsAzimuth(r))
      .f32((Number(move.rs) || 0) * (config.TANK_ROTATION_SPEED || 0));
    this.write('pu', w.done());
  }

  score(record) {
    this.write('sc', new Writer(8)
      .u8(1).u8(this.slotFor(record.id)).u16(record.wins).u16(record.losses).u16(record.tks)
      .done());
  }

  alive(record) {
    this.players.set(String(record.id), { ...record, alive: true });
    this.write('al', new Writer(17)
      .u8(this.slotFor(record.id))
      .vec3(toBzfsPosition(record.x, record.y, record.z))
      .f32(toBzfsAzimuth(record.rotation))
      .done());
  }

  // `FlagInfo::pack`: index, then `Flag::pack`.
  flagBody(w, flag) {
    const pos = (p) => (p ? toBzfsPosition(p.x, p.y, p.z) : [0, 0, 0]);
    return w.u16(flag.index)
      .flag(flag.type)
      .u16(flag.status)
      .u16(0)
      .u8(flag.owner === null || flag.owner === undefined ? NO_PLAYER : this.slotFor(flag.owner))
      .vec3(pos(flag.position))
      .vec3(pos(flag.launchPosition))
      .vec3(pos(flag.landingPosition))
      .f32(flag.flightTime)
      .f32(flag.flightEnd)
      .f32(flag.initialVelocity);
  }

  flagUpdate(flags) {
    // A message holds what fits in one packet; bzfs splits the same way.
    for (let start = 0; start < flags.length; start += 16) {
      const chunk = flags.slice(start, start + 16);
      const w = new Writer(2 + (chunk.length * 57)).u16(chunk.length);
      for (const flag of chunk) this.flagBody(w, flag);
      this.write('fu', w.done());
    }
  }

  // bzo's id for a shot, as `(slot, counter << 8 | shotSlot)`.
  shotId(projectileId, shotSlot, shooter) {
    let shot = this.shots.get(projectileId);
    if (shot === undefined) {
      this.shotCounter = (this.shotCounter + 1) & 0xff;
      shot = { id: ((this.shotCounter << 8) | ((Number(shotSlot) || 0) & 0xff)) & 0xffff, shooter };
      this.shots.set(projectileId, shot);
    }
    return shot.id;
  }

  // The burst bzfs sends after MsgEnter (`addPlayer`, bzfs.cxx:2355).
  accept(init, self) {
    this.selfBzoId = String(self.id);
    this.accepted = true;
    this.write('ac', new Writer(1).u8(this.selfSlot).done());
    const vars = Object.entries(init.bzdb || {});
    for (let start = 0; start < vars.length; start += 20) {
      const chunk = vars.slice(start, start + 20);
      const w = new Writer(512).u16(chunk.length);
      for (const [name, value] of chunk) {
        const nameBytes = Buffer.from(String(name), 'latin1').subarray(0, 255);
        const valueBytes = Buffer.from(String(value), 'latin1').subarray(0, 255);
        w.u8(nameBytes.length).bytes(nameBytes).u8(valueBytes.length).bytes(valueBytes);
      }
      this.write('sv', w.done());
    }
    this.flagUpdate(init.flags || []);
    for (const record of init.players || []) {
      if (String(record.id) === this.selfBzoId) continue;
      if (record.joined === false) continue;
      this.addPlayer(record);
      if (record.alive) this.alive(record);
    }
    this.addPlayer(self);
    if (init.rabbitId !== null && init.rabbitId !== undefined) {
      this.write('nR', new Writer(1).u8(this.slotFor(init.rabbitId)).done());
    }
  }

  // One of bzo's own messages to this player, as bzfs would have said it.
  handle(message) {
    switch (message.type) {
      case 'init':
        this.pending = message;
        break;
      case 'playerJoined':
        if (!this.accepted) {
          // Our own join is what bzo answers MsgEnter with.
          if (this.pending && this.isSelf(message.player)) this.accept(this.pending, message.player);
          break;
        }
        if (!this.isSelf(message.player)) this.addPlayer(message.player);
        break;
      case 'playerLeft':
        if (this.accepted) this.removePlayer(message.id);
        break;
      case 'playerUpdated':
        if (this.accepted && message.player) {
          this.score(message.player);
          this.playerInfo(message.player);
        }
        break;
      case 'alive':
        if (this.accepted && message.player) this.alive(message.player);
        break;
      case 'pm':
        if (this.accepted && String(message.id) !== this.selfBzoId) this.playerUpdate(message);
        break;
      case 'pmBatch':
        if (!this.accepted) break;
        for (const move of message.moves || []) {
          if (String(move.id) !== this.selfBzoId) this.playerUpdate(move);
        }
        break;
      case 'killed': {
        if (!this.accepted) break;
        const victim = this.players.get(String(message.victimId));
        if (victim) victim.alive = false;
        this.write('kl', new Writer(10)
          .u8(this.slotFor(message.victimId))
          .u8(message.shooterId === null || message.shooterId === undefined
            ? SERVER_PLAYER : this.slotFor(message.shooterId))
          .i16(DEATH_REASONS[message.reason] ?? DEATH_REASONS.shot)
          .i16(message.projectileId ? this.shots.get(message.projectileId)?.id ?? -1 : -1)
          .flag(message.shooterFlag)
          .done());
        break;
      }
      case 'shotBegin': {
        if (!this.accepted) break;
        const speed = Number(message.speed) || 0;
        const config = this.config();
        // `_reloadTime`, upstream's default being `_shotRange / _shotSpeed`.
        const lifetime = (Number(config.SHOT_LIFETIME) / 1000)
          || ((Number(config.SHOT_RANGE) || 350) / (Number(config.SHOT_SPEED) || 100));
        this.write('sb', new Writer(48)
          .f32(this.timestamp())
          .u8(this.slotFor(message.playerId))
          .u16(this.shotId(message.id, message.shotSlot, this.slotFor(message.playerId)))
          .vec3(toBzfsPosition(message.x, message.y, message.z))
          .vec3(toBzfsPosition(message.dirX * speed, message.dirY * speed, message.dirZ * speed))
          .f32(0)
          .i16(this.teamIndex(message.team))
          .flag(message.flag)
          .f32(lifetime)
          .done());
        break;
      }
      case 'shotEnd': {
        if (!this.accepted) break;
        const shot = this.shots.get(message.id);
        if (shot === undefined) break;
        this.write('se', new Writer(5).u8(shot.shooter).u16(shot.id).u16(message.reason).done());
        this.shots.delete(message.id);
        break;
      }
      case 'message': {
        if (!this.accepted) break;
        const text = String(message.text ?? '');
        const w = new Writer(text.length + 4)
          .u8(this.sourceSlot(message.src))
          .u8(this.sourceSlot(message.dst))
          .u8(message.msgType === 'action' ? 1 : 0);
        w.bytes(Buffer.from(`${text.slice(0, 120)}\0`, 'latin1'));
        this.write('mg', w.done());
        break;
      }
      case 'flagUpdate':
        if (this.accepted) this.flagUpdate(message.flags || []);
        break;
      case 'grabFlag':
      case 'dropFlag': {
        if (!this.accepted || !message.flag) break;
        const w = new Writer(60).u8(this.slotFor(message.playerId));
        this.flagBody(w, message.flag);
        this.write(message.type === 'grabFlag' ? 'gf' : 'df', w.done());
        break;
      }
      case 'transferFlag': {
        if (!this.accepted || !message.flag) break;
        const w = new Writer(60).u8(this.slotFor(message.fromId)).u8(this.slotFor(message.toId));
        this.flagBody(w, message.flag);
        this.write('tf', w.done());
        break;
      }
      case 'captureFlag':
        if (this.accepted) {
          this.write('cf', new Writer(5)
            .u8(this.slotFor(message.playerId)).u16(message.index).u16(message.team).done());
        }
        break;
      case 'newRabbit':
        if (this.accepted) this.write('nR', new Writer(1).u8(this.slotFor(message.playerId)).done());
        break;
      case 'teleport':
        if (this.accepted) {
          this.write('tp', new Writer(5).u8(this.slotFor(message.playerId)).u16(0).u16(0).done());
        }
        break;
      case 'timeUpdate':
        if (this.accepted && message.timeLeft !== null && message.timeLeft !== undefined) {
          this.write('to', new Writer(4).i32(message.timeLeft).done());
        }
        break;
      case 'setVar':
        if (this.accepted) {
          const nameBytes = Buffer.from(String(message.name), 'latin1').subarray(0, 255);
          const valueBytes = Buffer.from(String(message.value ?? ''), 'latin1').subarray(0, 255);
          this.write('sv', new Writer(4 + nameBytes.length + valueBytes.length)
            .u16(1).u8(nameBytes.length).bytes(nameBytes).u8(valueBytes.length).bytes(valueBytes).done());
        }
        break;
      default:
        break;
    }
  }

  // `init` names this connection's own bzo player before it has joined.
  isSelf(record) {
    return Boolean(record && this.pending?.player && String(record.id) === String(this.pending.player.id));
  }
}

module.exports = {
  NativeTranslator,
  decodeEnter,
  decodeClientMessage,
  toBzfsPosition,
  toBzfsAzimuth,
  ALL_PLAYERS,
  SERVER_PLAYER,
};
