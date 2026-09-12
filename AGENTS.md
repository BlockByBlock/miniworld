# Forgotten Crypt

Three.js/Vite game with a rendered browser client and a deterministic headless
simulation. `README.md` describes the game and local setup.

## Gameplay and content contracts

- `src/game/world-rules.js` owns shared gameplay decisions: gate/chest gating,
  rewards, damage, and victory. Both the rendered game and headless simulation
  consume these rules; change the owning rule rather than duplicating it.
- `src/main.js` owns rendering, animation, audio, input, and UI.
  `src/game/game-core.js` operates on plain state without THREE, DOM, or timers.
  Headless actions are semantic (`talkTo`, `moveTo`, `interact`, `openGate`,
  `useAction`, `equip`, `consume`); advance time with `tick(delta)` and inspect
  results through `describe()` and `getEvents()`.
- `src/data/world.json` owns rooms, corridors, enemies, spawns, chests, wards,
  items, actions, and objective order. `src/world-data.js` loads and validates
  it. New sections or fields require corresponding validator and test changes.
- Room decorations are level data in `src/game/room-decorations.js`, interpreted
  by `decorateRoom()` in the rendered client.
- Gate traversal closes a gate only after the actor fully enters the destination
  room, using the entry clearance inset. Center-crossing is insufficient;
  movement and progression depend on this ordering.

## References by task

- Game behavior and local setup: the relevant `README.md` section.
- Full New Game-to-victory route: `DELVE_STEPS` in `src/game/delve-route.js`.
  Both `tests/game-core.test.mjs` and `tools/crypt-headless.mjs` interpret it;
  update the shared route when progression changes.
- Adding or replacing bundled assets: `ASSET_CREDITS.md` and
  `THIRD_PARTY_NOTICES.md`. Keep provenance and license records aligned with
  the assets included in the game.

## Validation and completion

Commands are defined in `package.json`:

- Implementation changes: run `npm test` and `npm run build`.
- Gameplay or progression changes: also run `npm run test:headless`.
- Rendering, animation, camera, input, or UI changes: inspect the affected flow
  in-browser with `npm run dev`; headless tests do not cover presentation.
- Documentation-only changes: run `git diff --check`.

`clearRoom()` accelerates tests by standing in for combat. It does not establish
combat parity; use `useAction` to exercise production-equivalent combat.

Complete authorized work through applicable validation and fixes for failures
caused by the change. Report remaining failures and coverage limits. Preserve
unrelated work; commit, push, deploy, or publish only when authorized.
