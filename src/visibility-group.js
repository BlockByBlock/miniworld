import { Group } from 'three';

export class VisibilityGroup extends Group {
  updateMatrixWorld(force) {
    // Three.js traverses invisible children during the scene's matrix update.
    if (this.visible) super.updateMatrixWorld(force);
  }
}
