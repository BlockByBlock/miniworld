import { strict as assert } from 'node:assert';
import test from 'node:test';

import { createGameCore } from '../src/game/game-core.js';
import { runDelve } from '../src/game/delve-route.js';
import { loadWorldData, WORLD_DATA } from '../src/world-data.js';

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

test('retrying the hunter interaction preserves the pending departure', () => {
  const core = freshCore();
  assert.equal(core.talkTo('Hunter').ok, true);
  core.tick(0.8);
  assert.equal(core.describe().mode, 'town');
  assert.equal(core.talkTo('Hunter').reason, 'trail-pending');
  core.tick(0.1);
  assert.equal(core.describe().mode, 'dungeon');
  assert.equal(core.getEvents().filter(({ type }) => type === 'trail-offered').length, 1);
});

test('movement in town stops at the trail teleport', () => {
  const core = freshCore();
  core.moveTo(0, 12);
  assert.deepEqual(core.describe().discoveredRooms, ['entrance']);
  core.talkTo('Hunter');
  assert.equal(core.moveTo(7, 12).reason, 'scene-changed');
  const view = core.describe();
  assert.equal(view.room, 'entrance');
  assert.deepEqual([view.player.x, view.player.z], [0, 26.8]);
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
  assert.equal(outcome.reason, 'unreachable');
  assert.ok(core.describe().elapsed < 4);
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

  assert.equal(core.moveTo(16, 8).ok, true);
  assert.equal(core.openGate('west-corridor').code, 'crossing');
  assert.equal(core.moveTo(18.6, 9).ok, true);
  assert.equal(core.describe().room, 'hub');
  assert.equal(core.describe().gates.find((gate) => gate.corridorId === 'east-corridor').open, true);
  // The player can move alongside the destination wall beyond the corridor's edge.
  assert.equal(core.moveTo(18.99, 8).ok, true);
  assert.equal(core.moveTo(core.describe().player.x, 14.1).ok, true);
  assert.equal(core.describe().room, 'hub');
  assert.equal(core.openGate('west-corridor').code, 'crossing');
  assert.equal(core.moveTo(20, 14.1).ok, true);
  assert.equal(core.describe().room, 'eastGate');
  assert.equal(core.describe().gates.some((gate) => gate.open), false);
});

test('the Keep gate needs an Archive key that can be acquired before entering', () => {
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
  core.loadCheckpoint(checkpoint);
  assert.equal(core.openGate('warden-corridor').code, 'warded');
  core.clearRoom('northLibrary');
  assert.equal(core.openGate('warden-corridor').code, 'archive-key-required');
  assert.match(core.interact().reason, /acolytes stand/);

  core.clearRoom('northHall');
  assert.equal(core.interact().ok, true);
  assert.equal(core.describe().archiveKey, true);
  assert.equal(core.describe().enemies.find((enemy) => enemy.id === 'warden-vanguard').dead, false);
  assert.equal(core.openGate('warden-corridor').ok, true);
});

test('the north gate requires both seals and can be reached through interact', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.moveTo(4.3, 6);
  assert.equal(core.moveTo(4.3, -8).reason, 'unreachable');
  assert.equal(core.describe().room, 'hub');
  core.moveTo(0, 2.2);
  const checkpoint = core.saveCheckpoint();
  for (const branch of ['west', 'east']) {
    const oneSeal = structuredClone(checkpoint);
    oneSeal.state.seals[branch] = true;
    core.loadCheckpoint(oneSeal);
    assert.equal(core.interact().code, 'seals-required');
  }
  checkpoint.state.seals = { west: true, east: true };
  core.loadCheckpoint(checkpoint);
  assert.equal(core.interact().corridorId, 'north-corridor');
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
  const before = restored.saveCheckpoint();
  assert.throws(() => restored.loadCheckpoint({ state: checkpoint.state, events: [() => {}] }));
  assert.deepEqual(restored.saveCheckpoint(), before);
  assert.throws(() => restored.loadCheckpoint({ state: checkpoint.state, events: {} }), /Invalid checkpoint/);
  assert.throws(() => restored.loadCheckpoint({ state: { mode: 'dungeon' } }), /Invalid checkpoint/);
  assert.throws(() => restored.loadCheckpoint({
    ...checkpoint, state: { ...checkpoint.state, actionCooldowns: 42 },
  }), /Invalid checkpoint/);
  assert.deepEqual(restored.saveCheckpoint(), before);
  restored.loadCheckpoint(checkpoint);

  assert.deepEqual(restored.describe(), core.describe());
  // The restored run continues exactly where the original left off.
  core.clearRoom('westGate');
  restored.clearRoom('westGate');
  assert.equal(restored.openGate('west-deep-corridor').ok, true);
});

test('full delve: New Game to victory via the shared delve route', async () => {
  const core = freshCore();
  let exitApproach;
  runDelve(core, {
    onStep(step) {
      if (step.corridorId === 'entry-corridor' && core.describe().objectives.complete) {
        exitApproach = core.saveCheckpoint();
      }
    },
  });

  const view = core.describe();
  assert.equal(view.finished, true);
  assert.equal(view.objectives.complete, true);
  assert.equal(view.seals.west, true);
  assert.equal(view.seals.east, true);
  assert.equal(view.archiveKey, true);
  assert.equal(view.enemies.every((enemy) => enemy.dead), true);
  assert.ok(core.getEvents().some((event) => event.type === 'run-finished' && event.success));
  const completed = core.saveCheckpoint();

  core.loadCheckpoint(exitApproach);
  assert.equal(core.moveTo(-4, 30).ok, true);
  assert.equal(core.moveTo(-4, 32.4).ok, true);
  assert.equal(core.moveTo(4, 32.4).ok, true);
  assert.equal(core.describe().finished, true, 'crossing the exit en route wins');

  for (const milestone of ['west', 'east', 'archiveKey']) {
    const incomplete = structuredClone(exitApproach);
    if (milestone === 'archiveKey') incomplete.state.archiveKey = false;
    else incomplete.state.seals[milestone] = false;
    core.loadCheckpoint(incomplete);
    core.moveTo(0, 31.2);
    assert.equal(core.describe().finished, false, `victory requires ${milestone}`);
  }
  completed.state.seals.east = false;
  assert.throws(() => core.loadCheckpoint(completed), /Invalid checkpoint outcome/);
  assert.equal(core.describe().finished, false);
});

test('a blocked move stops in a living room and a defeated run rejects a room-clear retry', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.openGate('west-corridor');
  core.moveTo(-26, 9); // walk into westGate without clearing it
  assert.equal(core.moveTo(0, 9).reason, 'unreachable');
  assert.equal(core.describe().failed, false);
  let seconds = 0;
  while (!core.describe().failed && seconds < 600) {
    core.tick(1);
    seconds += 1;
  }
  const view = core.describe();
  assert.equal(view.failed, true);
  assert.equal(view.player.hp, 0);
  assert.ok(core.getEvents().some((event) => event.type === 'run-finished' && event.success === false));
  const terminal = core.saveCheckpoint();
  assert.equal(core.clearRoom('westGate').ok, false);
  assert.deepEqual(core.saveCheckpoint(), terminal);
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
  assert.ok(core.describe().enemies.filter((enemy) => enemy.roomId === 'westGate')
    .every((enemy) => enemy.dead && enemy.hp === 0));
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

test('subdividing a combat tick preserves hits and vitality', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.openGate('west-corridor');
  core.moveTo(-26, 9);
  const start = core.saveCheckpoint();
  for (let i = 0; i < 130; i += 1) core.tick(0.1);
  const hits = core.getEvents().slice(start.events.length);
  assert.ok(hits.some(({ type }) => type === 'player-damaged'));
  const hp = core.describe().player.hp;
  core.loadCheckpoint(start);
  for (let i = 0; i < 260; i += 1) core.tick(0.05);
  assert.deepEqual(core.getEvents().slice(start.events.length), hits);
  assert.equal(core.describe().player.hp, hp);
});

test('waiting the advertised relic cooldown makes the action ready', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.openGate('west-corridor');
  core.moveTo(-23, 9);
  const checkpoint = core.saveCheckpoint();
  checkpoint.state.inventory[0] = 'frostRune';
  core.loadCheckpoint(checkpoint);
  assert.equal(core.equip(0).ok, true);
  assert.equal(core.useAction('freeze', 'sepulcher-watch').ok, true);
  core.tick(0.05);
  const blocked = core.useAction('freeze', 'sepulcher-watch');
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(blocked.remaining, core.describe().player.cooldowns.freeze);
  core.tick(blocked.remaining);
  assert.equal(core.useAction('freeze', 'sepulcher-watch').ok, true);
});

test('invalid command arguments leave the headless run unchanged', () => {
  const core = freshCore();
  enterDungeon(core);
  core.openGate('entry-corridor');
  core.moveTo(0, 12.5);
  core.openGate('west-corridor');
  core.moveTo(-23, 9);
  const before = core.saveCheckpoint();
  assert.equal(core.moveTo(NaN, 9).reason, 'invalid-position');
  assert.equal(core.useAction('toString', 'sepulcher-watch').reason, 'unknown-action');
  assert.equal(core.tick(NaN).reason, 'invalid-delta');
  assert.deepEqual(core.saveCheckpoint(), before);
});

test('the walkthrough rejects a pickup that masks its expected seal', () => {
  const raw = structuredClone(WORLD_DATA.raw);
  raw.enemySpawns.find(({ id }) => id === 'sepulcher-fang').position = [-47, -13];
  const core = createGameCore({ worldData: loadWorldData(raw) });
  core.startNewGame();
  assert.throws(() => runDelve(core), /west seal.*expected chest west-seal, got loot/);
  assert.equal(core.describe().seals.west, false);
  assert.throws(() => runDelve(core), /fresh game/);
});
