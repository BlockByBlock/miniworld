// Canvas minimap for the village and crypt; returns the per-frame updater.
export function createMinimap({ canvas, world, townWorld, map, roomBranch, state, townNpcs, getPlayer }) {
  const context = canvas.getContext('2d');

  function minimapPoint(x, z) {
    const pad = 10;
    return {
      x: pad + ((x - world.minX) / (world.maxX - world.minX)) * (canvas.width - pad * 2),
      y: pad + ((z - world.minZ) / (world.maxZ - world.minZ)) * (canvas.height - pad * 2),
    };
  }

  function townMinimapPoint(x, z) {
    const pad = 10;
    return {
      x: pad + ((x - townWorld.minX) / (townWorld.maxX - townWorld.minX)) * (canvas.width - pad * 2),
      y: pad + ((z - townWorld.minZ) / (townWorld.maxZ - townWorld.minZ)) * (canvas.height - pad * 2),
    };
  }

  function drawMinimapZone(zone, fill, stroke, lineWidth = 1) {
    const first = minimapPoint(zone.minX, zone.minZ);
    const second = minimapPoint(zone.maxX, zone.maxZ);
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.lineWidth = lineWidth;
    context.fillRect(first.x, first.y, second.x - first.x, second.y - first.y);
    context.strokeRect(first.x, first.y, second.x - first.x, second.y - first.y);
  }

  return function updateMinimap(delta, force = false) {
    const player = getPlayer();
    state.minimapTimer -= delta;
    if (!force && state.minimapTimer > 0) return;
    state.minimapTimer = 0.1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#070912';
    context.fillRect(0, 0, canvas.width, canvas.height);

    if (state.mode === 'town') {
      const first = townMinimapPoint(townWorld.minX, townWorld.minZ);
      const second = townMinimapPoint(townWorld.maxX, townWorld.maxZ);
      context.fillStyle = 'rgba(63, 99, 70, 0.95)';
      context.fillRect(first.x, first.y, second.x - first.x, second.y - first.y);
      context.fillStyle = 'rgba(155, 130, 96, 0.9)';
      const roadStart = townMinimapPoint(-2.1, townWorld.minZ);
      const roadEnd = townMinimapPoint(2.1, townWorld.maxZ);
      context.fillRect(roadStart.x, roadStart.y, roadEnd.x - roadStart.x, roadEnd.y - roadStart.y);
      const crossStart = townMinimapPoint(townWorld.minX, 2.25);
      const crossEnd = townMinimapPoint(townWorld.maxX, 5.35);
      context.fillRect(crossStart.x, crossStart.y, crossEnd.x - crossStart.x, crossEnd.y - crossStart.y);
      for (const npc of townNpcs) {
        const point = townMinimapPoint(npc.root.position.x, npc.root.position.z);
        context.fillStyle = npc.role === 'Hunter' ? '#e7c16f' : '#b8a0e8';
        context.beginPath();
        context.arc(point.x, point.y, npc.role === 'Hunter' ? 3.4 : 2.6, 0, Math.PI * 2);
        context.fill();
      }
      const playerPoint = townMinimapPoint(player.root.position.x, player.root.position.z);
      context.fillStyle = '#fff5df';
      context.beginPath();
      context.arc(playerPoint.x, playerPoint.y, 3.6, 0, Math.PI * 2);
      context.fill();
      return;
    }

    for (const corridor of map.corridors) {
      drawMinimapZone(corridor, 'rgba(48, 47, 65, 0.8)', 'rgba(111, 103, 132, 0.36)');
    }
    for (const room of map.rooms) {
      const discovered = state.discoveredRooms.has(room.id);
      const branch = roomBranch[room.id];
      const fill = !discovered
        ? 'rgba(20, 22, 33, 0.9)'
        : branch === 'west'
          ? 'rgba(91, 66, 57, 0.92)'
          : branch === 'east'
            ? 'rgba(47, 75, 88, 0.92)'
            : branch === 'north'
              ? 'rgba(67, 54, 88, 0.92)'
              : 'rgba(62, 61, 81, 0.92)';
      const current = room.id === state.currentRoomId;
      drawMinimapZone(
        room,
        fill,
        current ? 'rgba(242, 218, 169, 0.95)' : discovered ? 'rgba(164, 150, 179, 0.65)' : 'rgba(71, 72, 87, 0.5)',
        current ? 2 : 1,
      );
    }

    for (const chest of state.chests) {
      if (chest.opened || !state.discoveredRooms.has(chest.roomId)) continue;
      const point = minimapPoint(chest.position.x, chest.position.z);
      context.fillStyle = chest.kind === 'seal' || chest.kind === 'archive' ? '#e7c16f' : '#9b8766';
      context.fillRect(point.x - 2.5, point.y - 2.5, 5, 5);
    }
    const playerPoint = minimapPoint(player.root.position.x, player.root.position.z);
    context.fillStyle = '#c9b2f0';
    context.strokeStyle = '#fff5df';
    context.lineWidth = 1.4;
    context.beginPath();
    context.arc(playerPoint.x, playerPoint.y, 4, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(playerPoint.x, playerPoint.y);
    context.lineTo(
      playerPoint.x + Math.sin(player.root.rotation.y) * 8,
      playerPoint.y + Math.cos(player.root.rotation.y) * 8,
    );
    context.stroke();
  };
}
