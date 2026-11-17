import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Actor } from './actor.js';
import { createWorldBuilder } from './crypt-builder.js';
import { installDiagnostics } from './diagnostics.js';
import { createMinimap } from './minimap.js';
import { assets } from './models.js';
import {
  collectDungeonLightRecipes,
  createSlotPool,
} from './optimization-contracts.js';
import {
  cameraRelativeDirection,
  createNavigationContext,
  isWalkablePoint,
  stepActorWithinMap,
} from './movement-contracts.js';
import { initAudio, isMuted, playSfx, setMuted } from './audio.js';
import { browserStorage, clearCheckpoint, readCheckpoint, writeCheckpoint } from './save-game.js';
import { WORLD_DATA } from './world-data.js';
import {
  DUNGEON_ENTRANCE,
  EXIT_POSITION,
  HEAL_FRACTION,
  INTERACT_RADII,
  ROOM_ENTRY_CLEARANCE,
  applyChestRewards,
  applyGateOpen,
  attackDamage,
  computeZoneNeighbors,
  evaluateChestBlock,
  evaluateGateOpen,
  findRoomAt,
  findZoneAt,
  gateCrossing,
  gateTravelsAlongZ,
  gateWallPosition,
  hasBranchSeals,
  isArchiveGuardian,
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
const renderStatus = $('#render-status');
const endScreen = $('#end-screen');
const endEyebrow = $('#end-eyebrow');
const endTitle = $('#end-title');
const endCopy = $('#end-copy');
const restartButton = $('#restart-button');
const endNewGameButton = $('#end-new-game-button');
const pauseButton = $('#pause-button');
const pauseScreen = $('#pause-screen');
const resumeButton = $('#resume-button');
const soundButton = $('#sound-button');
const pauseNewGameButton = $('#pause-new-game-button');
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
  heal: { attackLock: 0.62, attackCooldown: 0.65, attackTimer: SPELL_CAST_TIMES.heal, castClip: 'Cast_Heal', spell: true },
  buff: { attackLock: 0.56, attackCooldown: 0.65, attackTimer: SPELL_CAST_TIMES.buff, castClip: 'Cast_Arcane', spell: true },
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
  paused: false,
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

const runInProgress = () => state.loaded && !state.finished && !state.failed;
const isRunActive = () => runInProgress() && !state.paused;
const canPlay = () => isRunActive() && !renderingPaused;
let renderingPaused = false;
// Diagnostics drive the game from a fresh town, so ?e2e runs never read or
// overwrite the player's checkpoint.
let saveStorage = E2E_ENABLED ? null : browserStorage();
let checkpointPosition = null;
const MUTED_KEY = 'forgotten-crypt:muted';

const keys = new Set();
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
const dungeonScene = new THREE.Scene();
const townScene = new THREE.Scene();
const scene = dungeonScene;
const {
  addBox,
  addBrickWall,
  buildRoomWalls,
  buildZoneRenderGroup,
  createFloorTiles,
  createGateStatic,
  createStatic,
  decorateRoom,
  roomCenter,
  shiftStaticObject,
  tileZone,
} = createWorldBuilder({ scene, staticColliders, zoneRenderGroups, recordZoneLight });
const updateMinimap = createMinimap({
  canvas: minimap,
  world: WORLD,
  townWorld: TOWN_WORLD,
  map: MAP,
  roomBranch: ROOM_BRANCH,
  state,
  townNpcs,
  getPlayer: () => player,
});
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

let renderer;
let controls;
const loader = new GLTFLoader();

function initializeRenderer() {
  renderer = new THREE.WebGLRenderer({
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

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 7;
  controls.maxDistance = 32;
  controls.minPolarAngle = THREE.MathUtils.degToRad(32);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(78);
  controls.target.set(0, 0.8, 0);
  controls.update();

  const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/');
  ktx2Loader.detectSupport(renderer);
  loader.setKTX2Loader(ktx2Loader);
  loader.setMeshoptDecoder(MeshoptDecoder);
}

function pauseRendering() {
  renderingPaused = true;
  controls.enabled = false;
  clearInputState();
  renderStatus.classList.remove('is-hidden');
}

function resumeRendering() {
  renderingPaused = false;
  controls.enabled = isRunActive() || !state.loaded;
  clock.getDelta();
  renderStatus.classList.add('is-hidden');
  if (state.teleporting && trailTimeout === null) enterDungeon();
}

const clock = new THREE.Clock();
const tempVector = new THREE.Vector3();
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
let trailTimeout = null;
let pointerPress = null;
let selectedTarget = null;
let moonLight = null;
let blobShadowMesh = null;
let townBlobShadowMesh = null;
let townWorldGroup = null;
let wardVisual = null;
let targetMarker = null;
let dialogueTimeout;

const blobShadowPosition = new THREE.Vector3();
const blobShadowScale = new THREE.Vector3();
const blobShadowRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const blobShadowMatrix = new THREE.Matrix4();

function setLoading(progress, label) {
  loadingFill.style.width = `${Math.round(progress * 100)}%`;
  loadingLabel.textContent = label;
}

function setToast(message, duration = 2200) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'), duration);
}

function addCameraFeedback(shake = 0.08, fovKick = 0.8) {
  state.cameraShake = Math.max(state.cameraShake, shake);
  state.cameraFovKick = Math.max(state.cameraFovKick, fovKick);
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

function moveGateAssemblyToRoom(gate, roomId) {
  gate.wallRoomId = roomId;
  const corridor = ZONE_BY_ID.get(gate.corridorId);
  const nextPosition = gateWallPosition(corridor, ZONE_BY_ID.get(roomId), gate.travelsAlongZ);
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
  const { x, z } = gateWallPosition(corridor, ZONE_BY_ID.get(roomId), travelsAlongZ);
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
  const endpointPositions = roomIds.map((roomId) => gateWallPosition(corridor, ZONE_BY_ID.get(roomId), travelsAlongZ));
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
    const [firstRoom, secondRoom] = roomIds.map((id) => ZONE_BY_ID.get(id));
    const travelsAlongZ = gateTravelsAlongZ(firstRoom, secondRoom);
    // MAP room order follows progression, so mount the gate on the wall of the
    // first connected room until the player opens it.
    const { x, z } = gateWallPosition(corridor, firstRoom, travelsAlongZ);
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
      wallRoomId: firstRoom.id,
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
    const enemy = spawnActor({
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
    });
    enemy.spawnId = spawn.id;
    enemies.push(enemy);
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

// Adapters from THREE positions to the shared world-rules geometry.
const roomAtPosition = (position, inset = 0) => findRoomAt(MAP.rooms, position.x, position.z, inset);
const zoneAtPosition = (position) => findZoneAt(MAP.zones, position.x, position.z);

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
  for (const enemy of enemies) {
    if (!isEnemyAccessible(enemy)) enemy.pendingEnemyAttack = null;
  }
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

function enterDungeon(checkpoint = null) {
  if (!canPlay() || state.mode === 'dungeon') return;
  window.clearTimeout(trailTimeout);
  trailTimeout = null;
  state.mode = 'dungeon';
  state.teleporting = false;
  for (const npc of townNpcs) npc.nameplate?.element.classList.add('is-hidden');
  window.clearTimeout(dialogueTimeout);
  dialogueCard.classList.add('is-hidden');
  state.started = false;
  state.combatStarted = false;
  player.root.removeFromParent();
  scene.add(player.root);
  const entry = checkpoint?.position ?? DUNGEON_ENTRANCE;
  player.root.position.set(entry.x, 0, entry.z);
  player.root.rotation.y = 0;
  player.setWeaponSheathed(true);
  state.currentRoomId = checkpoint?.roomId ?? 'entrance';
  state.currentZoneId = state.currentRoomId;
  state.discoveredRooms = new Set([...(checkpoint?.discoveredRooms ?? []), state.currentRoomId]);
  if (checkpoint) applyCheckpointProgress(checkpoint);
  checkpointPosition = { x: entry.x, z: entry.z };
  visibleZoneIds.clear();
  updateZoneVisibility(state.currentRoomId, true);
  camera.position.set(player.root.position.x + 10.6, 11.5, player.root.position.z + 12.2);
  controls.target.set(player.root.position.x, 0.8, player.root.position.z);
  controls.update();
  updateModeUi();
  updateMinimap(0, true);
  if (checkpoint) {
    setToast(`Resumed in ${ZONE_BY_ID.get(state.currentRoomId)?.label ?? 'the crypt'}.`, 2600);
  } else {
    showDialogue('Ranger Rowan', 'The cryptwalker has arrived. Keep the old dead from reaching Ravenrest.', 3000);
    setToast('Ranger Rowan sent you into the Forgotten Crypt.', 2600);
  }
  saveCheckpoint();
}

// Checkpoints keep durable progress only: the room-entry position, vitality,
// backpack, objectives, cleared enemies, dropped loot, and gate placement.
// Living enemies return to their spawns, so a resumed room restarts its fight.
function saveCheckpoint() {
  if (!saveStorage || state.mode !== 'dungeon' || !runInProgress() || !checkpointPosition) return;
  writeCheckpoint(saveStorage, {
    roomId: state.currentRoomId,
    position: checkpointPosition,
    discoveredRooms: [...state.discoveredRooms],
    playerHp: state.playerHp,
    inventory: [...state.inventory],
    equippedSlot: state.equippedSlot,
    seals: { ...state.seals },
    archiveKey: state.archiveKey,
    openedChests: state.chests.filter((chest) => chest.opened).map((chest) => chest.id),
    deadEnemies: enemies.filter((enemy) => enemy.dead && enemy.spawnId).map((enemy) => enemy.spawnId),
    loot: lootDrops.filter((drop) => !drop.collected).map(({ itemId, position }) => ({ itemId, x: position.x, z: position.z })),
    // An open gate is saved as closed on the side it was opened from, the
    // same placement applyGateOpen gives a gate closed by opening another.
    gates: state.gates.map((gate) => ({
      corridorId: gate.corridorId,
      wallRoomId: gate.open ? gate.fromRoomId : gate.wallRoomId,
      visibleFrames: gate.open
        ? [gate.fromRoomId]
        : gate.roomIds.filter((roomId) => gate.wallFrames.get(roomId)?.[0]?.visible),
    })),
  });
}

function applyCheckpointProgress(checkpoint) {
  state.playerHp = Math.min(state.playerMaxHp, checkpoint.playerHp);
  state.inventory.forEach((_, index) => {
    state.inventory[index] = checkpoint.inventory[index] ?? null;
  });
  state.equippedSlot = checkpoint.equippedSlot;
  player.setWeaponColor(equippedDefinition()?.color ?? null);
  Object.assign(state.seals, checkpoint.seals);
  state.archiveKey = checkpoint.archiveKey;
  const openedChests = new Set(checkpoint.openedChests);
  for (const chest of state.chests) {
    if (openedChests.has(chest.id)) showChestOpened(chest);
  }
  state.openedChests = openedChests.size;
  const deadEnemies = new Set(checkpoint.deadEnemies);
  for (const enemy of enemies) {
    if (!deadEnemies.has(enemy.spawnId)) continue;
    enemy.hp = 0;
    enemy.dead = true;
    enemy.lootDropped = true;
    enemy.root.visible = false;
  }
  for (const drop of checkpoint.loot) createLootVisual(drop.itemId, new THREE.Vector3(drop.x, 0, drop.z));
  for (const saved of checkpoint.gates) {
    const gate = findGate(saved.corridorId);
    if (!gate?.roomIds.includes(saved.wallRoomId)) continue;
    moveGateAssemblyToRoom(gate, saved.wallRoomId);
    for (const roomId of gate.roomIds) setGateWallFrameVisible(gate, roomId, saved.visibleFrames.includes(roomId));
  }
  updateHealthUi();
  updateInventoryUi();
  updateQuestUi();
}

function talkToTownNpc(npc) {
  if (!npc || state.teleporting) return;
  npc.face(player.root.position);
  if (npc.role === 'Hunter') {
    state.teleporting = true;
    showDialogue(npc.name, 'The old bell has started ringing below the hill. Follow my mark into the crypt.', 1500);
    setToast('The hunter opens a trail beneath Ravenrest…', 1500);
    trailTimeout = window.setTimeout(() => {
      trailTimeout = null;
      enterDungeon();
    }, 900);
    return;
  }
  showDialogue(npc.name, npc.role === 'Town guard'
    ? 'The southern road is quiet. Rowan knows the safe path into the crypt.'
    : 'Fresh tools, fresh trouble. Rowan is the one to ask about the dungeon.', 2600);
}

function livingEnemiesInBranch(branch) {
  return enemies.filter((enemy) => !enemy.dead && ROOM_BRANCH[enemy.roomId] === branch);
}

function archiveGuardianCount() {
  return enemies.filter((enemy) => !enemy.dead && isArchiveGuardian(enemy, ROOM_BRANCH)).length;
}

function livingEnemiesInRoom(roomId) {
  return enemies.filter((enemy) => !enemy.dead && enemy.roomId === roomId);
}

function isEnemyAccessible(enemy) {
  return visibleZoneIds.has(enemy.roomId);
}

function isTargetableEnemy(enemy) {
  return enemy && enemy !== player && !enemy.dead && enemy.root.visible && isEnemyAccessible(enemy);
}

function returnCrossingGuardians(gate, roomId) {
  const coordinate = gate.travelsAlongZ ? 'z' : 'x';
  const wall = gate.position[coordinate];
  const center = roomCenter(ZONE_BY_ID.get(roomId))[coordinate];
  const inside = Math.sign(center - wall);
  for (const enemy of livingEnemiesInRoom(roomId)) {
    if ((enemy.root.position[coordinate] - wall) * inside >= ROOM_ENTRY_CLEARANCE) continue;
    enemy.root.position.copy(enemy.spawnPosition);
    enemy.evading = false;
    enemy.awake = false;
    enemy.attackLock = 0;
    enemy.attackCooldown = 1;
    enemy.pendingEnemyAttack = null;
    enemy.play(['idle_combat', 'idle'], { force: true });
  }
}

function updateProgression() {
  const zone = zoneAtPosition(player.root.position);
  state.currentZoneId = zone?.id ?? null;
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
    diagnostics?.onGateTraversal();
    returnCrossingGuardians(traversedGate, transition.roomId);
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
  checkpointPosition = { x: player.root.position.x, z: player.root.position.z };
  saveCheckpoint();
}

function runObjectivesComplete() {
  return evaluateObjectivesComplete({
    seals: state.seals,
    archiveKey: state.archiveKey,
    wardenSpoilsOpened: chestById('warden-spoils')?.opened,
    livingEnemyCount: countLivingEnemies(),
  });
}

function isWalkable(x, z, padding = 0.55) {
  return isWalkablePoint({ x, z, padding, navigation });
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
  const actorRoots = [player.root, ...enemies.filter(isTargetableEnemy).map((enemy) => enemy.root)];
  const hits = raycaster.intersectObjects(actorRoots, true);
  for (const hit of hits) {
    const actor = actorFromObject(hit.object);
    if (actor) return actor;
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
  if (!canPlay() || state.mode !== 'dungeon') return;
  if (target !== player && !isTargetableEnemy(target)) {
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
  if (!targetMarker || !isTargetableEnemy(selectedTarget)) {
    if (targetMarker) targetMarker.visible = false;
    if (selectedTarget && selectedTarget !== player) {
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
  const target = isTargetableEnemy(selectedTarget) ? selectedTarget : null;
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
  const target = isTargetableEnemy(selectedTarget) ? selectedTarget : null;
  for (const slot of abilitySlots) {
    const action = slot.dataset.ability;
    const remaining = state.actionCooldowns[action] ?? 0;
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
  if (!item || !canPlay() || state.mode !== 'dungeon') return;
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
  const zoneId = zoneAtPosition(position)?.id ?? state.currentRoomId;
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
  zoneRenderGroups.get(zoneId).add(root);
  const drop = { itemId, zoneId, root, position: position.clone(), phase: Math.random() * Math.PI * 2, collected: false };
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
    if (drop.collected || !visibleZoneIds.has(drop.zoneId)) continue;
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
  drop.root.removeFromParent();
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
    if (drop.collected || !visibleZoneIds.has(drop.zoneId)) continue;
    drop.phase += delta * 2.2;
    drop.root.position.y = 0.38 + Math.sin(drop.phase) * 0.09;
    drop.root.rotation.y += delta * 0.85;
  }
}

function nearestClosedChest(maxDistance = Infinity) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const chest of state.chests) {
    if (chest.opened || !visibleZoneIds.has(chest.roomId)) continue;
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
    if (gate.open || !gate.roomIds.includes(state.currentRoomId)) continue;
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
  if (!isRunActive() || state.mode !== 'dungeon') return;
  for (const enemy of enemies) {
    if (enemy.dead || !filter(enemy)) continue;
    enemy.hp = 0;
    enemy.dead = true;
    enemy.pendingEnemyAttack = null;
    enemy.root.visible = false;
  }
}

function gateOpenVerdict(gate) {
  const { x, z } = player.root.position;
  return evaluateGateOpen({
    gate,
    currentRoomId: state.currentRoomId,
    livingInRoomCount: livingEnemiesInRoom(state.currentRoomId).length,
    crossing: gateCrossing({ x, z, room: ZONE_BY_ID.get(state.currentRoomId), gates: state.gates }),
    seals: state.seals,
    archiveKey: state.archiveKey,
  });
}

function openGate(gate) {
  if (!canPlay() || state.mode !== 'dungeon') return;
  const verdict = gateOpenVerdict(gate);
  if (!verdict.ok) {
    if (verdict.message) setToast(verdict.message, 1800);
    return;
  }
  for (const { gate: otherGate, fromRoomId, toRoomId } of applyGateOpen(state.gates, gate, state.currentRoomId)) {
    moveGateAssemblyToRoom(otherGate, fromRoomId);
    setGateWallFrameVisible(otherGate, fromRoomId, true);
    setGateWallFrameVisible(otherGate, toRoomId, false);
    otherGate.root.visible = true;
  }
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
  return evaluateChestBlock({ chest, enemies, roomBranch: ROOM_BRANCH });
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
    when: () => !hasBranchSeals(state.seals),
    title: 'Claim the twin branch seals',
    detail: () => {
      const west = state.seals.west ? 'seal claimed' : `${livingEnemiesInBranch('west').length} guardians`;
      const east = state.seals.east ? 'seal claimed' : `${livingEnemiesInBranch('east').length} guardians`;
      return `West: ${west}. East: ${east}. Each reliquary opens when its branch is clear.`;
    },
  },
  {
    when: () => !state.archiveKey && archiveGuardianCount() > 0,
    title: 'Cross the Silent Archive',
    detail: () => `${archiveGuardianCount()} northern guardians stand between you and the Archive key.`,
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

// The prompt and E key use the same interaction priority.
function interactionCandidate() {
  const loot = nearestLootDrop(INTERACT_RADII.loot);
  if (loot && state.inventory.includes(null)) return { kind: 'loot', item: loot };
  const chest = nearestClosedChest(INTERACT_RADII.chest);
  if (chest && (!loot || !chestBlockReason(chest))) return { kind: 'chest', item: chest };
  const gate = nearestClosedGate(INTERACT_RADII.gate);
  if (gate && (!loot || gateOpenVerdict(gate).ok)) return { kind: 'gate', item: gate };
  return loot ? { kind: 'loot', item: loot } : null;
}

function updateInteractionUi() {
  if (!isRunActive()) {
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
    if (state.inventory.includes(null)) {
      interaction.innerHTML = `Press <kbd>E</kbd> to collect ${ITEM_DEFS[candidate.item.itemId].name.toLowerCase()}`;
    } else {
      interaction.textContent = 'Backpack full';
    }
  } else if (candidate.kind === 'chest') {
    interaction.innerHTML = `Press <kbd>E</kbd> to open ${candidate.item.name.toLowerCase()}`;
  } else {
    const verdict = gateOpenVerdict(candidate.item);
    if (!verdict.ok) {
      interaction.classList.toggle('is-hidden', !verdict.message);
      interaction.textContent = verdict.message;
      return;
    }
    const destinationId = candidate.item.roomIds.find((id) => id !== state.currentRoomId);
    const destination = ZONE_BY_ID.get(destinationId);
    interaction.innerHTML = `Press <kbd>E</kbd> to open the way to ${(destination?.label ?? 'the next chamber').toLowerCase()}`;
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
  diagnostics?.publish();
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

function spawnTelegraph({ position, radius, duration, color, enemy, attack, onResolve }) {
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
  telegraphs.push({ disc, material, life: duration, duration, enemy, attack, onResolve });
}

function updateTelegraphs(delta) {
  for (let index = telegraphs.length - 1; index >= 0; index -= 1) {
    const telegraph = telegraphs[index];
    const canceled = telegraph.enemy.dead || telegraph.enemy.frozenTimer > 0
      || !isEnemyAccessible(telegraph.enemy)
      || telegraph.enemy.pendingEnemyAttack !== telegraph.attack;
    telegraph.life -= delta;
    if (canceled || telegraph.life <= 0) {
      disposeVisual(telegraph.disc);
      telegraphs.splice(index, 1);
      if (!canceled) telegraph.onResolve();
      if (!isRunActive()) return;
      continue;
    }
    telegraph.attack.castRemaining = telegraph.life;
    const progress = 1 - Math.max(0, telegraph.life / telegraph.duration);
    const pulse = 0.92 + Math.sin(progress * Math.PI * 8) * 0.035;
    telegraph.disc.scale.setScalar(pulse);
    telegraph.material.opacity = 0.13 + progress * 0.32;
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
  if (!isTargetableEnemy(target)) return;

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
  if (!canPlay() || state.mode !== 'dungeon') return;
  const actionDef = ACTIONS[action];
  if (!actionDef) return;
  const selfAction = action === 'heal' || action === 'buff';
  if (!selfAction && !isTargetableEnemy(target)) {
    if (target && target !== player) clearSelectedTarget({ silent: true });
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
  if (runtime.spell) spawnSpellCharge(action);
  state.actionCooldowns[action] = actionCooldownFor(action);
  state.started = true;
}

function attemptAttack() {
  if (!canPlay() || state.mode !== 'dungeon') return;
  const target = isTargetableEnemy(selectedTarget) ? selectedTarget : null;
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
  if (diagnostics?.autoWalk(delta)) return;
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
  diagnostics?.sampleMovement();
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
    enemy,
    attack,
    onResolve: () => {
      enemy.pendingEnemyAttack = null;
      if (player.root.position.distanceTo(position) <= radius) damagePlayer(damage, enemy.name);
      else spawnCombatText(player.root.position, 'DODGED', '#a9d8ef', player.height + 0.2);
      if (!isRunActive()) return;
      spawnBurst(position, soulCollapse ? 0xb978da : wardenSlam ? 0xe06252 : 0xb07bd3, soulCollapse ? 22 : wardenSlam ? 28 : 16);
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
  showChestOpened(chest);
  applyChestRewards(state, chest, Object.keys(state.actionCooldowns));
  if (chest.kind === 'seal') {
    spawnCombatText(chest.position, `${chest.branch.toUpperCase()} SEAL`, '#f2cf7c', 1.8);
    setToast(`The ${chest.branch}ern branch seal is yours.`, 2400);
  } else if (chest.kind === 'archive') {
    spawnCombatText(chest.position, 'ARCHIVE KEY', '#c9b2f0', 1.8);
    setToast('The Archive key hums toward the Warden\'s Keep.', 2400);
  } else if (chest.kind === 'final') {
    spawnCombatText(chest.position, 'WARDEN’S SPOILS', '#f2cf7c', 1.8);
    setToast('The Warden’s spoils are yours. Return to the entrance.', 2400);
  } else {
    spawnCombatText(chest.position, 'RENEWED', '#9fe1bb', 1.8);
    setToast(`${chest.name} restores vitality and hastens your abilities.`);
  }
  updateHealthUi();
  updateProgression();
  updateQuestUi();
  saveCheckpoint();
}

function showChestOpened(chest) {
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
}

function interact() {
  if (!canPlay()) return;
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
  // Victory ends the delve; defeat keeps the last checkpoint and retries it
  // with full vitality so a low-health save cannot trap the player.
  const checkpoint = readCheckpoint(saveStorage, WORLD_DATA);
  if (success) clearCheckpoint(saveStorage);
  else if (checkpoint) writeCheckpoint(saveStorage, { ...checkpoint, playerHp: state.playerMaxHp });
  clearInputState();
  controls.enabled = false;
  state.playerBuffTimer = 0;
  player.pendingAction = null;
  player.attackTarget = null;
  player.attackTimer = 0;
  for (const enemy of enemies) {
    enemy.pendingEnemyAttack = null;
    enemy.nameplate?.element.classList.add('is-hidden');
  }
  for (const projectile of spellProjectiles.splice(0)) disposeVisual(projectile.root);
  for (const visual of spellVisuals.splice(0)) disposeVisual(visual.root);
  for (const telegraph of telegraphs.splice(0)) disposeVisual(telegraph.disc);
  clearWardVisual();
  for (const effect of effects.splice(0)) {
    effect.mesh.visible = false;
    burstMeshPool.release(effect.mesh);
  }
  for (const text of combatTexts.splice(0)) text.element.remove();
  if (success) {
    endEyebrow.textContent = 'CRYPT CLEARED';
    endTitle.textContent = 'The path is clear.';
    endCopy.textContent = 'You cleared every chamber in the expanded crypt.';
    restartButton.textContent = 'Run it again';
  } else {
    endEyebrow.textContent = 'THE CRYPT WINS';
    endTitle.textContent = 'The lanterns go dark.';
    endCopy.textContent = checkpoint
      ? 'Retry from the last chamber you entered with full vitality, or start a new delve.'
      : 'Try again and keep the dead at sword’s reach.';
    restartButton.textContent = checkpoint ? 'Retry from checkpoint' : 'Try again';
  }
  endNewGameButton.classList.toggle('is-hidden', success || !checkpoint);
  endScreen.classList.remove('is-hidden');
  targetCard.classList.add('is-hidden');
  interaction.classList.add('is-hidden');
  clearSelectedTarget({ silent: true });
  updateHealthUi();
  updateQuestUi();
  restartButton.focus({ preventScroll: true });
  diagnostics?.publish(true);
}

function resetRun() {
  window.location.reload();
}

function startNewGame() {
  clearCheckpoint(saveStorage);
  // Stop the pagehide save from writing this run back during the reload.
  saveStorage = null;
  window.location.reload();
}

function setPaused(paused) {
  if (paused === state.paused || !runInProgress()) return;
  state.paused = paused;
  clearInputState();
  controls.enabled = !paused && !renderingPaused;
  pauseScreen.classList.toggle('is-hidden', !paused);
  if (paused) {
    resumeButton.focus({ preventScroll: true });
    return;
  }
  clock.getDelta();
  // Drop focus from the pause controls so Space attacks instead of re-pausing.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (state.teleporting && trailTimeout === null && !renderingPaused) enterDungeon();
}

function applyMuted(muted) {
  setMuted(muted);
  soundButton.textContent = muted ? 'Sound off' : 'Sound on';
}

function toggleMuted() {
  applyMuted(!isMuted());
  try {
    browserStorage()?.setItem(MUTED_KEY, isMuted() ? '1' : '0');
  } catch {
    // The preference lasts for this page when storage is unavailable.
  }
  setToast(isMuted() ? 'Sound muted.' : 'Sound on.', 1100);
}

async function loadAssets() {
  const entries = Object.entries(ASSETS);
  let loadedCount = 0;
  setLoading(0.08, 'Calling the cryptwalker');
  await Promise.all(entries.map(async ([key, url]) => {
    assets.set(key, await loader.loadAsync(url));
    loadedCount += 1;
    setLoading(0.08 + (loadedCount / entries.length) * 0.82, `Raising the crypt (${loadedCount}/${entries.length})`);
  }));
  setLoading(0.96, 'Lighting the last room');
}

function onKeyDown(event) {
  const pressed = event.key.toLowerCase();
  if (state.loaded && !event.repeat && (pressed === 'p' || (pressed === 'escape' && state.paused))) {
    setPaused(!state.paused);
    event.preventDefault();
    return;
  }
  if (state.loaded && !event.repeat && pressed === 'm') {
    toggleMuted();
    return;
  }
  if (!canPlay()) return;
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.code === 'Space' && target.closest('button, a[href], [role="button"]')) return;
  }
  initAudio();
  const action = ACTION_BY_KEY.get(event.code);
  if (action && state.mode === 'dungeon') {
    if (!event.repeat) useAction(action);
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
  if (state.mode !== 'dungeon') return;
  if (key === 'escape' && !event.repeat) clearSelectedTarget();
  if (event.code === 'Space') {
    if (!event.repeat) attemptAttack();
    event.preventDefault();
  }
}

function onKeyUp(event) {
  keys.delete(event.key.toLowerCase());
}

function clearInputState() {
  keys.clear();
  pointerPress = null;
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
  if (renderingPaused) return;
  updateAdaptiveQuality(frameDelta);
  const delta = Math.min(frameDelta, 0.05);
  if (isRunActive()) {
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
        if (!isRunActive()) break;
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
      if (isRunActive()) {
        updateEffects(delta);
        updateSpellProjectiles(delta);
        updateSpellVisuals(delta);
        updateWardVisual(delta);
        updateLootDrops(delta);
        updateTelegraphs(delta);
        if (isRunActive()) updateCombatTexts(delta);
      }
    } else {
      updateTownActors(delta);
    }
  }
  if (isRunActive()) {
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
  renderer?.setSize(window.innerWidth, window.innerHeight);
  renderer?.setPixelRatio(rendererPixelRatio());
});
window.addEventListener('keydown', onKeyDown, { passive: false });
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', clearInputState);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  clearInputState();
  saveCheckpoint();
});
window.addEventListener('pagehide', saveCheckpoint);
canvas.addEventListener('pointerdown', (event) => {
  if (!canPlay() || event.button !== 0) return;
  initAudio();
  if (state.mode !== 'dungeon' || pointerPress) return;
  pointerPress = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
});
canvas.addEventListener('pointerup', (event) => {
  if (pointerPress?.id !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - pointerPress.x, event.clientY - pointerPress.y);
  const duration = performance.now() - pointerPress.time;
  pointerPress = null;
  if (event.button === 0 && distance < 8 && duration < 500) {
    const target = pickActor(event.clientX, event.clientY);
    if (target) selectTarget(target);
    else clearSelectedTarget();
  }
});
function cancelPointerPress(event) {
  const press = pointerPress;
  if (press?.id !== event.pointerId) return;
  // OrbitControls releases capture in its pointerup handler.
  if (event.type === 'lostpointercapture') {
    queueMicrotask(() => { if (pointerPress === press) pointerPress = null; });
  } else pointerPress = null;
}
canvas.addEventListener('pointercancel', cancelPointerPress);
canvas.addEventListener('lostpointercapture', cancelPointerPress);
abilitySlots.forEach((button) => {
  button.addEventListener('click', () => useAction(button.dataset.ability));
});
backpackSlots.forEach((button) => {
  button.addEventListener('click', () => useInventorySlot(Number(button.dataset.inventorySlot)));
});
restartButton.addEventListener('click', resetRun);
endNewGameButton.addEventListener('click', startNewGame);
pauseNewGameButton.addEventListener('click', startNewGame);
pauseButton.addEventListener('click', () => setPaused(!state.paused));
resumeButton.addEventListener('click', () => setPaused(false));
soundButton.addEventListener('click', toggleMuted);
try {
  applyMuted(browserStorage()?.getItem(MUTED_KEY) === '1');
} catch {
  applyMuted(false);
}

async function start() {
  try {
    initializeRenderer();
  } catch (error) {
    console.error(error);
    loadingLabel.textContent = 'WebGL 2 could not start. Check your browser’s graphics settings and reload.';
    loadingFill.style.background = '#b5656b';
    return;
  }
  canvas.addEventListener('webglcontextlost', pauseRendering);
  canvas.addEventListener('webglcontextrestored', resumeRendering);
  try {
    animate();
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
    const checkpoint = readCheckpoint(saveStorage, WORLD_DATA);
    if (checkpoint) enterDungeon(checkpoint);
    else setToast('Find Ranger Rowan by the archery yard.');
    window.__gameReady = true;
    diagnostics?.publish(true);
  } catch (error) {
    console.error(error);
    loadingLabel.textContent = 'The asset bundle could not be opened. Check the browser console.';
    loadingFill.style.background = '#b5656b';
  }
}

// Installed before start() so load-time errors reach the published snapshot.
const diagnostics = E2E_ENABLED ? installDiagnostics({
  app,
  state,
  camera,
  townNpcs,
  zoneRenderGroups,
  enemies,
  lootDrops,
  objective,
  objectiveDetail,
  get player() {
    return player;
  },
  get renderingPaused() {
    return renderingPaused;
  },
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
}) : null;

start();
