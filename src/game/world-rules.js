// Pure gameplay rules shared by the rendered game (src/main.js) and the
// headless simulation (src/game/game-core.js). No THREE, no DOM, no timers:
// callers pass in plain data and counts, these functions return decisions.
// Keeping one definition here is what guarantees the headless run exercises
// the same rules as the rendered game.

export const EXIT_POSITION = { x: 0, z: 32.4 };
export const EXIT_RADIUS = 2.4;
export const DUNGEON_ENTRANCE = { x: 0, z: 26.8 };
export const ROOM_ENTRY_CLEARANCE = 1.1;
export const HEAL_FRACTION = 0.3;
export const CONSUMABLE_HEAL = 30;

// Interaction reach per target kind, shared so both surfaces agree.
export const INTERACT_RADII = { npc: 2.45, loot: 1.9, chest: 2.1, gate: 2.4 };

// --- Gates ---------------------------------------------------------------

export function hasBranchSeals(seals) {
  return seals.west && seals.east;
}

export function evaluateGateOpen({
  gate, currentRoomId, livingInRoomCount, crossing, seals, archiveKey,
}) {
  if (!gate || gate.open) return { ok: false, code: 'unavailable', message: '' };
  if (!gate.roomIds.includes(currentRoomId)) return { ok: false, code: 'wrong-room', message: '' };
  if (crossing) {
    return { ok: false, code: 'crossing', message: 'Finish crossing before opening another gate.' };
  }
  if (livingInRoomCount > 0) {
    return {
      ok: false,
      code: 'warded',
      message: `The gate is sealed by ${livingInRoomCount} remaining guardian${livingInRoomCount === 1 ? '' : 's'}.`,
    };
  }
  if (gate.corridorId === 'north-corridor' && currentRoomId === 'hub' && !hasBranchSeals(seals)) {
    return { ok: false, code: 'seals-required', message: 'Claim both branch seals to open the northern way.' };
  }
  if (gate.corridorId === 'warden-corridor' && currentRoomId === 'northLibrary' && !archiveKey) {
    return { ok: false, code: 'archive-key-required', message: 'The Archive key opens the Warden’s Keep.' };
  }
  return { ok: true, code: 'opened', message: '' };
}

export function gateTravelsAlongZ(first, second) {
  return Math.abs(first.minZ + first.maxZ - second.minZ - second.maxZ)
    > Math.abs(first.minX + first.maxX - second.minX - second.maxX);
}

// Both adapters interact with the doorway on the current room's wall.
export function gateWallPosition(corridor, room, travelsAlongZ) {
  const x = (corridor.minX + corridor.maxX) / 2;
  const z = (corridor.minZ + corridor.maxZ) / 2;
  return {
    x: travelsAlongZ ? x : (room.minX + room.maxX) / 2 < x ? room.maxX : room.minX,
    z: travelsAlongZ ? (room.minZ + room.maxZ) / 2 < z ? room.maxZ : room.minZ : z,
  };
}

export function gateCrossing({ x, z, room, gates, zoneById }) {
  const gate = gates.find((candidate) => candidate.open && candidate.fromRoomId === room.id);
  return Boolean(gate && zoneContains(zoneById.get(gate.corridorId), x, z, -ROOM_ENTRY_CLEARANCE)
    && !zoneContains(room, x, z, ROOM_ENTRY_CLEARANCE));
}

export function applyGateOpen(gates, gate, currentRoomId) {
  // Preserve old endpoints for the rendered doorway frames before closing.
  const closed = gates.filter((other) => other.open).map((other) => ({
    gate: other, fromRoomId: other.fromRoomId, toRoomId: other.toRoomId,
  }));
  for (const { gate: other } of closed) {
    other.open = false;
    other.fromRoomId = null;
    other.toRoomId = null;
  }
  gate.open = true;
  gate.fromRoomId = currentRoomId;
  gate.toRoomId = gate.roomIds.find((id) => id !== currentRoomId) ?? null;
  return closed;
}

// --- Chests --------------------------------------------------------------

// Resolve the warding population here so callers cannot drop scope rules.
export function evaluateChestBlock({ chest, enemies, roomBranch }) {
  if (!chest || chest.opened) return '';
  const guardians = enemies.filter((enemy) => !enemy.dead);
  if (chest.kind === 'seal') {
    const count = guardians.filter((enemy) => roomBranch[enemy.roomId] === chest.branch).length;
    if (count > 0) {
      return `The ${chest.branch}ern seal remains warded by ${count} guardian${count === 1 ? '' : 's'}.`;
    }
  }
  if (chest.kind === 'archive' && guardians.some((enemy) => isArchiveGuardian(enemy, roomBranch))) {
    return 'The Archive cache remains sealed while its acolytes stand.';
  }
  if ((chest.kind === 'final' || chest.kind === 'cache')
    && guardians.some((enemy) => enemy.roomId === chest.roomId)) {
    return chest.kind === 'final'
      ? 'The Warden\'s reliquary is still bound to the living dead.'
      : 'Clear this chamber before opening its cache.';
  }
  return '';
}

export function isArchiveGuardian(enemy, roomBranch) {
  return roomBranch[enemy.roomId] === 'north' && enemy.roomId !== 'wardenKeep';
}

// Mutates plain progression state exactly as openChest() does; returns a
// summary so callers can layer presentation (text/audio/effects) on top.
export function applyChestRewards(stateLike, chest, actionKeys) {
  stateLike.openedChests += 1;
  const summary = { kind: chest.kind ?? 'cache', healed: 0, cooldownRefresh: 0 };
  if (chest.kind === 'seal') {
    stateLike.seals[chest.branch] = true;
    summary.healed = 25;
  } else if (chest.kind === 'archive') {
    stateLike.archiveKey = true;
  } else if (chest.kind !== 'final') {
    summary.healed = 12;
    summary.cooldownRefresh = 1.5;
  }
  if (summary.healed > 0) {
    stateLike.playerHp = Math.min(stateLike.playerMaxHp, stateLike.playerHp + summary.healed);
  }
  if (summary.cooldownRefresh > 0) {
    for (const action of actionKeys) {
      stateLike.actionCooldowns[action] = Math.max(0, stateLike.actionCooldowns[action] - summary.cooldownRefresh);
    }
  }
  return summary;
}

// --- Loot ----------------------------------------------------------------

export function lootItemForProfile(profileKey) {
  if (profileKey === 'warden') return 'wardenRelic';
  if (profileKey === 'support') return 'emberCharm';
  if (profileKey === 'pulser') return 'frostRune';
  if (profileKey === 'guard') return 'ossuaryEdge';
  return 'healingDraft';
}

// --- World geometry -------------------------------------------------------

// Geometric zone adjacency used at build time by the rendered game and on
// every run by the headless core. Zones are neighbors when their bounds
// overlap on both axes past a small epsilon.
export function computeZoneNeighbors(zones) {
  return new Map(zones.map((zone) => {
    const neighbors = zones
      .filter((candidate) => candidate !== zone)
      .filter((candidate) => {
        const overlapX = Math.min(zone.maxX, candidate.maxX) - Math.max(zone.minX, candidate.minX);
        const overlapZ = Math.min(zone.maxZ, candidate.maxZ) - Math.max(zone.minZ, candidate.minZ);
        return overlapX >= -0.05 && overlapZ >= -0.05 && (overlapX > 0.5 || overlapZ > 0.5);
      })
      .map((candidate) => candidate.id);
    return [zone.id, neighbors];
  }));
}

export function playerDamage(baseDamage, { buffed = false, itemMultiplier = 1 } = {}) {
  return Math.round(baseDamage * (buffed ? 1.4 : 1) * itemMultiplier);
}

// Base damage per action/target mirroring applyPlayerAction() and the spell
// impact rules. `warden` targets take reduced damage.
export function attackDamage(action, targetProfileKey) {
  const warden = targetProfileKey === 'warden';
  switch (action) {
    case 'sword': return warden ? 16 : 22;
    case 'fire': return warden ? 24 : 34;
    case 'freeze': return warden ? 7 : 10;
    default: return 0;
  }
}

// --- Run objectives / win condition --------------------------------------

export function runObjectivesComplete({ seals, archiveKey, wardenSpoilsOpened, livingEnemyCount }) {
  return hasBranchSeals(seals) && archiveKey && Boolean(wardenSpoilsOpened) && livingEnemyCount === 0;
}

// --- Zone geometry ---------------------------------------------------------

export function zoneContains(zone, x, z, inset = 0) {
  return x >= zone.minX + inset && x <= zone.maxX - inset
    && z >= zone.minZ + inset && z <= zone.maxZ - inset;
}

// `zones` must be ordered rooms-before-corridors so room priority is
// preserved when scanning.
export function findRoomAt(rooms, x, z, inset = 0) {
  return rooms.find((room) => zoneContains(room, x, z, inset)) ?? null;
}

export function findZoneAt(zones, x, z) {
  return zones.find((zone) => zoneContains(zone, x, z)) ?? null;
}

// --- Zone visibility / room transitions -----------------------------------

// Zones currently rendered/active for a room: the room itself plus its
// non-room neighbors, plus every open gate and the rooms it connects.
export function visibleZoneIdsFor({ currentRoomId, neighborIdsByZone, gates, isRoom }) {
  const visible = new Set([currentRoomId]);
  for (const neighborId of neighborIdsByZone.get(currentRoomId) ?? []) {
    if (!isRoom(neighborId)) visible.add(neighborId);
  }
  for (const gate of gates) {
    if (!gate.open) continue;
    visible.add(gate.corridorId);
    gate.roomIds.forEach((id) => visible.add(id));
  }
  return [...visible];
}

// Pure room-transition decision used by updateProgression() on both sides.
// Returns which room (if any) the actor fully entered at (x, z) given the
// entry clearance, and which traversed gate should close as a consequence.
export function resolveRoomEntry({ x, z, rooms, currentRoomId, gates, clearance = 0 }) {
  const room = findRoomAt(rooms, x, z, clearance);
  if (!room || room.id === currentRoomId) return { entered: false };
  return {
    entered: true,
    roomId: room.id,
    label: room.label ?? null,
    traversedGate: gates.find((gate) => (
      gate.open && gate.fromRoomId === currentRoomId && gate.toRoomId === room.id
    )) ?? null,
  };
}


export function isRunVictory({ objectivesComplete, distanceToExit }) {
  return objectivesComplete && distanceToExit < EXIT_RADIUS;
}
