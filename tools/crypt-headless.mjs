#!/usr/bin/env node
// Headless agent runner for Forgotten Crypt.
//
// Drives the full game from New Game to victory through the shared delve
// route (src/game/delve-route.js) on the headless core — no browser, no
// rendering, no keyboard/mouse, no frame-rate dependence. Fully
// deterministic: the same commands always produce the same run.
//
// Ordinary rooms are cleared with clearRoom(), an accelerated test
// affordance that stands in for room combat; the Warden itself is fought
// through semantic useAction() calls.
//
// Usage:
//   node tools/crypt-headless.mjs [--quiet]

import { parseArgs } from 'node:util';
import { createGameCore } from '../src/game/game-core.js';
import { runDelve } from '../src/game/delve-route.js';

const { values } = parseArgs({
  options: {
    quiet: { type: 'boolean', default: false },
  },
});

const log = (...args) => { if (!values.quiet) console.log(...args); };

const core = createGameCore();
core.startNewGame();
const seenRooms = new Set();
runDelve(core, {
  onStep: (step) => {
    if (step.type === 'moveTo') {
      const room = core.describe().room;
      if (!seenRooms.has(room)) {
        seenRooms.add(room);
        log(`# entered ${room}`);
      }
    } else if (step.type === 'openGate') {
      log(`# gate ${step.corridorId} open`);
    } else if (step.type === 'kill') {
      log(`# warden down`);
    } else if (step.type === 'interact' && step.label) {
      log(`# ${step.label}`);
    }
  },
});

const view = core.describe();
const result = {
  finished: view.finished,
  objectives: view.objectives,
  elapsedSimSeconds: Number(view.elapsed.toFixed(1)),
  discoveredRooms: view.discoveredRooms.length,
  enemiesDefeated: view.enemies.filter((enemy) => enemy.dead).length,
  chestOpenings: view.openedChests,
  events: core.getEvents().length,
};

if (!result.finished) throw new Error('run did not finish');
console.log(JSON.stringify(result, null, 2));
