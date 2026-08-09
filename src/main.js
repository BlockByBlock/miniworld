import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import './style.css';

const $ = (selector) => document.querySelector(selector);

const canvas = $('#scene');
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
const actionMenu = $('#action-menu');
const actionMenuTitle = $('#action-menu-title');
const actionBubbles = [...actionMenu.querySelectorAll('[data-action]')];
const abilitySlots = [...document.querySelectorAll('[data-ability]')];
const minimap = $('#minimap');
const minimapContext = minimap.getContext('2d');
const areaName = $('#area-name');
const backpackSlots = [...document.querySelectorAll('[data-inventory-slot]')];
const equippedItem = $('#equipped-item');

const ACTIONS = {
  sword: { cooldown: 0.7, range: 3.45 },
  fire: { cooldown: 3.8, range: 8.5 },
  freeze: { cooldown: 7.5, range: 8.5 },
  heal: { cooldown: 14, range: 0 },
  buff: { cooldown: 18, range: 0 },
};

const ITEM_DEFS = {
  healingDraft: {
    name: 'Gravebloom Draft',
    kind: 'consumable',
    rarity: 'common',
    glyph: '✚',
    color: '#91cfa7',
    description: 'Restore 30 vitality.',
  },
  ossuaryEdge: {
    name: 'Ossuary Edge',
    kind: 'equipment',
    rarity: 'uncommon',
    glyph: '⚔',
    color: '#8fc8bd',
    description: 'Sword damage +20%.',
    damage: { sword: 1.2 },
  },
  emberCharm: {
    name: 'Ember Charm',
    kind: 'equipment',
    rarity: 'rare',
    glyph: '✹',
    color: '#d68b65',
    description: 'Fire damage +25%.',
    damage: { fire: 1.25 },
  },
  frostRune: {
    name: 'Rimebound Rune',
    kind: 'equipment',
    rarity: 'rare',
    glyph: '❄',
    color: '#87c8e8',
    description: 'Freeze cooldown -25%.',
    cooldown: { freeze: 0.75 },
  },
  wardenRelic: {
    name: 'Warden Relic',
    kind: 'equipment',
    rarity: 'epic',
    glyph: '◆',
    color: '#c49ae6',
    description: 'All damage +12%.',
    damage: { sword: 1.12, fire: 1.12, freeze: 1.12 },
  },
};

const ENEMY_PROFILES = {
  guard: { kind: 'melee', damage: 2, desiredRange: 1.72, attackRange: 2.25, attackCooldown: 1.9, windup: 0.32, leash: 9 },
  rusher: { kind: 'melee', damage: 3, desiredRange: 1.6, attackRange: 2.2, attackCooldown: 1.65, windup: 0.24, chaseMult: 1.55, leash: 10 },
  pulser: { kind: 'pulse', damage: 5, desiredRange: 5.4, attackRange: 7.2, attackCooldown: 3.6, windup: 0.9, radius: 1.8, leash: 8 },
  support: { kind: 'support', damage: 3, desiredRange: 5.8, attackRange: 7.5, attackCooldown: 4.2, windup: 0.95, radius: 1.35, heal: 10, leash: 8 },
  warden: { kind: 'warden', damage: 5, desiredRange: 1.9, attackRange: 2.5, attackCooldown: 2.15, windup: 0.38, leash: 11, slamCooldown: 6.4 },
};

const ROOM_BRANCH = {
  westGate: 'west',
  westBurial: 'west',
  westOssuary: 'west',
  eastGate: 'east',
  eastFlooded: 'east',
  eastReliquary: 'east',
  northHall: 'north',
  northLibrary: 'north',
  wardenKeep: 'north',
};

const ASSETS = {
  knight: '/assets/models/chars/players/knight.glb',
  sword: '/assets/models/weapons/sword_1handed.glb',
  skeletonWarrior: '/assets/models/chars/enemies/skeleton_warrior.glb',
  skeletonGolem: '/assets/models/chars/enemies/skeleton_golem.glb',
  floorTile: '/assets/models/dungeon/floor_tile_small.glb',
  torch: '/assets/models/dungeon/torch_lit.glb',
  chest: '/assets/models/dungeon/chest.glb',
  chestGold: '/assets/models/dungeon/chest_gold.glb',
  column: '/assets/models/dungeon/column.glb',
  crypt: '/assets/models/dungeon/crypt.glb',
};

const WORLD = {
  minX: -59,
  maxX: 59,
  minZ: -51,
  maxZ: 37,
};

const MAP = {
  rooms: [
    {
      id: 'entrance',
      label: 'Entrance Vault',
      minX: -10,
      maxX: 10,
      minZ: 20,
      maxZ: 34,
      openings: { north: [[-4, 4]] },
    },
    {
      id: 'hub',
      label: 'The Bell Hub',
      minX: -14,
      maxX: 14,
      minZ: 2,
      maxZ: 18,
      openings: {
        south: [[-4, 4]],
        west: [[4, 12]],
        east: [[4, 12]],
        north: [[-4, 4]],
      },
    },
    {
      id: 'westGate',
      label: 'Burial Hall',
      minX: -34,
      maxX: -18,
      minZ: 2,
      maxZ: 16,
      openings: { east: [[4, 12]], west: [[4, 12]] },
    },
    {
      id: 'westBurial',
      label: 'Ashen Gallery',
      minX: -56,
      maxX: -38,
      minZ: 2,
      maxZ: 16,
      openings: { east: [[4, 12]], north: [[-50, -44]] },
    },
    {
      id: 'westOssuary',
      label: 'The Ossuary',
      minX: -56,
      maxX: -38,
      minZ: -16,
      maxZ: 0,
      openings: { south: [[-50, -44]] },
    },
    {
      id: 'eastGate',
      label: 'Flooded Hall',
      minX: 18,
      maxX: 34,
      minZ: 2,
      maxZ: 16,
      openings: { west: [[4, 12]], east: [[4, 12]] },
    },
    {
      id: 'eastFlooded',
      label: 'Drowned Gallery',
      minX: 38,
      maxX: 56,
      minZ: 2,
      maxZ: 16,
      openings: { west: [[4, 12]], north: [[44, 50]] },
    },
    {
      id: 'eastReliquary',
      label: 'The Reliquary',
      minX: 38,
      maxX: 56,
      minZ: -16,
      maxZ: 0,
      openings: { south: [[44, 50]] },
    },
    {
      id: 'northHall',
      label: 'Catacomb Crossing',
      minX: -12,
      maxX: 12,
      minZ: -16,
      maxZ: -4,
      openings: { south: [[-4, 4]], north: [[-4, 4]] },
    },
    {
      id: 'northLibrary',
      label: 'The Silent Archive',
      minX: -12,
      maxX: 12,
      minZ: -32,
      maxZ: -18,
      openings: { south: [[-4, 4]], north: [[-4, 4]] },
    },
    {
      id: 'wardenKeep',
      label: 'Warden\'s Keep',
      minX: -16,
      maxX: 16,
      minZ: -50,
      maxZ: -34,
      openings: { south: [[-4, 4]] },
    },
  ],
  corridors: [
    { id: 'entry-corridor', minX: -4, maxX: 4, minZ: 18, maxZ: 22 },
    { id: 'west-corridor', minX: -18, maxX: -14, minZ: 4, maxZ: 12 },
    { id: 'west-deep-corridor', minX: -38, maxX: -34, minZ: 4, maxZ: 12 },
    { id: 'west-drop', minX: -50, maxX: -44, minZ: -2, maxZ: 4 },
    { id: 'east-corridor', minX: 14, maxX: 18, minZ: 4, maxZ: 12 },
    { id: 'east-deep-corridor', minX: 34, maxX: 38, minZ: 4, maxZ: 12 },
    { id: 'east-drop', minX: 44, maxX: 50, minZ: -2, maxZ: 4 },
    { id: 'north-corridor', minX: -4, maxX: 4, minZ: -4, maxZ: 2 },
    { id: 'archive-corridor', minX: -4, maxX: 4, minZ: -18, maxZ: -14 },
    { id: 'warden-corridor', minX: -4, maxX: 4, minZ: -34, maxZ: -30 },
  ],
};
MAP.zones = [...MAP.rooms, ...MAP.corridors];
const corridorZones = new Set(MAP.corridors);

const state = {
  loaded: false,
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
  exitPosition: new THREE.Vector3(0, 32.4, 0),
  toastTimer: 0,
  toastText: '',
  elapsed: 0,
};

const keys = new Set();
const assets = new Map();
const enemies = [];
const staticColliders = [];
const effects = [];
const telegraphs = [];
const combatTexts = [];
const lootDrops = [];

const scene = new THREE.Scene();
scene.background = new THREE.Color('#090b14');
scene.fog = new THREE.FogExp2('#090b14', 0.018);

const camera = new THREE.PerspectiveCamera(43, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(10.6, 11.5, 12.2);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

let player;
let toastTimeout;
let pointerPress = null;
let actionTarget = null;
let audioContext = null;
let noiseBuffer = null;

function setLoading(progress, label) {
  loadingFill.style.width = `${Math.round(progress * 100)}%`;
  loadingLabel.textContent = label;
}

function setToast(message, duration = 2200) {
  state.toastText = message;
  state.toastTimer = duration / 1000;
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'), duration);
}

function initAudio() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = new AudioContextClass();
    noiseBuffer = audioContext.createBuffer(1, Math.floor(audioContext.sampleRate * 0.35), audioContext.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  }
  if (audioContext.state === 'suspended') audioContext.resume();
}

function playTone({ frequency = 220, endFrequency = frequency, duration = 0.12, gain = 0.035, type = 'sine' } = {}) {
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const volume = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
  volume.gain.setValueAtTime(gain, now);
  volume.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  oscillator.connect(volume).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function playNoise({ duration = 0.08, gain = 0.025, frequency = 900 } = {}) {
  if (!audioContext || audioContext.state !== 'running' || !noiseBuffer) return;
  const now = audioContext.currentTime;
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const volume = audioContext.createGain();
  source.buffer = noiseBuffer;
  filter.type = 'lowpass';
  filter.frequency.value = frequency;
  volume.gain.setValueAtTime(gain, now);
  volume.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(filter).connect(volume).connect(audioContext.destination);
  source.start(now);
  source.stop(now + duration);
}

function playSfx(name) {
  if (!audioContext || audioContext.state !== 'running') return;
  if (name === 'sword') {
    playNoise({ duration: 0.09, gain: 0.035, frequency: 1800 });
    playTone({ frequency: 210, endFrequency: 105, duration: 0.1, gain: 0.018, type: 'triangle' });
  } else if (name === 'fire') {
    playNoise({ duration: 0.2, gain: 0.025, frequency: 1400 });
    playTone({ frequency: 180, endFrequency: 420, duration: 0.18, gain: 0.026, type: 'sawtooth' });
  } else if (name === 'freeze') {
    playTone({ frequency: 740, endFrequency: 290, duration: 0.28, gain: 0.026, type: 'sine' });
    playTone({ frequency: 980, endFrequency: 520, duration: 0.2, gain: 0.014, type: 'triangle' });
  } else if (name === 'hurt') {
    playNoise({ duration: 0.13, gain: 0.045, frequency: 520 });
    playTone({ frequency: 120, endFrequency: 70, duration: 0.16, gain: 0.03, type: 'square' });
  } else if (name === 'pickup') {
    playTone({ frequency: 410, endFrequency: 760, duration: 0.16, gain: 0.026, type: 'sine' });
  } else if (name === 'equip') {
    playTone({ frequency: 270, endFrequency: 430, duration: 0.14, gain: 0.025, type: 'triangle' });
  } else if (name === 'room') {
    playTone({ frequency: 130, endFrequency: 190, duration: 0.3, gain: 0.012, type: 'sine' });
  } else if (name === 'step') {
    playNoise({ duration: 0.045, gain: 0.012, frequency: 260 });
  } else if (name === 'chest') {
    playTone({ frequency: 330, endFrequency: 660, duration: 0.22, gain: 0.027, type: 'triangle' });
  }
}

function addCameraFeedback(shake = 0.08, fovKick = 0.8) {
  state.cameraShake = Math.max(state.cameraShake, shake);
  state.cameraFovKick = Math.max(state.cameraFovKick, fovKick);
}

function setShadows(object, receive = true) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = receive;
  });
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

function fitStaticVisual(visual, { width, depth, height } = {}) {
  visual.updateMatrixWorld(true);
  tempBox.setFromObject(visual);
  tempBox.getSize(tempSize);
  const factors = [];
  if (width && tempSize.x > 0.001) factors.push(width / tempSize.x);
  if (depth && tempSize.z > 0.001) factors.push(depth / tempSize.z);
  if (height && tempSize.y > 0.001) factors.push(height / tempSize.y);
  if (factors.length) {
    visual.scale.multiplyScalar(Math.min(...factors));
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
  setShadows(equipment, false);
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

class Actor {
  constructor({ assetKey, type, position, height, name, maxHp = 1, speed = 0, profileKey = 'guard', roomId = null }) {
    const source = assets.get(assetKey);
    this.name = name;
    this.type = type;
    this.root = new THREE.Group();
    this.root.userData.actor = this;
    this.root.position.copy(position);
    this.spawnPosition = position.clone();
    this.visual = SkeletonUtils.clone(source.scene);
    alignVisualToGround(this.visual, height);
    setShadows(this.visual);
    this.handWeapon = null;
    this.backWeapon = null;
    this.weaponSheathed = false;
    if (type === 'player') {
      this.handWeapon = attachEquipment(this.visual, 'sword', 'handslot.r', { scale: 1.05 });
      this.backWeapon = attachEquipment(this.visual, 'sword', 'chest', {
        scale: 1.05,
        position: [0.06, 0.18, -0.18],
        rotation: [Math.PI / 2, 0, -0.18],
      });
      this.setWeaponSheathed(true);
    }
    this.root.add(this.visual);
    scene.add(this.root);

    this.mixer = new THREE.AnimationMixer(this.visual);
    this.clips = source.animations ?? [];
    this.actions = new Map();
    this.currentAction = null;
    this.currentClipName = '';
    this.attackLock = 0;
    this.attackTimer = 0;
    this.attackPending = false;
    this.attackCooldown = 0;
    this.pendingAction = null;
    this.pendingEnemyAttack = null;
    this.frozenTimer = 0;
    this.specialCooldown = profileKey === 'warden' ? 3.5 : 0;
    this.deathTimer = 0;
    this.height = height;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.speed = speed;
    this.profileKey = profileKey;
    this.roomId = roomId;
    this.dead = false;
    this.awake = type === 'player';
    this.evading = false;
    this.lootDropped = false;
    this.nameplate = type === 'enemy' ? createEnemyNameplate(this) : null;
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

  update(delta) {
    this.mixer.update(delta);
    this.attackCooldown = Math.max(0, this.attackCooldown - delta);
    this.attackLock = Math.max(0, this.attackLock - delta);
    this.frozenTimer = Math.max(0, this.frozenTimer - delta);
    this.specialCooldown = Math.max(0, this.specialCooldown - delta);
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
  colliderWidth = 0,
  colliderDepth = 0,
} = {}) {
  const source = assets.get(assetKey);
  const root = new THREE.Group();
  const visual = source.scene.clone(true);
  fitStaticVisual(visual, { width, depth, height });
  setShadows(visual);
  root.add(visual);
  root.position.set(x, y, z);
  root.rotation.y = rotationY;
  scene.add(root);
  if (colliderWidth > 0 && colliderDepth > 0) {
    const quarterTurn = Math.abs(Math.sin(rotationY)) > 0.5;
    staticColliders.push({
      root,
      minX: x - (quarterTurn ? colliderDepth : colliderWidth) / 2,
      maxX: x + (quarterTurn ? colliderDepth : colliderWidth) / 2,
      minZ: z - (quarterTurn ? colliderWidth : colliderDepth) / 2,
      maxZ: z + (quarterTurn ? colliderWidth : colliderDepth) / 2,
    });
  }
  return root;
}

function addBox({ x, y, z, width, height, depth, material, castShadow = false }) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function addPointLight(x, z, color = 0xffbd74, intensity = 2.4, castShadow = true) {
  const light = new THREE.PointLight(color, intensity, 7, 2);
  light.position.set(x, 2.2, z);
  light.castShadow = castShadow;
  if (castShadow) light.shadow.mapSize.set(512, 512);
  scene.add(light);
}

function buildLighting() {
  scene.add(new THREE.HemisphereLight(0x8886b3, 0x17131b, 1.7));
  const moon = new THREE.DirectionalLight(0xc8c9ff, 2.1);
  moon.position.set(-5, 12, 7);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.left = -34;
  moon.shadow.camera.right = 34;
  moon.shadow.camera.top = 28;
  moon.shadow.camera.bottom = -32;
  scene.add(moon);
  addPointLight(-6.1, 4.25);
  addPointLight(6.1, 4.25, 0xffa767, 2.6);
  addPointLight(0, -4.75, 0x8e9aff, 2.2);
}

function addWallSpan({ fixed, start, end, openings = [], horizontal, material }) {
  const clippedOpenings = openings
    .map(([openStart, openEnd]) => [Math.max(start, openStart), Math.min(end, openEnd)])
    .filter(([openStart, openEnd]) => openEnd - openStart > 0.1)
    .sort((first, second) => first[0] - second[0]);
  let cursor = start;
  for (const [openStart, openEnd] of clippedOpenings) {
    if (openStart - cursor > 0.45) {
      const length = openStart - cursor;
      addBox({
        x: horizontal ? (cursor + openStart) / 2 : fixed,
        y: 1.35,
        z: horizontal ? fixed : (cursor + openStart) / 2,
        width: horizontal ? length : 0.5,
        height: 2.7,
        depth: horizontal ? 0.5 : length,
        material,
      });
    }
    cursor = Math.max(cursor, openEnd);
  }
  if (end - cursor > 0.45) {
    const length = end - cursor;
    addBox({
      x: horizontal ? (cursor + end) / 2 : fixed,
      y: 1.35,
      z: horizontal ? fixed : (cursor + end) / 2,
      width: horizontal ? length : 0.5,
      height: 2.7,
      depth: horizontal ? 0.5 : length,
      material,
    });
  }
}

function buildRoomWalls(room, wallMaterial) {
  const openings = room.openings ?? {};
  addWallSpan({
    fixed: room.minZ,
    start: room.minX,
    end: room.maxX,
    openings: openings.north,
    horizontal: true,
    material: wallMaterial,
  });
  addWallSpan({
    fixed: room.maxZ,
    start: room.minX,
    end: room.maxX,
    openings: openings.south,
    horizontal: true,
    material: wallMaterial,
  });
  addWallSpan({
    fixed: room.minX,
    start: room.minZ,
    end: room.maxZ,
    openings: openings.west,
    horizontal: false,
    material: wallMaterial,
  });
  addWallSpan({
    fixed: room.maxX,
    start: room.minZ,
    end: room.maxZ,
    openings: openings.east,
    horizontal: false,
    material: wallMaterial,
  });
}

function tileZone(zone) {
  for (let x = zone.minX + 1; x < zone.maxX; x += 2) {
    for (let z = zone.minZ + 1; z < zone.maxZ; z += 2) {
      createStatic('floorTile', { x, z, width: 1.92, depth: 1.92 });
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
  addPointLight(center.x, center.z, color, intensity, false);
}

function decorateRoom(room) {
  if (room.id === 'entrance') {
    addColumn(-7.5, 23);
    addColumn(7.5, 23);
    addColumn(-7.5, 31);
    addColumn(7.5, 31);
    addWallTorch(room, 'west', 27);
    addWallTorch(room, 'east', 27);
    addRoomLight(room, 0xffbd74, 1.5);
  } else if (room.id === 'hub') {
    for (const [x, z] of [[-10, 5], [10, 5], [-10, 15], [10, 15]]) addColumn(x, z, 3);
    addTomb(0, 10, 0, 1.15);
    addWallTorch(room, 'north', -9);
    addWallTorch(room, 'north', 9);
    addWallTorch(room, 'south', -9);
    addWallTorch(room, 'south', 9);
    addRoomLight(room, 0xffa767, 1.75);
  } else if (room.id === 'westGate') {
    for (const x of [-30, -26, -22]) {
      addTomb(x, 4.4, Math.PI / 2, 0.82);
      addTomb(x, 13.6, Math.PI / 2, 0.82);
    }
    addWallTorch(room, 'north', -26);
    addWallTorch(room, 'south', -26);
    addRoomLight(room, 0xd78b64);
  } else if (room.id === 'westBurial') {
    for (const [x, z, rotation] of [[-53, 6, 0], [-47, 6, 0], [-41, 6, 0], [-53, 13, Math.PI], [-41, 13, Math.PI]]) {
      addTomb(x, z, rotation, 0.9);
    }
    addWallTorch(room, 'south', -53);
    addWallTorch(room, 'south', -41);
    addRoomLight(room, 0xc7765c);
  } else if (room.id === 'westOssuary') {
    for (const [x, z] of [[-53, -13], [-41, -13], [-53, -4], [-41, -4]]) addColumn(x, z, 2.45);
    addTomb(-47, -7, Math.PI / 2, 1.2);
    addWallTorch(room, 'north', -53);
    addWallTorch(room, 'north', -41);
    addRoomLight(room, 0xb08bff, 1.55);
  } else if (room.id === 'eastGate') {
    for (const [x, z] of [[22, 5], [30, 5], [22, 13], [30, 13]]) addColumn(x, z, 2.3);
    const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x244e61, roughness: 0.42, metalness: 0.14 });
    addBox({ x: 26, y: 0.03, z: 5, width: 4.5, height: 0.08, depth: 2.2, material: waterMaterial });
    addBox({ x: 26, y: 0.03, z: 13, width: 4.5, height: 0.08, depth: 2.2, material: waterMaterial });
    addWallTorch(room, 'north', 20.5);
    addWallTorch(room, 'south', 31.5);
    addRoomLight(room, 0x65b6d1, 1.5);
  } else if (room.id === 'eastFlooded') {
    for (const [x, z, rotation] of [[41, 5, 0], [47, 5, 0], [53, 5, 0], [41, 13, Math.PI], [53, 13, Math.PI]]) {
      addTomb(x, z, rotation, 0.9);
    }
    addWallTorch(room, 'south', 41);
    addWallTorch(room, 'south', 53);
    addRoomLight(room, 0x65b6d1, 1.45);
  } else if (room.id === 'eastReliquary') {
    for (const [x, z] of [[41, -13], [53, -13], [41, -4], [53, -4]]) addColumn(x, z, 3.1);
    addTomb(43, -8, 0, 0.9);
    addTomb(51, -8, Math.PI, 0.9);
    addWallTorch(room, 'north', 41);
    addWallTorch(room, 'north', 53);
    addRoomLight(room, 0xe0b75f, 1.65);
  } else if (room.id === 'northHall') {
    for (const [x, z] of [[-9, -7], [9, -7], [-9, -13], [9, -13]]) addColumn(x, z, 2.8);
    addWallTorch(room, 'west', -10);
    addWallTorch(room, 'east', -10);
    addRoomLight(room, 0x8e9aff, 1.4);
  } else if (room.id === 'northLibrary') {
    for (const z of [-21, -25, -29]) {
      addTomb(-8.5, z, Math.PI / 2, 0.82);
      addTomb(8.5, z, Math.PI / 2, 0.82);
    }
    addWallTorch(room, 'west', -21);
    addWallTorch(room, 'east', -29);
    addRoomLight(room, 0xa183cf, 1.45);
  } else if (room.id === 'wardenKeep') {
    for (const [x, z, rotation] of [[-12, -38, 0], [12, -38, 0], [-12, -46, Math.PI], [12, -46, Math.PI]]) {
      addTomb(x, z, rotation, 1.05);
    }
    for (const [x, z] of [[-7, -37], [7, -37], [-7, -47], [7, -47]]) addColumn(x, z, 3.2);
    addWallTorch(room, 'north', -12);
    addWallTorch(room, 'north', 12);
    addRoomLight(room, 0xb08bff, 1.8);
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
  underfloor.receiveShadow = true;
  scene.add(underfloor);

  const grid = new THREE.GridHelper(120, 60, 0x525168, 0x292a3a);
  grid.position.y = 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.11;
  scene.add(grid);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x171928,
    roughness: 0.96,
    metalness: 0.02,
  });
  for (const room of MAP.rooms) tileZone(room);
  const corridorMaterial = new THREE.MeshStandardMaterial({
    color: 0x34374a,
    roughness: 0.9,
    metalness: 0.03,
  });
  for (const corridor of MAP.corridors) {
    addBox({
      x: (corridor.minX + corridor.maxX) / 2,
      y: -0.055,
      z: (corridor.minZ + corridor.maxZ) / 2,
      width: corridor.maxX - corridor.minX + 0.4,
      height: 0.1,
      depth: corridor.maxZ - corridor.minZ + 0.4,
      material: corridorMaterial,
    });
    tileZone(corridor);
  }
  MAP.rooms.forEach((room) => {
    buildRoomWalls(room, wallMaterial);
    decorateRoom(room);
  });
}

function spawnActor({ assetKey, type, name, x, z, height, maxHp, speed, profileKey, roomId }) {
  return new Actor({
    assetKey,
    type,
    name,
    position: new THREE.Vector3(x, 0, z),
    height,
    maxHp,
    speed,
    profileKey,
    roomId,
  });
}

function buildChests() {
  const chestSpawns = [
    { id: 'hub-cache', name: 'Bell Hub cache', x: 0, z: 14.2, roomId: 'hub', kind: 'cache' },
    { id: 'ashen-cache', name: 'Ashen Gallery cache', x: -47, z: 10, roomId: 'westBurial', kind: 'cache' },
    { id: 'west-seal', name: 'Ossuary reliquary', x: -47, z: -13, roomId: 'westOssuary', kind: 'seal', branch: 'west' },
    { id: 'drowned-cache', name: 'Drowned Gallery cache', x: 47, z: 10, roomId: 'eastFlooded', kind: 'cache' },
    { id: 'east-seal', name: 'Reliquary vault', x: 47, z: -12.5, roomId: 'eastReliquary', kind: 'seal', branch: 'east' },
    { id: 'archive-key', name: 'Silent Archive cache', x: 0, z: -27, roomId: 'northLibrary', kind: 'archive' },
    { id: 'warden-spoils', name: "Warden's spoils", x: 0, z: -47.5, roomId: 'wardenKeep', kind: 'final' },
  ];
  state.chests = chestSpawns.map((chest) => ({
    ...chest,
    position: new THREE.Vector3(chest.x, 0, chest.z),
    root: createStatic('chest', {
      x: chest.x,
      z: chest.z,
      width: 1.35,
      height: 1.05,
      colliderWidth: 1.25,
      colliderDepth: 0.9,
    }),
    opened: false,
    rewardRoot: null,
  }));
  state.openedChests = 0;
}

function buildActors() {
  player = spawnActor({ assetKey: 'knight', type: 'player', name: 'Cryptwalker', x: 0, z: 26.8, height: 1.85, maxHp: 100, speed: 4.2 });
  const enemySpawns = [
    ['Boneguard Captain', -31, 9, 'guard', 'westGate'],
    ['Burial Hall Reaver', -27, 7, 'rusher', 'westGate'],
    ['Sepulcher Watch', -23, 10, 'guard', 'westGate'],
    ['Dustbound Ringer', -20, 7, 'pulser', 'westGate'],
    ['Ashen Sentry', -54, 10, 'guard', 'westBurial'],
    ['Cinderblade', -50, 9, 'rusher', 'westBurial'],
    ['Gallery Keeper', -44, 10, 'support', 'westBurial'],
    ['Ember Husk', -40, 9, 'rusher', 'westBurial'],
    ['Ossuary Ringer', -52, -9, 'pulser', 'westOssuary'],
    ['Marrow Guard', -43, -9, 'guard', 'westOssuary'],
    ['Bone Collector', -50, -3, 'support', 'westOssuary'],
    ['Sepulcher Fang', -42, -12, 'rusher', 'westOssuary'],
    ['Flooded Hall Guard', 20, 9, 'guard', 'eastGate'],
    ['Brine Reaver', 24, 8, 'rusher', 'eastGate'],
    ['Sunken Watch', 29, 10, 'guard', 'eastGate'],
    ['Tide Ringer', 32, 7, 'pulser', 'eastGate'],
    ['Drowned Ringer', 40, 10, 'pulser', 'eastFlooded'],
    ['Siltwalker', 44, 9, 'rusher', 'eastFlooded'],
    ['Gallery Acolyte', 50, 10, 'support', 'eastFlooded'],
    ['Brinebound', 54, 9, 'guard', 'eastFlooded'],
    ['Reliquary Acolyte', 40, -9, 'support', 'eastReliquary'],
    ['Gilded Guard', 44, -5, 'guard', 'eastReliquary'],
    ['Vault Reaver', 50, -5, 'rusher', 'eastReliquary'],
    ['Relic Ringer', 54, -10, 'pulser', 'eastReliquary'],
    ['Catacomb Pursuer', -7, -10, 'rusher', 'northHall'],
    ['Crossing Guard', 7, -10, 'guard', 'northHall'],
    ['Grave Bolt Acolyte', -5, -6, 'support', 'northHall'],
    ['Catacomb Ringer', 5, -14, 'pulser', 'northHall'],
    ['Archive Acolyte', -5, -23, 'support', 'northLibrary'],
    ['Silent Reaver', 5, -23, 'rusher', 'northLibrary'],
    ['Index Guard', -4, -28, 'guard', 'northLibrary'],
    ['Dust Scribe', 4, -20, 'pulser', 'northLibrary'],
    ['Warden Vanguard', -5, -41, 'guard', 'wardenKeep'],
    ['Warden Reaver', 5, -41, 'rusher', 'wardenKeep'],
    ['Warden Acolyte', 0, -45, 'support', 'wardenKeep'],
  ];
  for (const [name, x, z, profileKey, roomId] of enemySpawns) {
    const profileStats = profileKey === 'rusher'
      ? { maxHp: 26, speed: 1.18 }
      : profileKey === 'pulser'
        ? { maxHp: 34, speed: 0.9 }
        : profileKey === 'support'
          ? { maxHp: 32, speed: 0.92 }
          : { maxHp: 30, speed: 1.05 };
    enemies.push(spawnActor({
      assetKey: 'skeletonWarrior',
      type: 'enemy',
      name,
      x,
      z,
      height: 1.8,
      profileKey,
      roomId,
      ...profileStats,
    }));
  }
  enemies.push(spawnActor({
    assetKey: 'skeletonGolem',
    type: 'enemy',
    name: 'Crypt Warden',
    x: 0,
    z: -40,
    height: 2.2,
    maxHp: 120,
    speed: 0.72,
    profileKey: 'warden',
    roomId: 'wardenKeep',
  }));
}

function buildWorld() {
  buildLighting();
  buildCrypt();
  buildChests();
  buildActors();
  updateHealthUi();
  updateQuestUi();
}

function nearestLivingEnemy(maxDistance = Infinity) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const enemy of enemies) {
    if (enemy.dead || !isEnemyAccessible(enemy)) continue;
    const distance = player.root.position.distanceTo(enemy.root.position);
    if (distance < nearestDistance) {
      nearest = enemy;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function countLivingEnemies() {
  return enemies.filter((enemy) => !enemy.dead).length;
}

function chestById(id) {
  return state.chests.find((chest) => chest.id === id) ?? null;
}

function roomAtPosition(position) {
  return MAP.rooms.find((room) => (
    position.x >= room.minX
    && position.x <= room.maxX
    && position.z >= room.minZ
    && position.z <= room.maxZ
  )) ?? null;
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
  return true;
}

function updateProgression() {
  const room = roomAtPosition(player.root.position);
  if (room) {
    const enteredNewRoom = room.id !== state.currentRoomId;
    state.currentRoomId = room.id;
    state.discoveredRooms.add(room.id);
    areaName.textContent = room.label;
    if (enteredNewRoom && state.started) {
      playSfx('room');
      addCameraFeedback(0.035, 1.1);
    }
  }
}

function runObjectivesComplete() {
  return Boolean(chestById('warden-spoils')?.opened) && countLivingEnemies() === 0;
}

function isWalkable(x, z, padding = 0.55) {
  const insideMap = MAP.zones.some((zone) => {
    // Corridors overlap the room interiors by the actor clearance so their
    // usable areas meet at each doorway instead of leaving a collision seam.
    const clearance = corridorZones.has(zone) ? -padding : padding;
    return x >= zone.minX + clearance
      && x <= zone.maxX - clearance
      && z >= zone.minZ + clearance
      && z <= zone.maxZ - clearance;
  });
  if (!insideMap) return false;
  return !staticColliders.some((collider) => (
    collider.root.visible
    && x >= collider.minX - padding
    && x <= collider.maxX + padding
    && z >= collider.minZ - padding
    && z <= collider.maxZ + padding
  ));
}

function moveActorWithinMap(actor, offsetX, offsetZ, padding = 0.55) {
  const currentX = actor.root.position.x;
  const currentZ = actor.root.position.z;
  const nextX = THREE.MathUtils.clamp(currentX + offsetX, WORLD.minX + padding, WORLD.maxX - padding);
  const nextZ = THREE.MathUtils.clamp(currentZ + offsetZ, WORLD.minZ + padding, WORLD.maxZ - padding);
  if (isWalkable(nextX, currentZ, padding)) actor.root.position.x = nextX;
  if (isWalkable(actor.root.position.x, nextZ, padding)) actor.root.position.z = nextZ;
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

function closeActionMenu() {
  actionTarget = null;
  actionMenu.classList.add('is-hidden');
}

function updateActionMenuPosition() {
  if (!actionTarget || state.finished || state.failed || actionTarget.dead) {
    if (actionTarget) closeActionMenu();
    return;
  }
  projectedAnchor.copy(actionTarget.root.position);
  projectedAnchor.y += actionTarget.height + 0.35;
  projectedAnchor.project(camera);
  if (projectedAnchor.z < -1 || projectedAnchor.z > 1) {
    closeActionMenu();
    return;
  }
  const menuHalfWidth = actionTarget === player ? 82 : 126;
  const x = THREE.MathUtils.clamp(
    (projectedAnchor.x * 0.5 + 0.5) * window.innerWidth,
    menuHalfWidth,
    window.innerWidth - menuHalfWidth,
  );
  const y = THREE.MathUtils.clamp(
    (-projectedAnchor.y * 0.5 + 0.5) * window.innerHeight,
    82,
    window.innerHeight - 96,
  );
  actionMenu.style.left = `${x}px`;
  actionMenu.style.top = `${y}px`;
}

function openActionMenu(target) {
  if (!state.loaded || state.finished || state.failed || !target || target.dead) return;
  state.started = true;
  actionTarget = target;
  const isSelf = target === player;
  actionMenuTitle.textContent = isSelf ? 'SELF ACTIONS' : `${target.name.toUpperCase()} ACTIONS`;
  actionBubbles.forEach((button) => {
    button.classList.toggle('is-hidden', button.dataset.scope !== (isSelf ? 'self' : 'enemy'));
  });
  actionMenu.classList.remove('is-hidden');
  updateActionMenuPosition();
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
  const selectedEnemy = actionTarget && actionTarget !== player && !actionTarget.dead ? actionTarget : null;
  const target = selectedEnemy ?? nearestLivingEnemy(4.4);
  if (!target) {
    targetCard.classList.add('is-hidden');
    return;
  }
  targetCard.classList.remove('is-hidden');
  targetName.textContent = target.name;
  targetFill.style.width = `${Math.max(0, target.hp / target.maxHp) * 100}%`;
  const statuses = [];
  if (target.frozenTimer > 0) statuses.push(`<span class="status-chip is-frozen">FROZEN ${target.frozenTimer.toFixed(1)}s</span>`);
  if (target.pendingEnemyAttack?.label) statuses.push(`<span class="status-chip is-danger">${target.pendingEnemyAttack.label}</span>`);
  if (target.evading) statuses.push('<span class="status-chip">RESETTING</span>');
  targetStatus.innerHTML = statuses.join('');
}

function updateActionUi() {
  for (const button of actionBubbles) {
    const action = button.dataset.action;
    const remaining = state.actionCooldowns[action] ?? 0;
    const total = actionCooldownFor(action);
    const ratio = total > 0 ? remaining / total : 0;
    let readout = button.querySelector('.action-cooldown');
    if (!readout) {
      readout = document.createElement('span');
      readout.className = 'action-cooldown';
      button.append(readout);
    }
    readout.textContent = remaining > 0 ? remaining.toFixed(1) : '';
    button.disabled = remaining > 0;
    button.style.setProperty('--cooldown-angle', `${ratio * 360}deg`);
  }
  for (const slot of abilitySlots) {
    const remaining = state.actionCooldowns[slot.dataset.ability] ?? 0;
    slot.classList.toggle('is-cooling', remaining > 0);
    slot.querySelector('strong').textContent = remaining > 0 ? `${remaining.toFixed(1)}s` : 'READY';
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
  core.castShadow = true;
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

function lootItemForEnemy(enemy) {
  if (enemy.profileKey === 'warden') return 'wardenRelic';
  if (enemy.profileKey === 'support') return 'emberCharm';
  if (enemy.profileKey === 'pulser') return 'frostRune';
  if (enemy.profileKey === 'guard') return 'ossuaryEdge';
  return 'healingDraft';
}

function spawnLootDrop(enemy) {
  if (enemy.lootDropped) return;
  enemy.lootDropped = true;
  const itemId = lootItemForEnemy(enemy);
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

function chestBlockReason(chest) {
  if (!chest || chest.opened) return '';
  if (chest.kind === 'seal' && livingEnemiesInBranch(chest.branch).length > 0) {
    return `The ${chest.branch}ern seal remains warded by ${livingEnemiesInBranch(chest.branch).length} guardian${livingEnemiesInBranch(chest.branch).length === 1 ? '' : 's'}.`;
  }
  if (chest.kind === 'archive' && livingEnemiesInBranch('north', { includeWarden: false }).length > 0) {
    return 'The Archive cache remains sealed while its acolytes stand.';
  }
  if (chest.kind === 'final' && livingEnemiesInRoom('wardenKeep').length > 0) {
    return 'The Warden\'s reliquary is still bound to the living dead.';
  }
  if (chest.kind === 'cache' && livingEnemiesInRoom(chest.roomId).length > 0) {
    return 'Clear this chamber before opening its cache.';
  }
  return '';
}

function updateQuestUi() {
  const threats = countLivingEnemies();
  threatValue.textContent = `${threats} ${threats === 1 ? 'REMAINS' : 'REMAIN'}`;
  if (state.finished) {
    objective.textContent = 'Delve complete';
    objectiveDetail.textContent = 'The crypt keeps its secrets for another day.';
  } else if (state.failed) {
    objective.textContent = 'The crypt wins';
    objectiveDetail.textContent = 'Take a breath, then try the route again.';
  } else if (!state.started) {
    objective.textContent = 'Enter the crypt';
    objectiveDetail.textContent = 'Clear the western and eastern branches to claim their seals.';
  } else if (!state.seals.west || !state.seals.east) {
    const west = state.seals.west ? 'seal claimed' : `${livingEnemiesInBranch('west').length} guardians`;
    const east = state.seals.east ? 'seal claimed' : `${livingEnemiesInBranch('east').length} guardians`;
    objective.textContent = 'Claim the twin branch seals';
    objectiveDetail.textContent = `West: ${west}. East: ${east}. Each reliquary opens when its branch is clear.`;
  } else if (livingEnemiesInBranch('north', { includeWarden: false }).length > 0) {
    objective.textContent = 'Cross the Silent Archive';
    objectiveDetail.textContent = `${livingEnemiesInBranch('north', { includeWarden: false }).length} northern guardians stand between you and the Archive key.`;
  } else if (!state.archiveKey) {
    objective.textContent = 'Claim the Archive key';
    objectiveDetail.textContent = 'Open the cache in the Silent Archive to continue into the Warden\'s Keep.';
  } else if (livingEnemiesInRoom('wardenKeep').length > 0) {
    objective.textContent = 'Defeat the Crypt Warden';
    objectiveDetail.textContent = 'Dodge its telegraphed slam and break the dead it calls back.';
  } else if (!chestById('warden-spoils')?.opened) {
    objective.textContent = 'Claim the Warden\'s spoils';
    objectiveDetail.textContent = 'The final reliquary is no longer warded.';
  } else {
    objective.textContent = 'Return to the entrance';
    objectiveDetail.textContent = `${state.openedChests} of ${state.chests.length} caches found. Return through the southern entrance.`;
  }
}

function updateInteractionUi() {
  if (!state.loaded || state.finished || state.failed) {
    interaction.classList.add('is-hidden');
    return;
  }
  const nearbyLoot = nearestLootDrop(1.9);
  const nearbyChest = nearestClosedChest(2.1);
  if (nearbyLoot) {
    interaction.classList.remove('is-hidden');
    interaction.innerHTML = `Press <kbd>E</kbd> to collect ${ITEM_DEFS[nearbyLoot.itemId].name.toLowerCase()}`;
  } else if (nearbyChest) {
    interaction.classList.remove('is-hidden');
    interaction.innerHTML = `Press <kbd>E</kbd> to open ${nearbyChest.name.toLowerCase()}`;
  } else {
    interaction.classList.add('is-hidden');
  }
}

function spawnBurst(position, color = 0xf0c071, count = 12) {
  const geometry = new THREE.SphereGeometry(0.055, 6, 6);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true });
  for (let index = 0; index < count; index += 1) {
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.position.copy(position);
    mesh.position.y += 0.55;
    scene.add(mesh);
    const angle = (index / count) * Math.PI * 2;
    effects.push({
      mesh,
      life: 0.65 + Math.random() * 0.25,
      velocity: new THREE.Vector3(Math.cos(angle) * (0.65 + Math.random() * 0.35), 1.2 + Math.random() * 0.7, Math.sin(angle) * (0.65 + Math.random() * 0.35)),
    });
  }
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
    effect.mesh.material.opacity = Math.max(0, effect.life);
    if (effect.life <= 0) {
      scene.remove(effect.mesh);
      effect.mesh.geometry.dispose();
      effect.mesh.material.dispose();
      effects.splice(index, 1);
    }
  }
}

function playerDamage(baseDamage, action) {
  return Math.round(baseDamage * (state.playerBuffTimer > 0 ? 1.4 : 1) * itemDamageMultiplier(action));
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
  if (!target || target.dead) return;

  const distance = player.root.position.distanceTo(target.root.position);
  if (action === 'sword' && distance <= 3.45) {
    const damage = playerDamage(target.profileKey === 'warden' ? 16 : 22, action);
    playSfx('sword');
    applyEnemyDamage(target, damage, 0xe9b36f, `${target.name} takes ${damage} damage.`);
  } else if (action === 'fire' && distance <= 8.5) {
    const damage = playerDamage(target.profileKey === 'warden' ? 12 : 17, action);
    playSfx('fire');
    applyEnemyDamage(target, damage, 0xf27e68, `${target.name} burns for ${damage}.`);
  } else if (action === 'freeze' && distance <= 8.5) {
    const damage = playerDamage(target.profileKey === 'warden' ? 7 : 10, action);
    playSfx('freeze');
    target.frozenTimer = target.profileKey === 'warden' ? 3.5 : 6;
    target.attackPending = false;
    target.pendingEnemyAttack = null;
    applyEnemyDamage(target, damage, 0x8dcdf3, `${target.name} freezes solid.`);
    spawnCombatText(target.root.position, 'FROZEN', '#bfe7fa', target.height + 0.55);
  }
}

function applySelfAction(action) {
  if (action === 'heal') {
    const restored = state.playerMaxHp - state.playerHp;
    state.playerHp = state.playerMaxHp;
    updateHealthUi();
    spawnBurst(player.root.position, 0x8ed9a8, 18);
    spawnCombatText(player.root.position, `+${restored}`, '#9fe1bb', player.height + 0.2);
    setToast(restored > 0 ? 'Vitality restored to full.' : 'Vitality is already full.');
  } else if (action === 'buff') {
    state.playerBuffTimer = 8;
    spawnBurst(player.root.position, 0xd0a2f0, 18);
    spawnCombatText(player.root.position, 'WARD', '#d8b5f0', player.height + 0.2);
    setToast('Arcane buff active: enemy damage is negated for 8s.');
  }
}

function useAction(action, target) {
  if (!state.loaded || state.finished || state.failed) return;
  const actionDef = ACTIONS[action];
  if (!actionDef) return;
  const selfAction = action === 'heal' || action === 'buff';
  if (!selfAction && (!target || target === player || target.dead || !isEnemyAccessible(target))) return;
  const remaining = state.actionCooldowns[action] ?? 0;
  if (remaining > 0) {
    setToast(`${action === 'buff' ? 'Ward' : action[0].toUpperCase() + action.slice(1)} is ready in ${remaining.toFixed(1)}s.`, 1000);
    closeActionMenu();
    return;
  }
  if (player.attackLock > 0 || player.attackCooldown > 0) {
    setToast('The cryptwalker is still recovering.', 1000);
    closeActionMenu();
    return;
  }
  if (action === 'heal' && state.playerHp >= state.playerMaxHp) {
    setToast('Vitality is already full.', 1000);
    closeActionMenu();
    return;
  }
  if (!selfAction) {
    const range = actionDef.range;
    if (player.root.position.distanceTo(target.root.position) > range) {
      setToast(`${target.name} is out of range.`, 1100);
      closeActionMenu();
      return;
    }
    state.combatStarted = true;
    state.weaponReadyTimer = 4.5;
    player.setWeaponSheathed(false);
    player.attackLock = action === 'sword' ? 0.67 : 0.58;
    player.attackTimer = action === 'sword' ? 0.24 : 0.2;
    player.attackTarget = target;
    player.pendingAction = action;
    player.face(target.root.position);
    player.play(['1h_melee_attack', 'melee_attack', 'attack'], { once: true, force: true });
    player.attackCooldown = action === 'sword' ? 0.52 : 0.78;
  } else {
    player.attackLock = 0.45;
    player.attackCooldown = 0.65;
    player.attackTimer = 0;
    player.attackTarget = null;
    player.pendingAction = null;
    player.play(['idle'], { force: true });
    applySelfAction(action);
  }
  state.actionCooldowns[action] = actionCooldownFor(action);
  state.started = true;
  closeActionMenu();
}

function attemptAttack() {
  const target = nearestLivingEnemy(3.1);
  if (!target) {
    state.started = true;
    setToast('Nothing close enough to strike.');
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
    const direction = new THREE.Vector3(
      (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0),
      0,
      (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0),
    );
    if (direction.lengthSq() > 0) {
      direction.normalize();
      const speed = player.speed * (state.playerBuffTimer > 0 ? 1.25 : 1);
      moveActorWithinMap(player, direction.x * speed * delta, direction.z * speed * delta, 0.65);
      player.face(player.root.position.clone().add(direction));
      player.play(['running', 'walking']);
      if (state.footstepTimer <= 0) {
        playSfx('step');
        state.footstepTimer = 0.34;
      }
    } else {
      player.play(['idle']);
    }
  }
}

function updateWeaponState(delta) {
  state.weaponReadyTimer = Math.max(0, state.weaponReadyTimer - delta);
  const nearbyThreat = enemies.some((enemy) => (
    !enemy.dead
    && enemy.awake
    && !enemy.evading
    && player.root.position.distanceTo(enemy.root.position) < 8
  ));
  player.setWeaponSheathed(state.weaponReadyTimer <= 0 && !nearbyThreat && player.attackLock <= 0);
  equippedItem.dataset.weaponState = player.weaponSheathed ? 'sheathed' : 'drawn';
  equippedItem.setAttribute('aria-label', `Weapon ${player.weaponSheathed ? 'sheathed' : 'drawn'}`);
}

function moveEnemy(enemy, direction, speed, delta) {
  if (direction.lengthSq() <= 0.001) return;
  direction.normalize();
  moveActorWithinMap(enemy, direction.x * speed * delta, direction.z * speed * delta, 0.65);
  enemy.face(enemy.root.position.clone().add(direction));
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

function startGroundAttack(enemy, profile, { wardenSlam = false } = {}) {
  const position = wardenSlam ? enemy.root.position.clone() : player.root.position.clone();
  const radius = wardenSlam ? 3.9 : profile.radius;
  const damage = wardenSlam ? 10 : profile.damage;
  const label = wardenSlam ? 'WARDEN SLAM' : profile.kind === 'support' ? 'GRAVE BOLT' : 'DEATH PULSE';
  const castDuration = wardenSlam ? 1.2 : profile.windup;
  const attack = { kind: 'ground', label, position, radius, damage, castDuration, castRemaining: castDuration };
  enemy.pendingEnemyAttack = attack;
  enemy.attackLock = profile.windup + 0.3;
  enemy.attackCooldown = profile.attackCooldown;
  enemy.face(player.root.position);
  enemy.play(['1h_melee_attack', 'melee_attack', 'attack'], { once: true, force: true });
  spawnTelegraph({
    position,
    radius,
    duration: castDuration,
    color: wardenSlam ? 0xc44743 : profile.kind === 'support' ? 0x9a69cf : 0xd57a62,
    attack,
    onResolve: () => {
      if (enemy.dead || enemy.frozenTimer > 0 || enemy.pendingEnemyAttack !== attack) return;
      enemy.pendingEnemyAttack = null;
      spawnBurst(position, wardenSlam ? 0xe06252 : 0xb07bd3, wardenSlam ? 28 : 16);
      if (player.root.position.distanceTo(position) <= radius) damagePlayer(damage, enemy.name);
      else spawnCombatText(player.root.position, 'DODGED', '#a9d8ef', player.height + 0.2);
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
      maxHp: 22,
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
    if (enemy.specialCooldown <= 0 && distance <= 5.5) {
      enemy.specialCooldown = profile.slamCooldown;
      startGroundAttack(enemy, profile, { wardenSlam: true });
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
    colliderWidth: 1.25,
    colliderDepth: 0.9,
  });
  state.openedChests += 1;
  spawnBurst(chest.position, 0xf4d071, 22);
  playSfx('chest');
  addCameraFeedback(0.055, 0.9);
  if (chest.kind === 'seal') {
    state.seals[chest.branch] = true;
    state.playerHp = Math.min(state.playerMaxHp, state.playerHp + 25);
    spawnCombatText(chest.position, `${chest.branch.toUpperCase()} SEAL`, '#f2cf7c', 1.8);
    setToast(`The ${chest.branch}ern branch seal is yours.`, 2400);
  } else if (chest.kind === 'archive') {
    state.archiveKey = true;
    spawnCombatText(chest.position, 'ARCHIVE KEY', '#c9b2f0', 1.8);
    setToast('The Archive key hums toward the Warden\'s Keep.', 2400);
  } else if (chest.kind === 'final') {
    spawnCombatText(chest.position, 'WARDEN RELIC', '#f2cf7c', 1.8);
    setToast('The Warden relic completes the delve. Return to the entrance.', 2400);
  } else {
    state.playerHp = Math.min(state.playerMaxHp, state.playerHp + 12);
    for (const action of Object.keys(state.actionCooldowns)) {
      state.actionCooldowns[action] = Math.max(0, state.actionCooldowns[action] - 1.5);
    }
    spawnCombatText(chest.position, 'RENEWED', '#9fe1bb', 1.8);
    setToast(`${chest.name} restores vitality and hastens your abilities.`);
  }
  updateHealthUi();
  updateProgression();
  updateQuestUi();
}

function interact() {
  if (!state.loaded || state.finished || state.failed) return;
  closeActionMenu();
  state.started = true;
  const nearbyLoot = nearestLootDrop(1.9);
  if (nearbyLoot) {
    collectLootDrop(nearbyLoot);
    return;
  }
  const nearbyChest = nearestClosedChest(2.1);
  if (nearbyChest) {
    openChest(nearbyChest);
    return;
  }
}

function finishRun(success) {
  if (state.finished || state.failed) return;
  state.finished = success;
  state.failed = !success;
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
  closeActionMenu();
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
  const key = event.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
    state.started = true;
    closeActionMenu();
    keys.add(key);
    event.preventDefault();
  }
  if (key === 'e' && !event.repeat) interact();
  if (key === 'escape') closeActionMenu();
  if (event.code === 'Space' && !event.repeat) {
    closeActionMenu();
    attemptAttack();
    event.preventDefault();
  }
}

function onKeyUp(event) {
  keys.delete(event.key.toLowerCase());
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  if (state.loaded && !state.finished && !state.failed) {
    state.elapsed += delta;
    state.playerBuffTimer = Math.max(0, state.playerBuffTimer - delta);
    for (const action of Object.keys(state.actionCooldowns)) {
      state.actionCooldowns[action] = Math.max(0, state.actionCooldowns[action] - delta);
    }
    player.update(delta);
    updatePlayer(delta);
    updateWeaponState(delta);
    updateProgression();
    if (runObjectivesComplete() && player.root.position.distanceTo(state.exitPosition) < 2.4) {
      finishRun(true);
    }
    for (const enemy of enemies) {
      enemy.update(delta);
      updateEnemy(enemy, delta);
    }
    updateEffects(delta);
    updateLootDrops(delta);
    updateTelegraphs(delta);
    updateCombatTexts(delta);
    updateCamera(delta);
    updateEnemyNameplates();
    updateMinimap(delta);
    updateHealthUi();
    updateActionUi();
    updateTargetUi();
    updateQuestUi();
    updateInteractionUi();
    updateActionMenuPosition();
  }
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});
window.addEventListener('keydown', onKeyDown, { passive: false });
window.addEventListener('keyup', onKeyUp);
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  initAudio();
  closeActionMenu();
  pointerPress = { x: event.clientX, y: event.clientY, time: performance.now() };
});
canvas.addEventListener('pointerup', (event) => {
  if (event.button !== 0 || !pointerPress) return;
  const distance = Math.hypot(event.clientX - pointerPress.x, event.clientY - pointerPress.y);
  const duration = performance.now() - pointerPress.time;
  pointerPress = null;
  if (distance < 8 && duration < 500) {
    const target = pickActor(event.clientX, event.clientY);
    if (target) openActionMenu(target);
  }
});
canvas.addEventListener('pointercancel', () => {
  pointerPress = null;
});
actionBubbles.forEach((button) => {
  button.addEventListener('click', () => useAction(button.dataset.action, actionTarget));
});
backpackSlots.forEach((button) => {
  button.addEventListener('click', () => useInventorySlot(Number(button.dataset.inventorySlot)));
});
restartButton.addEventListener('click', resetRun);

async function start() {
  try {
    await loadAssets();
    buildWorld();
    state.loaded = true;
    updateProgression();
    updateActionUi();
    updateInventoryUi();
    updateMinimap(0, true);
    setLoading(1, 'The crypt is awake');
    window.setTimeout(() => loadingScreen.classList.add('is-hidden'), 420);
    setToast('Three branches wait beyond the central hub.');
  } catch (error) {
    console.error(error);
    loadingLabel.textContent = 'The asset bundle could not be opened. Check the browser console.';
    loadingFill.style.background = '#b5656b';
  }
}

animate();
start();
