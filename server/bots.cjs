/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Bots this server runs itself (docs/bots-plan.md, step 2): upstream's
// `bz_ServerSidePlayerHandler` with one of `public/autopilot.mjs`'s pilots as
// its brain. A bot is a client in every way the server can see -- it joins,
// moves and shoots through the same messages a browser sends, on a socket that
// never leaves the process -- so validation, broadcast, scoring and the list
// treat it as any other player. What lives here is only what a browser does
// for itself: drive the tank and say so.

const { resolveTankMotion } = require('./motion.cjs');
const {
  findTankObstacle,
  getTankHitNormal,
  isPyramidFlatTop,
  TANK_HALF_WIDTH,
  TANK_HALF_LENGTH,
} = require('./collision.cjs');
const { getAccelerationLimits, applyAccelerationLimit } = require('./flags.cjs');

// The fill rule: bots make up the playing roster to `fill`, and there are none
// once the people do. Returns how many to add (positive) or take away
// (negative).
function planBotFill({ fill, humans, bots }) {
  const wanted = Math.max(0, Math.floor(fill || 0) - humans);
  return wanted - bots;
}

// The team a bot leaves when the roster has one too many: the biggest, so a
// person joining a team leaves the game as even as it was.
function pickBotToRemove(bots, teamSizes) {
  let best = null;
  for (const bot of bots) {
    const size = teamSizes.get(bot.team) || 0;
    if (!best || size > best.size) best = { bot, size };
  }
  return best ? best.bot : null;
}

// The client's own numbers, from public/client.js: the occupant height its
// collision test uses, and the muzzle a tank model reports.
const TANK_COLLISION_HEIGHT = 2;
const MUZZLE_FORWARD = 3.0;
const MUZZLE_HEIGHT = 1.57;
// How often a bot reports a move with nothing new in it, as a client's own
// heartbeat does.
const HEARTBEAT_SECONDS = 1;
// The smallest change in a reported speed worth a packet, as a client's
// VELOCITY_THRESHOLD.
const VELOCITY_THRESHOLD = 0.01;

const round = (value, places) => Number(value.toFixed(places));

// One bot's tank. `env` is the server it lives in:
//   config()        GAME_CONFIG
//   colliders()     every solid a tank meets, world walls included
//   topOf(obs)      an obstacle's top
//   state()         { alive, x, y, z, rotation } off the server's player
//   view(self)      the pilot's view, given the bot's own idea of itself
//   send(message)   a message as though the bot's client had sent it
//   act(self)       the per-frame checks a client makes: grab, capture
class BotDriver {
  constructor({ pilot, env }) {
    this.pilot = pilot;
    this.env = env;
    this.alive = false;
    this.clock = 0;
    this.lastSentAt = -Infinity;
    this.lastSent = null;
    this.stuckFrameCount = 0;
    this.lastDropAt = -Infinity;
  }

  // Where the server put the tank, which is where every life starts.
  respawn(state) {
    this.x = state.x;
    this.y = state.y;
    this.z = state.z;
    this.r = state.rotation;
    this.vy = 0;
    this.angVel = 0;
    this.speed = 0;
    this.jumpDirection = null;
    this.airVX = 0;
    this.airVZ = 0;
    this.onGround = this.y <= 0;
    this.onObstacle = !this.onGround;
    this.stuckFrameCount = 0;
    this.lastSent = null;
  }

  self() {
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      rotation: this.r,
      inAir: this.jumpDirection !== null,
      muzzleForward: MUZZLE_FORWARD,
      muzzleHeight: MUZZLE_HEIGHT,
    };
  }

  // One frame. Mirrors `handleInputEvents` and `handleMotion` in client.js for
  // a tank carrying nothing that changes how it drives.
  tick(dt) {
    this.clock += dt;
    const state = this.env.state();
    if (!state.alive) {
      this.alive = false;
      return;
    }
    if (!this.alive) {
      this.alive = true;
      this.respawn(state);
    }
    const config = this.env.config();
    const out = this.pilot.think(this.env.view(this.self()));
    this.lastOut = out;

    if (out.dropFlag && this.clock - this.lastDropAt > 1) {
      this.lastDropAt = this.clock;
      this.env.send({ type: 'dropFlag' });
    }

    const forward = Math.max(-0.5, Math.min(1, out.speed || 0));
    const turn = Math.max(-1, Math.min(1, out.rotation || 0));
    const speed = config.TANK_SPEED;
    const angSpeed = config.TANK_ROTATION_SPEED;
    const airborne = this.jumpDirection !== null;
    let force = false;

    let vx;
    let vz;
    if (airborne) {
      // "can't control motion in air" (LocalPlayer.cxx:341): the velocity and
      // the turn rate are the ones it left with, so a tank that jumps turning
      // lands facing somewhere else.
      vx = this.airVX;
      vz = this.airVZ;
    } else {
      // doMomentum, the same model the client drives by: no limit at all by
      // default, a world's `-a` or `M` Momentum otherwise.
      const limits = getAccelerationLimits(null, config.LINEAR_ACCELERATION, config.ANGULAR_ACCELERATION);
      this.speed = applyAccelerationLimit(this.speed, forward * speed, limits.linear, dt);
      this.angVel = applyAccelerationLimit(this.angVel, turn * angSpeed, limits.angular, dt);
      vx = -Math.sin(this.r) * this.speed;
      vz = -Math.cos(this.r) * this.speed;
    }

    if (!airborne && this.onGround) {
      this.vy = 0;
      this.y = 0;
    }
    if (airborne || this.onObstacle) this.vy -= config.GRAVITY * dt;
    if (out.jump && !airborne && config.ALLOW_JUMPING) {
      this.vy = config.JUMP_VELOCITY;
      this.jumpDirection = this.r;
      this.airVX = vx;
      this.airVZ = vz;
      force = true;
    }

    const step = this.resolve(vx, this.vy, vz, this.angVel, dt, config);
    const oldX = this.x;
    const oldZ = this.z;
    const oldR = this.r;
    this.stuckFrameCount = step.stuckFrameCount;
    this.x = step.x;
    this.y = step.y;
    this.z = step.z;
    this.r = step.azimuth;
    this.vy = step.velocityY;

    this.onObstacle = step.onBuilding;
    this.onGround = !this.onObstacle && this.y <= 0;
    const inAir = !this.onObstacle && !this.onGround;
    if (this.jumpDirection !== null && !inAir) {
      this.jumpDirection = null;
      this.airVX = 0;
      this.airVZ = 0;
      this.vy = 0;
      force = true;
    } else if (this.jumpDirection === null && inAir) {
      // Drove off an edge: the fall keeps the speed the tank left with.
      this.jumpDirection = this.r;
      this.airVX = vx;
      this.airVZ = vz;
      force = true;
    }

    // `fs` and `rs` are what the tank did, not what it was asked: client.js
    // measures them off the resolved step.
    let fs;
    // In the air the turn carries on, so it is the turn rate the tank left
    // with, as the client reports it.
    const rs = dt > 0 ? (this.r - oldR) / dt / angSpeed : 0;
    if (this.jumpDirection === null) {
      const dx = this.x - oldX;
      const dz = this.z - oldZ;
      const along = (dx * -Math.sin(this.r)) + (dz * -Math.cos(this.r));
      fs = dt > 0 ? along / dt / speed : 0;
    } else {
      fs = Math.hypot(this.airVX, this.airVZ) / speed;
    }
    this.report(fs, rs, dt, force || out.fire);

    this.env.act(this.self());
    if (out.fire) this.fire();
  }

  resolve(velocityX, velocityY, velocityZ, angularVelocity, dt, config) {
    return resolveTankMotion({
      x: this.x,
      y: this.y,
      z: this.z,
      azimuth: this.r,
      velocityX,
      velocityY,
      velocityZ,
      angularVelocity,
      timeStep: dt,
      groundLimit: 0,
      onGround: this.onGround || this.onObstacle,
      hitTest: (fromX, fromY, fromZ, fromAz, toX, toY, toZ, toAz) => findTankObstacle(
        this.env.colliders(), toX, toY, toZ, {
          rotation: toAz, fromY, fromX, fromZ, radius: TANK_COLLISION_HEIGHT,
        }),
      getNormal: (obs, px, py, pz, paz, hitX, hitY, hitZ, hitAz, fromX, fromZ, fromAz, toX, toZ, toAz) => (
        getTankHitNormal(obs, px, py, pz, paz, hitY, TANK_COLLISION_HEIGHT, {
          fromX, fromZ, fromAz, toX, toZ, toAz, hitX, hitZ,
          halfWidth: TANK_HALF_WIDTH,
          halfLength: TANK_HALF_LENGTH,
        })),
      isFlatTop: (obs) => {
        if (!obs || obs.collisionKind === 'boundary') return false;
        if (obs.type === 'pyramid') return isPyramidFlatTop(obs);
        return true;
      },
      getObstacleTop: (obs) => this.env.topOf(obs),
      maxBumpHeight: config.MAX_BUMP_HEIGHT,
      stuckFrameCount: this.stuckFrameCount,
    });
  }

  // A move packet, sent as a client sends one: when a speed changed, on a jump
  // or a landing, before a shot, and otherwise as a heartbeat.
  report(fs, rs, dt, force) {
    const packet = {
      type: 'm',
      x: round(this.x, 2),
      y: round(this.y, 2),
      z: round(this.z, 2),
      r: round(this.r, 2),
      fs: round(fs, 3),
      rs: round(rs, 3),
      vv: round(this.jumpDirection === null ? 0 : this.vy, 2),
      vx: round(this.jumpDirection === null ? 0 : this.airVX, 2),
      vz: round(this.jumpDirection === null ? 0 : this.airVZ, 2),
      dt: round(dt, 3),
      sdt: round(Math.min(this.clock - this.lastSentAt, 60), 3),
      ct: round(this.clock, 3),
      air: this.jumpDirection === null ? 0 : 1,
    };
    const last = this.lastSent;
    const changed = !last
      || Math.abs(packet.fs - last.fs) > VELOCITY_THRESHOLD
      || Math.abs(packet.rs - last.rs) > VELOCITY_THRESHOLD;
    if (!force && !changed && this.clock - this.lastSentAt < HEARTBEAT_SECONDS) return;
    this.lastSent = packet;
    this.lastSentAt = this.clock;
    this.env.send(packet);
  }

  // A stop, for a bot about to be left idle: whatever the server last heard is
  // what it keeps extrapolating, so the last thing it hears is standing still.
  halt() {
    if (!this.alive || this.jumpDirection !== null) return;
    this.report(0, 0, 0, true);
  }

  fire() {
    const dirX = -Math.sin(this.r);
    const dirZ = -Math.cos(this.r);
    this.env.send({
      type: 'shoot',
      x: this.x + (dirX * MUZZLE_FORWARD),
      y: this.y + MUZZLE_HEIGHT,
      z: this.z + (dirZ * MUZZLE_FORWARD),
      dirX,
      dirY: 0,
      dirZ,
    });
  }
}

module.exports = {
  planBotFill,
  pickBotToRemove,
  BotDriver,
};
