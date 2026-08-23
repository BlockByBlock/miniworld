// Pure gameplay rules shared by the rendered game (src/main.js) and the
// headless simulation (src/game/game-core.js). No THREE, no DOM, no timers:
// callers pass in plain data and counts, these functions return decisions.
// Keeping one definition here is what guarantees the headless run exercises
// the same rules as the rendered game.

export const EXIT_POSITION = { x: 0, z: 32.4 };
export const EXIT_RADIUS = 2.4;
export const HEAL_FRACTION = 0.3;

// Interaction reach per target kind, shared so both surfaces agree.
export const INTERACT_RADII = { npc: 2.45, loot: 1.9, chest: 2.1, gate: 2.4 };

// --- Gates ---------------------------------------------------------------

// Mirrors openGate(): a gate opens only from one of its two rooms and only
// once that room holds no living guardians.
export function evaluateGateOpen({ gate, currentRoomId, livingInRoomCount }) {
  if (!gate || gate.open) return { ok: false, reason: '' };
  if (!gate.roomIds.includes(currentRoomId)) return { ok: false, reason: '' };
  if (livingInRoomCount > 0) {
    return {
      ok: false,
      reason: `The gate is sealed by ${livingInRoomCount} remaining guardian${livingInRoomCount === 1 ? '' : 's'}.`,
    };
  }
  return { ok: true, reason: '' };
}

// --- Chests --------------------------------------------------------------
// Mirrors chestBlockReason(): the caller resolves the relevant living-enemy
// count for the chest kind, this only turns it into a display reason.
export function evaluateChestBlock({ chest, guardianCount = 0 }) {
  if (!chest || chest.opened) return '';
  if (chest.kind === 'seal' && guardianCount > 0) {
    return `The ${chest.branch}ern seal remains warded by ${guardianCount} guardian${guardianCount === 1 ? '' : 's'}.`;
  }
  if (chest.kind === 'archive' && guardianCount > 0) {
    return 'The Archive cache remains sealed while its acolytes stand.';
  }
  if (chest.kind === 'final' && guardianCount > 0) {
    return 'The Warden\'s reliquary is still bound to the living dead.';
  }
  if (chest.kind === 'cache' && guardianCount > 0) {
    return 'Clear this chamber before opening its cache.';
  }
  return '';
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
  } else if (chest.kind === 'final') {
    // The relic itself grants nothing; it enables the return to the exit.
  } else {
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

export function runObjectivesComplete({ wardenSpoilsOpened, livingEnemyCount }) {
  return Boolean(wardenSpoilsOpened) && livingEnemyCount === 0;
}

export function isRunVictory({ objectivesComplete, distanceToExit }) {
  return objectivesComplete && distanceToExit < EXIT_RADIUS;
}
