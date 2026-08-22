# Handover — Optimization Pass, 2026-08-22

Status: checkpoint committed in PR #6; review fixes are applied in a follow-up commit.
Contact point for context: `docs/optimization-review.md` (full review trail:
original findings → follow-up review → verification → execution results).

---

## TL;DR

The repository did **not** need a rewrite. Three targeted changes were shipped
after profiling confirmed the real bottlenecks, followed by a review-fix pass:

1. Pooled dungeon lights — removes shader-recompile hitches on room entry.
2. Pooled burst particles — removes mid-combat allocation/GC churn.
3. Restored the 15-test suite as a safety net before touching anything.
4. Made profiling opt-in, corrected the scripted route, and covered the new
   light/pool contracts with tests.

The checkpoint profile recorded worst frame time falling from **78.6 ms →
19.4 ms**; those measurements predate the route fix and must be regenerated.
Tests now pass 19/19; production build remains green.

---

## What changed

The checkpoint runtime changes are in `src/main.js`; the follow-up adds the
browser-free contracts in `src/optimization-contracts.js` and focused tests in
`tests/optimization-contracts.test.mjs`. No gameplay constants, no
`world.json` edits, no visual changes.

| Change | Where | Why |
|---|---|---|
| Test suite restored | `tests/world-data.test.mjs`, `tests/crypt-wall-geometry.test.mjs` | Was missing from working tree; recovered from `refactor/optimize` branch (ancestor of main, zero src drift) |
| Profiling harness (opt-in) | `src/main.js`, `src/optimization-contracts.js` | Starts with no profile buffer; `__cryptRun()` lazily enables recording for the scripted walk, reports route failures, and disables recording when finished |
| chestBlockReason fix | `src/main.js` ~2312 | Was evaluating `livingEnemiesInBranch()` three times per seal-chest check |
| Pooled dungeon lights | `DUNGEON_LIGHT_POOL_SIZE` block (~line 805), `addRoomLight`, `updateZoneVisibility` | Room lights used to live inside zone groups; toggling group visibility changed the visible light count and forced shader program recompiles on every first room entry |
| Pooled burst particles | `BURST_POOL_SIZE` block (~line 2467), `updateEffects` | `spawnBurst` allocated geometry + one material per particle per burst, then disposed them mid-combat |
| Optimization contracts | `src/optimization-contracts.js`, `tests/optimization-contracts.test.mjs` | Browser-free tests cover inactive profiling, five-light capacity, route timeout failure, and pooled-slot reuse |

### How the light pool works

- 5 point lights (`DUNGEON_LIGHT_POOL_SIZE`) created once by
  `buildDungeonLightPool()` during `buildWorld()`, added to the dungeon scene
  root — never inside zone groups.
- `decorateRoom` no longer creates lights; it records recipes via
  `recordZoneLight(zoneId, { x, z, color, intensity })`.
- On every zone visibility change, `applyDungeonLights()` applies the union of
  recipes for currently visible zones to the pool.
- Unused slots park at `y = -50` with `intensity = 0`. They stay in the scene
  so three.js's visible-light count is constant → program cache stays warm.

The current map has at most five simultaneous room-light recipes: the hub's
four lights plus one adjacent room light. If a content change raises that
maximum, bump `DUNGEON_LIGHT_POOL_SIZE`; the recipe collector throws on an
overflow instead of silently dropping a visible light.

### How particle pooling works

- One shared sphere geometry (`burstGeometry`), ring buffer of 160 mesh
  entries (`acquireBurstMesh`). Each mesh keeps its own material because
  particles have randomized lifetimes and must fade independently.
- Expired particles set `visible = false` and return to the pool; nothing is
  disposed at runtime.
- The shared geometry has a single owner concept: it is created lazily and
  never disposed while the page lives (same lifetime as the renderer).

---

## Measured results

These are checkpoint measurements from headless Chrome (`--headless=new`, Metal
ANGLE, 1440×900), using the pre-fix scripted route town → entrance → hub → west
branch → east branch, ~11.8k frames/run. Regenerate them after the route fix
before treating them as current benchmark evidence.

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
recreate from this spec: launch headless Chrome with
`--remote-debugging-port`, navigate to the preview URL, wait for
`window.__gameReady === true`, set `window.__cryptProfile = null`, call
`window.__cryptRun()` (fire-and-forget — do NOT await it through CDP, it will
time out), poll `window.__cryptDone === true`, then dump
`JSON.stringify({ frames, zones, marks, error: window.__cryptError })`.

Instrumentation endpoints in `main.js`: `__cryptProfile` `{active, frames,
zones, marks}`, `__cryptMark(label)`, `__cryptWalkTarget` (auto-walk hook
patched into the player update loop), `__cryptDone`, and `__cryptError`. All
recording is inert until `__cryptRun()` activates the profile.

---

## Verification checklist (all passing at handover)

- [x] `npm test` — 19/19 pass (15 restored contracts + 4 optimization contracts)
- [x] `npm run build` — green, bundle ~795 KB JS (217 KB gzip)
- [x] Draw calls and program counts identical baseline vs after
- [x] `node --check src/main.js` and `git diff --check` — green
- [x] No changes to `src/world-data.js`, `src/data/world.json`,
      `src/crypt-wall-geometry.js`, `index.html`, `src/style.css`

## Known limitations / follow-ups

1. **Fresh browser measurements are pending.** The checkpoint numbers above
   were collected before the route correction; rerun the driver after the
   follow-up commit and replace the historic table only if the route completes
   and reports no `__cryptError`.
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
5. **The old CDP driver reported 0 zone events** even though the code path
   worked when invoked directly (verified manually). If that persists with the
   corrected driver, treat it as a `Runtime.evaluate` world/context quirk;
   segment stats around room-entry marks cover the same ground.
