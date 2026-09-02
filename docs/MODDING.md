# Modding

A mod is a folder. Drop it in the mods directory, restart the server, and it is
live — no rebuild, no compiler, no Docker.

```
<app data>/state/mods/my-mod/
├── mod.json     name, version, author, description
├── db/          server tables: mob stats, item stats, drops, skills
└── npc/         server scripts: NPCs, warps, monster spawns, custom maps
```

On macOS the mods directory is
`~/Library/Application Support/Ragnarok Offline/state/mods`.

Mods are merged in name order, so if two mods change the same file the later
name wins. Everything is reassembled on every server start, so removing a mod
folder removes its effects.

## db/ — changing the world's numbers

rAthena reads `db/import` over its own tables, and that is what `db/` becomes.
Anything with a stub in rAthena's `db/import-tmpl` can be overridden: `mob_db.yml`,
`item_db.yml`, `skill_db.yml`, `mob_item_ratio.yml`, `statpoint.yml`, the `exp_*`
tables, and about fifty more.

Only the entries you name are affected — the rest of the table is untouched.

```yaml
# my-mod/db/mob_db.yml — a Poring that fights back
Header:
  Type: MOB_DB
  Version: 3

Body:
  - Id: 1002
    AegisName: PORING
    Name: Poring
    Level: 3
    Hp: 200
    Attack: 25
```

## npc/ — adding things to the world

Every `.txt` under `npc/` is loaded as an rAthena script. That covers NPCs,
warp portals, monster spawns, shops, and quests.

```
// my-mod/npc/greeter.txt
prontera,155,185,4	script	My Greeter#mymod	4_F_KAFRA1,{
	mes "[My Greeter]";
	mes "This NPC came from a mod folder.";
	close;
}
```

Scripts are mounted at `npc/mods/<mod-name>/` inside the server and named with
`npc:` lines in the generated `map_conf.txt`, which is why no rebuild is needed.

**Custom maps** live here too: the spawns, warps into and out of the map, and
any NPCs on it are scripts, and the map itself is registered by overriding
`db/map_index.txt`. The map's own `.gat`/`.rsw`/`.gnd` files are client assets —
see below.

## What is not wired up yet

Client-side layers are designed but not implemented:

- `data/` — sprites, `.act`/`.spr`, Lua, and custom map geometry. The asset
  server already serves loose files ahead of the GRFs, so this needs exposing
  rather than inventing, but `assets.rs` currently rebuilds its tree on every
  client re-link and would delete anything a mod put there.
- `System/` — `itemInfo.lua` and the other client tables. The English
  translation currently claims that file outright.
- `client/` — login screen, loading screens, UI styling.

Until those land, client-side changes still mean repacking a GRF.

## Checking your work

The server logs what it loaded. For a `db/` override:

```
Loading '1' entries in 'db/import/mob_db.yml'
```

For `npc/`, the NPC total at the end of startup goes up by however many your
scripts define.

If a mod seems to do nothing, check the server log first: rAthena reports a
YAML error with the file and line, and a script error with the file and the
offending line.
