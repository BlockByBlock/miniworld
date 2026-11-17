import { strict as assert } from 'node:assert';
import test from 'node:test';

import { WORLD_DATA } from '../src/world-data.js';
import { CHECKPOINT_KEY, clearCheckpoint, readCheckpoint, writeCheckpoint } from '../src/save-game.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const checkpoint = {
  roomId: 'westGate',
  position: { x: -26, z: 9 },
  discoveredRooms: ['entrance', 'hub', 'westGate'],
  playerHp: 64,
  inventory: ['healingDraft', 'emberCharm', null, null, null, null],
  equippedSlot: 1,
  seals: { west: false, east: false },
  archiveKey: false,
  openedChests: ['hub-cache'],
  deadEnemies: ['boneguard-captain'],
  loot: [{ itemId: 'frostRune', x: -24, z: 8 }],
  gates: [{ corridorId: 'entry-corridor', wallRoomId: 'hub', visibleFrames: ['entrance', 'hub'] }],
};

test('round-trips a checkpoint and clears it', () => {
  const storage = memoryStorage();
  writeCheckpoint(storage, checkpoint);
  assert.deepEqual(readCheckpoint(storage, WORLD_DATA), { ...checkpoint, version: 1 });
  clearCheckpoint(storage);
  assert.equal(readCheckpoint(storage, WORLD_DATA), null);
});

test('discards checkpoints that do not match the current world', () => {
  const stale = [
    { ...checkpoint, version: 0 },
    { ...checkpoint, roomId: 'missingRoom' },
    { ...checkpoint, deadEnemies: ['missing-spawn'] },
    { ...checkpoint, openedChests: ['missing-chest'] },
    { ...checkpoint, equippedSlot: 0 },
    { ...checkpoint, playerHp: 0 },
    { ...checkpoint, gates: [{ corridorId: 'entry-corridor', wallRoomId: 'hub' }] },
  ];
  for (const value of stale) {
    const storage = memoryStorage();
    storage.setItem(CHECKPOINT_KEY, JSON.stringify({ ...value, version: value.version ?? 1 }));
    assert.equal(readCheckpoint(storage, WORLD_DATA), null, JSON.stringify(value).slice(0, 80));
  }
  const corrupt = memoryStorage();
  corrupt.setItem(CHECKPOINT_KEY, '{not json');
  assert.equal(readCheckpoint(corrupt, WORLD_DATA), null);
});

test('treats blocked storage as no checkpoint', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.equal(readCheckpoint(blocked, WORLD_DATA), null);
  assert.doesNotThrow(() => writeCheckpoint(blocked, checkpoint));
  assert.doesNotThrow(() => clearCheckpoint(blocked));
  assert.equal(readCheckpoint(null, WORLD_DATA), null);
});
