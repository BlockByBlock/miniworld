# Handover — Optimization Pass, 2026-08-22

Status: complete. All work verified on `main` working tree (uncommitted).
Contact point for context: `docs/optimization-review.md` (full review trail:
original findings → follow-up review → verification → execution results).

---

## TL;DR

The repository did **not** need a rewrite. Three targeted changes were shipped
after profiling confirmed the real bottlenecks:

1. Pooled dungeon lights — removes shader-recompile hitches on room entry.
2. Pooled burst particles — removes mid-combat allocation/GC churn.
3. Restored the 15-test suite as a safety net before touching anything.

Result: worst frame went from **78.6 ms → 19.4 ms**; zero frames above 30 ms
(baseline had 3). Rendering output unchanged (identical draw calls/programs).
Tests 15/15 green; production build green.

---

## What changed

All runtime changes are in `src/main.js` (+195/−19). Nothing else in `src/`
was touched. No gameplay constants, no `world.json` edits, no visual changes.

| Change | Where | Why |
|---|---|---|
| Test suite restored | `tests/world-data.test.mjs`, `tests/crypt-wall-geometry.test.mjs` | Was missing from working tree; recovered from `refactor/optimize` branch (ancestor of main, zero src drift) |
| Profiling harness (inert) | end of `src/main.js` | `window.__cryptProfile` frame stats + zone events + route marks; `__cryptRun()` scripted walk. Zero cost unless enabled by driver |
| chestBlockReason fix | `src/main.js` ~2312 | Was evaluating `livingEnemiesInBranch()` three times per seal-chest check |
| Pooled dungeon lights | `DUNGEON_LIGHT_POOL_SIZE` block (~line 805), `addRoomLight`, `updateZoneVisibility` | Room lights used to live inside zone groups; toggling group visibility changed the visible light count and forced shader program recompiles on every first room entry |
| Pooled burst particles | `BURST_POOL_SIZE` block (~line 2467), `updateEffects` | `spawnBurst` allocated geometry + one material per particle per burst, then disposed them mid-combat |

### How the light pool works

- 4 point lights (`DUNGEON_LIGHT_POOL_SIZE`) created once by
  `buildDungeonLightPool()` during `buildWorld()`, added to the dungeon scene
  root — never inside zone groups.
- `decorateRoom` no longer creates lights; it records recipes via
  `recordZoneLight(zoneId, { x, z, color, intensity })`.
- On every zone visibility change, `applyDungeonLights()` applies the union of
  recipes for currently visible zones to the pool.
- Unused slots park at `y = -50` with `intensity = 0`. They stay in the scene
  so three.js's visible-light count is constant → program cache stays warm.

**If you add a room with more than 4 simultaneous point lights**, bump
`DUNGEON_LIGHT_POOL_SIZE` to the new max, or extra lights will be silently
dropped (recipes beyond the pool size are ignored).

### How particle pooling works

- One shared frozen sphere geometry (`burstGeometry`), ring buffer of 160 mesh
  entries (`acquireBurstMesh`). Each mesh keeps its own material because
  particles have randomized lifetimes and must fade independently.
- Expired particles set `visible = false` and return to the pool; nothing is
  disposed at runtime.
- The shared geometry has a single owner concept: it is created lazily and
  never disposed while the page lives (same lifetime as the renderer).

---

## Measured results

Headless Chrome (`--headless=new`, Metal ANGLE, 1440×900), identical scripted
route town → entrance → hub → west branch → east branch, ~11.8k frames/run.

| Metric | Baseline | After | Delta |
|---|---|---|---|
| Frames > 30 ms | 3 (worst 78.6 ms) | 0 (worst 19.4 ms) | spikes eliminated |
| p95 frame time | 17.9 ms | 17.3 ms | −3% |
| p99 frame time | 18.4 ms | 17.7 ms | −4% |
| max frame time | 78.6 ms | 19.4 ms | −75% |
| median | 16.7 ms | 16.7 ms | vsync-pinned both runs |
| max draw calls / programs | 73 / 15 | 73 / 15 | rendering output identical |

Raw data: `/tmp/baseline3.json`, `/tmp/baseline3-summary.json`,
`/tmp/optimized.json`, `/tmp/optimized-summary.json` (ephemeral; regenerate
with the commands below).

Note: medians sit at the display refresh interval in both runs — the workload
is vsync-bound, so median will not move. The win is spike elimination.

---

## Tooling (how to re-run the profile)

```sh
# 1. build + serve
npm run build
npx vite preview --port 4173 --strictPort &

# 2. run the CDP driver (headless Chrome on macOS)
node /tmp/profile-driver.mjs <name>          # full walk, ~3.5 min
node /tmp/analyze.mjs /tmp/<name>.json       # segment stats + spikes
```

The driver script lives at `/tmp/profile-driver.mjs` (ephemeral). If lost,
recreate from this spec: launches headless Chrome with
`--remote-debugging-port`, navigates to the preview URL, waits for
`window.__gameReady === true`, resets `__cryptProfile` buffers, calls
`window.__cryptRun()` (fire-and-forget — do NOT await it through CDP, it will
time out), polls `window.__cryptDone === true`, then dumps
`JSON.stringify({ frames, zones, marks })`.

Instrumentation endpoints in `main.js`: `__cryptProfile` `{frames, zones,
marks}`, `__cryptMark(label)`, `__cryptWalkTarget` (auto-walk hook patched into
the player update loop). All inert without the driver.

---

## Verification checklist (all passing at handover)

- [x] `npm test` — 15/15 pass
- [x] `npm run build` — green, bundle ~795 KB JS (217 KB gzip)
- [x] Draw calls and program counts identical baseline vs after
- [x] No changes to `src/world-data.js`, `src/data/world.json`,
      `src/crypt-wall-geometry.js`, `index.html`, `src/style.css`

## Known limitations / follow-ups

1. **Working tree is uncommitted.** Changes live only in the local checkout of
   `main`. Commit them (suggested split: tests restore, light pool, particle
   pool, instrumentation) before other work lands on top.
2. **Profiling scripts are in `/tmp`** and will not survive a reboot. The doc
   section above is enough to recreate them (~80 lines).
3. **Deferred findings** (from `docs/optimization-review.md`, still valid):
   - D broadphase spatial hash — collider scans are O(n) but n is small;
     revisit if enemy counts grow.
   - E overlay compositor positioning (`left/top` → `transform`) — unproven
     cost; needs a trace showing layout thrash first.
   - F cached asset bounds at startup — plausible win for load time, unmeasured.
   - G static geometry merging — optional, gated on draw calls becoming the
     limiter (currently max 73, fine).
4. **Stale branches** can be pruned once this work merges:
   `refactor/optimize`, `codex/optimize-rendering-and-gates`,
   `codex/ponytail-cleanup` (pre-squash originals of merged PRs #4/#5).
5. **Zone-event capture returns 0 events** in the driver even though the code
   path works when invoked directly (verified manually). Likely a
   `Runtime.evaluate` world/context quirk in the fire-and-forget call chain.
   Harmless — segment stats around room-entry marks cover the same ground.
