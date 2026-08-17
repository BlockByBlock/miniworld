export function brickWallDimensions({ horizontal, length, thickness }) {
  return {
    width: length,
    depth: thickness,
    rotationY: horizontal ? 0 : Math.PI / 2,
  };
}

export function brickWallCornerRotation({ west, north }) {
  if (west) return north ? Math.PI / 2 : Math.PI;
  return north ? 0 : -Math.PI / 2;
}
