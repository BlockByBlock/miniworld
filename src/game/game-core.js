// Headless simulation of Forgotten Crypt.
//
// The same rules that drive the rendered game (src/main.js) run here on
// plain JavaScript state: no THREE, no DOM, no audio, no rAF, no setTimeout.
// Time passes only when the caller calls tick(delta); randomness comes from
// an injectable seeded RNG; the world definition is injectable too.
//
// Agents and tests drive the simulation through semantic actions
// (talkTo / moveTo / interact / openGate / useAction) instead of keyboard,
// mouse, or physical traversal, and read structured state through describe().
// saveCheckpoint/loadCheckpoint give controlled start states mid-run.

import { WORLD_DATA } from '../world-data.js';
import { createRng } from './rng.js';
import {
  createNavigationContext,
  isWalkablePoint,
  stepActorWithinMap,
} from '../movement-contracts.js';
import {
  EXIT_POSITION,
  EXIT_RADIUS,
  HEAL_FRACTION,
  applyChestRewards,
  attackDamage,
  evaluateChestBlock,
  evaluateGateOpen,
  isRunVictory,
  lootItemForProfile,
  playerDamage,
  runObjectivesComplete,
} from './world-rules.js';

const INTERACT_RADII = { npc: 2.45, loot: 1.9, chest: 2.1, gate: 2.4 };
const MOVE_ARRIVE_DISTANCE = 0.35;
const MOVE_TICK_SECONDS = 0.1;

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createGameCore({
  seed = 1,
  worldData = WORLD_DATA,
  colliders = [],
} = {}) {
  const rng = createRng(seed);
  const currentSeed = seed;
  const map = worldData.map;
  const zones = [...map.rooms, ...map.corridors];
  const corridorZoneIds = new Set(map.corridors);
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const roomIds = new Set(map.rooms.map((room) => room.id));
  const roomBranch = worldData.roomBranch;

  // Geometric zone adjacency, identical to the rendered game's build-time
  // computation in main.js.
  const zoneNeighbors = new Map(zones.map((zone) => {
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

  // Navmesh-level walkability: zone bounds plus corridor clearance, without
  // furniture colliders (those are presentation-layer obstacles). Scenarios
  // that need solid obstacles can inject colliders ({minX..maxZ, visible}).
  const navigation = createNavigationContext({
    getMode: () => state.mode,
    townBounds: worldData.town.bounds,
    worldBounds: worldData.world,
    mapZones: zones,
    corridorZoneIds,
    staticColliders: colliders,
    townStaticColliders: [],
  });

  const actions = Object.fromEntries(Object.entries(worldData.actions)
    .map(([id, action]) => [id, { cooldown: action.cooldown, range: action.range }]));
  const actionKeys = Object.keys(actions);

  let events = [];
  const record = (type, payload = {}) => {
    events.push({ t: Number(state.elapsed.toFixed(3)), type, ...payload });
    if (events.length > 400) events = events.slice(-300);
  };

  function makeState() {
    return {
      mode: 'town',
      started: false,
      combatStarted: false,
      finished: false,
      failed: false,
      playerHp: worldData.player.maxHp,
      playerMaxHp: worldData.player.maxHp,
      playerBuffTimer: 0,
      actionCooldowns: Object.fromEntries(actionKeys.map((key) => [key, 0])),
      seals: { west: false, east: false },
      archiveKey: false,
      discoveredRooms: ['entrance'],
      currentRoomId: 'entrance',
      currentZoneId: null,
      openedChests: 0,
      inventory: Array(6).fill(null),
      equippedSlot: null,
      interactionCount: 0,
      lastInteraction: null,
      elapsed: 0,
      trailTimer: 0,
      playerX: worldData.player.x,
      playerZ: worldData.player.z,
      enemies: worldData.enemySpawns.map((spawn) => ({
        id: spawn.id,
        name: spawn.name,
        profileKey: spawn.profileKey,
        roomId: spawn.roomId,
        x: spawn.position[0],
        z: spawn.position[1],
        hp: spawn.maxHp,
        maxHp: spawn.maxHp,
        dead: false,
        lootDropped: false,
      })),
      gates: map.corridors.map((corridor) => ({
        id: `${corridor.id}-gate`,
        corridorId: corridor.id,
        roomIds: [...corridor.connects],
        open: false,
        fromRoomId: null,
        toRoomId: null,
      })),
      chests: worldData.chests.map((chest) => ({
        id: chest.id,
        kind: chest.kind,
        branch: chest.branch ?? null,
        roomId: chest.roomId,
        x: chest.position[0],
        z: chest.position[1],
        opened: false,
      })),
      loot: [],
      visibleZoneIds: ['entrance'],
    };
  }

  const state = makeState();

  // --- queries ---------------------------------------------------------------

  function livingEnemiesInRoom(roomId) {
    return state.enemies.filter((enemy) => !enemy.dead && enemy.roomId === roomId);
  }
  function livingEnemiesInBranch(branch, { includeWarden = true } = {}) {
    return state.enemies.filter((enemy) => (
      !enemy.dead
      && roomBranch[enemy.roomId] === branch
      && (includeWarden || enemy.profileKey !== 'warden')
    ));
  }
  const livingEnemyCount = () => state.enemies.filter((enemy) => !enemy.dead).length;

  function containsPosition(zone, x, z, inset = 0) {
    return x >= zone.minX + inset && x <= zone.maxX - inset
      && z >= zone.minZ + inset && z <= zone.maxZ - inset;
  }
  const roomAtPosition = (x, z, inset = 0) => map.rooms.find(
    (room) => containsPosition(room, x, z, inset),
  ) ?? null;
  const zoneAtPosition = (x, z) => roomAtPosition(x, z)
    ?? map.corridors.find((corridor) => containsPosition(corridor, x, z))
    ?? null;

  function isWalkable(x, z, padding = 0.55) {
    return isWalkablePoint({ x, z, padding, navigation });
  }

  function recomputeVisibleZones() {
    const nextVisible = new Set([state.currentRoomId]);
    for (const neighborId of zoneNeighbors.get(state.currentRoomId) ?? []) {
      if (!roomIds.has(neighborId)) nextVisible.add(neighborId);
    }
    for (const gate of state.gates) {
      if (!gate.open) continue;
      nextVisible.add(gate.corridorId);
      gate.roomIds.forEach((id) => nextVisible.add(id));
    }
    state.visibleZoneIds = [...nextVisible];
  }

  const enemyAccessible = (enemy) => state.visibleZoneIds.includes(enemy.roomId);
  const chestById = (id) => state.chests.find((chest) => chest.id === id) ?? null;
  const gateByCorridor = (corridorId) => state.gates.find((gate) => gate.corridorId === corridorId) ?? null;


  // --- internal transitions ----------------------------------------------------

  function enterDungeon() {
    if (state.mode === 'dungeon') return;
    state.mode = 'dungeon';
    // Mirrors the rendered trail: the actor always arrives at the entrance
    // vault door, regardless of where they stood in Ravenrest.
    state.playerX = 0;
    state.playerZ = 26.8;
    state.currentRoomId = 'entrance';
    state.currentZoneId = null;
    state.discoveredRooms = ['entrance'];
    recomputeVisibleZones();
    record('dungeon-entered', { position: { x: state.playerX, z: state.playerZ } });
  }

  // Mirrors updateProgression(): zone tracking, gate closure once the actor
  // has fully entered the next room, discovery, visibility.
  function updateProgression() {
    const zone = zoneAtPosition(state.playerX, state.playerZ);
    if (zone && zone.id !== state.currentZoneId) state.currentZoneId = zone.id;
    const room = roomAtPosition(state.playerX, state.playerZ, 1.1);
    if (!room) return;
    if (room.id === state.currentRoomId) {
      if (state.visibleZoneIds.length === 0) recomputeVisibleZones();
      return;
    }
    const previousRoomId = state.currentRoomId;
    const traversedGate = state.gates.find((gate) => (
      gate.open && gate.fromRoomId === previousRoomId && gate.toRoomId === room.id
    ));
    if (traversedGate) {
      traversedGate.open = false;
      traversedGate.fromRoomId = null;
      traversedGate.toRoomId = null;
      record('gate-closed', { corridorId: traversedGate.corridorId, from: previousRoomId, to: room.id });
    }
    state.currentRoomId = room.id;
    if (!state.discoveredRooms.includes(room.id)) state.discoveredRooms.push(room.id);
    recomputeVisibleZones();
    record('room-entered', { roomId: room.id });
  }

  function spawnLoot(enemy) {
    if (enemy.lootDropped) return;
    enemy.lootDropped = true;
    const itemId = lootItemForProfile(enemy.profileKey);
    const drop = {
      id: `${enemy.id}-loot`,
      itemId,
      x: enemy.x,
      z: enemy.z,
      collected: false,
      // Cosmetic bobbing phase; drawn from the seeded RNG so runs reproduce.
      phase: rng() * Math.PI * 2,
    };
    state.loot.push(drop);
    record('loot-dropped', { itemId, from: enemy.id });
  }

  // --- semantic actions ----------------------------------------------------------

  function startNewGame() {
    Object.assign(state, makeState());
    events = [];
    record('game-started', { seed: currentSeed });
    return { ok: true };
  }

  function talkTo(roleOrName) {
    if (state.mode !== 'town' || state.finished || state.failed) {
      return { ok: false, reason: 'not-in-town' };
    }
    const npc = worldData.town.npcs.find((candidate) => (
      candidate.role === roleOrName || candidate.name === roleOrName
    ));
    if (!npc) return { ok: false, reason: 'no-such-npc' };
    const [x, z] = npc.position;
    const distance = Math.hypot(state.playerX - x, state.playerZ - z);
    if (distance > INTERACT_RADII.npc) {
      return { ok: false, reason: 'out-of-range', distance };
    }
    state.interactionCount += 1;
    state.lastInteraction = { kind: 'npc', id: npc.name };
    if (npc.role === 'Hunter') {
      // The rendered game opens the trail after a short delay; here that delay
      // is explicit state consumed by tick().
      state.trailTimer = 0.9;
      record('trail-offered', { npc: npc.name });
    } else {
      record('dialogue', { npc: npc.name });
    }
    return { ok: true, npc: npc.name, kind: 'npc' };
  }

  function moveTo(x, z) {
    const maxSteps = 20000;
    if (state.finished || state.failed) return { ok: false, reason: 'run-over' };
    const point = { x: state.playerX, z: state.playerZ };
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const dx = x - point.x;
      const dz = z - point.z;
      const distance = Math.hypot(dx, dz);
      if (distance < MOVE_ARRIVE_DISTANCE) {
        state.playerX = point.x;
        state.playerZ = point.z;
        updateProgression();
        return { ok: true, steps: stepIndex, position: { x: point.x, z: point.z } };
      }
      state.started = true;
      const speed = worldData.player.speed * 1.15; // matches the auto-walk pace
      const offsetX = (dx / distance) * speed * MOVE_TICK_SECONDS;
      const offsetZ = (dz / distance) * speed * MOVE_TICK_SECONDS;
      stepActorWithinMap(point, offsetX, offsetZ, navigation.modeBounds(), isWalkable);
      state.playerX = point.x;
      state.playerZ = point.z;
      updateProgression();
      advanceTimers(MOVE_TICK_SECONDS);
      if (state.finished || state.failed) {
        return { ok: false, reason: 'run-over', position: { x: point.x, z: point.z } };
      }
    }
    return { ok: false, reason: 'unreachable', position: { x: point.x, z: point.z } };
  }

  function attemptGateOpen(gate) {
    const verdict = evaluateGateOpen({
      gate,
      currentRoomId: state.currentRoomId,
      livingInRoomCount: livingEnemiesInRoom(state.currentRoomId).length,
    });
    if (!verdict.ok) {
      record('gate-blocked', { corridorId: gate?.corridorId ?? null, reason: verdict.reason });
      return { ok: false, reason: verdict.reason };
    }
    gate.open = true;
    gate.fromRoomId = state.currentRoomId;
    gate.toRoomId = gate.roomIds.find((id) => id !== state.currentRoomId) ?? null;
    record('gate-opened', { corridorId: gate.corridorId });
    return { ok: true, corridorId: gate.corridorId };
  }

  function openGate(corridorId) {
    if (state.mode !== 'dungeon' || state.finished || state.failed) {
      return { ok: false, reason: 'not-in-dungeon' };
    }
    return attemptGateOpen(gateByCorridor(corridorId));
  }

  function openChestOutcome(chest) {
    let blockedReason = '';
    if (chest.kind === 'seal') {
      blockedReason = evaluateChestBlock({
        chest,
        branchGuardianCount: livingEnemiesInBranch(chest.branch).length,
      });
    } else if (chest.kind === 'archive') {
      blockedReason = evaluateChestBlock({
        chest,
        branchGuardianCount: livingEnemiesInBranch('north', { includeWarden: false }).length,
      });
    } else {
      blockedReason = evaluateChestBlock({
        chest,
        roomGuardianCount: livingEnemiesInRoom(chest.roomId).length,
      });
    }
    if (blockedReason) {
      record('chest-blocked', { chestId: chest.id, reason: blockedReason });
      return { ok: false, reason: blockedReason };
    }
    chest.opened = true;
    const summary = applyChestRewards(state, chest, actionKeys);
    record('chest-opened', { chestId: chest.id, kind: summary.kind, healed: summary.healed });
    return { ok: true, summary };
  }

  function collectLoot(drop) {
    const slot = state.inventory.findIndex((itemId) => itemId === null);
    if (slot < 0) {
      record('loot-blocked', { dropId: drop.id, reason: 'backpack-full' });
      return { ok: false, reason: 'backpack-full' };
    }
    drop.collected = true;
    state.inventory[slot] = drop.itemId;
    record('loot-collected', { itemId: drop.itemId, slot });
    return { ok: true, itemId: drop.itemId, slot };
  }

  function killEnemy(target, action, damage) {
    target.hp = Math.max(0, target.hp - damage);
    record('enemy-damaged', { target: target.id, action, damage, hp: target.hp });
    if (target.hp > 0) return false;
    target.dead = true;
    record('enemy-killed', { target: target.id, profileKey: target.profileKey });
    spawnLoot(target);
    return true;
  }

  function useAction(action, targetId = null) {
    if (state.finished || state.failed) return { ok: false, reason: 'run-over' };
    const actionDef = actions[action];
    if (!actionDef) return { ok: false, reason: 'unknown-action' };
    const selfAction = action === 'heal' || action === 'buff';
    let target = null;
    if (!selfAction) {
      target = state.enemies.find((enemy) => enemy.id === targetId) ?? null;
      if (!target || target.dead || !enemyAccessible(target)) {
        return { ok: false, reason: 'invalid-target' };
      }
    }
    const remaining = state.actionCooldowns[action] ?? 0;
    if (remaining > 0) {
      record('action-blocked', { action, reason: 'cooldown', remaining });
      return { ok: false, reason: 'cooldown', remaining };
    }
    if (action === 'heal' && state.playerHp >= state.playerMaxHp) {
      return { ok: false, reason: 'hp-full' };
    }
    if (!selfAction) {
      const distance = Math.hypot(state.playerX - target.x, state.playerZ - target.z);
      if (distance > actionDef.range) {
        return { ok: false, reason: 'out-of-range', distance };
      }
      state.combatStarted = true;
      const damage = playerDamage(
        attackDamage(action, target.profileKey),
        { buffed: state.playerBuffTimer > 0 },
      );
      killEnemy(target, action, damage);
    } else if (action === 'heal') {
      const restored = Math.min(
        Math.round(state.playerMaxHp * HEAL_FRACTION),
        state.playerMaxHp - state.playerHp,
      );
      state.playerHp += restored;
      record('healed', { restored });
    } else {
      state.playerBuffTimer = 8;
      record('buff-active', { duration: 8 });
    }
    state.actionCooldowns[action] = actions[action].cooldown;
    state.started = true;
    return { ok: true, action };
  }

  // Mirrors interact()'s priority and radii exactly.
  function interact() {
    if (state.finished || state.failed) return { ok: false, reason: 'run-over' };
    if (state.mode === 'town') return talkTo('Hunter');
    state.started = true;
    const nearest = (list, radius, pick) => list
      .map((item) => ({ item, d: Math.hypot(state.playerX - pick(item).x, state.playerZ - pick(item).z) }))
      .sort((a, b) => a.d - b.d)[0];
    const nearLoot = nearest(state.loot.filter((drop) => !drop.collected), INTERACT_RADII.loot, (d) => d);
    if (nearLoot && nearLoot.d <= INTERACT_RADII.loot) {
      const outcome = collectLoot(nearLoot.item);
      if (outcome.ok) {
        state.interactionCount += 1;
        state.lastInteraction = { kind: 'loot', itemId: outcome.itemId };
      }
      return { ...outcome, kind: 'loot' };
    }
    const nearChest = nearest(state.chests.filter((chest) => !chest.opened), INTERACT_RADII.chest, (c) => c);
    if (nearChest && nearChest.d <= INTERACT_RADII.chest) {
      const outcome = openChestOutcome(nearChest.item);
      if (outcome.ok) {
        state.interactionCount += 1;
        state.lastInteraction = { kind: 'chest', id: nearChest.item.id };
      }
      return { ...outcome, kind: 'chest' };
    }
    const gateCenter = (gate) => {
      const corridor = zoneById.get(gate.corridorId);
      return { x: (corridor.minX + corridor.maxX) / 2, z: (corridor.minZ + corridor.maxZ) / 2 };
    };
    const nearGate = nearest(state.gates.filter((gate) => !gate.open), INTERACT_RADII.gate, gateCenter);
    if (nearGate && nearGate.d <= INTERACT_RADII.gate) {
      const outcome = attemptGateOpen(nearGate.item);
      if (outcome.ok) {
        state.interactionCount += 1;
        state.lastInteraction = { kind: 'gate', id: nearGate.item.corridorId };
      }
      return { ...outcome, kind: 'gate' };
    }
    record('interact-nothing-nearby');
    return { ok: false, reason: 'nothing-nearby' };
  }

  // --- time ----------------------------------------------------------------------

  function advanceTimers(delta) {
    state.elapsed += delta;
    for (const action of actionKeys) {
      state.actionCooldowns[action] = Math.max(0, state.actionCooldowns[action] - delta);
    }
    state.playerBuffTimer = Math.max(0, state.playerBuffTimer - delta);
    if (state.trailTimer > 0) {
      state.trailTimer -= delta;
      if (state.trailTimer <= 0) enterDungeon();
    }
  }

  function checkVictory() {
    if (state.finished || state.failed) return;
    const objectivesComplete = runObjectivesComplete({
      wardenSpoilsOpened: Boolean(chestById('warden-spoils')?.opened),
      livingEnemyCount: livingEnemyCount(),
    });
    const distanceToExit = Math.hypot(state.playerX - EXIT_POSITION.x, state.playerZ - EXIT_POSITION.z);
    if (isRunVictory({ objectivesComplete, distanceToExit })) {
      state.finished = true;
      record('run-finished', { success: true, objectivesComplete, distanceToExit });
    }
  }

  function tick(delta = 0.1) {
    advanceTimers(delta);
    checkVictory();
    return { elapsed: state.elapsed, finished: state.finished };
  }

  // --- checkpoints -----------------------------------------------------------------

  function saveCheckpoint() {
    return deepCopy({ version: 1, state, events });
  }

  function loadCheckpoint(checkpoint) {
    if (!checkpoint || checkpoint.version !== 1) {
      throw new Error('Unsupported checkpoint format.');
    }
    Object.assign(state, deepCopy(checkpoint.state));
    events = deepCopy(checkpoint.events ?? []);
    return { ok: true };
  }

  // --- structured state / debug representation ---------------------------------------

  function describe() {
    const wardenSpoilsOpened = Boolean(chestById('warden-spoils')?.opened);
    const objectivesComplete = runObjectivesComplete({
      wardenSpoilsOpened,
      livingEnemyCount: livingEnemyCount(),
    });
    return deepCopy({
      mode: state.mode,
      started: state.started,
      finished: state.finished,
      failed: state.failed,
      elapsed: state.elapsed,
      player: {
        x: state.playerX,
        z: state.playerZ,
        hp: state.playerHp,
        maxHp: state.playerMaxHp,
        buffTimer: state.playerBuffTimer,
        cooldowns: { ...state.actionCooldowns },
        inventory: [...state.inventory],
        equippedSlot: state.equippedSlot,
      },
      room: state.currentRoomId,
      zone: state.currentZoneId,
      discoveredRooms: [...state.discoveredRooms],
      visibleZoneIds: [...state.visibleZoneIds],
      gates: state.gates.map((gate) => ({
        corridorId: gate.corridorId,
        roomIds: [...gate.roomIds],
        open: gate.open,
      })),
      chests: state.chests.map((chest) => ({
        id: chest.id,
        kind: chest.kind,
        roomId: chest.roomId,
        opened: chest.opened,
      })),
      seals: { ...state.seals },
      archiveKey: state.archiveKey,
      openedChests: state.openedChests,
      enemies: state.enemies.map((enemy) => ({
        id: enemy.id,
        name: enemy.name,
        profileKey: enemy.profileKey,
        roomId: enemy.roomId,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        dead: enemy.dead,
      })),
      loot: deepCopy(state.loot.filter((drop) => !drop.collected)),
      objectives: {
        westSeal: state.seals.west,
        eastSeal: state.seals.east,
        archiveKey: state.archiveKey,
        wardenRelicObtained: state.inventory.includes('wardenRelic'),
        wardenSpoilsOpened,
        complete: objectivesComplete,
      },
      interactionCount: state.interactionCount,
      lastInteraction: state.lastInteraction ? { ...state.lastInteraction } : null,
      events: events.slice(-20),
    });
  }

  const getEvents = () => deepCopy(events);

  return {
    // semantic actions
    startNewGame,
    talkTo,
    moveTo,
    interact,
    openGate,
    useAction,
    // test affordance mirroring __cryptTest.clearRoom
    clearRoom(roomId) {
      for (const enemy of state.enemies) {
        if (enemy.roomId !== roomId || enemy.dead) continue;
        enemy.dead = true;
        spawnLoot(enemy);
      }
      record('room-cleared', { roomId });
      return { ok: true, roomId };
    },
    // time / checkpoints / inspection
    tick,
    saveCheckpoint,
    loadCheckpoint,
    describe,
    getEvents,
  };
}
