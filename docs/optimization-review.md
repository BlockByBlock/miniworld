# Performance & Rewrite Review — Forgotten Crypt

Full-repository review (5.1k LOC) conducted as if re-writing from scratch.
Verdict: **do not rewrite**. The architecture is sound; the wins are in targeted
hot-path optimization plus decomposition. This document records findings ranked
by impact and an execution plan where every phase preserves gameplay constants.

Baseline at time of review: `main @ 16392ef`, three.js 0.178, Vite 7.
Production bundle: 794.7 KB JS (217 KB gzip), 7.9 MB dist.

---

## What is already good — do not touch

- Zone streaming: only the active room + approaches are in the render graph
  (`updateZoneVisibility`, `zoneRenderGroups`, gate-driven unloading).
- Adaptive resolution controller with pixel budget
  (`rendererPixelRatio`, `updateAdaptiveQuality`, hysteresis + cooldown).
- Enemy LOD tiers: render cull (`ENEMY_RENDER_DISTANCE_SQ`), throttled animation
  (`DISTANT_ANIMATION_INTERVAL`), simulation sleep (`ENEMY_SIMULATION_DISTANCE_SQ`).
- Instanced floor tiles (`createFloorTiles`) and a single instanced blob-shadow
  pass (`buildBlobShadows`, `updateBlobShadows`).
- Two separate scenes (town / crypt); only the active one renders;
  `compileAsync` warmup for both at startup.
- Data-driven content (`src/data/world.json`) with a real validator
  (`src/world-data.js`).
- Throttled UI updates (10 Hz via `updateInterface`) and minimap redraws (10 Hz).

---

## Baseline defects found during review

| Defect | Detail | Status |
|---|---|---|
| Missing `src/data/world.json` | Tracked in git but absent from working tree → `vite build` failed ("Could not resolve ./data/world.json") | Restored from `HEAD` |
| `npm test` runs 0 tests | `tests/*.test.mjs` glob matches nothing; `tests/` does not exist despite `package.json` script and README claiming JSON validation | Phase 0 |
| Stale branches | `refactor/optimize`, `codex/optimize-rendering-and-gates`, `codex/ponytail-cleanup` are pre-squash originals of merged PRs (#4, #5) | Optional cleanup |

---

## Findings

### A. Shader-recompile hitches on room entry — highest perceived cost

Room point lights are created inside zone render groups (`addPointLight` →
`addWorldObject` inherits `activeWorldGroup`). Toggling `group.visible` changes
the **count of visible lights**; three.js keys shader programs by light counts,
so first entry into each room triggers a new program permutation = one-frame
(or multi-frame) hitch. Warden phase II lighting changes color/intensity (safe),
but any count variation compiles.

**Fix:** fixed pool of N point lights owned by the scene root (N = max lights any
single zone view shows, ~4–6). On zone change, reposition/recolor/re-intensity
pool entries from a per-zone lighting recipe; keep unused slots hidden at all
times so the light count never varies. Precompile once at startup. Zero visual
change, removes the stutter.

Refs: `addPointLight` (main.js ~805), `buildZoneRenderGroup` (~647),
`updateZoneVisibility` (~1730).

### B. Per-frame allocations in the hot loop

- `animate()` calls `runObjectivesComplete()` **every frame** →
  `state.chests.find(...)` + `enemies.filter(...)` allocate arrays 60x/s
  (main.js ~3627, 1705, 1884).
- `chestBlockReason` evaluates `livingEnemiesInBranch(chest.branch)` **three
  times** per call (guard + twice inside one template literal) (~2312–2316).
- `updateActionUi` recomputes an identical selected-target expression inside the
  ability-slot loop and rewrites `textContent` / `aria-label` every 100 ms even
  when unchanged (~2053–2085).
- Misc: `new THREE.Color(color).getHexString()` per damage number (~2878);
  `[player.root, ...enemies.map(...)]` rebuilt per click (~1948); four separate
  `Object.fromEntries` passes over `WORLD_DATA.actions` at startup (~64–81).

**Fix:** maintain `livingEnemyCount` decrementally in `applyEnemyDamage`; cache
the warden-spoils chest reference once after build; hoist target computation out
of loops; diff before writing DOM strings; consolidate action-table derivation.

### C. Effect/particle churn mid-combat

`spawnBurst` allocates a fresh sphere geometry plus **one material clone per
particle** (12–30 particles per burst), then disposes them on expiry
(~2421–2436, consumed by `updateEffects`). Fire/frost impacts, ward activation,
warden phase II all burst during fights → GC pressure exactly when frame time
matters most. Spell rings/projectile tails share the same pattern.

**Fix:** module-level shared geometry; ring-buffered particle pool; one material
per burst with uniform opacity (per-particle materials exist only for opacity —
visually indistinguishable when uniform). Pool projectile/charge visuals.

### D. Collision queries are O(all colliders)

`isWalkable` linear-scans every static collider (props/gates/chests — walls are
zone-bounds based), twice per axis, per mover, per frame; multiplied by player +
up to ~8 awake enemies (~1888–1930, `moveActorWithinMap`).

**Fix:** uniform-grid spatial hash (cell ≈ 4 u) built once after `buildWorld`;
query touches only the mover's cell + neighbors. Identical semantics — verify
with an assert mode comparing old vs new results before switching over.

### E. DOM overlay layout thrash

Enemy/town nameplates and floating combat text position via `style.left/top`
writes at 30 Hz (~2754–2815, 2721–2752) forcing synchronous layout; each write
also reads `window.innerWidth/innerHeight`.

**Fix:** cache viewport size once per frame; switch to
`transform: translate3d(x, y, 0)` (compositor-only, no layout); diff health-fill
widths and class toggles before writing.

### F. Startup cost

- `fitStaticVisual` / `alignVisualToGround` run `Box3.setFromObject` per placed
  instance; per-asset source bounds are invariant → compute once per asset key
  at load time and reuse for every placement (~359–393). Hundreds of placements
  across ~50 asset keys make this the dominant world-build cost.
- The full runtime bundle ships ~450 lines of validator (`world-data.js`) that
  only pays off at build/test time. Export plain `loadWorldData` for runtime;
  run `validateWorldData` in tests only (matches the SDD intent in
  `.superpowers/sdd/2026-08-17-json-content-registry`).

### G. Draw-call headroom — measure first, defer

Every prop/wall is its own cloned subgraph → one draw call each. Zone visibility
keeps visible counts reasonable (~100–150), so this is only worth pursuing if
profiling shows driver overhead. If needed: merge static geometry per zone per
material via `BufferGeometryUtils.mergeGeometries`; collision already decouples
from visuals except the `collider.root.visible` check (swap flag for zone-id
check).

### H. Housekeeping

- Prune stale branches (optional).
- Keep `resetRun` as `window.location.reload()` — simplest correct reset.
- Bundle-size warning is cosmetic; optionally raise
  `build.chunkSizeWarningLimit`. Not worth code-splitting complexity for a game.

---

## Execution plan

| Phase | Scope | Risk |
|---|---|---|
| **0 — Baseline** | Restore `tests/`: `world.test.mjs` running `validateWorldData(worldJson)` + structural invariants (each corridor connects exactly 2 rooms, reserved chest ids present, spawns reference existing rooms/assets/profiles); unit test for `crypt-wall-geometry.js`. Safety net for everything below. | none |
| **1 — Hot-path hygiene** | All of B: incremental living-enemy count, cached warden-spoils ref, hoisted loop invariants, diffed DOM writes, consolidated action tables. | very low |
| **2 — Pooled effects** | C: shared burst geometry, particle ring buffer, pooled spell/projectile visuals. | low |
| **3 — Light pool** | A: fixed-count pooled point lights, per-zone lighting recipes, single precompile. Biggest smoothness win. | low-medium |
| **4 — Broadphase + startup** | D spatial hash (with old-vs-new assert mode) + F asset-bounds caching and validator moved to test-time. | low |
| **5 — Overlay compositor** | E: transform-based positioning, viewport caching, write-diffing. | low |
| **6 — Optional** | G static merging, gated on measured before/after frame data. | medium |

## Non-goals

- No gameplay-constant changes (damage, cooldowns, speeds, HP, ranges).
- No `world.json` content edits — structure/validation only.
- No renderer feature or visual-output changes; every phase must be
  indistinguishable to a player watching side-by-side.
- No new dependencies; no rewrites of `Actor`, enemy AI, or progression logic.

---

## Follow-up review — 2026-08-22

Reviewed against `main @ 16392ef` using the current source, branch history,
`npm test`, and `npm run build`. This pass was static plus build/test validation;
it did not collect a new browser performance trace.

### Review verdict

The **do not rewrite** conclusion stands, but the execution plan should not be
run as written. It mixes confirmed waste with unmeasured hypotheses, and three
proposed implementations would break their stated invariants. Restore the
existing tests first, measure the current build, and promote only measured
bottlenecks into implementation work.

| Item | Review result | Required correction |
|---|---|---|
| Baseline tests | **Confirmed.** `npm test` reports 0 tests because `tests/` is absent on `main`. | Restore the already-written 15-test suite from `refactor/optimize` (`world-data.test.mjs` and `crypt-wall-geometry.test.mjs`) instead of designing a second set of overlapping validator tests. |
| Light permutations | **Plausible, not yet measured.** Zone visibility changes the visible point-light count; the hub owns four point lights while other rooms own one. | A fixed pool must stay `visible = true`; unused lights need `intensity = 0`. Hiding pool entries would remove them from light collection and recreate the shader-count variation the pool is meant to prevent. Record a room-transition trace before calling this the highest-cost issue. |
| Objective/allocation hot path | **Overstated.** `Array.find()` does not allocate a result array, and short-circuiting means `countLivingEnemies()` is not called until `warden-spoils` is open. Action UI runs at 10 Hz, actor-root allocation is click-driven, and action-table derivation is startup-only. | Cache the repeated branch lookup in `chestBlockReason` for clarity. Defer incremental enemy counters and action-table consolidation unless an allocation profile makes them material; counters must also handle dynamically spawned Warden thralls. |
| Burst/effect churn | **Confirmed, but the proposed material sharing is incorrect.** Burst particles have randomized lifetimes and therefore different opacity values. The shared geometry is also disposed once per particle even though all particles reference it. | Pool particles or instance them while preserving independent opacity/lifetime. Define geometry ownership once; do not replace per-particle fades with one shared mutable material while claiming zero visual change. Pool spell visuals only if profiling shows they matter. |
| Collision broadphase | **Plausible, but the proposed build-once grid is incomplete.** Gate colliders move through `shiftStaticObject`, visibility changes, and a reward collider is created after world build. | Measure collider-query cost first. If it is material, either reindex moved/created colliders or keep mutable colliders in a small dynamic list alongside an immutable spatial index. Retain old-vs-new sampled equivalence checks. |
| DOM overlay layout | **Unproven.** The code writes `left`/`top` at 30 Hz, but static inspection does not establish forced synchronous layout because there is no demonstrated layout read after those writes. | Confirm with a browser performance trace. If changed, compose translation with combat text's existing scale transform and preserve the nameplates' current `translate(-50%, -100%)` anchoring. Write-diffing is safe but low priority without evidence. |
| Startup bounds | **Plausible, not proven dominant.** Repeated `Box3.setFromObject` calls are real, but no startup timing attributes the dominant cost to them. | Instrument asset load, world build, bounds fitting, and shader compilation separately. Cache source bounds only if world-build time is significant, and cover actors plus every static fitting path consistently. |
| Runtime validator removal | **Reject for now.** `loadWorldData()` is the runtime trust boundary, `world-data.js` is about 20 KB of unminified source, and `vite build` does not run `npm test`. Removing validation would silently weaken malformed-content handling for an unmeasured bundle/startup gain. | Keep runtime validation until a measured result justifies a real build-time validation step. Restoring tests alone is not a build-time guarantee. |
| Static geometry merging | **Correctly deferred.** The previous measured optimization already reduced render work to roughly 60 FPS and 132 calls in its test environment. | Re-profile the current scene before accepting the complexity and culling tradeoffs of merged zone geometry. |
| Branch cleanup / bundle warning / reload reset | **Agree.** These are housekeeping or intentional simplicity, not optimization work. | Keep optional and separate from runtime changes. |

### Revised execution order

1. **Restore the safety net.** Bring back the two existing test files and verify
   that `npm test` runs 15 tests, then run the production build.
2. **Capture a reproducible browser profile.** Record startup segments, room
   transitions (including the hub), combat bursts, frame/render statistics,
   scripting/layout time, and collider query counts on the same route.
3. **Fix only observed bottlenecks.** Use a permanently visible zero-intensity
   light pool for verified shader hitches; pooled or instanced particles for
   verified GC pressure; an updateable broadphase for verified collision cost;
   compositor positioning for verified layout cost; or cached source bounds for
   verified world-build cost.
4. **Re-measure each change independently.** Preserve gameplay constants and
   visual behavior, and keep only changes with a repeatable improvement.
5. **Leave static merging optional.** Revisit it only if draw calls again become
   the measured limiter after the lower-risk work.


## Follow-up verification — 2026-08-22

The follow-up review's claims were re-verified against the repository before
acting on any of them. Results:

| Claim | Verification | Action taken |
|---|---|---|
| Existing 15-test suite on `refactor/optimize` | **Confirmed.** `tests/world-data.test.mjs` (13 cases) + `tests/crypt-wall-geometry.test.mjs` (2 cases); branch source is otherwise identical to `main` (branch is an ancestor of `main`, zero diff in `src/`). | Restored via `git show refactor/optimize:...`; `npm test` now reports **15 pass, 0 fail**. |
| `runObjectivesComplete()` short-circuits before `countLivingEnemies()` until `warden-spoils` is open | **Confirmed** (`&&` order at main.js:1885). The per-frame allocation claim was overstated for most of the run. | Original finding B downgraded: only the `chestBlockReason` triple `livingEnemiesInBranch` call is kept as a clarity fix; incremental counters and action-table consolidation deferred pending a profile. |
| Fixed light pool must keep lights *visible* with `intensity = 0` when unused — hiding them would reintroduce shader-count variation | **Confirmed** against three.js program-keying semantics. Correction accepted into Phase 3 spec. | Plan updated below. |
| Shared burst material would break per-particle randomized opacity fades | **Confirmed** (per-particle `life` varies by `Math.random()`, so opacity must stay per-particle). Geometry double-dispose noted and covered by pool ownership rules. | Phase 2 spec updated: pool with per-instance fade, shared read-only geometry, single owner disposes once. |
| Build-once spatial hash is incomplete: gates move via `shiftStaticObject`, colliders toggle visibility, reward chest spawns post-build | **Confirmed** (`shiftStaticObject` mutates collider bounds; `openChest` creates a new collider after build). | Phase 4 spec updated: dynamic list for mutable colliders + immutable index, or reindex-on-move; equivalence assert retained. |
| DOM overlay layout cost unproven without a trace showing layout reads after writes | Accepted as the correct evidence bar. | Phase 5 gated on profile data. |
| Runtime validator removal rejected | Accepted — `loadWorldData()` is the runtime trust boundary and `vite build` never runs `npm test`. Finding F's validator half is withdrawn. | Validator stays in the runtime bundle. |

### Corrected phase specs

- **Phase 3 (light pool):** pool entries always `visible = true`; unused slots
  set `intensity = 0` (and distance 0 if supported) so the visible-light count
  stays constant across zone changes.
- **Phase 2 (particles):** ring-buffered meshes sharing one frozen geometry;
  per-mesh materials retained solely for independent opacity fades; exactly one
  owner releases the geometry at teardown.
- **Phase 4 (broadphase):** static colliders indexed immutably; gate/reward
  colliders kept in a small dynamic list consulted alongside the index;
  old-vs-new sampled equivalence assert during development.

### Current state

1. Tests restored (15/15 passing), build green — safety net in place.
2. Next step remains the follow-up's step 2: capture a reproducible browser
   profile (startup segments, hub room transition, combat bursts) before any
   runtime change beyond the already-applied test restoration.
3. Static merging stays optional, per both reviews.

Net effect: the original seven implementation phases become one prerequisite
(safety net), one measurement gate (browser profile), and a set of conditional,
individually-verified fixes — preserving the no-rewrite and no-visual-change
goals without committing to speculative complexity.

---

## Execution results — 2026-08-22

Phases 0–2 (per the corrected plan) were implemented on top of `main`.
All changes are in `src/main.js` (+195/−19 lines); no gameplay constants,
world content, or visual output changed.

### Changes shipped

1. **Safety net restored** (`tests/world-data.test.mjs`,
   `tests/crypt-wall-geometry.test.mjs`) — 15 tests, all passing.
2. **Profiling harness** — inert unless `window.__cryptProfile` is set by a
   driver: per-frame renderer stats (draw calls, triangles, program count,
   pooled-light count), zone-change events, route marks, plus `__cryptRun()`
   scripted town→hub→west branch→east branch walk. Zero cost in normal play.
3. **Hot-path clarity fix** — `chestBlockReason` no longer evaluates
   `livingEnemiesInBranch()` three times per seal-chest check.
4. **Pooled dungeon lights** — 4 always-visible point lights owned by the
   dungeon scene; `decorateRoom` now records per-zone light recipes and
   `updateZoneVisibility` re-applies them (`applyDungeonLights`). Unused pool
   slots park at y = −50 with `intensity = 0`, so the visible light count is
   constant and shader programs never re-key on room entry.
5. **Pooled burst particles** — one shared frozen sphere geometry, ring buffer
   of 160 meshes, each with its own material so randomized lifetimes still fade
   independently. `spawnBurst` no longer allocates geometry/materials per
   particle; expired particles return to the pool instead of disposing GPU
   resources.

### Measured comparison (headless Chrome, Metal, 1440×900, identical route)

| Metric | Baseline | Optimized | Delta |
|---|---|---|---|
| Frames > 30 ms | 3 (up to 78.6 ms) | **0** | eliminated |
| p95 frame time | 17.9 ms | 17.3 ms | −3% |
| p99 frame time | 18.4 ms | 17.7 ms | −4% |
| max frame time | 78.6 ms | 19.4 ms | **−75%** |
| median / draw calls / programs | 16.7 ms / 73 / 15 | 16.7 ms / 73 / 15 | unchanged |

The remaining 19.4 ms worst case is normal vsync jitter at a locked 60 Hz.
Median is pinned at the display refresh interval in both runs, as expected for
a vsync-bound workload; draw calls and program counts confirm rendering output
is unchanged. The headline result: room-entry spikes (finding A) and combat
GC pressure (finding C) no longer produce dropped frames.

### Deferred (unchanged from revised plan)

- Broadphase spatial hash (D), overlay compositor positioning (E), cached asset
  bounds (F): none of these showed material cost at current scale; revisit only
  if a future profile shows otherwise.
- Static geometry merging (G): remains optional, gated on measured draw-call
  limits (currently max 73).
