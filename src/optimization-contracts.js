export function createCryptProfile() {
  return {
    active: false,
    frames: [],
    zones: [],
    marks: [],
  };
}

export function collectDungeonLightRecipes(visibleZoneIds, dungeonZoneLights, capacity = Infinity) {
  const recipes = [];
  for (const zoneId of visibleZoneIds) {
    recipes.push(...(dungeonZoneLights.get(zoneId) ?? []));
  }
  if (recipes.length > capacity) {
    throw new Error(`Dungeon light pool capacity ${capacity} exceeded by ${recipes.length} recipes.`);
  }
  return recipes;
}

export async function waitForProfileTarget({
  x,
  z,
  setTarget,
  getPosition,
  wait,
  now = () => performance.now(),
  threshold = 1.2,
  timeoutMs = 20000,
}) {
  setTarget({ x, z });
  const start = now();
  while (now() - start < timeoutMs) {
    const position = getPosition();
    if (Math.hypot(position.x - x, position.z - z) < threshold) return;
    await wait(50);
  }
  throw new Error(`Profile route could not reach (${x}, ${z}).`);
}

export function createSlotPool(size, createSlot) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('Pool size must be a positive integer.');
  const slots = [];
  let cursor = 0;
  return () => {
    if (!slots[cursor]) slots[cursor] = createSlot();
    const slot = slots[cursor];
    cursor = (cursor + 1) % size;
    return slot;
  };
}
