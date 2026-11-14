import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Group, Scene, Vector3 } from 'three';
import { VisibilityGroup } from '../src/visibility-group.js';

test('skips hidden subtrees and refreshes their transforms when revealed', () => {
  const scene = new Scene();
  const root = new VisibilityGroup();
  const child = new Group();
  const bone = new Group();
  scene.add(root);
  root.add(child);
  child.add(bone);
  root.position.x = 2;
  child.position.x = 3;
  bone.position.x = 4;
  scene.updateMatrixWorld(true);
  const position = () => new Vector3().setFromMatrixPosition(bone.matrixWorld).x;
  assert.equal(position(), 9);

  root.visible = false;
  scene.position.x = 10;
  root.position.x = 5;
  child.position.x = 6;
  bone.position.x = 7;
  scene.updateMatrixWorld(true);
  assert.equal(position(), 9, 'hidden descendants must not be updated by the render traversal');

  root.visible = true;
  scene.updateMatrixWorld();
  assert.equal(position(), 28, 'revealed descendants must include every transform changed while hidden');

  root.visible = false;
  root.position.x = 8;
  assert.equal(bone.getWorldPosition(new Vector3()).x, 31, 'explicit world-position queries still refresh hidden actors');
});
