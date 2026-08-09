# Forgotten Crypt

`Forgotten Crypt` is a standalone Three.js hub-and-branches crypt built as an
expanded preview. Its central hub opens into three connected branches with
eleven large rooms, 36 initial enemies, branch progression, and reliquary caches.
Every room has four times the floor area of the original layout and its own
prop arrangement, lighting treatment, and combat formation. Solid corridor
floors bridge every doorway, while chests, tombs, and columns block movement.
The western and eastern seals guide the northern Archive route; its key leads
to a telegraphed Warden encounter. A schematic minimap, ability
cooldowns, projected enemy nameplates and cast bars, combat status, and
floating feedback keep the larger delve readable. Enemies leave physical loot
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

Open the local Vite URL, then use `WASD` to move through the hub and three
branches, drag with the mouse to orbit the view, and scroll to zoom. Click an
enemy to choose `Sword`, `Fire`, or `Freeze`; click the knight to choose `Heal`
or `Ward`. Press `Space` for a quick sword strike, and press `E` to open
reliquaries or collect glowing enemy drops. Click a backpack item to consume or
equip it. Walk freely through the connected rooms; after the final cache,
return through the southern entrance to finish. Room caches provide small recovery and cooldown relief, while the two branch
reliquaries, Archive cache, and Warden spoils drive the required route.

## Build

```sh
npm run build
```

See [ASSET_CREDITS.md](./ASSET_CREDITS.md) for the exact source commit and
license record for the bundled models.
