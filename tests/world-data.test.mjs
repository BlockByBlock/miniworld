import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import test from 'node:test';

import { loadWorldData, validateWorldData, WORLD_DATA } from '../src/world-data.js';

test('loads the canonical registry and derives runtime maps', () => {
  assert.equal(WORLD_DATA.rooms.length, 11);
  assert.equal(WORLD_DATA.corridors.length, 10);
  assert.equal(Object.keys(WORLD_DATA.assets).length, 55);
  assert.deepEqual(
    Object.fromEntries(Object.entries(WORLD_DATA.assets).filter(([id]) => ['wall', 'wallCorner', 'banner'].includes(id))),
    {
      wall: '/assets/models/dungeon/wall.glb',
      wallCorner: '/assets/models/dungeon/wall_corner.glb',
      banner: '/assets/models/dungeon/banner_red.glb',
    },
  );
  assert.equal(Object.keys(WORLD_DATA.actions).length, 5);
  assert.equal(Object.keys(WORLD_DATA.items).length, 5);
  assert.equal(Object.keys(WORLD_DATA.enemyProfiles).length, 5);
  assert.equal(WORLD_DATA.enemySpawns.length, 36);
  assert.equal(WORLD_DATA.enemySpawns.filter(({ profileKey }) => profileKey === 'warden').length, 1);
  assert.equal(WORLD_DATA.chests.length, 7);
  assert.equal(WORLD_DATA.town.placements.length, 23);
  assert.equal(WORLD_DATA.town.npcs.length, 3);
  assert.equal(WORLD_DATA.roomById.get('wardenKeep').label, "Warden's Keep");
  assert.equal(WORLD_DATA.roomBranch.westOssuary, 'west');
  assert.equal(WORLD_DATA.actions.sword.keys[0], 'Digit1');
  assert.deepEqual(
    WORLD_DATA.map.rooms[0],
    { ...WORLD_DATA.raw.rooms[0].bounds, id: 'entrance', label: 'Entrance Vault', branch: null, openings: { north: [[-4, 4]] } },
  );
  assert.equal(WORLD_DATA.corridorById.get('entry-corridor').minZ, 18);
  assert.equal(Object.getPrototypeOf(WORLD_DATA.roomBranch), Object.prototype);
  assert.equal(loadWorldData(WORLD_DATA.raw).roomById instanceof Map, true);
});

test('exposes the runtime content contracts', () => {
  assert.deepEqual(Object.keys(WORLD_DATA.actions), ['sword', 'fire', 'freeze', 'heal', 'buff']);
  assert.deepEqual(Object.keys(WORLD_DATA.items), [
    'healingDraft',
    'ossuaryEdge',
    'emberCharm',
    'frostRune',
    'wardenRelic',
  ]);
  assert.equal(WORLD_DATA.enemySpawns.length, 36);
  assert.equal(WORLD_DATA.enemySpawns.filter(({ profileKey }) => profileKey === 'warden').length, 1);
  assert.equal(WORLD_DATA.enemySpawns.filter(({ name }) => name === 'Crypt Warden').length, 1);
  assert.equal(WORLD_DATA.chests.length, 7);
  assert.equal(WORLD_DATA.chests.some(({ id }) => id === 'warden-spoils'), true);
  assert.deepEqual(WORLD_DATA.town.npcs.map(({ name }) => name), [
    'Ranger Rowan',
    'Guard Elin',
    'Tinker Vale',
  ]);
});

test('rejects duplicate content IDs', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.rooms.push(structuredClone(copy.rooms[0]));
  assert.throws(() => validateWorldData(copy), /rooms.*duplicate.*entrance/i);
});

test('rejects missing cross-references', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.enemySpawns[0].profileKey = 'missing-profile';
  assert.throws(() => validateWorldData(copy), /enemySpawns\[0\].*profile/i);
});

test('rejects invalid corridor topology and geometry', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.corridors[0].connects = ['entrance'];
  assert.throws(() => validateWorldData(copy), /corridors\[0\].*exactly two/i);
});

test('rejects corridors with a third geometric room neighbor', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.rooms.push({
    id: 'third-room',
    label: 'Third Room',
    branch: null,
    bounds: { minX: -4, maxX: 4, minZ: 18, maxZ: 22 },
    openings: {},
  });
  assert.throws(() => validateWorldData(copy), /corridors\[0\].*geometric.*neighbor/i);
});

test('rejects malformed town placements', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.town.placements = null;
  assert.throws(() => validateWorldData(copy), /town\.placements.*array/i);
});

test('rejects malformed town NPCs', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  delete copy.town.npcs;
  assert.throws(() => validateWorldData(copy), /town\.npcs.*array/i);
});

test('rejects reserved progression chest mismatches', () => {
  const mismatches = [
    ['west-seal', 'branch', 'east'],
    ['east-seal', 'kind', 'cache'],
    ['archive-key', 'roomId', 'hub'],
    ['warden-spoils', 'branch', 'north'],
  ];
  for (const [id, field, value] of mismatches) {
    const copy = structuredClone(WORLD_DATA.raw);
    copy.chests.find((chest) => chest.id === id)[field] = value;
    assert.throws(() => validateWorldData(copy), new RegExp(`${id}.*${field}`, 'i'));
  }
});

test('rejects renamed reserved progression chests', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.chests.find((chest) => chest.id === 'west-seal').id = 'renamed-seal';
  assert.throws(() => validateWorldData(copy), /missing progression chest west-seal/i);
});

test('rejects unsafe or missing asset paths', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.assets.knight = '/assets/../secret.glb';
  assert.throws(() => validateWorldData(copy), /assets\.knight.*path/i);
});

test('all canonical asset files exist under public', () => {
  const publicAssetPaths = new Set();
  const collectFiles = (directory, prefix) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const assetPath = `${prefix}/${name}`;
      if (statSync(path).isDirectory()) collectFiles(path, assetPath);
      else if (statSync(path).isFile()) publicAssetPaths.add(assetPath.replaceAll('\\', '/'));
    }
  };
  collectFiles(fileURLToPath(new URL('../public/assets/', import.meta.url)), '/assets');
  validateWorldData(WORLD_DATA.raw, { assetPaths: publicAssetPaths });
});

test('rejects invalid geometry and missing progression records', () => {
  const copy = structuredClone(WORLD_DATA.raw);
  copy.rooms[0].bounds.maxX = copy.rooms[0].bounds.minX;
  copy.chests = copy.chests.filter(({ id }) => id !== 'warden-spoils');
  assert.throws(() => validateWorldData(copy), /rooms\[0\].*bounds|warden-spoils/i);
});
