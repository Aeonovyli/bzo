/*
 * Copyright (C) 2025-2026 Tim Riker <timriker@gmail.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPLv3).
 * Source: https://github.com/timriker/bzo
 * See LICENSE or https://www.gnu.org/licenses/agpl-3.0.html
 */

// Keep client-side allocations bounded even when the server configuration
// arrives through an untrusted WebSocket payload.
export const MAX_SHOT_SLOTS = 64;

// Zero survives: `-ms 0` means "tanks cannot shoot" upstream
// (`CmdLineOptions.cxx:897-909`, which warns and then honours it), and it is
// only a *negative* or unparseable count that upstream turns into one shot.
// Everything that can fire asks this first, so a world with no slots refuses
// every shot by arithmetic rather than by a switch of its own.
//
// Which means absence has to be told from a stated zero before the number is
// taken: `Number(null)`, `Number(false)` and `Number('')` are all 0, and none
// of them is a world saying it has no shooting.
export function normalizeShotSlotCount(value) {
  if (value === null || typeof value === 'boolean') {
    return 1;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return 1;
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
    return 1;
  }
  if (parsedValue > MAX_SHOT_SLOTS) {
    return MAX_SHOT_SLOTS;
  }
  return parsedValue;
}

// PlayerId `ServerPlayer` (Address.h:75), the id upstream gives every shot
// nobody fired: a world weapon's, and a death by drowning or a death physics
// driver. It is one of five reserved ids -- 255 NoPlayer, 254 AllPlayers, 253
// ServerPlayer, 252 AdminPlayers, 251 and down for the teams -- and it is a
// number where a bzo player id is the decimal *string* of its player number, so
// the two can never be equal however many players join. A shot carrying it has
// no entry in the roster on purpose, which is what every path that looks a
// shooter up has to tolerate.
export const WORLD_WEAPON_PLAYER_ID = 253;

// bz_vectorFromRotations (bzfsAPI.cxx:1845), which is how a world weapon's aim
// becomes a direction, converted to bzo's axes.
//
// Upstream builds it in BZFlag's frame:
//
//   (cos(tilt) * cos(rot), cos(tilt) * sin(rot), sin(tilt))
//
// and bzo is that frame relabelled -- bzo(x, y, z) = bzf(x, z, -y) -- so the
// second and third components swap and the new z takes the sign. `rotation` and
// `tilt` are radians here; the BZW file states both in degrees and
// `WorldFileLocation::read` and `CustomWeapon::read` convert.
export function getWorldWeaponDirection(rotation, tilt) {
  const tiltFactor = Math.cos(tilt);
  return {
    x: tiltFactor * Math.cos(rotation),
    y: Math.sin(tilt),
    z: -tiltFactor * Math.sin(rotation),
  };
}

// CustomWeapon's defaults (CustomWeapon.cxx:32) and its floor on a delay: a
// weapon with no `initdelay` waits ten seconds for its first shot and one with
// no `delay` fires every ten after that. `minWeaponDelay` is upstream's own
// guard against a weapon asked to fire faster than the server ticks -- it skips
// such an entry with a message rather than accepting it.
export const WORLD_WEAPON_DEFAULT_DELAY = 10;
export const WORLD_WEAPON_MIN_DELAY = 0.1;

// The delay list a weapon actually cycles, from what the map asked for.
// Upstream keeps a vector and steps through it a shot at a time, wrapping at the
// end (WorldWeapons.cxx:181), so a map may give a rhythm rather than a rate. An
// entry under the floor is dropped; if that leaves nothing, the default stands.
export function normalizeWorldWeaponDelays(delays) {
  const kept = (Array.isArray(delays) ? delays : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= WORLD_WEAPON_MIN_DELAY);
  return kept.length > 0 ? kept : [WORLD_WEAPON_DEFAULT_DELAY];
}

// WorldPlayer (WorldPlayer.cxx:17), which is the *only* identity a world weapon
// has: upstream keeps one pseudo-player for every world weapon on the map --
// `Player(ServerPlayer, RogueTeam, "world weapon", "", ComputerPlayer)` -- and
// its shots are drawn and put on the radar as that player's.
//
// It is a collective, not a name per weapon: `CustomWeapon::read` reads no
// `name`, and a weapon is not an obstacle, so there is nothing in the map to
// name one by. It is also not on the scoreboard, because it is not in
// `remotePlayers`, and bzo keeps it out of the roster for the same reason.
export const WORLD_WEAPON_NAME = 'world weapon';
export const WORLD_WEAPON_TEAM = 'rogue';

// --- Shot slots as a clock ---------------------------------------------------

// The world's `_reloadTime`, in seconds. Upstream declares it
// `_shotRange / _shotSpeed` (global.cxx:127) and a map may state its own, which
// is what `SHOT_LIFETIME` carries. Everything below is a multiple of it, and so
// is a shot's life, so both ends have to read it the same way or they disagree
// about when a slot comes back.
export function getWorldReloadSeconds(config) {
  const lifetimeMs = Number(config?.SHOT_LIFETIME);
  if (Number.isFinite(lifetimeMs) && lifetimeMs > 0) return lifetimeMs / 1000;
  const speed = Number.isFinite(config?.SHOT_SPEED) ? config.SHOT_SPEED : 100;
  const range = Number.isFinite(config?.SHOT_RANGE)
    ? config.SHOT_RANGE
    : (Number.isFinite(config?.SHOT_DISTANCE) ? config.SHOT_DISTANCE : 350);
  return speed > 0 ? range / speed : 10;
}

// How long one slot is out of action after it is fired: `ShotPath::reloadTime`,
// which starts at the world's reload and is divided by the firing flag's rate in
// each segmented strategy's constructor -- `setReloadTime(reload / adRate)`.
//
// **This is the client's rule, not bzfs's, and that is deliberate.** bzfs frees
// a slot on the shot's *life* instead (`GameKeeper::addShot` tests
// `now < shotsInfo[id].expireTime`, and `expireTime` comes from
// `GetShotLifetime`), which for `L`, `SW` and `TH` is far shorter than the
// reload an honest bzflag client waits out. Holding bzo to the client's rule is
// what keeps a bzo player level with a desktop one rather than ahead of them,
// and it means every shot bzo sends is one the target server will accept --
// a shot bzfs refuses is simply dropped, which on a phone would look like a
// trigger that sometimes does nothing.
export function getSlotReloadSeconds(worldReloadSeconds, rateFactor) {
  const rate = Number.isFinite(rateFactor) && rateFactor > 0 ? rateFactor : 1;
  return worldReloadSeconds / rate;
}

// `LocalPlayer::getReloadTime` (LocalPlayer.cxx:1315) walking `shots[]` for an
// empty slot, with the shells replaced by the times their slots come back.
//
// A slot is free once its reload has elapsed since it was *filled*, and nothing
// frees one early: `LocalPlayer` reaps a slot on `isReloaded()` and not on
// `isExpired()`, and bzfs's `removeShot` clears a shot's `running` flag while
// leaving its `expireTime` alone. The slot belongs to the weapon, so a shell
// that stops against a wall a metre away costs exactly what one that flies its
// whole range costs.
//
// Returns the lowest free slot, or -1 when every slot is still reloading.
export function findFreeShotSlot(slotFreeAt, slotCount, now) {
  for (let slot = 0; slot < slotCount; slot++) {
    const freeAt = Number(slotFreeAt?.[slot]);
    if (!Number.isFinite(freeAt) || freeAt <= now) return slot;
  }
  return -1;
}

// How ready a slot is, 0 to 1, for the row of bars beside the control box
// (HUDRenderer.cxx:1988). A slot that was never fired reads full.
export function getShotSlotProgress(slotFreeAt, slot, reloadMs, now) {
  const freeAt = Number(slotFreeAt?.[slot]);
  if (!Number.isFinite(freeAt) || freeAt <= now) return 1;
  if (!(reloadMs > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - ((freeAt - now) / reloadMs)));
}

// The shortest gap bzo puts between two shots fired by two separate pulls of
// the trigger. **Upstream has nothing to copy here.** Its BZDB table
// (global.cxx) has `_reloadTime` and the per-flag `AdRate`/`AdLife` pairs and
// no trigger tuning of any kind, and its own held-trigger behaviour is whatever
// the platform does: `SDL2Display.cxx:544` never checks `event.key.repeat`, so
// a held fire *key* auto-repeats at the operating system's rate while a held
// mouse button fires once.
//
// bzo needs an answer because it has a touch button, an XR trigger and a
// gamepad where upstream has a mouse. This is a floor on the *tap* path only --
// a guard against one press being read twice, or a finger resting on a virtual
// button emptying every slot in three frames. At 100ms it sits at about the
// rate a practised player can click a mouse, so it takes nothing away from a
// deliberate burst and leaves a bzo player no faster than a desktop one.
//
// Client-side only, and deliberately not sent to the server or enforced there:
// a server-side gate this short would compare shots inside the range network
// jitter actually lands in. See the shot slots above for the rule that *is*
// enforced.
export const SHOT_TAP_SPACING_MS = 100;
