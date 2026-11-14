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
  DUNGEON_ENTRANCE,
  EXIT_POSITION,
  HEAL_FRACTION,
  ROOM_ENTRY_CLEARANCE,
  applyChestRewards,
  applyGateOpen,
  attackDamage,
  computeZoneNeighbors,
  evaluateChestBlock,
  findRoomAt,
  findZoneAt,
  evaluateGateOpen,
  gateCrossing,
  gateTravelsAlongZ,
  gateWallPosition,
  INTERACT_RADII,
  isRunVictory,
  lootItemForProfile,
  playerDamage,
  resolveRoomEntry,
  runObjectivesComplete,
  visibleZoneIdsFor,
  zoneContains,
} from './world-rules.js';
const MOVE_ARRIVE_DISTANCE = 0.35;
const SIM_STEP_SECONDS = 0.1;
const STEP_EPSILON = 1e-9;

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

  const actions = worldData.actions;
  const actionKeys = Object.keys(actions);

  let events = [];
  const record = (type, payload = {}) => {
    events.push({ t: Number(state.elapsed.toFixed(3)), type, ...payload });
  };

  function makeState() {
    return {
      mode: 'town',
      started: false,
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
      pendingTime: 0,
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

  let state = makeState();

  // --- queries ---------------------------------------------------------------

  function livingEnemiesInRoom(roomId) {
    return state.enemies.filter((enemy) => !enemy.dead && enemy.roomId === roomId);
  }
  const roomAtPosition = (x, z, inset = 0) => findRoomAt(map.rooms, x, z, inset);
  const zoneAtPosition = (x, z) => findZoneAt(zones, x, z);

  function isWalkable(x, z, padding = 0.55) {
    return isWalkablePoint({ x, z, padding, navigation });
  }

  function isTraversable(x, z, padding) {
    if (!isWalkable(x, z, padding)) return false;
    if (state.mode !== 'dungeon' || roomAtPosition(x, z)) return true;
    return map.corridors.some((corridor) =>
      gateByCorridor(corridor.id)?.open && zoneContains(corridor, x, z, -padding));
  }

  function recomputeVisibleZones() {
    state.visibleZoneIds = visibleZoneIdsFor({
      currentRoomId: state.currentRoomId,
      neighborIdsByZone: zoneNeighbors,
      gates: state.gates,
      isRoom: (id) => roomIds.has(id),
    });
  }

  const enemyAccessible = (enemy) => state.visibleZoneIds.includes(enemy.roomId);
  const chestById = (id) => state.chests.find((chest) => chest.id === id) ?? null;
  const gateByCorridor = (corridorId) => state.gates.find((gate) => gate.corridorId === corridorId) ?? null;

  function gatePosition(gate) {
    const first = zoneById.get(gate.roomIds[0]);
    const second = zoneById.get(gate.roomIds[1]);
    return gateWallPosition(zoneById.get(gate.corridorId), zoneById.get(state.currentRoomId),
      gateTravelsAlongZ(first, second));
  }

  // Equipment rules (mirrors main.js): an equipped item scales damage and
  // cooldowns; agents reach them through the equip() semantic action.
  function equippedDefinition() {
    const itemId = state.equippedSlot === null ? null : state.inventory[state.equippedSlot];
    return itemId ? worldData.items[itemId] : null;
  }
  const itemDamageMultiplier = (action) => equippedDefinition()?.damage?.[action] ?? 1;
  const actionCooldownFor = (action) => actions[action].cooldown * (equippedDefinition()?.cooldown?.[action] ?? 1);

  function cooldownWait(action) {
    const remaining = state.actionCooldowns[action];
    if (remaining <= STEP_EPSILON) return 0;
    const steps = Math.ceil((remaining - STEP_EPSILON) / SIM_STEP_SECONDS);
    return Math.max(0, steps * SIM_STEP_SECONDS - state.pendingTime);
  }

  // --- internal transitions ----------------------------------------------------

  function enterDungeon() {
    if (state.mode === 'dungeon') return;
    state.mode = 'dungeon';
    state.started = false;
    state.trailTimer = 0;
    // Mirrors the rendered trail: the actor always arrives at the entrance
    // vault door, regardless of where they stood in Ravenrest.
    state.playerX = DUNGEON_ENTRANCE.x;
    state.playerZ = DUNGEON_ENTRANCE.z;
    state.currentRoomId = 'entrance';
    state.currentZoneId = 'entrance';
    state.discoveredRooms = ['entrance'];
    recomputeVisibleZones();
    record('dungeon-entered', { position: { x: state.playerX, z: state.playerZ } });
  }

  // Zone tracking, gate closure once the actor fully entered the next room,
  // discovery and visibility. The decision comes from the shared
  // resolveRoomEntry rule; only state mutation lives here.
  function updateProgression() {
    if (state.mode !== 'dungeon') return;
    const zone = zoneAtPosition(state.playerX, state.playerZ);
    state.currentZoneId = zone?.id ?? null;
    const transition = resolveRoomEntry({
      x: state.playerX,
      z: state.playerZ,
      rooms: map.rooms,
      currentRoomId: state.currentRoomId,
      gates: state.gates,
      clearance: ROOM_ENTRY_CLEARANCE,
    });
    if (!transition.entered) {
      if (state.visibleZoneIds.length === 0) recomputeVisibleZones();
      return;
    }
    if (transition.traversedGate) {
      const traversedGate = transition.traversedGate;
      traversedGate.open = false;
      traversedGate.fromRoomId = null;
      traversedGate.toRoomId = null;
      record('gate-closed', { corridorId: traversedGate.corridorId, from: state.currentRoomId, to: transition.roomId });
    }
    state.currentRoomId = transition.roomId;
    if (!state.discoveredRooms.includes(transition.roomId)) state.discoveredRooms.push(transition.roomId);
    recomputeVisibleZones();
    record('room-entered', { roomId: transition.roomId });
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
    state = makeState();
    events = [];
    record('game-started');
    return { ok: true };
  }

  function talkTo(role) {
    if (state.mode !== 'town' || state.finished || state.failed) {
      return { ok: false, reason: 'not-in-town' };
    }
    if (state.trailTimer > 0) return { ok: false, reason: 'trail-pending' };
    const npc = worldData.town.npcs.find((candidate) => candidate.role === role)
      ?? worldData.town.npcs.find((candidate) => candidate.name === role);
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
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, reason: 'invalid-position' };
    const mode = state.mode;
    const position = () => ({ x: state.playerX, z: state.playerZ });
    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      const point = position();
      const dx = x - point.x;
      const dz = z - point.z;
      const distance = Math.hypot(dx, dz);
      if (distance < MOVE_ARRIVE_DISTANCE) {
        updateProgression();
        checkVictory();
        return { ok: true, steps: stepIndex, position: point };
      }
      const step = Math.min(distance, worldData.player.speed * 1.15 * SIM_STEP_SECONDS);
      stepActorWithinMap(point, (dx / distance) * step, (dz / distance) * step,
        navigation.modeBounds(), isTraversable, 0.65);
      if (distance - Math.hypot(x - point.x, z - point.z) <= STEP_EPSILON) break;
      state.started = true;
      state.playerX = point.x;
      state.playerZ = point.z;
      updateProgression();
      tick(SIM_STEP_SECONDS);
      if (state.mode !== mode) return { ok: false, reason: 'scene-changed', position: position() };
      if (state.failed) return { ok: false, reason: 'run-over', position: position() };
      if (state.finished) return { ok: true, steps: stepIndex + 1, position: position() };
    }
    return { ok: false, reason: 'unreachable', position: position() };
  }

  function gateOpenVerdict(gate) {
    return evaluateGateOpen({
      gate,
      currentRoomId: state.currentRoomId,
      livingInRoomCount: livingEnemiesInRoom(state.currentRoomId).length,
      crossing: gateCrossing({
        x: state.playerX, z: state.playerZ, room: zoneById.get(state.currentRoomId), gates: state.gates,
      }),
      seals: state.seals,
      archiveKey: state.archiveKey,
    });
  }

  function attemptGateOpen(gate) {
    const verdict = gateOpenVerdict(gate);
    if (!verdict.ok) {
      record('gate-blocked', { corridorId: gate?.corridorId ?? null, code: verdict.code, message: verdict.message });
      return { ok: false, code: verdict.code, reason: verdict.message };
    }
    for (const { gate: closedGate } of applyGateOpen(state.gates, gate, state.currentRoomId)) {
      record('gate-closed', { corridorId: closedGate.corridorId, reason: 'another-gate-opened' });
    }
    recomputeVisibleZones();
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

  function chestBlockReason(chest) {
    return evaluateChestBlock({
      chest,
      enemies: state.enemies,
      roomBranch,
    });
  }

  function openChestOutcome(chest) {
    const blockedReason = chestBlockReason(chest);
    if (blockedReason) {
      record('chest-blocked', { chestId: chest.id, reason: blockedReason });
      return { ok: false, reason: blockedReason };
    }
    chest.opened = true;
    const summary = applyChestRewards(state, chest, actionKeys);
    record('chest-opened', { chestId: chest.id, kind: summary.kind, healed: summary.healed });
    return { ok: true, chestId: chest.id, summary };
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
    if (state.mode !== 'dungeon') return { ok: false, reason: 'not-in-dungeon' };
    if (typeof action !== 'string' || !Object.hasOwn(actions, action)) {
      return { ok: false, reason: 'unknown-action' };
    }
    const actionDef = actions[action];
    const selfAction = action === 'heal' || action === 'buff';
    let target = null;
    if (!selfAction) {
      target = state.enemies.find((enemy) => enemy.id === targetId) ?? null;
      if (!target || target.dead || !enemyAccessible(target)) {
        return { ok: false, reason: 'invalid-target' };
      }
    }
    const remaining = cooldownWait(action);
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
    if (!Number.isInteger(slot) || slot < 0 || slot >= state.inventory.length) {
      return { ok: false, reason: 'invalid-slot' };
    }
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
    if (!Number.isInteger(slot) || slot < 0 || slot >= state.inventory.length) {
      return { ok: false, reason: 'invalid-slot' };
    }
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
    const distanceTo = (x, z) => Math.hypot(state.playerX - x, state.playerZ - z);
    let blockedLoot = null;
    // Interact targets in production priority order: loot, chest, gate.
    const targets = [
      {
        kind: 'loot',
        radius: INTERACT_RADII.loot,
        items: state.loot.filter((drop) => !drop.collected),
        position: (drop) => drop,
        act: (drop) => collectLoot(drop),
        lastInteraction: (drop) => ({ kind: 'loot', itemId: drop.itemId }),
      },
      {
        kind: 'chest',
        radius: INTERACT_RADII.chest,
        items: state.chests.filter((chest) => !chest.opened && state.visibleZoneIds.includes(chest.roomId)),
        position: (chest) => chest,
        usable: (chest) => !chestBlockReason(chest),
        act: (chest) => openChestOutcome(chest),
        lastInteraction: (chest) => ({ kind: 'chest', id: chest.id }),
      },
      {
        kind: 'gate',
        radius: INTERACT_RADII.gate,
        items: state.gates.filter((gate) => !gate.open && gate.roomIds.includes(state.currentRoomId)),
        position: gatePosition,
        usable: (gate) => gateOpenVerdict(gate).ok,
        act: (gate) => attemptGateOpen(gate),
        lastInteraction: (gate) => ({ kind: 'gate', id: gate.corridorId }),
      },
    ];
    for (const { kind, radius, items, position, usable, act, lastInteraction } of targets) {
      const nearest = items
        .map((item) => {
          const { x, z } = position(item);
          return { item, d: distanceTo(x, z) };
        })
        .sort((a, b) => a.d - b.d)[0];
      if (!nearest || nearest.d > radius) continue;
      if (kind === 'loot' && !state.inventory.includes(null)) {
        blockedLoot = nearest.item;
        continue;
      }
      if (blockedLoot && !usable(nearest.item)) continue;
      const outcome = act(nearest.item);
      if (outcome.ok) {
        state.interactionCount += 1;
        state.lastInteraction = lastInteraction(nearest.item);
      }
      return { ...outcome, kind };
    }
    if (blockedLoot) return { ...collectLoot(blockedLoot), kind: 'loot' };
    record('interact-nothing-nearby');
    return { ok: false, reason: 'nothing-nearby' };
  }

  function advanceTimers(delta) {
    state.elapsed += delta;
    for (const action of actionKeys) {
      const remaining = state.actionCooldowns[action] - delta;
      state.actionCooldowns[action] = remaining > STEP_EPSILON ? remaining : 0;
    }
    const buffRemaining = state.playerBuffTimer - delta;
    state.playerBuffTimer = buffRemaining > STEP_EPSILON ? buffRemaining : 0;
    if (state.trailTimer > 0) {
      state.trailTimer -= delta;
      if (state.trailTimer <= STEP_EPSILON) enterDungeon();
      return;
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
      if (enemy.attackTimer > STEP_EPSILON) continue;
      enemy.attackTimer += profile.attackCooldown;
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
    if (state.mode !== 'dungeon' || state.finished || state.failed) return;
    const objectivesComplete = objectivesAreComplete();
    const distanceToExit = Math.hypot(state.playerX - EXIT_POSITION.x, state.playerZ - EXIT_POSITION.z);
    if (isRunVictory({ objectivesComplete, distanceToExit })) {
      state.finished = true;
      record('run-finished', { success: true, objectivesComplete, distanceToExit });
    }
  }

  function tick(delta = SIM_STEP_SECONDS) {
    if (!Number.isFinite(delta) || delta < 0 || !Number.isSafeInteger(Math.floor(delta / SIM_STEP_SECONDS))) {
      return { ok: false, reason: 'invalid-delta', elapsed: state.elapsed, finished: state.finished };
    }
    if (state.finished || state.failed) return { elapsed: state.elapsed, finished: state.finished };
    state.pendingTime += delta;
    if (state.mode === 'town' && state.trailTimer <= 0) {
      const steps = Math.floor((state.pendingTime + STEP_EPSILON) / SIM_STEP_SECONDS);
      state.elapsed += steps * SIM_STEP_SECONDS;
      state.pendingTime = Math.max(0, state.pendingTime - steps * SIM_STEP_SECONDS);
    }
    while (state.pendingTime >= SIM_STEP_SECONDS - STEP_EPSILON && !state.finished && !state.failed) {
      state.pendingTime = Math.max(0, state.pendingTime - SIM_STEP_SECONDS);
      advanceTimers(SIM_STEP_SECONDS);
      checkVictory();
    }
    if (state.finished || state.failed) state.pendingTime = 0;
    return { elapsed: state.elapsed, finished: state.finished };
  }

  // --- checkpoints -----------------------------------------------------------------
  function saveCheckpoint() {
    return structuredClone({ state, events });
  }

  // Edited fixtures can change progress. The state shape and world identities stay fixed.
  function validateCheckpointShape(candidate, template, path = 'state') {
    const invalid = () => { throw new TypeError(`Invalid checkpoint at ${path}`); };
    if (Array.isArray(template)) {
      if (!Array.isArray(candidate) || (template.length > 0 && candidate.length !== template.length)) invalid();
      template.forEach((entry, index) => validateCheckpointShape(candidate[index], entry, `${path}[${index}]`));
    } else if (template && typeof template === 'object') {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid();
      for (const [key, value] of Object.entries(template)) {
        if (!Object.hasOwn(candidate, key)) invalid();
        validateCheckpointShape(candidate[key], value, `${path}.${key}`);
      }
    } else if (template !== null && (typeof candidate !== typeof template
      || (typeof template === 'number' && !Number.isFinite(candidate)))) {
      invalid();
    }
  }

  function loadCheckpoint(checkpoint) {
    const { state: restored, events: history } = structuredClone(checkpoint ?? {});
    if (!restored || typeof restored !== 'object' || Array.isArray(restored)) {
      throw new TypeError('Invalid checkpoint state');
    }
    restored.pendingTime ??= 0;
    const initial = makeState();
    validateCheckpointShape(restored, { ...initial, discoveredRooms: [], visibleZoneIds: [] });
    for (const drop of restored.loot) {
      validateCheckpointShape(drop, { id: '', itemId: '', x: 0, z: 0, collected: false }, 'loot');
      if (!Object.hasOwn(worldData.items, drop.itemId)) throw new TypeError('Invalid checkpoint loot item');
    }
    const log = history ?? [];
    validateCheckpointShape(log, [], 'events');
    for (const event of log) validateCheckpointShape(event, { t: 0, type: '' }, 'event');
    const equipped = restored.equippedSlot;
    const openGates = restored.gates.filter((gate) => gate.open);
    if (
      (equipped !== null && (!Number.isInteger(equipped) || equipped < 0 || equipped >= restored.inventory.length
        || worldData.items[restored.inventory[equipped]]?.kind !== 'equipment'))
      || Array.from(restored.inventory).some((itemId) =>
        itemId !== null && (typeof itemId !== 'string' || !Object.hasOwn(worldData.items, itemId)))
      || !['town', 'dungeon'].includes(restored.mode)
      || !roomIds.has(restored.currentRoomId) || (restored.currentZoneId !== null && !zoneById.has(restored.currentZoneId))
      || Array.from(restored.discoveredRooms).some((id) => !roomIds.has(id))
      || Array.from(restored.visibleZoneIds).some((id) => !zoneById.has(id))
      || restored.playerMaxHp !== initial.playerMaxHp || restored.playerHp < 0 || restored.playerHp > restored.playerMaxHp
      || restored.pendingTime < 0 || restored.pendingTime >= SIM_STEP_SECONDS
      || actionKeys.some((action) => restored.actionCooldowns[action] < 0)
      || restored.enemies.length !== initial.enemies.length || restored.enemies.some((enemy, index) =>
        enemy.id !== initial.enemies[index].id || enemy.roomId !== initial.enemies[index].roomId
        || enemy.profileKey !== initial.enemies[index].profileKey || enemy.maxHp !== initial.enemies[index].maxHp
        || enemy.hp < 0 || enemy.hp > enemy.maxHp)
      || restored.chests.length !== initial.chests.length || restored.chests.some((chest, index) =>
        chest.id !== initial.chests[index].id || chest.roomId !== initial.chests[index].roomId
        || chest.kind !== initial.chests[index].kind || chest.branch !== initial.chests[index].branch)
      || restored.gates.length !== initial.gates.length
      || restored.gates.some((gate, index) => gate.corridorId !== initial.gates[index].corridorId
        || Array.from(gate.roomIds).some((id, endpoint) => id !== initial.gates[index].roomIds[endpoint])
        || (gate.open
          ? gate.fromRoomId === gate.toRoomId || !gate.roomIds.includes(gate.fromRoomId) || !gate.roomIds.includes(gate.toRoomId)
          : gate.fromRoomId !== null || gate.toRoomId !== null))
      || openGates.length > 1 || openGates.some((gate) => gate.fromRoomId !== restored.currentRoomId)
    ) {
      throw new TypeError('Invalid checkpoint');
    }
    if (restored.failed !== (restored.playerHp === 0)
      || ((restored.failed || restored.finished) && restored.mode !== 'dungeon')
      || (restored.finished && (restored.failed || !isRunVictory({
        objectivesComplete: objectivesAreComplete(restored),
        distanceToExit: Math.hypot(restored.playerX - EXIT_POSITION.x, restored.playerZ - EXIT_POSITION.z),
      })))) {
      throw new TypeError('Invalid checkpoint outcome');
    }
    // Older clearRoom fixtures marked deaths without clearing vitality.
    for (const enemy of restored.enemies) {
      if (enemy.dead) enemy.hp = 0;
    }
    if (restored.mode === 'dungeon') restored.trailTimer = 0;
    state = restored;
    events = log;
    return { ok: true };
  }
  // --- structured state / debug representation ---------------------------------------

  function objectivesAreComplete(run = state) {
    return runObjectivesComplete({
      seals: run.seals,
      archiveKey: run.archiveKey,
      wardenSpoilsOpened: run.chests.find((chest) => chest.id === 'warden-spoils')?.opened,
      livingEnemyCount: run.enemies.filter((enemy) => !enemy.dead).length,
    });
  }

  function describe() {
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
        cooldowns: Object.fromEntries(actionKeys.map((action) => [action, cooldownWait(action)])),
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
        wardenSpoilsOpened: Boolean(chestById('warden-spoils')?.opened),
        complete: objectivesAreComplete(),
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
      if (state.finished || state.failed) return { ok: false, reason: 'run-over' };
      const guardians = livingEnemiesInRoom(roomId);
      for (const enemy of guardians) {
        enemy.hp = 0;
        enemy.dead = true;
        spawnLoot(enemy);
      }
      if (guardians.length > 0) record('room-cleared', { roomId });
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
