import * as THREE from 'three';

// Loaded glTF assets keyed by the world registry's asset ids, plus the helpers
// that fit a cloned model to its intended footprint.
export const assets = new Map();

const tempBox = new THREE.Box3();
const tempSize = new THREE.Vector3();

export function alignVisualToGround(visual, desiredHeight) {
  visual.updateMatrixWorld(true);
  tempBox.setFromObject(visual);
  tempBox.getSize(tempSize);
  if (desiredHeight && tempSize.y > 0.001) {
    visual.scale.multiplyScalar(desiredHeight / tempSize.y);
    visual.updateMatrixWorld(true);
    tempBox.setFromObject(visual);
  }
  visual.position.y -= tempBox.min.y;
  visual.updateMatrixWorld(true);
}

export function fitStaticVisual(visual, { width, depth, height, stretch = false } = {}) {
  visual.updateMatrixWorld(true);
  tempBox.setFromObject(visual);
  tempBox.getSize(tempSize);
  const factors = [];
  if (width && tempSize.x > 0.001) factors.push(width / tempSize.x);
  if (depth && tempSize.z > 0.001) factors.push(depth / tempSize.z);
  if (height && tempSize.y > 0.001) factors.push(height / tempSize.y);
  if (factors.length) {
    if (stretch) {
      if (width && tempSize.x > 0.001) visual.scale.x *= width / tempSize.x;
      if (depth && tempSize.z > 0.001) visual.scale.z *= depth / tempSize.z;
      if (height && tempSize.y > 0.001) visual.scale.y *= height / tempSize.y;
    } else {
      visual.scale.multiplyScalar(Math.min(...factors));
    }
    visual.updateMatrixWorld(true);
    tempBox.setFromObject(visual);
  }
  visual.position.y -= tempBox.min.y;
  visual.updateMatrixWorld(true);
}
