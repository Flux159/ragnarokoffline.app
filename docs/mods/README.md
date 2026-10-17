# Mod reference

**New to modding?** Start with the tutorials. They are shorter, and they walk
through a working mod step by step:

| | |
|---|---|
| [Getting started](tutorials/gettingstarted.md) | a first mod in ten minutes: the mods folder, an NPC, switching it on, and what to check when nothing happens |
| [Adding a `@give` command](tutorials/giveguide.md) | a chat command from one script: reading what the player typed, looking up items, and who may use it |

[Making mods](../MODDING.md) is the full reference. It covers the whole
mod format: `db/`, `npc/`, `conf/`, `data/`, `System/`, `client/`, and how to
install, test and share one.

These pages go deeper on parts of the server that need more than a paragraph,
and that nobody would find by guessing:

| | |
|---|---|
| [Adding a mod to the registry](../MOD_REGISTRY.md) | putting a mod in the registry so the app can find and install it: files in this repository or your own repository with releases, `mod.json`, cutting a release, updates, and what a reviewer reads for ([short version](publishing.md)) |
| [The map editor](MAP_EDITOR.md) | Settings → Tools → Map editor: making a map, or changing one of the client's, as a mod — ground, textures, walkability, water, light, models, NPCs, warps, monsters, sky and music — then Test in game. AI agents can drive it too (`ragnarok-map`, MCP) |
| [Custom maps](CUSTOM_MAPS.md) | a map that is in nobody's GRF: the files, how the server side is done for you, making the geometry, its sky, weather and music, and getting players there |
| [Custom quests](CUSTOM_QUESTS.md) | a quest in the game's own quest log: kill counters the server keeps, the quest window's text, icons over the NPC, choosing a quest id, and what the quest system cannot do |
| [Custom achievements](CUSTOM_ACHIEVEMENTS.md) | an achievement in the game's own achievement window: what completes it on the server, its tab and text in the window, rewards and titles, choosing an id, and the traps between the files |
| [Monster looks](MONSTER_LOOKS.md) | one monster that looks different from the rest of its kind, with nothing changed but a mod: another sprite, half or one and a half times the size, a hat effect, status colours, which of them players arriving later still see, and every hat effect with what the client draws for it |
| [Where the AI characters go](ai-characters.md) | the population engine's spawn table: adding maps to it, replacing it, and the eight tables that still cannot be modded |
