// Canonical headless delve route, shared by tests/game-core.test.mjs and
// tools/crypt-headless.mjs so the walkthrough exists exactly once.
//
// Ordinary rooms are cleared through clearRoom(), an accelerated test
// affordance that stands in for room combat; the Warden itself is fought
// through semantic useAction() calls from outside every enemy's reach.

const WARDEN_ID = 'crypt-warden';
const KILL_LOOP_GUARD = 400;

export const DELVE_STEPS = [
  { type: 'talkTo', role: 'Hunter' },
  { type: 'tick', delta: 1.0 },

  // West branch.
  { type: 'openGate', corridorId: 'entry-corridor' },
  { type: 'moveTo', x: 0, z: 12.5 },
  { type: 'openGate', corridorId: 'west-corridor' },
  { type: 'moveTo', x: -26, z: 9 },
  { type: 'clearRoom', roomId: 'westGate' },
  { type: 'openGate', corridorId: 'west-deep-corridor' },
  { type: 'moveTo', x: -47, z: 9 },
  { type: 'clearRoom', roomId: 'westBurial' },
  { type: 'openGate', corridorId: 'west-drop' },
  { type: 'moveTo', x: -47, z: -13 },
  { type: 'clearRoom', roomId: 'westOssuary' },
  { type: 'interact', label: 'west seal' },

  // East branch.
  { type: 'openGate', corridorId: 'west-drop' },
  { type: 'moveTo', x: -47, z: 9 },
  { type: 'openGate', corridorId: 'west-deep-corridor' },
  { type: 'moveTo', x: -26, z: 9 },
  { type: 'openGate', corridorId: 'west-corridor' },
  { type: 'moveTo', x: 0, z: 12.5 },
  { type: 'openGate', corridorId: 'east-corridor' },
  { type: 'moveTo', x: 26, z: 9 },
  { type: 'clearRoom', roomId: 'eastGate' },
  { type: 'openGate', corridorId: 'east-deep-corridor' },
  { type: 'moveTo', x: 47, z: 9 },
  { type: 'clearRoom', roomId: 'eastFlooded' },
  { type: 'openGate', corridorId: 'east-drop' },
  { type: 'moveTo', x: 47, z: -12.5 },
  { type: 'clearRoom', roomId: 'eastReliquary' },
  { type: 'interact', label: 'east seal' },

  // North branch.
  { type: 'openGate', corridorId: 'east-drop' },
  { type: 'moveTo', x: 47, z: 9 },
  { type: 'openGate', corridorId: 'east-deep-corridor' },
  { type: 'moveTo', x: 26, z: 9 },
  { type: 'openGate', corridorId: 'east-corridor' },
  { type: 'moveTo', x: 0, z: -8 },
  { type: 'clearRoom', roomId: 'northHall' },
  { type: 'openGate', corridorId: 'archive-corridor' },
  { type: 'moveTo', x: 0, z: -27 },
  { type: 'clearRoom', roomId: 'northLibrary' },

  // The archive cache stays sealed while its acolytes stand, and the keep's
  // vanguard counts as a north-branch guardian — so the Warden falls first.
  { type: 'openGate', corridorId: 'warden-corridor' },
  { type: 'moveTo', x: 0, z: -36 },
  { type: 'kill', targetId: WARDEN_ID },
  { type: 'clearRoom', roomId: 'wardenKeep' },

  // Archive key on the way back through the library, spoils in the keep.
  { type: 'openGate', corridorId: 'warden-corridor' },
  { type: 'moveTo', x: 0, z: -27 },
  { type: 'interact', label: 'archive key' },
  { type: 'openGate', corridorId: 'warden-corridor' },
  { type: 'moveTo', x: 0, z: -40 },
  { type: 'moveTo', x: 0, z: -47.5 },
  { type: 'interact', label: "warden's spoils" },

  // Return to the entrance vault and finish at the southern exit.
  { type: 'openGate', corridorId: 'warden-corridor' },
  { type: 'moveTo', x: 0, z: -27 },
  { type: 'openGate', corridorId: 'archive-corridor' },
  { type: 'moveTo', x: 0, z: -8 },
  { type: 'openGate', corridorId: 'north-corridor' },
  { type: 'moveTo', x: 0, z: 12.5 },
  { type: 'openGate', corridorId: 'entry-corridor' },
  { type: 'moveTo', x: 0, z: 31.2 },
  { type: 'tick', delta: 0.1 },
];

function killWithFire(core, targetId) {
  // The guard counts simulation turns (cooldown ticks included), not swings.
  let turns = 0;
  while ((core.describe().enemies.find((enemy) => enemy.id === targetId)?.hp ?? 0) > 0) {
    const swing = core.useAction('fire', targetId);
    if (!swing.ok && swing.reason === 'cooldown') {
      core.tick(swing.remaining);
    } else if (!swing.ok) {
      throw new Error(`attack failed: ${swing.reason}`);
    }
    if ((turns += 1) > KILL_LOOP_GUARD) throw new Error(`${targetId} fight did not converge`);
  }
}

// Executes DELVE_STEPS against a fresh-or-restored core. `onStep` receives
// each completed step for logging; failures throw with the step description.
export function runDelve(core, { onStep } = {}) {
  for (const step of DELVE_STEPS) {
    switch (step.type) {
      case 'talkTo': {
        const outcome = core.talkTo(step.role);
        if (!outcome.ok) throw new Error(`talkTo ${step.role}: ${outcome.reason}`);
        break;
      }
      case 'openGate': {
        const outcome = core.openGate(step.corridorId);
        if (!outcome.ok) throw new Error(`gate ${step.corridorId}: ${outcome.reason}`);
        break;
      }
      case 'moveTo': {
        const outcome = core.moveTo(step.x, step.z);
        if (!outcome.ok) throw new Error(`moveTo(${step.x}, ${step.z}): ${outcome.reason}`);
        break;
      }
      case 'clearRoom':
        core.clearRoom(step.roomId);
        break;
      case 'interact': {
        const outcome = core.interact();
        if (!outcome.ok) throw new Error(`${step.label ?? 'interact'}: ${outcome.reason}`);
        break;
      }
      case 'kill':
        killWithFire(core, step.targetId);
        break;
      case 'tick':
        core.tick(step.delta);
        break;
      default:
        throw new Error(`Unknown delve step type: ${step.type}`);
    }
    onStep?.(step);
  }
  return core.describe();
}
