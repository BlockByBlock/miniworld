import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createGameCore } from '../src/game/game-core.js';

function freshCore() {
  const core = createGameCore();
  core.startNewGame();
  return core;
}

function enterDungeon(core) {
  // Semantic path from New Game into the crypt, no keyboard/mouse involved.
  assert.equal(core.talkTo('Hunter').ok, true);
  core.tick(1.0);
  assert.equal(core.describe().mode, 'dungeon');
}

test('a new game starts in town with full health and empty packs', () => {
  const core = freshCore();
  const view = core.describe();
  assert.equal(view.mode, 'town');
  assert.equal(view.player.hp, view.player.maxHp);
  assert.deepEqual(view.player.inventory, Array(6).fill(null));
  assert.deepEqual(view.objectives, {
    westSeal: false,
    eastSeal: false,
    archiveKey: false,
    wardenRelicObtained: false,
    wardenSpoilsOpened: false,
    complete: false,
  });
});

test('talking to the hunter enters the dungeon after the trail delay', () => {
  const core = freshCore();
  const tooEarly = core.describe();
  assert.equal(tooEarly.mode, 'town');
  enterDungeon(core);
  assert.ok(core.getEvents().some((event) => event.type === 'dungeon-entered'));
});
test('evaluateChestBlock wards every kind on its resolved guardian count', async () => {
  const { evaluateChestBlock } = await import('../src/game/world-rules.js');
  const chest = (kind, branch = null) => ({ kind, branch, opened: false });
  // A wrong wiring (e.g. passing an unknown count key) resolves to 0 and
  // silently opens warded chests — each kind must block while guarded.
  for (const kind of ['seal', 'archive', 'final', 'cache']) {
    assert.match(
      evaluateChestBlock({ chest: chest(kind, 'west'), guardianCount: 2 }),
      /warded|sealed|bound|Clear this chamber/,
      `${kind} must stay blocked with guardians alive`,
    );
    assert.equal(evaluateChestBlock({ chest: chest(kind, 'west'), guardianCount: 0 }), '');
  }
});

test('gates refuse to open while their room holds living guardians', () => {
  const core = freshCore();
  enterDungeon(core);
  // entry-corridor opens from entrance, which has no spawns.
  assert.equal(core.openGate('entry-corridor').ok, true);
  assert.equal(core.moveTo(0, 10).ok, true); // hub has no spawns either
  assert.equal(core.openGate('west-corridor').ok, true);
  assert.equal(core.moveTo(-26, 9).ok, true); // westGate holds 4 guardians
  const blocked = core.openGate('west-deep-corridor');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /sealed by 4 remaining guardians/);
  core.clearRoom('westGate');
  assert.equal(core.openGate('west-deep-corridor').ok, true);
});

test('seal chests stay warded until their whole branch is cleared', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  // Walk the west branch room-by-room, clearing each chamber on the way.
  assert.equal(core.moveTo(0, 12.5).ok, true); // hub
  assert.equal(core.openGate('west-corridor').ok, true);
  assert.equal(core.moveTo(-26, 9).ok, true); // westGate
  core.clearRoom('westGate');
  assert.equal(core.openGate('west-deep-corridor').ok, true);
  assert.equal(core.moveTo(-47, 9).ok, true); // westBurial
  core.clearRoom('westBurial');
  assert.equal(core.openGate('west-drop').ok, true);
  assert.equal(core.moveTo(-47, -8).ok, true); // westOssuary
  core.clearRoom('westOssuary');

  // Too far from the chest to interact yet.
  assert.equal(core.interact().reason, 'nothing-nearby');
  assert.equal(core.moveTo(-47, -13).ok, true);
  const outcome = core.interact();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.kind, 'chest');
  const view = core.describe();
  assert.equal(view.seals.west, true);
  assert.ok(core.getEvents().some((event) => event.type === 'chest-opened' && event.chestId === 'west-seal'));
});

test('checkpoints restore an identical mid-run state', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.moveTo(-26, 9);
  const checkpoint = core.saveCheckpoint();

  const restored = createGameCore({ seed: 99 });
  restored.startNewGame();
  restored.loadCheckpoint(checkpoint);

  assert.deepEqual(restored.describe(), core.describe());
  // The restored run continues exactly where the original left off.
  core.clearRoom('westGate');
  restored.clearRoom('westGate');
  assert.equal(restored.openGate('west-deep-corridor').ok, true);
});

test('full delve: New Game to victory using only semantic actions', () => {
  const core = freshCore();
  enterDungeon(core); // talkTo('Hunter') + tick
  const open = (corridorId) => {
    const outcome = core.openGate(corridorId);
    assert.equal(outcome.ok, true, `gate ${corridorId}: ${outcome.reason}`);
  };
  const walk = (x, z) => {
    const outcome = core.moveTo(x, z);
    assert.equal(outcome.ok, true, `moveTo(${x}, ${z}): ${outcome.reason}`);
  };

  // West branch.
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
  assert.equal(core.interact().kind, 'chest'); // west-seal

  // East branch.
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
  assert.equal(core.interact().kind, 'chest'); // east-seal

  // North branch.
  walk(47, 9);
  open('east-deep-corridor');
  walk(26, 9);
  open('east-corridor');
  walk(0, -8);
  core.clearRoom('northHall');
  open('archive-corridor');
  walk(0, -27);
  core.clearRoom('northLibrary');
  // The archive cache stays sealed while its acolytes stand, and the keep's
  // vanguard counts as north-branch guardians — so the warden falls first.
  assert.equal(
    core.interact().reason,
    'The Archive cache remains sealed while its acolytes stand.',
  );
  open('warden-corridor');
  // Kite: stand just inside the keep, out of every enemy's attack range but
  // within firebolt range (8.5) of the warden.
  walk(0, -36);
  let guard = 0;
  while (core.describe().enemies.find((enemy) => enemy.id === 'crypt-warden')?.hp > 0) {
    const swing = core.useAction('fire', 'crypt-warden');
    if (!swing.ok && swing.reason === 'cooldown') core.tick(swing.remaining);
    else assert.equal(swing.ok, true, `attack failed: ${swing.reason}`);
    if (++guard > 400) assert.fail('warden fight did not converge');
  }
  core.clearRoom('wardenKeep');

  // With the whole north branch silent the archive key yields, then the
  // spoils chest opens back inside the keep.
  open('warden-corridor');
  walk(0, -27);
  assert.equal(core.interact().kind, 'chest'); // archive-key
  open('warden-corridor');
  walk(0, -40);
  walk(0, -47.5);
  assert.equal(core.interact().kind, 'chest'); // warden-spoils

  // Return to the entrance vault and finish at the exit.
  open('warden-corridor');
  walk(0, -27);
  open('archive-corridor');
  walk(0, -8);
  open('north-corridor');
  walk(0, 12.5);
  walk(0, 31.2);
  core.tick(0.1);

  const view = core.describe();
  assert.equal(view.archiveKey, true);
  assert.equal(view.enemies.every((enemy) => enemy.dead), true);
  assert.ok(core.getEvents().some((event) => event.type === 'run-finished' && event.success));
});

test('the loss path is exercisable: standing in a living room gets you killed', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.openGate('west-corridor');
  core.moveTo(-26, 9); // walk into westGate without clearing it
  let seconds = 0;
  while (!core.describe().failed && seconds < 600) {
    core.tick(1);
    seconds += 1;
  }
  const view = core.describe();
  assert.equal(view.failed, true);
  assert.equal(view.player.hp, 0);
  assert.ok(core.getEvents().some((event) => event.type === 'run-finished' && event.success === false));
});

test('replaying the same actions produces identical event logs', () => {
  const run = () => {
    const core = freshCore();
    enterDungeon(core);
    core.moveTo(0, 12.5);
    core.clearRoom('hub');
    return JSON.stringify(core.getEvents());
  };
  assert.equal(run(), run());
});

test('victory requires objectives complete AND standing at the exit', () => {
  const core = freshCore();
  enterDungeon(core);
  const view = core.describe();
  assert.equal(view.objectives.complete, false);
  core.tick(2.0);
  assert.equal(core.describe().finished, false);
});
