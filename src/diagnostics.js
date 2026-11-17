import * as THREE from 'three';
import { createCryptProfile, waitForProfileTarget } from './optimization-contracts.js';

// Opt-in browser diagnostics for ?e2e pages: published state snapshots, the
// keyboard smoke, the fast functional checkpoint, the __cryptRun profiling
// route, and window.__cryptTest. `game` exposes the internals they drive;
// `player` and `renderingPaused` are getters because the game reassigns them.
export function installDiagnostics(game) {
  const {
    app,
    state,
    camera,
    townNpcs,
    zoneRenderGroups,
    enemies,
    lootDrops,
    objective,
    objectiveDetail,
    countLivingEnemies,
    runObjectivesComplete,
    chestById,
    updateZoneVisibility,
    enterDungeon,
    talkToTownNpc,
    updateProgression,
    moveActorWithinMap,
    createLootVisual,
    nearestLootDrop,
    updateLootDrops,
    findGate,
    clearEnemies,
    openGate,
    interact,
    clearInputState,
  } = game;
  const movementDirection = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();

  const e2eState = {
    activeDiagnostic: null,
    routeUsed: false,
    errors: [],
    smoke: null,
    lastResult: null,
    fastGateTransitions: 0,
  };
  let e2eStatus = null;

  function e2eSnapshot() {
    return {
      mode: state.mode,
      zoneId: state.currentZoneId,
      roomId: state.currentRoomId,
      position: game.player
        ? { x: game.player.root.position.x, y: game.player.root.position.y, z: game.player.root.position.z }
        : null,
      playerHp: state.playerHp,
      seals: { ...state.seals },
      archiveKey: state.archiveKey,
      chests: state.chests.map((chest) => ({
        id: chest.id,
        roomId: chest.roomId,
        kind: chest.kind,
        opened: chest.opened,
      })),
      gates: state.gates.map((gate) => ({
        corridorId: gate.corridorId,
        open: gate.open,
        fromRoomId: gate.fromRoomId,
        toRoomId: gate.toRoomId,
      })),
      enemies: enemies.map((enemy) => ({ id: enemy.name, roomId: enemy.roomId, dead: enemy.dead })),
      livingEnemies: countLivingEnemies(),
      loot: lootDrops.map((drop) => ({ itemId: drop.itemId, collected: drop.collected })),
      objectives: {
        complete: runObjectivesComplete(),
        title: objective.textContent,
        detail: objectiveDetail.textContent,
      },
      finished: state.finished,
      failed: state.failed,
      interactionCount: state.interactionCount,
      lastInteraction: state.lastInteraction,
      windowRuntimeErrors: [...e2eState.errors],
    };
  }

  let lastPublishAt = -Infinity;
  function publishE2eSnapshot(force = false) {
    if (!e2eStatus) return;
    // Interface ticks call this every frame; serialize at most every 100 ms
    // unless a caller forces it (results, errors, readiness flips).
    const now = performance.now();
    if (!force && now - lastPublishAt < 100) return;
    lastPublishAt = now;
    const snapshot = e2eSnapshot();
    const serialized = JSON.stringify(snapshot);
    app.dataset.gameReady = String(state.loaded);
    app.dataset.e2eSnapshot = serialized;
    app.dataset.e2eResult = e2eState.lastResult ? JSON.stringify(e2eState.lastResult) : '';
    app.dataset.e2eErrors = JSON.stringify(e2eState.errors);
    e2eStatus.value = serialized;
    e2eStatus.textContent = serialized;
  }

  function sampleKeyboardSmokeMovement() {
    const smoke = e2eState.smoke;
    if (!smoke || !game.player) return;
    const position = game.player.root.position;
    if (smoke.sampleMode !== state.mode) {
      smoke.sampleMode = state.mode;
      smoke.sample = { x: position.x, z: position.z };
      return;
    }
    const dx = position.x - smoke.sample.x;
    const dz = position.z - smoke.sample.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 0.0001) {
      smoke.pathDistance += distance;
      smoke.forwardTravel += dx * smoke.cameraForward.x + dz * smoke.cameraForward.z;
    }
    smoke.sample = { x: position.x, z: position.z };
  }

  function setE2eResult(result) {
    e2eState.lastResult = result;
    publishE2eSnapshot(true);
  }

  e2eStatus = document.createElement('output');
  e2eStatus.id = 'e2e-status';
  e2eStatus.hidden = true;
  e2eStatus.setAttribute('aria-label', 'End-to-end test state');
  app.append(e2eStatus);
  window.addEventListener('error', (event) => {
    e2eState.errors.push(event.error?.message ?? event.message ?? 'runtime error');
    publishE2eSnapshot(true);
  });
  window.addEventListener('unhandledrejection', (event) => {
    e2eState.errors.push(String(event.reason?.message ?? event.reason ?? 'unhandled rejection'));
    publishE2eSnapshot(true);
  });

  // --- Profiling instrumentation (opt in through __cryptRun) ---
  window.__cryptProfile = null;
  window.__cryptDone = false;
  window.__cryptError = null;
  window.__cryptMark = (label) => {
    const profile = window.__cryptProfile;
    if (profile?.active) profile.marks.push({ t: performance.now(), label });
  };

  function diagnosticBlockReason() {
    if (!state.loaded) return 'Wait for the game to finish loading.';
    if (game.renderingPaused) return 'Wait for the graphics context to recover.';
    if (e2eState.activeDiagnostic) return 'Another diagnostic is already running.';
    if (e2eState.routeUsed || state.mode !== 'town' || state.teleporting) {
      return 'Reload the page to start a diagnostic from town.';
    }
    return '';
  }

  window.__cryptRun = async (instant = false) => {
    const blocked = diagnosticBlockReason();
    if (blocked) throw new Error(blocked);
    e2eState.activeDiagnostic = 'profile';
    e2eState.routeUsed = true;
    const profile = window.__cryptProfile ??= createCryptProfile();
    profile.frames.length = 0;
    profile.zones.length = 0;
    profile.marks.length = 0;
    profile.active = true;
    window.__cryptDone = false;
    window.__cryptError = null;
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const walkTo = (x, z, threshold = 0.3) => waitForProfileTarget({
      x,
      z,
      setTarget: (target) => { window.__cryptWalkTarget = target; },
      getPosition: () => game.player.root.position,
      wait,
      threshold,
    });
    const clearProfileRoom = () => clearEnemies((enemy) => enemy.roomId === state.currentRoomId);
    const openProfileGate = async (corridorId) => {
      const gate = findGate(corridorId);
      if (!gate) throw new Error(`Profile route has no gate for ${corridorId}.`);
      if (gate.open) return;
      await walkTo(gate.position.x, gate.position.z, 1.2);
      clearProfileRoom();
      openGate(gate);
      if (!gate.open) throw new Error(`Profile route could not open ${corridorId}.`);
      await wait(100);
    };
    try {
      window.__cryptMark('route:start');
      if (!instant) {
        const rowan = townNpcs.find((npc) => npc.role === 'Hunter');
        if (!rowan) throw new Error('Profile route could not find Ranger Rowan.');
        await walkTo(rowan.root.position.x, rowan.root.position.z);
        window.__cryptMark('town:at-rowan');
        talkToTownNpc(rowan);
        window.__cryptWalkTarget = null;
        await wait(1400);
        if (state.mode !== 'dungeon') throw new Error('Profile route did not enter the dungeon.');
      } else {
        enterDungeon();
        await wait(400);
      }
      window.__cryptMark('dungeon:entered');
      // Entrance -> hub.
      await openProfileGate('entry-corridor');
      await walkTo(3, 16);
      await walkTo(3, 12.5);
      await walkTo(-5, 12.5);
      window.__cryptMark('room:hub');
      await wait(1200); // let hub lights/shaders settle
      // West branch: gate corridor -> gate room -> burial -> ossuary.
      await openProfileGate('west-corridor');
      await walkTo(-26, 8);
      window.__cryptMark('room:westGate');
      await wait(800);
      await openProfileGate('west-deep-corridor');
      await walkTo(-47, 8);
      window.__cryptMark('room:westBurial');
      await walkTo(-49.3, 8);
      await walkTo(-49.3, 3.5);
      await walkTo(-47, 3.5);
      await openProfileGate('west-drop');
      await walkTo(-47, -2.5);
      window.__cryptMark('room:westOssuary');
      await wait(800);
      // Return to hub, cross east.
      await openProfileGate('west-drop');
      await walkTo(-47, 3.5);
      await walkTo(-49.3, 3.5);
      await walkTo(-49.3, 8);
      await openProfileGate('west-deep-corridor');
      await walkTo(-26, 8);
      await openProfileGate('west-corridor');
      await walkTo(-5, 7.5);
      await walkTo(5, 7.5);
      await openProfileGate('east-corridor');
      await walkTo(26, 8);
      window.__cryptMark('room:eastGate');
      await wait(800);
      await openProfileGate('east-deep-corridor');
      await walkTo(47, 8);
      window.__cryptMark('room:eastFlooded');
      await walkTo(49.3, 8);
      await walkTo(49.3, 3.2);
      await walkTo(47, 3.2);
      await openProfileGate('east-drop');
      await walkTo(47, -6);
      window.__cryptMark('room:eastReliquary');
    } catch (error) {
      window.__cryptError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      profile.active = false;
      window.__cryptDone = true;
      window.__cryptWalkTarget = null;
      e2eState.activeDiagnostic = null;
    }
  };

  // Auto-walk hook: when a profile target exists, the game's player update
  // calls this first and skips its keyboard movement for the frame.
  function autoWalk(delta) {
    const target = window.__cryptWalkTarget;
    const player = game.player;
    if (!target || !player || player.dead || player.attackLock > 0) return false;
    movementDirection.set(target.x - player.root.position.x, 0, target.z - player.root.position.z);
    const distance = movementDirection.length();
    if (distance <= 0.25) return false;
    movementDirection.normalize();
    moveActorWithinMap(player, movementDirection.x * player.speed * delta * 1.15, movementDirection.z * player.speed * delta * 1.15, 0.65);
    player.faceDirection(movementDirection);
    player.play(['running', 'walking']);
    state.started = true;
    state.combatStarted = true;
    sampleKeyboardSmokeMovement();
    return true;
  }

  // --- Fast functional-checkpoint surface (opt in through ?e2e) ---
  // Not a performance instrument: it bypasses animation time. Use __cryptRun
  // for any timing/frame measurement.
  const placeAt = (x, z) => {
    if (!game.player) throw new Error('World not built yet.');
    game.player.root.position.x = x;
    game.player.root.position.z = z;
    updateProgression();
    publishE2eSnapshot(true);
  };
  const clearAllEnemies = () => clearEnemies();
  const openFastGate = (corridorId) => {
    const gate = findGate(corridorId);
    if (!gate) throw new Error(`No gate for ${corridorId}.`);
    openGate(gate);
    if (!gate.open) throw new Error(`Fast route could not open ${corridorId}.`);
  };
  const interactChestAt = (id, x, z) => {
    placeAt(x, z);
    const chest = chestById(id);
    if (!chest) throw new Error(`Fast route has no chest for ${id}.`);
    interact();
    if (!chest.opened) throw new Error(`Fast route could not open ${id}.`);
  };
  const runFastCheckpoint = async () => {
    const blocked = diagnosticBlockReason();
    if (blocked) throw new Error(blocked);
    e2eState.activeDiagnostic = 'fast-checkpoint';
    e2eState.routeUsed = true;
    setE2eResult(null);
    const startedAt = performance.now();
    e2eState.fastGateTransitions = 0;
    try {
      enterDungeon();
      state.started = true;
      clearAllEnemies();
      const lootDrop = createLootVisual('healingDraft', game.player.root.position);
      const lootGroup = zoneRenderGroups.get(lootDrop.zoneId);
      const lootPhase = lootDrop.phase;
      updateZoneVisibility('hub', true);
      updateLootDrops(0.1);
      const lootHidden = lootDrop.root.parent === lootGroup
        && !lootGroup.visible && lootDrop.phase === lootPhase && nearestLootDrop(2) === null;
      updateZoneVisibility('entrance', true);
      updateLootDrops(0.1);
      const lootRevealed = lootGroup.visible && lootDrop.phase !== lootPhase && nearestLootDrop(2) === lootDrop;
      interact();

      placeAt(0, 26.8);
      openFastGate('entry-corridor');
      placeAt(0, 12);
      interactChestAt('hub-cache', 0, 14.2);

      openFastGate('west-corridor');
      placeAt(-26, 9);
      openFastGate('west-deep-corridor');
      placeAt(-47, 9);
      interactChestAt('ashen-cache', -47, 10);
      openFastGate('west-drop');
      interactChestAt('west-seal', -47, -13);

      openFastGate('west-drop');
      placeAt(-47, 9);
      openFastGate('west-deep-corridor');
      placeAt(-26, 9);
      openFastGate('west-corridor');
      placeAt(0, 12);
      openFastGate('east-corridor');
      placeAt(26, 9);
      openFastGate('east-deep-corridor');
      placeAt(47, 9);
      interactChestAt('drowned-cache', 47, 10);
      openFastGate('east-drop');
      interactChestAt('east-seal', 47, -12.5);

      openFastGate('east-drop');
      placeAt(47, 9);
      openFastGate('east-deep-corridor');
      placeAt(26, 9);
      openFastGate('east-corridor');
      placeAt(0, 12);
      openFastGate('north-corridor');
      placeAt(0, -10);
      openFastGate('archive-corridor');
      placeAt(0, -24);
      interactChestAt('archive-key', 0, -27);
      openFastGate('warden-corridor');
      placeAt(0, -42);
      interactChestAt('warden-spoils', 0, -47.5);
      openFastGate('warden-corridor');
      placeAt(0, -24);
      openFastGate('archive-corridor');
      placeAt(0, -10);
      openFastGate('north-corridor');
      placeAt(0, 12);
      openFastGate('entry-corridor');
      placeAt(0, 32.4);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const snapshot = e2eSnapshot();
      const requiredChestIds = ['west-seal', 'east-seal', 'archive-key', 'warden-spoils'];
      const assertions = {
        finished: snapshot.finished && !snapshot.failed,
        seals: snapshot.seals.west && snapshot.seals.east,
        archiveKey: snapshot.archiveKey,
        requiredChests: requiredChestIds.every((id) => snapshot.chests.find((chest) => chest.id === id)?.opened),
        lootHidden,
        lootRevealed,
        lootCollected: lootDrop.collected && lootDrop.root.parent === null,
        interacted: snapshot.interactionCount >= requiredChestIds.length + 4,
        gateTraversal: e2eState.fastGateTransitions === state.gates.length * 2
          && snapshot.gates.every((gate) => !gate.open),
        objectives: snapshot.objectives.complete,
      };
      setE2eResult({
        kind: 'fast-functional-checkpoint',
        pass: Object.values(assertions).every(Boolean),
        durationMs: Math.round(performance.now() - startedAt),
        assertions,
        snapshot,
      });
    } catch (error) {
      setE2eResult({
        kind: 'fast-functional-checkpoint',
        pass: false,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
        snapshot: e2eSnapshot(),
      });
    } finally {
      e2eState.activeDiagnostic = null;
    }
  };
  const startKeyboardSmoke = () => {
    const blocked = diagnosticBlockReason();
    if (blocked) throw new Error(blocked);
    e2eState.activeDiagnostic = 'keyboard-smoke';
    clearInputState();
    const rowan = townNpcs.find((npc) => npc.role === 'Hunter');
    if (rowan) game.player.root.position.copy(rowan.root.position);
    state.lastInteraction = null;
    camera.getWorldDirection(cameraForward);
    cameraForward.y = 0;
    cameraForward.normalize();
    e2eState.smoke = {
      startedAt: performance.now(),
      cameraForward: { x: cameraForward.x, z: cameraForward.z },
      interactionBefore: state.interactionCount,
      lastInteractionBefore: state.lastInteraction,
      errorsBefore: e2eState.errors.length,
      sampleMode: state.mode,
      sample: { x: game.player.root.position.x, z: game.player.root.position.z },
      pathDistance: 0,
      forwardTravel: 0,
    };
    setE2eResult(null);
  };
  const finishKeyboardSmoke = () => {
    if (e2eState.activeDiagnostic && e2eState.activeDiagnostic !== 'keyboard-smoke') return;
    const smoke = e2eState.smoke;
    if (!smoke) {
      setE2eResult({ kind: 'keyboard-smoke', pass: false, error: 'Smoke was not started.' });
      return;
    }
    e2eState.smoke = null;
    e2eState.activeDiagnostic = null;
    const distance = smoke.pathDistance;
    const forwardDot = distance > 0.001 ? smoke.forwardTravel / distance : 0;
    const assertions = {
      cameraRelativeW: distance > 0.1 && forwardDot > 0.55,
      interacted: state.interactionCount > smoke.interactionBefore
        && state.lastInteraction !== smoke.lastInteractionBefore
        && state.lastInteraction?.kind === 'npc',
      windowRuntimeErrors: e2eState.errors.length === smoke.errorsBefore,
    };
    setE2eResult({
      kind: 'keyboard-smoke',
      pass: Object.values(assertions).every(Boolean),
      durationMs: Math.round(performance.now() - smoke.startedAt),
      assertions,
      errorSources: ['window.error', 'unhandledrejection'],
      movement: { distance, forwardDot },
      snapshot: e2eSnapshot(),
    });
  };

  const panel = document.createElement('section');
  panel.id = 'e2e-controls';
  panel.setAttribute('aria-label', 'Browser validation controls');
  panel.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;display:flex;gap:4px;';
  const addCommand = (command, label, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.e2eCommand = command;
    button.textContent = label;
    button.addEventListener('click', async () => {
      if (e2eState.activeDiagnostic
        && (command !== 'smoke-finish' || e2eState.activeDiagnostic !== 'keyboard-smoke')) return;
      try {
        await handler();
      } catch (error) {
        setE2eResult({ kind: command, pass: false, error: error instanceof Error ? error.message : String(error), snapshot: e2eSnapshot() });
      }
      publishE2eSnapshot(true);
    });
    panel.append(button);
  };
  addCommand('smoke-start', 'Start keyboard smoke', startKeyboardSmoke);
  addCommand('smoke-finish', 'Finish keyboard smoke', finishKeyboardSmoke);
  addCommand('fast-checkpoint', 'Run fast checkpoint', runFastCheckpoint);
  app.append(panel);

  window.__cryptTest = {
    snapshot: e2eSnapshot,
    enterDungeon,
    placeAt,
    clearRoom() {
      clearEnemies((enemy) => enemy.roomId === state.currentRoomId);
    },
    openGateById(corridorId) {
      const gate = findGate(corridorId);
      if (!gate) throw new Error(`No gate for ${corridorId}.`);
      openGate(gate);
      return gate.open;
    },
  };

  return {
    publish: publishE2eSnapshot,
    onGateTraversal() {
      e2eState.fastGateTransitions += 1;
    },
    sampleMovement: sampleKeyboardSmokeMovement,
    autoWalk,
  };
}
