import { strict as assert } from 'node:assert';
import test from 'node:test';

import { brickWallCornerRotation, brickWallDimensions } from '../src/crypt-wall-geometry.js';

test('keeps vertical brick wall length on the local width axis', () => {
  assert.deepEqual(brickWallDimensions({ horizontal: false, length: 12, thickness: 0.5 }), {
    width: 12,
    depth: 0.5,
    rotationY: Math.PI / 2,
  });
});

test('turns each brick corner into both room borders', () => {
  assert.deepEqual([
    brickWallCornerRotation({ west: true, north: true }),
    brickWallCornerRotation({ west: false, north: true }),
    brickWallCornerRotation({ west: false, north: false }),
    brickWallCornerRotation({ west: true, north: false }),
  ], [Math.PI / 2, 0, -Math.PI / 2, Math.PI]);
});
