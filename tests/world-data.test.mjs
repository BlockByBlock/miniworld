import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import test from 'node:test';

import { loadWorldData, validateWorldData, WORLD_DATA } from '../src/world-data.js';

test('loads the canonical registry and derives runtime maps', () => {
  assert.equal(WORLD_DATA.rooms.length, 11);
  assert.equal(WORLD_DATA.corridors.length, 10);
  assert.equal(Object.keys(WORLD_DATA.assets).length, 52);
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
