/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// The autopilots. `Roger` is upstream's own (`src/bzflag/AutoPilot.cxx`) and
// stays that: each frame it decides a turn, a speed, a jump and a trigger,
// which the caller feeds through exactly the path a stick would. `Ace` is
// Roger with bzo's improvements, and is where new behaviour goes -- Roger is
// the reference it is measured against. Nothing here reads the client:
// everything arrives through a *view* (see `docs/bots-plan.md`), so a
// server-launched bot can drive the same decisions from its own world.
//
// The logic runs in upstream's frame -- (x, y) on the ground, z up, azimuth
// counter-clockwise from +x -- so it reads line for line against
// AutoPilot.cxx. The view speaks bzo's frame, and `toBzf`/`toBzoHeading` are
// the only crossings: bzf(x, y, z) = (x, -z, y), and an azimuth is a heading
// plus a quarter turn. A positive rotation turns left in both.

import { isBadFlag } from './flags.mjs';
import { SHOT_COLLISION_RADIUS, TANK_HIT_RADIUS, traceShotStep } from './collision.mjs';
import { buildNavGraph, NAV_CELL, planJump } from './nav.mjs';

const HALF_PI = Math.PI / 2;

function normalizeAngle(angle) {
  if (angle < -Math.PI) angle += 2 * Math.PI;
  if (angle > Math.PI) angle -= 2 * Math.PI;
  return angle;
}

function toBzf(p) {
  return { x: p.x, y: -p.z, z: p.y };
}

function toBzoHeading(azimuth) {
  return azimuth - HALF_PI;
}

function distance2D(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function azimuthTo(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// TargetingUtils::getTargetAngleDifference: the angle between a heading and the
// line to a target, in radians.
function angleDifference(src, azimuth, target) {
  const d = distance2D(src, target);
  if (d === 0) return 0;
  const tx = (target.x - src.x) / d;
  const ty = (target.y - src.y) / d;
  const dot = (tx * Math.cos(azimuth)) + (ty * Math.sin(azimuth));
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

// "toss in some lag adjustment/future prediction - 300 millis".
function predict(p) {
  const z = p.z + (0.3 * p.vz);
  return {
    x: p.x + (0.3 * p.vx),
    y: p.y + (0.3 * p.vy),
    z: z < 0 ? 0 : z,
  };
}

// dropHardFlags: flags Roger cannot use.
const HARD_FLAGS = new Set(['US', 'MG', 'ID']);

function createStats() {
  return {
    modes: {}, shots: 0, jumps: 0, falls: 0, plans: 0, unreachable: 0, unsticks: 0, held: 0,
  };
}

// A point in upstream's frame, back in bzo's, for the intent.
function toBzo(p) {
  return { x: p.x, y: p.z, z: -p.y };
}

export class Roger {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    // teachAutoPilot's table: per flag, kills minus deaths and how many.
    this.flagSuccess = new Map();
    this.totalSum = 0;
    this.totalCnt = 0;
    this.lastStuckTime = -Infinity;
    this.stuckRot = 0;
    this.stuckSpeed = 0;
    this.lastNavChange = -Infinity;
    this.navRot = 0;
    this.navSpeed = 0;
    this.lastShot = -Infinity;
    this.stats = createStats();
    this.wasInAir = false;
    this.jumpedLast = false;
  }

  // teachAutoPilot: +1 for a kill made with a flag, -1 for dying holding it.
  teach(flagType, adjust) {
    if (!flagType) return;
    const entry = this.flagSuccess.get(flagType);
    if (entry) {
      entry.sum += adjust;
      entry.count++;
    } else {
      this.flagSuccess.set(flagType, { sum: adjust, count: 1 });
    }
    this.totalSum += adjust;
    this.totalCnt++;
  }

  isFlagUseful(flagType) {
    if (!flagType) return false;
    const entry = this.flagSuccess.get(flagType);
    if (!entry) return true;
    const value = entry.count === 0 ? 0 : entry.sum / entry.count;
    const avg = this.totalCnt === 0 ? 0 : this.totalSum / this.totalCnt;
    return value >= avg;
  }

  // Whether a flag on the ground is worth driving to. Roger drives to any of
  // them.
  wantsGroundFlag() {
    return true;
  }

  // Whether a tank carrying its own team's flag is home, so drops it. Upstream
  // compares the base's x with the tank's, truncated, so the test passes over
  // half the map; that is Roger's, and kept.
  isHome(pos, base) {
    const basePos = toBzf(base);
    return Math.trunc(basePos.x) + 2 >= Math.trunc(pos.x)
      || (basePos.x === pos.x && basePos.y === pos.y);
  }

  // avoidDeathFall's branch for a look-ahead that met nothing. Upstream's reads
  // a collision point the ray never set, so Roger does nothing here.
  edgeAhead() {}

  // doAutoPilot. Returns `{ rotation, speed, jump, fire, dropFlag, targetId,
  // shotTargetId }`, rotation and speed as fractions of the tank's maximum:
  // `targetId` is who is being chased, `shotTargetId` who a shot was fired at.
  think(view) {
    const ctx = {
      view,
      me: { ...view.self, ...toBzf(view.self), azimuth: view.self.rotation + HALF_PI },
      out: {
        rotation: 0, speed: 0, jump: false, fire: false, dropFlag: false, targetId: null, shotTargetId: null,
        // What the pilot is doing and why, for whoever wants to show it: a
        // client draws it, a server bot reports it, and nothing reads it to
        // decide anything. Points are in bzo's frame.
        intent: {
          mode: null, target: null, route: null, shot: null, landing: null,
        },
      },
    };
    const { intent } = ctx.out;
    this.dropHardFlags(ctx);
    if (this.avoidBullet(ctx)) intent.mode = 'dodge';
    else if (this.stuckOnWall(ctx)) intent.mode = 'unstick';
    else if (this.chasePlayer(ctx)) intent.mode = intent.mode || 'chase';
    else if (this.lookForFlag(ctx)) intent.mode = intent.mode || 'flag';
    else {
      this.navigate(ctx);
      intent.mode = intent.mode || 'wander';
    }
    this.avoidDeathFall(ctx);
    this.fireAtTank(ctx);
    if (ctx.out.fire && !intent.shot) intent.shot = this.muzzleRay(ctx);
    this.count(ctx);
    return ctx.out;
  }

  // Where a shot fired now leaves from and goes, in bzo's frame.
  muzzleRay(ctx) {
    const self = ctx.view.self;
    const dirX = -Math.sin(self.rotation);
    const dirZ = -Math.cos(self.rotation);
    return {
      from: {
        x: self.x + (dirX * (self.muzzleForward ?? 3)),
        y: self.y + (self.muzzleHeight ?? 1.57),
        z: self.z + (dirZ * (self.muzzleForward ?? 3)),
      },
      dir: { x: dirX, y: 0, z: dirZ },
      segments: null,
    };
  }

  // The counts a report is made of: what the pilot did since the last one.
  count(ctx) {
    const { me, out } = ctx;
    const stats = this.stats;
    stats.modes[out.intent.mode] = (stats.modes[out.intent.mode] || 0) + 1;
    if (out.fire) stats.shots++;
    if (out.jump && !me.inAir) stats.jumps++;
    if (me.inAir && !this.wasInAir && !this.jumpedLast) stats.falls++;
    this.wasInAir = me.inAir;
    this.jumpedLast = out.jump && !me.inAir;
  }

  // What the pilot has been up to since the last report, and a fresh start:
  // the share of frames in each mode, and the counts.
  takeReport() {
    const { stats } = this;
    const frames = Object.values(stats.modes).reduce((sum, n) => sum + n, 0) || 1;
    const modes = Object.entries(stats.modes)
      .sort((a, b) => b[1] - a[1])
      .map(([mode, n]) => `${mode} ${Math.round((100 * n) / frames)}%`)
      .join(', ');
    const report = `${modes || 'idle'}; shots ${stats.shots}, jumps ${stats.jumps}, falls ${stats.falls}`
      + (this.extraReport ? this.extraReport(stats) : '');
    this.stats = createStats();
    return report;
  }

  remotePlayers(view) {
    return view.players.map((p) => ({ ...p, ...toBzf(p), vx: p.vx, vy: -p.vz, vz: p.vy }));
  }

  // The view's ray, asked in upstream's frame.
  openDistance(ctx, pos, azimuth) {
    return ctx.view.openDistance(
      { x: pos.x, y: pos.z, z: -pos.y }, toBzoHeading(azimuth));
  }

  isObscured(ctx, from, to) {
    return ctx.view.isObscured(
      { x: from.x, y: from.z, z: -from.y }, { x: to.x, y: to.z, z: -to.y });
  }

  dropHardFlags(ctx) {
    const { me, out } = ctx;
    if (HARD_FLAGS.has(me.flag) || (me.flag === 'PZ' && !me.zoned)) out.dropFlag = true;
  }

  findWorstBullet(ctx) {
    const { view, me } = ctx;
    let minDistance = Infinity;
    let worst = null;
    for (const shot of view.shots) {
      if (shot.ownerId === me.id) continue;
      if (shot.flag === 'IB' && me.flag !== 'SE') continue;
      if (shot.ownerZoned && !me.zoned) continue;
      if (shot.flag === 'L' && me.flag === 'CL') continue;
      const pos = toBzf(shot);
      if (Math.abs(pos.z - me.z) > view.world.tankHeight && shot.flag !== 'GM') continue;
      const dist = distance2D(me, pos);
      if (dist >= minDistance || dist === 0) continue;
      const shotAngle = Math.atan2(-shot.vz, shot.vx);
      const dot = (((me.x - pos.x) / dist) * Math.cos(shotAngle))
        + (((me.y - pos.y) / dist) * Math.sin(shotAngle));
      // "pretty wide angle, evasive actions prolly aren't gonna work"
      if (dot <= 0.1) continue;
      minDistance = dist;
      worst = { pos, shotAngle, dot };
    }
    return worst ? { ...worst, distance: minDistance } : null;
  }

  avoidBullet(ctx) {
    const { view, me, out } = ctx;
    if (me.flag === 'N' || me.flag === 'BU') return false; // take our chances
    const shot = this.findWorstBullet(ctx);
    if (!shot || shot.distance > 100) return false;
    const { shotAngle, dot } = shot;
    const canJump = (view.world.allowJumping || me.flag === 'JP' || me.flag === 'WG')
      && me.flag !== 'NJ';
    if (canJump && shot.distance < Math.max(dot, 0.5) * view.world.tankLength * 2.25) {
      out.jump = true;
      return me.flag !== 'WG';
    }
    if (dot <= 0.96) return false;
    const trueX = (me.x - shot.pos.x) / shot.distance;
    const trueY = (me.y - shot.pos.y) / shot.distance;
    const rotation1 = normalizeAngle((shotAngle + HALF_PI) - me.azimuth);
    const rotation2 = normalizeAngle((shotAngle - HALF_PI) - me.azimuth);
    const zCross = (Math.cos(shotAngle) * trueY) - (Math.sin(shotAngle) * trueX);
    const [near, far] = zCross > 0 ? [rotation1, rotation2] : [rotation2, rotation1];
    out.rotation = near;
    if (Math.abs(near) < Math.abs(far)) out.speed = 1;
    else if (dot > 0.98) out.speed = -0.5;
    else out.speed = 0.5;
    return true;
  }

  stuckOnWall(ctx) {
    const { view, me, out } = ctx;
    const stuckPeriod = view.now - this.lastStuckTime;
    if (stuckPeriod < 0.5) {
      out.rotation = this.stuckRot;
      out.speed = this.stuckSpeed;
      return true;
    }
    if (stuckPeriod < 1.0) {
      out.rotation = this.stuckRot;
      out.speed = 1;
      return true;
    }
    const phased = me.flag === 'OO' || me.zoned;
    if (phased || this.openDistance(ctx, me, me.azimuth) >= 5) return false;
    this.lastStuckTime = view.now;
    if (this.random() > 0.8) {
      // "Every once in a while, do something nuts"
      out.speed = (this.random() * 1.5) - 0.5;
      out.rotation = (this.random() * 2) - 1;
    } else {
      const left = this.openDistance(ctx, me, me.azimuth + (Math.PI / 4));
      const right = this.openDistance(ctx, me, me.azimuth - (Math.PI / 4));
      out.rotation = left > right ? 1 : -1;
      out.speed = -0.5;
    }
    this.stuckRot = out.rotation;
    this.stuckSpeed = out.speed;
    return true;
  }

  findBestTarget(ctx, players) {
    const { view, me } = ctx;
    let target = null;
    let best = Infinity;
    for (const p of players) {
      if (!p.alive || p.paused || p.notResponding || !view.isFoe(p)) continue;
      if (p.zoned && !me.zoned && me.flag !== 'SW' && me.flag !== 'SB') continue;
      if (p.flag === 'CL' && me.flag === 'L') continue;
      // "chase the proposed opponent if they have our flag"
      if (view.world.teamFlags && p.flagTeam !== null && p.flagTeam === me.teamColor) {
        return p;
      }
      let d = distance2D(me, p);
      const obscured = this.isObscured(ctx, me, p);
      if (obscured) d *= 1.25; // demote the priority of obscured enemies
      if (d >= best) continue;
      // Upstream compares a radian angle against 30 here, so a stealthed tank
      // is chased whenever it is in plain sight; that is kept.
      if (p.flag !== 'ST' || me.flag === 'SE' || !obscured) {
        target = p;
        best = d;
      }
    }
    return target;
  }

  chasePlayer(ctx) {
    const { view, me, out } = ctx;
    const target = this.findBestTarget(ctx, this.remotePlayers(view));
    if (!target) return false;
    out.targetId = target.id;
    out.intent.target = { ...toBzo(target), id: target.id };
    const distance = distance2D(me, target);
    if (distance > 250) return false;

    const enemyAzimuth = azimuthTo(me, target);
    out.rotation = normalizeAngle(enemyAzimuth - me.azimuth);

    // "If we are driving relatively towards our target and a building pops up
    // jump over it"
    if (Math.abs(out.rotation) < view.world.lockOnAngle) {
      const d = distance - 5; // "Make sure building is REALLY in front of player"
      const building = view.firstBuilding(
        { x: me.x, y: me.z, z: -me.y }, toBzoHeading(me.azimuth), d);
      if (building && !me.zoned && me.flag !== 'OO') {
        // "If roger can drive around it, just do that"
        if (this.openDistance(ctx, me, me.azimuth + (Math.PI / 6)) > 2 * d) {
          out.speed = 0.5;
          out.rotation = -0.5;
          return true;
        }
        if (this.openDistance(ctx, me, me.azimuth - (Math.PI / 6)) > 2 * d) {
          out.speed = 0.5;
          out.rotation = 0.5;
          return true;
        }
        // "assuming 20-50 is a good range"
        if (d > 20 && d < 50 && building.isBox) {
          const jumpVel = view.world.jumpVelocity;
          const maxJump = (jumpVel * jumpVel) / (2 * view.world.gravity);
          if (building.top - me.z < maxJump) {
            out.speed = d / 50;
            out.jump = true;
            return true;
          }
        }
      }
    }

    // weave towards the player
    if (distance > view.world.shotSpeed / 2 || !me.canFire) {
      const dot = (Math.cos(me.azimuth) * Math.cos(enemyAzimuth))
        + (Math.sin(me.azimuth) * Math.sin(enemyAzimuth));
      if (dot < 0.866) {
        // "if target is more than 30 degrees away, turn as fast as you can"
        out.rotation *= Math.PI / (2 * Math.abs(out.rotation));
        out.speed = dot;
      } else {
        const period = Math.floor(view.now);
        const absBias = (Math.PI / 20) * (distance / 100);
        out.rotation = normalizeAngle(out.rotation + ((period % 4) < 2 ? absBias : -absBias));
        out.speed = 1;
      }
    } else if (target.flag !== 'BU') {
      out.speed = -0.5;
      if (out.rotation !== 0) out.rotation *= Math.PI / (2 * Math.abs(out.rotation));
    }
    return true;
  }

  lookForFlag(ctx) {
    const { view, me, out } = ctx;
    const pos = { x: me.x, y: me.y, z: Math.max(0, me.z) };
    if (me.flag && this.isFlagUseful(me.flag)) return false;

    let closest = null;
    let minDist = Infinity;
    let teamFlag = null;
    for (const flag of view.flags) {
      if (!flag.onGround) continue;
      if (flag.team !== null) teamFlag = flag;
      else if (!this.wantsGroundFlag(flag)) continue;
      const fpos = toBzf(flag);
      // Upstream's `fpos[2] == pos[2]`: only a flag at the tank's own level.
      if (Math.abs(fpos.z - pos.z) > 0.01) continue;
      let dist = distance2D(pos, fpos);
      if (this.isObscured(ctx, pos, fpos)) dist *= 1.25;
      if (dist < 200 && dist < minDist) {
        minDist = dist;
        closest = flag;
      }
    }
    if (teamFlag && (minDist < 10 || !closest)) closest = teamFlag;
    if (!closest) return false;
    if (minDist < 10 && me.flag) out.dropFlag = true;
    out.intent.target = { x: closest.x, y: closest.y, z: closest.z, flag: closest.type ?? null };
    const flagAzimuth = azimuthTo(pos, toBzf(closest));
    out.rotation = normalizeAngle(flagAzimuth - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    return true;
  }

  navigate(ctx) {
    const { view, me, out } = ctx;
    if (view.now - this.lastNavChange < 1) {
      out.rotation = this.navRot;
      out.speed = this.navSpeed;
      return true;
    }
    const pos = { x: me.x, y: me.y, z: me.z < 0 ? 0.01 : me.z };
    const left = this.openDistance(ctx, pos, me.azimuth + (Math.PI / 4));
    const center = this.openDistance(ctx, pos, me.azimuth);
    const right = this.openDistance(ctx, pos, me.azimuth - (Math.PI / 4));
    if (left > right) out.rotation = left > center ? 0.75 : 0;
    else out.rotation = right > center ? -0.75 : 0;

    if (me.flagTeam !== null) {
      const base = view.myBase();
      out.intent.mode = 'home';
      if (base) out.intent.target = { x: base.x, y: base.y, z: base.z };
      if (!base) {
        out.dropFlag = true;
      } else if (me.flagTeam === me.teamColor && this.isHome(pos, base)) {
        out.dropFlag = true;
      } else {
        out.rotation = normalizeAngle(azimuthTo(pos, toBzf(base)) - me.azimuth);
        out.speed = HALF_PI - Math.abs(out.rotation);
      }
    } else {
      out.speed = 1;
    }
    if (me.inAir && me.flag === 'WG') out.jump = true;

    this.navRot = out.rotation;
    this.navSpeed = out.speed;
    this.lastNavChange = view.now;
    return true;
  }

  // avoidDeathFall: look ahead and below, and stop short of water.
  avoidDeathFall(ctx) {
    const { view, me, out } = ctx;
    const waterLevel = view.world.waterLevel;
    let azimuth = me.azimuth;
    if (out.speed < 0) azimuth += Math.PI;
    const reach = 8 * view.world.tankHeight;
    const from = { x: me.x, y: me.z + (10 * view.world.tankHeight), z: -me.y };
    const to = {
      x: me.x + (reach * Math.cos(azimuth)),
      y: me.z + 0.01,
      z: -(me.y + (reach * Math.sin(azimuth))),
    };
    const hit = view.firstHit(from, to);
    if (hit) {
      const groundY = Math.max(0, hit.y);
      if (Number.isFinite(waterLevel) && groundY < waterLevel) out.speed = 0;
    } else {
      this.edgeAhead(ctx);
    }
  }

  fireAtTank(ctx) {
    const { view, me, out } = ctx;
    if (view.now - this.lastShot < 1 / view.world.maxShots) return;
    const pos = { x: me.x, y: me.y, z: me.z < 0 ? 0.01 : me.z };
    const players = this.remotePlayers(view)
      .filter((p) => p.alive && !p.paused && !p.notResponding);

    if (me.flag === 'SW') {
      let hasTarget = false;
      for (const p of players) {
        if (distance2D(pos, predict(p)) > view.world.shockOutRadius) continue;
        if (!view.isFoe(p)) {
          hasTarget = false;
          break;
        }
        hasTarget = true;
      }
      if (hasTarget) {
        out.fire = true;
        this.lastShot = view.now;
      }
      return;
    }

    const errorLimit = (view.world.maxShots * view.world.lockOnAngle) / 8;
    const closeErrorLimit = errorLimit * 2;
    for (const p of players) {
      if (!view.isFoe(p)) continue;
      if (p.zoned && !me.zoned && me.flag !== 'SB' && me.flag !== 'SW') continue;
      const enemy = predict(p);
      if (me.flag !== 'GM' && Math.abs(pos.z - enemy.z) >= 2 * view.world.tankHeight) continue;
      const dist = distance2D(pos, enemy);
      const diff = angleDifference(pos, me.azimuth, enemy);
      if (diff >= errorLimit
        && !(dist < 2 * view.world.shotSpeed && diff < closeErrorLimit)) continue;
      if (me.flag !== 'SB' && this.isObscured(ctx, pos, enemy)) continue;
      out.fire = true;
      out.shotTargetId = p.id;
      this.lastShot = view.now;
      return;
    }
  }
}

// How far from Ace a returning ricochet still counts as coming back to him --
// he may have moved a little by then -- and how long a shot is clear of its
// own muzzle.
const SELF_HIT_MARGIN = 2;
// Dodging: how far past a hit a shot must pass to count as missing, how far
// ahead a shot is worth worrying about, and how much time a move out of its
// way must leave to spare.
const DODGE_CLEARANCE = 1;
const DODGE_HORIZON_SECONDS = 3;
const DODGE_MARGIN_SECONDS = 0.1;
const DODGE_DEAD_ON = 0.5;
// The antidote is worth the drive when shaking the flag off takes longer than
// the drive there, with this much to spare.
const ANTIDOTE_DRIVE_FACTOR = 1.5;
const ANTIDOTE_SPARE_SECONDS = 2;
// How close a foe has to be to pull Ace off a capture.
const CAPTURE_CHASE_RANGE = 50;
// A step a tank drives up without a jump: `_maxBumpHeight`'s default.
const MAX_STEP_UP = 0.33;
// How much of one jump's height a flag may sit above Ace, and still be worth
// jumping for; how square to the flag he must be to jump; how far ahead he
// looks for the edge; and how far past an edge's corner the jump should clear.
const JUMP_REACH_SHARE = 0.9;
const JUMP_AIM_TOLERANCE = 0.2;
const JUMP_LOOKAHEAD = 30;
// Route following that is not a matter of tuning: how square a gap must be
// taken, how a stall is noticed and backed out of, and how many nodes ahead
// the follower looks at once.
const BRIDGE_AIM_TOLERANCE = 0.1;
// A flight is flown from within this of its takeoff, and this square to it.
const FLIGHT_TAKEOFF_SLACK = 3;
const FLIGHT_AIM_TOLERANCE = 0.05;
// How many frames before a drive-off leaves the edge the landing turn goes on.
const FLIGHT_SPIN_FRAMES = 1.5;
const UNSTICK_SECONDS = 0.5;
const UNSTICK_BACKOFF_SECONDS = 0.6;
const UNSTICK_SPEED = -0.5;
const UNSTICK_TURN = 0.05;
const UNSTICK_MOVE = 0.3;
const ROUTE_LOOKAHEAD = 16;
// How Ace drives a route, as numbers a benchmark can vary
// (scripts/bench-pilot.mjs): `follow` is `nodes` -- the next node, or a few
// ahead on the ground -- or `pursuit`, a point `pursuitGround`/`pursuitRaised`
// further along the route than he is; `speed` is `bearing` (slower the more he
// has to turn) or `arrival` (as fast as still lets him turn onto the aim).
// Off the ground he goes `raisedFactor` of the speed, which keeps him on
// walkways a tank's width wide.
export const ACE_TUNING = Object.freeze({
  follow: 'nodes',
  speed: 'bearing',
  groundLookahead: 10,
  pursuitGround: 10,
  pursuitRaised: 5,
  pursuitMin: 2,
  turnInPlace: 1,
  raisedTurn: 0.3,
  raisedSpeed: 0.3,
  raisedFactor: 0.7,
  reachedGround: 3,
  reachedRaised: 1.5,
  // How near a node Ace may pass and still count it behind him.
  passRange: 6,
  // `raised` is `factor` -- a flat `raisedFactor`, and `raisedSpeed` while
  // turning harder than `raisedTurn` -- or `curve`: full speed down a straight,
  // braking for the sharpest bend in the next `cornerLookahead` units, never
  // below `cornerSlowest`.
  raised: 'factor',
  cornerLookahead: 12,
  cornerSlowest: 0.2,
});
// Half a tank's width, plus a little, for the lane check.
const LANE_HALF_WIDTH = 1.6;
const ROUTE_REPLAN_SECONDS = 3;
const ROUTE_STRAY = 12;
const ROUTE_DEST_SLACK = 8;
const UNREACHABLE_SECONDS = 10;
const SELF_HIT_GRACE_SECONDS = 0.1;

// Roger with bzo's improvements. Each override is one of Roger's decisions
// answered differently; everything else is Roger's.
export class Ace extends Roger {
  constructor(options = {}) {
    super(options);
    this.tuning = { ...ACE_TUNING, ...options.tuning };
    // What each flag slot is, as far as this pilot has seen: what it carried,
    // and what it saw anyone else carry. A superflag on the ground arrives with
    // its type hidden, so this is how a pilot that dropped a flag knows not to
    // drive straight back over it.
    this.knownFlagTypes = new Map();
    // The route being followed, and the flags no route reached lately.
    this.route = null;
    this.unreachable = new Map();
    // Whether a route is getting anywhere, and how long a back-off has left.
    this.progress = null;
    this.unstickUntil = -Infinity;
    this.lastTrace = null;
    this.extraReport = (stats) => `, routes ${stats.plans} (${stats.unreachable} none),`
      + ` unsticks ${stats.unsticks}, held shots ${stats.held}`;
    // The landing each airborne foe has been shot at for, as a clock time, so
    // one jump costs one shot.
    this.landingShots = new Map();
    this.lastThinkAt = null;
  }

  // Ace sees everything the view holds -- every tank, every shot, wherever
  // it is. How fair a bot should play is a separate question, for later.
  think(view) {
    this.frameSeconds = this.lastThinkAt === null ? 0 : Math.max(0, view.now - this.lastThinkAt);
    this.lastThinkAt = view.now;
    if (view.self.flag && Number.isInteger(view.self.flagIndex)) {
      this.knownFlagTypes.set(view.self.flagIndex, view.self.flag);
    }
    for (const player of view.players) {
      if (player.flag && Number.isInteger(player.flagIndex)) {
        this.knownFlagTypes.set(player.flagIndex, player.flag);
      }
    }
    return super.think(view);
  }

  // A type this pilot has learned is one it can refuse.
  wantsGroundFlag(flag) {
    const type = flag.type ?? this.knownFlagTypes.get(flag.index) ?? null;
    if (!type) return true;
    if (isBadFlag(type) || HARD_FLAGS.has(type)) return false;
    return this.isFlagUseful(type);
  }

  // Where and when an airborne tank comes down, in upstream's frame: the arc
  // its last move describes, met with whatever surface is under the place it
  // gets to. Asked twice, since the surface decides the time and the time the
  // place.
  predictLanding(ctx, p) {
    if (!p.airborne || !(p.gravity > 0)) return null;
    const g = p.gravity;
    const apex = p.vz > 0 ? p.z + ((p.vz * p.vz) / (2 * g)) : p.z;
    let floor = 0;
    let landing = null;
    for (let pass = 0; pass < 2; pass++) {
      const disc = (p.vz * p.vz) + (2 * g * (p.z - floor));
      if (disc < 0) return null;
      const t = (p.vz + Math.sqrt(disc)) / g;
      landing = { x: p.x + (p.vx * t), y: p.y + (p.vy * t), z: floor, t };
      const hit = ctx.view.firstHit(
        { x: landing.x, y: apex + 0.5, z: -landing.y },
        { x: landing.x, y: -0.1, z: -landing.y },
      );
      const surface = hit ? Math.max(0, hit.y) : 0;
      if (Math.abs(surface - floor) < 0.01) break;
      floor = surface;
    }
    return landing;
  }

  // The shot a jumper lands into: from the muzzle, when its flight time is the
  // time left before the tank's body comes down through the shot's height.
  // Null when no shot can meet this landing.
  planLandingShot(ctx, p) {
    const { view, me } = ctx;
    const landing = this.predictLanding(ctx, p);
    if (!landing) return null;
    const muzzleZ = me.z + me.muzzleHeight;
    // A level shot meets the tank only if it lands with the muzzle's height
    // inside its body.
    if (muzzleZ < landing.z || muzzleZ > landing.z + view.world.tankHeight) return null;
    const g = p.gravity;
    // When the body's underside comes down past the shot's height, on the way
    // down: a tank still rising through it is about to leave. A hop that never
    // gets that high is in the shot's path all along.
    const disc = (p.vz * p.vz) + (2 * g * (p.z - muzzleZ));
    const enter = disc < 0 ? 0 : Math.max(0, (p.vz + Math.sqrt(disc)) / g);
    const azimuth = azimuthTo(me, landing);
    const reach = distance2D(me, landing) - me.muzzleForward - TANK_HIT_RADIUS;
    const flight = Math.max(0, reach) / me.shotSpeed;
    return { landing, azimuth, flight, enter, distance: distance2D(me, landing) };
  }

  // Turn to a heading in one step where one step reaches it: Roger's own
  // `rotation = difference` closes a gap over seconds, which is no way to aim
  // at a moment.
  aimAt(ctx, azimuth) {
    const { view, me, out } = ctx;
    const diff = normalizeAngle(azimuth - me.azimuth);
    const step = (view.world.tankAngVel || 0) * (this.frameSeconds || 0);
    out.rotation = step > 0 ? Math.max(-1, Math.min(1, diff / step)) : Math.sign(diff);
    return diff;
  }

  // A team flag goes home before anything is chased: Roger chases first, and a
  // chase that ends on an enemy base captures his own flag there, which kills
  // him and his team. Shooting is a separate step and still happens. And a foe
  // in the air is met where it will land rather than chased where it is.
  chasePlayer(ctx) {
    if (ctx.me.flagTeam !== null) return false;
    if (this.antidoteTarget(ctx)) return false;
    // A capture to make wins over a chase, except a foe close enough to be a
    // threat rather than a detour.
    if (this.captureTarget(ctx) && !this.foeWithin(ctx, CAPTURE_CHASE_RANGE)) return false;
    const chased = super.chasePlayer(ctx);
    const target = ctx.view.players.find((p) => p.id === ctx.out.targetId);
    if (!chased || !target?.airborne) return chased;
    const plan = this.planLandingShot(ctx, this.remotePlayers({ players: [target] })[0]);
    if (!plan) return chased;
    ctx.out.intent.mode = 'ambush';
    ctx.out.intent.landing = toBzo(plan.landing);
    this.aimAt(ctx, plan.azimuth);
    // Standing still while the shot is lined up keeps the muzzle where the plan
    // put it.
    ctx.out.speed = 0;
    return true;
  }

  // Every shot is checked before it leaves: one that would bounce back into
  // Ace is not fired. Roger, as upstream's does, fires and finds out.
  fireAtTank(ctx) {
    const lastShot = this.lastShot;
    const landingShots = new Map(this.landingShots);
    this.chooseShot(ctx);
    if (!ctx.out.fire) return;
    const shot = this.muzzleRay(ctx);
    if (this.shotEndangersSelf(ctx)) {
      ctx.out.fire = false;
      ctx.out.shotTargetId = null;
      this.lastShot = lastShot;
      this.landingShots = landingShots;
      this.stats.held++;
      // Shown all the same, as the shot that was not fired and why.
      ctx.out.intent.shot = { ...shot, segments: this.lastTrace, held: true };
      return;
    }
    ctx.out.intent.shot = { ...shot, segments: this.lastTrace };
  }

  // Whether the shot about to be fired comes back to where Ace is. Only a
  // ricochet can, and only once it has had time to turn round.
  shotEndangersSelf(ctx) {
    const { view } = ctx;
    const self = view.self;
    this.lastTrace = null;
    if (!self.ricochet || typeof view.traceShot !== 'function') return false;
    const dirX = -Math.sin(self.rotation);
    const dirZ = -Math.cos(self.rotation);
    const muzzle = {
      x: self.x + (dirX * self.muzzleForward),
      y: self.y + self.muzzleHeight,
      z: self.z + (dirZ * self.muzzleForward),
    };
    const reach = TANK_HIT_RADIUS + SELF_HIT_MARGIN;
    const segments = view.traceShot(muzzle, { x: dirX, y: 0, z: dirZ }, self.shotSpeed, self.shotLifetime, true);
    this.lastTrace = segments;
    for (const segment of segments) {
      if (segment.t0 < SELF_HIT_GRACE_SECONDS) continue;
      if (segment.to.y > self.y + view.world.tankHeight + 1) continue;
      if (segmentDistance2D(segment.from, segment.to, self) < reach) return true;
    }
    return false;
  }

  // Roger's trigger for every foe on the ground; one timed shot for a foe in
  // the air, and nothing else at it.
  chooseShot(ctx) {
    const { view, me, out } = ctx;
    const players = this.remotePlayers(view);
    for (const p of players) {
      if (!p.airborne || !p.alive || p.paused || !view.isFoe(p)) continue;
      if (!me.canFire) continue;
      const plan = this.planLandingShot(ctx, p);
      if (!plan) continue;
      const landsAt = view.now + plan.landing.t;
      const shotAt = this.landingShots.get(p.id);
      if (shotAt !== undefined && Math.abs(shotAt - landsAt) < 0.5) continue;
      // Late is a miss; early waits for a later frame.
      if (plan.flight < plan.enter || plan.flight > plan.landing.t + 0.05) continue;
      const miss = plan.distance * Math.abs(Math.sin(normalizeAngle(plan.azimuth - me.azimuth)));
      if (miss > TANK_HIT_RADIUS / 2) continue;
      if (this.isObscured(ctx, { x: me.x, y: me.y, z: me.z }, plan.landing)) continue;
      out.fire = true;
      out.shotTargetId = p.id;
      this.landingShots.set(p.id, landsAt);
      this.lastShot = view.now;
      return;
    }
    // A tank with a landing shot already on its way is left to it.
    const grounded = {
      ...view,
      players: view.players.filter((p) => !p.airborne
        && !(view.now <= (this.landingShots.get(p.id) ?? -Infinity) + 0.5)),
    };
    super.fireAtTank({ ...ctx, view: grounded });
  }

  // Staying alive comes first, and moving out of a shot's way before jumping
  // over it: a tank in the air cannot steer, so it is the easiest one to hit
  // next. For the shot that would hit soonest, Ace drives forward or back --
  // whichever clears its line first -- if that clears it in time and the way
  // is open; jumps only if not, and only where the jump is above the shot
  // before it arrives; and otherwise dodges as Roger does.
  avoidBullet(ctx) {
    const { view, me, out } = ctx;
    const threat = this.soonestHit(ctx);
    if (!threat) return false;
    const heading = { x: Math.cos(me.azimuth), y: Math.sin(me.azimuth) };
    let lateral = (heading.x * threat.away.x) + (heading.y * threat.away.y);
    // Dead on, neither side is nearer, so take the one ahead: forward is
    // twice reverse.
    if (threat.miss < DODGE_DEAD_ON && lateral < 0) lateral = -lateral;
    const needed = threat.clearance - threat.miss;
    const forwardRate = view.world.tankSpeed * lateral;
    const reverseRate = -0.5 * view.world.tankSpeed * lateral;
    const [speed, rate] = forwardRate >= reverseRate ? [1, forwardRate] : [-0.5, reverseRate];
    if (rate > 0 && needed / rate < threat.time - DODGE_MARGIN_SECONDS) {
      const travel = (needed / rate) * Math.abs(speed) * view.world.tankSpeed;
      const way = speed > 0 ? me.azimuth : me.azimuth + Math.PI;
      if (this.openDistance(ctx, me, way) > travel + 2) {
        out.speed = speed;
        out.rotation = 0;
        return true;
      }
    }
    if (this.canJumpClear(ctx, threat)) {
      out.jump = true;
      out.speed = speed;
      return true;
    }
    return super.avoidBullet(ctx);
  }

  // Of the shots Ace can see, the one that will hit him soonest if he stays
  // put: when it passes closest, by how much, and which way is away from it.
  soonestHit(ctx) {
    const { view, me } = ctx;
    const clearance = TANK_HIT_RADIUS + SHOT_COLLISION_RADIUS + DODGE_CLEARANCE;
    let best = null;
    for (const shot of view.shots) {
      if (shot.ownerId === me.id) continue;
      if (shot.ownerZoned && !me.zoned) continue;
      if (shot.flag === 'L' && me.flag === 'CL') continue;
      const pos = toBzf(shot);
      const vx = shot.vx;
      const vy = -shot.vz;
      const speed2 = (vx * vx) + (vy * vy);
      if (speed2 < 1e-6) continue;
      if (shot.flag !== 'GM' && Math.abs(pos.z - (me.z + 1)) > view.world.tankHeight) continue;
      const rx = me.x - pos.x;
      const ry = me.y - pos.y;
      const time = ((rx * vx) + (ry * vy)) / speed2;
      if (time <= 0 || time > DODGE_HORIZON_SECONDS) continue;
      const mx = rx - (vx * time);
      const my = ry - (vy * time);
      const miss = Math.hypot(mx, my);
      if (miss >= clearance) continue;
      if (best && time >= best.time) continue;
      const length = Math.sqrt(speed2);
      // Dead on, either side is away; take the left of the shot.
      const away = miss > 1e-6 ? { x: mx / miss, y: my / miss } : { x: -vy / length, y: vx / length };
      best = { time, miss, away, clearance, height: pos.z - me.z };
    }
    return best;
  }

  canJumpClear(ctx, threat) {
    const { view, me } = ctx;
    if (me.inAir || this.jumpReach(ctx) <= 0) return false;
    const v = view.world.jumpVelocity;
    const g = view.world.gravity;
    const rise = threat.height + SHOT_COLLISION_RADIUS;
    if (rise <= 0) return true;
    const disc = (v * v) - (2 * g * rise);
    if (disc < 0) return false;
    return (v - Math.sqrt(disc)) / g < threat.time;
  }

  // The antidote, when Ace carries a bad flag the server will let him shed
  // there and its own way out is slow or never: shake-off time longer than
  // the drive, or none at all.
  antidoteTarget(ctx) {
    const { view, me } = ctx;
    const antidote = view.antidote;
    if (!antidote || !me.flag || !isBadFlag(me.flag)) return null;
    const pos = toBzf(antidote);
    const drive = distance2D(me, pos) / (view.world.tankSpeed || 1);
    const timeout = view.world.shakeTimeout || 0;
    if (timeout > 0 && timeout < (drive * ANTIDOTE_DRIVE_FACTOR) + ANTIDOTE_SPARE_SECONDS) return null;
    return pos;
  }

  // The team flag worth fetching: an enemy's on the ground anywhere, or Ace's
  // own lying away from home. Roger only looks at a team flag he is all but
  // standing on, so he hardly ever makes a capture.
  captureTarget(ctx) {
    const { view, me } = ctx;
    if (!view.world.teamFlags || me.flagTeam !== null) return null;
    if (me.flag && isBadFlag(me.flag)) return null;
    const base = view.myBase();
    const reach = this.jumpReach(ctx) * JUMP_REACH_SHARE;
    const routed = typeof view.findRoute === 'function';
    let best = null;
    for (const flag of view.flags) {
      if (!flag.onGround || flag.team === null) continue;
      const pos = toBzf(flag);
      // With a route graph a flag is worth going for until no route reaches
      // it. Without one, only where driving straight at it gets there: down,
      // level, or up one jump.
      if (routed) {
        if ((this.unreachable.get(flag.index) ?? -Infinity) > view.now) continue;
      } else if (pos.z - me.z > Math.max(reach, MAX_STEP_UP)) {
        continue;
      }
      if (flag.team === me.teamColor) {
        if (!base || this.isHome(pos, base)) continue;
      }
      const dist = distance2D(me, pos);
      if (!best || dist < best.dist) best = { flag, pos, dist };
    }
    return best;
  }

  // How high one jump lifts the tank, if it may jump at all.
  jumpReach(ctx) {
    const { view, me } = ctx;
    const canJump = (view.world.allowJumping || me.flag === 'JP' || me.flag === 'WG') && me.flag !== 'NJ';
    if (!canJump || !(view.world.gravity > 0)) return 0;
    return (view.world.jumpVelocity * view.world.jumpVelocity) / (2 * view.world.gravity);
  }

  foeWithin(ctx, range) {
    return this.remotePlayers(ctx.view).some((p) => p.alive && !p.paused
      && ctx.view.isFoe(p) && distance2D(ctx.me, p) < range);
  }

  lookForFlag(ctx) {
    const antidote = this.antidoteTarget(ctx);
    if (antidote) return this.goTo(ctx, antidote, 'antidote');
    const target = this.captureTarget(ctx);
    if (!target) return super.lookForFlag(ctx);
    const { me, out } = ctx;
    out.intent.mode = 'capture';
    out.intent.target = { ...toBzo(target.pos), flag: target.flag.type ?? null };
    // One flag at a time: whatever is held goes when the team flag is in reach.
    if (target.dist < 10 && me.flag) out.dropFlag = true;
    if (typeof ctx.view.findRoute === 'function') {
      const route = this.routeTo(ctx, target.pos);
      if (route && this.followRoute(ctx, route)) return true;
      if (!route) {
        this.unreachable.set(target.flag.index, ctx.view.now + UNREACHABLE_SECONDS);
        return super.lookForFlag(ctx);
      }
    }
    out.rotation = normalizeAngle(azimuthTo(me, target.pos) - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    // Up onto whatever the flag sits on: at full speed, from where the jump
    // clears the top on the way up and comes down on it before falling past.
    const rise = target.pos.z - me.z;
    if (rise > MAX_STEP_UP && Math.abs(out.rotation) < JUMP_AIM_TOLERANCE && !me.inAir) {
      const edge = ctx.view.firstBuilding(
        { x: me.x, y: me.z, z: -me.y }, toBzoHeading(me.azimuth), JUMP_LOOKAHEAD);
      if (edge && edge.top - me.z <= this.jumpReach(ctx)) this.takeJump(ctx, edge.top - me.z, edge.distance);
    }
    return true;
  }

  // Somewhere to be, by a route where there is one and straight there where not.
  goTo(ctx, pos, mode) {
    const { out, me } = ctx;
    out.intent.mode = mode;
    out.intent.target = toBzo(pos);
    if (typeof ctx.view.findRoute === 'function') {
      const route = this.routeTo(ctx, pos);
      if (route && this.followRoute(ctx, route)) return true;
    }
    out.rotation = normalizeAngle(azimuthTo(me, pos) - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    return true;
  }

  // Carrying a team flag home, by the route there rather than straight at it.
  navigate(ctx) {
    const { view, me } = ctx;
    if (me.flagTeam !== null && typeof view.findRoute === 'function') {
      const base = view.myBase();
      const pos = { x: me.x, y: me.y, z: me.z };
      const home = base && me.flagTeam === me.teamColor && this.isHome(pos, base);
      if (base && !home) {
        ctx.out.intent.mode = 'home';
        ctx.out.intent.target = { x: base.x, y: base.y, z: base.z };
        const route = this.routeTo(ctx, toBzf(base));
        if (route && this.followRoute(ctx, route)) return true;
      }
    }
    return super.navigate(ctx);
  }

  // The route to `dest` (upstream's frame), planned when the destination moves,
  // when Ace has strayed from it, or every few seconds; a destination no route
  // reaches is not asked about again for a while.
  routeTo(ctx, dest) {
    const { view, me } = ctx;
    const here = { x: me.x, y: me.z, z: -me.y };
    const there = { x: dest.x, y: dest.z, z: -dest.y };
    const current = this.route;
    const sameDest = current && Math.hypot(current.dest.x - there.x, current.dest.z - there.z) < ROUTE_DEST_SLACK
      && Math.abs(current.dest.y - there.y) < 1;
    if (sameDest && !current.nodes) {
      return view.now - current.plannedAt < UNREACHABLE_SECONDS ? null : this.plan(view, here, there);
    }
    if (sameDest && view.now - current.plannedAt < ROUTE_REPLAN_SECONDS && !this.strayed(current, here)) {
      return current;
    }
    return this.plan(view, here, there);
  }

  plan(view, here, there) {
    const nodes = view.findRoute(here, there);
    this.stats.plans++;
    if (!nodes) this.stats.unreachable++;
    this.route = { dest: there, nodes, at: 0, plannedAt: view.now };
    return nodes ? this.route : null;
  }

  // Measured from the last node reached rather than the next, which across a
  // jump is the far side of it.
  strayed(route, here) {
    const last = route.nodes[Math.max(0, Math.min(route.at, route.nodes.length) - 1)];
    return !last || Math.hypot(last.x - here.x, last.z - here.z) > ROUTE_STRAY;
  }

  // One frame along a route: on to the next node, past the ones on the same
  // level, and up a jump when lined up for it. False once the route is run.
  followRoute(ctx, route) {
    const { me, out } = ctx;
    const here = { x: me.x, y: me.z, z: -me.y };
    const nodes = route.nodes;
    // Up off the ground, where an edge is a fall, a node counts only once Ace
    // is on it and the aim does not run ahead to cut a corner.
    const raised = here.y > MAX_STEP_UP;
    const tuning = this.tuning;
    const reached = raised ? tuning.reachedRaised : tuning.reachedGround;
    while (route.at < nodes.length) {
      const node = nodes[route.at];
      if (Math.abs(node.y - here.y) > 1) break;
      const distance = Math.hypot(node.x - here.x, node.z - here.z);
      if (distance <= reached) {
        route.at++;
        continue;
      }
      // Driven past rather than over: beyond the node, in the direction the
      // route goes on from it, and near it. Turning back to touch it is how a
      // tank that turns an eighth of a circle a second spends its life.
      const after = nodes[route.at + 1];
      if (!after || distance > tuning.passRange) break;
      const ahead = ((here.x - node.x) * (after.x - node.x)) + ((here.z - node.z) * (after.z - node.z));
      if (ahead <= 0) break;
      route.at++;
    }
    if (route.at >= nodes.length) return false;
    out.intent.route = nodes.slice(route.at);
    const next = nodes[route.at];
    if (next.flight && !me.inAir) {
      this.fly(ctx, here, route.at > 0 ? nodes[route.at - 1] : here, next.flight, next, nodes[route.at + 1]);
      this.unstick(ctx);
      return true;
    }
    let aim = next;
    if (!next.jump && !next.bridge) {
      if (tuning.follow === 'pursuit') {
        aim = this.pursuitPoint(ctx, here, nodes, route.at, raised);
      } else if (!raised) {
        for (let k = route.at + 1; k < Math.min(nodes.length, route.at + tuning.groundLookahead); k++) {
          if (nodes[k].jump || nodes[k].bridge || Math.abs(nodes[k].y - next.y) > 0.5) break;
          aim = nodes[k];
        }
      }
    }
    out.rotation = normalizeAngle(azimuthTo(me, toBzf(aim)) - me.azimuth);
    if (tuning.speed === 'arrival') {
      out.speed = this.arrivalSpeed(ctx, here, aim, out.rotation);
    } else {
      // Far off the heading, turn on the spot rather than drive a wide arc --
      // or, past a right angle, backwards away from the route.
      out.speed = Math.abs(out.rotation) > tuning.turnInPlace ? 0 : HALF_PI - Math.abs(out.rotation);
    }
    if (raised && tuning.raised === 'curve') {
      out.speed = Math.min(out.speed, this.cornerSpeed(here, nodes, route.at, out.rotation));
    } else if (raised && Math.abs(out.rotation) > tuning.raisedTurn) {
      out.speed = Math.min(out.speed, tuning.raisedSpeed);
    }
    if (next.jump && !next.flight && !me.inAir) this.lineUpJump(ctx, here, next);
    // A gap is crossed square to it, or a corner of the tank drops into it.
    if (next.bridge && Math.abs(out.rotation) >= BRIDGE_AIM_TOLERANCE) out.speed = 0;
    this.unstick(ctx);
    return true;
  }

  // A tank asked to turn or to move that does neither is against something:
  // a wall refuses a turn that would swing the tank into it. Roger's own check
  // only looks straight ahead. Back off for a moment, turning, and try again.
  unstick(ctx) {
    const { view, me, out } = ctx;
    if (view.now < this.unstickUntil) {
      out.speed = UNSTICK_SPEED;
      out.intent.mode = 'unstick';
      return;
    }
    const sample = this.progress;
    const trying = Math.abs(out.rotation) > 0.1 || Math.abs(out.speed) > 0.1;
    if (!sample || !trying || me.inAir) {
      this.progress = { t: view.now, x: me.x, y: me.y, azimuth: me.azimuth };
      return;
    }
    const turned = Math.abs(normalizeAngle(me.azimuth - sample.azimuth));
    const moved = Math.hypot(me.x - sample.x, me.y - sample.y);
    if (turned > UNSTICK_TURN || moved > UNSTICK_MOVE) {
      this.progress = { t: view.now, x: me.x, y: me.y, azimuth: me.azimuth };
      return;
    }
    if (view.now - sample.t > UNSTICK_SECONDS) {
      this.unstickUntil = view.now + UNSTICK_BACKOFF_SECONDS;
      this.progress = null;
      this.stats.unsticks++;
      out.speed = UNSTICK_SPEED;
    }
  }

  // The nearest point to `here` on the legs ending at nodes `at` onward --
  // leg `k` runs from node `k - 1` to node `k` -- as the leg it is on.
  nearestOnRoute(here, nodes, at) {
    let best = { leg: at, distance: Infinity };
    const end = Math.min(nodes.length, at + ROUTE_LOOKAHEAD);
    for (let k = Math.max(1, at); k < end; k++) {
      const a = nodes[k - 1];
      const b = nodes[k];
      // A jump or a gap is entered from its takeoff node and nowhere else:
      // being level with some point along its leg is not being ready for it.
      if (b.jump || b.bridge) break;
      if (Math.abs(b.y - here.y) > 1 && Math.abs(a.y - here.y) > 1) continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSquared = (dx * dx) + (dz * dz) || 1;
      const t = Math.max(0, Math.min(1, (((here.x - a.x) * dx) + ((here.z - a.z) * dz)) / lengthSquared));
      const distance = Math.hypot(a.x + (dx * t) - here.x, a.z + (dz * t) - here.z);
      if (distance < best.distance) best = { leg: k, distance, t };
    }
    return best;
  }

  // Pure pursuit: the point a fixed distance further along the route than
  // where Ace is on it, stopping at anything to be taken square -- a jump, a
  // gap, a change of level. Short up on a walkway, so he stays over it; longer
  // on the ground, shortened while a tank's width to it is not clear.
  pursuitPoint(ctx, here, nodes, at, raised) {
    const level = nodes[at].y;
    const { pursuitGround, pursuitRaised, pursuitMin } = this.tuning;
    for (let lead = raised ? pursuitRaised : pursuitGround; lead >= pursuitMin; lead /= 2) {
      let left = lead;
      let from = here;
      let point = nodes[at];
      for (let k = at; k < nodes.length; k++) {
        const node = nodes[k];
        if (k > at && (node.jump || node.bridge || Math.abs(node.y - level) > MAX_STEP_UP)) break;
        const step = Math.hypot(node.x - from.x, node.z - from.z);
        if (step >= left) {
          const t = left / step;
          point = { x: from.x + ((node.x - from.x) * t), y: node.y, z: from.z + ((node.z - from.z) * t) };
          left = 0;
          break;
        }
        left -= step;
        from = node;
        point = node;
      }
      if (raised) return point;
      const dx = point.x - here.x;
      const dz = point.z - here.z;
      const length = Math.hypot(dx, dz);
      if (length < 1e-3 || this.laneClear(ctx, here, point, dx / length, dz / length)) return point;
    }
    return nodes[at];
  }

  // How fast to drive up on a walkway: full speed down a straight one, braking
  // for the sharpest bend in the next stretch of route and for how far his
  // heading is off it now -- a corner taken fast on something a tank wide is a
  // fall.
  cornerSpeed(here, nodes, at, rotation) {
    const { cornerLookahead, cornerSlowest } = this.tuning;
    let sharpest = 0;
    let travelled = 0;
    let from = here;
    let heading = null;
    for (let k = at; k < nodes.length && travelled < cornerLookahead; k++) {
      const node = nodes[k];
      const dx = node.x - from.x;
      const dz = node.z - from.z;
      const step = Math.hypot(dx, dz);
      if (step < 1e-3) continue;
      const direction = Math.atan2(dx, dz);
      if (heading !== null) sharpest = Math.max(sharpest, Math.abs(normalizeAngle(direction - heading)));
      heading = direction;
      travelled += step;
      from = node;
    }
    const bend = Math.max(sharpest, Math.abs(rotation));
    return Math.max(cornerSlowest, 1 - (bend / HALF_PI));
  }

  // The fastest Ace can drive and still turn onto a point: at full turn a tank
  // runs a circle of `tankSpeed / turnRate` times its speed, and to come round
  // onto a point `d` off at bearing `b` that circle can be at most
  // `d / (2 sin b)` across. Faster than that, he orbits it and never arrives;
  // past a right angle he turns where he is.
  arrivalSpeed(ctx, here, aim, rotation) {
    const { world } = ctx.view;
    const bearing = Math.abs(rotation);
    if (bearing >= HALF_PI) return 0;
    const turnRadius = (world.tankSpeed || 25) / (world.tankAngVel || (Math.PI / 4));
    const distance = Math.hypot(aim.x - here.x, aim.z - here.z);
    const sine = Math.sin(bearing);
    if (sine < 1e-3) return 1;
    return Math.min(1, distance / (2 * sine * turnRadius));
  }

  // A tank's width of open drive from here to there: the centre line and one
  // either side.
  laneClear(ctx, here, there, ux, uz) {
    for (const side of [0, -LANE_HALF_WIDTH, LANE_HALF_WIDTH]) {
      const ox = -uz * side;
      const oz = ux * side;
      const from = { x: here.x + ox, y: here.y + 1, z: here.z + oz };
      const to = { x: there.x + ox, y: there.y + 1, z: there.z + oz };
      if (ctx.view.isObscured(from, to)) return false;
    }
    return true;
  }

  // A flight as planned: from its takeoff, square to its heading, at its
  // speed -- a jump leaves at once, a drive-off holds the speed to the edge.
  // The arc was worked out for exactly this, so nothing improvises: off the
  // heading, he turns where he stands.
  //
  // A tank keeps turning through the air at the rate it left with, so the
  // turn for the leg after the landing is put on as it leaves: enough to come
  // down facing it.
  fly(ctx, here, takeoff, flight, landing, after) {
    const { me, out } = ctx;
    // On the flight's line: near it across, and along it no further back than
    // the takeoff -- nor further on than the launch, for a drive-off, which is
    // that stretch of driving.
    const rx = here.x - takeoff.x;
    const rz = here.z - takeoff.z;
    const along = (rx * flight.dx) + (rz * flight.dz);
    const across = Math.abs((rx * flight.dz) - (rz * flight.dx));
    const furthest = flight.jump ? FLIGHT_TAKEOFF_SLACK : flight.launch + FLIGHT_TAKEOFF_SLACK + NAV_CELL;
    if (across > FLIGHT_TAKEOFF_SLACK || along < -FLIGHT_TAKEOFF_SLACK || along > furthest) {
      out.rotation = normalizeAngle(azimuthTo(me, toBzf(takeoff)) - me.azimuth);
      out.speed = Math.abs(out.rotation) > this.tuning.turnInPlace ? 0 : HALF_PI - Math.abs(out.rotation);
      return;
    }
    const heading = Math.atan2(-flight.dz, flight.dx);
    const off = this.aimAt(ctx, heading);
    const aligned = Math.abs(off) < FLIGHT_AIM_TOLERANCE;
    out.speed = aligned ? flight.speed : 0;
    if (!aligned) return;
    // Leaving now: a jump at once, a drive-off on its last frame of ground.
    const step = flight.speed * ctx.view.world.tankSpeed * (this.frameSeconds || 0.05);
    const leaving = flight.jump || along >= flight.launch - (FLIGHT_SPIN_FRAMES * step);
    if (flight.jump) out.jump = true;
    if (leaving && after && flight.air > 0) {
      const nextHeading = Math.atan2(-(after.z - landing.z), after.x - landing.x);
      const turn = normalizeAngle(nextHeading - heading);
      const rate = ctx.view.world.tankAngVel || (Math.PI / 4);
      out.rotation = Math.max(-1, Math.min(1, turn / (flight.air * rate)));
    }
  }

  // A jump is taken square to it and from inside its window: turn to face it,
  // back straight off if too close to clear the corner, drive in if too far,
  // and go at full speed once there.
  lineUpJump(ctx, here, landing) {
    const { out } = ctx;
    if (Math.abs(out.rotation) >= JUMP_AIM_TOLERANCE) {
      out.speed = 0;
      return;
    }
    const edge = Math.hypot(landing.x - here.x, landing.z - here.z) - (NAV_CELL / 2);
    this.takeJump(ctx, landing.y - here.y, edge);
  }

  // Jump onto something `rise` up and `edge` away at the speed that lands it,
  // or back off or drive in until there is one.
  takeJump(ctx, rise, edge) {
    const { view, out } = ctx;
    const plan = planJump(this.jumpParams(view), rise, edge);
    if (!plan) return false;
    if (plan.tooClose) {
      out.speed = -0.5;
    } else if (plan.tooFar) {
      out.speed = 1;
    } else {
      out.speed = plan.speed;
      out.jump = true;
    }
    return true;
  }

  jumpParams(view) {
    return { velocity: view.world.jumpVelocity, gravity: view.world.gravity, tankSpeed: view.world.tankSpeed };
  }



  // Home is on the base.
  isHome(pos, base) {
    return distance2D(pos, toBzf(base)) <= base.radius;
  }

  // Off the ground, Roger's look-ahead meets nothing whether or not an edge is
  // there, so this runs on every frame he is up on something: stop short of
  // water below, and otherwise drive at `raisedFactor` of the speed, which on a
  // walkway a tank's width wide is the difference between staying on it and
  // driving off the side.
  edgeAhead(ctx) {
    const { view, me, out } = ctx;
    if (me.z <= 0.01) return;
    // A route knows where the surface is, and its follower brakes for it; and
    // a jump goes at the speed chosen for it.
    if (out.jump || out.intent.route?.[0]?.flight) return;
    if (this.tuning.raised === 'curve' && out.intent.route?.length) return;
    const waterLevel = view.world.waterLevel;
    if (Number.isFinite(waterLevel) && waterLevel > 0) out.speed = 0;
    else out.speed *= this.tuning.raisedFactor;
  }


}

// The view's four probes, against the solids a shot meets and the world's
// walls -- upstream's walls are obstacles and bzo's are not. Built from
// whichever world the caller holds, so the client and a server-run bot ask the
// same questions the same way. `findImpact` is the `collision` pair's
// `findShotSegmentImpact`; `topOf` an obstacle's top height.
const PROBE_RANGE = 1000;

// `colliders` is every solid a shot bounces off, the world's walls included,
// for `traceShot`.
const TRACE_STEP_SECONDS = 1 / 30;

export function createWorldProbes({
  obstacles, colliders, mapSize, findImpact, topOf,
}) {
  const rayFraction = (from, to) => {
    const impact = findImpact(obstacles(), from, to, 0);
    let fraction = impact ? impact.fraction : 1;
    const half = mapSize() / 2;
    for (const axis of ['x', 'z']) {
      const delta = to[axis] - from[axis];
      if (delta > 0 && to[axis] > half) fraction = Math.min(fraction, (half - from[axis]) / delta);
      if (delta < 0 && to[axis] < -half) fraction = Math.min(fraction, (-half - from[axis]) / delta);
    }
    return { fraction: Math.max(0, fraction), obstacle: impact ? impact.obstacle : null, hit: fraction < 1 };
  };
  const ray = (pos, heading, range) => {
    const from = { x: pos.x, y: pos.y + 0.1, z: pos.z };
    const to = {
      x: from.x - (Math.sin(heading) * range),
      y: from.y,
      z: from.z - (Math.cos(heading) * range),
    };
    return rayFraction(from, to);
  };
  return {
    openDistance: (pos, heading) => {
      const hit = ray(pos, heading, PROBE_RANGE);
      return hit.hit ? hit.fraction * PROBE_RANGE : Infinity;
    },
    isObscured: (from, to) => rayFraction(from, to).hit,
    firstHit: (from, to) => {
      const hit = rayFraction(from, to);
      if (!hit.hit) return null;
      return {
        x: from.x + ((to.x - from.x) * hit.fraction),
        y: from.y + ((to.y - from.y) * hit.fraction),
        z: from.z + ((to.z - from.z) * hit.fraction),
      };
    },
    firstBuilding: (pos, heading, range) => {
      if (!(range > 0)) return null;
      const hit = ray(pos, heading, range);
      if (!hit.obstacle) return null;
      return {
        isBox: hit.obstacle.type === 'box',
        top: topOf(hit.obstacle),
        distance: hit.fraction * range,
      };
    },
    // Where a shot goes over its life, bounces and all, by the tracer the
    // shot itself is flown with: a list of `{ t0, t1, from, to }`, seconds
    // after firing. Teleporters are not followed.
    traceShot: (from, dir, speed, lifetime, ricochet) => {
      const solids = colliders();
      const segments = [];
      let point = { ...from };
      let direction = { ...dir };
      for (let t = 0; t < lifetime; t += TRACE_STEP_SECONDS) {
        const step = traceShotStep({
          obstacles: solids,
          x: point.x,
          y: point.y,
          z: point.z,
          dirX: direction.x,
          dirY: direction.y,
          dirZ: direction.z,
          distance: speed * TRACE_STEP_SECONDS,
          radius: SHOT_COLLISION_RADIUS,
          ricochet,
        });
        const to = { x: step.x, y: step.y, z: step.z };
        segments.push({ t0: t, t1: t + TRACE_STEP_SECONDS, from: point, to });
        if ((step.obstacle || step.ground) && (!ricochet || step.bounces === 0)) break;
        point = to;
        direction = { x: step.dirX, y: step.dirY, z: step.dirZ };
      }
      return segments;
    },
  };
}

// The nearest a segment comes to a point, on the ground plane.
function segmentDistance2D(from, to, point) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSquared = (dx * dx) + (dz * dz);
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, (((point.x - from.x) * dx) + ((point.z - from.z) * dz)) / lengthSquared))
    : 0;
  return Math.hypot(from.x + (dx * t) - point.x, from.z + (dz * t) - point.z);
}

// The view's `findRoute`, over whichever world the caller holds: the graph is
// built the first time a route is asked for and again only when the world
// changes. `world()` returns { obstacles, mapSize, waterLevel, jump }, where
// `obstacles` is the same array for as long as the world is the same.
export function createRouter(world) {
  let built = null;
  return (from, to) => {
    const current = world();
    if (!built || built.obstacles !== current.obstacles || built.mapSize !== current.mapSize) {
      built = { obstacles: current.obstacles, mapSize: current.mapSize, graph: buildNavGraph(current) };
    }
    return built.graph.findRoute(from, to);
  };
}

// What the Settings row offers, in order, and the key each is chosen by.
export const AUTOPILOTS = Object.freeze([
  Object.freeze({ id: 'roger', name: 'Roger', Pilot: Roger }),
  Object.freeze({ id: 'ace', name: 'Ace', Pilot: Ace }),
]);
