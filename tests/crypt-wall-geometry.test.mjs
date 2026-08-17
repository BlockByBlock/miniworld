import { strict as assert } from 'node:assert';
import test from 'node:test';

import { brickWallDimensions } from '../src/crypt-wall-geometry.js';

test('keeps vertical brick wall length on the local width axis', () => {
  assert.deepEqual(brickWallDimensions({ horizontal: false, length: 12, thickness: 0.5 }), {
    width: 12,
    depth: 0.5,
    rotationY: Math.PI / 2,
  });
});
