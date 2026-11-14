# Forgotten Crypt state-machine audit

Forgotten Crypt runs as a single-player Three.js game and as a synchronous headless simulation driven by semantic commands. Both use the same world data and share several gameplay decisions. The browser advances on animation frames, input events and wall-clock timers. The headless core advances through `tick()` and through steps inside `moveTo()`.

Reviewed commit `b8e9a4089412c90304c4d719346dd00ef7f6ffe8`. The issue writeups and their source links preserve the findings from that baseline. The transition tables below reflect the follow-up fixes.

## Ranked issues

P1 covers bypassing required progression or losing a run due to an invalid transition. P2 covers narrower gameplay, accessibility or tooling failures. P3 covers localized feedback failures. Issue numbers are local to this audit.

| Issue | Priority | Affected surface |
| --- | --- | --- |
| [1. Enforce the required progression](#1-enforce-the-required-progression) | P1 | Browser and headless |
| [2. Stop headless movement at simulation boundaries](#2-stop-headless-movement-at-simulation-boundaries) | P1 | Headless |
| [3. Keep gate closure consistent with traversal](#3-keep-gate-closure-consistent-with-traversal) | P2 | Browser and headless |
| [4. Freeze gameplay and HUD at the terminal transition](#4-freeze-gameplay-and-hud-at-the-terminal-transition) | P2 | Browser and headless test helper |
| [5. Route input according to focus and game mode](#5-route-input-according-to-focus-and-game-mode) | P2 | Browser |
| [6. Give each diagnostic run exclusive ownership](#6-give-each-diagnostic-run-exclusive-ownership) | P2 | Browser diagnostics |
| [7. Restore checkpoints atomically](#7-restore-checkpoints-atomically) | P2 | Headless |
| [8. Resolve the interaction the player or route intends](#8-resolve-the-interaction-the-player-or-route-intends) | P2 | Browser interaction rules and headless route |
| [9. Validate headless commands and stabilize timer stepping](#9-validate-headless-commands-and-stabilize-timer-stepping) | P2 | Headless |
| [10. Clear canceled ground telegraphs](#10-clear-canceled-ground-telegraphs) | P3 | Browser |
| [11. Show a startup error when WebGL is unavailable](#11-show-a-startup-error-when-webgl-is-unavailable) | P3 | Browser |

### 1. Enforce the required progression

**Evidence.** The HUD and README call for the two seals, the Archive key and the Warden's spoils. A fresh headless delve still won after omitting the three interactions for the seals and key. It returned `westSeal: false`, `eastSeal: false`, `archiveKey: false`, `wardenSpoilsOpened: true` and `complete: true`. In Chromium, using the test hooks to set up rooms and remove guardians, the normal `E` interaction opened the spoils while the HUD still said “Claim the twin branch seals.” The normal exit check then displayed “Delve complete” with only the spoils opened. The gate rule checks the current room's guardians. Victory checks the final chest and global living count. [Documented route](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/README.md#L46-L58), [gate and chest rules](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/world-rules.js#L20-L73), [completion rule](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/world-rules.js#L147-L151), [objective ladder](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2241-L2306).

**Fix.** Make the required milestones explicit in the shared rules and derive the HUD from them. If the Archive key is to unlock the Keep, make the key obtainable before entry. Its current ward includes the Keep's non-Warden guardians, so adding a key check to the gate alone would create a cycle. Keep the optional equipment drop distinct from opening the final reliquary in the HUD copy. Verify the order and the exit with each prerequisite individually absent. [Archive ward](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/world-rules.js#L61-L65), [Keep population](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/data/world.json#L351-L354), [final chest message](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3444-L3449).

### 2. Stop headless movement at simulation boundaries

- **Scene switch.** At New Game, call `talkTo('Hunter')` followed by `moveTo(7, 12)`. It returns success in the Bell Hub near `(6.762, 12)` with every gate closed. The log enters the hub in town, records the dungeon arrival at `(0, 26.8)`, then enters the hub again. `moveTo()` runs dungeon room detection in town and retains its local position after the trail timer teleports the authoritative position. [Movement loop](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L292-L321), [teleport](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L197-L210), [timer order](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L521-L532).
- **Blocked movement.** After entering the crypt, `moveTo(0, -47.5)` with the first gate shut returned `unreachable` after advancing **2,000 simulated seconds**. From Burial Hall at 93 HP, trying to move back to `(0, 9)` across the closed west gate kept advancing enemy attacks at the blocked edge. The player died at 76.2 s and the retry returned `run-over`. [Movement loop](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L292-L321), [enemy attack tick](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L538-L565).
- **Exit crossing.** From a real checkpoint with all objectives complete, walk to `(-4, 30)`, then `(-4, 32.4)`, then `(4, 32.4)`. The last move crossed the exit disk at its center and ended near `(3.728, 32.397)` with `finished: false`. Movement checks victory when it reaches the command destination. The browser checks during movement on each frame. [Headless movement and victory](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L292-L321), [browser frame](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3570-L3586).

**Fix.** Advance movement from the authoritative position, apply room tracking only in the crypt, and stop or explicitly replan when the scene changes. End a blocked command once its step makes no progress, with the actual position and time reached. Check victory at each dungeon step and report a successful terminal arrival distinctly from defeat.

### 3. Keep gate closure consistent with traversal

- **Browser guardian stranded across the gate.** In Chromium, positioned the player near the west gate using the test hook, then used normal movement and enemy AI. With the gate open, move into wake range, retreat toward the hub, let Sepulcher Watch follow to `x ≈ -15.27`, then run back into Burial Hall. At `x ≈ -19.65`, the gate closed behind the player. Five wall-clock seconds later the live Watch was still on the hub side of the closed gate at `x ≈ -17.02` with home room `westGate`. The gate checks this home room for guardians, and the Watch cannot walk through the closed collider. Ranged attacks can still reach across the gate, so this evidence establishes a stranded guardian and a movement blockade. [Player-only entry check](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L1792-L1826), [gate verdict](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2209-L2229), [enemy movement and leash](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3028-L3056), [home room](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/data/world.json#L319-L322).
- **Headless gate replacement mid-crossing.** From the hub, open `east-corridor`, `moveTo(16, 8)`, open `west-corridor`, then `moveTo(19.5, 8)`. The player enters `eastGate` through the now-closed east gate. The west gate stays open from the hub, revealing the hub and west branch from an unrelated room. A direct gate command checks the last fully entered room, which is still the hub in the east corridor. The closed-corridor exception lets movement continue to the destination, and room entry only closes a matching open gate. [Gate command](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L323-L346), [corridor exception](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L156-L170), [gate replacement and room entry](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/world-rules.js#L33-L47).

**Fix.** Preserve the full-entry clearance. Reject a competing gate open while the player is crossing. Keep guardians in a position that remains reachable from their encounter room, or return crossing guardians to that side when the gate closes. Verify both directions, retreat before full entry, and opening a different gate during traversal. [Room-entry contract](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/AGENTS.md#L21-L23), [shared room-entry decision](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/world-rules.js#L187-L201).

### 4. Freeze gameplay and HUD at the terminal transition

**Evidence.** A Chromium frame probe staged a legal overlap between Sepulcher Watch's melee windup and an in-flight Fire projectile. The melee reduced the player from 2 to 0 HP and `finishRun(false)` hid enemy nameplates. During that same frame, Fire reduced the Watch from 250 to 216 HP and the overlay pass showed two enemy nameplates again. The active-run guard is checked at the start of the frame. The headless `clearRoom()` helper also remains callable after defeat. With an ordinary failed Burial Hall run it appended four loot drops after `run-finished` and left the four dead guardians at their prior positive HP. Repeating a clear adds another `room-cleared` event while its drop guard prevents duplicates. [Browser terminal update](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3488-L3508), [frame order](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3565-L3624), [headless room clear](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L681-L690).

**Fix.** Once the browser commits a result, skip the remaining gameplay and combat HUD updates for that frame and retire pending combat visuals. Have the headless helper obey terminal state, set HP consistently with death and emit a clear event only for a real clear. Verify a same-frame lethal hit and projectile impact, and a room-clear retry after defeat.

### 5. Route input according to focus and game mode

- **Keyboard restart.** In Chromium, focus “Run it again” on the result screen and press Space. The page stays finished and shows “Select an enemy target first.” Enter on the same focused button restarts. The global Space branch prevents the button's native action and `attemptAttack()` writes feedback before checking the run phase. [Input handler](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3526-L3553), [attack fallback](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2947-L2955), [restart button](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/index.html#L110-L115).
- **Lost key release and overlapping pointers.** In a Chromium event probe, a movement key held on the game page survived a blur event and a release delivered elsewhere. The player moved another 1.68 units over the next 450 ms before the game received its own key-up. In a synthetic two-touch sequence, pointer 2 replaced pointer 1's starting position, and pointer 1's up cleared pointer 2's pending press. The input state has no blur reset or pointer ownership check. [Key storage](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3526-L3553), [pointer handlers](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3645-L3665).
- **Town cast.** On the ordinary browser page, pressing `5` with the action bar hidden activates Ward in town. A read-only probe observed Ward at 8 s, then found both its charge and impact still queued after the buff had expired. The charge's life stayed at 0.36 s because town skips the spell update loop. Entering the crypt also leaves the Ward timer and action cooldowns intact. [Mode UI](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L1708-L1718), [entry handoff](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L1733-L1759), [action acceptance](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2897-L2945), [town versus dungeon frame work](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3570-L3612).

**Fix.** Let focused buttons receive native activation, restrict game shortcuts to the relevant active phase, and clear movement state on focus loss. Track the pointer that owns a selection gesture. Apply the dungeon-only action guard to the keyboard and button paths, or run the complete spell lifecycle in town if town casting is intentional.

### 6. Give each diagnostic run exclusive ownership

- **Overlapping profiles.** On a ready `?e2e` page, start `__cryptRun(false)` and `__cryptRun(true)` in the same task and observe both promises. In Chromium, the first timed out while the second was pending. The first finalizer published `done: true`, disabled profile sampling and cleared the second run's walk target. The second then timed out too. A solo instant profile on a fresh `?e2e` page reached East Reliquary. On the ordinary page, a solo invocation timed out approaching Rowan because the auto-walk consumer exists only with `?e2e`. [Shared profile buffers and target](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3702-L3737), [finalizer and auto-walk](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3798-L3829).
- **Fast checkpoint retry and overlap.** The first click passed all assertions. A second click on the finished page created an uncollected draft and reported `lootCollected: false` because interaction was already terminal. Two clicks in the same JavaScript task created and collected two drafts before either run published a result. The final result still passed every assertion. Both invocations use the same live world, traversal counter and result slot. [Fast route setup](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3856-L3878), [frame waits and result publication](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3906-L3939), [command handlers](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3988-L4010).

**Fix.** Gate the mutating browser diagnostics on a ready, fresh session and reject overlaps before touching the world. Expose the profile command where its auto-walk consumer exists, or fail immediately with the prerequisite. Make retry instructions explicit. Verify double invocation, retry after both success and failure, and smoke reporting after a previous command.

### 7. Restore checkpoints atomically

**Evidence.** On a fresh town core, load a valid saved dungeon `state` with `events: [() => {}]`. `loadCheckpoint()` throws `DataCloneError` after replacing the state. `describe()` now reports dungeon while `getEvents()` still contains only `game-started`. Retry with the same state and `events: {}`. Loading reports success. The next `useAction('buff')` throws on `events.push` after setting the buff timer to 8 and before charging its cooldown. A missing state field also retains the previous run's value because the loader merges into the current object. [Checkpoint implementation](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L594-L603), [event log write](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L72-L75), [Ward transition](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L411-L429).

**Fix.** Clone and validate the complete candidate state and event array before committing either. Preserve the supported editable fixture use while rejecting incomplete or incompatible snapshots. Assert that a rejected restore preserves both prior values and that a retry with a valid snapshot restores both.

### 8. Resolve the interaction the player or route intends

- **Headless north gate.** From the hub, `moveTo(0, 2.2)` reached `z ≈ 2.167`. `interact()` returned `nothing-nearby` while `openGate('north-corridor')` succeeded and the player could enter Catacomb Crossing. The headless search uses the midpoint at `z = -1`, outside the 2.4 reach from the blocked hub side. The browser gate starts on the hub wall at `z = 2`. [Headless gate candidate](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L493-L516), [browser gate placement](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L1321-L1334), [north corridor bounds](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/data/world.json#L306-L316).
- **Failed pickup masks a nearby cache.** With six equipment items and no consumable in the canonical headless world, clear Drowned Gallery using the test affordance and approach `(48.6, 10)`. The cache and Gallery Acolyte's drop are both in reach. Two interactions returned `backpack-full` for the same drop. Moving to `(46, 10)` let the next interaction open the cache. Both adapters pick loot ahead of chests and terminate on a blocked pickup. [Headless candidate order](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L473-L518), [browser priority](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2311-L2317), [browser full-pack guard](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2137-L2145).
- **Route false success and retry.** In a validated world fixture with Sepulcher Fang at the west seal at `(-47, -13)`, `runDelve()` reported the seal step after picking up a draft and won with `westSeal: false`. It checks only `outcome.ok`. Calling it on a genuine restored dungeon checkpoint failed immediately with `talkTo Hunter: not-in-town`. Its entry comment allows a restored core and the executor always starts at step zero. [Route executor](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/delve-route.js#L101-L140).

**Fix.** Use a reachable gate approach point in headless interaction and let a usable chest or gate receive the interaction when a full bag prevents pickup. Keep the prompt aligned with that choice. Assert the expected kind and object on route steps. Require a fresh run for the full walkthrough or explicitly supply the next step for checkpoint continuation.

### 9. Validate headless commands and stabilize timer stepping

- **Clock partition.** From New Game, talk to Rowan, tick 1 s, open the entry gate, move to `(0, 12.5)`, open the west gate and move to `(-26, 9)`. From a checkpoint there at 9.3 s, ticking for 13 s in 0.1 s calls left 73 HP. Ticking for 13 s in 0.05 s calls left 78 HP. Each invocation consumes its own fractional slice. Attack cooldowns reset after the sampled hit, discarding the portion of the slice after the timer crossed zero. [Fixed-step claim and implementation](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L581-L592), [attack timer](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L538-L565).
- **Trail retry.** `talkTo('Hunter')`, `tick(0.8)`, repeat `talkTo('Hunter')`, then `tick(0.2)` left the player in town and logged two offers. The browser rejects repeats while its trail is pending. [Headless talk](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L267-L290), [browser talk](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L1761-L1769).
- **Invalid commands.** `tick(Infinity)` on a fresh town core never returned in a bounded child-process check. `moveTo(NaN, 12)` returned `unreachable` after advancing 2,000 s. In Burial Hall, `useAction('toString', 'sepulcher-watch')` returned success, logged zero damage and added a `NaN` cooldown under `toString`. The lookup admits inherited object properties. [Tick loop](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L581-L592), [move inputs](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L292-L321), [action lookup and commit](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/game/game-core.js#L386-L429).

**Fix.** Validate finite time and coordinates and require an own action ID before mutation. Make repeated trail interaction preserve the original pending transition. Define a caller-independent fixed-step policy with a retained remainder, or explicitly support variable steps and carry the time across attack deadlines. Test equal total time split across different caller intervals.

### 10. Clear canceled ground telegraphs

**Evidence.** In a controlled Chromium frame sequence, Frostbolt hit Dustbound Ringer before its Death Pulse deadline. The enemy became frozen for 6 s and its pending cast was cleared. The ground warning still had 0.20 s of life. Its callback correctly suppressed damage, but the ground marker continued warning the player after the cast bar cleared. Evade and death also invalidate ground attacks while their discs wait for expiry. [Frostbolt impact](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2612-L2644), [telegraph loop](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L2777-L2810), [ground-cast resolution guard](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3090-L3110).

**Fix.** Retire and dispose the warning when the owning attack is canceled. Use the existing attack identity to avoid canceling a newer cast. Verify Frostbolt cancellation, evade, and a lethal hit before impact.

### 11. Show a startup error when WebGL is unavailable

**Evidence.** With Chromium returning `null` for the WebGL2 context, the page raised “Error creating WebGL context.” The loading card stayed visible at “Preparing the lanterns” and readiness stayed false. Renderer creation runs at module scope, outside the startup handler that displays an error. [Initial loading card](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/index.html#L103-L108), [renderer construction](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L334-L361), [startup error handler](https://github.com/BlockByBlock/miniworld/blob/b8e9a4089412c90304c4d719346dd00ef7f6ffe8/src/main.js#L3674-L3699).

**Fix.** Include renderer initialization in the startup failure path and give the loading card a terminal error message for unavailable WebGL.

## Follow-up changes

| Issue | Behavior after the fix |
| --- | --- |
| 1 | Both branch seals open the northern route. The Archive key opens the Keep. The southern exit requires the seals, key, spoils and zero living guardians. |
| 2 | A headless move stops at the scene handoff, the blocked edge or the first winning exit step. |
| 3 | A crossing keeps its gate until full entry. Browser guardians that would be stranded return to their side with current vitality. |
| 4 | Victory and defeat retire pending combat and freeze gameplay and combat HUD. Headless room-clear retries preserve terminal state. |
| 5 | Space activates focused controls, blur clears movement, selection tracks the initiating pointer and combat shortcuts require the dungeon. |
| 6 | The browser permits one diagnostic at a time. The fast checkpoint and profiler require a fresh town session. |
| 7 | Restore validates a cloned candidate before replacing either the state or the event log. |
| 8 | A full backpack leaves usable gates and chests available. Headless interaction finds gates at their room wall, and the walkthrough verifies each chest ID. |
| 9 | Headless time retains partial steps, pending trail interaction preserves the original departure, and invalid action or time inputs leave the core unchanged. |
| 10 | Canceled ground casts dispose of their warning before it can resolve. |
| 11 | A failed WebGL startup displays a loading error. |

## State machines

### Boot, scene and run outcome

**State.** `mode` has explicit values `town` and `dungeon`. Readiness, pending entry, activity and outcome are represented by `loaded`, `teleporting` or `trailTimer`, `started`, browser `combatStarted`, and the `finished` and `failed` flags. The headless core is usable immediately. Browser startup spans sequential asset loads, world construction and two scene compiles. [Browser state](../src/main.js#L148-L191), [browser startup](../src/main.js#L3566-L3580), [headless state](../src/game/game-core.js#L82-L143).

**Invariants.** The town and dungeon have separate bounds and only the active scene renders. A pending trail belongs to the town session. Entering the crypt puts the player in the Entrance Vault and resets discovery. `started` and `combatStarted` indicate activity and enemy activation. The run is active until one outcome flag is set. Defeat requires zero player HP. The terminal result is stable until restart or a headless restore. See issues [2](#2-stop-headless-movement-at-simulation-boundaries), [4](#4-freeze-gameplay-and-hud-at-the-terminal-transition), [5](#5-route-input-according-to-focus-and-game-mode), [9](#9-validate-headless-commands-and-stabilize-timer-stepping) and [11](#11-show-a-startup-error-when-webgl-is-unavailable).

| From | Event and guard | To and effects |
| --- | --- | --- |
| Browser module setup | Renderer created and startup starts | Loading assets, then building and compiling the world |
| Loading or compiling | All assets and compiles succeed | Ready in town. The loading card hides after 420 ms |
| Renderer setup, loading or compiling | Startup fails | Loading card displays the WebGL or asset error |
| Town ready | Talk to a non-Hunter NPC | Town ready with transient dialogue |
| Town ready | Interact with Rowan within reach | Trail pending for about 0.9 s. Browser schedules a timeout. Headless arms a timer |
| Trail pending | Repeat the interaction | Original deadline stays in place. Headless returns `trail-pending` |
| Trail pending | Timer expires | Dungeon entrance at `(0, 26.8)`. Reset entry and discovery state. Browser reparents the player and resets the camera |
| Dungeon active | Movement input or an accepted offensive action in the browser | `started` and `combatStarted` true. Interaction, target selection and self-casts can set `started` independently |
| Dungeon active | Shared completion predicate and distance to exit strictly below 2.4 | `finished = true`. Browser shows the win card. Headless records success |
| Dungeon active | Unabsorbed damage reduces HP to zero | `failed = true`. Browser shows the defeat card. Headless records failure |
| Terminal | Browser restart button or headless `startNewGame()` | Browser reloads. Headless replaces state and clears the event log |

Sources for the entry and terminal transitions. [Browser entry](../src/main.js#L1732-L1774), [outcome and restart](../src/main.js#L3525-L3568), [browser frame](../src/main.js#L3631-L3708), [headless entry and reset](../src/game/game-core.js#L205-L221), [headless talk](../src/game/game-core.js#L272-L303), [headless timers and outcome](../src/game/game-core.js#L566-L644).

### Movement, gates, room entry and visibility

**State.** Position and `currentZoneId` describe where the player is. `currentRoomId` is the last room fully entered. An open gate has directional `fromRoomId` and `toRoomId`. The browser also tracks the gate's wall position, two wall frames and collider visibility. Discovery is a set in the browser and a deduplicated array in headless.

**Invariants.** At most one gate is open and its endpoints are distinct connected rooms. Closed gates have null traversal endpoints. A corridor crossing keeps the source as the active room until the player reaches the 1.1-unit inset of the destination. Ordinary movement into a different room requires the connecting gate. The visible set contains the active room, its adjacent corridors and the open gate's connected rooms. Visibility drives render groups, lights, loot activity and enemy eligibility. See issues [2](#2-stop-headless-movement-at-simulation-boundaries), [3](#3-keep-gate-closure-consistent-with-traversal) and [8](#8-resolve-the-interaction-the-player-or-route-intends).

| From | Event and guard | To and effects |
| --- | --- | --- |
| In a scene | Attempt an axis step | Clamp to scene bounds. Accept each axis that passes bounds, clearance and collision checks. A blocked axis retains its coordinate |
| Gate closed | Request open from a connected room with no living guardians assigned there and any required seals or key | Gate opens toward the other room. Browser moves its hidden assembly to the destination wall. Both sides refresh visibility |
| Gate closed or already open | Request with wrong room, living guardians, missing prerequisite, missing gate or existing open state | Verdict rejects the request. No gate state change |
| One gate open | Another gate is successfully opened | First gate closes and clears its endpoints. Browser remounts it at its source |
| Open gate, source room active | Player moves into corridor or enters the destination before full clearance | Zone may change. Source remains the current room and gate remains open |
| Crossing | Request to open a different gate | Reject with `crossing` |
| Crossing | Player retreats into source | Source remains active and the gate stays open |
| Crossing | Player reaches the destination inset | Record destination room and discovery. Return browser guardians caught on the wrong side. Close the traversed gate and recompute visibility |
| Render group hidden or visible | Visible set changes | Toggle group and update pooled lights. Hidden groups skip matrix updates. Headless keeps the visible IDs for eligibility |

[Movement and collision checks](../src/movement-contracts.js#L36-L77), [shared gate verdict and replacement](../src/game/world-rules.js#L19-L82), [visibility and room-entry rules](../src/game/world-rules.js#L205-L236), [browser gate build](../src/main.js#L1451-L1506), [browser transition](../src/main.js#L1809-L1848), [headless movement and gate action](../src/game/game-core.js#L305-L369), [visibility group](../src/visibility-group.js#L1-L8).

### Objectives, chests, loot and equipment

**State.** Chest state is `opened` plus a ward decision derived from living enemies. A guardian death can create one drop. Drops are uncollected or collected. Each of six slots is empty, holds a consumable or holds equipment. `equippedSlot` is null or points to one equipment slot. Seals, key and final chest are progression milestones. The Warden Relic equipment is a separate drop.

**Invariants.** A chest opens and pays its rewards at most once per run. `openedChests` counts opened chests. A pickup fills a single empty slot. A failed pickup preserves the drop. A draft is consumed only if it can heal. Equipment remains in its slot when toggled. The required route should agree with the HUD and with the final predicate. A repeated interaction can select a different object after success because the previous one leaves the candidate set. See issues [1](#1-enforce-the-required-progression) and [8](#8-resolve-the-interaction-the-player-or-route-intends).

| From | Event and guard | To and effects |
| --- | --- | --- |
| Dungeon active | Interact with a nearby candidate | Check nearby loot, then chests, then gates. If the backpack is full, try a usable chest or gate before reporting failed pickup |
| Closed seal chest | Open with all assigned branch guardians dead | Mark opened, claim its seal, heal up to 25 HP |
| Closed Archive cache | Open with Catacomb Crossing and Silent Archive guardians dead | Mark opened and set `archiveKey` |
| Closed room cache | Open with that room's guardians dead | Mark opened, heal up to 12 HP and reduce action cooldowns by up to 1.5 s |
| Closed Warden's spoils | Open with the Keep's guardians dead | Mark opened. This supplies the final-chest flag used by victory |
| Warded or already opened | Open attempt | Reward state stays as it was. In the browser, a blocked ward produces feedback |
| Uncollected loot | Interact in range with a free slot | Set collected, write the item to the first empty slot and retire the browser visual |
| Uncollected loot | Interact with full backpack | Keep the drop and inventory. A repeat can select the same drop |
| Equipment in slot | Use a valid slot | Equip or replace the current relic. Use the same slot again to unequip |
| Draft in slot | Use below full HP | Heal up to 30 HP and clear the slot. At full HP the item stays |

The browser objective table selects the first matching row on each HUD update. Its ordering is explicit.

| First matching condition | HUD stage |
| --- | --- |
| In town | Find the hunter |
| Victory or defeat | Delve complete or The crypt wins |
| Dungeon activity has yet to start | Enter the crypt |
| Either seal missing | Claim the twin branch seals |
| Archive key missing and its guardians alive | Cross the Silent Archive |
| Archive key missing | Claim the Archive key |
| Keep guardian alive | Defeat the Crypt Warden |
| Spoils closed | Claim the Warden's spoils |
| Remaining cases | Return to the entrance |

The victory predicate requires the seals, key, open spoils chest, zero living guardians and the exit. The HUD uses the same seal check and Archive guardian scope. [Chest wards, rewards and drop selection](../src/game/world-rules.js#L84-L144), [victory inputs](../src/game/world-rules.js#L182-L186), [objective table and HUD](../src/main.js#L2271-L2336), [browser interaction commit](../src/main.js#L3459-L3523), [headless chest and inventory operations](../src/game/game-core.js#L371-L401), [headless equipment and interactions](../src/game/game-core.js#L462-L564).

### Browser input, targeting, action and Ward

**State.** Input uses a set of held movement keys and one `pointerPress` record. The selection is empty, self or an accessible living enemy. A pending action has an action ID, a timer and, for attacks, its own target reference. Global recovery and per-ability cooldowns run independently. A Fire or Frostbolt cast can launch a separate projectile. Ward is inactive or active with a remaining duration. The sword can be sheathed or drawn.

**Invariants.** A cast owns its target from acceptance through resolution. Per-ability cooldown and global recovery must permit a new action. HP stays between zero and max HP. Ward absorbs damage while active. Movement is relative to the camera and locked during an attack lock. A terminal run should accept no gameplay input or pending combat. See issues [4](#4-freeze-gameplay-and-hud-at-the-terminal-transition) and [5](#5-route-input-according-to-focus-and-game-mode).

| From | Event and guard | To and effects |
| --- | --- | --- |
| Movement key up | WASD or arrow keydown | Add held key and set activity flags. A frame converts held keys to camera-relative motion when the player is unlocked |
| Movement key down | Keyup, window blur or hidden document | Clear the released key or the full input state |
| No pending pointer press | Left pointer down on canvas | Store screen position and time |
| Pointer press recorded | Owning pointer up within 8 px and under 500 ms | Raycast and select a valid actor, or clear selection. A drag, long press or cancellation clears the gesture |
| Selected | Escape, empty click, death, inaccessibility or run result | Clear selection and target marker. A running cast still holds its original target |
| Action ready | Active dungeon, valid target and range for attack or valid self-action, and recovery and cooldown ready | Arm the windup, set lock and cooldowns, and start animation and spell visuals |
| Windup | Timer expires | Sword hits a living target still in range. Fire and Frostbolt launch on the same check. Heal or Ward resolves on the player |
| Projectile in flight | Travel completes | Remove projectile. Fire damages a living target. Frostbolt damages, freezes and cancels its pending attack |
| Ward inactive | Ward resolves | Eight seconds of protection, increased player damage and movement speed, and a shell visual |
| Ward active | Timer expires or the run ends | Clear protection and shell |
| Sword sheathed or drawn | Frame checks the readiness timer, nearby awake threats and attack lock | Draw for active combat. Sheathe when all three checks clear |

Headless `useAction()` validates ability, target, cooldown and range and applies its effect immediately. It tracks Ward protection and the damage multiplier. Its Frostbolt applies damage with the ability cooldown. [Browser input](../src/main.js#L3582-L3619), [pointer listeners](../src/main.js#L3716-L3755), [selection](../src/main.js#L1899-L1953), [cast and recovery](../src/main.js#L2891-L3064), [projectile impact](../src/main.js#L2648-L2679), [headless action](../src/game/game-core.js#L413-L460).

### Enemy behavior, ground attacks and the Warden

**State.** Enemy behavior is derived from its home room, `awake`, `evading`, `frozenTimer`, the attack lock and cooldowns, `pendingEnemyAttack.kind`, HP and `dead`. Melee and ground are explicit attack kinds. Browser ground attacks carry an identity shared by the enemy and the telegraph. The Warden has an explicit phase number and an independent one-time summon flag.

**Invariants.** An enemy may have at most one pending attack. A canceled attack cannot damage the player. Death removes the enemy from guardian counts and gives at most one ordinary loot drop. A gate must leave living guardians reachable from the room whose progression they govern. The summon and phase upgrades each happen once per run. See issues [3](#3-keep-gate-closure-consistent-with-traversal), [4](#4-freeze-gameplay-and-hud-at-the-terminal-transition) and [10](#10-clear-canceled-ground-telegraphs).

| From | Event and guard | To and effects |
| --- | --- | --- |
| Dormant or outside simulated room | Home room becomes accessible, combat is enabled and player approaches | Wake within attack range plus 3.2. The render and simulation distance checks also apply |
| Awake with no pending attack | Choose behavior from profile and distance | Chase or face the player. Ranged enemies can back away. Support can heal the weakest nearby injured ally |
| Awake melee enemy | In range, unlocked and cooldown ready | Melee windup. At expiry, recheck range, then hit or miss |
| Awake ranged enemy or Warden | Eligible for ground cast | Store pending attack and show warning. Cancellation disposes of the warning. A live cast resolves at expiry |
| Awake or casting | Frostbolt hits | Freeze, clear pending attack, resume when thawed. The Warden freezes for 3.5 s, other profiles for 6 s |
| Awake | Position exceeds leash from spawn | Evade, cancel attack and return toward spawn |
| Evading | Within 0.32 of spawn | Snap to spawn, restore HP and go dormant with a short cooldown. Warden phase and summon flag persist |
| Live enemy | Damage reduces HP to zero | Dead, spawn loot, play death animation and hide after the death timer can finish |
| Warden with summon unused | Alive and eligible for a combat update at or below 55% HP | Spawn two thralls and set the summon flag |
| Warden phase I | Alive and eligible for a combat update at or below 50% HP | Enter phase II, increase speed, tint lighting and switch the special from Slam to Soul Collapse |

Headless enemies hold spawn positions. Their states are dormant, awake outside attack range, waiting on an attack timer, hitting or having the hit absorbed, and dead. The headless Warden uses that same timer model with its own stats. [Browser AI and attacks](../src/main.js#L3066-L3317), [combat frame and culling](../src/main.js#L3653-L3670), [death and loot](../src/main.js#L2872-L2889), [headless defense](../src/game/game-core.js#L582-L613).

### Headless time, checkpoints and walkthrough

**State.** The simulation holds elapsed time, an event array and per-action and per-enemy timers. A checkpoint is a detached clone of the current state and its event log. The walkthrough is an explicit ordered list interpreted by `runDelve()`, with a separate cooldown retry loop for Fire.

**Invariants.** Equal commands and time increments on the same starting state replay deterministically. The fixed-step comment also promises caller-cadence independence. Failed imports should preserve both state and log. A walkthrough step should establish the result its label claims. Headless commands run synchronously. Queuing them in promises still calls them in sequence, so partial commits and timer changes within a command are the relevant interleavings. See issues [2](#2-stop-headless-movement-at-simulation-boundaries), [7](#7-restore-checkpoints-atomically), [8](#8-resolve-the-interaction-the-player-or-route-intends) and [9](#9-validate-headless-commands-and-stabilize-timer-stepping).

| From | Event and guard | To and effects |
| --- | --- | --- |
| Active state | `tick(delta)` | Advance cooldowns, Ward, the trail, enemy attacks and victory in 0.1 s steps. Carry partial steps forward |
| Active state | `moveTo(x, z)` | Step toward the target, update position and room, and advance timers. Stop at blocked movement, scene change or a terminal result |
| Current run | `saveCheckpoint()` | Return a detached state and event snapshot |
| Current run | `loadCheckpoint(checkpoint)` | Clone and validate state and log. Replace both on success. Preserve both on failure |
| Fresh game | `runDelve(core)` | Start at Rowan, then execute each step in order. Confirm required chest IDs and the final victory |
| Warden attack step | Fire is cooling down | Tick the reported remaining time, then retry. Other errors or the iteration limit throw |
| Walkthrough finished or step fails | Route exhausted or exception | Return `describe()`, or throw and leave the core at the last mutation |

[Time and snapshot implementation](../src/game/game-core.js#L566-L728), [route and retry loop](../src/game/delve-route.js#L11-L150), [CLI success check](../tools/crypt-headless.mjs#L28-L61).

### Browser diagnostics

**State.** Profiling has an `active` flag, global done and error values, sample buffers and one shared walk target. The fast checkpoint uses the live world, a gate counter and a result slot. Keyboard smoke uses an optional sample with initial position, camera direction, interaction count and error count. The `?e2e` page publishes throttled snapshots and publishes immediately for commands, results and errors.

**Invariants.** Each diagnostic result should describe one invocation. A walk target and its sample buffer belong to the invocation that set them. The fast checkpoint expects a fresh world. Keyboard smoke requires a start sample. Issue [6](#6-give-each-diagnostic-run-exclusive-ownership) covers the shared-state violations.

| From | Event and guard | To and effects |
| --- | --- | --- |
| Ready, fresh town session, diagnostics idle | Invoke `__cryptRun(instant)` with `?e2e` | Claim the diagnostic, reset sample buffers and flags, then approach Rowan or enter the crypt directly |
| Profile running | Set a waypoint and poll every 50 ms | Auto-walk consumes the target with `?e2e`. Arrival continues the route. A 20 s timeout rejects the step |
| Profile running | Success or exception | Save the error on failure. Stop profiling, set done, clear the target and release ownership |
| Ready, fresh town session, diagnostics idle | Click fast checkpoint | Claim the diagnostic, exercise gates and chests, place at the exit, then yield across two animation frames |
| Fast checkpoint awaiting frames | Resume | Publish pass or fail and release ownership |
| Any diagnostic active | Start another diagnostic | Reject or ignore the attempt without changing the active diagnostic |
| Keyboard smoke idle | Start command | Move to Rowan, capture the baseline and clear the old result |
| Smoke sampled | Movement, interaction, then finish | Consume the sample and report movement direction, NPC interaction and runtime errors |

[Snapshot and error publication](../src/main.js#L218-L323), [profile state and finalization](../src/main.js#L3793-L3935), [target polling](../src/optimization-contracts.js#L20-L38), [fast checkpoint and smoke](../src/main.js#L3962-L4132).

### Presentation and resource lifecycles

**Invariants.** A replacement toast or dialogue owns its hide timer. A pooled mesh is either active or free. A timed visual retires once. Adaptive resolution stays between 0.65 and 1. These state machines feed presentation and have their own transitions.

| Machine and owner | From | Event and guard | To and effects |
| --- | --- | --- | --- |
| Toast and dialogue | Hidden or shown | Show or replace | Clear the previous timeout, render new content and arm the new hide timeout |
| Toast and dialogue | Shown | Timeout, or change scene for dialogue | Hide. Scene entry replaces the town dialogue with the arrival dialogue |
| Town NPC patrol | Walking | Waypoint reached or movement blocked | Advance the waypoint index, wrap at the end and wait for the configured pause |
| Town NPC patrol | Paused | Pause expires | Resume walking to the next waypoint while in town |
| Actor clip | No clip, looping or one-shot | Matching clip changes or caller forces it | Fade from previous clip, start a repeat or a clamped one-shot. The gameplay timers drive attack resolution |
| Pooled burst | New or free mesh | Spawn burst | Acquire a slot, make it visible and track its lifetime |
| Pooled burst | Active | Life reaches zero | Hide, release to the pool and remove the active record |
| Spell visual or floating text | Active | Life reaches zero | Dispose the visual or remove the DOM node and delete the active record |
| Adaptive resolution | Sampling | Invalid or hidden frame | Discard the current frame sample |
| Adaptive resolution | Sampling, cooldown expired | One-second sample above 20 ms, or two qualifying samples below 17.2 ms | Adjust scale by −0.10 or +0.05 respectively, clamp, and start 1.5 s cooldown |
| Web Audio | Uninitialized or suspended | Keyboard or pointer gesture | Initialize context and noise buffer once. Request resume when suspended |
| Web Audio | Running | Play cue | Start scheduled nodes and stop them at their deadlines. In other context states, playback is skipped |

[Toast timer](../src/main.js#L415-L420), [dialogue timer](../src/main.js#L1699-L1705), [town patrol](../src/main.js#L1557-L1608), [actor clip](../src/main.js#L656-L680), [visual updates](../src/main.js#L2682-L2747), [burst release](../src/main.js#L2849-L2862), [slot pool](../src/optimization-contracts.js#L40-L46), [adaptive resolution](../src/main.js#L920-L959), [audio](../src/audio.js#L5-L49).

## Verification and limits

- The baseline passed 43 tests. The follow-up passed 49 tests, built with Vite, and completed `npm run test:headless` with 11 discovered rooms, 36 defeated enemies and four opened chests. The canonical route uses `clearRoom()` for ordinary rooms and `useAction('fire', …)` against the Warden.
- Targeted Node probes used the public headless API, an authentic saved checkpoint for the exit and cadence checks, and one validated custom-world fixture for route interaction. The rejected-restore cases supplied malformed data at the public restore boundary.
- Local Chromium against Vite exercised keyboard smoke, a solo instant profile, route objectives, restart, overlap and retry, and gameplay around a gate. Browser setup used `?e2e` placement or room-clear hooks where specified. The terminal-frame and Frostbolt probes staged pending work and stepped the production frame handler to control ordering. The input lifecycle probes used synthetic blur and touch-pointer events.
- The browser checks covered targeted transitions before and after the fixes. Full manual browser combat from New Game to victory, physical touch devices and hosted execution were outside this run.
