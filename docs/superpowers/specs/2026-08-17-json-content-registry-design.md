# Build-Time JSON Content Registry Design

## Goal

Reduce repeated content declarations in the Forgotten Crypt Three.js preview by moving stable game data into a source-controlled JSON registry that is imported at build time, while keeping rendering and gameplay behavior in JavaScript.

## Scope

The registry covers data that is already represented as records or parallel lookup tables in `src/main.js`:

- asset keys and root-absolute asset paths;
- player actions, action-bar keys, spell colors, and cast timings;
- item definitions;
- enemy combat profiles and spawn rows;
- rooms, corridors, and map bounds;
- dungeon chest rows;
- town static placements and NPC/patrol records.

The refactor does not introduce runtime configuration, a network fetch, a scene scripting language, arbitrary function names in JSON, or a new game engine. Unique room decoration rules remain in JavaScript because they contain one-off geometry, water materials, wall-relative torches, and room-specific loops rather than repeated records.

## Architecture

`src/data/world.json` is the single source of build-time content data. `src/world-data.js` statically imports the JSON, validates its structure and cross-references without importing Three.js or browser globals, then exposes normalized data and derived lookup maps for `src/main.js`.

The adapter owns only data concerns:

- `validateWorldData(raw)` rejects malformed or unsafe content;
- `loadWorldData(raw)` validates and returns normalized data;
- derived `Map`/`Set` values are created in JavaScript, not serialized in JSON.

`src/main.js` continues to own `THREE.Scene`, `THREE.Vector3`, scene groups, colliders, animation state, combat state machines, and progression behavior. Its builders consume validated records through the existing `createStatic()`, `createTownStatic()`, and `spawnActor()` paths so scene ownership and collision registration stay unchanged.

## JSON shape

The top-level object contains `version`, `assets`, `actions`, `items`, `enemyProfiles`, `rooms`, `corridors`, `enemySpawns`, `chests`, `town`, and `world` sections. IDs remain stable semantic keys used by progression and rendering code.

Content records use asset keys rather than raw URLs. The asset registry remains the only place that maps a content key to `/assets/...`; configuration records therefore cannot bypass the loader or introduce arbitrary filesystem paths.

Rooms store `id`, `label`, optional `branch`, `bounds`, `openings`, and the existing room metadata. Corridors store `id`, `bounds`, and their two connected room IDs. Enemy and chest records refer to rooms, profiles, and assets by ID. Town placement records contain asset key, position, rotation, fit dimensions, and optional collider dimensions; NPC records contain actor data and patrol waypoints.

JSON uses strict JSON values: decimal numbers or `#rrggbb` strings for colors, no JavaScript expressions, comments, trailing commas, `NaN`, `Infinity`, or hex literals.

## Validation contract

Validation occurs before asset loading and world construction. It must reject:

1. a non-object root, missing required sections, unknown section shapes, duplicate IDs, or unsupported `version`;
2. non-finite numbers, non-positive dimensions, invalid ranges, invalid enum values, or malformed positions/openings;
3. room openings outside the corresponding wall span;
4. corridors that do not reference exactly two rooms or do not geometrically connect those rooms;
5. missing asset, profile, room, action, or chest references;
6. invalid chest kind/branch combinations or missing semantic progression records;
7. asset paths containing `..`, paths outside `/assets/`, or paths that do not exist in `public/`.

Validation errors include the record path and the reason so a bad content edit fails clearly during startup/build checks rather than partially building a world.

## Behavior preservation

The migration preserves:

- the current five action-bar abilities and their HTML `data-ability` keys;
- asset loading before `buildWorld()` and the existing KTX2/Meshopt setup;
- mutually exclusive town/dungeon scene roots and Ranger Rowan's transition;
- map topology, gate placement, walkability, and collider registration;
- chest progression, branch seals, Archive key, Warden spoils, and enemy counts;
- combat timing, profile values, inventory semantics, and adaptive rendering behavior.

The current `exitPosition` coordinate mismatch is an independent existing gameplay defect. It is not changed by this design; it will be reported separately unless a later explicit fix is requested.

## Testing and verification

Add a browser-free `node:test` suite for `world-data.js` covering:

- the canonical JSON registry;
- duplicate IDs and missing references;
- invalid dimensions, ranges, openings, and corridor topology;
- invalid asset paths and missing public files;
- semantic progression records and normalized derived maps.

Run the suite with `node --test tests/world-data.test.mjs`. Also run `node --check src/main.js`, `npm run build` with an isolated output directory, and `git diff --check`. Perform a browser smoke pass that confirms loading, town rendering, Rowan's dungeon transition, one target/action, and one gate/chest interaction without 404s or console errors.

## Deliberate non-goals

- Runtime-editable configuration without a rebuild.
- A generic JSON command interpreter for arbitrary room decoration.
- New dependencies or a schema framework when a focused validator and Node's built-in test runner suffice.
- Moving scene objects, colliders, `Set`, `Map`, `Vector3`, or animation state into JSON.
