import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createGameCore } from '../src/game/game-core.js';
import { runDelve } from '../src/game/delve-route.js';

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
  const chest = (kind, branch = null) => ({ kind, branch, roomId: 'hub', opened: false });
  // Each kind must block while its warding population stands.
  for (const kind of ['seal', 'archive', 'final', 'cache']) {
    const input = {
      chest: chest(kind, 'west'),
      enemies: [{ roomId: 'hub', profileKey: 'guard', dead: false }],
      roomBranch: { hub: kind === 'archive' ? 'north' : 'west' },
    };
    assert.match(
      evaluateChestBlock(input),
      /warded|sealed|bound|Clear this chamber/,
      `${kind} must stay blocked with guardians alive`,
    );
    input.enemies[0].dead = true;
    assert.equal(evaluateChestBlock(input), '');
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

test('closed gates block headless traversal until opened', () => {
  const core = freshCore();
  enterDungeon(core);
  // Straight shot at the warden keep with every gate still closed.
  const outcome = core.moveTo(0, -47.5);
  assert.equal(outcome.ok, false);
  assert.equal(core.describe().room, 'entrance');
  // Opening the first gate is what unlocks progression.
  assert.equal(core.openGate('entry-corridor').ok, true);
  assert.equal(core.moveTo(0, 12.5).ok, true);
  assert.equal(core.describe().room, 'hub');
});

test('switching gates reveals only the chosen room and closes after full entry', () => {
  const core = freshCore();
  enterDungeon(core);
  assert.equal(core.openGate('entry-corridor').ok, true);
  assert.equal(core.moveTo(0, 12.5).ok, true);
  assert.equal(core.openGate('west-corridor').ok, true);
  assert.equal(core.openGate('east-corridor').ok, true);

  const view = core.describe();
  assert.equal(view.gates.find((gate) => gate.corridorId === 'west-corridor').open, false);
  assert.ok(view.visibleZoneIds.includes('eastGate'));
  assert.ok(!view.visibleZoneIds.includes('westGate'));

  assert.equal(core.moveTo(18.6, 9).ok, true);
  assert.equal(core.describe().room, 'hub');
  assert.equal(core.describe().gates.find((gate) => gate.corridorId === 'east-corridor').open, true);
  assert.equal(core.moveTo(20, 9).ok, true);
  assert.equal(core.describe().room, 'eastGate');
  assert.equal(core.describe().gates.find((gate) => gate.corridorId === 'east-corridor').open, false);
});

test('Archive wards include northern guardians but exclude the Warden', () => {
  const core = freshCore();
  const checkpoint = core.saveCheckpoint();
  Object.assign(checkpoint.state, {
    mode: 'dungeon',
    playerX: 0,
    playerZ: -27,
    currentRoomId: 'northLibrary',
    currentZoneId: 'northLibrary',
    visibleZoneIds: ['northLibrary'],
  });
  for (const enemy of checkpoint.state.enemies) {
    enemy.dead = !['crypt-warden', 'warden-vanguard'].includes(enemy.id);
  }
  core.loadCheckpoint(checkpoint);
  assert.match(core.interact().reason, /acolytes stand/);

  checkpoint.state.enemies.find((enemy) => enemy.id === 'warden-vanguard').dead = true;
  core.loadCheckpoint(checkpoint);
  assert.equal(core.interact().ok, true);
  assert.equal(core.describe().archiveKey, true);
  assert.equal(core.describe().enemies.find((enemy) => enemy.id === 'crypt-warden').dead, false);
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
  core.openGate('west-corridor');
  core.moveTo(-26, 9);
  const checkpoint = core.saveCheckpoint();

  const restored = createGameCore();
  restored.startNewGame();
  restored.loadCheckpoint(checkpoint);

  assert.deepEqual(restored.describe(), core.describe());
  // The restored run continues exactly where the original left off.
  core.clearRoom('westGate');
  restored.clearRoom('westGate');
  assert.equal(restored.openGate('west-deep-corridor').ok, true);
});

test('full delve: New Game to victory via the shared delve route', async () => {
  const core = freshCore();
  runDelve(core); // includes the semantic New Game path: talkTo + trail tick

  const view = core.describe();
  assert.equal(view.finished, true);
  assert.equal(view.objectives.complete, true);
  assert.equal(view.seals.west, true);
  assert.equal(view.seals.east, true);
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

test('equip rejects consumables; consume drinks them', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.openGate('west-corridor');
  core.moveTo(-26, 9); // westGate: guardians alive
  assert.ok(core.tick(3)); // soak hits so there is vitality to restore
  const hpAfterHits = core.describe().player.hp;
  assert.ok(hpAfterHits < core.describe().player.maxHp);
  core.clearRoom('westGate'); // accelerated combat affordance stops the damage
  const draft = core.describe().loot.find((drop) => drop.itemId === 'healingDraft');
  assert.ok(draft, 'rusher should drop a healing draft');
  assert.equal(core.moveTo(draft.x, draft.z).ok, true);
  assert.equal(core.interact().kind, 'loot');
  const slot = core.describe().player.inventory.indexOf('healingDraft');
  assert.ok(slot >= 0);

  // Production drinks drafts; equipping one must be rejected.
  assert.equal(core.equip(slot).reason, 'not-equipment');
  const consumed = core.consume(slot);
  assert.equal(consumed.ok, true);
  assert.ok(consumed.restored > 0);
  assert.equal(core.describe().player.inventory[slot], null);
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
