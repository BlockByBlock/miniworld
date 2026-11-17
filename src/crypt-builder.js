import * as THREE from 'three';
import { VisibilityGroup } from './visibility-group.js';
import { brickWallCornerRotation, brickWallDimensions } from './crypt-wall-geometry.js';
import { ROOM_DECORATIONS } from './game/room-decorations.js';
import { assets, fitStaticVisual } from './models.js';

// World-building helpers for static models, walls, floors, and room dressing.
// Objects land in the zone group currently being built, so each room or
// corridor can be shown or hidden as a unit.
export function createWorldBuilder({ scene, staticColliders, zoneRenderGroups, recordZoneLight }) {
  const tempBox = new THREE.Box3();
  const tempSize = new THREE.Vector3();
  let activeWorldGroup = null;

  function addWorldObject(object, parent = null) {
    (parent ?? activeWorldGroup ?? scene).add(object);
    return object;
  }

  function buildZoneRenderGroup(zone, build) {
    const group = new VisibilityGroup();
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

  return {
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
  };
}
