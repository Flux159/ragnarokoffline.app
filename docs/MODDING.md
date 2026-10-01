# Modding

A mod is a folder. Drop it in the mods directory, restart, and it is live — no
rebuild, no compiler, no Docker.

```
<app data>/state/mods/my-mod/
├── mod.json     name, version, author, description, what it requires
├── db/          server tables: mob stats, item stats, drops, skills — new ones too
├── npc/         server scripts: NPCs, warps, monster spawns, quests
├── lua/         skill hooks: damage formulas, accuracy, what a hit does
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

Mods are applied in **name order**, unless a mod asks to come `after` another.
Two mods that ship the same server table, the same `conf/groups.yml` or an item
table are **combined**, entry by entry; only where both define the *same* entry
does the later one win. A sprite or texture two mods both replace can only be
one file, and there the later name wins. Everything is reassembled on every
start, so removing a folder removes its effects.

Where something could not be combined you are told, rather than left to wonder
why half of what you installed is not in effect:

```
mods: b gives group 0 @autoloot, which a already gives it -- left out, because
      rAthena throws away the rest of a group entry that repeats a command
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
- **`mods`** — other mods this one cannot work without, by folder name. Each
  must be installed and switched on. (Before 1.2.6 this key was refused as
  unknown, so a mod using it did not load at all.)

`"after": ["other-mod"]`, beside `requires`, is about precedence rather than
need: when both are on, this mod is applied later and wins where the two
disagree. [Publishing](mods/publishing.md) covers both.

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

### Options that change the server

A yes/no setting can also switch part of the mod's **server** config on and off,
with no code: put the files under `conf/when/<setting key>/`, and they are part
of the mod exactly while that setting is on.

```
player-commands/
├── mod.json                          declares "allow_go", a boolean
└── conf/
    ├── groups.yml                    always: @autoloot, @showexp, ...
    └── when/allow_go/groups.yml      only while "allow_go" is ticked: @go
```

The fragment is added *after* the mod's own copy of the file and combined with
it like any other copy, so it holds only what it adds. **Apply** restarts the
server, so the change takes effect then.

### Reading settings from an NPC script

A switch that loads a folder or not is all a boolean needs, but a number or a
string has to reach the script itself — a reward multiplier, a list of buffs.
Every mod's settings are available to every NPC script through one function
the app writes on each server start:

```c
.@set$ = callfunc("F_ModSetting", "standart-npc", "buffer_set", "blessing,agi");
.@rate = callfunc("F_ModSetting", "standart-npc", "gramps_rate", 1);
.@on   = callfunc("F_ModSetting", "standart-npc", "enable_buffer", 1);
```

The arguments are the mod's name, the setting's `key`, and what to use if the
mod or setting is not there — always pass it, so a script keeps working when
the mod is switched off or an older app is running it. A boolean arrives as
`1` or `0`, a number as a whole number (rAthena scripts have no fractions),
and a string as a string. These are the same checked values the client gets,
and they change on **Apply**, like everything else about the server.

Only `groups.yml`, `atcommands.yml` and files under `npc/` can be switched this
way. Put conditional NPC scripts under `npc/when/<setting key>/`; ordinary
files under `npc/` remain unconditional. A folder named for a setting the mod
does not declare, or for one that is not a boolean, is ignored and the log says
so. See
[`mods/player-commands`](../mods/player-commands).

### settingsPage — a settings window of your own

When a list of checkboxes is not enough — options in groups, one switch that
sets several, a preview — a mod can ship its own settings page:

```json
{
  "name": "settings-window",
  "settingsPage": "settings/index.html",
  "settings": [
    { "key": "greeter_north", "type": "boolean", "default": true, "label": "North greeter" },
    { "key": "greeter_south", "type": "boolean", "default": true, "label": "South greeter" }
  ]
}
```

The Mods tab then shows a **Settings…** button under the mod instead of drawing
the options itself, and the page opens in a window the mod owns. The options
are still declared in `settings` — that is what the app validates, stores and
hands to `init(parameters, api)` and `npc/when/` — the page only decides how
they are shown. It talks to the app through one object:

```js
const mod = await window.modSettings.get();
// { name, version, enabled,
//   settings: [{ key, type, value, label, description, min?, max?, maxLength? }],
//   context: { era: "renewal" | "pre-renewal", appVersion, enabledMods: [...] } }

await window.modSettings.set({ greeter_south: false }); // only keys you declared, of their declared type
await window.modSettings.apply();                        // restart the server, like Apply in the Mods tab
```

`set` takes any subset of your settings and keeps the rest as they are; a key
you did not declare, or a value of the wrong type, is refused with the reason.
`apply` resolves once the server is back up.

The window is deliberately small in what it can do. The page is served from
the mod's own folder and nothing else: it cannot load anything from the
internet or read files outside that folder, cannot open other windows or
navigate away, and cannot touch another mod's settings or any other part of
the app. Put scripts, styles, pictures and any data files in the mod folder
and link or `fetch()` them relatively. `settingsPage` must name an `.html` file inside the mod folder, or
the mod is refused with the reason.

An app too old to know `settingsPage` ignores it and draws the declared
options in the Mods tab as before. See
[`examples/mods/settings-window`](../examples/mods/settings-window).

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
[`System/`](#system--item-names-quest-text-and-descriptions), ten lines, and it is
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

## Making new things: items, monsters, and how they look

A mod can add items and monsters that exist in no client and no server, with
ids of their own. Nothing is replaced: every stock item and monster keeps its
own entry. A new thing needs up to three layers: `db/` for what it *does*,
`System/` for what the client *calls* it and *draws*, and `npc/` to put it in
the world.

[`examples/mods/custom-monster`](../examples/mods/custom-monster) has one of
each: a monster, a headgear with its own look, and a card that casts a spell.

### Ids

| | Use | Why there |
|---|---|---|
| Monsters | **25000–31998** | rAthena accepts 1001–3998 and 20021–31998 and keeps 3999–20020 for player clones. Its own monsters reach about 22700 and grow with each update. |
| Items | **50000–99999** | Item ids are 32-bit. Stock items sit below 32409 and from 100000 up, so this block is empty. |
| Headgear/garment looks (`View:`) | **5000+** | Stock view ids stop at 2822. |

Pick a number in the middle rather than the first one, since other authors
start at the start too. If two enabled mods define the same id, Settings →
Mods says so under the one whose version isn't in effect.

### A new item

`db/item_db.yml` says what it is and does; `System/itemInfo.lua` holds its
name, description and icon, **only your entries**. The app lists your table
ahead of the client's own, so nothing else changes.
[`examples/mods/custom-item`](../examples/mods/custom-item) explains the
details: which icon a resource name gives you, and how to rename a stock
item.

What an item *does* is its `Script:`, rAthena's item script. The common
forms:

| Script | Effect |
|---|---|
| `bonus bStr,5;` `bonus bMaxHPrate,10;` | stats (`doc/item_bonus.txt` in rAthena lists them all) |
| `bonus2 bAddRace,RC_Undead,20;` | +20% damage against a race |
| `bonus3 bAutoSpell,"AS_SONICBLOW",5,50;` | 5% chance to cast Sonic Blow Lv 5 **when you attack** |
| `bonus3 bAutoSpellWhenHit,"CR_REFLECTSHIELD",1,30;` | 3% chance to cast Reflect Shield **when you are hit** |
| `bonus4 bAutoSpellOnSkill,"MG_FIREBOLT","MG_COLDBOLT",3,200;` | 20% chance to follow Fire Bolt with Cold Bolt Lv 3 |
| `autobonus "{ bonus bAtk,50; }",10,5000;` | 1% on attack: +50 ATK for 5 seconds |
| `itemheal rand(120,180),0;` | a potion |

The chances in `bAutoSpell…` and `autobonus` are out of 1000. Anything a bonus can't express
("only below 30% HP", "every fifth hit") is what [Lua](#lua--changing-how-a-skill-works)
is for.

### A new monster

`db/mob_db.yml` with the new id, and a spawn in `npc/`:

```
prt_fild08,0,0	monster	Lunar Poring	25001,8,60000,30000
```

What it looks like is up to you:

- **A stock monster's look, no client change:** `db/mob_avail.yml` tells the
  server to show it as another monster.
  ```yaml
  Body:
    - Mob: LUNAR_PORING
      Sprite: POPORING
  ```
  The server sends Poporing's id, so the client never learns the new one:
  the monster's name still comes from the server, but tools that go by id
  see the stock monster.
- **Its own entry on the client:** `System/jobname.lub` maps the new id to a
  sprite, with only your rows:
  ```lua
  JobNameTable = {
  	[25001] = "LUNAR_PORING",
  }
  ```
  `LUNAR_PORING` can be a stock sprite's name (`POPORING`), or your own art
  in `data/sprite/monster/lunar_poring.spr` and `.act`. The official format,
  `System/npcidentity.lub` defining `jobtbl.JT_LUNAR_PORING = 25001` with
  `[jobtbl.JT_LUNAR_PORING]` in `jobname.lub`, works too. Add to `jobtbl`
  rather than replacing it.

### A new look for headgear, garments and weapons

An equipment item's `View:` is a number; the client turns it into a sprite
through a table, and a mod adds rows to those tables the same way:

| Equipment | Files in `System/` | Art, if it's your own |
|---|---|---|
| Headgear | `accname.lub` (+ `accessoryid.lub` for named ids) | `data/sprite/accessory/남/남_<name>.spr`, `여/여_<name>.spr` |
| Garments | `spriterobename.lub` (+ `spriterobeid.lub`) | `data/sprite/robe/…` |
| Weapons | `weapontable.lub` | `data/sprite/human/…` |

```lua
AccNameTable = {
	[5001] = "_리본",   -- Moon_Ribbon's View: 5001 looks like the Ribbon
}
```

**Save these three tables in CP949, not UTF-8,** whenever a name in them is
Korean. They name the client's own sprite files byte for byte; a UTF-8 copy
names a file that isn't there and the item is invisible on you. An ASCII
name for your own art has no such problem. The sex folders and file prefix
(`남`, `여`) have no ASCII alias yet.

### Checking your work

**Settings → Tools → Item browser** and **Monster browser** read the same
tables the client does, your mods' included: a new item appears with its
name and icon, and a new monster with its sprite and drops.

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

## lua/ — changing how a skill or item works

`db/` changes a skill's or item's numbers: cast time, cooldown, SP cost,
element, hit count, how long its status lasts. What it cannot change is the
**formula** — how much damage a skill does, from what — or what happens
when a hit lands or an attack is received. Those are C++ in the server. A
mod's `lua/` folder reaches them without a change to the server, from two
sides: `skill(...)` hooks the damage calculation and outcome of a specific
skill, and `item(...)` hooks any attack by or against the wearer of a
specific piece of equipment.

```lua
-- my-mod/lua/firebolt.lua: Fire Bolt scales with INT as well as its level.
skill("MG_FIREBOLT", {
  ratio = function(c, stock)
    return stock + c.caster.int * 2
  end,
})
```

Every `.lua` file in `lua/` (subfolders too) runs once when the server
starts, in the same order mods are applied. **Apply** restarts the server,
so an edited file takes effect then.

**Two mods can hook the same part of the same skill or item.** Both run,
in ascending priority order — a mod sets `priority = N` (0..10, default 5)
in the registration table to say where it goes in the chain; lower runs
first, ties broken by mod load order (the alphabetical order of folder
names). `ratio`, `hit` and `element` thread the value through: each hook
sees the previous one's return as `stock`, so the chain composes. `on_hit`,
`on_attack` and `on_hit_taken` run every hook; each may queue its own
drain/heal/status/polymorph actions, which are applied together once the
hit is dealt. A hook that fails is switched off and the rest of the chain
carries on.

```lua
-- my-mod/lua/firebolt.lua: run after mods using the default priority of 5.
skill("MG_FIREBOLT", {
  priority = 7,
  ratio = function(c, stock) return stock + c.caster.int * 2 end,
})
```

A mod that registers twice for the same (skill, hook) or (item, hook)
replaces its own previous entry rather than stacking against itself. The
`priority` key is optional: omit it and the default (5) is used. Priority
is per call, applying to every hook declared in that call; a mod wanting
different priorities for two hooks makes two calls.

### `skill("<AegisName>", { ... })` — the four skill hooks

Takes any of four functions, keyed by the name in `skill_db.yml` —
`MG_FIREBOLT`, not "Fire Bolt".

| Hook | Called | Return |
|---|---|---|
| `ratio(c, stock)` | when the skill's damage is calculated | the skill's damage percentage; `stock` is the running value — the server's own on the first hook in the chain, the previous hook's return thereafter |
| `hit(c, stock)` | when a weapon skill's accuracy is calculated | the hit rate bonus |
| `element(c, stock)` | when the attack's element is decided | an element, e.g. `const("ELE_FIRE")` |
| `on_hit(c)` | on every hit, once its damage is known | nothing; call the actions below |

`ratio`, `hit` and `element` receive the stock result and return a new one;
returning `nil` keeps it. They work for the roughly 1,060 skills rAthena has
given their own C++ class, which includes every damaging player skill. For
the rest, the server says so in the log when it starts, and `on_hit` still
works.

### `item("<AegisName>", { ... })` — the two equipment hooks

Takes any of two functions, keyed by the item's AegisName in
`item_db.yml` — `KNIFE`, `MOONLIGHT_DAGGER`, or a custom item a mod has
added. The hook fires for every attack by or against a unit **wearing**
that item; a mob or a player with the item in inventory but not equipped
does not fire it.

| Hook | Called | Return |
|---|---|---|
| `on_attack(c)` | when the wearer attacks (skill or normal, hit or miss), once damage is finalized | nothing; call the actions below |
| `on_hit_taken(c)` | when an attack lands or misses against the wearer, once damage is finalized | nothing; call the actions below |

Both fire for weapon attacks and skill attacks alike; `c.skill_id` is `0`
for a normal attack and the skill's id otherwise. Both fire for misses and
dodges too — gate on `c.connected` and `c.damage` if your hook only cares
about damage that landed. An item equipped in several slots (an accessory
in both rings) fires its hooks once per attack, not once per copy.

### What `c` describes

Common to every hook (skill *and* item):

| Field | Means |
|---|---|
| `c.skill` | the skill's AegisName, or `""` for a normal attack |
| `c.skill_id`, `c.skill_lv` | the skill id and the level used; `0` for a normal attack |
| `c.caster`, `c.target` | the two units (below) |
| `c:chance(n)` | true `n` times in 10000, from the server's own random numbers |

Additional fields in a damage hook (`on_hit`, `on_attack`, `on_hit_taken`):

| Field | Means |
|---|---|
| `c.damage` | the final damage this hit deals (0 if it did not connect) |
| `c.connected` | `true` if damage was applied, `false` if dodged, missed or blocked to zero |
| `c.critical` | `true` if the attack was a critical |
| `c.element` | the attack's element (an `ELE_*` constant) |
| `c.weapon_type` | `"weapon"`, `"magic"` or `"misc"` — the `BF_WEAPON`/`BF_MAGIC`/`BF_MISC` class |

Each unit (`c.caster`, `c.target`) has:

| Field | Means |
|---|---|
| `id`, `kind`, `name`, `level` | `kind` is `"pc"`, `"mob"`, `"homun"`, `"merc"`, `"elemental"`, `"pet"` or `"npc"` |
| `str` `agi` `vit` `int` `dex` `luk` | base stats |
| `hp` `maxhp` `sp` `maxsp` | current and maximum vitals |
| `race`, `element`, `size`, `boss`, `dead` | the usual flags; `boss` is true for MVPs |
| `has_status("SC_...")` | status probe, returns a boolean |

A **player** unit also has:

| Field | Means |
|---|---|
| `job`, `job_level` | job id and job level |
| `classchange` | the Hylozoist Card bonus |
| `weapon_id`, `shield_id`, `armor_id`, `shoes_id`, `robe_id` | equipped item ids; `0` when the slot is empty |
| `helm_top_id`, `helm_mid_id`, `helm_bottom_id` | the three head slots |
| `accessory_1_id`, `accessory_2_id` | the two accessory slots |

A **monster** unit also has:

| Field | Means |
|---|---|
| `mob_id` | the `mob_db.yml` id |

Unit tables are a snapshot: changing them changes nothing on the server.

### Actions you can request

In any damage hook (`on_hit`, `on_attack`, `on_hit_taken`), `c` can ask for
something to happen. It happens once the hit has been dealt, and not at all
if the unit has died by then:

| Action | What it does |
|---|---|
| `c:drain()` | apply the attacker's HP/SP drain item bonuses to this hit's damage — what a weapon attack already does. Direction is fixed (attacker drains defender) |
| `c:heal(hp, sp, who)` | restore a unit; `sp` defaults to `0`; `who` is `"caster"` (default, the attacker) or `"target"` (the defender). An `on_hit_taken` hook that restores its wearer passes `"target"` |
| `c:status("SC_STUN", rate, ms, val1, who)` | start a status; `who` is `"target"` (default) or `"caster"`; `rate` is out of 10000; `val1` defaults to `1` |
| `c:cast("MG_FIREBOLT", level, who)` | cast a skill the way `bAutoSpell` does, at `"target"` (default) or `"caster"`. No Lua hook runs during that cast, so a hook that casts a bolt cannot set itself off again. A ground skill's later ticks (Storm Gust) do run hooks: an `on_attack` that casts one should check `c.skill_id` |
| `c:polymorph()` | Hylozoist Card's effect: the target becomes a random monster. Bosses and status-immune monsters are left alone |

Three functions work anywhere:

| Function | What it does |
|---|---|
| `const("SC_STUN")` | any constant a server script can use: `SC_*`, `ELE_*`, `RC_*`, `Job_*` |
| `setting("<mod>", "<key>", default)` | a [setting](#settings--options-the-app-renders-for-you) from Settings → Mods. Booleans are `true`/`false` and numbers keep their fractions, unlike in an NPC script |
| `log(...)` | a line in the map server's log, with your mod's name on it |

### Example: a weapon that drains and strikes back

```lua
-- my-mod/lua/vampiric_blade.lua -- an item() hook combining both directions.
item("VAMPIRIC_BLADE", {
  priority = 5,

  on_attack = function(c)
    -- Honour the weapon's drain bonuses on every connecting hit, and
    -- heal an extra 10% of the damage on a critical.
    if not c.connected then return end
    c:drain()
    if c.critical then c:heal(c.damage // 10, 0) end
  end,

  on_hit_taken = function(c)
    -- Someone critted me while I was holding this. Stun them.
    if c.critical then
      c:status("SC_STUN", 10000, 2000, 1, "caster")
    end
  end,
})
```

Four complete worked examples, each showing a different gating pattern
on `item()`:

| Mod | Hooks | Fires on | Shows |
|---|---|---|---|
| [`vampiric-blade`](../examples/mods/vampiric-blade) | `on_attack` + `on_hit_taken` on a weapon | both directions | lifesteal, crit heal, retaliation stun on being critted |
| [`thorns-plate`](../examples/mods/thorns-plate) | `on_hit_taken` on armor | **physical** hits only (`c.weapon_type == "weapon"`) | filtering by attack type, delivering percent damage via `SC_BLEEDING` |
| [`arcane-ward`](../examples/mods/arcane-ward) | `on_hit_taken` on an accessory | **magical** hits only (`c.weapon_type == "magic"`) | the opposite filter, routing a `c:heal` to `"target"` so the wearer gains SP |
| [`mirage-cloak`](../examples/mods/mirage-cloak) | `on_hit_taken` on a garment | hits that **missed** (`c.connected == false`) | reacting to dodges, picking a random status with `math.random`, routing it to `"caster"` |

The four together cover the three questions an `on_hit_taken` hook
usually wants to answer: *what kind of attack was it* (`c.weapon_type`),
*did it land* (`c.connected`, `c.critical`), and *who did what to whom*
(`c.caster`, `c.target`, with every equip slot's item id on both).

### What a script cannot do

Lua here has arithmetic, strings, tables and `utf8` — nothing that reads a
file, starts a program or opens a connection (`io`, `os`, `require`, `load`
and `debug` are not there). A mod's Lua can change a fight; it cannot touch
the computer the server runs on.

A mistake costs one hook, not the server. An error, or a loop that runs past
a million instructions, turns that hook off until the next start and logs the
mod, the skill and where it went wrong:

```
[Error]: Lua: my-mod's hook for MG_FIREBOLT failed and is now off until the server restarts:
db/import/lua/my-mod/firebolt.lua:3: attempt to perform arithmetic on a nil value (field 'intt')
stack traceback:
	...
```

[`examples/mods/blaze-shield-lua`](../examples/mods/blaze-shield-lua) is a
complete one: Blaze Shield honouring drain cards and Hylozoist Card.

### A mod, or a change to the server?

Most of what people want to change is one of these, and only the last row
needs anything more than a mod:

| You want to change | Where | |
|---|---|---|
| A monster, item, drop, skill's cast time/cooldown/cost/duration | `db/` | Only the fields you name |
| An NPC, a quest, a warp, a shop, what happens on an event | `npc/` | rAthena's script language |
| A skill's damage formula, accuracy or element | `lua/` | `skill("...", { ratio, hit, element })` |
| What a skill does when it hits: drain, heal, a status, polymorph | `lua/` | `skill("...", { on_hit })` |
| What an equipped weapon or piece of armor does on an attack or an incoming hit | `lua/` | `item("...", { on_attack, on_hit_taken })` |
| A server setting from the allowlist | `conf/` | |
| Switch on one of the fork's server extensions, or set its values | `db/extension_db.yml` | `@extensions` in game lists them; `@extensioninfo <id>` shows what one does |
| How the client looks or behaves | `data/`, `System/`, `client/` | |
| **A new kind of event, a new script command, a new action for `on_hit`, or anything outside a skill** (status formulas in `status.cpp`, how monsters think) | the server | A change to [our rAthena fork](https://github.com/Flux159/rathena), made once and then usable by every mod |

That last row is the one to think about before asking for a server change:
is it really new, or is it a formula (Lua) or a number (`db/`)? When it is
new, the change adds the *capability* — an event like `OnPCDropItemEvent`, a
command like `makeitemowned`, an action like `c:polymorph()` — and what a
particular mod does with it stays in the mod.

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

**Several mods can each ship one.** Every enabled mod's `groups.yml` is combined
into the single file the server imports, in load order, and so is every
`atcommands.yml`.

**A command the group already has is left out for you.** rAthena treats a
repeated grant as an error that throws away the *whole* group entry — every
other command in it — so a mod listing `@resurrect` (group 0 already has it)
used to lose everything else it granted. The supervisor now removes a command a
group already holds, from rAthena's own `groups.yml` or from a mod applied
earlier, before the server reads it, and names each one in the log. Taking away
a command the group does not have (`go: false`) is the same error, and is
treated the same way. Aliases count: `accountinfo` is `accinfo`.

**Group 20 is taken.** The app always defines it, as *AI Agent*: the accounts
an AI agent plays on (Claude Code, Codex; Settings → Population → *Play with an
AI agent*). It is a player's permissions plus `@warp`, `@go` and `@load`, and
it is read before any mod's file. Give your own groups another id. A mod that
lists group 20 adds its commands to the agents rather than making a group of
its own; one that removes commands from it can stop the agents travelling.

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
| `data/palette/body/…` | `data/palette/몸/…` |
| `data/palette/hair/…`, `palette/doram/hair/…` | `data/palette/머리/…`, `data/palette/도람족/머리/…` |

This matters more than tidiness: **a zip containing those bytes unpacks
differently on different machines**, so a mod that ships them arrives corrupted
for some people. A mod written in ASCII travels.

Only whole path segments are translated, and only at the start — a folder of
your own called `sprite/monsters` is left alone. The real names still work if
you prefer them; nothing is rewritten on the way out.

### Or write it in Korean

Anything not in that table — a job's palette, a monster's sprite file — can be
written **in Korean**, folder or file name, anywhere in the path:

```
my-mod/data/palette/body/로그_여_4.pal
my-mod/data/sprite/monster/포링.spr
```

The app puts every Hangul syllable into the client's CP949 spelling as it lays
the mod down, so those land on `palette/¸ö/·Î±×_¿©_4.pal` and
`sprite/¸ó½ºÅÍ/Æ÷¸µ.spr` — the names the client asks for. Korean in a zip
travels the way ASCII does, which the mojibake spelling does not. A name already
in the client's spelling is left alone, so existing mods are unaffected.

### Palettes

A character's colours are a palette file per job, sex and colour number, and
the stylist's colour choices are those numbers:

| | path |
|---|---|
| clothes | `data/palette/body/<job>_<sex>_<n>.pal` |
| hair | `data/palette/hair/머리<style>_<sex>_<n>.pal` |

`<sex>` is `남` (male) or `여` (female), and `<job>` is the job's Korean name as
the client spells it — `로그` for Rogue, `스토커` for Stalker; the full list is
`PalNameTable.js` and `JobNameTable.js` in roBrowserLegacy's `src/DB/Jobs/`.
Colour 0 is the sprite's own.

**A missing palette is the default colour, silently.** The client draws the
sprite's built-in palette when the file is not there, and says nothing. The
official data does not have every colour for every job — Rogue has 1 to 3 —
while the stylist offers up to the server's `max_cloth_color` (7), so choices 4
to 7 look like the default until a mod supplies `로그_남_4.pal` through
`로그_여_7.pal`. `state/assets/logs/missing-files.log` names every palette the
client asked for and did not get.

A `.pal` is 1024 bytes: 256 colours of red, green, blue and one unused byte,
with colour 0 transparent. Start from one of the job's existing colours.

**Do not put them in `state/assets/data/palette/` directly.** That folder is
rebuilt from nothing every time the app starts — which is why files put there
keep disappearing. A mod's `data/` is the place that lasts.

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

## System/ — item names, quest text and descriptions

`System/` is merged over the client's tables *after* the English translation,
so a mod wins. This is where `itemInfo.lua` goes if your mod adds items and
wants them named in the client.

**Item tables are the exception: they are added, not replaced.** The
translation's `itemInfo.lua` is 22 MB, so replacing it to add one item would
mean a 22 MB mod. Instead, ship a `System/itemInfo.lua` containing only your
items:

```lua
-- my-mod/System/itemInfo.lua, saved as UTF-8
tbl = {
	[30001] = {
		unidentifiedDisplayName = "Bottle",
		unidentifiedResourceName = "빨간포션",
		identifiedDisplayName = "Islander Brew",
		identifiedResourceName = "빨간포션",
		identifiedDescriptionName = { "Restores a fair amount of ^0000FFHP^000000." },
		slotCount = 0,
		ClassNum = 0
	}
}
```

- **No footer.** The client registers every entry itself. `tbl`, `tbl_custom`
  and `tbl_override` all work, so the translation's `itemInfo_C.lua` template
  can be copied as it is.
- **An entry needs `identifiedDisplayName`.** Everything else is optional.
- **Save it as UTF-8**, which is what an editor does anyway. Names and
  descriptions can then hold any character.
- **The resource name is the art.** It names the inventory icon
  (`data/texture/ui/item/<name>.bmp`), the item window's picture
  (`…/ui/collection/<name>.bmp`) and the dropped sprite
  (`data/sprite/item/<name>.spr`). Write an existing item's in Korean to borrow
  its art — `빨간포션` is the Red Potion — or ship your own under an ASCII name.
  An apple icon means the name matched no file; `missing-files.log` names the
  one the client asked for.

The app copies each item table directly under `System/` aside as
`itemInfo-<mod>.lua` (a second one in the same mod gets `itemInfo-<mod>.2.lua`)
and lists them in the client's `customItemInfo` **ahead of the base table,
last mod first**. The client takes each item from the first table that defines
it, so a mod's entry wins over the stock one — which is how a mod renames an
existing item — and a later mod wins over an earlier one, as in `db/`.

A table anywhere else — `System/LuaFiles514/`, `data/luafiles514/` — is not
read by the client, and the log says so. Editing the copy under
`state/assets/System/` does not last: that folder is rebuilt on every start.

See [`examples/mods/custom-item`](../examples/mods/custom-item).

**Quest tables are added too.** A `System/OngoingQuestInfoList.lub` holding
only your quests gives them their titles, summaries and descriptions in the
quest window, and every other quest keeps its own:

```lua
-- my-mod/System/OngoingQuestInfoList.lub
QuestInfoList = {
	[70001] = {
		Title = "The Islander's Errand",
		Summary = "Bring Hana 10 Jellopies.",
		IconName = "ico_nq.bmp",
		Description = { "Hana in Alberta needs ^0000FF10 Jellopies^000000." },
		RewardEXP = "1000",
		RewardJEXP = "500",
		RewardItemList = { { ItemID = 501, ItemNum = 5 } },
	},
}
```

The quest id is the one your script gives `setquest`, and its hunting targets
come from your mod's `db/quest_db.yml`, not from this file. Write the
text in ASCII: the client reads quest tables in its own codepage, not as
UTF-8. The app copies each table aside as `OngoingQuestInfoList-<mod>.lub` and
lists them in the client's `customQuestInfo`, which loads **after** the base,
in mod order, the last definition of a quest winning.

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
| `api.on(event, listener, { replay: true })` | Returns an unsubscribe function; subscriptions also end at disposal. Events: `map:enter`, `map:leave`, `connection`, `ui:append`, `ui:remove`, `movement:clear`, `preferences:change`, and `item:use` (`{ itemId }`, the item's id, sent when the client asks to use it -- before the server says whether it worked). |
| `api.snapshot()` | Frozen copy of map, connection, player position/HP/SP, selected target identity/name/HP, camera, packet version and movement counters. Server movement acknowledgements are read-only evidence. |
| `api.components.current()` | Mounted `{ name, root, host }` descriptors. DOM references support styling; do not retain detached components after `ui:remove`. |
| `api.preferences.get(key, fallback)` / `.set(key, value)` | JSON values isolated by plugin, browser and server origin. Storage failure is reported by `set`. Do not store secrets. |
| `api.movement.register(name, onCancel)` | Returns `begin(x,y)`, `update(x,y)`, `end()`, `dispose()`. Screen-up is positive Y. Only a deliberate `begin` can take ownership; a stale `update` cannot. |
| `api.input.state()` / `.shortcutConflict(keyCode)` | Read input eligibility and the active native battle-shortcut mapping. |
| `api.input.suspend()` | Suspend movement while showing a plugin dialog. Returns an idempotent release function, also released at disposal. |
| `api.actions.perform(name, payload)` | Native actions: `attack`, `target` (toggle auto-target), `interact`, `pickup`, `menu` (game options), `shortcut` with `{ index: 0…35 }`, `shortcut:assign` and `storage:transfer` (below), or `window` with an allowed `{ name }`. Returns whether the action was dispatched, not whether the server accepted it. |
| `api.targeting.pick({ type, label })` | Raises the client's own target cursor and resolves to a frozen `{ classId, gid, name, kind }` for what the player clicks, or `null` for ESC, empty ground, a client too old to offer it, or the player starting a skill of their own (their action wins). `type` is `mob` (default), `player` or `any`; NPCs cannot be picked. One pick at a time: a new one cancels the last, and so does disposal. |
| `api.server.command(text)` | Sends an `@` or `#` command as if the player had typed it in chat, so the server allows exactly what the player's group allows. Anything else is refused; returns whether it was sent. |
| `api.graphics.registerPass({ name, fragment, uniforms, enabled })` | A full-screen GLSL pass over each frame, after bloom and before anti-aliasing. Returns a function that removes it; it also goes when the plugin does. See [Graphics passes](#graphics-passes). |
| `api.ui.window({ id, title, width, height, resizable })` | A window of the plugin's own; fill its `body`. `show`, `hide`, `toggle`, `isOpen`, `setTitle`, `onClose`. See [Windows and server requests](#windows-and-server-requests). |
| `api.items.search(text, limit)` / `.get(id)` / `.icon(id)` | Items from the client's own tables, mods' included: `{ id, name, description, slots }`, and an icon URL for an `<img>`. |
| `api.server.request(command, text, { timeout })` | Ask the mod's server script for something; resolves with its answer. See [Windows and server requests](#windows-and-server-requests). |
| `api.cleanup(fn)` | Register idempotent cleanup immediately after allocating a resource. The returned function can release it early. Runs on failure, scope replacement and page teardown. |

### Graphics passes

`api.graphics.registerPass` runs a GLSL fragment shader over every frame of the
3D view. Write `void main()` and set `fragColor`; everything else is provided:

| | |
|---|---|
| `vUv` | where on screen, 0..1 |
| `uTexture` | the frame so far |
| `uDepth`, `uHasDepth`, `linearDepth(uv)` | the scene's depth, and the distance from the camera at a point. `uHasDepth` is false on WebGL 1, where there is none |
| `uResolution`, `uTime` | pixels, seconds |
| `uSunDirection`, `uSunColor`, `uAmbient` | the map's light |
| `uLights[i]`, `uLightColors[i]`, `uLightCount` | up to 32 of the map's lamps and torches already on screen: `xy` position, `z` radius, nearest first |

```js
export default function init(parameters, api) {
    api.graphics.registerPass({
        name: 'Sepia',
        fragment: `
            uniform float uAmount;
            void main() {
                vec3 c = texture(uTexture, vUv).rgb;
                vec3 sepia = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
                fragColor = vec4(mix(c, sepia, uAmount), 1.0);
            }`,
        uniforms: () => ({ uAmount: parameters.amount / 100 }),
    });
}
```

Some things have to be drawn inside the 3D scene rather than over the
finished frame: grass among the models, other water, a shadow map. A
**map hook** does that, with `api.graphics.hook`:

```js
api.graphics.hook({
    name: 'Grass',
    init(gl, map) { /* the map's ground is ready: build buffers */ },
    render(stage, ctx) { if (stage === 'models') { /* draw */ } },
    free(gl) { /* the map, or the mod, is going away: delete what you made */ },
});
```

| | |
|---|---|
| `render(stage, ctx)` | each frame, at each stage: `'begin'` before the ground (draw into targets of your own, then `ctx.restoreTarget()`), `'ground'` the ground is drawn, `'models'` the map's models are drawn and the sprites not yet, `'end'` everything is drawn. With `replaces: ['water']`, also `'water'`, where you draw the water in the client's place |
| `ctx` | `gl`, `modelView`, `projection`, `fog`, `light`, `tick`, `player` (position), `lightmap`, and `drawScene(view, projection)` (sky, ground and models again, depth tested, into whatever is bound), `drawModelsDepth(program)` (the models with your program: `aPosition`, `aTextureCoord`), `restoreTarget()`, `createProgram(vertex, fragment)` |
| `init(gl, map)` | `map`: `name`, `width`, `height`; per ground cell `cellTexture`, `cellHeights`, `cellUv`; `textureNames`; `groundTextures()` (atlas, lightmap); `water()` (mesh, animation frames, waves, level; `null` without water); `altitude` (`cellType`, `cellHeight`, `TYPE`); `lights` |
| `light(light)` | return `{ ambient: [r,g,b], diffuse: [r,g,b] }` to light this frame with a sun and sky of your own (a warmer sun, a cooler sky), `null` for the map's |
| `free(gl)` | delete every buffer, texture, program and framebuffer you made: the map is going away, or your mod is |

A hook that throws is taken out (and freed), and says so in the console; it
never takes the frame down. Hooks go with the mod that added them.

Lighting per map, for instance -- warm in the fields, the map's own
underground:

```js
let sun = null;
api.on('map:enter', ({ name }) => {
    sun = name.includes('_dun') ? null : { ambient: [0.16, 0.2, 0.3], diffuse: [1.1, 0.92, 0.68] };
});
api.graphics.hook({ name: 'Sunlight', light: () => sun });
```

**glTF models in place of the map's.** `api.models.replace` draws a glTF
2.0 model (`.glb`, or `.gltf` with its files beside it) wherever a map
places one of the client's own models:

```js
const here = file => new URL(file, import.meta.url).href;   // beside index.js
api.models.replace({
    '나무잡초꽃/나무01.rsm': { url: here('tree_oak.glb'), size: 1, colors: { leafsGreen: [0.33, 0.55, 0.2] } },
});
```

The key is the model's file under `data/model/` (Korean and all, `/` or
`\`). Every placement, on every map, gets the glTF instead: fitted to the
original's height (`size` multiplies that; `scale` sets an exact scale),
standing on its base, turned as it was, and lit by the map's sun, ambient
light and fog. `colors` replaces named materials' base colour. It applies
to maps loaded after the call, so call it when the plugin starts.

Supported: triangle meshes with normals and texture coordinates, node
hierarchies, base colour factors and textures, alpha mask and blend. Not
skins, animation, morph targets or extensions. Keep models light -- a
field may place the same tree a few hundred times (they are instanced: one
draw per material). `examples/mods/gltf-trees` replaces two field trees
with Kenney's Nature Kit trees (CC0).

**Higher-resolution textures.** A texture pack replaces a texture by
shipping a larger file at the same path, e.g.
`data/texture/필드바닥/prt_흙02.bmp` at 1024x1024 (the Korean path is the
client's own; `link-assets` serves it the way the client asks for it). The
client shrinks every ground texture to 256x256 in the map's atlas; with
Graphics+ "High-resolution ground" on, the atlas is rebuilt at up to four
times that, capped at 4096x4096 (every texture in the atlas is scaled, so a
map with many textures gets 512). The gain shows close up: at the default
zoom a ground tile is about 64 pixels on screen. Replace a map's whole set,
including the hand-painted edge tiles, or the new texture's tile shows next
to the old ones. `examples/mods/hd-ground-texture` replaces Prontera field
dirt with a CC0 texture from ambientCG.

Graphics+ is the worked example: its grass (`grass.js`), water and
reflections (`water.js`, `reflection.js`) and shadows (`shadows.js`) are
each a map hook. Its sunlight is the example above as settings: off
everywhere by default, "Warm sunlight" to turn it on for every map, and
"Sunlight per map" for the exceptions -- `izlude:100 prt_fild*:80` to warm
only those maps, or `*_dun*:0` to leave dungeons alone when it is on
everywhere.

`uniforms()` is called every frame and returns your own uniforms by name
(numbers, or arrays of 2, 3, 4 or 16). `enabled()` turns the pass off without
removing it. A shader that doesn't compile is reported in the client log and
stays off; it can't affect anything outside the picture.
[`mods/graphics-plus`](../mods/graphics-plus) is a complete one: grading,
lamp glow, haze, tone mapping and more in a single pass.

### Windows and server requests

`api.ui.window` gives a plugin a window in the game's style: a title bar to
drag it by, a close button, a corner to resize it, and a `body` element that is
the plugin's to fill. It sits in its own shadow root, so a mod's CSS and the
game's never meet. The game remembers where the player left it, and typing in
it doesn't move the character or fire shortcuts.

```js
const win = api.ui.window({ id: 'notes', title: 'Notes', width: 300, height: 200 });
win.body.innerHTML = '<textarea style="width:100%;height:100%"></textarea>';
win.show();
```

When a window needs something only the server knows, `api.server.request`
asks the mod's own NPC script. The script binds an @command and answers with
`dispbottom` lines in a fixed form; the client collects them, hands their text
to the plugin, and keeps them out of chat:

```c
-	script	MyMod	-1,{
OnInit:
	bindatcmd "mymod", strnpcinfo(3) + "::OnQuery", 0, 99;
	end;
OnQuery:
	// .@atcmd_parameters$[0] is the request's number; the rest is what the plugin sent.
	dispbottom "@@reply " + .@atcmd_parameters$[0] + " 1/1 " + getmonsterinfo(.@atcmd_parameters$[1], MOB_LV);
	end;
}
```

```js
const level = await api.server.request('mymod', 'Poring');   // "1"
```

A long answer can be split: `@@reply <n> 1/3 …`, `2/3 …`, `3/3 …`, and the
parts are joined in order. A request that gets no answer rejects after its
timeout (5 seconds by default). Only the server can send these lines, because
anything a player says arrives with their name in front of it.
[`mods/ingame-database`](../mods/ingame-database) is a complete one: an item
and monster lookup window.

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

**To have it listed in the app instead**, so anyone can find and install it
from Settings → Mods, it goes in this repository and the pull request is the
review: **[docs/mods/publishing.md](mods/publishing.md)**. No zip is involved
there — the app downloads the reviewed folder file by file and checks every one
against its digest.
