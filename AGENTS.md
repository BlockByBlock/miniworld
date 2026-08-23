# AGENTS.md

Guidance for coding agents working in this repository.

## Commands

All scripts live in [package.json](./package.json): `npm run dev` (Vite dev server), `npm run build`, `npm test`, `npm run test:headless`.

## Architecture

One definition of each gameplay rule lives in [src/game/world-rules.js](./src/game/world-rules.js) and is imported by both consumers:

- **Rendered game** — [src/main.js](./src/main.js) owns rendering, animation, audio, input, and UI. It delegates gameplay decisions (gate/chest gating, rewards, damage math, win condition) to world-rules; keep it that way rather than re-deriving decisions inline.
- **Headless simulation** — [src/game/game-core.js](./src/game/game-core.js) runs the same rules on plain JS state with no THREE/DOM/timers. Tests drive it through semantic actions (`talkTo`, `moveTo`, `interact`, `openGate`, `useAction`, `equip`, `consume`) instead of keyboard/mouse input, advance time explicitly with `tick(delta)`, and read state via `describe()` / `getEvents()`.

When changing a gameplay rule, change it in world-rules and let both surfaces follow — never copy the decision into a second file.

## World content

Stable world data (rooms, corridors, enemies, chests, items, action stats) lives in [src/data/world.json](./src/data/world.json), loaded and schema-validated by [src/world-data.js](./src/world-data.js). New top-level sections or fields require validator and test updates alongside the data. Room decoration layouts are level data too: [src/game/room-decorations.js](./src/game/room-decorations.js), interpreted by `decorateRoom()` in main.js.

## Testing

- Unit/contract tests target the browser-free modules under `tests/` (`npm test`).
- The full New Game-to-victory delve route lives once as `DELVE_STEPS` in [src/game/delve-route.js](./src/game/delve-route.js); both `tests/game-core.test.mjs` and [tools/crypt-headless.mjs](./tools/crypt-headless.mjs) interpret it. Route changes are made there, not copied between consumers.
- `clearRoom()` on the core is an accelerated test affordance standing in for room combat; production-equivalent combat exists only through `useAction`.
- Rendering, animation, camera, and UI have no automated coverage — when touching presentation code in main.js, verify in-browser with `npm run dev`.

## Gotchas

- Gate traversal closes a gate only after the actor has *fully* entered the destination room (entry clearance inset, not center-crossing); both movement and progression depend on this ordering.
- Enemy profiles, spawn tables, chest wards, and objective order all come from world.json — check there before hardcoding a value.
