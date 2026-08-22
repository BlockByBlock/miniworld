import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  cameraRelativeDirection,
  createNavigationContext,
  isWalkablePoint,
  stepActorWithinMap,
} from '../src/movement-contracts.js';

const townBounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
const room = { id: 'hub', minX: -10, maxX: 10, minZ: 0, maxZ: 20 };
const corridor = { id: 'entry-corridor', minX: -2, maxX: 2, minZ: 20, maxZ: 30 };
const destination = { id: 'vault', minX: -10, maxX: 10, minZ: 30, maxZ: 40 };
const corridorZones = new Set([corridor]);
const collider = { root: { visible: true }, minX: 4, maxX: 6, minZ: 4, maxZ: 6 };
const navigation = createNavigationContext({
  mode: 'dungeon',
  townBounds,
  worldBounds: { minX: -60, maxX: 60, minZ: -55, maxZ: 40 },
  mapZones: [room, corridor, destination],
  corridorZoneIds: corridorZones,
  staticColliders: [collider],
  townStaticColliders: [],
});

function walkable({ x, z, padding, mode = 'dungeon' }) {
  return isWalkablePoint({ x, z, padding, navigation: { ...navigation, mode } });
}

test('rejects points outside the map and accepts the room interior', () => {
  assert.equal(walkable({ x: 0, z: 10 }), true);
  assert.equal(walkable({ x: -11, z: 10 }), false);
  assert.equal(walkable({ x: 0, z: 41 }), false);
});


test('colliders block with padding and only while visible', () => {
  assert.equal(walkable({ x: 5, z: 5 }), false);
  assert.equal(walkable({ x: 5 + 0.55, z: 5 }), false);
  assert.equal(walkable({ x: 6.56, z: 5 }), true);
  collider.root.visible = false;
  assert.equal(walkable({ x: 5, z: 5 }), true);
  collider.root.visible = true;
});

test('town mode uses town bounds and town colliders', () => {
  const houseCollider = { root: { visible: true }, minX: -6, maxX: -4, minZ: -6, maxZ: -4 };
  const townNavigation = createNavigationContext({
    mode: 'town',
    townBounds,
    worldBounds: townBounds,
    mapZones: [room, destination],
    corridorZoneIds: corridorZones,
    staticColliders: [],
    townStaticColliders: [houseCollider],
  });
  assert.equal(isWalkablePoint({ navigation: townNavigation, x: 0, z: 0 }), true);
  assert.equal(isWalkablePoint({ navigation: townNavigation, x: -21, z: 0 }), false);
});

test('corridor clearance keeps doorways usable instead of seam-blocking them', () => {
  // Padding shrinks rooms but grows corridors so their usable areas meet
  // at the doorway (z ~ 19.45..20) instead of leaving a collision seam.
  assert.equal(walkable({ x: 0, z: 19.8, padding: 0.55 }), true);
  assert.equal(walkable({ x: 0, z: 29.7, padding: 0.55 }), true);
  assert.equal(walkable({ x: 2.6, z: 25, padding: 0.55 }), false);
});
test('steps clamp to bounds and slide along walls axis-by-axis', () => {
  const point = { x: 9, z: 10 };
  stepActorWithinMap(point, 5, 0, room, (x, z) => walkable({ x, z }));
  assert.deepEqual(point, { x: 9.45, z: 10 });

  stepActorWithinMap(point, 0, -20, room, (x, z) => walkable({ x, z }));
  assert.deepEqual(point, { x: 9.45, z: 0.55 });
});

test('a blocked axis keeps its coordinate while the free axis still moves', () => {
  const wallBounds = { minX: 8.5, maxX: 12, minZ: 9, maxZ: 11 };
  const point = { x: 8, z: 10 };
  const blocked = (x, z) => !(
    x >= wallBounds.minX - 0.55 && x <= wallBounds.maxX + 0.55
    && z >= wallBounds.minZ - 0.55 && z <= wallBounds.maxZ + 0.55
  );
  stepActorWithinMap(point, 3, 3, room, blocked);
  assert.deepEqual(point, { x: 8, z: 13 });
});

test('camera-relative input follows the camera basis', () => {
  assert.deepEqual(
    cameraRelativeDirection({ x: 1, z: 0 }, { x: 0, z: -1 }, 1, 0),
    { x: 1, z: 0 },
  );
  assert.deepEqual(
    cameraRelativeDirection({ x: 0, z: -1 }, { x: 1, z: 0 }, 0, 1),
    { x: 1, z: 0 },
  );
});

test('traverses a room, doorway corridor, and destination room without axis seams', () => {
  const point = { x: 0, z: 10 };
  const route = [
    { x: 0, z: 19.8 },
    { x: 0, z: 20.2 },
    { x: 0, z: 29.7 },
    { x: 0, z: 31 },
  ];
  for (const target of route) {
    stepActorWithinMap(point, target.x - point.x, target.z - point.z, navigation.worldBounds, (x, z, padding) => walkable({ x, z, padding }));
    assert.deepEqual(point, target);
  }
});
