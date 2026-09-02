# Modding

A mod is a folder. Drop it in the mods directory, restart the server, and it is
live — no rebuild, no compiler, no Docker.

```
<app data>/state/mods/my-mod/
├── mod.json     name, version, author, description
├── db/          server tables: mob stats, item stats, drops, skills
├── npc/         server scripts: NPCs, warps, monster spawns, custom maps
├── data/        client assets: sprites, .act/.spr, map geometry, Lua
├── System/      client tables: itemInfo.lua and friends
└── client/      a roBrowser plugin: styling, viewport, UI
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

## data/ — sprites, effects and map geometry

Anything under `data/` is served **ahead of the GRFs**, so a file here replaces
the client's own copy without repacking a 2.4 GB archive. Sprites (`.spr`),
animations (`.act`), textures, Lua tables, and the `.gat`/`.rsw`/`.gnd` geometry
of a custom map all go here, in the same layout the GRF uses.

```
my-mod/data/sprite/·¹½ºÅÍ/poring.spr
my-mod/data/texture/유저인터페이스/login_interface/login_bg.bmp
```

The paths are the client's own, mojibake and all — copy them out of a GRF
viewer rather than typing them.

## System/ — item names and descriptions

`System/` is merged over the client's tables *after* the English translation, so
a mod wins. This is where `itemInfo.lua` goes if your mod adds items and wants
them named in the client.

Your file replaces the translation's copy rather than editing it, so start from
the translation's version and add to it.

## client/ — restyling the client itself

A `client/index.js` is loaded as a roBrowser plugin. It runs in the page, so it
can restyle the interface, adjust the viewport, or hook the client's own UI.

```js
// my-mod/client/index.js
define(function () {
	return {
		init: function () {
			var css = document.createElement('style');
			css.textContent = '#chat { font-size: 15px !important; }';
			document.head.appendChild(css);
		},
	};
});
```

Enabled mods are written into the `plugins` map of the generated
`Config.local.js` automatically; there is nothing to register by hand. Files
next to `index.js` are served from `plugins/<mod-name>/`, and paths inside the
plugin resolve from the **server root**, not from the plugin folder.

The shipped `mobile-ui` mod is a working example: it widens the viewport and
enlarges touch targets on small screens, and does nothing at all on a desktop.

## Applying changes

`db/` and `npc/` take effect when the server restarts. `data/`, `System/` and
`client/` are assembled when the app links your client assets, which happens on
launch — so a client-side change needs the app restarted, not just the server.

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
