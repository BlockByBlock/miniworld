import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { VisibilityGroup } from './visibility-group.js';
import { alignVisualToGround, assets } from './models.js';

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

export class Actor {
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
    sceneRoot,
  }) {
    const source = assets.get(assetKey);
    this.name = name;
    this.role = role;
    this.type = type;
    this.root = new VisibilityGroup();
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
