# Modding

A mod is a folder. Drop it in the mods directory, restart, and it is live — no
rebuild, no compiler, no Docker.

```
<app data>/state/mods/my-mod/
├── mod.json     name, version, author, description, what it requires
├── db/          server tables: mob stats, item stats, drops, skills
├── npc/         server scripts: NPCs, warps, monster spawns, quests
├── conf/        a few server settings, from a short allowlist
├── data/        client assets: sprites, textures, map geometry, Lua
├── BGM/         music, merged over the client's own tracks
├── System/      client tables: itemInfo.lua and friends
└── client/      a roBrowser plugin: styling, viewport, UI
```

The mods directory is:

| | |
|---|---|
| macOS | `~/Library/Application Support/Ragnarok Offline/state/mods` |
| Windows | `%APPDATA%\Ragnarok Offline\state\mods` |
| Linux | `~/.local/share/Ragnarok Offline/state/mods` |

or `$RAGNAROK_OFFLINE_HOME/state/mods` if that is set — which is how to test
against a scratch install instead of the one you play on.

**Worked examples live in [`examples/mods/`](../examples/mods).** Their READMEs
describe what each demonstrates and what to look at first. Start from the one
closest to what you want.

Mods merge in **name order**, so if two touch the same file the later name
wins. Everything is reassembled on every start, so removing a folder removes
its effects.

When that happens you are told, rather than left to wonder why half of what you
installed is not in effect:

```
mods: tougher-monsters overwrites mob_db.yml from hello-mod -- later name wins,
      so hello-mod's copy is not in effect
```

---

## mod.json

```json
{
  "name": "my-island",
  "version": "1.2.0",
  "author": "someone",
  "description": "A new island, reachable by boat from Alberta.",
  "requires": { "app": ">=1.0.6", "era": "any" }
}
```

Everything is optional, including the file itself — the smallest useful mod is
a folder with one thing in it. But a `mod.json` that *exists* and cannot be
read is an error, and the mod is refused: somebody meant something by it.

`description` is what the player sees in Settings. `requires` is what makes a
mod safe to hand to a stranger:

- **`app`** — a rule over the app's version. `">=1.0.6"`, `">1.0.6"`,
  `"=1.0.6"`, or a bare `"1.0.6"` read as `">="`. A mod built for a newer
  build is refused and told so, rather than half-applied.
- **`era`** — `"renewal"`, `"pre-renewal"` or `"any"`. A mod that rebalances
  third-job skills is meaningless in pre-renewal, and a mod shipping
  pre-renewal map geometry is meaningless in renewal.

A refused mod is **named in Settings, next to the ones that loaded, with the
reason**:

> **my-island** — *Not loaded — needs app >=1.0.7, and this is 1.0.6*

and the same line goes to the log. Nothing is half-applied: a refused mod
contributes no tables, no scripts, no assets and no plugin.

The **folder name** is the mod's identity — it is what `disabled.txt` lists,
what the script mount is called, and what decides merge order. A `mod.json`
that calls the mod something else gets a warning, and the folder name wins.

### settings — options the app renders for you

A mod that wants one switch should not have to ship its own settings window.
Declare the options in `mod.json` and the app draws them under **Settings →
Mods**, right below the mod's checkbox:

```json
{
  "name": "wasd-movement",
  "settings": [
    {
      "key": "show_controls_button",
      "type": "boolean",
      "default": true,
      "label": "Show the Controls button in game",
      "description": "Turn this off to keep keyboard movement without the on-screen button."
    }
  ]
}
```

`type` is `"boolean"`, `"number"` or `"string"` — three scalars, because the
app has to render them without knowing what the mod means by them. Anything
richer is the mod's own UI problem. A number takes optional `min` and `max`, a
string an optional `max_length` (200 at most); `key` is up to 40 letters,
digits or underscores, and a mod may declare at most twenty.

The values arrive as the **first argument to your client entry point**, the one
you were already given:

```js
export default function init(parameters, api) {
  const showButton = parameters?.show_controls_button !== false;
}
```

Read them defensively, the way that line does. A saved value the mod no longer
declares is dropped, a value of the wrong type falls back to your default, and
a number outside your own `min`/`max` is clamped to it — so a hand-edited
`mod-settings.json` cannot hand your mod something it said it could not take.
Answers live in `state/mod-settings.json`, outside both the runtime tree an
update replaces and the `state/mods` folder that only exists for mods somebody
installed, so a bundled mod's options survive an app update.

Settings are read when the client config is generated, so **Apply** rewrites it
and the game picks the new values up on its next load. Changing an option does
not disable the mod: it stays on and decides for itself what to do with the
answer, which is the point — `show_controls_button` hides a button while
keyboard movement keeps working.

## Installing a mod

**Settings → Mods → Install a mod…** takes a folder or a `.zip` and puts it in
the right place. A zip must contain exactly one folder, named for the mod;
anything with two top-level folders, or with a path that would escape the mods
directory, is refused rather than unpacked.

Or do it by hand: drop the folder in the mods directory yourself. Same result.

A mod adds scripts and tables to your server and can run JavaScript in the game
window. Installing one is running somebody's code — install ones you trust.

## Turning mods off

Settings → Mods lists what is installed with a checkbox each. Under the hood
that is `state/mods/disabled.txt`, one name per line. Disable by naming it
there rather than by moving the folder: a folder that moves loses its place in
the merge order.

Mods that ship with the app appear in the same list, marked *included*. They
can be switched off like any other, and a mod you install under the same name
replaces the shipped one — so a bundled mod is a starting point, not a locked
cabinet.

---

## db/ — changing the world's numbers

rAthena reads `db/import` over its own tables, and that is what `db/` becomes.
Anything with a stub in rAthena's `db/import-tmpl` can be overridden:
`mob_db.yml`, `item_db.yml`, `skill_db.yml`, `mob_item_ratio.yml`,
`statpoint.yml`, the `exp_*` tables, and about fifty more.

Only the entries you name are affected — the rest of the table is untouched.

**Two mods can both ship the same table.** rAthena reads a list of files and
accumulates their entries, and so does this: if another enabled mod also has a
`db/item_db.yml`, the two are combined into the one file the server reads —
one header, both sets of entries. Neither mod has to know the other exists.

Entries go in the order the mods are applied, which is their folder names in
alphabetical order, so if both define the *same* id the later name wins. That
is the only case where two mods can disagree, and it is the only case worth
avoiding. If the two files cannot be combined at all — different `Type:` in
the header, or a file that is not a table — the later name wins outright and
**Settings → Mods says so under the mod whose copy is not in effect.**

```yaml
# my-mod/db/mob_db.yml — a Poring that fights back
Header:
  Type: MOB_DB
  Version: 5

Body:
  - Id: 1002
    AegisName: PORING
    Name: Poring
    Level: 8
    Hp: 220
    Attack: 24
```

**Take `Version:` from the header of
`vendor/rathena/db/import-tmpl/<the same file>`.** An out-of-date number is not
an error; rAthena warns that the database version is outdated and loads the
file in a reduced-compatibility mode, which is a different thing from what you
asked for.

**A brand-new item needs a second file to be named in the client.** `db/` gives
it stats, a script and a price; the client gets its name, icon and description
from a separate table and will otherwise call it *Unknown Item*. That is
[`System/`](#system--item-names-and-descriptions), ten lines, and it is
additive too.

**`Drops:` does not behave like the other fields.** A drop entry without an
`Index:` is *appended* to the monster's existing list rather than replacing it,
and monsters have ten slots. Appending to a monster that is already full gets
you:

```
[Error]: Maximum of 10 monster Drops met, skipping.
```

With an `Index:`, the entry overwrites that slot
(`MobDatabase::parseDropNode`, `src/map/mob.cpp`). Index 0 is the monster's
first drop.

**There is no way to delete a drop, and `Rate: 0` is worse than useless.**
rAthena rejects a zero rate — `Node "Rate" needs to be at least 1` — and the
rejection makes it abandon the whole entry, so one zero silently discards the
entire monster rather than one drop. The lowest rate the parser accepts is `1`,
which is 0.01%.

See [`examples/mods/tougher-monsters`](../examples/mods/tougher-monsters).

### Where the AI characters go

The wandering AI characters are placed by `db/population_spawn.yml`, one entry
per *profile* — `novice_default`, `combat_pve_low`, `pve_knight` and eleven
more — each with a list of town, field and dungeon maps and a headcount to
spread across each list.

A mod ships `db/population_spawn.yml` like any other table, and names only the
profiles it cares about. Entries are matched by `Profile:`, and only the fields
an entry actually names are touched, so the rest of the table is left alone. A
profile that is not in the shipped table is added whole.

Each list and count has two forms, and the difference matters:

| | |
|---|---|
| `Towns:` `Fields:` `Dungeons:` | **replace** that profile's list |
| `TownsAdd:` `FieldsAdd:` `DungeonsAdd:` | **append** to it |
| `TownsPopulation:` and the `Fields`/`Dungeons` pair | set the headcount |
| `TownsPopulationAdd:` and its pair | add to the headcount |
| `TownsMaxPerMap:` and its pair, plus the `…Add` forms | the per-map cap |

Prefer the `Add` forms. A category's headcount is divided between its maps, so
adding a map with the plain form means restating the twenty already there — and
then silently keeping *those* twenty when the shipped table changes.

```yaml
# my-mod/db/population_spawn.yml — twelve more of them, on my island
Header:
  Type: POPULATION_SPAWN_DB
  Version: 1

Body:
  - Profile: combat_pve_low
    FieldsAdd:
      - ro_isle
    FieldsPopulationAdd: 12
```

**To own the table outright instead**, put `Clear: true` in the header.
rAthena empties a database before reading a file that asks for it, so the
shipped table goes and only yours remains — which is what you want for a server
where the AI characters should be nowhere except where you say:

```yaml
Header:
  Type: POPULATION_SPAWN_DB
  Version: 1
  Clear: true
```

If another enabled mod also ships this table, the two are combined as usual,
and a `Clear:` from either one applies to the merged result.

Two things the server will not tell you, which is why
`third-party/population-engine/validate.py` exists: a job belongs to exactly
one profile and the last definition silently wins, so a profile that loses all
its jobs is skipped without a word and its maps just stay empty. Run the
validator over anything you write here.

The other eight population databases — chat lines, names, gear sets, vendor
placement — are **not** wired this way yet. A mod's copy of those still lands
in a directory nothing opens.

**[docs/mods/ai-characters.md](mods/ai-characters.md)** is the full reference:
every key, how the headcount is divided between maps, which tables are still
unreachable, and the two ways this data fails without the server saying
anything.

## npc/ — adding things to the world

Every `.txt` under `npc/` is loaded as an rAthena script. That covers NPCs,
warp portals, monster spawns, shops and quests.

```
// my-mod/npc/greeter.txt
prontera,155,185,4	script	My Greeter#mymod	4_F_KAFRA1,{
	mes "[My Greeter]";
	mes "This NPC came from a mod folder.";
	close;
}
```

Scripts are mounted at `npc/mods/<mod-name>/` inside the server and named with
`npc:` lines in the generated `map_conf.txt`, which is why no rebuild is
needed.

Three things that will cost you an afternoon each:

- **The fields in a header line are separated by tab characters**, not spaces.
  An editor that expands tabs produces a line rAthena skips or misreads.
- **Sprite names are constants, and a wrong one is a warning, not an error.**
  `npc_parseview: Invalid NPC constant '4_M_SAILOR' ... Defaulting to
  INVISIBLE` — the script loads, the NPC is there, and you cannot see it. Grep
  `vendor/rathena/npc/` for a name that is actually in use.
- **Variable scope is spelled in the prefix**, and getting it wrong is how a
  quest half-works:

  | written | lives until |
  |---|---|
  | `.@name` | the end of this script run |
  | `@name` | the character logs out |
  | `name` | forever, on that character, in the database |
  | `$name` | forever, on the server, shared by everyone |

  There is no namespacing. Prefix your variables with your mod's name, or the
  next mod that calls one `progress` will collide with yours, silently, on the
  player's character.

### Removing things a mod did not add

A mod cannot unload a stock script, but it can **switch off the NPCs and warps
inside one**, which covers most of what "remove" means in practice. Stock warps
and NPCs are ordinary named objects, so `disablenpc` finds them:

```
-	script	my_retheme	-1,{
	end;
OnInit:
	disablenpc "prt001";     // Prontera's south gate
	end;
}

// ...and put your own in the same place
prontera,156,22,0	warp	my_gate	3,2,my_isle,40,40
```

Warp names are in `vendor/rathena/npc/warps/`; they are short and stable
(`prt01`, `prt001`). This is verified — rerouting Prontera's south gate to a
custom island works, with no duplicate-name complaint.

What genuinely cannot be removed is a **monster spawn definition**. Those come
from the stock spawn scripts and nothing unloads them, which is why the
[randomizer](../examples/mods/randomizer) shuffles what each monster *is*
rather than where it stands.

See [`examples/mods/quest-npc`](../examples/mods/quest-npc).

## conf/ — a few server settings

`conf/` sets server config the supervisor otherwise owns. It is an
**allowlist**, and a short one:

```
char_conf.txt   start_point  start_point_pre  start_zeny  start_items
                start_status_points  char_name_letters  char_name_option
```

```
# my-mod/conf/char_conf.txt — new characters start on my island
start_point: my_isle,40,44
start_point_pre: my_isle,40,44
```

Both era keys, because a pre-renewal char-server reads only `start_point_pre`
and a renewal one reads only `start_point`; setting one leaves new characters
with no start point at all in the other era.

The list is short on purpose. `conf/` is also where `login_ip`, `char_ip` and
`map_ip` live, and a mod that could write those could point a player's client
at somebody else's server while looking exactly like a mod that works. Anything
outside the list is **named in the log and ignored**:

```
mods: my-mod asked to set "char_ip" in conf/char_conf.txt, which mods may not set -- ignoring
```

Widening the list is a change to `CONF_ALLOWED` in `stack/src/mods.rs` and a
conversation about what it lets a mod do.

### Two files a mod may supply whole

Some config is a document rather than a list of settings, and two of those can
be dropped in as-is:

| file | what it decides |
|---|---|
| `conf/groups.yml` | which `@commands` each player group may use |
| `conf/atcommands.yml` | command aliases |

The common use is giving ordinary players a command that is normally a GM's.
Group `0` is the default group every new account lands in, and an entry that
lists only `Commands:` **merges** — `can_trade` and the rest survive:

```yaml
# my-mod/conf/groups.yml — everyone gets @autoloot
Header:
  Type: PLAYER_GROUP_DB
  Version: 1
Body:
  - Id: 0
    Commands:
      autoloot: true
      autolootitem: true
```

A misspelled command is a named error at load, not a silent no-op:
`Unknown atcommand: autolot`.

**`groups.yml` decides what every player on your server can do.** A mod that
ships one can hand out `@item` or `@zeny` as easily as `@autoloot`. The
supervisor says which mod supplied it on every start — `mods: my-mod supplies
conf/groups.yml` — so read it before installing a mod you did not write.

See [`examples/mods/start-in-your-town`](../examples/mods/start-in-your-town).

## data/ — sprites, textures and map geometry

Anything under `data/` is served **ahead of the GRFs**, so a file here replaces
the client's own copy without repacking a 2.4 GB archive. Sprites (`.spr`),
animations (`.act`), textures, Lua tables and the `.gat`/`.gnd`/`.rsw` geometry
of a custom map all go here, in the same layout the GRF uses.

```
my-mod/data/sprite/·¹½ºÅÍ/poring.spr
my-mod/data/texture/À¯ÀúÀÎÅÍÆäÀÌ½º/loading01.jpg
```

### You can write ASCII instead of mojibake

The client asks for `data/texture/유저인터페이스/...` as **CP949 bytes that
every tool in the chain reads as Latin-1** — on disk and in a URL, that is
`À¯ÀúÀÎÅÍÆäÀÌ½º`. Those names are hard-coded in the client, so they cannot be
renamed.

But a mod does not have to contain them. Write the ASCII name and the app
translates it as it lays the mod down:

| write this | the client sees |
|---|---|
| `data/texture/ui/…` | `data/texture/유저인터페이스/…` |
| `data/texture/town/…` | `data/texture/기타마을/…` |
| `data/texture/field-ground/…` | `data/texture/필드바닥/…` |
| `data/texture/indoor-props/…`, `outdoor-props` | `내부소품`, `외부소품` |
| `data/sprite/human/…`, `human/body/…` | `인간족/…`, `인간족/몸통/…` |
| `data/sprite/monster/…` | `data/sprite/몬스터/…` |
| `data/sprite/item/…`, `accessory`, `robe`, `shield`, `effect` | `아이템`, `악세사리`, `로브`, `방패`, `이팩트` |

This matters more than tidiness: **a zip containing those bytes unpacks
differently on different machines**, so a mod that ships them arrives corrupted
for some people. A mod written in ASCII travels.

Only whole path segments are translated, and only at the start — a folder of
your own called `sprite/monsters` is left alone. The real names still work if
you prefer them; nothing is rewritten on the way out.

Anything not in that table has to be spelled the client's way. Copy it out of a
GRF viewer or an example; do not retype it, and do not "correct" it to Korean —
a directory named in Korean is one the client never looks in.

### The client caches, hard

There are two caches between your file and the screen, and they fail
differently.

The **asset server** keeps every file it has served in memory. It is emptied
when the server stops, so restarting the app is enough.

The **client** keeps its own copy of every file it downloads, in the browser's
sandboxed filesystem, and looks there before asking the server again. That one
is keyed by *filename* and survives restarts, which is what made this the
nastiest failure in the whole system: a mod replacing a stock file the client
had already saved — a login background, a loading screen, `itemInfo.lua` —
loaded on the server, reported `on` in Settings, and changed nothing on screen.
Everything that could tell you the mod was working said it was.

The app now clears that cache for you. `link-assets` writes a fingerprint of
the overlay to `state/assets/overlay.id` — the era, plus the name, size and
mtime of every file each enabled mod puts under `data/`, `BGM/`, `System/` or
`client/` — and the app drops the client's cache whenever that number moves.
So installing, editing or switching off a mod takes effect on the next launch,
and an ordinary launch still starts from a warm cache.

A mod that only touches `db/`, `npc/` or `conf/` deliberately does not count:
the client never sees those, and clearing its cache would cost you a re-download
for nothing.

### Two things worth knowing before you replace a background

- **The login screen is twelve images, not one.** For packet versions between
  2018-11-14 and 2022-12-07 — which includes the 20221005 this app ships — the
  client draws a 4 × 3 grid of `t_¹è°æ<row>-<col>.bmp`. Use
  [`scripts/mkloginbg.py`](../scripts/mkloginbg.py), and see
  [`examples/mods/login-screen`](../examples/mods/login-screen).
- **Loading screens already rotate.** The client picks at random from a fixed
  list of ten names, `loading01.jpg` to `loading10.jpg`, on every map change.
  That list is not configurable — `Background.init()` accepts one but every
  call site passes nothing — so a mod supplies as many of those ten names as it
  wants, and the ones it does not supply stay the client's. See
  [`examples/mods/loading-screens`](../examples/mods/loading-screens).
- **The extension does not have to match the format.** These are decoded by the
  browser, which sniffs content rather than trusting the name, so a JPEG saved
  as `.bmp` works and is roughly a tenth of the size.

## BGM/ — music

`BGM/` is merged over the client's own tracks, so a mod can add a piece of music
or replace one:

```
my-mod/BGM/my-theme.mp3
```

It is its own layer rather than part of `data/` because the client asks for
music as `BGM/<file>`, a path root outside `data/`.

Which track plays on which map is `data/mp3nametable.txt` — a `data/` file, so a
mod can override it to point maps at its own music. Start from the client's copy
and edit it.

## Custom maps

**This works, end to end**, and there is nothing to configure: put the geometry
in `data/` and the server side is done.

That is worth stating plainly because it is not obvious and because it is not
how rAthena works on its own. A custom map needs **three** things on the server,
two of which are invisible:

1. **A `map:` line in the map config.** The map server builds its list of maps
   from `map:` directives — `conf/maps_athena.conf` is twelve hundred of them.
   A map never named there is not in the list and the server says *nothing at
   all* about it. This is the one that wastes the afternoon.
2. **An entry in `db/import/map_index.txt`**, which gives the map the number
   the servers pass between them. Missing, and the map is dropped at load with
   only a "maps removed" count to say so.
3. **An entry in `db/import/map_cache.dat`.** rAthena's map server never reads
   a `.gat` at runtime; it reads a prebuilt cache and refuses any map not in
   one, however correctly it is registered elsewhere. Upstream builds this file
   with a separate `mapcache` tool that links against the whole server and
   reads geometry out of a GRF.

On every start, the supervisor scans each enabled mod's `data/` for `.gat`
files, decodes them, writes `map_cache.dat` and `map_index.txt` into the
`db/import` tree it mounts, and adds the `map:` lines to the generated
`map_conf.txt` (`stack/src/mapcache.rs`, `stack/src/mods.rs`). It prints what
it found:

```
mods: custom-map
mod maps: ro_isle
```

The map cache is built in-process rather than by running rAthena's `mapcache`
tool, so a custom map needs no Docker rebuild and no image change — which is
the same promise as the rest of the mod system.

### Making one

```
scripts/mkmap.py my_isle --out path/to/my-mod/data --cells 40
```

writes a flat, walled, walkable square with a generated ground texture and a
minimap: `.gat`, `.gnd`, `.rsw`, `data/texture/my_isle/ground.bmp` and
`data/texture/À¯ÀúÀÎÅÍÆäÀÌ½º/map/my_isle.bmp`. It is a floor to stand on, not a
landscape — for real terrain, use one of the community map editors and copy its
`.gat`/`.gnd`/`.rsw` into `data/` exactly the same way.

Three traps:

- **Map names are at most 11 characters.** rAthena truncates silently at three
  separate layers before anything complains.
- **The `.gnd` is half the `.gat`'s resolution.** An 80 × 80 walkable map is a
  40 × 40 ground mesh.
- **A `.gnd` lightmap cell is not a brightness value.** It is 64 bytes of
  shadow followed by 64 RGB triples of *additive* coloured light. Filling the
  cell with `0xff` — the obvious thing — adds full white light to every pixel
  and renders the map as a flat white sheet with the texture washed out of it.
- **Without a minimap bitmap** at `data/texture/À¯ÀúÀÎÅÍÆäÀÌ½º/map/<name>.bmp`
  the client asks once, gets a 404, and shows an empty frame.

See [`examples/mods/custom-map`](../examples/mods/custom-map) and
[`examples/mods/island-ferry`](../examples/mods/island-ferry).

## Generating a mod instead of writing one

Some mods are better computed than typed. `ro-randomizer`, which ships beside
the other binaries in the app's `runtime/bin`, reads rAthena's monster table
out of the running server, shuffles it against a seed, and writes a complete
mod folder:

```
ro-randomizer --seed 12345
```

Every monster in the game becomes another monster — stats, drops, element,
size, AI and sprite — without a single spawn script being touched, because
every stock spawn line names an *ID* and the randomizer moves the blocks
between the IDs. That is the way around the one thing the `npc/` layer cannot
do, which is remove a stock spawn.

Its source is in [`examples/mods/randomizer`](../examples/mods/randomizer) and
is worth reading whatever you are building: it is a worked account of the
`db/import` traps above, found by hitting them.

## System/ — item names and descriptions

`System/` is merged over the client's tables *after* the English translation,
so a mod wins. This is where `itemInfo.lua` goes if your mod adds items and
wants them named in the client.

**Item tables are the exception: they are added, not replaced.** The
translation's `itemInfo.lua` is 22 MB, so replacing it to add one item would
mean a 22 MB mod. Instead, ship a `System/itemInfo.lua` containing only your
items — the app copies it aside and names it in the client's `customItemInfo`
list after the base table, and roBrowser merges them by item id. Ten lines is
enough. See [`examples/mods/custom-item`](../examples/mods/custom-item).

Everything else in `System/` still replaces the client's copy, so start from the
translation's version and add to it.

## client/ — restyling the client itself

`client/index.js` is loaded as a roBrowser plugin. It runs in the page, so it
can restyle the interface, adjust the viewport, or hook the client's own UI.

**It must be an ES module whose default export is a function.** The plugin
manager imports the file and awaits `module.default(params, api)`. Initializers
run in configured order before login, once per page. Existing one-argument
plugins remain compatible. Return a cleanup function or `{ dispose() }` for
owned resources; `false` reports failure. A failed or timed-out initializer
releases its registered resources and does not stop the next plugin or login.

```js
// my-mod/client/index.js
export default function (params, api) {
	if (api?.version !== 1) throw new Error('This mod requires client API 1');
	const css = document.createElement('style');
	css.textContent = '#chat { font-size: 15px !important; }';
	document.head.appendChild(css);
	return () => css.remove();
}
```

Older roBrowser plugins are written as `define(function () { … })`. **Those do
not work here.** The import throws, the plugin manager catches it, and the
error goes to a console the client has muted — so the plugin loads, does
nothing, and nothing says so. If a plugin seems inert, this is the first thing
to check.

The second thing: **roBrowser's windows live in shadow roots**, and a `<style>`
in the document head does not cross that boundary. To restyle the interface
rather than the page, build a `CSSStyleSheet` and adopt it into each shadow
root as it appears. Use `api.on('ui:append', component => …)` for supported
component notifications. Already mounted components replay to new subscribers;
`ui:remove` lets a mod remove its styles. Avoid scanning the entire document on
every DOM mutation. See [`examples/mods/client-api`](../examples/mods/client-api).

Enabled mods are written into the `plugins` map of the generated
`Config.local.js` automatically; there is nothing to register by hand. Files
next to `index.js` are served from `plugins/<mod-name>/`. The configured entry
path resolves from the page URL; relative ES module imports resolve from the
importing module. Use `new URL('./file.css', import.meta.url)` for adjacent
resources. Plugin entries must use the same HTTP(S) origin as the game.

### Client API 1

This is an unprivileged game-page API. It does not expose Electron IPC, engine
objects, passwords, database operations or arbitrary packet construction.
It is a supported interface, not a sandbox for untrusted JavaScript.

| API | Contract |
| --- | --- |
| `api.on(event, listener, { replay: true })` | Returns an unsubscribe function; subscriptions also end at disposal. Events: `map:enter`, `map:leave`, `connection`, `ui:append`, `ui:remove`, `movement:clear`, `preferences:change`. |
| `api.snapshot()` | Frozen copy of map, connection, player position/HP/SP, selected target identity/name/HP, camera, packet version and movement counters. Server movement acknowledgements are read-only evidence. |
| `api.components.current()` | Mounted `{ name, root, host }` descriptors. DOM references support styling; do not retain detached components after `ui:remove`. |
| `api.preferences.get(key, fallback)` / `.set(key, value)` | JSON values isolated by plugin, browser and server origin. Storage failure is reported by `set`. Do not store secrets. |
| `api.movement.register(name, onCancel)` | Returns `begin(x,y)`, `update(x,y)`, `end()`, `dispose()`. Screen-up is positive Y. Only a deliberate `begin` can take ownership; a stale `update` cannot. |
| `api.input.state()` / `.shortcutConflict(keyCode)` | Read input eligibility and the active native battle-shortcut mapping. |
| `api.input.suspend()` | Suspend movement while showing a plugin dialog. Returns an idempotent release function, also released at disposal. |
| `api.actions.perform(name, payload)` | Native actions: `attack`, `target` (toggle auto-target), `interact`, `pickup`, `menu` (game options), `shortcut` with `{ index: 0…35 }`, `shortcut:assign` and `storage:transfer` (below), or `window` with an allowed `{ name }`. Returns whether the action was dispatched, not whether the server accepted it. |
| `api.cleanup(fn)` | Register idempotent cleanup immediately after allocating a resource. The returned function can release it early. Runs on failure, scope replacement and page teardown. |

Allowed window actions currently cover Inventory, Equipment, SkillList, Quest,
WorldMap, PartyFriends, WinStats and already-open Storage. Set `{ name, open: true }`
to focus an existing window instead of toggling it closed. Storage must first be
opened by the server; this action cannot create a storage session.

Map and connection events clear movement;
blur, hidden page, text entry, IME and modal UI also cancel it. Directional
requests use native pathfinding and packets, with a 180 ms cadence and at most
three path steps per destination. The server remains authoritative.

`shortcut:assign` accepts `{ slot: 0…35, kind: 'item' | 'skill', id }`.
For items, `id` is a current inventory **index**, not the item type ID; for skills
it is the learned skill ID. The adapter validates the live item/learned level and
uses the native shortcut assignment callbacks, including server persistence.

`storage:transfer` accepts `{ direction: 'deposit' | 'withdraw', index, count }`.
The index belongs to the live source inventory/storage list. Count must be a
positive integer within the available stack or `'all'`. The adapter requires
an open storage session, rejects equipped deposits, and invokes native storage
callbacks. A `true` result means a request was sent; only the server's item
updates establish success. The mobile controls show “Transfer requested.”

Host mod enable/disable still requires the normal reload. Arbitrary older
plugins cannot be safely hot-unloaded if they never registered cleanup. The
in-game **Controls** button from [`wasd-movement`](../mods/wasd-movement) offers
per-browser activation, rebinding, arrows and battle-shortcut priority.

The bundled `mobile-ui` mod provides **Display** settings before login and under
the phone's in-game **Menu**. Auto selects a phone layout on a touch-capable
screen whose shorter side is at most 900 pixels. On/Off overrides that choice.
Mode changes reload the client; control size changes apply immediately.
Geometry preferences use a separate phone key selected before UI initialization,
so a mode change cannot save phone coordinates into the desktop preferences.
The phone HUD retains the native joystick, action handlers and shortcuts. Tap
an inventory/equipment/skill entry, then its explicit action button; F1–F4 can
be assigned from the inventory and skills toolbars. Storage adds quantity and
whole-stack deposit/withdraw controls, with explicit focus buttons between it
and inventory. Shops reuse the native buy/sell selection, quantity dialog and
transaction callbacks. Their nested geometry also has a separate phone bank.

---

## Applying changes

| layer | takes effect on |
|---|---|
| `db/` `npc/` `conf/` | a **server** restart (Settings → Restart server) |
| `data/` `BGM/` `System/` `client/` | an **app** restart |

Client assets are linked when the app starts, and the asset server caches
everything it serves, so a client-side change needs the app restarted rather
than just the server.

`state/modbuild` is rebuilt from scratch on every start. **Never edit files
there** — edit under `mods/` and restart.

There is one exception worth knowing while you are iterating on a script.
`state/modbuild` is live inside the running server, and `state/mods` is not, so
editing a script *there* and typing `@reloadscript` in game applies it without a
restart. Treat it as scratch space: it is deleted and rebuilt from `mods/` the
next time the stack starts, so copy anything you want to keep back into your
mod folder. (`@reloadscript` has also preceded a server crash at least once —
see issue #16 — so use it on a test character.)

## Checking your work

**Look at the result, not the exit code.** This project has been bitten
repeatedly by steps that report success and do nothing.

**A mod that appears not to work may be a mod that did not load.** The
supervisor prints the mods it applied on start:

```
mods: custom-map, login-screen, quest-npc
mod maps: ro_isle
```

If your mod is not in that line, nothing else you are looking at matters — look
for a refusal instead:

```
mods: my-island was not applied -- needs app >=1.0.7, and this is 1.0.6
```

**Settings → Mods says when the server rejected one of your tables.** A `db/`
file that the server could not read does not switch the mod off or refuse it:
every other layer still applies, the box stays ticked, and only that one table
is missing. So the mod is listed as on, with what the server said underneath:

```
Server could not read part of this mod — db/skill_db.yml: 1 entry offered,
0 kept. Node "Id" cannot be parsed as t. (t is a whole number)
Occurred in file 'db/import/skill_db.yml' on line 5 and column 4.
```

That is rAthena's own verdict, quoted, with the file and line it named. `t` is
its name for a whole number, which is worth knowing because its message says
only the letter — that one is a field wanting a number and given something
else, such as a skill's `Id` written as `AM_CALLHOMUN` instead of `243`.

It comes from the last time the server started, so start the server after
installing a mod and then look. No line means the server did not complain, not
that it has read anything.

The server log is the next place to look. For a `db/` override:

```
Loading '1' entries in 'db/import/mob_db.yml'
```

For `npc/`, the NPC total at the end of startup goes up by however many your
scripts define. rAthena reports a YAML error with the file and line, and a
script error with the file and the offending line.

**A script that loads silently can be made to say so.** `debugmes` writes to
the map server log, so an `OnInit` block is a cheap way to prove a script is
running before you go looking for the reason it is not:

```
OnInit:
	debugmes "my-mod: greeter loaded";
	end;
```

**Test in both eras if the mod touches the server.** Pre-renewal uses different
binaries, a different database volume and a different translation overlay. A
mod tested only in renewal is tested in half the app.

**If you see sixty `db/import` warnings**, the import stubs failed to stage —
rAthena ships ~60 files there and warns for each one it cannot open. That is a
bug in the app, not in your mod; please report it.

## Sharing a mod

Zip the folder and hand it over. Whoever gets it drops it in their mods
directory and restarts.

That works on any build satisfying the mod's `requires`, with no edits — and on
a build that does not, they get a named refusal with a reason instead of a
server that runs and is quietly wrong. Which is the whole point of filling in
`requires`.
