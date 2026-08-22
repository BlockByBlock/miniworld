const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createNavigationContext({
  mode,
  townBounds,
  worldBounds,
  mapZones,
  corridorZoneIds,
  staticColliders,
  townStaticColliders,
}) {
  return {
    mode,
    townBounds,
    worldBounds,
    mapZones,
    corridorZoneIds,
    staticColliders,
    townStaticColliders,
  };
}

export function cameraRelativeDirection(forward, right, forwardInput, strafeInput) {
  const x = forward.x * forwardInput + right.x * strafeInput;
  const z = forward.z * forwardInput + right.z * strafeInput;
  const length = Math.hypot(x, z);
  if (length < 0.001) return { x: 0, z: 0 };
  return { x: x / length, z: z / length };
}

function pointInBounds(x, z, bounds, padding) {
  return x >= bounds.minX + padding
    && x <= bounds.maxX - padding
    && z >= bounds.minZ + padding
    && z <= bounds.maxZ - padding;
}

function pointHitsCollider(x, z, colliders, padding) {
  return colliders.some((collider) => {
    return collider.root.visible
      && x >= collider.minX - padding
      && x <= collider.maxX + padding
      && z >= collider.minZ - padding
      && z <= collider.maxZ + padding;
  });
}

export function isWalkablePoint({ x, z, padding = 0.55, navigation }) {
  if (navigation.mode === 'town') {
    if (!pointInBounds(x, z, navigation.townBounds, padding)) return false;
    return !pointHitsCollider(x, z, navigation.townStaticColliders, padding);
  }
  const insideMap = navigation.mapZones.some((zone) => {
    // Corridors overlap the room interiors by the actor clearance so their
    // usable areas meet at each doorway instead of leaving a collision seam.
    const clearance = navigation.corridorZoneIds.has(zone) ? -padding : padding;
    return x >= zone.minX + clearance
      && x <= zone.maxX - clearance
      && z >= zone.minZ + clearance
      && z <= zone.maxZ - clearance;
  });
  if (!insideMap) return false;
  return !pointHitsCollider(x, z, navigation.staticColliders, padding);
}

export function stepActorWithinMap(point, offsetX, offsetZ, bounds, isWalkable, padding = 0.55) {
  const nextX = clamp(point.x + offsetX, bounds.minX + padding, bounds.maxX - padding);
  const nextZ = clamp(point.z + offsetZ, bounds.minZ + padding, bounds.maxZ - padding);
  if (isWalkable(nextX, point.z, padding)) point.x = nextX;
  if (isWalkable(point.x, nextZ, padding)) point.z = nextZ;
  return point;
}
