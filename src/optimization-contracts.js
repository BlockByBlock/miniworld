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
  // Overflowing the shader light count must degrade gracefully, not crash
  // the render loop when content grows past the pool.
  return recipes.slice(0, capacity);
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

export function createSlotPool(createSlot) {
  const free = [];
  return {
    acquire: () => free.pop() ?? createSlot(),
    release: (slot) => { free.push(slot); },
  };
}
