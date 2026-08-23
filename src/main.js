import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { brickWallCornerRotation, brickWallDimensions } from './crypt-wall-geometry.js';
import {
  collectDungeonLightRecipes,
  createCryptProfile,
  createSlotPool,
  waitForProfileTarget,
} from './optimization-contracts.js';
import {
  cameraRelativeDirection,
  createNavigationContext,
  isWalkablePoint,
  stepActorWithinMap,
} from './movement-contracts.js';
import { initAudio, playSfx } from './audio.js';
import { WORLD_DATA } from './world-data.js';
import { ROOM_DECORATIONS } from './game/room-decorations.js';
import {
  EXIT_POSITION,
  HEAL_FRACTION,
  INTERACT_RADII,
  applyChestRewards,
  attackDamage,
  computeZoneNeighbors,
  evaluateChestBlock,
  evaluateGateOpen,
  isRunVictory,
  lootItemForProfile,
  playerDamage as computePlayerDamage,
  resolveRoomEntry,
  runObjectivesComplete as evaluateObjectivesComplete,
  visibleZoneIdsFor,
} from './game/world-rules.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);

const canvas = $('#scene');
const app = $('#app');
const E2E_ENABLED = new URLSearchParams(window.location.search).has('e2e');
const loadingScreen = $('#loading');
const loadingFill = $('#loading-fill');
const loadingLabel = $('#loading-label');
const endScreen = $('#end-screen');
const endEyebrow = $('#end-eyebrow');
const endTitle = $('#end-title');
const endCopy = $('#end-copy');
const restartButton = $('#restart-button');
const objective = $('#objective');
const objectiveDetail = $('#objective-detail');
const healthValue = $('#health-value');
const healthFill = $('#health-fill');
const threatValue = $('#threat-value');
const targetCard = $('#target-card');
const targetName = $('#target-name');
const targetFill = $('#target-fill');
const targetStatus = $('#target-status');
const playerStatus = $('#player-status');
const interaction = $('#interaction');
const toast = $('#toast');
const abilitySlots = [...document.querySelectorAll('[data-ability]')];
const minimap = $('#minimap');
const minimapContext = minimap.getContext('2d');
const areaName = $('#area-name');
const minimapLabel = $('#minimap-label');
const backpackSlots = [...document.querySelectorAll('[data-inventory-slot]')];
const equippedItem = $('#equipped-item');
const abilityStrip = $('#ability-strip');
const backpackCard = $('#backpack-card');
const dialogueCard = $('#dialogue-card');
const dialogueName = $('#dialogue-name');
const dialogueCopy = $('#dialogue-copy');

const MAX_RENDER_PIXEL_RATIO = 1.25;
const MAX_RENDER_PIXELS = 1920 * 1080;
const MIN_RESOLUTION_SCALE = 0.65;
const RESOLUTION_SAMPLE_SECONDS = 1;
const RESOLUTION_DOWNSHIFT_MS = 20;
const RESOLUTION_UPSHIFT_MS = 17.2;
const RESOLUTION_STEP_DOWN = 0.1;
const RESOLUTION_STEP_UP = 0.05;
const RESOLUTION_CHANGE_COOLDOWN = 1.5;
const MAX_BLOB_SHADOWS = 64;
const ROOM_ENTRY_CLEARANCE = 1.1;
const DISTANT_ANIMATION_INTERVAL = 0.1;
const FULL_ANIMATION_DISTANCE_SQ = 30 ** 2;
const ENEMY_SIMULATION_DISTANCE_SQ = 18 ** 2;
const ENEMY_RENDER_DISTANCE_SQ = 34 ** 2;

const ASSETS = WORLD_DATA.assets;
const ACTIONS = Object.fromEntries(Object.entries(WORLD_DATA.actions).map(([id, action]) => [id, {
  cooldown: action.cooldown,
  range: action.range,
}]));
const ACTION_NAMES = Object.fromEntries(Object.entries(WORLD_DATA.actions).map(([id, action]) => [id, action.name]));
const ACTION_BAR_KEYS = Object.fromEntries(Object.entries(WORLD_DATA.actions).map(([id, action]) => [id, action.keys]));

const ACTION_BY_KEY = new Map(
  Object.entries(ACTION_BAR_KEYS).flatMap(([action, codes]) => codes.map((code) => [code, action])),
);

// Per-action runtime constants that are presentation/timing concerns rather
// than world data: windup locks, recovery, cast clips, and resolve behavior.
// One row per action instead of ternaries scattered through useAction and
// applyPlayerAction.
const SPELL_COLORS = Object.fromEntries(Object.entries(WORLD_DATA.actions)
  .filter(([, action]) => action.spellColor)
  .map(([id, action]) => [id, action.spellColor]));
const SPELL_CAST_TIMES = Object.fromEntries(Object.entries(WORLD_DATA.actions)
  .filter(([, action]) => action.castTime !== undefined)
  .map(([id, action]) => [id, action.castTime]));

// Per-action runtime constants that are presentation/timing concerns rather
// than world data: windup locks, recovery, cast clips/timers, and resolve
// behavior. One row per action instead of ternaries scattered through
// useAction and applyPlayerAction.
const ACTION_RUNTIME = {
  sword: { attackLock: 0.67, attackCooldown: 0.52, attackTimer: 0.24, clips: ['1h_melee_attack', 'melee_attack', 'attack'], spell: false },
  fire: { attackLock: 0.58, attackCooldown: 0.78, attackTimer: SPELL_CAST_TIMES.fire, castClip: 'Cast_Fire', spell: true },
  freeze: { attackLock: 0.58, attackCooldown: 0.78, attackTimer: SPELL_CAST_TIMES.freeze, castClip: 'Cast_Frost', spell: true },
  heal: { attackLock: 0.62, attackCooldown: 0.65, attackTimer: SPELL_CAST_TIMES.heal, castClip: 'Cast_Heal' },
  buff: { attackLock: 0.56, attackCooldown: 0.65, attackTimer: SPELL_CAST_TIMES.buff, castClip: 'Cast_Arcane' },
};
const ITEM_DEFS = WORLD_DATA.items;
const ENEMY_PROFILES = WORLD_DATA.enemyProfiles;
const WORLD = WORLD_DATA.world;
const TOWN_WORLD = WORLD_DATA.town.bounds;
const MAP = WORLD_DATA.map;
const ROOM_BRANCH = WORLD_DATA.roomBranch;

MAP.zones = [...MAP.rooms, ...MAP.corridors];
const corridorZones = new Set(MAP.corridors);
const ZONE_BY_ID = new Map(MAP.zones.map((zone) => [zone.id, zone]));
const ROOM_IDS = new Set(MAP.rooms.map((room) => room.id));
const ZONE_NEIGHBORS = computeZoneNeighbors(MAP.zones);

const state = {
  loaded: false,
  mode: 'town',
  teleporting: false,
  started: false,
  combatStarted: false,
  finished: false,
  failed: false,
  playerHp: 100,
  playerMaxHp: 100,
  playerBuffTimer: 0,
  actionCooldowns: Object.fromEntries(Object.keys(ACTIONS).map((key) => [key, 0])),
  seals: { west: false, east: false },
  archiveKey: false,
  discoveredRooms: new Set(['entrance']),
  currentRoomId: 'entrance',
  currentZoneId: null,
  gates: [],
  chests: [],
  openedChests: 0,
  wardenSummoned: false,
  minimapTimer: 0,
  inventory: Array(6).fill(null),
  equippedSlot: null,
  weaponReadyTimer: 0,
  footstepTimer: 0,
  cameraShake: 0,
  cameraFovKick: 0,
  cameraOffset: new THREE.Vector3(),
  // The player uses (x, y, z) with y fixed at ground level; the southern exit
  // is in the entrance room at z=32.4.
  exitPosition: new THREE.Vector3(EXIT_POSITION.x, 0, EXIT_POSITION.z),
  elapsed: 0,
  uiTimer: 0,
  overlayTimer: 0,
  weaponUiSheathed: null,
  resolutionScale: 1,
  frameSampleSeconds: 0,
  frameSampleFrames: 0,
  resolutionCooldown: 0,
  fastFrameSamples: 0,
  interactionCount: 0,
  lastInteraction: null,
};

const keys = new Set();
const assets = new Map();
const enemies = [];
const townNpcs = [];
const staticColliders = [];
const townStaticColliders = [];
const effects = [];
const spellProjectiles = [];
const spellVisuals = [];
const telegraphs = [];
const combatTexts = [];
const lootDrops = [];
const zoneRenderGroups = new Map();
const visibleZoneIds = new Set();
const navigation = createNavigationContext({
  getMode: () => state.mode,
  townBounds: TOWN_WORLD,
  worldBounds: WORLD,
  mapZones: MAP.zones,
  corridorZoneIds: corridorZones,
  staticColliders,
  townStaticColliders,
});
const e2eState = {
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
    position: player
      ? { x: player.root.position.x, y: player.root.position.y, z: player.root.position.z }
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
  if (!E2E_ENABLED || !e2eStatus) return;
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
  if (!smoke || !player) return;
  const position = player.root.position;
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

if (E2E_ENABLED) {
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
}

let activeWorldGroup = null;
const dungeonScene = new THREE.Scene();
const townScene = new THREE.Scene();
const scene = dungeonScene;
dungeonScene.background = new THREE.Color('#090b14');
dungeonScene.fog = new THREE.FogExp2('#090b14', 0.018);
townScene.background = new THREE.Color('#6e8f88');
townScene.fog = new THREE.Fog('#6e8f88', 28, 58);

const camera = new THREE.PerspectiveCamera(43, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(10.6, 11.5, 12.2);

function rendererPixelRatio() {
  const viewportPixels = Math.max(1, window.innerWidth * window.innerHeight);
  const pixelBudgetRatio = Math.sqrt(MAX_RENDER_PIXELS / viewportPixels);
  const baseRatio = Math.max(0.5, Math.min(window.devicePixelRatio, MAX_RENDER_PIXEL_RATIO, pixelBudgetRatio));
  return baseRatio * state.resolutionScale;
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(rendererPixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 7;
controls.maxDistance = 32;
controls.minPolarAngle = THREE.MathUtils.degToRad(32);
controls.maxPolarAngle = THREE.MathUtils.degToRad(78);
controls.target.set(0, 0.8, 0);
controls.update();

const loader = new GLTFLoader();
const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/');
ktx2Loader.detectSupport(renderer);
loader.setKTX2Loader(ktx2Loader);
loader.setMeshoptDecoder(MeshoptDecoder);

const clock = new THREE.Clock();
const tempVector = new THREE.Vector3();
const tempBox = new THREE.Box3();
const tempSize = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const projectedAnchor = new THREE.Vector3();
const spellOrigin = new THREE.Vector3();
const spellTarget = new THREE.Vector3();
const movementDirection = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);

let player;
let toastTimeout;
let pointerPress = null;
let selectedTarget = null;
function addCameraFeedback(shake = 0.08, fovKick = 0.8) {
  state.cameraShake = Math.max(state.cameraShake, shake);
  state.cameraFovKick = Math.max(state.cameraFovKick, fovKick);
}

function alignVisualToGround(visual, desiredHeight) {
  visual.updateMatrixWorld(true);
  tempBox.setFromObject(visual);
  tempBox.getSize(tempSize);
  if (desiredHeight && tempSize.y > 0.001) {
    visual.scale.multiplyScalar(desiredHeight / tempSize.y);
    visual.updateMatrixWorld(true);
    tempBox.setFromObject(visual);
  }
  visual.position.y -= tempBox.min.y;
  visual.updateMatrixWorld(true);
}

function fitStaticVisual(visual, { width, depth, height, stretch = false } = {}) {
  visual.updateMatrixWorld(true);
  tempBox.setFromObject(visual);
  tempBox.getSize(tempSize);
  const factors = [];
  if (width && tempSize.x > 0.001) factors.push(width / tempSize.x);
  if (depth && tempSize.z > 0.001) factors.push(depth / tempSize.z);
  if (height && tempSize.y > 0.001) factors.push(height / tempSize.y);
  if (factors.length) {
    if (stretch) {
      if (width && tempSize.x > 0.001) visual.scale.x *= width / tempSize.x;
      if (depth && tempSize.z > 0.001) visual.scale.z *= depth / tempSize.z;
      if (height && tempSize.y > 0.001) visual.scale.y *= height / tempSize.y;
    } else {
      visual.scale.multiplyScalar(Math.min(...factors));
    }
    visual.updateMatrixWorld(true);
    tempBox.setFromObject(visual);
  }
  visual.position.y -= tempBox.min.y;
  visual.updateMatrixWorld(true);
}

function findClip(clips, patterns) {
  const wanted = patterns.map((pattern) => pattern.toLowerCase());
  return clips.find((clip) => {
    const name = clip.name.toLowerCase();
    return wanted.some((pattern) => name.includes(pattern));
  });
}

function cloneAbilityClip(clips, name, sourcePatterns, speed = 1) {
  const source = findClip(clips, sourcePatterns);
  if (!source) return null;
  const clip = source.clone();
  clip.name = name;
  if (speed !== 1) {
    clip.tracks = clip.tracks.map((track) => {
      const next = track.clone();
      next.times = Float32Array.from(track.times, (time) => time / speed);
      return next;
    });
    clip.resetDuration();
  }
  return clip;
}

function createAbilityClips(clips) {
  // ClaudeCraft uses these school-level names. We derive the same small set
  // from the local CC0 rig so the demo keeps its own asset provenance.
  return [
    cloneAbilityClip(clips, 'Cast_Fire', ['spellcast_shoot'], 2.9),
    cloneAbilityClip(clips, 'Cast_Frost', ['spellcast_raise'], 4.3),
    cloneAbilityClip(clips, 'Cast_Arcane', ['spellcasting'], 1.85),
    cloneAbilityClip(clips, 'Cast_Heal', ['spellcast_raise'], 4.8),
  ].filter(Boolean);
}

function attachEquipment(visual, assetKey, boneName, { scale = 1, position = [0, 0, 0], rotation = [0, 0, 0] } = {}) {
  const attachmentNames = [boneName, boneName.replace(/[._]/g, '')];
  const attachmentPoint = attachmentNames.map((name) => visual.getObjectByName(name)).find(Boolean);
  const source = assets.get(assetKey);
  if (!attachmentPoint || !source) return null;
  const equipment = source.scene.clone(true);
  equipment.position.set(...position);
  equipment.rotation.set(...rotation);
  equipment.scale.setScalar(scale);
  equipment.traverse((child) => {
    if (!child.isMesh) return;
    if (Array.isArray(child.material)) child.material = child.material.map((material) => material.clone());
    else if (child.material) child.material = child.material.clone();
  });
  attachmentPoint.add(equipment);
  return equipment;
}

function createEnemyNameplate(actor) {
  const element = document.createElement('div');
  element.className = 'enemy-nameplate is-hidden';
  const name = document.createElement('span');
  name.className = 'enemy-nameplate-name';
  name.textContent = actor.name;
  const healthTrack = document.createElement('div');
  healthTrack.className = 'enemy-nameplate-track';
  const healthFillElement = document.createElement('span');
  healthTrack.append(healthFillElement);
  const cast = document.createElement('div');
  cast.className = 'enemy-cast is-hidden';
  const castLabel = document.createElement('span');
  castLabel.className = 'enemy-cast-label';
  const castTrack = document.createElement('div');
  castTrack.className = 'enemy-cast-track';
  const castFill = document.createElement('span');
  castTrack.append(castFill);
  cast.append(castLabel, castTrack);
  element.append(name, healthTrack, cast);
  document.body.append(element);
  return { element, healthFill: healthFillElement, cast, castLabel, castFill };
}

function createTownNameplate(actor) {
  const element = document.createElement('div');
  element.className = 'town-nameplate is-hidden';
  const name = document.createElement('span');
  name.className = 'town-nameplate-name';
  name.textContent = actor.name;
  const role = document.createElement('small');
  role.className = 'town-nameplate-role';
  role.textContent = actor.role;
  element.append(name, role);
  document.body.append(element);
  return { element };
}

class Actor {
  constructor({
    assetKey,
    type,
    position,
    height,
    name,
    role = 'resident',
    maxHp = 1,
    speed = 0,
    profileKey = 'guard',
    roomId = null,
    sceneRoot = scene,
  }) {
    const source = assets.get(assetKey);
    this.name = name;
    this.role = role;
    this.type = type;
    this.root = new THREE.Group();
    this.root.userData.actor = this;
    this.root.position.copy(position);
    this.spawnPosition = position.clone();
    this.visual = SkeletonUtils.clone(source.scene);
    alignVisualToGround(this.visual, height);
    this.handWeapon = null;
    this.backWeapon = null;
    this.weaponSheathed = false;
    if (type === 'player') {
      this.handWeapon = attachEquipment(this.visual, 'sword', 'hand.r', {
        scale: 1.05,
        // The exported sword origin sits just below the grip. Rotate the
        // blade forward from the hand and pull that grip back onto the bone.
        position: [0.16, 0, 0],
        rotation: [0, 0, Math.PI / 2],
      });
      this.backWeapon = attachEquipment(this.visual, 'sword', 'chest', {
        scale: 1.05,
        position: [0.06, 0.18, -0.18],
        rotation: [Math.PI / 2, 0, -0.18],
      });
      this.setWeaponSheathed(true);
    }
    this.root.add(this.visual);
    sceneRoot.add(this.root);

    this.mixer = new THREE.AnimationMixer(this.visual);
    this.clips = [...(source.animations ?? [])];
    if (type === 'player') this.clips.push(...createAbilityClips(this.clips));
    this.actions = new Map();
    this.currentAction = null;
    this.currentClipName = '';
    this.attackLock = 0;
    this.attackTimer = 0;
    this.attackPending = false;
    this.attackCooldown = 0;
    this.pendingAction = null;
    this.pendingEnemyAttack = null;
    this.animationAccumulator = 0;
    this.frozenTimer = 0;
    this.specialCooldown = profileKey === 'warden' ? 3.5 : 0;
    this.bossPhase = profileKey === 'warden' ? 1 : 0;
    this.deathTimer = 0;
    this.height = height;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.speed = speed;
    this.profileKey = profileKey;
    this.roomId = roomId;
    this.townPatrol = null;
    this.dead = false;
    this.awake = type === 'player';
    this.evading = false;
    this.lootDropped = false;
    this.nameplate = type === 'enemy'
      ? createEnemyNameplate(this)
      : type === 'npc'
        ? createTownNameplate(this)
        : null;
    this.play(type === 'player' ? ['idle'] : ['idle_combat', 'idle']);
  }

  setWeaponSheathed(sheathed) {
    if (this.type !== 'player' || this.weaponSheathed === sheathed) return;
    this.weaponSheathed = sheathed;
    if (this.handWeapon) this.handWeapon.visible = !sheathed;
    if (this.backWeapon) this.backWeapon.visible = sheathed;
  }

  setWeaponColor(color) {
    const tint = new THREE.Color(color ?? '#d8c6a5');
    for (const weapon of [this.handWeapon, this.backWeapon]) {
      weapon?.traverse((child) => {
        if (!child.isMesh) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (!material) continue;
          if ('emissive' in material) material.emissive.copy(tint).multiplyScalar(color ? 0.16 : 0);
          if ('emissiveIntensity' in material) material.emissiveIntensity = color ? 0.75 : 0;
        }
      });
    }
  }

  actionFor(clip) {
    if (!clip) return null;
    if (!this.actions.has(clip.name)) this.actions.set(clip.name, this.mixer.clipAction(clip));
    return this.actions.get(clip.name);
  }

  play(patterns, { once = false, force = false } = {}) {
    const clip = findClip(this.clips, patterns);
    if (!clip) return;
    if (!force && this.currentClipName === clip.name) return;
    const next = this.actionFor(clip);
    const previous = this.currentAction;
    if (previous && previous !== next) previous.fadeOut(0.11);
    next.reset().fadeIn(0.11);
    if (once) {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }
    next.play();
    this.currentAction = next;
    this.currentClipName = clip.name;
  }

  face(position) {
    const dx = position.x - this.root.position.x;
    const dz = position.z - this.root.position.z;
    if (Math.abs(dx) + Math.abs(dz) > 0.001) this.root.rotation.y = Math.atan2(dx, dz);
  }

  faceDirection(direction) {
    if (Math.abs(direction.x) + Math.abs(direction.z) > 0.001) {
      this.root.rotation.y = Math.atan2(direction.x, direction.z);
    }
  }

  update(delta, animationInterval = 0) {
    if (animationInterval !== null) {
      this.animationAccumulator += delta;
      if (animationInterval <= 0 || this.animationAccumulator >= animationInterval) {
        this.mixer.update(this.animationAccumulator);
        this.animationAccumulator = 0;
      }
    }
    this.attackCooldown = Math.max(0, this.attackCooldown - delta);
    this.attackLock = Math.max(0, this.attackLock - delta);
    this.frozenTimer = Math.max(0, this.frozenTimer - delta);
    this.specialCooldown = Math.max(0, this.specialCooldown - delta);
  }
}

function addWorldObject(object, parent = null) {
  (parent ?? activeWorldGroup ?? scene).add(object);
  return object;
}

function buildZoneRenderGroup(zone, build) {
  const group = new THREE.Group();
  group.name = `zone:${zone.id}`;
  zoneRenderGroups.set(zone.id, group);
  scene.add(group);
  const previousGroup = activeWorldGroup;
  activeWorldGroup = group;
  try {
    build();
  } finally {
    activeWorldGroup = previousGroup;
  }
}

function createStatic(assetKey, {
  x = 0,
  y = 0,
  z = 0,
  rotationY = 0,
  width,
  depth,
  height,
  stretch = false,
  colliderWidth = 0,
  colliderDepth = 0,
  parent = null,
  colliders = staticColliders,
} = {}) {
  const source = assets.get(assetKey);
  const root = new THREE.Group();
  const visual = source.scene.clone(true);
  fitStaticVisual(visual, { width, depth, height, stretch });
  root.add(visual);
  root.position.set(x, y, z);
  root.rotation.y = rotationY;
  addWorldObject(root, parent);
  if (colliderWidth > 0 && colliderDepth > 0) {
    const quarterTurn = Math.abs(Math.sin(rotationY)) > 0.5;
    const collider = {
      root,
      minX: x - (quarterTurn ? colliderDepth : colliderWidth) / 2,
      maxX: x + (quarterTurn ? colliderDepth : colliderWidth) / 2,
      minZ: z - (quarterTurn ? colliderWidth : colliderDepth) / 2,
      maxZ: z + (quarterTurn ? colliderWidth : colliderDepth) / 2,
    };
    root.userData.staticCollider = collider;
    colliders.push(collider);
  }
  return root;
}

function createGateStatic({ x, z, travelsAlongZ, span, height, parent }) {
  const source = assets.get('archGate');
  const root = new THREE.Group();
  const visual = source.scene.clone(true);

  visual.updateMatrixWorld(true);
  tempBox.setFromObject(visual);
  tempBox.getSize(tempSize);
  const localSpanAxis = tempSize.x >= tempSize.z ? 'x' : 'z';
  const heightScale = height / tempSize.y;
  visual.scale.setScalar(heightScale);
  visual.updateMatrixWorld(true);

  tempBox.setFromObject(visual);
  tempBox.getSize(tempSize);
  visual.scale[localSpanAxis] *= span / tempSize[localSpanAxis];
  visual.updateMatrixWorld(true);

  tempBox.setFromObject(visual);
  const center = tempBox.getCenter(new THREE.Vector3());
  visual.position.x -= center.x;
  visual.position.y -= tempBox.min.y;
  visual.position.z -= center.z;
  visual.updateMatrixWorld(true);
  root.add(visual);
  root.position.set(x, 0, z);
  const localSpanAlongX = localSpanAxis === 'x';
  root.rotation.y = localSpanAlongX === travelsAlongZ ? 0 : Math.PI / 2;
  addWorldObject(root, parent);

  const colliderWidth = travelsAlongZ ? span : 0.65;
  const colliderDepth = travelsAlongZ ? 0.65 : span;
  const collider = {
    root,
    minX: x - colliderWidth / 2,
    maxX: x + colliderWidth / 2,
    minZ: z - colliderDepth / 2,
    maxZ: z + colliderDepth / 2,
  };
  root.userData.staticCollider = collider;
  staticColliders.push(collider);
  return root;
}

function shiftStaticObject(root, offsetX, offsetZ) {
  root.position.x += offsetX;
  root.position.z += offsetZ;
  const collider = root.userData.staticCollider;
  if (!collider) return;
  collider.minX += offsetX;
  collider.maxX += offsetX;
  collider.minZ += offsetZ;
  collider.maxZ += offsetZ;
}

function createFloorTiles(placements) {
  const source = assets.get('floorTile');
  const template = source.scene.clone(true);
  fitStaticVisual(template, { width: 1.92, depth: 1.92 });
  template.updateMatrixWorld(true);

  const translation = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  template.traverse((child) => {
    if (!child.isMesh) return;
    const tiles = new THREE.InstancedMesh(child.geometry, child.material, placements.length);
    tiles.name = 'instanced-floor-tiles';
    placements.forEach(({ x, z }, index) => {
      translation.makeTranslation(x, 0, z);
      instanceMatrix.multiplyMatrices(translation, child.matrixWorld);
      tiles.setMatrixAt(index, instanceMatrix);
    });
    tiles.instanceMatrix.needsUpdate = true;
    tiles.computeBoundingSphere();
    addWorldObject(tiles);
  });
}

function addBox({
  x,
  y,
  z,
  width,
  height,
  depth,
  material,
  colliderWidth = 0,
  colliderDepth = 0,
  parent = null,
}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  addWorldObject(mesh, parent);
  if (colliderWidth > 0 && colliderDepth > 0) {
    const collider = {
      root: mesh,
      minX: x - colliderWidth / 2,
      maxX: x + colliderWidth / 2,
      minZ: z - colliderDepth / 2,
      maxZ: z + colliderDepth / 2,
    };
    mesh.userData.staticCollider = collider;
    staticColliders.push(collider);
  }
  return mesh;
}

// Point-light pool: the dungeon uses a fixed set of always-visible lights whose
// positions/colors/intensities are re-applied per zone view. Keeping the visible
// light count constant avoids shader program recompilation hitches when rooms
// toggle visibility.
const DUNGEON_LIGHT_POOL_SIZE = 5;

let dungeonLightPool = [];
const dungeonZoneLights = new Map();

function recordZoneLight(zoneId, { x, z, color = 0xffbd74, intensity = 2.4 }) {
  if (!dungeonZoneLights.has(zoneId)) dungeonZoneLights.set(zoneId, []);
  dungeonZoneLights.get(zoneId).push({ x, z, color, intensity });
}

function applyDungeonLights() {
  const recipes = collectDungeonLightRecipes(visibleZoneIds, dungeonZoneLights, DUNGEON_LIGHT_POOL_SIZE);
  for (let index = 0; index < dungeonLightPool.length; index += 1) {
    const light = dungeonLightPool[index];
    const recipe = recipes[index];
    if (!recipe) {
      // Lights stay in the scene and "on" at all times; unused slots drop to
      // zero intensity so the shader's light count never changes.
      light.position.set(0, -50, 0);
      light.intensity = 0;
      continue;
    }
    light.color.set(recipe.color);
    light.intensity = recipe.intensity;
    light.position.set(recipe.x, 2.2, recipe.z);
  }
}

function buildDungeonLightPool() {
  for (let index = 0; index < DUNGEON_LIGHT_POOL_SIZE; index += 1) {
    const light = new THREE.PointLight(0xffbd74, 0, 7, 2);
    light.position.set(0, -50, 0);
    dungeonScene.add(light);
    dungeonLightPool.push(light);
  }
}

function buildLighting() {
  scene.add(new THREE.HemisphereLight(0x8886b3, 0x17131b, 1.7));
  moonLight = new THREE.DirectionalLight(0xc8c9ff, 2.1);
  moonLight.position.set(-5, 12, 7);
  scene.add(moonLight, moonLight.target);
}

function resetFrameSample() {
  state.frameSampleSeconds = 0;
  state.frameSampleFrames = 0;
}

function applyAdaptiveResolutionScale(nextScale) {
  const clamped = THREE.MathUtils.clamp(nextScale, MIN_RESOLUTION_SCALE, 1);
  if (Math.abs(clamped - state.resolutionScale) < 0.001) return;
  state.resolutionScale = clamped;
  renderer.setPixelRatio(rendererPixelRatio());
  state.resolutionCooldown = RESOLUTION_CHANGE_COOLDOWN;
}

function updateAdaptiveQuality(frameDelta) {
  if (!state.loaded || document.hidden || frameDelta <= 0 || frameDelta > 0.25) {
    resetFrameSample();
    return;
  }
  state.resolutionCooldown = Math.max(0, state.resolutionCooldown - frameDelta);
  state.frameSampleSeconds += frameDelta;
  state.frameSampleFrames += 1;
  if (state.frameSampleSeconds < RESOLUTION_SAMPLE_SECONDS) return;

  const averageFrameMs = (state.frameSampleSeconds * 1000) / state.frameSampleFrames;
  resetFrameSample();
  if (state.resolutionCooldown <= 0) {
    if (averageFrameMs > RESOLUTION_DOWNSHIFT_MS && state.resolutionScale > MIN_RESOLUTION_SCALE) {
      state.fastFrameSamples = 0;
      applyAdaptiveResolutionScale(state.resolutionScale - RESOLUTION_STEP_DOWN);
    } else if (averageFrameMs < RESOLUTION_UPSHIFT_MS && state.resolutionScale < 1) {
      state.fastFrameSamples += 1;
      if (state.fastFrameSamples >= 2) {
        state.fastFrameSamples = 0;
        applyAdaptiveResolutionScale(state.resolutionScale + RESOLUTION_STEP_UP);
      }
    } else {
      state.fastFrameSamples = 0;
    }
  }
}

function buildBlobShadows() {
  const geometry = new THREE.CircleGeometry(1, 20);
  const material = new THREE.MeshBasicMaterial({
    color: 0x05050a,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  blobShadowMesh = new THREE.InstancedMesh(geometry, material, MAX_BLOB_SHADOWS);
  blobShadowMesh.name = 'blob-shadows';
  blobShadowMesh.count = 0;
  blobShadowMesh.visible = true;
  blobShadowMesh.frustumCulled = false;
  blobShadowMesh.renderOrder = 1;
  blobShadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(blobShadowMesh);

  townBlobShadowMesh = new THREE.InstancedMesh(geometry, material.clone(), 8);
  townBlobShadowMesh.name = 'town-blob-shadows';
  townBlobShadowMesh.count = 0;
  townBlobShadowMesh.visible = true;
  townBlobShadowMesh.frustumCulled = false;
  townBlobShadowMesh.renderOrder = 1;
  townBlobShadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  townScene.add(townBlobShadowMesh);
}

function updateBlobShadows() {
  const shadowMesh = state.mode === 'town' ? townBlobShadowMesh : blobShadowMesh;
  if (!shadowMesh?.visible) return;
  const actors = state.mode === 'town' ? [player, ...townNpcs] : [player, ...enemies];
  let count = 0;
  for (const actor of actors) {
    if (!actor || actor.dead || !actor.root.visible || count >= MAX_BLOB_SHADOWS) continue;
    const radius = actor.profileKey === 'warden' ? 1.05 : actor.type === 'player' ? 0.62 : 0.56;
    blobShadowPosition.set(actor.root.position.x, 0.035, actor.root.position.z);
    blobShadowScale.set(radius, radius, 1);
    blobShadowMatrix.compose(blobShadowPosition, blobShadowRotation, blobShadowScale);
    shadowMesh.setMatrixAt(count, blobShadowMatrix);
    count += 1;
  }
  shadowMesh.count = count;
  shadowMesh.instanceMatrix.needsUpdate = true;
}

function addBrickWall({
  x,
  z,
  width,
  depth,
  rotationY = 0,
  colliderWidth = 0,
  colliderDepth = 0,
  parent = null,
}) {
  return createStatic('wall', {
    x,
    z,
    rotationY,
    width,
    depth,
    height: 2.7,
    stretch: true,
    colliderWidth,
    colliderDepth,
    parent,
  });
}

function addWallSpan({ fixed, start, end, openings = [], horizontal, parent = null }) {
  const clippedOpenings = openings
    .map(([openStart, openEnd]) => [Math.max(start, openStart), Math.min(end, openEnd)])
    .filter(([openStart, openEnd]) => openEnd - openStart > 0.1)
    .sort((first, second) => first[0] - second[0]);
  let cursor = start;
  for (const [openStart, openEnd] of clippedOpenings) {
    if (openStart - cursor > 0.45) {
      const length = openStart - cursor;
      const wallDimensions = brickWallDimensions({ horizontal, length, thickness: 0.5 });
      addBrickWall({
        x: horizontal ? (cursor + openStart) / 2 : fixed,
        z: horizontal ? fixed : (cursor + openStart) / 2,
        ...wallDimensions,
        parent,
      });
    }
    cursor = Math.max(cursor, openEnd);
  }
  if (end - cursor > 0.45) {
    const length = end - cursor;
    const wallDimensions = brickWallDimensions({ horizontal, length, thickness: 0.5 });
    addBrickWall({
      x: horizontal ? (cursor + end) / 2 : fixed,
      z: horizontal ? fixed : (cursor + end) / 2,
      ...wallDimensions,
      parent,
    });
  }
}

function buildRoomWalls(room) {
  const openings = room.openings ?? {};
  addWallSpan({
    fixed: room.minZ,
    start: room.minX,
    end: room.maxX,
    openings: openings.north,
    horizontal: true,
  });
  addWallSpan({
    fixed: room.maxZ,
    start: room.minX,
    end: room.maxX,
    openings: openings.south,
    horizontal: true,
  });
  addWallSpan({
    fixed: room.minX,
    start: room.minZ,
    end: room.maxZ,
    openings: openings.west,
    horizontal: false,
  });
  addWallSpan({
    fixed: room.maxX,
    start: room.minZ,
    end: room.maxZ,
    openings: openings.east,
    horizontal: false,
  });

  const corners = [
    [room.minX, room.minZ, true, true],
    [room.maxX, room.minZ, false, true],
    [room.maxX, room.maxZ, false, false],
    [room.minX, room.maxZ, true, false],
  ];
  corners.forEach(([x, z, west, north]) => {
    addDecoration('wallCorner', x, z, {
      height: 2.7,
      rotationY: brickWallCornerRotation({ west, north }),
    });
  });
}

function tileZone(zone, placements) {
  for (let x = zone.minX + 1; x < zone.maxX; x += 2) {
    for (let z = zone.minZ + 1; z < zone.maxZ; z += 2) {
      placements.push({ x, z });
    }
  }
}

function roomCenter(room) {
  return {
    x: (room.minX + room.maxX) / 2,
    z: (room.minZ + room.maxZ) / 2,
  };
}

function addColumn(x, z, height = 2.7) {
  return createStatic('column', {
    x,
    z,
    width: 1.05,
    height,
    colliderWidth: 0.9,
    colliderDepth: 0.9,
  });
}

function addTomb(x, z, rotationY = 0, scale = 1) {
  return createStatic('crypt', {
    x,
    z,
    rotationY,
    width: 2.5 * scale,
    height: 1.55 * scale,
    colliderWidth: 2.35 * scale,
    colliderDepth: 1.25 * scale,
  });
}

function addDecoration(assetKey, x, z, {
  y = 0,
  rotationY = 0,
  width,
  depth,
  height,
  colliderWidth = 0,
  colliderDepth = 0,
} = {}) {
  return createStatic(assetKey, {
    x,
    y,
    z,
    rotationY,
    width,
    depth,
    height,
    colliderWidth,
    colliderDepth,
  });
}

function addBrokenFloor(assetKey, x, z, rotationY = 0) {
  return addDecoration(assetKey, x, z, {
    y: 0.025,
    rotationY,
    width: 1.82,
    depth: 1.82,
  });
}

function addWallTorch(room, wall, along) {
  const inset = 0.58;
  const positions = {
    west: { x: room.minX + inset, z: along, rotationY: Math.PI / 2 },
    east: { x: room.maxX - inset, z: along, rotationY: -Math.PI / 2 },
    north: { x: along, z: room.minZ + inset, rotationY: 0 },
    south: { x: along, z: room.maxZ - inset, rotationY: Math.PI },
  };
  createStatic('torch', { ...positions[wall], height: 2.2 });
}

function addRoomLight(room, color, intensity = 1.35) {
  const center = roomCenter(room);
  recordZoneLight(room.id, { x: center.x, z: center.z, color, intensity });
}

// Decoration ops are data (src/game/room-decorations.js); this is the
// interpreter that maps each op onto the world-building helpers.
const DECOR_OPS = {
  column: (_, { x, z, height = 2.7 }) => addColumn(x, z, height),
  tomb: (_, { x, z, rotationY = 0, scale = 1 }) => addTomb(x, z, rotationY, scale),
  torch: (room, { wall, along }) => addWallTorch(room, wall, along),
  decoration: (room, { asset, x, z, ...options }) => addDecoration(asset, x, z, options),
  brokenFloor: (_, { asset, x, z, rotationY }) => addBrokenFloor(asset, x, z, rotationY),
  light: (room, { color, intensity }) => addRoomLight(room, color, intensity),
  zoneLight: (room, { x, z, color, intensity }) => recordZoneLight(room.id, { x, z, color, intensity }),
  box: (_, spec) => addBox(spec),
  water: (_, { spots, ...spec }) => {
    const material = new THREE.MeshStandardMaterial({ color: 0x244e61, roughness: 0.42, metalness: 0.14 });
    for (const [x, z] of spots) {
      addBox({ x, y: 0.03, z, width: spec.width, height: spec.height ?? 0.08, depth: spec.depth, material });
    }
  },
  bookcases: () => {
    for (const z of [-21, -25, -29]) {
      addDecoration('bookcase', -10.4, z, {
        height: 2.35,
        rotationY: Math.PI / 2,
        colliderWidth: 0.75,
        colliderDepth: 1.65,
      });
      addDecoration('bookcase', 10.4, z, {
        height: 2.35,
        rotationY: -Math.PI / 2,
        colliderWidth: 0.75,
        colliderDepth: 1.65,
      });
    }
  },
};

// ['minX'|'maxX'|'minZ'|'maxZ', offset] resolves relative to the room bounds.
function resolveCoordinate(value, room) {
  return Array.isArray(value) ? room[value[0]] + value[1] : value;
}

function decorateRoom(room) {
  for (const { op: name, x, z, ...spec } of ROOM_DECORATIONS[room.id] ?? []) {
    const operation = DECOR_OPS[name];
    if (!operation) throw new Error(`Unknown decoration op ${name} in ${room.id}`);
    operation(room, { ...spec, x: resolveCoordinate(x, room), z: resolveCoordinate(z, room) });
  }
}

function buildCrypt() {
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x252839,
    roughness: 0.93,
    metalness: 0.04,
  });
  const underfloor = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.maxX - WORLD.minX + 4, WORLD.maxZ - WORLD.minZ + 4),
    floorMaterial,
  );
  underfloor.rotation.x = -Math.PI / 2;
  underfloor.position.y = -0.08;
  underfloor.position.x = (WORLD.minX + WORLD.maxX) / 2;
  underfloor.position.z = (WORLD.minZ + WORLD.maxZ) / 2;
  scene.add(underfloor);

  const grid = new THREE.GridHelper(120, 60, 0x525168, 0x292a3a);
  grid.position.y = 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.11;
  scene.add(grid);

  const corridorMaterial = new THREE.MeshStandardMaterial({
    color: 0x34374a,
    roughness: 0.9,
    metalness: 0.03,
  });

  for (const room of MAP.rooms) {
    buildZoneRenderGroup(room, () => {
      const floorPlacements = [];
      tileZone(room, floorPlacements);
      createFloorTiles(floorPlacements);
      buildRoomWalls(room);
      decorateRoom(room);
    });
  }
  for (const corridor of MAP.corridors) {
    buildZoneRenderGroup(corridor, () => {
      addBox({
        x: (corridor.minX + corridor.maxX) / 2,
        y: -0.055,
        z: (corridor.minZ + corridor.maxZ) / 2,
        width: corridor.maxX - corridor.minX + 0.4,
        height: 0.1,
        depth: corridor.maxZ - corridor.minZ + 0.4,
        material: corridorMaterial,
      });
      const floorPlacements = [];
      tileZone(corridor, floorPlacements);
      createFloorTiles(floorPlacements);
    });
  }
}

function spawnActor({ assetKey, type, name, role, x, z, height, maxHp, speed, profileKey, roomId, sceneRoot = scene }) {
  return new Actor({
    assetKey,
    type,
    name,
    role,
    position: new THREE.Vector3(x, 0, z),
    height,
    maxHp,
    speed,
    profileKey,
    roomId,
    sceneRoot,
  });
}

function buildChests() {
  state.chests = WORLD_DATA.chests.map((chest) => {
    const [x, z] = chest.position;
    return {
      ...chest,
      x,
      z,
      position: new THREE.Vector3(x, 0, z),
      root: createStatic('chest', {
        x,
        z,
        width: 1.35,
        height: 1.05,
        parent: zoneRenderGroups.get(chest.roomId),
        colliderWidth: 1.25,
        colliderDepth: 0.9,
      }),
      opened: false,
      rewardRoot: null,
    };
  });
  state.openedChests = 0;
}

function gateWallPosition(corridor, roomId, travelsAlongZ) {
  const corridorX = (corridor.minX + corridor.maxX) / 2;
  const corridorZ = (corridor.minZ + corridor.maxZ) / 2;
  const room = ZONE_BY_ID.get(roomId);
  const center = roomCenter(room);
  return {
    x: travelsAlongZ
      ? corridorX
      : center.x < corridorX ? room.maxX : room.minX,
    z: travelsAlongZ
      ? center.z < corridorZ ? room.maxZ : room.minZ
      : corridorZ,
  };
}

function moveGateAssemblyToRoom(gate, roomId) {
  const corridor = ZONE_BY_ID.get(gate.corridorId);
  const nextPosition = gateWallPosition(corridor, roomId, gate.travelsAlongZ);
  const offsetX = nextPosition.x - gate.position.x;
  const offsetZ = nextPosition.z - gate.position.z;
  if (Math.abs(offsetX) + Math.abs(offsetZ) < 0.001) return;
  shiftStaticObject(gate.root, offsetX, offsetZ);
  gate.position.set(nextPosition.x, 0, nextPosition.z);
}

function setGateWallFrameVisible(gate, roomId, visible) {
  gate.wallFrames.get(roomId)?.forEach((root) => {
    root.visible = visible;
  });
}

function buildGateWallFrame({ corridor, roomId, travelsAlongZ, openingWidth }) {
  const { x, z } = gateWallPosition(corridor, roomId, travelsAlongZ);
  const wallThickness = 0.5;
  const parent = zoneRenderGroups.get(corridor.id);
  const wallRoots = [];

  if (travelsAlongZ) {
    const wallSections = [
      [corridor.minX, x - openingWidth / 2],
      [x + openingWidth / 2, corridor.maxX],
    ];
    for (const [startX, endX] of wallSections) {
      const sideWidth = endX - startX;
      wallRoots.push(addBrickWall({
        x: (startX + endX) / 2,
        z,
        width: sideWidth,
        depth: wallThickness,
        colliderWidth: sideWidth,
        colliderDepth: wallThickness,
        parent,
      }));
    }
  } else {
    const wallSections = [
      [corridor.minZ, z - openingWidth / 2],
      [z + openingWidth / 2, corridor.maxZ],
    ];
    for (const [startZ, endZ] of wallSections) {
      const sideWidth = endZ - startZ;
      wallRoots.push(addBrickWall({
        x,
        z: (startZ + endZ) / 2,
        width: sideWidth,
        depth: wallThickness,
        rotationY: Math.PI / 2,
        colliderWidth: sideWidth,
        colliderDepth: wallThickness,
        parent,
      }));
    }
  }

  return wallRoots;
}

function buildGateCorridorWalls({ corridor, roomIds, travelsAlongZ, openingWidth }) {
  const corridorX = (corridor.minX + corridor.maxX) / 2;
  const corridorZ = (corridor.minZ + corridor.maxZ) / 2;
  const endpointPositions = roomIds.map((roomId) => gateWallPosition(corridor, roomId, travelsAlongZ));
  const wallThickness = 0.5;
  const parent = zoneRenderGroups.get(corridor.id);
  const wallRoots = [];

  if (travelsAlongZ) {
    const minZ = Math.min(...endpointPositions.map(({ z }) => z));
    const maxZ = Math.max(...endpointPositions.map(({ z }) => z));
    const wallDepth = maxZ - minZ + wallThickness;
    const wallSections = [
      [corridor.minX, corridorX - openingWidth / 2],
      [corridorX + openingWidth / 2, corridor.maxX],
    ];
    for (const [startX, endX] of wallSections) {
      const sideWidth = endX - startX;
      wallRoots.push(addBrickWall({
        x: (startX + endX) / 2,
        z: (minZ + maxZ) / 2,
        width: sideWidth,
        depth: wallDepth,
        colliderWidth: sideWidth,
        colliderDepth: wallDepth,
        parent,
      }));
    }
  } else {
    const minX = Math.min(...endpointPositions.map(({ x }) => x));
    const maxX = Math.max(...endpointPositions.map(({ x }) => x));
    const wallWidth = maxX - minX + wallThickness;
    const wallSections = [
      [corridor.minZ, corridorZ - openingWidth / 2],
      [corridorZ + openingWidth / 2, corridor.maxZ],
    ];
    for (const [startZ, endZ] of wallSections) {
      const sideWidth = endZ - startZ;
      wallRoots.push(addBrickWall({
        x: (minX + maxX) / 2,
        z: (startZ + endZ) / 2,
        width: wallWidth,
        depth: sideWidth,
        colliderWidth: wallWidth,
        colliderDepth: sideWidth,
        parent,
      }));
    }
  }

  return wallRoots;
}

function buildGates() {
  state.gates = MAP.corridors.map((corridor) => {
    const roomIds = (ZONE_NEIGHBORS.get(corridor.id) ?? []).filter((id) => ROOM_IDS.has(id));
    if (roomIds.length !== 2) {
      throw new Error(`Corridor ${corridor.id} must connect exactly two rooms.`);
    }
    const width = corridor.maxX - corridor.minX;
    const depth = corridor.maxZ - corridor.minZ;
    const connectedRoomCenters = roomIds.map((id) => roomCenter(ZONE_BY_ID.get(id)));
    const travelsAlongZ = Math.abs(connectedRoomCenters[1].z - connectedRoomCenters[0].z)
      > Math.abs(connectedRoomCenters[1].x - connectedRoomCenters[0].x);
    // MAP room order follows progression, so mount the gate on the wall of the
    // first connected room until the player opens it.
    const { x, z } = gateWallPosition(corridor, roomIds[0], travelsAlongZ);
    const span = travelsAlongZ ? width : depth;
    const openingWidth = Math.min(3.6, span - 1.2);
    const parent = zoneRenderGroups.get(corridor.id);
    // Bridge the two room wall planes along the corridor so the side walls do
    // not leave a visible strip of corridor tiles between the sections.
    buildGateCorridorWalls({
      corridor,
      roomIds,
      travelsAlongZ,
      openingWidth,
    });
    const wallFrames = new Map(roomIds.map((roomId) => [roomId, buildGateWallFrame({
      corridor,
      roomId,
      travelsAlongZ,
      openingWidth,
    })]));
    wallFrames.get(roomIds[1]).forEach((root) => {
      root.visible = false;
    });

    const root = createGateStatic({
      x,
      z,
      travelsAlongZ,
      span: openingWidth,
      height: 3.2,
      parent,
    });
    return {
      id: `${corridor.id}-gate`,
      corridorId: corridor.id,
      roomIds,
      travelsAlongZ,
      position: new THREE.Vector3(x, 0, z),
      root,
      wallFrames,
      open: false,
      fromRoomId: null,
      toRoomId: null,
    };
  });
}

function buildActors() {
  player = spawnActor({
    ...WORLD_DATA.player,
    type: 'player',
    sceneRoot: townScene,
  });
  for (const spawn of WORLD_DATA.enemySpawns) {
    const profile = ENEMY_PROFILES[spawn.profileKey];
    const [x, z] = spawn.position;
    enemies.push(spawnActor({
      assetKey: spawn.assetKey,
      type: 'enemy',
      name: spawn.name,
      x,
      z,
      height: spawn.height,
      maxHp: profile.maxHp,
      speed: profile.speed,
      profileKey: spawn.profileKey,
      roomId: spawn.roomId,
    }));
  }
}

function buildTownActors() {
  for (const npcData of WORLD_DATA.town.npcs) {
    const { position, patrol, ...actorData } = npcData;
    const [x, z] = position;
    const npc = spawnActor({
      ...actorData,
      type: 'npc',
      x,
      z,
      sceneRoot: townScene,
    });
    townNpcs.push(npc);
    if (patrol) {
      configureTownPatrol(npc, patrol.waypoints.map(([waypointX, waypointZ]) => ({ x: waypointX, z: waypointZ })), {
        speed: patrol.speed,
        pause: patrol.pause,
      });
    }
  }
  townNpcs.forEach((npc) => {
    npc.awake = true;
    npc.play(['idle', 'idle_combat'], { force: true });
  });
}

function configureTownPatrol(actor, waypoints, { speed = 1.1, pause = 0.6 } = {}) {
  actor.townPatrol = {
    waypoints: waypoints.map(({ x, z }) => new THREE.Vector3(x, 0, z)),
    targetIndex: 0,
    speed,
    pause,
    pauseTimer: 0,
  };
}

function updateTownNpcPatrol(npc, delta) {
  const patrol = npc.townPatrol;
  if (!patrol || patrol.waypoints.length < 2) return false;

  const target = patrol.waypoints[patrol.targetIndex];
  if (patrol.pauseTimer > 0) {
    patrol.pauseTimer = Math.max(0, patrol.pauseTimer - delta);
    tempVector.subVectors(target, npc.root.position);
    tempVector.y = 0;
    npc.faceDirection(tempVector);
    npc.play(['idle_combat', 'idle']);
    return true;
  }

  tempVector.subVectors(target, npc.root.position);
  tempVector.y = 0;
  const distance = tempVector.length();
  if (distance <= 0.14) {
    npc.root.position.set(target.x, 0, target.z);
    patrol.targetIndex = (patrol.targetIndex + 1) % patrol.waypoints.length;
    patrol.pauseTimer = patrol.pause;
    tempVector.subVectors(patrol.waypoints[patrol.targetIndex], npc.root.position);
    tempVector.y = 0;
    npc.faceDirection(tempVector);
    npc.play(['idle_combat', 'idle']);
    return true;
  }

  tempVector.multiplyScalar(1 / distance);
  const previousX = npc.root.position.x;
  const previousZ = npc.root.position.z;
  const step = Math.min(distance, patrol.speed * delta);
  moveActorWithinMap(npc, tempVector.x * step, tempVector.z * step, 0.55);
  if (Math.abs(npc.root.position.x - previousX) + Math.abs(npc.root.position.z - previousZ) < 0.0001) {
    patrol.targetIndex = (patrol.targetIndex + 1) % patrol.waypoints.length;
    patrol.pauseTimer = patrol.pause;
    npc.play(['idle_combat', 'idle']);
    return true;
  }
  npc.faceDirection(tempVector);
  npc.play(['running', 'walking', 'idle_combat']);
  return true;
}

function buildTownLighting() {
  townScene.add(new THREE.HemisphereLight(0xd8ebd6, 0x304536, 2.4));
  const sun = new THREE.DirectionalLight(0xffe2b0, 2.8);
  sun.position.set(-12, 18, 10);
  sun.target.position.set(0, 0, 0);
  townScene.add(sun, sun.target);
  const lantern = new THREE.PointLight(0xffc66f, 3.2, 12, 2);
  lantern.position.set(0, 3, 10.8);
  townScene.add(lantern);
}

function buildTown() {
  townWorldGroup = new THREE.Group();
  townWorldGroup.name = 'scene:town-ravenrest';
  townScene.add(townWorldGroup);

  const grassMaterial = new THREE.MeshStandardMaterial({ color: 0x587d5a, roughness: 0.94, metalness: 0.02 });
  const roadMaterial = new THREE.MeshStandardMaterial({ color: 0x9d8664, roughness: 0.98, metalness: 0 });
  const roadEdgeMaterial = new THREE.MeshStandardMaterial({ color: 0x6f795d, roughness: 0.98, metalness: 0 });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(TOWN_WORLD.maxX - TOWN_WORLD.minX, TOWN_WORLD.maxZ - TOWN_WORLD.minZ),
    grassMaterial,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.08, 0.5);
  townWorldGroup.add(ground);
  addBox({ x: 0, y: -0.015, z: 3.8, width: 4.2, height: 0.08, depth: 23, material: roadMaterial, parent: townWorldGroup });
  addBox({ x: 0, y: -0.012, z: 3.8, width: 30, height: 0.06, depth: 3.1, material: roadMaterial, parent: townWorldGroup });
  addBox({ x: 0, y: 0.01, z: 3.8, width: 1.15, height: 0.08, depth: 23, material: roadEdgeMaterial, parent: townWorldGroup });

  const townStatic = { parent: townWorldGroup, colliders: townStaticColliders };
  for (const placement of WORLD_DATA.town.placements) {
    const { assetKey, position, ...options } = placement;
    const [x, z] = position;
    createStatic(assetKey, { ...options, x, z, ...townStatic });
  }

  buildTownActors();
  buildTownLighting();
}

function buildWorld() {
  buildDungeonLightPool();
  buildLighting();
  buildCrypt();
  buildChests();
  buildGates();
  buildActors();
  buildTown();
  buildBlobShadows();
  updateHealthUi();
  updateQuestUi();
}

function countLivingEnemies() {
  return enemies.filter((enemy) => !enemy.dead).length;
}

function chestById(id) {
  return state.chests.find((chest) => chest.id === id) ?? null;
}

function containsPosition(zone, position, inset = 0) {
  return position.x >= zone.minX + inset
    && position.x <= zone.maxX - inset
    && position.z >= zone.minZ + inset
    && position.z <= zone.maxZ - inset;
}

function roomAtPosition(position, inset = 0) {
  return MAP.rooms.find((room) => containsPosition(room, position, inset)) ?? null;
}

function zoneAtPosition(position) {
  return roomAtPosition(position)
    ?? MAP.corridors.find((corridor) => containsPosition(corridor, position))
    ?? null;
}

function updateZoneVisibility(roomId, force = false) {
  if (!ROOM_IDS.has(roomId)) return;
  const nextVisible = new Set(visibleZoneIdsFor({
    currentRoomId: roomId,
    neighborIdsByZone: ZONE_NEIGHBORS,
    gates: state.gates,
    isRoom: (id) => ROOM_IDS.has(id),
  }));
  const changed = force
    || nextVisible.size !== visibleZoneIds.size
    || [...nextVisible].some((id) => !visibleZoneIds.has(id));
  if (!changed) return;
  visibleZoneIds.clear();
  nextVisible.forEach((id) => visibleZoneIds.add(id));
  zoneRenderGroups.forEach((group, id) => {
    group.visible = visibleZoneIds.has(id);
  });
  applyDungeonLights();
  const profile = window.__cryptProfile;
  if (profile?.active) profile.zones.push({ t: performance.now(), visible: [...visibleZoneIds] });
}

function showDialogue(npcName, copy, duration = 2400) {
  dialogueName.textContent = npcName;
  dialogueCopy.textContent = copy;
  dialogueCard.classList.remove('is-hidden');
  window.clearTimeout(dialogueTimeout);
  dialogueTimeout = window.setTimeout(() => dialogueCard.classList.add('is-hidden'), duration);
}

function updateModeUi() {
  const inTown = state.mode === 'town';
  areaName.textContent = inTown ? 'Ravenrest Village' : ZONE_BY_ID.get(state.currentRoomId)?.label ?? 'Entrance Vault';
  minimapLabel.textContent = inTown ? 'VILLAGE MAP' : 'CRYPT MAP';
  minimap.closest('.minimap-card')?.classList.remove('is-hidden');
  targetCard.classList.toggle('is-hidden', inTown);
  abilityStrip.classList.toggle('is-hidden', inTown);
  backpackCard.classList.toggle('is-hidden', inTown);
  if (inTown) clearSelectedTarget({ silent: true });
  else updateTargetUi();
}

function nearestTownNpc(maxDistance = Infinity) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const npc of townNpcs) {
    const distance = player.root.position.distanceTo(npc.root.position);
    if (distance < nearestDistance) {
      nearest = npc;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function enterDungeon() {
  if (state.mode === 'dungeon' || !player) return;
  state.mode = 'dungeon';
  state.teleporting = false;
  for (const npc of townNpcs) npc.nameplate?.element.classList.add('is-hidden');
  window.clearTimeout(dialogueTimeout);
  dialogueCard.classList.add('is-hidden');
  state.started = false;
  state.combatStarted = false;
  player.root.removeFromParent();
  scene.add(player.root);
  player.root.position.set(0, 0, 26.8);
  player.root.rotation.y = 0;
  player.setWeaponSheathed(true);
  state.currentRoomId = 'entrance';
  state.currentZoneId = null;
  state.discoveredRooms = new Set(['entrance']);
  visibleZoneIds.clear();
  updateZoneVisibility('entrance', true);
  camera.position.set(player.root.position.x + 10.6, 11.5, player.root.position.z + 12.2);
  controls.target.set(player.root.position.x, 0.8, player.root.position.z);
  controls.update();
  updateModeUi();
  updateMinimap(0, true);
  showDialogue('Ranger Rowan', 'The cryptwalker has arrived. Keep the old dead from reaching Ravenrest.', 3000);
  setToast('Ranger Rowan sent you into the Forgotten Crypt.', 2600);
}

function talkToTownNpc(npc) {
  if (!npc || state.teleporting) return;
  npc.face(player.root.position);
  if (npc.role === 'Hunter') {
    state.teleporting = true;
    showDialogue(npc.name, 'The old bell has started ringing below the hill. Follow my mark into the crypt.', 1500);
    setToast('The hunter opens a trail beneath Ravenrest…', 1500);
    window.setTimeout(enterDungeon, 900);
    return;
  }
  showDialogue(npc.name, npc.role === 'Town guard'
    ? 'The southern road is quiet. Rowan knows the safe path into the crypt.'
    : 'Fresh tools, fresh trouble. Rowan is the one to ask about the dungeon.', 2600);
}

function livingEnemiesInBranch(branch, { includeWarden = true } = {}) {
  return enemies.filter((enemy) => (
    !enemy.dead
    && ROOM_BRANCH[enemy.roomId] === branch
    && (includeWarden || enemy.profileKey !== 'warden')
  ));
}

function livingEnemiesInRoom(roomId) {
  return enemies.filter((enemy) => !enemy.dead && enemy.roomId === roomId);
}

function isEnemyAccessible(enemy) {
  return visibleZoneIds.has(enemy.roomId);
}

function updateProgression() {
  const zone = zoneAtPosition(player.root.position);
  if (zone && zone.id !== state.currentZoneId) {
    state.currentZoneId = zone.id;
  }
  // Keep the gate open until the entire actor has cleared its collider rather
  // than closing on the first frame their center crosses the room boundary.
  // The enter/close decision itself lives in world-rules.resolveRoomEntry so
  // the headless core follows the identical rule.
  const transition = resolveRoomEntry({
    x: player.root.position.x,
    z: player.root.position.z,
    rooms: MAP.rooms,
    currentRoomId: state.currentRoomId,
    gates: state.gates,
    clearance: ROOM_ENTRY_CLEARANCE,
  });
  if (!transition.entered) {
    if (visibleZoneIds.size === 0) updateZoneVisibility(state.currentRoomId, true);
    return;
  }
  const traversedGate = transition.traversedGate;
  if (traversedGate) {
    if (E2E_ENABLED) e2eState.fastGateTransitions += 1;
    traversedGate.open = false;
    traversedGate.root.visible = true;
    setGateWallFrameVisible(traversedGate, state.currentRoomId, true);
    setGateWallFrameVisible(traversedGate, transition.roomId, true);
    traversedGate.fromRoomId = null;
    traversedGate.toRoomId = null;
  }
  state.currentRoomId = transition.roomId;
  state.discoveredRooms.add(transition.roomId);
  areaName.textContent = transition.label;
  updateZoneVisibility(transition.roomId, true);
  if (state.started) {
    playSfx('room');
    addCameraFeedback(0.035, 1.1);
    if (traversedGate) setToast('The gate closes and the previous chamber fades into the dark.');
  }
}

function moveActorWithinMap(actor, offsetX, offsetZ, padding = 0.55) {
  stepActorWithinMap(
    actor.root.position,
    offsetX,
    offsetZ,
    navigation.modeBounds(),
    isWalkable,
    padding,
  );
}

function actorFromObject(object) {
  let current = object;
  while (current) {
    if (current.userData?.actor) return current.userData.actor;
    current = current.parent;
  }
  return null;
}

function pickActor(clientX, clientY) {
  if (!player) return null;
  pointerNdc.set(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, camera);
  const actorRoots = [player.root, ...enemies.map((enemy) => enemy.root)];
  const hits = raycaster.intersectObjects(actorRoots, true);
  for (const hit of hits) {
    const actor = actorFromObject(hit.object);
    if (actor && !actor.dead && (actor === player || isEnemyAccessible(actor))) return actor;
  }
  return null;
}

function ensureTargetMarker() {
  if (targetMarker) return;
  targetMarker = new THREE.Mesh(
    new THREE.TorusGeometry(0.82, 0.035, 8, 40),
    new THREE.MeshBasicMaterial({
      color: 0xd8b5f0,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  targetMarker.name = 'selected-target-marker';
  targetMarker.rotation.x = Math.PI / 2;
  targetMarker.visible = false;
  scene.add(targetMarker);
}

function clearSelectedTarget({ silent = false } = {}) {
  selectedTarget = null;
  if (targetMarker) targetMarker.visible = false;
  if (!silent && state.started) setToast('Target cleared.', 900);
  updateTargetUi();
  updateActionUi();
}

function selectTarget(target) {
  if (!state.loaded || state.finished || state.failed) return;
  if (!target || target.dead || (target !== player && !isEnemyAccessible(target))) {
    clearSelectedTarget({ silent: true });
    return;
  }
  state.started = true;
  selectedTarget = target;
  ensureTargetMarker();
  targetMarker.visible = target !== player;
  updateTargetUi();
  updateActionUi();
}

function updateTargetMarker(delta = 0) {
  if (!targetMarker || !selectedTarget || selectedTarget === player || selectedTarget.dead || !isEnemyAccessible(selectedTarget)) {
    if (targetMarker) targetMarker.visible = false;
    if (selectedTarget && (selectedTarget.dead || !isEnemyAccessible(selectedTarget))) {
      clearSelectedTarget({ silent: true });
    }
    return;
  }
  targetMarker.visible = true;
  targetMarker.position.copy(selectedTarget.root.position);
  targetMarker.position.y = 0.055;
  targetMarker.scale.setScalar(0.86 + Math.sin(state.elapsed * 5.2) * 0.045);
  targetMarker.rotation.z += delta * 1.8;
  targetMarker.material.opacity = 0.58 + Math.sin(state.elapsed * 6.5) * 0.1;
}

function updateHealthUi() {
  const ratio = Math.max(0, state.playerHp / state.playerMaxHp);
  healthValue.textContent = `${Math.ceil(state.playerHp)} / ${state.playerMaxHp}`;
  healthFill.style.width = `${ratio * 100}%`;
  healthFill.style.background = ratio < 0.3
    ? 'linear-gradient(90deg, #ad5e63, #d8866b)'
    : 'linear-gradient(90deg, #e1a26a, #eacb8a)';
  playerStatus.innerHTML = state.playerBuffTimer > 0
    ? `<span class="status-chip">WARD ${state.playerBuffTimer.toFixed(1)}s</span>`
    : '';
}

function updateTargetUi() {
  if (!state.started) {
    targetCard.classList.add('is-hidden');
    return;
  }
  const target = selectedTarget
    && selectedTarget !== player
    && !selectedTarget.dead
    && isEnemyAccessible(selectedTarget)
    ? selectedTarget
    : null;
  if (!target) {
    targetCard.classList.add('is-hidden');
    return;
  }
  targetCard.classList.remove('is-hidden');
  targetName.textContent = target.name;
  targetFill.style.width = `${Math.max(0, target.hp / target.maxHp) * 100}%`;
  const statuses = [];
  if (target.profileKey === 'warden' && target.bossPhase >= 2) {
    statuses.push('<span class="status-chip is-danger">PHASE II</span>');
  }
  if (target.frozenTimer > 0) statuses.push(`<span class="status-chip is-frozen">FROZEN ${target.frozenTimer.toFixed(1)}s</span>`);
  if (target.pendingEnemyAttack?.label) statuses.push(`<span class="status-chip is-danger">${target.pendingEnemyAttack.label}</span>`);
  if (target.evading) statuses.push('<span class="status-chip">RESETTING</span>');
  targetStatus.innerHTML = statuses.join('');
}

function updateActionUi() {
  for (const slot of abilitySlots) {
    const action = slot.dataset.ability;
    const remaining = state.actionCooldowns[action] ?? 0;
    const total = actionCooldownFor(action);
    const target = selectedTarget
      && selectedTarget !== player
      && !selectedTarget.dead
      && isEnemyAccessible(selectedTarget)
      ? selectedTarget
      : null;
    const needsTarget = action !== 'heal' && action !== 'buff';
    const outOfRange = target && needsTarget
      ? player.root.position.distanceTo(target.root.position) > ACTIONS[action].range
      : false;
    const blocked = (needsTarget && (!target || outOfRange))
      || (action === 'heal' && state.playerHp >= state.playerMaxHp);
    slot.classList.toggle('is-cooling', remaining > 0);
    slot.classList.toggle('is-unusable', blocked);
    slot.classList.toggle('is-casting', player?.pendingAction === action);
    slot.querySelector('strong').textContent = remaining > 0 ? `${remaining.toFixed(1)}s` : 'READY';
    const targetHint = needsTarget
      ? !target
        ? ' Select an enemy target first.'
        : outOfRange
          ? ' Target is out of range.'
          : ''
      : action === 'heal' && state.playerHp >= state.playerMaxHp
        ? ' Vitality is already full.'
        : '';
    slot.setAttribute('aria-label', `${ACTION_NAMES[action]}. Press ${slot.dataset.key}.${targetHint}`);
  }
}

function equippedDefinition() {
  const itemId = state.equippedSlot === null ? null : state.inventory[state.equippedSlot];
  return itemId ? ITEM_DEFS[itemId] : null;
}

function actionCooldownFor(action) {
  return ACTIONS[action].cooldown * (equippedDefinition()?.cooldown?.[action] ?? 1);
}

function itemDamageMultiplier(action) {
  return equippedDefinition()?.damage?.[action] ?? 1;
}

function updateInventoryUi() {
  backpackSlots.forEach((button, index) => {
    const itemId = state.inventory[index];
    const item = itemId ? ITEM_DEFS[itemId] : null;
    button.replaceChildren();
    button.dataset.slotNumber = `${index + 1}`;
    button.classList.toggle('is-equipped', index === state.equippedSlot);
    if (!item) {
      button.removeAttribute('style');
      button.title = '';
      button.setAttribute('aria-label', `Empty backpack slot ${index + 1}`);
      return;
    }
    const glyph = document.createElement('span');
    glyph.textContent = item.glyph;
    glyph.style.color = item.color;
    button.append(glyph);
    button.style.setProperty('--item-color', item.color);
    button.title = `${item.name} · ${item.description}`;
    button.setAttribute('aria-label', `${item.name}. ${item.description}${item.kind === 'equipment' ? ' Click to equip.' : ' Click to use.'}`);
  });
  const equipped = equippedDefinition();
  equippedItem.textContent = equipped ? `${equipped.glyph} ${equipped.name}` : 'No relic equipped';
  equippedItem.style.color = equipped?.color ?? '';
}

function useInventorySlot(index) {
  const itemId = state.inventory[index];
  const item = itemId ? ITEM_DEFS[itemId] : null;
  if (!item || state.finished || state.failed) return;
  initAudio();
  if (item.kind === 'consumable') {
    if (state.playerHp >= state.playerMaxHp) {
      setToast('Vitality is already full.', 1100);
      return;
    }
    const restored = Math.min(30, state.playerMaxHp - state.playerHp);
    state.playerHp += restored;
    state.inventory[index] = null;
    spawnBurst(player.root.position, 0x8ed9a8, 14);
    spawnCombatText(player.root.position, `+${restored}`, '#9fe1bb', player.height + 0.2);
    playSfx('pickup');
    setToast(`${item.name} restores ${restored} vitality.`);
    updateHealthUi();
  } else {
    state.equippedSlot = state.equippedSlot === index ? null : index;
    const equipped = equippedDefinition();
    player.setWeaponColor(equipped?.color ?? null);
    playSfx('equip');
    addCameraFeedback(0.035, 0.45);
    setToast(equipped ? `${equipped.name} equipped: ${equipped.description}` : `${item.name} unequipped.`);
  }
  updateInventoryUi();
}

function createLootVisual(itemId, position) {
  const item = ITEM_DEFS[itemId];
  const root = new THREE.Group();
  const color = new THREE.Color(item.color);
  const coreGeometry = item.kind === 'equipment'
    ? new THREE.OctahedronGeometry(0.25, 0)
    : new THREE.DodecahedronGeometry(0.21, 0);
  const core = new THREE.Mesh(coreGeometry, new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.15,
    roughness: 0.35,
    metalness: item.kind === 'equipment' ? 0.65 : 0.18,
  }));
  root.add(core);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.025, 8, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.68 }),
  );
  ring.rotation.x = Math.PI / 2;
  root.add(ring);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.11, 1.45, 12, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false }),
  );
  beam.position.y = 0.72;
  root.add(beam);
  root.position.copy(position);
  root.position.y = 0.36;
  scene.add(root);
  const drop = { itemId, root, position: position.clone(), phase: Math.random() * Math.PI * 2, collected: false };
  lootDrops.push(drop);
  return drop;
}

function spawnLootDrop(enemy) {
  if (enemy.lootDropped) return;
  enemy.lootDropped = true;
  const itemId = lootItemForProfile(enemy.profileKey);
  createLootVisual(itemId, enemy.root.position);
  spawnCombatText(enemy.root.position, 'LOOT', ITEM_DEFS[itemId].color, enemy.height + 0.55);
}

function nearestLootDrop(maxDistance = Infinity) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const drop of lootDrops) {
    if (drop.collected) continue;
    const distance = player.root.position.distanceTo(drop.position);
    if (distance < nearestDistance) {
      nearest = drop;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function collectLootDrop(drop) {
  if (!drop || drop.collected) return;
  const slot = state.inventory.findIndex((itemId) => itemId === null);
  if (slot < 0) {
    setToast('Your six-slot backpack is full.', 1700);
    return;
  }
  drop.collected = true;
  state.inventory[slot] = drop.itemId;
  scene.remove(drop.root);
  drop.root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry.dispose();
    child.material.dispose();
  });
  const item = ITEM_DEFS[drop.itemId];
  spawnBurst(drop.position, new THREE.Color(item.color).getHex(), 16);
  playSfx('pickup');
  addCameraFeedback(0.025, 0.35);
  setToast(`${item.name} added to backpack slot ${slot + 1}.`);
  updateInventoryUi();
}

function updateLootDrops(delta) {
  for (const drop of lootDrops) {
    if (drop.collected) continue;
    drop.phase += delta * 2.2;
    drop.root.position.y = 0.38 + Math.sin(drop.phase) * 0.09;
    drop.root.rotation.y += delta * 0.85;
  }
}

function nearestClosedChest(maxDistance = Infinity) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const chest of state.chests) {
    if (chest.opened) continue;
    const distance = player.root.position.distanceTo(chest.position);
    if (distance < nearestDistance) {
      nearest = chest;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function nearestClosedGate(maxDistance = Infinity) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const gate of state.gates) {
    if (gate.open || !zoneRenderGroups.get(gate.corridorId)?.visible) continue;
    const distance = player.root.position.distanceTo(gate.position);
    if (distance < nearestDistance) {
      nearest = gate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function findGate(corridorId) {
  return state.gates.find((candidate) => candidate.corridorId === corridorId);
}

function clearEnemies(filter = () => true) {
  for (const enemy of enemies) {
    if (!filter(enemy)) continue;
    enemy.dead = true;
    enemy.root.visible = false;
  }
}

function openGate(gate) {
  const verdict = evaluateGateOpen({
    gate,
    currentRoomId: state.currentRoomId,
    livingInRoomCount: livingEnemiesInRoom(state.currentRoomId).length,
  });
  if (!verdict.ok) {
    if (verdict.reason) setToast(verdict.reason, 1800);
    return;
  }
  for (const otherGate of state.gates) {
    if (!otherGate.open) continue;
    moveGateAssemblyToRoom(otherGate, otherGate.fromRoomId);
    setGateWallFrameVisible(otherGate, otherGate.fromRoomId, true);
    setGateWallFrameVisible(otherGate, otherGate.toRoomId, false);
    otherGate.open = false;
    otherGate.root.visible = true;
    otherGate.fromRoomId = null;
    otherGate.toRoomId = null;
  }
  gate.open = true;
  gate.fromRoomId = state.currentRoomId;
  gate.toRoomId = gate.roomIds.find((id) => id !== state.currentRoomId) ?? null;
  setGateWallFrameVisible(gate, gate.fromRoomId, true);
  setGateWallFrameVisible(gate, gate.toRoomId, true);
  moveGateAssemblyToRoom(gate, gate.toRoomId);
  gate.root.visible = false;
  updateZoneVisibility(state.currentRoomId, true);
  const destination = ZONE_BY_ID.get(gate.toRoomId);
  playSfx('room');
  addCameraFeedback(0.045, 0.7);
  spawnCombatText(gate.position, 'GATE OPEN', '#c9b2f0', 2.1);
  setToast(`${destination?.label ?? 'The next chamber'} emerges from the dark.`);
}

function chestBlockReason(chest) {
  if (!chest || chest.opened) return '';
  const guardianCount = chest.kind === 'seal'
    ? livingEnemiesInBranch(chest.branch).length
    : chest.kind === 'archive'
      ? livingEnemiesInBranch('north', { includeWarden: false }).length
      : livingEnemiesInRoom(chest.roomId).length;
  return evaluateChestBlock({ chest, guardianCount });
}

// Objective ladder, first match wins. Each row is the full rule for one
// stage of the delve; adding a stage is a row, not another else-if.
const OBJECTIVE_LADDER = [
  {
    when: () => state.finished,
    title: 'Delve complete',
    detail: () => 'The crypt keeps its secrets for another day.',
  },
  {
    when: () => state.failed,
    title: 'The crypt wins',
    detail: () => 'Take a breath, then try the route again.',
  },
  {
    when: () => !state.started,
    title: 'Enter the crypt',
    detail: () => 'Clear the western and eastern branches to claim their seals.',
  },
  {
    when: () => !state.seals.west || !state.seals.east,
    title: 'Claim the twin branch seals',
    detail: () => {
      const west = state.seals.west ? 'seal claimed' : `${livingEnemiesInBranch('west').length} guardians`;
      const east = state.seals.east ? 'seal claimed' : `${livingEnemiesInBranch('east').length} guardians`;
      return `West: ${west}. East: ${east}. Each reliquary opens when its branch is clear.`;
    },
  },
  {
    when: () => livingEnemiesInBranch('north', { includeWarden: false }).length > 0,
    title: 'Cross the Silent Archive',
    detail: () => `${livingEnemiesInBranch('north', { includeWarden: false }).length} northern guardians stand between you and the Archive key.`,
  },
  {
    when: () => !state.archiveKey,
    title: 'Claim the Archive key',
    detail: () => 'Open the cache in the Silent Archive to continue into the Warden\'s Keep.',
  },
  {
    when: () => livingEnemiesInRoom('wardenKeep').length > 0,
    title: 'Defeat the Crypt Warden',
    detail: () => 'Dodge its slam and Soul Collapse while breaking the dead it calls back.',
  },
  {
    when: () => !chestById('warden-spoils')?.opened,
    title: 'Claim the Warden\'s spoils',
    detail: () => 'The final reliquary is no longer warded.',
  },
  {
    when: () => true,
    title: 'Return to the entrance',
    detail: () => `${state.openedChests} of ${state.chests.length} caches found. Return through the southern entrance.`,
  },
];

function updateQuestUi() {
  if (state.mode === 'town') {
    threatValue.textContent = 'SAFE';
    objective.textContent = 'Find the hunter';
    objectiveDetail.textContent = 'Speak with Ranger Rowan at the archery yard to enter the Forgotten Crypt.';
    return;
  }
  const threats = countLivingEnemies();
  threatValue.textContent = `${threats} ${threats === 1 ? 'REMAINS' : 'REMAIN'}`;
  const stage = OBJECTIVE_LADDER.find((entry) => entry.when());
  objective.textContent = stage.title;
  objectiveDetail.textContent = stage.detail();
}

// One nearest-of-four scan shared by the interaction prompt and the E key
// handler. Priority order matches the headless core: loot, chest, gate.
function interactionCandidate() {
  const candidates = [
    { kind: 'loot', item: nearestLootDrop(INTERACT_RADII.loot), id: (drop) => drop.itemId },
    { kind: 'chest', item: nearestClosedChest(INTERACT_RADII.chest), id: (chest) => chest.id },
    { kind: 'gate', item: nearestClosedGate(INTERACT_RADII.gate), id: (gate) => gate.corridorId },
  ];
  return candidates.find((candidate) => candidate.item) ?? null;
}

function updateInteractionUi() {
  if (!state.loaded || state.finished || state.failed) {
    interaction.classList.add('is-hidden');
    return;
  }
  if (state.mode === 'town') {
    const nearbyNpc = nearestTownNpc(INTERACT_RADII.npc);
    if (state.teleporting) {
      interaction.classList.remove('is-hidden');
      interaction.textContent = 'The hunter is opening the crypt path…';
    } else if (nearbyNpc) {
      interaction.classList.remove('is-hidden');
      interaction.innerHTML = `Press <kbd>E</kbd> to speak with ${nearbyNpc.name}`;
    } else {
      interaction.classList.add('is-hidden');
    }
    return;
  }
  const candidate = interactionCandidate();
  if (!candidate) {
    interaction.classList.add('is-hidden');
    return;
  }
  interaction.classList.remove('is-hidden');
  if (candidate.kind === 'loot') {
    interaction.innerHTML = `Press <kbd>E</kbd> to collect ${ITEM_DEFS[candidate.item.itemId].name.toLowerCase()}`;
  } else if (candidate.kind === 'chest') {
    interaction.innerHTML = `Press <kbd>E</kbd> to open ${candidate.item.name.toLowerCase()}`;
  } else {
    const destinationId = candidate.item.roomIds.find((id) => id !== state.currentRoomId);
    const destination = ZONE_BY_ID.get(destinationId);
    const remainingEnemies = livingEnemiesInRoom(state.currentRoomId).length;
    interaction.innerHTML = remainingEnemies > 0
      ? `Gate sealed by ${remainingEnemies} remaining guardian${remainingEnemies === 1 ? '' : 's'}`
      : `Press <kbd>E</kbd> to open the way to ${(destination?.label ?? 'the next chamber').toLowerCase()}`;
  }
}

function updateInterface(delta, force = false) {
  state.uiTimer -= delta;
  if (!force && state.uiTimer > 0) return;
  state.uiTimer = 0.1;
  updateHealthUi();
  updateActionUi();
  updateTargetUi();
  updateQuestUi();
  updateInteractionUi();
  publishE2eSnapshot();
}

// Burst particles share one frozen geometry and draw from a pool of meshes.
// Each particle keeps its own material so randomized lifetimes can fade
// independently; released slots are reused, live ones never are.
let burstGeometry = null;
const burstMeshPool = createSlotPool(() => {
  if (!burstGeometry) burstGeometry = new THREE.SphereGeometry(0.055, 6, 6);
  const mesh = new THREE.Mesh(burstGeometry, new THREE.MeshBasicMaterial({ transparent: true }));
  scene.add(mesh);
  return mesh;
});

function spawnBurst(position, color = 0xf0c071, count = 12) {
  for (let index = 0; index < count; index += 1) {
    const mesh = burstMeshPool.acquire();
    mesh.visible = true;
    mesh.material.color.set(color);
    mesh.material.opacity = 1;
    mesh.position.copy(position);
    mesh.position.y += 0.55;
    const angle = (index / count) * Math.PI * 2;
    effects.push({
      mesh,
      life: 0.65 + Math.random() * 0.25,
      velocity: new THREE.Vector3(Math.cos(angle) * (0.65 + Math.random() * 0.35), 1.2 + Math.random() * 0.7, Math.sin(angle) * (0.65 + Math.random() * 0.35)),
    });
  }
}

function spellMaterial(color, opacity = 0.8) {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.userData.baseOpacity = opacity;
  return material;
}

function createSpellRing(color, radius = 0.55, thickness = 0.035) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(radius, thickness, 8, 36),
    spellMaterial(color, 0.8),
  );
  ring.rotation.x = Math.PI / 2;
  return ring;
}

function setVisualOpacity(root, opacity) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material?.transparent) material.opacity = (material.userData.baseOpacity ?? 1) * opacity;
    }
  });
}

function disposeVisual(root) {
  if (!root) return;
  root.parent?.remove(root);
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material?.dispose());
  });
}

function spellCastLabel(action) {
  return action === 'fire'
    ? 'CAST FIRE'
    : action === 'freeze'
      ? 'CAST FROST'
      : action === 'heal'
        ? 'CAST HEAL'
        : 'RAISE WARD';
}

function spawnSpellCharge(action) {
  const color = SPELL_COLORS[action];
  const root = new THREE.Group();
  root.name = `spell-charge-${action}`;
  root.position.set(0, 1.14, 0.48);
  const ring = createSpellRing(color, action === 'heal' ? 0.5 : 0.42, 0.035);
  root.add(ring);
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(action === 'heal' ? 0.13 : 0.16, 1),
    spellMaterial(color, 0.9),
  );
  orb.position.y = 0.08;
  root.add(orb);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(action === 'heal' ? 0.25 : 0.3, 12, 8),
    spellMaterial(color, 0.14),
  );
  halo.position.y = 0.08;
  root.add(halo);
  if (action === 'freeze') {
    const frostRing = createSpellRing(0xdaf5ff, 0.28, 0.022);
    frostRing.rotation.y = Math.PI / 2;
    root.add(frostRing);
  }
  if (action === 'heal') {
    const liftRing = createSpellRing(0xc6f5d5, 0.28, 0.022);
    liftRing.position.y = 0.32;
    root.add(liftRing);
  }
  player.root.add(root);
  spellVisuals.push({
    kind: 'charge',
    action,
    root,
    life: SPELL_CAST_TIMES[action],
    maxLife: SPELL_CAST_TIMES[action],
  });
  playSfx(`cast-${action}`);
  if (action !== 'buff') {
    spawnCombatText(player.root.position, spellCastLabel(action), `#${new THREE.Color(color).getHexString()}`, player.height + 0.18);
  }
}

function createSpellProjectile(action) {
  const color = SPELL_COLORS[action];
  const root = new THREE.Group();
  root.name = `spell-projectile-${action}`;
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(action === 'fire' ? 0.16 : 0.14, 1), spellMaterial(color, 0.95));
  root.add(core);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(action === 'fire' ? 0.32 : 0.27, 12, 8), spellMaterial(color, 0.16));
  root.add(halo);
  const ring = createSpellRing(action === 'fire' ? 0xffd27a : 0xdaf5ff, action === 'fire' ? 0.24 : 0.2, 0.025);
  ring.rotation.y = Math.PI / 2;
  root.add(ring);
  for (let index = 0; index < 3; index += 1) {
    const tail = new THREE.Mesh(
      new THREE.SphereGeometry(action === 'fire' ? 0.07 : 0.055, 8, 6),
      spellMaterial(color, 0.32 - index * 0.07),
    );
    tail.position.z = 0.18 + index * 0.14;
    tail.scale.setScalar(1 - index * 0.18);
    root.add(tail);
  }
  return root;
}

function spellTargetPosition(target) {
  return spellTarget.copy(target.root.position).setY(target.root.position.y + target.height * 0.56).clone();
}

function spawnSpellProjectile(action, target) {
  if (!target || target.dead) return;
  spellOrigin.set(0, 1.14, 0.66);
  player.root.localToWorld(spellOrigin);
  const destination = spellTargetPosition(target);
  const distance = spellOrigin.distanceTo(destination);
  const speed = action === 'fire' ? 18 : 15;
  const root = createSpellProjectile(action);
  root.position.copy(spellOrigin);
  scene.add(root);
  spellProjectiles.push({
    action,
    root,
    target,
    start: spellOrigin.clone(),
    destination,
    duration: THREE.MathUtils.clamp(distance / speed, 0.22, 0.58),
    life: 0,
  });
  playSfx(action === 'fire' ? 'fire-launch' : 'frost-launch');
}

function spawnSpellImpact(action, position) {
  const color = SPELL_COLORS[action];
  const root = new THREE.Group();
  root.name = `spell-impact-${action}`;
  root.position.copy(position);
  root.position.y += 0.045;
  const ring = createSpellRing(color, action === 'freeze' ? 0.42 : 0.34, 0.045);
  root.add(ring);
  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(action === 'freeze' ? 0.22 : 0.25, 12, 8),
    spellMaterial(color, 0.32),
  );
  flash.position.y = 0.58;
  root.add(flash);
  if (action === 'freeze') {
    for (let index = 0; index < 6; index += 1) {
      const shard = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.36, 5), spellMaterial(0xdaf5ff, 0.78));
      const angle = (index / 6) * Math.PI * 2;
      shard.position.set(Math.cos(angle) * 0.35, 0.22, Math.sin(angle) * 0.35);
      shard.rotation.z = Math.cos(angle) * 0.7;
      shard.rotation.x = Math.sin(angle) * 0.7;
      root.add(shard);
    }
  }
  scene.add(root);
  spellVisuals.push({ kind: 'impact', action, root, life: 0.46, maxLife: 0.46 });
  spawnBurst(position, color, action === 'freeze' ? 18 : 16);
  playSfx(action === 'fire' ? 'fire-impact' : action === 'freeze' ? 'frost-impact' : action === 'buff' ? 'ward-impact' : 'heal-impact');
  addCameraFeedback(action === 'freeze' ? 0.1 : 0.075, action === 'freeze' ? 1.1 : 0.8);
}

function clearWardVisual() {
  if (!wardVisual) return;
  disposeVisual(wardVisual.root);
  wardVisual = null;
}

function activateWardVisual() {
  clearWardVisual();
  const root = new THREE.Group();
  root.name = 'ward-shell';
  root.position.y = 1.02;
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 20, 14),
    new THREE.MeshBasicMaterial({
      color: SPELL_COLORS.buff,
      transparent: true,
      opacity: 0.12,
      wireframe: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  shell.material.userData.baseOpacity = 0.12;
  root.add(shell);
  root.add(createSpellRing(SPELL_COLORS.buff, 0.86, 0.035));
  const orbit = new THREE.Group();
  root.add(orbit);
  for (let index = 0; index < 6; index += 1) {
    const plate = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), spellMaterial(0xe7d8ff, 0.52));
    const angle = (index / 6) * Math.PI * 2;
    plate.position.set(Math.cos(angle) * 0.82, Math.sin(angle * 2) * 0.13, Math.sin(angle) * 0.82);
    plate.scale.set(1, 1.7, 0.34);
    orbit.add(plate);
  }
  player.root.add(root);
  wardVisual = { root, orbit, phase: 0 };
  spawnSpellImpact('buff', player.root.position);
}

function updateSpellProjectiles(delta) {
  for (let index = spellProjectiles.length - 1; index >= 0; index -= 1) {
    const projectile = spellProjectiles[index];
    projectile.life += delta;
    const progress = THREE.MathUtils.clamp(projectile.life / projectile.duration, 0, 1);
    const destination = projectile.target && !projectile.target.dead
      ? spellTargetPosition(projectile.target)
      : projectile.destination;
    projectile.root.position.lerpVectors(projectile.start, destination, progress);
    projectile.root.lookAt(destination);
    const pulse = 0.9 + Math.sin(projectile.life * 28) * 0.1;
    projectile.root.scale.setScalar(pulse);
    if (progress >= 1) {
      disposeVisual(projectile.root);
      spellProjectiles.splice(index, 1);
      const target = projectile.target;
      const impactPosition = target && !target.dead ? target.root.position.clone() : destination.clone();
      spawnSpellImpact(projectile.action, impactPosition);
      if (target && !target.dead) {
        if (projectile.action === 'freeze') {
          const damage = playerDamage(attackDamage('freeze', target.profileKey), 'freeze');
          target.frozenTimer = target.profileKey === 'warden' ? 3.5 : 6;
          target.attackPending = false;
          target.pendingEnemyAttack = null;
          applyEnemyDamage(target, damage, 0x8dcdf3, `${target.name} freezes solid.`);
          spawnCombatText(target.root.position, 'FROZEN', '#bfe7fa', target.height + 0.55);
        } else {
          const damage = playerDamage(attackDamage('fire', target.profileKey), 'fire');
          applyEnemyDamage(target, damage, 0xf27e68, `${target.name} burns for ${damage}.`);
        }
      }
    }
  }
}

function updateSpellVisuals(delta) {
  for (let index = spellVisuals.length - 1; index >= 0; index -= 1) {
    const visual = spellVisuals[index];
    visual.life -= delta;
    const progress = THREE.MathUtils.clamp(1 - visual.life / visual.maxLife, 0, 1);
    if (visual.kind === 'charge') {
      visual.root.rotation.y += delta * 2.8;
      visual.root.scale.setScalar(0.86 + Math.sin(progress * Math.PI) * 0.18);
      setVisualOpacity(visual.root, Math.min(1, 0.25 + (1 - progress) * 0.75));
    } else {
      visual.root.rotation.y += delta * 1.6;
      visual.root.scale.setScalar(0.55 + progress * 1.8);
      setVisualOpacity(visual.root, Math.max(0, 1 - progress));
    }
    if (visual.life <= 0) {
      disposeVisual(visual.root);
      spellVisuals.splice(index, 1);
    }
  }
}

function updateWardVisual(delta) {
  if (!wardVisual) return;
  if (state.playerBuffTimer <= 0 || state.finished || state.failed) {
    clearWardVisual();
    return;
  }
  wardVisual.phase += delta;
  wardVisual.orbit.rotation.y = wardVisual.phase * 0.8;
  const pulse = 1 + Math.sin(wardVisual.phase * 5) * 0.035;
  wardVisual.root.scale.setScalar(pulse);
  setVisualOpacity(wardVisual.root, 0.92 + Math.min(0.18, state.playerBuffTimer / 40));
}

function spawnCombatText(position, text, color = '#f3d093', height = 1.55) {
  const element = document.createElement('div');
  element.className = 'combat-text';
  element.textContent = text;
  element.style.color = color;
  document.body.append(element);
  combatTexts.push({
    element,
    position: position.clone().add(new THREE.Vector3(0, height, 0)),
    life: 1.05,
    maxLife: 1.05,
  });
}

function updateCombatTexts(delta) {
  for (let index = combatTexts.length - 1; index >= 0; index -= 1) {
    const item = combatTexts[index];
    item.life -= delta;
    item.position.y += delta * 0.7;
    projectedAnchor.copy(item.position).project(camera);
    const visible = projectedAnchor.z >= -1 && projectedAnchor.z <= 1;
    item.element.style.display = visible ? 'block' : 'none';
    item.element.style.left = `${(projectedAnchor.x * 0.5 + 0.5) * window.innerWidth}px`;
    item.element.style.top = `${(-projectedAnchor.y * 0.5 + 0.5) * window.innerHeight}px`;
    item.element.style.opacity = `${Math.max(0, item.life / item.maxLife)}`;
    item.element.style.transform = `translate(-50%, -50%) scale(${0.9 + (1 - item.life / item.maxLife) * 0.18})`;
    if (item.life <= 0) {
      item.element.remove();
      combatTexts.splice(index, 1);
    }
  }
}

function updateEnemyNameplates() {
  for (const enemy of enemies) {
    const nameplate = enemy.nameplate;
    if (!nameplate) continue;
    const distance = player.root.position.distanceTo(enemy.root.position);
    if (enemy.dead || !enemy.root.visible || distance > 10.5) {
      nameplate.element.classList.add('is-hidden');
      continue;
    }
    projectedAnchor.copy(enemy.root.position);
    projectedAnchor.y += enemy.height + 0.48;
    projectedAnchor.project(camera);
    const x = (projectedAnchor.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-projectedAnchor.y * 0.5 + 0.5) * window.innerHeight;
    const visible = projectedAnchor.z >= -1 && projectedAnchor.z <= 1
      && x > -70 && x < window.innerWidth + 70
      && y > 20 && y < window.innerHeight + 40;
    nameplate.element.classList.toggle('is-hidden', !visible);
    if (!visible) continue;
    nameplate.element.classList.toggle('is-alerted', enemy.awake && state.combatStarted && !enemy.evading);
    nameplate.element.classList.toggle('is-selected', selectedTarget === enemy);
    nameplate.element.style.left = `${x}px`;
    nameplate.element.style.top = `${y}px`;
    nameplate.healthFill.style.width = `${Math.max(0, enemy.hp / enemy.maxHp) * 100}%`;
    const attack = enemy.pendingEnemyAttack;
    if (!attack?.label) {
      nameplate.cast.classList.add('is-hidden');
      continue;
    }
    const duration = attack.duration ?? attack.castDuration ?? 1;
    const remaining = attack.timer ?? attack.castRemaining ?? 0;
    const progress = THREE.MathUtils.clamp(1 - remaining / duration, 0, 1);
    nameplate.cast.classList.remove('is-hidden');
    nameplate.castLabel.textContent = attack.label;
    nameplate.castFill.style.width = `${progress * 100}%`;
  }
}

function updateTownNpcNameplates() {
  for (const npc of townNpcs) {
    const nameplate = npc.nameplate;
    if (!nameplate) continue;
    const distance = player.root.position.distanceTo(npc.root.position);
    if (state.mode !== 'town' || !npc.root.visible || distance > 15) {
      nameplate.element.classList.add('is-hidden');
      continue;
    }
    projectedAnchor.copy(npc.root.position);
    projectedAnchor.y += npc.height + 0.42;
    projectedAnchor.project(camera);
    const x = (projectedAnchor.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-projectedAnchor.y * 0.5 + 0.5) * window.innerHeight;
    const visible = projectedAnchor.z >= -1 && projectedAnchor.z <= 1
      && x > -70 && x < window.innerWidth + 70
      && y > 20 && y < window.innerHeight + 40;
    nameplate.element.classList.toggle('is-hidden', !visible);
    if (!visible) continue;
    nameplate.element.classList.toggle('is-hunter', npc.role === 'Hunter');
    nameplate.element.style.left = `${x}px`;
    nameplate.element.style.top = `${y}px`;
  }
}

function spawnTelegraph({ position, radius, duration, color = 0xd96d63, attack = null, onResolve }) {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), material);
  disc.rotation.x = -Math.PI / 2;
  disc.position.copy(position);
  disc.position.y = 0.045;
  scene.add(disc);
  telegraphs.push({ disc, material, life: duration, duration, radius, attack, onResolve });
}

function updateTelegraphs(delta) {
  for (let index = telegraphs.length - 1; index >= 0; index -= 1) {
    const telegraph = telegraphs[index];
    telegraph.life -= delta;
    if (telegraph.attack) telegraph.attack.castRemaining = Math.max(0, telegraph.life);
    const progress = 1 - Math.max(0, telegraph.life / telegraph.duration);
    const pulse = 0.92 + Math.sin(progress * Math.PI * 8) * 0.035;
    telegraph.disc.scale.setScalar(pulse);
    telegraph.material.opacity = 0.13 + progress * 0.32;
    if (telegraph.life <= 0) {
      scene.remove(telegraph.disc);
      telegraph.disc.geometry.dispose();
      telegraph.material.dispose();
      telegraphs.splice(index, 1);
      telegraph.onResolve?.();
    }
  }
}

function updateEffects(delta) {
  for (let index = effects.length - 1; index >= 0; index -= 1) {
    const effect = effects[index];
    effect.life -= delta;
    effect.velocity.y -= delta * 2.8;
    effect.mesh.position.addScaledVector(effect.velocity, delta);
    effect.mesh.material.opacity = Math.min(1, Math.max(0, effect.life));
    if (effect.life <= 0) {
      // Return the mesh to the pool; geometry and material stay alive.
      effect.mesh.visible = false;
      burstMeshPool.release(effect.mesh);
      effects.splice(index, 1);
    }
  }
}

function playerDamage(baseDamage, action) {
  return computePlayerDamage(baseDamage, {
    buffed: state.playerBuffTimer > 0,
    itemMultiplier: itemDamageMultiplier(action),
  });
}

function applyEnemyDamage(target, damage, color, message) {
  if (!target || target.dead) return;
  target.hp = Math.max(0, target.hp - damage);
  target.attackLock = 0.28;
  target.play(['hit'], { once: true, force: true });
  spawnBurst(target.root.position, color, 10);
  spawnCombatText(target.root.position, `${damage}`, `#${new THREE.Color(color).getHexString()}`, target.height + 0.2);
  addCameraFeedback(target.profileKey === 'warden' ? 0.16 : 0.08, target.profileKey === 'warden' ? 1.5 : 0.75);
  if (target.hp <= 0) {
    target.dead = true;
    target.deathTimer = 0.95;
    target.play(['death'], { once: true, force: true });
    spawnLootDrop(target);
    setToast(`${target.name} falls.`);
  } else {
    setToast(message, 1000);
  }
}

function applyPlayerAction() {
  const action = player.pendingAction;
  const target = player.attackTarget;
  player.pendingAction = null;
  player.attackTarget = null;
  if (action === 'heal' || action === 'buff') {
    applySelfAction(action);
    return;
  }
  if (!target || target.dead) return;

  const distance = player.root.position.distanceTo(target.root.position);
  if (distance > ACTIONS[action].range) return;
  // Melee resolves immediately; spells fly as projectiles that apply
  // their own impact effects on arrival (see updateSpellProjectiles).
  if (action === 'sword') {
    const damage = playerDamage(attackDamage('sword', target.profileKey), action);
    playSfx('sword');
    applyEnemyDamage(target, damage, 0xe9b36f, `${target.name} takes ${damage} damage.`);
  } else {
    spawnSpellProjectile(action, target);
  }
}

function applySelfAction(action) {
  if (action === 'heal') {
    const restored = Math.min(
      Math.round(state.playerMaxHp * HEAL_FRACTION),
      state.playerMaxHp - state.playerHp,
    );
    state.playerHp += restored;
    updateHealthUi();
    spawnSpellImpact('heal', player.root.position);
    spawnCombatText(player.root.position, `+${restored}`, '#9fe1bb', player.height + 0.2);
    setToast(restored > 0 ? `Vitality restored by ${restored}.` : 'Vitality is already full.');
  } else if (action === 'buff') {
    state.playerBuffTimer = 8;
    activateWardVisual();
    spawnCombatText(player.root.position, 'WARD', '#d8b5f0', player.height + 0.2);
    setToast('Arcane buff active: enemy damage is negated for 8s.');
  }
}

function useAction(action, target = selectedTarget) {
  if (!state.loaded || state.finished || state.failed) return;
  const actionDef = ACTIONS[action];
  if (!actionDef) return;
  const selfAction = action === 'heal' || action === 'buff';
  if (!selfAction && (!target || target === player || target.dead || !isEnemyAccessible(target))) {
    if (target?.dead || (target && target !== player && !isEnemyAccessible(target))) {
      clearSelectedTarget({ silent: true });
    }
    setToast('Select a living enemy target first.', 1100);
    return;
  }
  const remaining = state.actionCooldowns[action] ?? 0;
  if (remaining > 0) {
    setToast(`${ACTION_NAMES[action]} is ready in ${remaining.toFixed(1)}s.`, 1000);
    return;
  }
  if (player.attackLock > 0 || player.attackCooldown > 0) {
    setToast('The cryptwalker is still recovering.', 1000);
    return;
  }
  if (action === 'heal' && state.playerHp >= state.playerMaxHp) {
    setToast('Vitality is already full.', 1000);
    return;
  }
  const runtime = ACTION_RUNTIME[action];
  if (!selfAction) {
    if (player.root.position.distanceTo(target.root.position) > actionDef.range) {
      setToast(`${target.name} is out of range.`, 1100);
      return;
    }
    state.combatStarted = true;
    state.weaponReadyTimer = 4.5;
    player.setWeaponSheathed(false);
    player.attackTarget = target;
    player.face(target.root.position);
    player.play(runtime.clips ?? [runtime.castClip], { once: true, force: true });
  } else {
    player.attackTarget = null;
    player.play([runtime.castClip], { once: true, force: true });
  }
  player.attackLock = runtime.attackLock;
  player.attackCooldown = runtime.attackCooldown;
  player.attackTimer = runtime.attackTimer;
  player.pendingAction = action;
  if (action !== 'sword') spawnSpellCharge(action);
  state.actionCooldowns[action] = actionCooldownFor(action);
  state.started = true;
}

function attemptAttack() {
  const target = selectedTarget && selectedTarget !== player && !selectedTarget.dead ? selectedTarget : null;
  if (!target) {
    state.started = true;
    setToast('Select an enemy target first.');
    return;
  }
  useAction('sword', target);
}

function damagePlayer(amount, sourceName) {
  if (state.finished || state.failed) return;
  if (state.playerBuffTimer > 0) {
    setToast(`${sourceName}'s hit is absorbed.`, 900);
    spawnCombatText(player.root.position, 'ABSORBED', '#d8b5f0', player.height + 0.15);
    return;
  }
  state.playerHp = Math.max(0, state.playerHp - amount);
  state.weaponReadyTimer = 4.5;
  player.setWeaponSheathed(false);
  player.play(['hit'], { once: true, force: true });
  player.attackLock = Math.max(player.attackLock, 0.32);
  updateHealthUi();
  spawnCombatText(player.root.position, `-${amount}`, '#f19b87', player.height + 0.2);
  playSfx('hurt');
  addCameraFeedback(0.22, 1.8);
  setToast(`${sourceName} hits for ${amount}.`, 1050);
  if (state.playerHp <= 0) finishRun(false);
}

function updatePlayer(delta) {
  if (player.dead) return;
  state.footstepTimer = Math.max(0, state.footstepTimer - delta);
  if (player.attackTimer > 0) {
    player.attackTimer -= delta;
    if (player.attackTimer <= 0) applyPlayerAction();
  }
  if (player.attackLock <= 0) {
    const forwardInput = (keys.has('w') || keys.has('arrowup') ? 1 : 0)
      - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const strafeInput = (keys.has('d') || keys.has('arrowright') ? 1 : 0)
      - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    movementDirection.set(0, 0, 0);
    if (forwardInput !== 0 || strafeInput !== 0) {
      camera.getWorldDirection(cameraForward);
      cameraForward.y = 0;
      if (cameraForward.lengthSq() < 0.001) cameraForward.set(0, 0, -1);
      else cameraForward.normalize();
      cameraRight.crossVectors(cameraForward, worldUp).normalize();
      const cameraRelative = cameraRelativeDirection(cameraForward, cameraRight, forwardInput, strafeInput);
      movementDirection.set(cameraRelative.x, 0, cameraRelative.z);
      const speed = player.speed * (state.playerBuffTimer > 0 ? 1.25 : 1);
      moveActorWithinMap(player, movementDirection.x * speed * delta, movementDirection.z * speed * delta, 0.65);
      player.faceDirection(movementDirection);
      player.play(['running', 'walking']);
      if (state.footstepTimer <= 0) {
        playSfx('step');
        state.footstepTimer = 0.34;
      }
    } else {
      player.play(['idle']);
    }
  }
  sampleKeyboardSmokeMovement();
}

function updateWeaponState(delta) {
  state.weaponReadyTimer = Math.max(0, state.weaponReadyTimer - delta);
  const nearbyThreat = enemies.some((enemy) => (
    !enemy.dead
    && enemy.awake
    && !enemy.evading
    && player.root.position.distanceToSquared(enemy.root.position) < 8 ** 2
  ));
  player.setWeaponSheathed(state.weaponReadyTimer <= 0 && !nearbyThreat && player.attackLock <= 0);
  if (state.weaponUiSheathed === player.weaponSheathed) return;
  state.weaponUiSheathed = player.weaponSheathed;
  equippedItem.dataset.weaponState = player.weaponSheathed ? 'sheathed' : 'drawn';
  equippedItem.setAttribute('aria-label', `Weapon ${player.weaponSheathed ? 'sheathed' : 'drawn'}`);
}

function moveEnemy(enemy, direction, speed, delta) {
  if (direction.lengthSq() <= 0.001) return;
  direction.normalize();
  moveActorWithinMap(enemy, direction.x * speed * delta, direction.z * speed * delta, 0.65);
  enemy.faceDirection(direction);
  enemy.play(['running', 'walking']);
}

function startEnemyEvade(enemy) {
  enemy.evading = true;
  enemy.awake = false;
  enemy.attackPending = false;
  enemy.pendingEnemyAttack = null;
  enemy.attackLock = 0;
  spawnCombatText(enemy.root.position, 'RESET', '#c7bdce', enemy.height + 0.2);
}

function updateEnemyEvade(enemy, delta) {
  tempVector.subVectors(enemy.spawnPosition, enemy.root.position).setY(0);
  if (tempVector.length() <= 0.32) {
    enemy.root.position.copy(enemy.spawnPosition);
    enemy.hp = enemy.maxHp;
    enemy.evading = false;
    enemy.attackCooldown = 1;
    enemy.play(['idle_combat', 'idle'], { force: true });
    return;
  }
  moveEnemy(enemy, tempVector, enemy.speed * 1.25, delta);
}

function startMeleeAttack(enemy, profile) {
  enemy.pendingEnemyAttack = {
    kind: 'melee',
    timer: profile.windup,
    duration: profile.windup,
    range: profile.attackRange,
    damage: profile.damage,
    label: profile.kind === 'warden' ? 'HEAVY STRIKE' : 'STRIKE',
  };
  enemy.attackCooldown = profile.attackCooldown;
  enemy.attackLock = profile.windup + 0.38;
  enemy.face(player.root.position);
  enemy.play(['1h_melee_attack', 'melee_attack', 'attack'], { once: true, force: true });
}

function startGroundAttack(enemy, profile, { wardenSlam = false, phaseTwo = false } = {}) {
  const soulCollapse = wardenSlam && phaseTwo;
  const position = soulCollapse
    ? player.root.position.clone()
    : wardenSlam
      ? enemy.root.position.clone()
      : player.root.position.clone();
  const radius = soulCollapse ? 2.35 : wardenSlam ? 3.9 : profile.radius;
  const damage = soulCollapse ? 12 : wardenSlam ? 10 : profile.damage;
  const label = soulCollapse
    ? 'SOUL COLLAPSE'
    : wardenSlam
      ? 'WARDEN SLAM'
      : profile.kind === 'support'
        ? 'GRAVE BOLT'
        : 'DEATH PULSE';
  const castDuration = soulCollapse ? 1.05 : wardenSlam ? 1.2 : profile.windup;
  const attack = { kind: 'ground', label, position, radius, damage, castDuration, castRemaining: castDuration };
  enemy.pendingEnemyAttack = attack;
  enemy.attackLock = castDuration + 0.3;
  enemy.attackCooldown = profile.attackCooldown;
  enemy.face(player.root.position);
  enemy.play(['1h_melee_attack', 'melee_attack', 'attack'], { once: true, force: true });
  spawnTelegraph({
    position,
    radius,
    duration: castDuration,
    color: soulCollapse ? 0x9a5ec1 : wardenSlam ? 0xc44743 : profile.kind === 'support' ? 0x9a69cf : 0xd57a62,
    attack,
    onResolve: () => {
      if (enemy.dead || enemy.frozenTimer > 0 || enemy.pendingEnemyAttack !== attack) return;
      enemy.pendingEnemyAttack = null;
      spawnBurst(position, soulCollapse ? 0xb978da : wardenSlam ? 0xe06252 : 0xb07bd3, soulCollapse ? 22 : wardenSlam ? 28 : 16);
      if (player.root.position.distanceTo(position) <= radius) damagePlayer(damage, enemy.name);
      else spawnCombatText(player.root.position, 'DODGED', '#a9d8ef', player.height + 0.2);
      if (soulCollapse) playSfx('warden-collapse');
    },
  });
}

function healWeakestAlly(enemy, profile) {
  let target = null;
  for (const ally of enemies) {
    if (ally.dead || ally === enemy || !isEnemyAccessible(ally)) continue;
    if (ally.root.position.distanceTo(enemy.root.position) > 7.5) continue;
    if (ally.hp >= ally.maxHp) continue;
    if (!target || ally.hp / ally.maxHp < target.hp / target.maxHp) target = ally;
  }
  if (!target) return false;
  const restored = Math.min(profile.heal, target.maxHp - target.hp);
  target.hp += restored;
  enemy.attackCooldown = profile.attackCooldown;
  enemy.attackLock = 0.75;
  enemy.face(target.root.position);
  enemy.play(['1h_melee_attack', 'melee_attack', 'attack'], { once: true, force: true });
  spawnBurst(target.root.position, 0x9ad3ac, 14);
  spawnCombatText(target.root.position, `+${restored}`, '#9fe1bb', target.height + 0.2);
  setToast(`${enemy.name} restores ${target.name}.`, 1000);
  return true;
}

function startWardenPhaseTwo(enemy) {
  if (enemy.bossPhase >= 2 || enemy.dead) return;
  enemy.bossPhase = 2;
  enemy.speed *= 1.18;
  enemy.specialCooldown = 1.5;
  enemy.attackCooldown = Math.min(enemy.attackCooldown, 0.65);

  const phaseVisual = new THREE.Group();
  phaseVisual.name = 'warden-phase-two-mark';
  phaseVisual.position.y = 0.05;
  phaseVisual.add(createSpellRing(0xde7290, 1.28, 0.05));
  const innerRing = createSpellRing(0x9a5ec1, 0.86, 0.028);
  innerRing.rotation.z = Math.PI / 2;
  phaseVisual.add(innerRing);
  enemy.root.add(phaseVisual);

  scene.background.set('#110a15');
  scene.fog.color.set('#140a18');
  if (moonLight) {
    moonLight.color.set(0xe5a1bb);
    moonLight.intensity = 1.75;
  }
  spawnBurst(enemy.root.position, 0xc45f83, 30);
  spawnCombatText(enemy.root.position, 'PHASE II', '#ef9ab2', enemy.height + 0.6);
  addCameraFeedback(0.25, 1.8);
  playSfx('warden-phase');
  setToast('The Crypt Warden tears open the dark. Keep moving.', 2800);
}

function spawnWardenAdds() {
  if (state.wardenSummoned) return;
  state.wardenSummoned = true;
  for (const x of [-4.2, 4.2]) {
    const add = spawnActor({
      assetKey: 'skeletonWarrior',
      type: 'enemy',
      name: 'Warden Thrall',
      x,
      z: -43,
      height: 1.75,
      maxHp: 200,
      speed: 1.2,
      profileKey: 'rusher',
      roomId: 'wardenKeep',
    });
    add.awake = true;
    enemies.push(add);
    spawnBurst(add.root.position, 0x9a73bd, 18);
  }
  setToast('The Crypt Warden calls two thralls from the dust!', 2600);
}

function updatePendingMelee(enemy, delta) {
  const attack = enemy.pendingEnemyAttack;
  if (!attack || attack.kind !== 'melee') return false;
  attack.timer -= delta;
  if (attack.timer <= 0) {
    enemy.pendingEnemyAttack = null;
    if (player.root.position.distanceTo(enemy.root.position) <= attack.range) {
      damagePlayer(attack.damage, enemy.name);
    } else {
      spawnCombatText(player.root.position, 'MISSED', '#a9d8ef', player.height + 0.2);
    }
  }
  return true;
}

function updateEnemy(enemy, delta) {
  if (enemy.dead) {
    enemy.deathTimer -= delta;
    if (enemy.deathTimer <= 0) enemy.root.visible = false;
    return;
  }
  if (!state.started || !state.combatStarted || !isEnemyAccessible(enemy)) {
    enemy.face(player.root.position);
    enemy.play(['idle_combat', 'idle']);
    return;
  }
  if (enemy.evading) {
    updateEnemyEvade(enemy, delta);
    return;
  }

  const profile = ENEMY_PROFILES[enemy.profileKey] ?? ENEMY_PROFILES.guard;
  const distance = player.root.position.distanceTo(enemy.root.position);
  if (!enemy.awake && distance > (profile.attackRange + 3.2)) {
    enemy.play(['idle_combat', 'idle']);
    return;
  }
  enemy.awake = true;

  if (enemy.root.position.distanceTo(enemy.spawnPosition) > profile.leash) {
    startEnemyEvade(enemy);
    return;
  }
  if (enemy.frozenTimer > 0) {
    enemy.attackPending = false;
    enemy.pendingEnemyAttack = null;
    enemy.face(player.root.position);
    enemy.play(['idle_combat', 'idle']);
    return;
  }
  if (updatePendingMelee(enemy, delta)) return;
  if (enemy.pendingEnemyAttack?.kind === 'ground') return;

  if (enemy.profileKey === 'warden') {
    if (enemy.hp <= enemy.maxHp * 0.55) spawnWardenAdds();
    if (enemy.hp <= enemy.maxHp * 0.5) startWardenPhaseTwo(enemy);
    const phaseTwo = enemy.bossPhase >= 2;
    const specialRange = phaseTwo ? 8.5 : 5.5;
    if (enemy.specialCooldown <= 0 && distance <= specialRange) {
      enemy.specialCooldown = phaseTwo ? 5.2 : profile.slamCooldown;
      startGroundAttack(enemy, profile, { wardenSlam: true, phaseTwo });
      return;
    }
  }
  if (enemy.profileKey === 'support' && enemy.attackCooldown <= 0 && healWeakestAlly(enemy, profile)) return;

  if (enemy.attackLock > 0) {
    enemy.face(player.root.position);
    return;
  }

  if (profile.kind === 'pulse' || profile.kind === 'support') {
    if (distance > profile.desiredRange) {
      tempVector.subVectors(player.root.position, enemy.root.position).setY(0);
      moveEnemy(enemy, tempVector, enemy.speed, delta);
    } else if (distance < profile.desiredRange - 1.4) {
      tempVector.subVectors(enemy.root.position, player.root.position).setY(0);
      moveEnemy(enemy, tempVector, enemy.speed * 0.75, delta);
    } else {
      enemy.face(player.root.position);
      enemy.play(['idle_combat', 'idle']);
    }
    if (enemy.attackCooldown <= 0 && distance <= profile.attackRange) startGroundAttack(enemy, profile);
    return;
  }

  if (distance > profile.desiredRange) {
    tempVector.subVectors(player.root.position, enemy.root.position).setY(0);
    moveEnemy(enemy, tempVector, enemy.speed * (profile.chaseMult ?? 1), delta);
  } else {
    enemy.face(player.root.position);
    enemy.play(['idle_combat', 'idle']);
    if (enemy.attackCooldown <= 0 && distance <= profile.attackRange) startMeleeAttack(enemy, profile);
  }
}

function minimapPoint(x, z) {
  const pad = 10;
  return {
    x: pad + ((x - WORLD.minX) / (WORLD.maxX - WORLD.minX)) * (minimap.width - pad * 2),
    y: pad + ((z - WORLD.minZ) / (WORLD.maxZ - WORLD.minZ)) * (minimap.height - pad * 2),
  };
}

function townMinimapPoint(x, z) {
  const pad = 10;
  return {
    x: pad + ((x - TOWN_WORLD.minX) / (TOWN_WORLD.maxX - TOWN_WORLD.minX)) * (minimap.width - pad * 2),
    y: pad + ((z - TOWN_WORLD.minZ) / (TOWN_WORLD.maxZ - TOWN_WORLD.minZ)) * (minimap.height - pad * 2),
  };
}

function drawMinimapZone(zone, fill, stroke, lineWidth = 1) {
  const first = minimapPoint(zone.minX, zone.minZ);
  const second = minimapPoint(zone.maxX, zone.maxZ);
  minimapContext.fillStyle = fill;
  minimapContext.strokeStyle = stroke;
  minimapContext.lineWidth = lineWidth;
  minimapContext.fillRect(first.x, first.y, second.x - first.x, second.y - first.y);
  minimapContext.strokeRect(first.x, first.y, second.x - first.x, second.y - first.y);
}

function updateMinimap(delta, force = false) {
  state.minimapTimer -= delta;
  if (!force && state.minimapTimer > 0) return;
  state.minimapTimer = 0.1;
  minimapContext.clearRect(0, 0, minimap.width, minimap.height);
  minimapContext.fillStyle = '#070912';
  minimapContext.fillRect(0, 0, minimap.width, minimap.height);

  if (state.mode === 'town') {
    const first = townMinimapPoint(TOWN_WORLD.minX, TOWN_WORLD.minZ);
    const second = townMinimapPoint(TOWN_WORLD.maxX, TOWN_WORLD.maxZ);
    minimapContext.fillStyle = 'rgba(63, 99, 70, 0.95)';
    minimapContext.fillRect(first.x, first.y, second.x - first.x, second.y - first.y);
    minimapContext.fillStyle = 'rgba(155, 130, 96, 0.9)';
    const roadStart = townMinimapPoint(-2.1, TOWN_WORLD.minZ);
    const roadEnd = townMinimapPoint(2.1, TOWN_WORLD.maxZ);
    minimapContext.fillRect(roadStart.x, roadStart.y, roadEnd.x - roadStart.x, roadEnd.y - roadStart.y);
    const crossStart = townMinimapPoint(TOWN_WORLD.minX, 2.25);
    const crossEnd = townMinimapPoint(TOWN_WORLD.maxX, 5.35);
    minimapContext.fillRect(crossStart.x, crossStart.y, crossEnd.x - crossStart.x, crossEnd.y - crossStart.y);
    for (const npc of townNpcs) {
      const point = townMinimapPoint(npc.root.position.x, npc.root.position.z);
      minimapContext.fillStyle = npc.role === 'Hunter' ? '#e7c16f' : '#b8a0e8';
      minimapContext.beginPath();
      minimapContext.arc(point.x, point.y, npc.role === 'Hunter' ? 3.4 : 2.6, 0, Math.PI * 2);
      minimapContext.fill();
    }
    const playerPoint = townMinimapPoint(player.root.position.x, player.root.position.z);
    minimapContext.fillStyle = '#fff5df';
    minimapContext.beginPath();
    minimapContext.arc(playerPoint.x, playerPoint.y, 3.6, 0, Math.PI * 2);
    minimapContext.fill();
    return;
  }

  for (const corridor of MAP.corridors) {
    drawMinimapZone(corridor, 'rgba(48, 47, 65, 0.8)', 'rgba(111, 103, 132, 0.36)');
  }
  for (const room of MAP.rooms) {
    const discovered = state.discoveredRooms.has(room.id);
    const branch = ROOM_BRANCH[room.id];
    const fill = !discovered
      ? 'rgba(20, 22, 33, 0.9)'
      : branch === 'west'
        ? 'rgba(91, 66, 57, 0.92)'
        : branch === 'east'
          ? 'rgba(47, 75, 88, 0.92)'
          : branch === 'north'
            ? 'rgba(67, 54, 88, 0.92)'
            : 'rgba(62, 61, 81, 0.92)';
    const current = room.id === state.currentRoomId;
    drawMinimapZone(
      room,
      fill,
      current ? 'rgba(242, 218, 169, 0.95)' : discovered ? 'rgba(164, 150, 179, 0.65)' : 'rgba(71, 72, 87, 0.5)',
      current ? 2 : 1,
    );
  }

  for (const chest of state.chests) {
    if (chest.opened || !state.discoveredRooms.has(chest.roomId)) continue;
    const point = minimapPoint(chest.position.x, chest.position.z);
    minimapContext.fillStyle = chest.kind === 'seal' || chest.kind === 'archive' ? '#e7c16f' : '#9b8766';
    minimapContext.fillRect(point.x - 2.5, point.y - 2.5, 5, 5);
  }
  const playerPoint = minimapPoint(player.root.position.x, player.root.position.z);
  minimapContext.fillStyle = '#c9b2f0';
  minimapContext.strokeStyle = '#fff5df';
  minimapContext.lineWidth = 1.4;
  minimapContext.beginPath();
  minimapContext.arc(playerPoint.x, playerPoint.y, 4, 0, Math.PI * 2);
  minimapContext.fill();
  minimapContext.stroke();
  minimapContext.beginPath();
  minimapContext.moveTo(playerPoint.x, playerPoint.y);
  minimapContext.lineTo(
    playerPoint.x + Math.sin(player.root.rotation.y) * 8,
    playerPoint.y + Math.cos(player.root.rotation.y) * 8,
  );
  minimapContext.stroke();
}

function updateCamera(delta) {
  camera.position.sub(state.cameraOffset);
  state.cameraOffset.set(0, 0, 0);
  const followFactor = 1 - Math.pow(0.0005, delta);
  const shiftX = (player.root.position.x - controls.target.x) * followFactor;
  const shiftZ = (player.root.position.z - controls.target.z) * followFactor;
  controls.target.x += shiftX;
  controls.target.z += shiftZ;
  camera.position.x += shiftX;
  camera.position.z += shiftZ;
  controls.update();
  state.cameraShake = THREE.MathUtils.damp(state.cameraShake, 0, 9, delta);
  state.cameraFovKick = THREE.MathUtils.damp(state.cameraFovKick, 0, 7, delta);
  if (state.cameraShake > 0.001) {
    state.cameraOffset.set(
      (Math.random() - 0.5) * state.cameraShake,
      (Math.random() - 0.5) * state.cameraShake * 0.6,
      (Math.random() - 0.5) * state.cameraShake,
    );
    camera.position.add(state.cameraOffset);
  }
  const nextFov = THREE.MathUtils.damp(camera.fov, 43 - state.cameraFovKick, 10, delta);
  if (Math.abs(nextFov - camera.fov) > 0.001) {
    camera.fov = nextFov;
    camera.updateProjectionMatrix();
  }
  if (moonLight && state.mode === 'dungeon') {
    moonLight.position.set(player.root.position.x - 5, 12, player.root.position.z + 7);
    moonLight.target.position.set(player.root.position.x, 0, player.root.position.z);
  }
}

function openChest(chest) {
  if (!chest || chest.opened) return;
  const blockReason = chestBlockReason(chest);
  if (blockReason) {
    setToast(blockReason, 2200);
    return;
  }
  chest.opened = true;
  chest.root.visible = false;
  chest.rewardRoot = createStatic('chestGold', {
    x: chest.position.x,
    z: chest.position.z,
    width: 1.35,
    height: 1.05,
    parent: zoneRenderGroups.get(chest.roomId),
    colliderWidth: 1.25,
    colliderDepth: 0.9,
  });
  applyChestRewards(state, chest, Object.keys(state.actionCooldowns));
  if (chest.kind === 'seal') {
    spawnCombatText(chest.position, `${chest.branch.toUpperCase()} SEAL`, '#f2cf7c', 1.8);
    setToast(`The ${chest.branch}ern branch seal is yours.`, 2400);
  } else if (chest.kind === 'archive') {
    spawnCombatText(chest.position, 'ARCHIVE KEY', '#c9b2f0', 1.8);
    setToast('The Archive key hums toward the Warden\'s Keep.', 2400);
  } else if (chest.kind === 'final') {
    spawnCombatText(chest.position, 'WARDEN RELIC', '#f2cf7c', 1.8);
    setToast('The Warden relic completes the delve. Return to the entrance.', 2400);
  } else {
    spawnCombatText(chest.position, 'RENEWED', '#9fe1bb', 1.8);
    setToast(`${chest.name} restores vitality and hastens your abilities.`);
  }
  updateHealthUi();
  updateProgression();
  updateQuestUi();
}

function interact() {
  if (!state.loaded || state.finished || state.failed) return;
  if (state.mode === 'town') {
    const nearbyNpc = nearestTownNpc(INTERACT_RADII.npc);
    if (nearbyNpc && !state.teleporting) {
      state.interactionCount += 1;
      state.lastInteraction = { kind: 'npc', id: nearbyNpc.name };
    }
    talkToTownNpc(nearbyNpc);
    return;
  }
  state.started = true;
  const candidate = interactionCandidate();
  if (!candidate) return;
  if (candidate.kind === 'loot') collectLootDrop(candidate.item);
  else if (candidate.kind === 'chest') openChest(candidate.item);
  else openGate(candidate.item);

  const resolved = {
    loot: () => (candidate.item.collected ? { kind: 'loot', id: candidate.item.itemId } : null),
    chest: () => (candidate.item.opened ? { kind: 'chest', id: candidate.item.id } : null),
    gate: () => (candidate.item.open ? { kind: 'gate', id: candidate.item.corridorId } : null),
  }[candidate.kind]();
  if (resolved) {
    state.interactionCount += 1;
    state.lastInteraction = resolved;
  }
}

function finishRun(success) {
  if (state.finished || state.failed) return;
  state.finished = success;
  state.failed = !success;
  clearWardVisual();
  if (success) {
    endEyebrow.textContent = 'CRYPT CLEARED';
    endTitle.textContent = 'The path is clear.';
    endCopy.textContent = 'You cleared every chamber in the expanded crypt.';
  } else {
    endEyebrow.textContent = 'THE CRYPT WINS';
    endTitle.textContent = 'The lanterns go dark.';
    endCopy.textContent = 'The route is short. Try again and keep the dead at sword’s reach.';
  }
  endScreen.classList.remove('is-hidden');
  targetCard.classList.add('is-hidden');
  interaction.classList.add('is-hidden');
  for (const enemy of enemies) enemy.nameplate?.element.classList.add('is-hidden');
  clearSelectedTarget({ silent: true });
  updateQuestUi();
}

function resetRun() {
  window.location.reload();
}

async function loadAssets() {
  const entries = Object.entries(ASSETS);
  for (let index = 0; index < entries.length; index += 1) {
    const [key, url] = entries[index];
    const label = key === 'knight' ? 'Calling the cryptwalker' : `Loading ${key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)}`;
    setLoading(0.08 + (index / entries.length) * 0.82, label);
    const gltf = await loader.loadAsync(url);
    assets.set(key, gltf);
  }
  setLoading(0.96, 'Lighting the last room');
}

function onKeyDown(event) {
  initAudio();
  const activeTag = document.activeElement?.tagName?.toLowerCase();
  if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;
  const action = ACTION_BY_KEY.get(event.code);
  if (action && !event.repeat) {
    useAction(action);
    event.preventDefault();
    return;
  }
  const key = event.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
    state.started = true;
    state.combatStarted = true;
    keys.add(key);
    event.preventDefault();
  }
  if (key === 'e' && !event.repeat) interact();
  if (key === 'escape' && !event.repeat) clearSelectedTarget();
  if (event.code === 'Space' && !event.repeat) {
    attemptAttack();
    event.preventDefault();
  }
}

function onKeyUp(event) {
  keys.delete(event.key.toLowerCase());
}

function updateTownActors(delta) {
  for (const npc of townNpcs) {
    npc.update(delta);
    if (!updateTownNpcPatrol(npc, delta)) {
      npc.face(player.root.position);
      npc.play(['idle', 'idle_combat']);
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  const frameDelta = clock.getDelta();
  updateAdaptiveQuality(frameDelta);
  const delta = Math.min(frameDelta, 0.05);
  if (state.loaded && !state.finished && !state.failed) {
    state.elapsed += delta;
    state.playerBuffTimer = Math.max(0, state.playerBuffTimer - delta);
    for (const action of Object.keys(state.actionCooldowns)) {
      state.actionCooldowns[action] = Math.max(0, state.actionCooldowns[action] - delta);
    }
    player.update(delta);
    updatePlayer(delta);
    updateWeaponState(delta);
    if (state.mode === 'dungeon') {
      updateProgression();
      if (isRunVictory({
        objectivesComplete: runObjectivesComplete(),
        distanceToExit: player.root.position.distanceTo(state.exitPosition),
      })) {
        finishRun(true);
      }
      for (const enemy of enemies) {
        if (enemy.dead && !enemy.root.visible) continue;
        const distanceSq = player.root.position.distanceToSquared(enemy.root.position);
        const roomVisible = visibleZoneIds.has(enemy.roomId);
        const shouldRender = roomVisible && distanceSq <= ENEMY_RENDER_DISTANCE_SQ;
        if (!enemy.dead && enemy.root.visible !== shouldRender) {
          enemy.root.visible = shouldRender;
        }
        const animationInterval = !roomVisible
          ? null
          : distanceSq > FULL_ANIMATION_DISTANCE_SQ ? DISTANT_ANIMATION_INTERVAL : 0;
        enemy.update(delta, animationInterval);
        if (!roomVisible) continue;
        if (!enemy.awake && !enemy.evading && distanceSq > ENEMY_SIMULATION_DISTANCE_SQ) continue;
        updateEnemy(enemy, delta);
      }
      updateEffects(delta);
      updateSpellProjectiles(delta);
      updateSpellVisuals(delta);
      updateWardVisual(delta);
      updateLootDrops(delta);
      updateTelegraphs(delta);
      updateCombatTexts(delta);
    } else {
      updateTownActors(delta);
    }
    updateBlobShadows();
    updateCamera(delta);
    state.overlayTimer -= delta;
    if (state.overlayTimer <= 0) {
      state.overlayTimer = 1 / 30;
      if (state.mode === 'dungeon') updateEnemyNameplates();
      else updateTownNpcNameplates();
    }
    updateMinimap(delta);
    updateInterface(delta);
    updateTargetMarker(delta);
  }
  const profile = window.__cryptProfile;
  if (profile?.active) {
    const info = renderer.info;
    profile.frames.push({
      t: performance.now(),
      calls: info.render.calls,
      tris: info.render.triangles,
      programs: info.programs?.length ?? 0,
      lights: dungeonLightPool.filter((light) => light.intensity > 0).length,
    });
  }
  renderer.render(state.mode === 'town' ? townScene : dungeonScene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(rendererPixelRatio());
});
window.addEventListener('keydown', onKeyDown, { passive: false });
window.addEventListener('keyup', onKeyUp);
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  initAudio();
  pointerPress = { x: event.clientX, y: event.clientY, time: performance.now() };
});
canvas.addEventListener('pointerup', (event) => {
  if (event.button !== 0 || !pointerPress) return;
  const distance = Math.hypot(event.clientX - pointerPress.x, event.clientY - pointerPress.y);
  const duration = performance.now() - pointerPress.time;
  pointerPress = null;
  if (distance < 8 && duration < 500) {
    const target = pickActor(event.clientX, event.clientY);
    if (target) selectTarget(target);
    else clearSelectedTarget();
  }
});
canvas.addEventListener('pointercancel', () => {
  pointerPress = null;
});
abilitySlots.forEach((button) => {
  button.addEventListener('click', () => useAction(button.dataset.ability));
});
backpackSlots.forEach((button) => {
  button.addEventListener('click', () => useInventorySlot(Number(button.dataset.inventorySlot)));
});
restartButton.addEventListener('click', resetRun);

async function start() {
  try {
    await loadAssets();
    buildWorld();
    setLoading(0.98, 'Settling the shadows');
    await renderer.compileAsync(scene, camera);
    await renderer.compileAsync(townScene, camera);
    state.loaded = true;
    updateModeUi();
    updateInterface(0, true);
    updateInventoryUi();
    updateMinimap(0, true);
    setLoading(1, 'Ravenrest is awake');
    window.setTimeout(() => loadingScreen.classList.add('is-hidden'), 420);
    setToast('Find Ranger Rowan by the archery yard.');
    window.__gameReady = true;
    publishE2eSnapshot(true);
  } catch (error) {
    console.error(error);
    loadingLabel.textContent = 'The asset bundle could not be opened. Check the browser console.';
    loadingFill.style.background = '#b5656b';
  }
}

animate();
start();

// --- Profiling instrumentation (opt in through __cryptRun) ---
window.__cryptProfile = null;
window.__cryptDone = false;
window.__cryptError = null;
window.__cryptMark = (label) => {
  const profile = window.__cryptProfile;
  if (profile?.active) profile.marks.push({ t: performance.now(), label });
};

window.__cryptRun = async (instant = false) => {
  const profile = window.__cryptProfile ??= createCryptProfile();
  profile.frames.length = 0;
  profile.zones.length = 0;
  profile.marks.length = 0;
  profile.active = true;
  window.__cryptDone = false;
  window.__cryptError = null;
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const walkTo = (x, z, timeoutMs = 20000) => waitForProfileTarget({
    x,
    z,
    setTarget: (target) => { window.__cryptWalkTarget = target; },
    getPosition: () => player.root.position,
    wait,
    timeoutMs,
  });
  const clearProfileRoom = () => clearEnemies((enemy) => enemy.roomId === state.currentRoomId);
  const openProfileGate = async (corridorId) => {
    const gate = findGate(corridorId);
    if (!gate) throw new Error(`Profile route has no gate for ${corridorId}.`);
    if (gate.open) return;
    await walkTo(gate.position.x, gate.position.z);
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
      await wait(1400);
      if (state.mode !== 'dungeon') throw new Error('Profile route did not enter the dungeon.');
    } else {
      enterDungeon();
      await wait(400);
    }
    window.__cryptMark('dungeon:entered');
    // Entrance -> hub.
    await openProfileGate('entry-corridor');
    await walkTo(0, 12.5);
    window.__cryptMark('room:hub');
    await wait(1200); // let hub lights/shaders settle
    // West branch: gate corridor -> gate room -> burial -> ossuary.
    await openProfileGate('west-corridor');
    await walkTo(-26, 9);
    window.__cryptMark('room:westGate');
    await wait(800);
    await openProfileGate('west-deep-corridor');
    await walkTo(-47, 9);
    window.__cryptMark('room:westBurial');
    await openProfileGate('west-drop');
    await walkTo(-47, -6);
    window.__cryptMark('room:westOssuary');
    await wait(800);
    // Return to hub, cross east.
    await walkTo(-47, 9);
    await openProfileGate('west-deep-corridor');
    await walkTo(-26, 9);
    await openProfileGate('west-corridor');
    await walkTo(0, 12.5);
    await openProfileGate('east-corridor');
    await walkTo(26, 9);
    window.__cryptMark('room:eastGate');
    await wait(800);
    await openProfileGate('east-deep-corridor');
    await walkTo(47, 9);
    window.__cryptMark('room:eastFlooded');
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
  }
};

// Auto-walk hook: when a profile target exists, inject movement toward it.
// Test-only: production keeps the unpatched updatePlayer.
if (E2E_ENABLED) {
  const originalUpdate = updatePlayer;
  updatePlayer = function patchedUpdatePlayer(delta) {
    const target = window.__cryptWalkTarget;
    if (target && player && !player.dead && player.attackLock <= 0) {
      movementDirection.set(target.x - player.root.position.x, 0, target.z - player.root.position.z);
      const distance = movementDirection.length();
      if (distance > 0.25) {
        movementDirection.normalize();
        moveActorWithinMap(player, movementDirection.x * player.speed * delta * 1.15, movementDirection.z * player.speed * delta * 1.15, 0.65);
        player.faceDirection(movementDirection);
        player.play(['running', 'walking']);
        state.started = true;
        state.combatStarted = true;
        sampleKeyboardSmokeMovement();
        return;
      }
    }
    originalUpdate(delta);
  };
}
// --- Fast functional-checkpoint surface (opt in through ?e2e) ---
// Not a performance instrument: it bypasses animation time. Use __cryptRun
// for any timing/frame measurement.
if (E2E_ENABLED) {
  const placeAt = (x, z) => {
    if (!player) throw new Error('World not built yet.');
    player.root.position.x = x;
    player.root.position.z = z;
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
    const startedAt = performance.now();
    e2eState.fastGateTransitions = 0;
    try {
      enterDungeon();
      state.started = true;
      clearAllEnemies();
      createLootVisual('healingDraft', player.root.position);
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

      placeAt(0, 12);
      openFastGate('east-corridor');
      placeAt(26, 9);
      openFastGate('east-deep-corridor');
      placeAt(47, 9);
      interactChestAt('drowned-cache', 47, 10);
      openFastGate('east-drop');
      interactChestAt('east-seal', 47, -12.5);

      placeAt(0, 12);
      openFastGate('north-corridor');
      placeAt(0, -10);
      openFastGate('archive-corridor');
      placeAt(0, -24);
      interactChestAt('archive-key', 0, -27);
      openFastGate('warden-corridor');
      placeAt(0, -42);
      interactChestAt('warden-spoils', 0, -47.5);
      // Use the real southern exit and let the animation loop invoke the
      // production completion condition after objectives are complete.
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
        lootCollected: snapshot.loot.some((drop) => drop.collected),
        interacted: snapshot.interactionCount >= requiredChestIds.length + 4,
        gateTraversal: e2eState.fastGateTransitions === state.gates.length,
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
    }
  };
  const startKeyboardSmoke = () => {
    const rowan = townNpcs.find((npc) => npc.role === 'Hunter');
    if (rowan) player.root.position.copy(rowan.root.position);
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
      sample: { x: player.root.position.x, z: player.root.position.z },
      pathDistance: 0,
      forwardTravel: 0,
    };
    setE2eResult(null);
  };
  const finishKeyboardSmoke = () => {
    const smoke = e2eState.smoke;
    if (!smoke) {
      setE2eResult({ kind: 'keyboard-smoke', pass: false, error: 'Smoke was not started.' });
      return;
    }
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

  const controls = document.createElement('section');
  controls.id = 'e2e-controls';
  controls.setAttribute('aria-label', 'Browser validation controls');
  controls.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;display:flex;gap:4px;';
  const addCommand = (command, label, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.e2eCommand = command;
    button.textContent = label;
    button.addEventListener('click', () => {
      try {
        handler();
      } catch (error) {
        setE2eResult({ kind: command, pass: false, error: error instanceof Error ? error.message : String(error), snapshot: e2eSnapshot() });
      }
      publishE2eSnapshot(true);
    });
    controls.append(button);
  };
  addCommand('smoke-start', 'Start keyboard smoke', startKeyboardSmoke);
  addCommand('smoke-finish', 'Finish keyboard smoke', finishKeyboardSmoke);
  addCommand('fast-checkpoint', 'Run fast checkpoint', runFastCheckpoint);
  app.append(controls);

  window.__cryptTest = {
    snapshot: e2eSnapshot,
    enterDungeon,
    placeAt,
    clearRoom() {
      if (!player) throw new Error('World not built yet.');
      clearEnemies((enemy) => enemy.roomId === state.currentRoomId);
    },
    openGateById(corridorId) {
      const gate = findGate(corridorId);
      if (!gate) throw new Error(`No gate for ${corridorId}.`);
      openGate(gate);
      return gate.open;
    },
  };
}
