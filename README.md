# Forgotten Crypt

`Forgotten Crypt` is a standalone Three.js preview with two mutually exclusive
scenes: the small Ravenrest Village hub and a hub-and-branches crypt. Ravenrest
has a few WoC NPCs and a hunter-class ranger; speak with Ranger Rowan at the
archery yard to teleport into the dungeon entrance. The town and dungeon are
separate `THREE.Scene` instances, so only the active scene is rendered.

The crypt's central hub opens into three connected branches with
eleven large rooms, 36 initial enemies, branch progression, and reliquary caches.
Every room has four times the floor area of the original layout and its own
prop arrangement, lighting treatment, and combat formation. Burial debris,
broken floors, flooded storage, an actual furnished archive, and a gilded
reliquary give the branches distinct silhouettes. Solid corridor
floors bridge every doorway, while interactive gates unload chambers behind
the player and keep only the active room, its approaches, and an opened
destination rendered. Chests, tombs, and columns block movement.
An adaptive quality controller lowers or restores render resolution using
averaged frame time; the renderer uses a single instanced blob-shadow pass for
lightweight, consistent shadows.
The western and eastern seals guide the northern Archive route; its key leads
to a telegraphed Warden encounter. At half health, the Warden enters a second
phase, accelerates, changes the crypt lighting, and casts a player-targeted
Soul Collapse that must be dodged. A schematic minimap, selected-target frame,
action-bar cooldowns, projected enemy nameplates and cast bars, combat status, and
floating feedback keep the larger delve readable. Fire and Frostbolt now use
distinct cast clips, travelling projectiles, and impact timing; Heal resolves
after its cast, while Ward wraps the knight in an orbiting protective shell.
Enemies leave physical loot
drops for a six-slot backpack; consumables can be used in place, while one
relic at a time modifies damage or cooldowns. The knight automatically sheathes
the sword outside combat, with procedural Web Audio cues and restrained camera
feedback adding impact without additional media dependencies.
It uses a focused
selection of the CC0 character and dungeon assets recorded in World of
ClaudeCraft's asset register, but does not copy the game's runtime, branding,
UI, or server.

## Run locally

```sh
npm install
npm run dev
```

Open the local Vite URL, speak with the hunter using `E`, then use
camera-relative `WASD` to move through the hub and three branches, drag with the
mouse to orbit the view, and scroll to zoom. Click an
enemy to select it, then press `1`–`5` or click the matching action-bar slot for
`Sword`, `Fire`, `Frostbolt`, `Heal`, or `Ward`. Press `Space` to use `Sword` on
the selected enemy, and press `Esc` or click empty ground to clear the target.
Press `E` to open
gates and reliquaries or collect glowing enemy drops. Gates remain sealed until
the current room is clear; entering the revealed room closes the gate and hides
the chamber behind. Blob shadows are always enabled while render resolution
adapts to frame time. Click a backpack item to consume or equip it. After the
final cache, return through the southern entrance to finish. Room caches provide small recovery and cooldown relief, while the two branch
reliquaries, Archive cache, and Warden spoils drive the required route.

## Build

```sh
npm run build
```

Stable world content lives in [src/data/world.json](./src/data/world.json) and is validated by `npm test`; its asset keys point to files under `public/assets`, while runtime behavior and rendering remain in `src/main.js`.

See [ASSET_CREDITS.md](./ASSET_CREDITS.md) for the exact source commit and
license record for the bundled models.
