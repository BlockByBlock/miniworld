import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  collectDungeonLightRecipes,
  createCryptProfile,
  createSlotPool,
  waitForProfileTarget,
} from '../src/optimization-contracts.js';

test('creates an inactive profiling buffer', () => {
  const profile = createCryptProfile();

  assert.equal(profile.active, false);
  assert.deepEqual(profile.frames, []);
  assert.deepEqual(profile.zones, []);
  assert.deepEqual(profile.marks, []);
});

test('keeps the five visible hub and branch lights and truncates overflow', () => {
  const recipes = new Map([
    ['hub', [{ id: 'hub-1' }, { id: 'hub-2' }, { id: 'hub-3' }, { id: 'hub-4' }]],
    ['westGate', [{ id: 'west-1' }]],
  ]);

  assert.equal(collectDungeonLightRecipes(['hub', 'westGate'], recipes, 5).length, 5);
  const overflow = collectDungeonLightRecipes(['hub', 'westGate'], recipes, 3);
  assert.deepEqual(overflow.map((recipe) => recipe.id), ['hub-1', 'hub-2', 'hub-3']);
});

test('reuses released slots but never hands out a live slot twice', () => {
  let created = 0;
  const pool = createSlotPool(() => ({ id: ++created }));
  const first = pool.acquire();
  const second = pool.acquire();

  assert.notEqual(first, second);
  const third = pool.acquire();
  assert.notEqual(third, first);
  assert.notEqual(third, second);

  pool.release(second);
  assert.equal(pool.acquire(), second);
  assert.equal(created, 3);
});

test('fails a profiling route step when the target is unreachable', async () => {
  let now = 0;
  let target = null;

  await assert.rejects(
    waitForProfileTarget({
      x: 1,
      z: 1,
      setTarget: (nextTarget) => { target = nextTarget; },
      getPosition: () => ({ x: 0, z: 0 }),
      wait: async () => { now += 50; },
      now: () => now,
      timeoutMs: 100,
    }),
    /Profile route could not reach \(1, 1\)/,
  );
  assert.deepEqual(target, { x: 1, z: 1 });
});
