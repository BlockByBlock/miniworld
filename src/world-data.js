import worldJson from './data/world.json' with { type: 'json' };

const SECTION_SHAPES = {
  assets: 'object',
  actions: 'object',
  items: 'object',
  enemyProfiles: 'object',
  world: 'object',
  town: 'object',
  rooms: 'array',
  corridors: 'array',
  enemySpawns: 'array',
  chests: 'array',
  player: 'object',
};
const TOP_LEVEL_KEYS = new Set(['version', ...Object.keys(SECTION_SHAPES)]);
const BRANCHES = new Set(['west', 'east', 'north']);
const CHEST_KINDS = new Set(['cache', 'seal', 'archive', 'final']);
const PROFILE_KINDS = new Set(['melee', 'pulse', 'support', 'warden']);
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const BOUND_KEYS = ['minX', 'maxX', 'minZ', 'maxZ'];
const OPENING_DIRECTIONS = new Set(['north', 'south', 'east', 'west']);
const REQUIRED_ROOM_IDS = ['entrance', 'hub', 'westOssuary', 'eastReliquary', 'northLibrary', 'wardenKeep'];
const RESERVED_CHESTS = {
  'west-seal': { kind: 'seal', roomId: 'westOssuary', branch: 'west' },
  'east-seal': { kind: 'seal', roomId: 'eastReliquary', branch: 'east' },
  'archive-key': { kind: 'archive', roomId: 'northLibrary', branch: null },
  'warden-spoils': { kind: 'final', roomId: 'wardenKeep', branch: null },
};
const REQUIRED_CHEST_IDS = Object.keys(RESERVED_CHESTS);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function createFailureCollector() {
  const failures = [];
  return {
    add(path, reason) {
      failures.push(`${path}: ${reason}`);
    },
    throwIfAny() {
      if (failures.length > 0) throw new Error(failures.join('\n'));
    },
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateBounds(path, bounds, errors) {
  if (!isRecord(bounds)) {
    errors.add(path, 'expected an object with minX, maxX, minZ, and maxZ');
    return false;
  }
  let valid = true;
  for (const key of BOUND_KEYS) {
    if (!isFiniteNumber(bounds[key])) {
      errors.add(`${path}.${key}`, 'expected a finite number');
      valid = false;
    }
  }
  if (valid && bounds.maxX <= bounds.minX) {
    errors.add(path, 'maxX must be greater than minX');
    valid = false;
  }
  if (valid && bounds.maxZ <= bounds.minZ) {
    errors.add(path, 'maxZ must be greater than minZ');
    valid = false;
  }
  return valid;
}

function validatePosition(path, position, errors) {
  if (!Array.isArray(position) || position.length !== 2) {
    errors.add(path, 'expected a two-element position');
    return false;
  }
  let valid = true;
  for (const [index, value] of position.entries()) {
    if (!isFiniteNumber(value)) {
      errors.add(`${path}[${index}]`, 'expected a finite number');
      valid = false;
    }
  }
  return valid;
}

function validatePositiveNumber(path, value, errors) {
  if (!isFiniteNumber(value) || value <= 0) {
    errors.add(path, 'expected a positive finite number');
    return false;
  }
  return true;
}

function validateUniqueIds(sectionName, records, errors) {
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const path = `${sectionName}[${index}]`;
    if (!isRecord(record)) {
      errors.add(path, 'expected an object');
      continue;
    }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      errors.add(`${path}.id`, 'expected a non-empty string');
      continue;
    }
    if (seen.has(record.id)) errors.add(`${path}.id`, `duplicate id ${record.id}`);
    seen.add(record.id);
  }
}

function validateRooms(rooms, errors) {
  for (const [index, room] of rooms.entries()) {
    if (!isRecord(room)) continue;
    const path = `rooms[${index}]`;
    validateBounds(`${path}.bounds`, room.bounds, errors);
    if (room.branch !== null && room.branch !== undefined && !BRANCHES.has(room.branch)) {
      errors.add(`${path}.branch`, 'must be null or west, east, or north');
    }
    if (!isRecord(room.openings)) {
      errors.add(`${path}.openings`, 'expected an object');
      continue;
    }
    for (const [direction, intervals] of Object.entries(room.openings)) {
      const openingPath = `${path}.openings.${direction}`;
      if (!OPENING_DIRECTIONS.has(direction)) {
        errors.add(openingPath, 'unknown wall direction');
        continue;
      }
      if (!Array.isArray(intervals)) {
        errors.add(openingPath, 'expected an array of intervals');
        continue;
      }
      const bounds = room.bounds;
      const min = direction === 'east' || direction === 'west' ? bounds?.minZ : bounds?.minX;
      const max = direction === 'east' || direction === 'west' ? bounds?.maxZ : bounds?.maxX;
      for (const [intervalIndex, interval] of intervals.entries()) {
        const intervalPath = `${openingPath}[${intervalIndex}]`;
        if (!Array.isArray(interval) || interval.length !== 2) {
          errors.add(intervalPath, 'expected a two-element interval');
          continue;
        }
        if (!isFiniteNumber(interval[0]) || !isFiniteNumber(interval[1])) {
          errors.add(intervalPath, 'expected finite interval endpoints');
          continue;
        }
        if (interval[1] <= interval[0]) errors.add(intervalPath, 'end must be greater than start');
        if (isFiniteNumber(min) && isFiniteNumber(max) && (interval[0] < min || interval[1] > max)) {
          errors.add(intervalPath, 'must stay within the room wall span');
        }
      }
    }
  }
}

function validateCorridors(corridors, roomsById, errors) {
  for (const [index, corridor] of corridors.entries()) {
    if (!isRecord(corridor)) continue;
    const path = `corridors[${index}]`;
    const boundsValid = validateBounds(`${path}.bounds`, corridor.bounds, errors);
    if (!Array.isArray(corridor.connects) || corridor.connects.length !== 2) {
      errors.add(`${path}.connects`, 'must contain exactly two room IDs');
      continue;
    }
    const [firstId, secondId] = corridor.connects;
    if (firstId === secondId) errors.add(`${path}.connects`, 'must reference two distinct rooms');
    const connectedRooms = corridor.connects.map((roomId, roomIndex) => {
      if (typeof roomId !== 'string' || !roomsById.has(roomId)) {
        errors.add(`${path}.connects[${roomIndex}]`, `unknown room ${roomId}`);
        return null;
      }
      return roomsById.get(roomId);
    });
    if (!boundsValid || connectedRooms.some((room) => room === null)) continue;
    const geometricNeighbors = [...roomsById.values()]
      .filter((room) => isRecord(room.bounds) && BOUND_KEYS.every((key) => isFiniteNumber(room.bounds[key])))
      .filter((room) => {
        const overlapX = Math.min(corridor.bounds.maxX, room.bounds.maxX)
          - Math.max(corridor.bounds.minX, room.bounds.minX);
        const overlapZ = Math.min(corridor.bounds.maxZ, room.bounds.maxZ)
          - Math.max(corridor.bounds.minZ, room.bounds.minZ);
        return overlapX >= -0.05 && overlapZ >= -0.05 && (overlapX > 0.5 || overlapZ > 0.5);
      })
      .map((room) => room.id)
      .sort();
    const declaredNeighbors = [...new Set(corridor.connects)].sort();
    if (declaredNeighbors.length !== geometricNeighbors.length
      || declaredNeighbors.some((roomId, roomIndex) => roomId !== geometricNeighbors[roomIndex])) {
      errors.add(`${path}.connects`, `must match geometric room neighbors (${geometricNeighbors.join(', ') || 'none'})`);
    }
  }
}

function validateActions(actions, errors) {
  for (const [id, action] of Object.entries(actions)) {
    const path = `actions.${id}`;
    if (!isRecord(action)) {
      errors.add(path, 'expected an object');
      continue;
    }
    if (typeof action.name !== 'string' || action.name.length === 0) errors.add(`${path}.name`, 'expected a non-empty string');
    validatePositiveNumber(`${path}.cooldown`, action.cooldown, errors);
    if (!isFiniteNumber(action.range) || action.range < 0) errors.add(`${path}.range`, 'expected a non-negative finite number');
    if (!Array.isArray(action.keys) || action.keys.length === 0) {
      errors.add(`${path}.keys`, 'expected a non-empty array');
    } else {
      const keys = new Set();
      for (const [index, key] of action.keys.entries()) {
        if (typeof key !== 'string' || key.length === 0) errors.add(`${path}.keys[${index}]`, 'expected a non-empty string');
        else if (keys.has(key)) errors.add(`${path}.keys[${index}]`, `duplicate key ${key}`);
        keys.add(key);
      }
    }
    if (action.spellColor !== undefined && (typeof action.spellColor !== 'string' || !COLOR_PATTERN.test(action.spellColor))) {
      errors.add(`${path}.spellColor`, 'expected a #rrggbb color');
    }
    if (action.castTime !== undefined) validatePositiveNumber(`${path}.castTime`, action.castTime, errors);
  }
}

function validateItems(items, actions, errors) {
  for (const [id, item] of Object.entries(items)) {
    const path = `items.${id}`;
    if (!isRecord(item)) {
      errors.add(path, 'expected an object');
      continue;
    }
    for (const field of ['name', 'kind', 'rarity', 'glyph', 'description']) {
      if (typeof item[field] !== 'string' || item[field].length === 0) errors.add(`${path}.${field}`, 'expected a non-empty string');
    }
    if (typeof item.color !== 'string' || !COLOR_PATTERN.test(item.color)) errors.add(`${path}.color`, 'expected a #rrggbb color');
    for (const field of ['damage', 'cooldown']) {
      if (item[field] === undefined) continue;
      if (!isRecord(item[field])) {
        errors.add(`${path}.${field}`, 'expected an object');
        continue;
      }
      for (const [actionId, multiplier] of Object.entries(item[field])) {
        if (!hasOwn(actions, actionId)) errors.add(`${path}.${field}.${actionId}`, `unknown action ${actionId}`);
        validatePositiveNumber(`${path}.${field}.${actionId}`, multiplier, errors);
      }
    }
  }
}

function validateEnemyProfiles(profiles, errors) {
  for (const [id, profile] of Object.entries(profiles)) {
    const path = `enemyProfiles.${id}`;
    if (!isRecord(profile)) {
      errors.add(path, 'expected an object');
      continue;
    }
    if (!PROFILE_KINDS.has(profile.kind)) errors.add(`${path}.kind`, 'must be melee, pulse, support, or warden');
    for (const field of ['damage', 'desiredRange', 'attackRange', 'attackCooldown', 'windup', 'leash', 'maxHp', 'speed', 'height']) {
      validatePositiveNumber(`${path}.${field}`, profile[field], errors);
    }
    for (const field of ['chaseMult', 'radius', 'heal', 'slamCooldown']) {
      if (profile[field] !== undefined) validatePositiveNumber(`${path}.${field}`, profile[field], errors);
    }
  }
}

function validateAssetReferences(assets, assetPaths, errors) {
  for (const [id, assetPath] of Object.entries(assets)) {
    const path = `assets.${id}`;
    if (typeof assetPath !== 'string' || !assetPath.startsWith('/assets/') || assetPath.includes('..')) {
      errors.add(path, 'path must start with /assets/ and contain no ..');
      continue;
    }
    if (assetPaths !== undefined && !assetPaths.has(assetPath)) errors.add(path, `path does not exist: ${assetPath}`);
  }
}

function validateActorRecord(path, record, assets, errors) {
  if (!isRecord(record)) {
    errors.add(path, 'expected an object');
    return;
  }
  if (typeof record.assetKey !== 'string' || !hasOwn(assets, record.assetKey)) errors.add(`${path}.assetKey`, `unknown asset ${record.assetKey}`);
  validatePosition(`${path}.position`, record.position, errors);
  validatePositiveNumber(`${path}.height`, record.height, errors);
}

function validateWorldDataInternal(raw, options, errors) {
  if (!isRecord(raw)) {
    errors.add('world', 'expected an object');
    return;
  }
  if (raw.version !== 1) errors.add('version', 'must equal 1');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.add(key, 'unknown top-level section');
  }
  for (const [section, shape] of Object.entries(SECTION_SHAPES)) {
    if (!hasOwn(raw, section)) {
      errors.add(section, 'is required');
      continue;
    }
    const validShape = shape === 'array' ? Array.isArray(raw[section]) : isRecord(raw[section]);
    if (!validShape) errors.add(section, `expected an ${shape}`);
  }

  const assets = isRecord(raw.assets) ? raw.assets : {};
  const actions = isRecord(raw.actions) ? raw.actions : {};
  const items = isRecord(raw.items) ? raw.items : {};
  const profiles = isRecord(raw.enemyProfiles) ? raw.enemyProfiles : {};
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  const corridors = Array.isArray(raw.corridors) ? raw.corridors : [];
  const enemySpawns = Array.isArray(raw.enemySpawns) ? raw.enemySpawns : [];
  const chests = Array.isArray(raw.chests) ? raw.chests : [];
  const town = isRecord(raw.town) ? raw.town : null;
  const placements = town?.placements;
  const npcs = town?.npcs;

  validateUniqueIds('rooms', rooms, errors);
  validateUniqueIds('corridors', corridors, errors);
  validateUniqueIds('enemySpawns', enemySpawns, errors);
  validateUniqueIds('chests', chests, errors);

  validateActions(actions, errors);
  validateItems(items, actions, errors);
  validateEnemyProfiles(profiles, errors);
  validateBounds('world', raw.world, errors);
  if (isRecord(raw.town)) validateBounds('town.bounds', town.bounds, errors);
  if (!Array.isArray(placements)) errors.add('town.placements', 'expected an array');
  if (!Array.isArray(npcs)) errors.add('town.npcs', 'expected an array');
  validateRooms(rooms, errors);
  const roomsById = new Map(rooms.filter(isRecord).filter((room) => typeof room.id === 'string').map((room) => [room.id, room]));
  validateCorridors(corridors, roomsById, errors);

  for (const [index, spawn] of enemySpawns.entries()) {
    const path = `enemySpawns[${index}]`;
    validateActorRecord(path, spawn, assets, errors);
    if (!isRecord(spawn)) continue;
    if (typeof spawn.profileKey !== 'string' || !hasOwn(profiles, spawn.profileKey)) errors.add(`${path}.profileKey`, `unknown profile ${spawn.profileKey}`);
    if (typeof spawn.roomId !== 'string' || !roomsById.has(spawn.roomId)) errors.add(`${path}.roomId`, `unknown room ${spawn.roomId}`);
    for (const field of ['maxHp', 'speed']) validatePositiveNumber(`${path}.${field}`, spawn[field], errors);
  }

  const chestRoomIds = new Set(roomsById.keys());
  for (const [index, chest] of chests.entries()) {
    const path = `chests[${index}]`;
    if (!isRecord(chest)) continue;
    if (typeof chest.name !== 'string' || chest.name.length === 0) errors.add(`${path}.name`, 'expected a non-empty string');
    validatePosition(`${path}.position`, chest.position, errors);
    if (typeof chest.roomId !== 'string' || !chestRoomIds.has(chest.roomId)) errors.add(`${path}.roomId`, `unknown room ${chest.roomId}`);
    if (!CHEST_KINDS.has(chest.kind)) errors.add(`${path}.kind`, 'must be cache, seal, archive, or final');
    if (chest.branch !== null && chest.branch !== undefined && !BRANCHES.has(chest.branch)) errors.add(`${path}.branch`, 'must be null or west, east, or north');
    if (chest.kind === 'seal' && !['west', 'east'].includes(chest.branch)) errors.add(`${path}.branch`, 'seal chests require a west or east branch');
    if (chest.kind !== 'seal' && chest.branch !== null && chest.branch !== undefined) errors.add(`${path}.branch`, 'only seal chests may have a branch');
  }

  if (Array.isArray(placements)) {
    for (const [index, placement] of placements.entries()) {
      const path = `town.placements[${index}]`;
      validateActorRecord(path, placement, assets, errors);
      if (!isRecord(placement)) continue;
      for (const field of ['width', 'height', 'colliderWidth', 'colliderDepth']) {
        if (placement[field] !== undefined) validatePositiveNumber(`${path}.${field}`, placement[field], errors);
      }
      if (placement.rotationY !== undefined && !isFiniteNumber(placement.rotationY)) errors.add(`${path}.rotationY`, 'expected a finite number');
    }
  }
  if (Array.isArray(npcs)) {
    for (const [index, npc] of npcs.entries()) {
      const path = `town.npcs[${index}]`;
      validateActorRecord(path, npc, assets, errors);
      if (!isRecord(npc)) continue;
      if (typeof npc.name !== 'string' || npc.name.length === 0) errors.add(`${path}.name`, 'expected a non-empty string');
      if (npc.role !== undefined && typeof npc.role !== 'string') errors.add(`${path}.role`, 'expected a string');
      if (npc.patrol !== undefined) {
        if (!isRecord(npc.patrol)) {
          errors.add(`${path}.patrol`, 'expected an object');
        } else {
          if (!Array.isArray(npc.patrol.waypoints) || npc.patrol.waypoints.length < 2) errors.add(`${path}.patrol.waypoints`, 'expected at least two positions');
          else npc.patrol.waypoints.forEach((position, waypointIndex) => validatePosition(`${path}.patrol.waypoints[${waypointIndex}]`, position, errors));
          validatePositiveNumber(`${path}.patrol.speed`, npc.patrol.speed, errors);
          if (!isFiniteNumber(npc.patrol.pause) || npc.patrol.pause < 0) errors.add(`${path}.patrol.pause`, 'expected a non-negative finite number');
        }
      }
    }
  }

  if (isRecord(raw.player)) {
    const playerPath = 'player';
    if (typeof raw.player.assetKey !== 'string' || !hasOwn(assets, raw.player.assetKey)) errors.add(`${playerPath}.assetKey`, `unknown asset ${raw.player.assetKey}`);
    if (!isFiniteNumber(raw.player.x)) errors.add(`${playerPath}.x`, 'expected a finite number');
    if (!isFiniteNumber(raw.player.z)) errors.add(`${playerPath}.z`, 'expected a finite number');
    if (typeof raw.player.name !== 'string' || raw.player.name.length === 0) errors.add(`${playerPath}.name`, 'expected a non-empty string');
    for (const field of ['height', 'maxHp', 'speed']) validatePositiveNumber(`${playerPath}.${field}`, raw.player[field], errors);
  }

  for (const roomId of REQUIRED_ROOM_IDS) if (!roomsById.has(roomId)) errors.add('rooms', `missing progression room ${roomId}`);
  for (const chestId of REQUIRED_CHEST_IDS) {
    const chestIndex = chests.findIndex((chest) => isRecord(chest) && chest.id === chestId);
    if (chestIndex < 0) {
      errors.add('chests', `missing progression chest ${chestId}`);
      continue;
    }
    const chest = chests[chestIndex];
    const expected = RESERVED_CHESTS[chestId];
    for (const field of ['kind', 'roomId', 'branch']) {
      if (chest[field] !== expected[field]) {
        errors.add(`chests[${chestIndex}] (${chestId}).${field}`, `must equal ${expected[field] ?? 'null'} for reserved progression chest ${chestId}`);
      }
    }
  }

  const assetPaths = options?.assetPaths;
  if (assetPaths !== undefined && !(assetPaths instanceof Set)) errors.add('options.assetPaths', 'expected a Set when supplied');
  validateAssetReferences(assets, assetPaths instanceof Set ? assetPaths : undefined, errors);
}

export function validateWorldData(raw, options = {}) {
  const errors = createFailureCollector();
  validateWorldDataInternal(raw, options, errors);
  errors.throwIfAny();
}

function normalizeBounds(record) {
  const { bounds, ...rest } = record;
  return { ...rest, ...bounds };
}

export function loadWorldData(raw) {
  validateWorldData(raw);
  const rooms = raw.rooms.map(normalizeBounds);
  const corridors = raw.corridors.map(normalizeBounds);
  const map = { rooms, corridors };
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const corridorById = new Map(corridors.map((corridor) => [corridor.id, corridor]));
  const roomBranch = Object.fromEntries(raw.rooms
    .filter((room) => room.branch !== null && room.branch !== undefined)
    .map((room) => [room.id, room.branch]));
  return {
    ...raw,
    raw,
    rooms,
    corridors,
    map,
    roomById,
    corridorById,
    roomBranch,
  };
}

export const WORLD_DATA = loadWorldData(worldJson);
