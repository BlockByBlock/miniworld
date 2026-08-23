// Headless simulation of Forgotten Crypt.
//
// The same rules that drive the rendered game (src/main.js) run here on
// plain JavaScript state: no THREE, no DOM, no audio, no rAF, no setTimeout,
// and no randomness — every rule is deterministic. Time passes only when the
// caller calls tick(delta); the world definition is injectable too.
//
// Agents and tests drive the simulation through semantic actions
// (talkTo / moveTo / interact / openGate / useAction) instead of keyboard,
// mouse, or physical traversal, and read structured state through describe().
// saveCheckpoint/loadCheckpoint give controlled start states mid-run.

import { WORLD_DATA } from '../world-data.js';
import {
  createNavigationContext,
  isWalkablePoint,
  stepActorWithinMap,
} from '../movement-contracts.js';
import {
  CONSUMABLE_HEAL,
  EXIT_POSITION,
  HEAL_FRACTION,
  applyChestRewards,
  attackDamage,
  computeZoneNeighbors,
  evaluateChestBlock,
  evaluateGateOpen,
  INTERACT_RADII,
  isRunVictory,
  lootItemForProfile,
  playerDamage,
  runObjectivesComplete,
} from './world-rules.js';
const MOVE_ARRIVE_DISTANCE = 0.35;
const MOVE_TICK_SECONDS = 0.1;

export function createGameCore({
  worldData = WORLD_DATA,
} = {}) {
  const map = worldData.map;
  const zones = [...map.rooms, ...map.corridors];
  const corridorZoneIds = new Set(map.corridors);
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const roomIds = new Set(map.rooms.map((room) => room.id));
  const roomBranch = worldData.roomBranch;

  // Shared with the rendered game so the two can never drift.
  const zoneNeighbors = computeZoneNeighbors(zones);

  // Navmesh-level walkability: zone bounds plus corridor clearance, without
  // furniture colliders (those are presentation-layer obstacles).
  const navigation = createNavigationContext({
    getMode: () => state.mode,
    townBounds: worldData.town.bounds,
    worldBounds: worldData.world,
    mapZones: zones,
    corridorZoneIds,
    staticColliders: [],
    townStaticColliders: [],
  });

  const actions = Object.fromEntries(Object.entries(worldData.actions)
    .map(([id, action]) => [id, { cooldown: action.cooldown, range: action.range }]));
  const actionKeys = Object.keys(actions);

  let events = [];
  const record = (type, payload = {}) => {
    events.push({ t: Number(state.elapsed.toFixed(3)), type, ...payload });
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
      enemies: worldData.enemySpawns.map((spawn) => {
        const profile = worldData.enemyProfiles[spawn.profileKey];
        return {
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
          awake: false,
          // First swing comes after the profile windup, like production.
          attackTimer: profile?.windup ?? 0,
        };
      }),
      gates: map.corridors.map((corridor) => ({
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

  // Mirrors the physical gates: a closed gate seals its corridor. A step may
  // only enter a corridor whose gate is open — unless the actor is already
  // inside that corridor (production closes the gate only after the actor
  // has fully entered the next room, never mid-corridor).
  function traversable(x, z) {
    const zone = zoneAtPosition(x, z);
    if (!zone) return true;
    const gate = gateByCorridor(zone.id);
    if (!gate || gate.open) return true;
    const currentZone = zoneAtPosition(state.playerX, state.playerZ);
    return Boolean(currentZone && currentZone.id === zone.id);
  }

  function isTraversable(x, z, padding) {
    return isWalkable(x, z, padding) && traversable(x, z);
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

  // Equipment rules (mirrors main.js): an equipped item scales damage and
  // cooldowns; agents reach them through the equip() semantic action.
  function equippedDefinition() {
    const itemId = state.equippedSlot === null ? null : state.inventory[state.equippedSlot];
    return itemId ? worldData.items[itemId] : null;
  }
  const itemDamageMultiplier = (action) => equippedDefinition()?.damage?.[action] ?? 1;
  const actionCooldownFor = (action) => actions[action].cooldown * (equippedDefinition()?.cooldown?.[action] ?? 1);

  // --- internal transitions ----------------------------------------------------

  function enterDungeon() {
    if (state.mode === 'dungeon') return;
    state.mode = 'dungeon';
    state.started = false;
    state.combatStarted = false;
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
    };
    state.loot.push(drop);
    record('loot-dropped', { itemId, from: enemy.id });
  }

  // --- semantic actions ----------------------------------------------------------

  function startNewGame() {
    Object.assign(state, makeState());
    events = [];
    record('game-started');
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
        checkVictory();
        return { ok: true, steps: stepIndex, position: { x: point.x, z: point.z } };
      }
      state.started = true;
      const speed = worldData.player.speed * 1.15; // matches the auto-walk pace
      const offsetX = (dx / distance) * speed * MOVE_TICK_SECONDS;
      const offsetZ = (dz / distance) * speed * MOVE_TICK_SECONDS;
      stepActorWithinMap(point, offsetX, offsetZ, navigation.modeBounds(), isTraversable, 0.65);
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

  function openChestOutcome(chest) {
    const guardianCount = chest.kind === 'seal'
      ? livingEnemiesInBranch(chest.branch).length
      : chest.kind === 'archive'
        ? livingEnemiesInBranch('north', { includeWarden: false }).length
        : livingEnemiesInRoom(chest.roomId).length;
    const blockedReason = evaluateChestBlock({ chest, guardianCount });
    if (blockedReason) {
      record('chest-blocked', { chestId: chest.id, reason: blockedReason });
      return { ok: false, reason: blockedReason };
    }
    chest.opened = true;
    const summary = applyChestRewards(state, chest, actionKeys);
    record('chest-opened', { chestId: chest.id, kind: summary.kind, healed: summary.healed });
    return { ok: true, summary };
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
      const damage = playerDamage(attackDamage(action, target.profileKey), {
        buffed: state.playerBuffTimer > 0,
        itemMultiplier: itemDamageMultiplier(action),
      });
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
    state.actionCooldowns[action] = actionCooldownFor(action);
    state.started = true;
    return { ok: true, action };
  }

  function equip(slot) {
    if (state.finished || state.failed) return { ok: false, reason: 'run-over' };
    const itemId = state.inventory[slot];
    if (!itemId) return { ok: false, reason: 'empty-slot' };
    // Mirrors useInventorySlot(): consumables are drunk, not equipped.
    if (worldData.items[itemId]?.kind !== 'equipment') {
      return { ok: false, reason: 'not-equipment', itemId };
    }
    // Production toggles the slot on re-select.
    state.equippedSlot = state.equippedSlot === slot ? null : slot;
    record('equipped', { itemId, slot });
    return { ok: true, itemId, slot };
  }

  function consume(slot) {
    if (state.finished || state.failed) return { ok: false, reason: 'run-over' };
    const itemId = state.inventory[slot];
    const item = itemId ? worldData.items[itemId] : null;
    if (!item || item.kind !== 'consumable') return { ok: false, reason: 'not-consumable' };
    if (state.playerHp >= state.playerMaxHp) return { ok: false, reason: 'hp-full' };
    const restored = Math.min(CONSUMABLE_HEAL, state.playerMaxHp - state.playerHp);
    state.playerHp += restored;
    state.inventory[slot] = null;
    record('consumed', { itemId, restored, slot });
    return { ok: true, itemId, restored };
  }

  // Mirrors interact()'s priority and radii exactly.
  function interact() {
    if (state.finished || state.failed) return { ok: false, reason: 'run-over' };
    if (state.mode === 'town') {
      // Production talks to the nearest NPC of any role, not just the hunter.
      const npc = worldData.town.npcs
        .map((candidate) => ({
          candidate,
          d: Math.hypot(state.playerX - candidate.position[0], state.playerZ - candidate.position[1]),
        }))
        .sort((a, b) => a.d - b.d)[0];
      if (npc && npc.d <= INTERACT_RADII.npc) return talkTo(npc.candidate.role);
      return { ok: false, reason: 'nothing-nearby' };
    }
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
    simulateEnemyAttacks(delta);
  }

  // Deterministic defense model: enemies hold their spawn position, wake
  // inside leash range of the player, and swing on their profile cooldown
  // whenever the player stands within attack range. The ward absorbs hits,
  // and a fallen player fails the run — so the loss path is exercisable.
  function simulateEnemyAttacks(delta) {
    if (state.mode !== 'dungeon' || state.finished || state.failed) return;
    for (const enemy of state.enemies) {
      if (enemy.dead || !enemyAccessible(enemy)) continue;
      const profile = worldData.enemyProfiles[enemy.profileKey];
      if (!profile) continue;
      const distance = Math.hypot(state.playerX - enemy.x, state.playerZ - enemy.z);
      if (distance > (profile.leash ?? Infinity)) {
        enemy.awake = false;
        continue;
      }
      enemy.awake = true;
      if (distance > profile.attackRange) continue;
      enemy.attackTimer -= delta;
      if (enemy.attackTimer > 0) continue;
      enemy.attackTimer = profile.attackCooldown;
      if (state.playerBuffTimer > 0) {
        record('damage-absorbed', { from: enemy.id });
        continue;
      }
      state.playerHp = Math.max(0, state.playerHp - profile.damage);
      record('player-damaged', { from: enemy.id, damage: profile.damage, hp: state.playerHp });
      if (state.playerHp <= 0) {
        state.failed = true;
        record('run-finished', { success: false });
        return;
      }
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
    // Fixed-step simulation: long ticks resolve in 0.1s slices so cooldowns,
    // windups, and the trail timer behave identically at any caller cadence.
    let remaining = Math.max(0, delta);
    while (remaining > 0 && !state.finished && !state.failed) {
      const step = Math.min(MOVE_TICK_SECONDS, remaining);
      remaining -= step;
      advanceTimers(step);
      checkVictory();
    }
    return { elapsed: state.elapsed, finished: state.finished };
  }

  // --- checkpoints -----------------------------------------------------------------
  function saveCheckpoint() {
    return structuredClone({ state, events });
  }

  function loadCheckpoint(checkpoint) {
    Object.assign(state, structuredClone(checkpoint.state));
    events = structuredClone(checkpoint.events ?? []);
    return { ok: true };
  }
  // --- structured state / debug representation ---------------------------------------

  function describe() {
    const wardenSpoilsOpened = Boolean(chestById('warden-spoils')?.opened);
    const objectivesComplete = runObjectivesComplete({
      wardenSpoilsOpened,
      livingEnemyCount: livingEnemyCount(),
    });
    return structuredClone({
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
      loot: structuredClone(state.loot.filter((drop) => !drop.collected)),
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
    });
  }

  const getEvents = () => structuredClone(events);

  return {
    // semantic actions
    startNewGame,
    talkTo,
    moveTo,
    interact,
    openGate,
    useAction,
    equip,
    consume,
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
