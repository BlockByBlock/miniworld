// Browser checkpoint persistence for the rendered client. The client captures
// and applies checkpoints; this module only validates and stores them, so a
// malformed or stale save is discarded whole rather than half-applied.

import { zoneContains } from './game/world-rules.js';
import { isFiniteNumber } from './world-data.js';

export const CHECKPOINT_KEY = 'forgotten-crypt:checkpoint';
export const CHECKPOINT_VERSION = 1;

export function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isBoolean = (value) => typeof value === 'boolean';
const everyIn = (values, allowed) => Array.isArray(values) && values.every((value) => allowed.has(value));

export function isValidCheckpoint(value, world) {
  if (!value || typeof value !== 'object' || value.version !== CHECKPOINT_VERSION) return false;
  const roomIds = new Set(world.map.rooms.map((room) => room.id));
  const corridorIds = new Set(world.map.corridors.map((corridor) => corridor.id));
  const chestIds = new Set(world.chests.map((chest) => chest.id));
  const spawnIds = new Set(world.enemySpawns.map((spawn) => spawn.id));
  const itemIds = new Set(Object.keys(world.items));
  const { inventory, equippedSlot } = value;
  const room = world.map.rooms.find((candidate) => candidate.id === value.roomId);
  // A room-entry position outside its room (for example after the layout
  // changed) would strand the player, so the whole save is discarded.
  return Boolean(room)
    && isFiniteNumber(value.position?.x)
    && isFiniteNumber(value.position?.z)
    && zoneContains(room, value.position.x, value.position.z)
    && everyIn(value.discoveredRooms, roomIds)
    && isFiniteNumber(value.playerHp)
    && value.playerHp > 0
    && Array.isArray(inventory)
    && inventory.every((itemId) => itemId === null || itemIds.has(itemId))
    && (equippedSlot === null
      || (Number.isInteger(equippedSlot) && world.items[inventory[equippedSlot]]?.kind === 'equipment'))
    && isBoolean(value.seals?.west)
    && isBoolean(value.seals?.east)
    && isBoolean(value.archiveKey)
    && everyIn(value.openedChests, chestIds)
    && everyIn(value.deadEnemies, spawnIds)
    && Array.isArray(value.loot)
    && value.loot.every((drop) => itemIds.has(drop?.itemId) && isFiniteNumber(drop.x) && isFiniteNumber(drop.z))
    && Array.isArray(value.gates)
    && value.gates.every((gate) => corridorIds.has(gate?.corridorId)
      && roomIds.has(gate.wallRoomId)
      && everyIn(gate.visibleFrames, roomIds));
}

export function readCheckpoint(storage, world) {
  try {
    const value = JSON.parse(storage?.getItem(CHECKPOINT_KEY) ?? 'null');
    return isValidCheckpoint(value, world) ? value : null;
  } catch {
    return null;
  }
}

export function writeCheckpoint(storage, checkpoint) {
  try {
    storage?.setItem(CHECKPOINT_KEY, JSON.stringify({ ...checkpoint, version: CHECKPOINT_VERSION }));
  } catch {
    // Storage can be full, blocked, or unavailable; the run continues unsaved.
  }
}

export function clearCheckpoint(storage) {
  try {
    storage?.removeItem(CHECKPOINT_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
