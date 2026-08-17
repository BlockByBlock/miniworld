export function brickWallDimensions({ horizontal, length, thickness }) {
  return {
    width: length,
    depth: thickness,
    rotationY: horizontal ? 0 : Math.PI / 2,
  };
}
