#!/usr/bin/env node
// Headless agent runner for Forgotten Crypt.
//
// Drives the full game from New Game to victory through semantic actions on
// the headless core — no browser, no rendering, no keyboard/mouse, no
// frame-rate dependence. Fully deterministic: the same commands always
// produce the same run.
//
// One deliberate shortcut: ordinary rooms are cleared with clearRoom(), an
// accelerated test affordance that stands in for room combat. The warden
// itself is fought through semantic useAction() calls.
//
// Usage:
//   node tools/crypt-headless.mjs [--quiet]

import { parseArgs } from 'node:util';
import { createGameCore } from '../src/game/game-core.js';

const { values } = parseArgs({
  options: {
    quiet: { type: 'boolean', default: false },
  },
});

const log = (...args) => { if (!values.quiet) console.log(...args); };

const core = createGameCore();
core.startNewGame();
log('# new game');

// Semantic New Game path: talk to the hunter, let the trail timer run.
if (!core.talkTo('Hunter').ok) throw new Error('could not talk to Ranger Rowan');
core.tick(1.0);
log('# entered the crypt');

const open = (corridorId) => {
  const outcome = core.openGate(corridorId);
  if (!outcome.ok) throw new Error(`gate ${corridorId}: ${outcome.reason}`);
  log(`# gate ${corridorId} open`);
};
const walk = (x, z, label = '') => {
  const outcome = core.moveTo(x, z);
  if (!outcome.ok) throw new Error(`moveTo(${x}, ${z}): ${outcome.reason}`);
  const room = core.describe().room;
  if (room !== walk.lastRoom) {
    walk.lastRoom = room;
    log(`# entered ${room} ${label}`);
  }
};
walk.lastRoom = null;
const interact = (what) => {
  const outcome = core.interact();
  if (!outcome.ok) throw new Error(`${what}: ${outcome.reason}`);
  log(`# ${what}`);
};

// Checkpoint after entering: demonstrates controlled start states.
const entryCheckpoint = core.saveCheckpoint();

// West branch.
open('entry-corridor');
walk(0, 12.5);
open('west-corridor');
walk(-26, 9);
core.clearRoom('westGate');
open('west-deep-corridor');
walk(-47, 9);
core.clearRoom('westBurial');
open('west-drop');
walk(-47, -13);
core.clearRoom('westOssuary');
interact('west seal claimed');

// East branch (gates close behind each traversal — reopen as we go).
open('west-drop');
walk(-47, 9);
open('west-deep-corridor');
walk(-26, 9);
open('west-corridor');
walk(0, 12.5);
open('east-corridor');
walk(26, 9);
core.clearRoom('eastGate');
open('east-deep-corridor');
walk(47, 9);
core.clearRoom('eastFlooded');
open('east-drop');
walk(47, -12.5);
core.clearRoom('eastReliquary');
interact('east seal claimed');

// North branch.
open('east-drop');
walk(47, 9);
open('east-deep-corridor');
walk(26, 9);
open('east-corridor');
walk(0, -8);
core.clearRoom('northHall');
open('archive-corridor');
walk(0, -27);
core.clearRoom('northLibrary');

// The warden falls to semantic combat. The agent kites from the keep door:
// out of every enemy's attack range, within firebolt range. The archive
// cache stays sealed until the whole north branch is silent, so the key is
// collected after.
open('warden-corridor');
walk(0, -36);
let swings = 0;
while ((core.describe().enemies.find((enemy) => enemy.id === 'crypt-warden')?.hp ?? 0) > 0) {
  const swing = core.useAction('fire', 'crypt-warden');
  if (!swing.ok && swing.reason === 'cooldown') core.tick(swing.remaining);
  else if (!swing.ok) throw new Error(`attack failed: ${swing.reason}`);
  else swings += 1;
  if (swings > 400) throw new Error('warden fight did not converge');
}
log(`# warden down after ${swings} fire casts`);
core.clearRoom('wardenKeep');

open('warden-corridor');
walk(0, -27);
interact('archive key claimed'); // requires every north-branch guardian dead
open('warden-corridor');
walk(0, -40);
walk(0, -47.5);
interact("warden's spoils claimed");

// Return and win at the southern exit.
open('warden-corridor');
walk(0, -27);
open('archive-corridor');
walk(0, -8);
open('north-corridor');
walk(0, 12.5);
open('entry-corridor');
walk(0, 31.2);
core.tick(0.1);

const view = core.describe();
const result = {
  finished: view.finished,
  objectives: view.objectives,
  elapsedSimSeconds: Number(view.elapsed.toFixed(1)),
  discoveredRooms: view.discoveredRooms.length,
  enemiesDefeated: view.enemies.filter((enemy) => enemy.dead).length,
  chestOpenings: view.openedChests,
  events: core.getEvents().length,
  restoredFromEntryCheckpointWorks: (() => {
    const probe = createGameCore();
    probe.startNewGame();
    probe.loadCheckpoint(entryCheckpoint);
    return probe.describe().mode === 'dungeon' && !probe.describe().finished;
  })(),
};

if (!result.finished) throw new Error('run did not finish');
console.log(JSON.stringify(result, null, 2));
