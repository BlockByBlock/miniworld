import * as THREE from 'three';
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
const interaction = $('#interaction');
const toast = $('#toast');

const ASSETS = {
  knight: '/assets/models/chars/players/knight.glb',
  skeletonWarrior: '/assets/models/chars/enemies/skeleton_warrior.glb',
  skeletonGolem: '/assets/models/chars/enemies/skeleton_golem.glb',
  floorTile: '/assets/models/dungeon/floor_tile_small.glb',
  archGate: '/assets/models/dungeon/arch_gate.glb',
  torch: '/assets/models/dungeon/torch_lit.glb',
  chest: '/assets/models/dungeon/chest.glb',
  chestGold: '/assets/models/dungeon/chest_gold.glb',
  column: '/assets/models/dungeon/column.glb',
  crypt: '/assets/models/dungeon/crypt.glb',
  banner: '/assets/models/dungeon/banner_red.glb',
};

const WORLD = {
  minX: -8.3,
  maxX: 8.3,
  minZ: -6.1,
  maxZ: 6.1,
};

const state = {
  loaded: false,
  started: false,
  combatStarted: false,
  finished: false,
  failed: false,
  playerHp: 100,
  playerMaxHp: 100,
  chestOpened: false,
  chestRoot: null,
  rewardRoot: null,
  exitPosition: new THREE.Vector3(0, -5.25, 0),
  toastTimer: 0,
  toastText: '',
  elapsed: 0,
};

const keys = new Set();
const assets = new Map();
const enemies = [];
const effects = [];

const scene = new THREE.Scene();
scene.background = new THREE.Color('#090b14');
scene.fog = new THREE.FogExp2('#090b14', 0.035);

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

const loader = new GLTFLoader();
const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/');
ktx2Loader.detectSupport(renderer);
loader.setKTX2Loader(ktx2Loader);
loader.setMeshoptDecoder(MeshoptDecoder);

const clock = new THREE.Clock();
const tempVector = new THREE.Vector3();
const tempBox = new THREE.Box3();
const tempSize = new THREE.Vector3();

let player;
let cameraLookAt = new THREE.Vector3(0, 0.8, 0);
let toastTimeout;

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

class Actor {
  constructor({ assetKey, type, position, height, name, maxHp = 1, speed = 0 }) {
    const source = assets.get(assetKey);
    this.name = name;
    this.type = type;
    this.root = new THREE.Group();
    this.root.position.copy(position);
    this.visual = SkeletonUtils.clone(source.scene);
    alignVisualToGround(this.visual, height);
    setShadows(this.visual);
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
    this.deathTimer = 0;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.speed = speed;
    this.dead = false;
    this.play(type === 'player' ? ['idle'] : ['idle_combat', 'idle']);
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
  }
}

function createStatic(assetKey, { x = 0, y = 0, z = 0, rotationY = 0, width, depth, height } = {}) {
  const source = assets.get(assetKey);
  const root = new THREE.Group();
  const visual = source.scene.clone(true);
  fitStaticVisual(visual, { width, depth, height });
  setShadows(visual);
  root.add(visual);
  root.position.set(x, y, z);
  root.rotation.y = rotationY;
  scene.add(root);
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

function addPointLight(x, z, color = 0xffbd74, intensity = 2.4) {
  const light = new THREE.PointLight(color, intensity, 7, 2);
  light.position.set(x, 2.2, z);
  light.castShadow = true;
  light.shadow.mapSize.set(512, 512);
  scene.add(light);
}

function buildLighting() {
  scene.add(new THREE.HemisphereLight(0x8886b3, 0x17131b, 1.7));
  const moon = new THREE.DirectionalLight(0xc8c9ff, 2.1);
  moon.position.set(-5, 12, 7);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.left = -14;
  moon.shadow.camera.right = 14;
  moon.shadow.camera.top = 14;
  moon.shadow.camera.bottom = -14;
  scene.add(moon);
  addPointLight(-6.1, 4.25);
  addPointLight(6.1, 4.25, 0xffa767, 2.6);
  addPointLight(0, -4.75, 0x8e9aff, 2.2);
}

function buildRoom() {
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x252839,
    roughness: 0.93,
    metalness: 0.04,
  });
  const underfloor = new THREE.Mesh(new THREE.PlaneGeometry(18.5, 14.3), floorMaterial);
  underfloor.rotation.x = -Math.PI / 2;
  underfloor.position.y = -0.08;
  underfloor.receiveShadow = true;
  scene.add(underfloor);

  const grid = new THREE.GridHelper(16.8, 16, 0x525168, 0x292a3a);
  grid.position.y = 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.24;
  scene.add(grid);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x171928,
    roughness: 0.96,
    metalness: 0.02,
  });
  addBox({ x: 0, y: 1.35, z: WORLD.minZ - 0.32, width: 17.2, height: 2.7, depth: 0.5, material: wallMaterial });
  addBox({ x: 0, y: 1.35, z: WORLD.maxZ + 0.32, width: 17.2, height: 2.7, depth: 0.5, material: wallMaterial });
  addBox({ x: WORLD.minX - 0.32, y: 1.35, z: 0, width: 0.5, height: 2.7, depth: 12.2, material: wallMaterial });
  addBox({ x: WORLD.maxX + 0.32, y: 1.35, z: 0, width: 0.5, height: 2.7, depth: 12.2, material: wallMaterial });

  for (let x = -7; x <= 7; x += 2) {
    for (let z = -5; z <= 5; z += 2) {
      createStatic('floorTile', { x, z, width: 1.92, depth: 1.92 });
    }
  }

  createStatic('archGate', { x: 0, z: WORLD.minZ - 0.12, width: 3.1, height: 3.4 });
  createStatic('crypt', { x: 0, z: WORLD.minZ + 0.8, width: 2.1, height: 2.3 });
  createStatic('column', { x: -6.4, z: -4.65, width: 1.15, height: 2.8 });
  createStatic('column', { x: 6.4, z: -4.65, width: 1.15, height: 2.8 });
  createStatic('column', { x: -6.4, z: 4.6, width: 1.15, height: 2.8 });
  createStatic('column', { x: 6.4, z: 4.6, width: 1.15, height: 2.8 });
  createStatic('banner', { x: 7.35, z: 0.45, height: 2.65, rotationY: -Math.PI / 2 });
  createStatic('torch', { x: -6.85, z: 4.1, height: 2.2, rotationY: Math.PI / 2 });
  createStatic('torch', { x: 6.85, z: 4.1, height: 2.2, rotationY: -Math.PI / 2 });
  createStatic('torch', { x: -6.85, z: -2.4, height: 2.2, rotationY: Math.PI / 2 });
  createStatic('torch', { x: 6.85, z: -2.4, height: 2.2, rotationY: -Math.PI / 2 });

  state.chestRoot = createStatic('chest', { x: 0, z: 0.25, width: 1.35, height: 1.05 });
}

function spawnActor({ assetKey, type, name, x, z, height, maxHp, speed }) {
  return new Actor({
    assetKey,
    type,
    name,
    position: new THREE.Vector3(x, 0, z),
    height,
    maxHp,
    speed,
  });
}

function buildActors() {
  player = spawnActor({ assetKey: 'knight', type: 'player', name: 'Cryptwalker', x: 0, z: 4.45, height: 1.85, maxHp: 100, speed: 4.2 });
  enemies.push(spawnActor({ assetKey: 'skeletonWarrior', type: 'enemy', name: 'Boneguard', x: -3.6, z: 1.25, height: 1.8, maxHp: 30, speed: 1.05 }));
  enemies.push(spawnActor({ assetKey: 'skeletonWarrior', type: 'enemy', name: 'Gravebound', x: 3.5, z: -1.0, height: 1.8, maxHp: 30, speed: 1.1 }));
  enemies.push(spawnActor({ assetKey: 'skeletonGolem', type: 'enemy', name: 'Crypt Warden', x: 0, z: -3.0, height: 2.2, maxHp: 60, speed: 0.72 }));
}

function buildWorld() {
  buildLighting();
  buildRoom();
  buildActors();
  updateHealthUi();
  updateQuestUi();
}

function nearestLivingEnemy(maxDistance = Infinity) {
  let nearest = null;
  let nearestDistance = maxDistance;
  for (const enemy of enemies) {
    if (enemy.dead) continue;
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

function updateHealthUi() {
  const ratio = Math.max(0, state.playerHp / state.playerMaxHp);
  healthValue.textContent = `${Math.ceil(state.playerHp)} / ${state.playerMaxHp}`;
  healthFill.style.width = `${ratio * 100}%`;
  healthFill.style.background = ratio < 0.3
    ? 'linear-gradient(90deg, #ad5e63, #d8866b)'
    : 'linear-gradient(90deg, #e1a26a, #eacb8a)';
}

function updateTargetUi() {
  if (!state.started) {
    targetCard.classList.add('is-hidden');
    return;
  }
  const target = nearestLivingEnemy(4.4);
  if (!target) {
    targetCard.classList.add('is-hidden');
    return;
  }
  targetCard.classList.remove('is-hidden');
  targetName.textContent = target.name;
  targetFill.style.width = `${Math.max(0, target.hp / target.maxHp) * 100}%`;
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
    objectiveDetail.textContent = 'WASD to move, then click or press Space to draw steel.';
  } else if (threats > 0) {
    objective.textContent = 'Silence the dead';
    objectiveDetail.textContent = `${threats} hostile ${threats === 1 ? 'presence' : 'presences'} remain in the chamber.`;
  } else if (!state.chestOpened) {
    objective.textContent = 'Claim the silver chest';
    objectiveDetail.textContent = 'Move to the centre of the room and press E.';
  } else {
    objective.textContent = 'Find the way out';
    objectiveDetail.textContent = 'Reach the blue-lit gate at the far end of the crypt.';
  }
}

function updateInteractionUi() {
  if (!state.loaded || state.finished || state.failed) {
    interaction.classList.add('is-hidden');
    return;
  }
  const chestDistance = player.root.position.distanceTo(new THREE.Vector3(0, 0, 0.25));
  const exitDistance = player.root.position.distanceTo(state.exitPosition);
  const canOpenChest = !state.chestOpened && chestDistance < 2.1;
  const canExit = state.chestOpened && countLivingEnemies() === 0 && exitDistance < 2.4;
  if (canOpenChest || canExit) {
    interaction.classList.remove('is-hidden');
    interaction.innerHTML = `Press <kbd>E</kbd> to ${canExit ? 'escape' : 'open the chest'}`;
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

function attemptAttack() {
  if (!state.loaded || state.finished || state.failed || player.attackLock > 0 || player.attackCooldown > 0) return;
  state.started = true;
  const target = nearestLivingEnemy(3.1);
  if (target) state.combatStarted = true;
  player.attackLock = 0.67;
  player.attackTimer = target ? 0.24 : 0;
  player.attackTarget = target;
  player.face(target?.root.position ?? player.root.position.clone().add(new THREE.Vector3(0, 0, -1)));
  player.play(['1h_melee_attack', 'melee_attack', 'attack'], { once: true, force: true });
  player.attackCooldown = 0.52;
  if (!target) setToast('Nothing close enough to strike.');
}

function applyPlayerAttack() {
  const target = player.attackTarget;
  player.attackTarget = null;
  if (!target || target.dead || player.root.position.distanceTo(target.root.position) > 3.45) return;
  const damage = target.name === 'Crypt Warden' ? 16 : 22;
  target.hp = Math.max(0, target.hp - damage);
  target.attackLock = 0.28;
  target.play(['hit'], { once: true, force: true });
  spawnBurst(target.root.position, 0xe9b36f, 8);
  if (target.hp <= 0) {
    target.dead = true;
    target.deathTimer = 0.95;
    target.play(['death'], { once: true, force: true });
    setToast(`${target.name} falls.`);
  } else {
    setToast(`${target.name} takes ${damage} damage.` , 1000);
  }
}

function damagePlayer(amount, sourceName) {
  if (state.finished || state.failed) return;
  state.playerHp = Math.max(0, state.playerHp - amount);
  player.play(['hit'], { once: true, force: true });
  player.attackLock = Math.max(player.attackLock, 0.32);
  updateHealthUi();
  setToast(`${sourceName} hits for ${amount}.`, 1050);
  if (state.playerHp <= 0) finishRun(false);
}

function updatePlayer(delta) {
  if (player.dead) return;
  if (player.attackTimer > 0) {
    player.attackTimer -= delta;
    if (player.attackTimer <= 0) applyPlayerAttack();
  }
  if (player.attackLock <= 0) {
    const direction = new THREE.Vector3(
      (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0),
      0,
      (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0),
    );
    if (direction.lengthSq() > 0) {
      direction.normalize();
      player.root.position.addScaledVector(direction, player.speed * delta);
      player.root.position.x = THREE.MathUtils.clamp(player.root.position.x, WORLD.minX + 0.7, WORLD.maxX - 0.7);
      player.root.position.z = THREE.MathUtils.clamp(player.root.position.z, WORLD.minZ + 0.8, WORLD.maxZ - 0.7);
      player.face(player.root.position.clone().add(direction));
      player.play(['running', 'walking']);
    } else {
      player.play(['idle']);
    }
  }
}

function updateEnemy(enemy, delta) {
  if (!state.started) {
    enemy.play(['idle_combat', 'idle']);
    return;
  }
  if (!state.combatStarted && !enemy.dead) {
    enemy.face(player.root.position);
    enemy.play(['idle_combat', 'idle']);
    return;
  }
  if (enemy.dead) {
    enemy.deathTimer -= delta;
    if (enemy.deathTimer <= 0) enemy.root.visible = false;
    return;
  }
  if (enemy.attackPending) {
    enemy.attackTimer -= delta;
    if (enemy.attackTimer <= 0) {
      enemy.attackPending = false;
      if (player.root.position.distanceTo(enemy.root.position) < 2.25) {
        damagePlayer(enemy.name === 'Crypt Warden' ? 6 : 3, enemy.name);
      }
    }
  }
  const distance = player.root.position.distanceTo(enemy.root.position);
  if (enemy.attackLock <= 0 && distance > 1.72) {
    tempVector.subVectors(player.root.position, enemy.root.position).setY(0);
    if (tempVector.lengthSq() > 0.01) {
      tempVector.normalize();
      enemy.root.position.addScaledVector(tempVector, enemy.speed * delta);
      enemy.root.position.x = THREE.MathUtils.clamp(enemy.root.position.x, WORLD.minX + 0.8, WORLD.maxX - 0.8);
      enemy.root.position.z = THREE.MathUtils.clamp(enemy.root.position.z, WORLD.minZ + 0.8, WORLD.maxZ - 0.8);
      enemy.face(player.root.position);
      enemy.play(['running', 'walking']);
    }
  } else if (enemy.attackLock <= 0) {
    enemy.face(player.root.position);
    enemy.play(['idle_combat', 'idle']);
    if (enemy.attackCooldown <= 0 && distance < 2.25) {
      enemy.attackCooldown = enemy.name === 'Crypt Warden' ? 2.35 : 1.9;
      enemy.attackTimer = 0.32;
      enemy.attackPending = true;
      enemy.attackLock = 0.72;
      enemy.play(['1h_melee_attack', 'melee_attack', 'attack'], { once: true, force: true });
    }
  }
}

function updateCamera(delta) {
  const target = player.root.position;
  const desiredPosition = new THREE.Vector3(target.x + 9.8, 10.6, target.z + 10.6);
  camera.position.lerp(desiredPosition, 1 - Math.pow(0.001, delta));
  cameraLookAt.lerp(new THREE.Vector3(target.x, 0.8, target.z), 1 - Math.pow(0.0005, delta));
  camera.lookAt(cameraLookAt);
}

function openChest() {
  if (state.chestOpened) return;
  state.chestOpened = true;
  state.chestRoot.visible = false;
  state.rewardRoot = createStatic('chestGold', { x: 0, z: 0.25, width: 1.35, height: 1.05 });
  spawnBurst(new THREE.Vector3(0, 0, 0.25), 0xf4d071, 22);
  setToast('The chest yields a warm shard of light.');
  updateQuestUi();
}

function interact() {
  if (!state.loaded || state.finished || state.failed) return;
  state.started = true;
  const chestDistance = player.root.position.distanceTo(new THREE.Vector3(0, 0, 0.25));
  const exitDistance = player.root.position.distanceTo(state.exitPosition);
  if (!state.chestOpened && chestDistance < 2.1) {
    openChest();
  } else if (state.chestOpened && countLivingEnemies() === 0 && exitDistance < 2.4) {
    finishRun(true);
  } else if (countLivingEnemies() > 0) {
    setToast('The crypt gate will not yield while the dead still walk.');
  } else if (!state.chestOpened) {
    setToast('The chest is waiting in the centre of the chamber.');
  }
}

function finishRun(success) {
  if (state.finished || state.failed) return;
  state.finished = success;
  state.failed = !success;
  if (success) {
    endEyebrow.textContent = 'CRYPT CLEARED';
    endTitle.textContent = 'The old gate opens.';
    endCopy.textContent = 'You made it through the complete ten-minute preview loop.';
  } else {
    endEyebrow.textContent = 'THE CRYPT WINS';
    endTitle.textContent = 'The lanterns go dark.';
    endCopy.textContent = 'The route is short. Try again and keep the dead at sword’s reach.';
  }
  endScreen.classList.remove('is-hidden');
  targetCard.classList.add('is-hidden');
  interaction.classList.add('is-hidden');
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
  const key = event.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
    state.started = true;
    keys.add(key);
    event.preventDefault();
  }
  if (key === 'e' && !event.repeat) interact();
  if (event.code === 'Space' && !event.repeat) {
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
    player.update(delta);
    updatePlayer(delta);
    for (const enemy of enemies) {
      enemy.update(delta);
      updateEnemy(enemy, delta);
    }
    updateEffects(delta);
    updateCamera(delta);
    updateTargetUi();
    updateQuestUi();
    updateInteractionUi();
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
canvas.addEventListener('pointerdown', attemptAttack);
restartButton.addEventListener('click', resetRun);

async function start() {
  try {
    await loadAssets();
    buildWorld();
    state.loaded = true;
    setLoading(1, 'The crypt is awake');
    window.setTimeout(() => loadingScreen.classList.add('is-hidden'), 420);
    setToast('The dead are listening. Reach the centre.');
  } catch (error) {
    console.error(error);
    loadingLabel.textContent = 'The asset bundle could not be opened. Check the browser console.';
    loadingFill.style.background = '#b5656b';
  }
}

animate();
start();
