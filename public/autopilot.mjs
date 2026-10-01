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
      },
    };
    this.dropHardFlags(ctx);
    if (!this.avoidBullet(ctx)
      && !this.stuckOnWall(ctx)
      && !this.chasePlayer(ctx)
      && !this.lookForFlag(ctx)) {
      this.navigate(ctx);
    }
    this.avoidDeathFall(ctx);
    this.fireAtTank(ctx);
    return ctx.out;
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
// How close a foe has to be to pull Ace off a capture.
const CAPTURE_CHASE_RANGE = 50;
const SELF_HIT_GRACE_SECONDS = 0.1;

// Roger with bzo's improvements. Each override is one of Roger's decisions
// answered differently; everything else is Roger's.
export class Ace extends Roger {
  constructor(options) {
    super(options);
    // What each flag slot is, as far as this pilot has seen: what it carried,
    // and what it saw anyone else carry. A superflag on the ground arrives with
    // its type hidden, so this is how a pilot that dropped a flag knows not to
    // drive straight back over it.
    this.knownFlagTypes = new Map();
    // The landing each airborne foe has been shot at for, as a clock time, so
    // one jump costs one shot.
    this.landingShots = new Map();
    this.lastThinkAt = null;
  }

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
    // A capture to make wins over a chase, except a foe close enough to be a
    // threat rather than a detour.
    if (this.captureTarget(ctx) && !this.foeWithin(ctx, CAPTURE_CHASE_RANGE)) return false;
    const chased = super.chasePlayer(ctx);
    const target = ctx.view.players.find((p) => p.id === ctx.out.targetId);
    if (!chased || !target?.airborne) return chased;
    const plan = this.planLandingShot(ctx, this.remotePlayers({ players: [target] })[0]);
    if (!plan) return chased;
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
    if (ctx.out.fire && this.shotEndangersSelf(ctx)) {
      ctx.out.fire = false;
      ctx.out.shotTargetId = null;
      this.lastShot = lastShot;
      this.landingShots = landingShots;
    }
  }

  // Whether the shot about to be fired comes back to where Ace is. Only a
  // ricochet can, and only once it has had time to turn round.
  shotEndangersSelf(ctx) {
    const { view } = ctx;
    const self = view.self;
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

  // The team flag worth fetching: an enemy's on the ground anywhere, or Ace's
  // own lying away from home. Roger only looks at a team flag he is all but
  // standing on, so he hardly ever makes a capture.
  captureTarget(ctx) {
    const { view, me } = ctx;
    if (!view.world.teamFlags || me.flagTeam !== null) return null;
    if (me.flag && isBadFlag(me.flag)) return null;
    const base = view.myBase();
    let best = null;
    for (const flag of view.flags) {
      if (!flag.onGround || flag.team === null) continue;
      const pos = toBzf(flag);
      if (flag.team === me.teamColor) {
        if (!base || this.isHome(pos, base)) continue;
      }
      const dist = distance2D(me, pos);
      if (!best || dist < best.dist) best = { flag, pos, dist };
    }
    return best;
  }

  foeWithin(ctx, range) {
    return this.remotePlayers(ctx.view).some((p) => p.alive && !p.paused
      && ctx.view.isFoe(p) && distance2D(ctx.me, p) < range);
  }

  lookForFlag(ctx) {
    const target = this.captureTarget(ctx);
    if (!target) return super.lookForFlag(ctx);
    const { me, out } = ctx;
    // One flag at a time: whatever is held goes when the team flag is in reach.
    if (target.dist < 10 && me.flag) out.dropFlag = true;
    out.rotation = normalizeAngle(azimuthTo(me, target.pos) - me.azimuth);
    out.speed = HALF_PI - Math.abs(out.rotation);
    return true;
  }

  // Home is on the base.
  isHome(pos, base) {
    return distance2D(pos, toBzf(base)) <= base.radius;
  }

  // Nothing under the point ahead but the ground: an edge to drive off, and
  // with water below, one not to.
  edgeAhead(ctx) {
    const { view, me, out } = ctx;
    if (me.z <= 0.01) return;
    const waterLevel = view.world.waterLevel;
    if (Number.isFinite(waterLevel) && waterLevel > 0) out.speed = 0;
    else out.speed *= 0.5;
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
      return { isBox: hit.obstacle.type === 'box', top: topOf(hit.obstacle) };
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

// What the Settings row offers, in order, and the key each is chosen by.
export const AUTOPILOTS = Object.freeze([
  Object.freeze({ id: 'roger', name: 'Roger', Pilot: Roger }),
  Object.freeze({ id: 'ace', name: 'Ace', Pilot: Ace }),
]);
