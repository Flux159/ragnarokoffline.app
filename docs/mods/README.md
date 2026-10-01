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
| [Where the AI characters go](ai-characters.md) | the population engine's spawn table: adding maps to it, replacing it, and the eight tables that still cannot be modded |
