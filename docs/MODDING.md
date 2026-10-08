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
├── client/      a roBrowser plugin: styling, viewport, UI
└── host/        a host route: JavaScript that answers requests on the host's computer
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
- **`client`** — which game client's files the mod is for: `"kRO"`, or a list
  like `["kRO", "jRO"]`. On another client the mod isn't applied, and Settings
  → Mods says why ("is for kRO, and this client is iRO"). See
  [Mods for one client](#mods-for-one-client). An app from before this key
  refuses the whole mod, naming the key, so the player knows to update.

`"after": ["other-mod"]`, beside `requires`, is about precedence rather than
need: when both are on, this mod is applied later and wins where the two
disagree. [Adding a mod to the registry](MOD_REGISTRY.md) covers both.

`"kind": "skin"` or `"kind": "cursor"` marks a mod as one of a set of which
only one is on at a time: switching it on switches every other mod of the same
kind off. It is for mods that replace the same files as each other — every UI
skin overlays the whole interface folder — where two at once would be a
patchwork. Any other value is refused by name; leave it out for everything
else. See [UI skins](#ui-skins). (An app from before
this key ignores it, so a skin still loads there, just without the others
being switched off.)

`"host"` declares a [host route](#host-routes): JavaScript of the mod's own
that runs on the host's computer, and the addresses it may connect to.

`"maps"` gives maps a sky, clouds, weather and music, by map name:
`"maps": { "my_isle": { "sky": [0.4, 0.6, 0.8], "clouds": [1, 1, 1], "bgm": "my_isle.mp3" } }`.
It is how a custom map gets anything but black behind it and the default track;
see [Custom maps](mods/CUSTOM_MAPS.md#the-sky-the-weather-and-the-music).

### Mods for one client

Players host with different clients' files: kRO's, iRO's, others. Most mods
don't care, but some ship data that only matches one client. An `iteminfo.lua`
made for kRO's item tables, for example, overwrites the descriptions and art
of iRO's own items, which an iRO player sees as a broken cash shop.

The app reads which client the player has from their `data.grf`, and Settings
→ General → Client shows it: `iRO (from data.grf)`. (It comes from the
message table every client ships, `msgstring_kr.lub` in kRO, `msgstring_us.lub`
in iRO. The GRF's header can't tell them apart.)

- **Only for one client:** `"requires": { "client": "kRO" }`. Anywhere else
  the mod is not applied, and says why.
- **Different files per client:** `clientFolders`, laid out and applied like
  [era folders](#renewalfolder--prerenewalfolder--one-mod-for-both-eras), last,
  so the client's copy of a file wins over the mod's own and its era's:

  ```json
  {
    "name": "item-art",
    "clientFolders": { "kRO": "kro", "iRO": "iro" }
  }
  ```

  ```
  item-art/
  ├── mod.json
  ├── System/itemInfo.lua          every client, unless its folder has its own
  ├── kro/System/itemInfo.lua      kRO: kRO's item tables, with the mod's items
  └── iro/System/itemInfo.lua      iRO: iRO's
  ```

Names are compared without regard to case. The app knows `kRO`, `iRO`, `bRO`,
`jRO`, `twRO`, `thRO`, `idRO`, `pRO`, `ruRO`, `cRO` and `vRO`. When it can't
tell which client the files are (no message table, or one it doesn't know),
nothing is refused: the mod may well be right for it. Diagnostics and the log
say what was detected.

There is no client version to require: a GRF doesn't record its date. When a
mod needs data only newer clients have, say so in its description and check
for the file in a script, rather than assuming a date.

An app from before `clientFolders` ignores it and reads only the mod's own
folders; `requires.client` makes such an app refuse the mod by name.

### renewalFolder / prerenewalFolder — one mod for both eras

Some files only work in one era. An item script that calls a renewal-only
command, a monster with renewal-only stats, an NPC that warps to a renewal map:
in the other era the server refuses the table or the script and says so on
every start. `requires.era` keeps such a mod out of the other era entirely.
When most of the mod works in both and only a few files differ, name a folder
for each era instead:

```json
{
  "name": "my-island",
  "renewalFolder": "renewal",
  "prerenewalFolder": "pre-renewal"
}
```

```
my-island/
├── mod.json
├── db/item_db.yml              both eras, unless the era folder has its own
├── npc/ferry.txt               both eras
├── renewal/
│   ├── db/item_db.yml          renewal only: replaces db/item_db.yml
│   └── npc/renewal-quest.txt   renewal only: added to npc/
└── pre-renewal/
    └── db/item_db.yml          pre-renewal only: replaces db/item_db.yml
```

An era folder is laid out like the mod itself, with the same `db/`, `npc/`,
`conf/`, `lua/`, `data/`, `System/`, `BGM/` and `client/` folders, and
everything in this guide applies inside it. While its era is running it is
applied **over** the mod's own folders. A file at the same path replaces the
mod's copy (`renewal/db/item_db.yml` is the item table, not an addition to
`db/item_db.yml`), and anything else is added. The other era's folder is not
read at all. You may declare either key or both; with neither, nothing changes.
Switching era in Settings is enough to switch which copy is in effect.

Each value must be a folder inside the mod, written with forward slashes. It
cannot be one of the layer folders themselves (`"db"` is refused), and a name
that is not there is refused with the reason. An app from before 1.4.3 ignores
both keys and reads only the mod's own folders, so a mod relying on them should
say `"requires": { "app": ">=1.4.3" }`.

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
digits or underscores.

**A mod may declare at most 40 settings.** The app refuses a `mod.json` with
more ("a mod may declare at most 40 settings"), and a
[settings page](#settingspage--a-settings-window-of-your-own) does not lift
the limit: it shows the same declared settings. If you need more, in order of
preference:

- **Split the mod.** Options that turn separate features on and off usually
  mean separate mods, each with its own few settings. A mod that needs another
  says so with `requires.mods`, and a mod that only bundles others can list
  them there too.
- **Use fewer, broader settings.** One `number` setting can choose between
  presets ("Market pace: 1 slow, 2 normal, 3 busy"), and one `string`
  setting can hold a short list your scripts split (up to 200 characters).
- **For options only the client uses**, keep them in
  [`api.preferences`](#client-api-1) from your client code. They have no
  count limit, but they're per player and per browser, the server never sees
  them, and the Mods tab doesn't show them.

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

The same `when/<setting key>/` folder works in four layers:

| Folder | What it switches |
|---|---|
| `conf/when/<key>/` | `groups.yml` and `atcommands.yml` only |
| `npc/when/<key>/` | scripts, loaded only while the setting is on |
| `db/when/<key>/` | tables, added to the mod's own copy of the same table (1.4.3) |
| `lua/when/<key>/` | skill and item hooks, run only while the setting is on (1.4.3) |

Files outside `when/` stay unconditional. A folder named for a setting the mod
does not declare, or for one that is not a boolean, is ignored, and the log
says so. See [`mods/player-commands`](../mods/player-commands), and
[Several hooks in one mod](#several-hooks-in-one-mod-each-with-its-own-checkbox)
for `lua/` and `db/`. Inside an [era folder](#renewalfolder--prerenewalfolder--one-mod-for-both-eras)
the same switches work the same way.

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

The mod's row in the Mods tab then shows a **Settings…** button instead of drawing
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

So a settings page can't hold more options than `settings` declares, and the
[40-setting limit](#settings--options-the-app-renders-for-you) applies to it as
well. A page changes how the options look, not how many there are.
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

**Settings → Mods → Add mod from folder…** takes a folder, a `.zip` or a `.rar` and
puts it in the right place. An archive must contain exactly one folder, named
for the mod; anything with two top-level folders, a link, or a path that would
escape the mods directory, is refused rather than unpacked.

What the file is decides how it is opened, not its extension: a RAR named
`.zip` opens as a RAR. A zip opens everywhere. A RAR is opened with
libarchive's `bsdtar`, which macOS and Windows 10 and 11 have built in; on
Linux install it first (`libarchive-tools` on Debian and Ubuntu, `libarchive`
on Arch and SteamOS) or unpack the archive and choose the folder.

Or do it by hand: drop the folder in the mods directory yourself. Same result.

A UI skin or a cursor pack in the official client's format is not a mod yet;
**Add UI skin…** makes it one. See [UI skins](#ui-skins).

A mod adds scripts and tables to your server and can run JavaScript in the game
window. Installing one is running somebody's code — install ones you trust.

A mod installed from Find Mods is offered its updates on Settings → Mods →
Updates, with what changed: for a mod in the mod list, the sections of its
`CHANGELOG.md` for every version since the installed one; for a mod from its
own GitHub repository, the notes of every release since then. See
[CHANGELOG.md](MOD_REGISTRY.md#changelogmd-what-each-version-changed) and
[How updates reach players](MOD_REGISTRY.md#how-updates-reach-players).

## Turning mods off

Settings → Mods → Installed lists what is installed with a switch each. Under the hood
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

**How recruited companions fight** is a table a mod can ship as well:
`db/population_strategy.yml` gives them per-monster, per-job and per-build rules,
with strategies they switch between.
[docs/mods/companion-strategies/](mods/companion-strategies/README.md) is its
reference. [`examples/mods/companion-roles`](../examples/mods/companion-roles)
is what each kind of companion does at any boss, and
[`examples/mods/companion-tactics`](../examples/mods/companion-tactics) adds
particular bosses on top.

**[docs/mods/ai-characters.md](mods/ai-characters.md)** is the full reference:
every key, how the headcount is divided between maps, which tables are still
unreachable, and the two ways this data fails without the server saying
anything.

### Directing an AI character from a script

A script can take one AI character away from the engine for a while and drive
it with the stock `unitwalk`, `unittalk`, `emotion` and `unitskilluseid`
commands: a shell that says "gz" when you level, a wizard that walls off a
gate, a rival who turns up while you grind. Nine `population_*` commands find
shells, hold and release them, spawn a particular one, remove one, and tell
your script when someone whispers it or when its follow loses you.

**[docs/mods/shell-control.md](mods/shell-control.md)** is the reference, and
[examples/mods/shell-gz](../examples/mods/shell-gz) is a working start.

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
("only below 30% HP", "every fifth hit") is what [Lua](#lua--changing-how-a-skill-or-item-works)
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
| Weapons | `weapontable.lub` | one per class: see [A new weapon look](#a-new-weapon-look) |

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

### Which id to use

Every NPC and monster has a number, its **view id**, and the server and the
client each check it against fixed ranges. An id outside them still loads, but
the thing is invisible or drawn as something else:

| What | Server accepts (rAthena) | Client draws it as | Use for your own |
|---|---|---|---|
| NPC | 46–~129, 401–999, 10001–19999 (`npcdb_checkid`, `src/map/npc.hpp`) | an NPC, from `data/sprite/npc/`, for 46–129, 401–999 and 10001–**19998** (`DB.isNPC`) | **19000–19998**: official NPCs stop around 13000 |
| Monster | 1001–3999 and 20020–31999 (`mobdb_checkid`, `src/map/mob.cpp`) | a monster, from `data/sprite/몬스터/` (any id that is not a player, NPC, homunculus or mercenary) | **25000–31999**: official monsters stop around 22300 |
| Player jobs | 0–44, 4001–4361 | a player | — |
| Homunculus / mercenary | 6001–6052 | from `data/sprite/homun/`, the human folder | — |

Two consequences worth knowing:

- An NPC's sprite comes from `data/sprite/npc/` only if its id is an NPC id.
  Give an NPC script a monster id (`25001,{`) and the server accepts it as a
  monster's look, and the client draws it from the **monster** folder.
- Ids 4000–20019 that aren't NPCs are rAthena's clone range; don't use them for
  monsters.

### A new NPC with its own sprite

Three files in your mod, plus the art. The worked example is
[`examples/mods/custom-npc-sprite`](../examples/mods/custom-npc-sprite): an NPC
in Prontera drawn from a PNG.

```
my-mod/
├── mod.json
├── npc/guide.txt                    the NPC: where it stands, what it says
├── System/jobname.lub               id 19500 → sprite name RO_GUIDE
└── data/sprite/npc/ro_guide.spr     the pictures
    data/sprite/npc/ro_guide.act     how to show them
```

**1. Pick an id** from the NPC column above: say `19500`.

**2. Name its sprite** in `System/jobname.lub`, with only your rows:

```lua
JobNameTable = {
	[19500] = "RO_GUIDE",
}
```

The app adds your rows to the client's own table, so nothing else changes. The
client lower-cases the name and loads `data/sprite/npc/ro_guide.spr` and
`.act`. A numeric key is enough; you don't need `npcidentity.lub` for an NPC.
To reuse a stock NPC's look under a new id instead, put its name here
(`"4_F_KAFRA1"`) and skip the art.

**3. Make the art**: `data/sprite/npc/ro_guide.spr` and `.act`. See the next
section.

**4. Place the NPC** in `npc/guide.txt`, with the id as its sprite:

```
prontera,156,197,4	script	Ro the Guide	19500,{
	mes "[Ro the Guide]";
	mes "Hello! I am drawn with a sprite of my own.";
	close;
}
```

Fields are separated by **tabs**. `4` is the direction it faces, in
rAthena's numbering: 0 north, 2 west, 4 south (towards the player), 6 east.

**5. Install and look.** Install the mod (Settings → Mods), restart the
server, and walk there. If the name floats with no body, see "When it doesn't
show" below.

### Making the .spr and .act

A Ragnarok sprite is two files with the same name:

- **`.spr`**: the pictures. Each frame is a palette-indexed image of up to 256
  colours. Colour 0 is the transparent background, magenta in the stock files.
- **`.act`**: the animation. A list of actions, each one an animation for one
  facing direction. NPCs use the first eight actions: standing, one per
  direction (0 south, 1 south-west, … 7 south-east). Monsters also use walk,
  attack, hurt and die, eight directions each.

**From a PNG**, with no other tools, use `scripts/mksprite.py` in this
repository (Python 3, no packages):

```
python3 scripts/mksprite.py guide.png --out my-mod/data/sprite/npc/ro_guide
python3 scripts/mksprite.py frame1.png frame2.png frame3.png --delay 200 --out my-mod/data/sprite/npc/ro_guide
python3 scripts/mksprite.py my_monster.png --monster --out my-mod/data/sprite/monster/my_monster
```

- Use a transparent background. Pixels under half opacity become the
  background.
- The bottom edge of the picture is where the NPC stands, and it is centred
  on its cell.
- Every direction shows the same picture; that suits most NPCs.
- Several PNGs play as an animation, `--delay` milliseconds per frame, 150 by
  default.
- Up to 255 colours. Pixel art comes through exactly; a picture with more
  colours is reduced, so flat colours look best.
- The stock NPCs are about 40–60 px wide and 70–110 px tall. The example is
  40×76.

**With an editor**, for different art per direction or per action, use the
community's **Act Editor** (Tokeiburu's, "ActEditor" on GitHub). It opens a
`.spr` and `.act` pair, imports PNGs as frames, and edits each action and
direction. The easy start is a file from `mksprite.py`, or a stock NPC's pair.
Get a stock pair from your client's `data.grf` with **GRF Editor** (also by
Tokeiburu): they're under `data/sprite/npc/`. Save under your own name; don't
overwrite the stock file unless you mean to replace that NPC everywhere.

### When it doesn't show

| What you see | Why |
|---|---|
| The name, no body | The client didn't find the sprite. **Settings → Tools → Log viewer** names the file it asked for. Check the folder (`data/sprite/npc/`), and the name in lower case, matching `jobname.lub`. |
| A different NPC or a Poring | The id isn't in the client's NPC range, so it was drawn as a monster, or the `jobname.lub` row is missing. |
| Nothing at all, and `npc_parseview: Invalid NPC constant` in the map log | The sprite field isn't a number or a known constant. |
| The old picture after you changed the art | The client caches sprites by file name. Restart the app; changing mods clears the cache, editing a file inside an installed mod may not. |

### A new weapon look

A weapon is not one picture. It is drawn as a layer over the character, frame
for frame with the body's own attack, walk and sit animations. So each weapon
look is **a sprite per class line and sex**, in that class's own folder:

```
data/sprite/인간족/로그/로그_여_단검.spr     Rogue, female, dagger
data/sprite/인간족/기사/기사_남_검.spr       Knight, male, sword
```

Each class's sprite is shaped to that class's own motions. Three ways to give
an item a look, from least work to most:

**1. Look like a stock weapon.** No art: in the item's `System/itemInfo.lua`
entry, set `ClassNum` to that weapon type's look. 1 is a dagger, 2 a sword, 4 a
spear, 6 an axe, 8 a mace, 10 a rod, 11 a bow, and so on (the list is
`WeaponType.js` in roBrowserLegacy). An official look's id works too: 31–102 in
the client's `weapontable.lub`, e.g. Main Gauche, Lacma.

**2. A recoloured stock weapon, for every class at once.** `scripts/mkweapon.py`
takes one stock weapon type's sprites for every class from your running game,
recolours them, and writes them into your mod with a new name. Only the
colours change, so every class's animation stays right:

```
python3 scripts/mkweapon.py --type shortsword --name jade --look 5001 \
    --hue 150 --saturation 1.3 --mod my-mod
```

- `--type`: the stock type to start from: `shortsword` (dagger), `sword`,
  `twohandsword`, `spear`, `axe`, `mace`, `rod`, `bow`, `knukle`, `instrument`,
  `whip`, `book`, `katar`, `gun_handgun`, … (`--help` lists them).
- `--name`: your look's name, in ASCII. Files are `<class>_<sex>_<name>.spr`.
- `--look`: the new look id, which items use as `ClassNum`. **Use 103 or
  more**; 0–102 are official. This guide uses 5000–5999. It needs app 1.4.7 or
  later, whose client draws a mod's looks above 102 (roBrowserLegacy#61).
- `--hue` turns the colour wheel by that many degrees. `--saturation` and
  `--lightness` scale those (1.0 = unchanged).

It writes the sprites under `data/sprite/human/`, the app's ASCII name for
`인간족`. One pair goes in per class and sex that has that weapon type: 52 for a
dagger with the iRO data. It also writes `System/weapontable.lub`:

```lua
WeaponNameTable = {
	[5001] = "_jade",          -- the sprite name: <class>_<sex>_jade.spr
}
Expansion_Weapon_IDs = {
	[5001] = 1,                -- attacks like a dagger (WeaponType 1)
}
```

Then the item. In `db/item_db.yml` leave **`View:` out**. Without it the
server sends the item's own id, and the client reads `ClassNum` from
`itemInfo`. With `View: 5001` the server sends 5001 itself, which the client
reads as item 5001, a stock headgear:

```lua
-- System/itemInfo.lua
[50101] = {
	identifiedDisplayName = "Jade Dagger",
	identifiedResourceName = "나이프",   -- icon and dropped picture: the Knife's
	-- ...
	ClassNum = 5001
}
```

The sprites are recoloured copies of your client's own, so don't put them in a
public mod repository. A mod for others can ship `weapontable.lub`, the item
and the command line, and let each player run it. The worked example does
this: [`examples/mods/custom-weapon-look`](../examples/mods/custom-weapon-look).

**3. New art.** Same `weapontable.lub` and item as in 2, but you draw each
class's sprite yourself. Start from the stock `.act` for that class and weapon
type, so the frames line up. Open it in Act Editor and redraw the frames, one
class at a time. A class you don't make a sprite for holds nothing: the weapon
is invisible on that class.

**Checking it:** `@item 50101`, equip it, and attack something. A dagger is
small and only clearly visible mid-swing. If the character holds nothing, the
Log viewer names the sprite the client asked for. Check the class folder, the
sex (`남` male, `여` female) and `_<name>` against your `weapontable.lub`.

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

How *many* monsters a map's stock spawns put out can be changed, though, from a
script: the fork's `map_mob_count_rate` extension adds
`setmapmobcountrate "<map>",<percent>`, which scales every spawn line on that
map (lines of a single monster stay single). Switch the extension on in the
mod's `db/extension_db.yml` and call it from `OnInit`. The
[map-spawn-rate](../registry/mods/map-spawn-rate) mod does this for any map,
picked in its settings window.

See [`examples/mods/quest-npc`](../examples/mods/quest-npc). For a quest in
the game's own quest log, with kill counters the server keeps, see
[Custom quests](mods/CUSTOM_QUESTS.md).

### Reading the database: `query_sql` and `query_logsql` are read-only

A mod's script can **read** the game database with `query_sql` (and
`query_logsql`, below), but not change it. Both log in as `ragnarok_mods`,
a login the app creates that can only `SELECT`:

- **Every table but `login` and `mod_store`** can be read. `login` holds every
  account's password hash and e-mail, and `mod_store` holds every mod's own
  data, so a mod never sees them, not even through a join.
- **Nothing can be written.** `INSERT`, `UPDATE`, `DELETE`, `CREATE`,
  `ALTER`, `DROP` and `SELECT … INTO OUTFILE` all fail. The query returns
  `-1`, and the map server's log shows MariaDB's "command denied" error,
  naming the table.

So a mod can't make its own tables in the game database, or edit characters
behind the server's back (which it would overwrite anyway; see
[docs/DATABASE.md](DATABASE.md)). **To keep a mod's own data, use the
[mod store](MOD_STORE.md)**: key/value storage, global, per account and per
character, from NPC scripts and Lua. rAthena's permanent variables
(`$mymod_price[501]`, `#mymod_rank`) still work for simple cases; prefix them
with your mod's name so mods don't collide.

### Knowing what players did: rAthena's logs

A script can react to some things as they happen: `OnPCLoginEvent`,
`OnPCKillEvent`, `OnNPCKillEvent`, `OnPCDieEvent` and the other event labels
in `vendor/rathena/doc/script_commands.txt`. Most item movements have
no event, including someone buying from a vending stall, selling into a buying
store or trading. rAthena **writes all of those to log tables** in the same
database, and a script can read them with `query_logsql`.

The stock `conf/log_athena.conf` is what every install runs, and mods cannot
change it (`conf/` is an [allowlist](#conf--a-few-server-settings)). So you
can rely on these tables, and not on the others:

| Table | Logged by default? | Holds |
|---|---|---|
| `picklog` | **yes, every item, every type** | one row per item gained or lost: `char_id`, `type`, `nameid`, `amount`, `refine`, cards, `map`, `time` |
| `cashlog` | yes | cash point changes |
| `atcommandlog` | yes, for groups with `log_commands` | `@` commands |
| `npclog` | yes | what scripts write with `logmes` |
| `loginlog` | yes, by the login server | logins and failed logins |
| `zenylog`, `chatlog`, `mvplog`, `branchlog` | **no**, so they stay empty | |

`picklog.type` is one letter. These are the useful ones, and the full list is
at the top of `vendor/rathena/conf/log_athena.conf`:

| | |
|---|---|
| `V` | vending: the stall owner and the buyer each get a row |
| `B` | buying store: both sides again |
| `T` | trade window |
| `S` | NPC shop buy/sell |
| `N` | a script gave or took it (quests, `getitem`, `delitem`) |
| `P` / `M` / `L` | picked up or dropped by a player / dropped by a monster / looted by a monster |
| `C` | used up (potions, ammunition, skill catalysts) |
| `R` / `G` / `E` | storage, guild storage, mail |

`amount` is signed. It is positive for the side that gained the item and
negative for the side that lost it. So a vending sale is a `V` row with
`-3` on the stall owner and `+3` on the buyer. For `M` and `L` rows,
`char_id` holds the monster's id instead.

**Read it on a timer and remember where you got to.** `query_logsql` blocks
the map server while it runs. `picklog` grows with every potion drunk, and only
`id` and `type` are indexed. The pattern that works is to keep the last `id`
you handled in a `$` variable. When the variable is unset, start from the
current maximum rather than the server's whole history. Then read in limited
batches:

```
// my-mod/npc/watch-trades.txt
-	script	MyModTrades	-1,{
OnInit:
	if ($mymod_lastlog <= 0) {
		query_logsql("SELECT COALESCE(MAX(id), 0) FROM picklog", .@max);
		$mymod_lastlog = .@max;
	}
	initnpctimer;
	end;

OnTimer60000:
	.@n = query_logsql("SELECT id, char_id, nameid, amount FROM picklog WHERE id > " + $mymod_lastlog + " AND type = 'V' ORDER BY id LIMIT 500", .@id, .@char, .@item, .@amount);
	for (.@i = 0; .@i < .@n; .@i++) {
		$mymod_lastlog = .@id[.@i];
		if (.@amount[.@i] > 0)
			debugmes "char " + .@char[.@i] + " bought " + .@amount[.@i] + " x " + getitemname(.@item[.@i]);
	}
	initnpctimer;
	end;
}
```

The AI characters' trades are logged too, and their `char_id` has no row in
`char`. To count only real players, `LEFT JOIN` the `char` table on `char_id`
and skip the rows that found no match.
[prontera-vendors](../registry/mods/prontera-vendors)'s dynamic market
(`npc/prontera-vendors-market.txt`) works this way, and is a full example.

Use `query_logsql` for these tables and `query_sql` for the rest. Both reach
the same database here, but rAthena lets the logs live elsewhere, and the two
commands are how a script says which it means.

To see what the rows actually look like before writing the query, open
**Settings → Tools → Database** and pick `picklog`. Then do the thing in game
and sort by `id`, descending. See [DATABASE.md](DATABASE.md#the-database-tool).

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

### Several hooks in one mod, each with its own checkbox

One mod can carry several independent hooks and let the player choose which
are on. Declare a yes/no setting for each, and put each hook under
`lua/when/<setting key>/`. Settings → Mods draws the checkboxes, and **Apply**
loads exactly the ticked ones:

```json
{
  "name": "blaze-shield",
  "requires": { "app": ">=1.4.3" },
  "settings": [
    { "key": "drain", "type": "boolean", "default": true,
      "label": "Drain", "description": "Pillar hits drain HP and SP for the ninja." },
    { "key": "classchange", "type": "boolean", "default": false,
      "label": "Class change", "description": "Pillar hits can turn a monster into another." },
    { "key": "pin", "type": "boolean", "default": false,
      "label": "Pin on entry", "description": "Monsters cannot walk through the pillars." }
  ]
}
```

```
blaze-shield/
├── mod.json
├── lua/
│   ├── when/drain/drain.lua               skill("NJ_KAENSIN", { on_hit = ... })
│   └── when/classchange/classchange.lua   skill("NJ_KAENSIN", { on_hit = ... })
└── db/
    └── when/pin/extension_db.yml          Enabled: true for blaze_shield_knockback
```

Each part is loaded under its own name, `<mod>/<setting key>` (`blaze-shield/drain`
above). That is the name its errors are logged under, and it is why two parts
of one mod can hook the same skill: they chain like two mods, in `priority`
order, instead of the second replacing the first as a second registration
from the same file would. Files directly in `lua/` are loaded as the mod itself,
as before, and run before its switched parts. `setting("blaze-shield", "<key>", ...)`
still reads the mod's settings from any of them.

`db/when/<key>/` works the same way for tables. A switched part's copy of a
table is **added** to the mod's own copy rather than replacing it, the way two
mods' copies are combined. That makes it the place for a server extension the
player should be able to turn on: ship `db/when/<key>/extension_db.yml` with
just that extension's `Id` and `Enabled: true`.

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

### Signboards: icons over NPCs

The backpack over a Kafra and the red potion over a tool dealer are rows of one
table, `data/luafiles514/lua files/SignBoardList.lub`. A mod's copy of that file
is **added to the stock one, not laid over it**: ship one holding only your
signs, and every Kafra keeps its icon.

```lua
-- my-mod/data/luafiles514/lua files/SignBoardList.lub, plain text
SignBoardList = {
	{ "prontera", 160, 185, 0, 1, "information\\over_nmtrade.bmp" },
	{ "geffen", 120, 66, 10, 3, "information\\over_nmtrade.bmp", "Buying Drops", "#0x00FFFFFF" },
}
```

Each row is map, x, y, height, type, icon, and for a board a caption and a
colour. Type 1 is an icon on its own, as over a Kafra; any other type (the
stock table uses 3) is a board with the icon and the caption. The client
ignores the colour. The icon is a path under `data/texture/유저인터페이스/`
and can be any image there — the stock ones are `information\over_kafra.bmp`,
`over_store.bmp` (the potion), `over_nmtrade.bmp` (a bag of zeny),
`over_weaponshop.bmp`, `over_armorshops.bmp`, `over_inn.bmp`, `over_guide.bmp`
and so on. Or ship your own image there and name it.

- **A sign belongs to a cell, not to an NPC.** Use your NPC's own map and
  coordinates. A sign on a cell the stock table already has replaces that one,
  which is also how a mod changes a stock icon. The client ignores the height
  as well, and puts every sign at the same distance above the ground.
- **Mods load in order**, after the stock table, and the last sign on a cell
  wins. The app copies each mod's table aside as
  `SignBoardList-<mod>.lub` and lists them in the client's
  `customSignBoardList`.
- **Write it in ASCII.** The client reads captions in its own codepage, as it
  does quest text.
- **Only that one path is read.** A `SignBoardList.lub` in `System/`, or
  anywhere else under `data/`, is copied like any other file and changes
  nothing on screen, and the log says so.

### Cut-ins: an NPC's full-length picture

`cutin "<name>", <position>;` in an NPC's script shows a picture beside the
dialogue. The client loads it from `data/texture/유저인터페이스/illust/`:

- **A name with no extension is a BMP.** `cutin "skogul", 2;` loads
  `illust/skogul.bmp`.
- **A name with an extension is used as given.** `cutin "skogul.png", 2;`
  loads `illust/skogul.png`.
- **`cutin "", 255;`** takes the picture away.
- **Positions:** 0 bottom left, 1 bottom centre, 2 bottom right, 4 centre of
  the screen.

```
my-mod/data/texture/유저인터페이스/illust/skogul.bmp
my-mod/npc/my_npc.txt          cutin "skogul", 2;
```

**A BMP's transparency is magenta, and only near-pure magenta.** BMPs have no
alpha channel, so the client makes `#FF00FF` transparent. To be exact, it
clears any pixel with red above 230, green below 20 and blue above 230. This
applies to every BMP it loads: cut-ins, item icons, signboards.

That's the trap with modern art. A picture cut out and **antialiased** onto a
magenta background has edge pixels that are part art, part magenta, like
`(180, 40, 170)`. They aren't near-pure magenta, so they're drawn, and the
picture gets a purple halo.

| | |
|---|---|
| <img src="assets/cutin-fringe-before.png" alt="A dark winged figure on a grey background, outlined in thin magenta along every edge, with a zoomed wing showing the magenta pixels" width="300"> | <img src="assets/cutin-fringe-after.png" alt="The same figure with a clean edge and no magenta, zoomed the same way" width="300"> |
| Antialiased onto magenta: a purple halo | Every pixel art or exact `#FF00FF` |

The client can't safely key the halo away: a looser rule would also erase
real purple in the art. Fix the picture, one of two ways.

**Use a PNG with real transparency** (the smooth edges you drew):

1. Export the art with its transparent background as PNG. Don't flatten it
   onto magenta first.
2. Put it in `illust/` and name the extension in the script:
   `cutin "skogul.png", 2;`.

A PNG keeps its alpha as it is, so antialiased edges, soft shadows and glows
all work. That's a feature of Ragnarok Offline's client: don't count on other
RO clients reading a PNG cut-in.

**Or keep the BMP, with a hard edge.** Every pixel must be either art or exact
`#FF00FF`:
- **From art with transparency:** in your editor, make the selection or alpha
  hard first (threshold the alpha at 50%, or select with antialiasing off),
  then fill what's outside with `#FF00FF` and save as a 24-bit BMP.
- **From a BMP that already has a halo:** select the background with the magic
  wand at tolerance 0, grow the selection by 1–2 pixels, and fill it with
  `#FF00FF`. That eats into the edge's blended pixels rather than keeping them.
- **Check it:** zoom in on an edge. There should be no pinkish or purplish
  pixel between the art and the magenta.

The same goes for any BMP with transparency in a mod: item and collection
icons and signboard icons.

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

## UI skins

A UI skin is a `data/` mod over the client's interface folder,
`data/texture/유저인터페이스/` — written `data/texture/ui/`. roBrowser draws its
windows' title bars, buttons, slots, tabs and scroll bars from the pictures
there, the same names the official client uses, so the official client's skin
format maps onto it almost one to one: a skin's root is that folder's root, and
its `basic_interface/` is that folder's `basic_interface/`.

**Settings → Mods → Add UI skin…** does the conversion. Give it a skin
folder — the one you would put in the official client's `skin/` directory — or
a `.zip` or `.rar` of one, and it builds a mod named `skin-<name>`, switches it on, and
switches whichever skin was on off. It is client-side only, so there is no
server restart: restart the app to see it.

Skins are often handed around flattened, or made for an older client than your
GRF, so each picture is **placed against your GRF's own list of names**, read
from the archive's file table:

1. its own path, if the GRF has a file there (letter case does not matter);
2. otherwise the root, if the GRF has that name at the root;
3. otherwise `basic_interface/`, then `login_interface/`;
4. otherwise the one other folder that has that name, if exactly one does.

A picture that matches nothing is **left out and listed** — in the message
Settings shows, and in full in `skin-import.txt` in the mod's folder. A file the
client never asks for would sit in the overlay looking like part of the skin
and do nothing. So is a second copy of a file already placed. Across 58
community skins from 2016 this placed 98% of 15,068 pictures; what was left
out is mostly buttons the client has since dropped or renamed
(`btn_num*.bmp`, `btn_rec_*.bmp`, `btn_vip.bmp`) and files the skin's author
had renamed by hand (`equipwin_bg3 (1).bmp`, `#shop.bmp`).

Two things are left out on purpose:

- **`option/`** holds the official client's per-skin choices — alternative
  bars and buttons the player picks between in that client's own settings.
  roBrowser has no such setting. To use one, copy its pictures over the mod's
  own by hand.
- Anything that is not a picture: read-me files, thumbnails.

What a skin cannot change:

- **Window bodies, fonts and text colours.** roBrowser draws those in CSS, not
  from pictures. A skin mod can add a `client/index.js` that adopts a
  stylesheet for them — see [client/](#client--restyling-the-client-itself).
- **The login window, with most skins.** For the packet versions this app ships
  the client draws a newer login window (`login_interface/bg_login.tga`,
  `bt_start_*.bmp`) than any skin made before 2018 carries pictures for. The
  game windows behind it are the ones a skin restyles.

`"kind": "skin"` in `mod.json` is what makes a skin one of a set: see
[mod.json](#modjson). A skin you lay out by hand works the same way;
[`examples/mods/ui-skin`](../examples/mods/ui-skin) is three pictures.

### Cursor packs

The mouse pointer is a sprite, `data/sprite/cursors.spr` and `cursors.act`,
and a mod that ships those two replaces it. Give **Add UI skin…** a
folder or archive holding them — most travel as a `.rar`, which macOS and
Windows open with their built-in `tar`, and Linux with `bsdtar` if it is
installed; otherwise unpack it and choose the folder — and it builds a
`cursor-<name>` mod of `"kind": "cursor"`: one cursor pack at a time, alongside
any skin. A skin folder that carries the two files keeps them in the skin.

**The pack is only drawn while the game's Graphics option "Show official
cursor" is on.** Without it the client draws the system pointer and never asks
for the sprite. It is on unless somebody switched it off, and the mod the
importer builds switches it back on for you: if the saved option is off, it
turns it on and reloads the game page once. Its setting, *Turn on "Show
official cursor"*, lets a player who wants it off keep it off. The client draws
its cursor from the game's render loop, so expect the system pointer on the
login screen and the pack's once you are in a map. (Thanks to
Clarois, whose custom-cursor mod worked out how that option draws the sprite.)

### Switching skins and the client's cache

The client keeps every interface picture it has downloaded, by filename, and
every skin replaces the same filenames — so a switch would show the old skin's
pictures from that cache. It does not, because each enabled mod's *name* is
part of the [overlay fingerprint](#the-client-caches-hard): switching from one
skin to another, or switching skins off, moves it, and the app clears the
client's cache on the next launch. Switching back to a skin you had before
moves it back, which is a second clear and a short re-download, not a stale
screen.

## BGM/ — music

`BGM/` is merged over the client's own tracks, so a mod can add a piece of music
or replace one:

```
my-mod/BGM/my-theme.mp3
```

It is its own layer rather than part of `data/` because the client asks for
music as `BGM/<file>`, a path root outside `data/`.

Which track plays on which map is `data/mp3nametable.txt`, one table for the
whole game. Rather than ship a copy of it, which replaces every map's music with
what the copy says, name the track per map in `mod.json`:
`"maps": { "my_isle": { "bgm": "my-theme.mp3" } }`. See
[Custom maps](mods/CUSTOM_MAPS.md#the-sky-the-weather-and-the-music).

## Custom maps

A mod can add a map that is in nobody's GRF: put its `.gat`, `.gnd` and `.rsw`
in `data/`, and the app registers it with the server on every start (the
`map:` line, `map_index.txt` and the map cache rAthena would otherwise need a
separate tool for). A `"maps"` entry in `mod.json` gives it a sky, clouds,
weather and music; without one, the background behind a custom map is black and
it plays the default track.

**Settings → Tools → Map editor** makes one for you, as a mod: see
[The map editor](mods/MAP_EDITOR.md).

[Custom maps](mods/CUSTOM_MAPS.md) is the whole of it: the files, making the
geometry, the sky and weather, getting players there, and what to check when a
map does not show. See [`examples/mods/custom-map`](../examples/mods/custom-map)
and [`examples/mods/island-ferry`](../examples/mods/island-ferry).

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
	[50001] = {
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

With the English translation on, the base table is the translation's, and the
player's client's own item table comes **after** it, as
`System/itemInfo_client.lub` (or `.lua`): it names only what the translation
does not, such as iRO's own costumes. An item in neither shows as
"Unknown Item"; ship it in your mod's table.

A table anywhere else — `System/LuaFiles514/`, `data/luafiles514/` — is not
read by the client, and the log says so: **Settings → Tools → Log viewer**,
under *App*, as a `link-assets warning` each time the app starts or a mod is
switched on or off. Editing the copy under
`state/assets/System/` does not last: that folder is rebuilt on every start.

See [`examples/mods/custom-item`](../examples/mods/custom-item).

**Quest tables are added too.** A `System/OngoingQuestInfoList.lub` holding
only your quests gives them their titles, summaries and descriptions in the
quest window, and every other quest keeps its own:

```lua
-- my-mod/System/OngoingQuestInfoList.lub
QuestInfoList = {
	[105001] = {
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
[Custom quests](mods/CUSTOM_QUESTS.md) covers the whole quest: the server's
side, the fields this table takes, and choosing an id no one else uses.

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
| `api.on(event, listener, { replay: true })` | Returns an unsubscribe function; subscriptions also end at disposal. Events: `map:enter`, `map:leave`, `connection`, `ui:append`, `ui:remove`, `movement:clear`, `preferences:change`, `item:use` (`{ itemId }`, the item's id, sent when the client asks to use it -- before the server says whether it worked), `server:event` (`{ command, text }`, a mod's server script speaking first -- [below](#windows-and-server-requests)), and `exit` (`{ to, from }`, the player chose to leave -- [below](#leaving-the-game-and-remembered-logins--exit-and-apiaccount)). |
| `api.snapshot()` | Frozen copy of map, connection, player position/HP/SP/name/`characterId`, selected target identity/name/HP, camera, packet version and movement counters. Server movement acknowledgements are read-only evidence. |
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
| `api.ui.scale.windows()` / `.get(window)` / `.set(window, factor)` / `.global()` / `.setGlobal(factor)` / `.supported()` | Draw the client's own windows larger or smaller: a global factor times each window's own, 0.5 to 3. Put back when the plugin goes; the plugin remembers the player's choice. See [below](#window-sizes--apiuiscale). Absent in an older app. |
| `api.ui.menuButton({ background, hover, down, title, onClick })` | A button of the mod's own in the option menu (Escape), drawn from pictures the mod ships like the menu's own. Returns a function that takes it out; it also goes with the plugin. See [below](#a-button-in-the-option-menu--apiuimenubutton). Absent in an older app. |
| `api.items.search(text, limit)` / `.get(id)` / `.icon(id)` | Items from the client's own tables, mods' included: `{ id, name, description, slots }`, and an icon URL for an `<img>`. |
| `api.server.request(command, text, { timeout })` | Ask the mod's server script for something; resolves with its answer. See [Windows and server requests](#windows-and-server-requests). |
| `api.store.get(scope, path, { timeout })` | Read what the mod keeps in its store under `client` (`'global'`, or the player's own `'account'` / `'char'`); resolves with a value, an object, or `null`. See [MOD_STORE.md](MOD_STORE.md#from-the-mods-client-ui). |
| `api.cleanup(fn)` | Register idempotent cleanup immediately after allocating a resource. The returned function can release it early. Runs on failure, scope replacement and page teardown. |
| `api.screens.replace(screen, hook)` / `.stage(canvas)` / `.image(path)` | Draw the login screen, server list, character select or character creation yourself. See [below](#the-screens-before-the-game--apiscreens). |
| `api.account.status()` / `.remember()` / `.resume()` / `.forget()` | A remembered login the page never holds, traded for a one-time login token. See [below](#leaving-the-game-and-remembered-logins--exit-and-apiaccount). |
| `api.host.request(path, { method, body, timeout })` | Ask this mod's own [host route](#host-routes), on the host's computer, from the host's window or an invited friend's alike. Resolves `{ status, type, body, data }` for every answer (`data` is the parsed JSON, or `null`); rejects only when nothing answered. Absent in an older app. |

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
game's never meet. The game remembers where the player left it, and clicking
or typing in it doesn't move the character or fire shortcuts.

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

The script can also speak first, without being asked — an NPC opening the
mod's window when the player picks a menu option, for instance. It sends
`@@event <command> <text>`; every plugin gets it as the client event
`server:event`, and the line never shows in chat:

```c
	// in the NPC's dialogue
	close2;
	dispbottom "@@event mymod open";
	end;
```

```js
api.on('server:event', ({ command, text }) => {
    if (command === 'mymod' && text === 'open') win.show();
});
```

`<command>` takes the same form as a request's: lowercase letters, digits and
`_`, starting with a letter. Use your mod's own, and check it, since every
plugin hears every event.
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

### The screens before the game — `api.screens`

A mod can draw the login screen, the server list, character select and
character creation itself: its own background, its own layout, the character
standing on a stage of its own. The client's window for that screen is still
there, hidden, and still does the work — it holds the character list, sends
the packets, and raises its own dialogs ("wrong password", "delete this
character?") above whatever the mod drew. The mod gets the screen's data and
the window's own buttons.

```js
export default function (params, api) {
	if (!api.screens?.supported()) return; // an older app: the stock screens stay

	api.screens.replace('charSelect', {
		show(view) {
			view.root.innerHTML = `<link rel="stylesheet" href="${new URL('./style.css', import.meta.url)}">
				<ul class="slots"></ul><canvas width="300" height="300"></canvas><button>Play</button>`;
			const stage = api.screens.stage(view.root.querySelector('canvas'), { scale: 2 });
			this.stage = stage;
			this.update(view);
			view.root.querySelector('button').onclick = () => this.view.play();
		},
		update(view) {
			this.view = view;
			view.root.querySelector('.slots').replaceChildren(...view.characters.map(c => {
				const li = document.createElement('li');
				li.textContent = `${c.name} — Lv. ${c.level} ${c.jobName}`;
				li.onclick = () => view.select(c.slot);
				return li;
			}));
			this.stage.clear();
			if (view.selected) this.stage.add(view.selected.look, { action: 'ready' });
		},
		hide() { this.stage.dispose(); },
	});
}
```

`show(view)` runs when the screen opens; `update(view)` whenever its data
changes — a character arrives, the selection moves, a deletion is answered —
and without one, `show` is called again on an emptied layer; `hide()` when it
closes. `view.root` is a shadow root covering the window, above the 3D canvas
and below every client window. It is emptied and removed when the screen
closes, so there is nothing to clean up in it.

| screen | data | actions |
|---|---|---|
| `login` | `savedId`, `saveId` | `login(user, password, { saveId })`, `signup()`, `exit()` |
| `serverList` | `servers: [{ index, label }]`, `index` | `select(index)`, `exit()` |
| `charSelect` | `characters`, `selected`, `index`, `maxSlots`, `sex`, `enabled`, `deleteReservation` | `select(slot)`, `play(slot?)`, `create(slot?)`, `requestDelete(slot?)`, `cancelDelete(slot?)`, `confirmDelete(slot?)`, `exit()` |
| `charCreate` | `races: [{ job, name, hair: {min,max}, hairColor: {min,max} }]`, `sex`, `chooseSex`, `hasStats` | `create({ name, job, sex, hair, hairColor, stats? })`, `exit()` |

Each action is what the matching button of the client's window does, so the
same things follow from it: `login` runs the client's login (the password is
what the login packet carries — a password, or a token a sign-in service gave
in place of one), `play` the loading screen and the map, `exit` on character
select asks "are you sure?" first, and a name the server refuses comes back as
the client's own message box. Arguments are checked first: a slot outside
`0…maxSlots-1`, a hair style outside the race's range or a job that is not one
of `races` throws, and the window never sees it.

A character is `{ id, slot, name, job, jobName, level, jobLevel, exp, jobExp,
hp, maxHp, sp, maxSp, zeny, stats: { str, agi, vit, int, dex, luk }, map,
mapName, sex, deletePending, look }`. Everything in a view is a frozen copy.

**`api.screens.stage(canvas, { scale })`** draws characters on a canvas of
yours, the way character select draws its slots. `stage.add(look, place)`
takes a character's `look` — or any of `job`, `sex`, `head`, `headpalette`,
`bodypalette`, `weapon`, `shield`, `accessory`, `accessory2`, `accessory3`,
`robe`, `effectState` — and `place`: `x` and `y` as fractions of the canvas
(where the feet go; beyond 0…1 crops, which is how a portrait is made),
`direction` 0…7 (0 faces the viewer), `action` (`idle`, `walk`, `sit`,
`ready`, `attack`, `hurt`, `die`, `pickup`) and `kind: 'monster'` for a pet
or a companion beside the character. It returns `{ set(look), place(place),
action(name), remove() }`. A mount is part of the look: it is the
`effectState` bits the server sent, and is drawn as the game draws it.
`stage.dispose()` stops it; disposal of the plugin does too.

**`api.screens.image(path)`** resolves to a URL for a picture in the game
data — BMPs with their magenta made transparent, as the client draws them —
or `null`. A bare name is looked up in the interface folder, so
`api.screens.image('renewalparty/icon_jobs_4008.bmp')` is the Lord Knight
icon. Use it for the client's own art; ship your own beside `index.js`.

Three things to know:

- **A mod that throws gets the screen taken away from it.** An error in
  `show`, `update` or `hide` is reported under the plugin's name, the hook is
  switched off, and the client's own window comes back, so a broken mod never
  leaves a player unable to log in. Two mods that replace the same screen:
  the one loaded later draws it, and the other takes over if it goes.
- **Keys are yours while your screen is up.** The hidden client window
  ignores them; handle Enter and Escape in your own markup if you want them.
- **Character creation only sends what the server accepts at creation:**
  name, job, sex, hair style and hair colour. A body (clothes) colour can be
  shown on the stage with `bodypalette`, but the server will not store it until
  a stylist changes it in game.

The hooks themselves are `UI/ScreenHooks.js` in the roBrowser fork:
`register(screen, { show, update, hide })`, called by each of those windows as
it opens, changes and closes. `api.screens` is the supported way to reach it.
See [`examples/mods/pregame-stage`](../examples/mods/pregame-stage).

### Leaving the game, and remembered logins — `exit` and `api.account`

A mod that keeps something in step with where the player is needs to know when
the player *chose* to leave, as opposed to being disconnected. The `exit` event
says so, before the client acts:

| `{ to, from }` | The player pressed |
|---|---|
| `{ to: 'charSelect', from: 'escape' }` | Escape menu → Character select |
| `{ to: 'login', from: 'escape' }` | Escape menu → Exit |
| `{ to: 'login', from: 'charSelect' }` | Cancel (or Escape) on character select, and confirmed |

It is the choice, not the outcome: the server can still refuse to let a
character leave mid-fight. A disconnect, a kick or a closed window is never
reported. It comes from `UI/ExitHooks.js` in the roBrowser fork
(`ExitHooks.on(listener)`, emitted by the Escape window and character select).

`api.account` keeps a login for the player without the page ever holding
anything that could be replayed later:

```js
const { available, remembered } = await api.account.status();
await api.account.remember();                   // in game: remember this account
const { username, token } = await api.account.resume(); // -> view.login(username, token)
await api.account.forget();                     // revoke it, here and on the server
```

`remember()` asks whoever serves the page — the app, for the host's own window;
the friend gateway, for a friend — to keep a random credential for the account
the page is logged in to now. The page's proof is the session it is in (the
login server's web auth token), so a mod cannot remember an account it is not
playing. The credential stays with the app (a file of its own, for the host's
window) or in an HttpOnly cookie on the origin the game was loaded from: a
`__Host-` Secure one through the HTTPS sharing link (quick tunnel or the host's
own domain), or, for a LAN join, a plain-HTTP one that the asset server's
`/_friend/remember/` route hands to the app. No script in the page can read
it. `remember()` resolves `{ username, secure }`, and `secure` is false only
on a plain-HTTP LAN origin. `resume()` trades it for a
one-time login token (60 seconds, one use) to hand straight to the login
screen's `view.login`. It rejects with `.code` `'none'`, `'revoked'` (it is
already forgotten) or `'unavailable'` (the server is not up; try later).
Changing an account's password or disabling it in Settings → Accounts revokes
all of its remembered logins. Where nothing answers, `status()` says
`available: false`. That covers a LAN join while the host has LAN off, an
older host, and any other server.

See [`mods/autologin`](../mods/autologin), which uses all three.

### How GMs are drawn — `api.players.gmLook`

The client draws every account on its GM list (`adminList` in its config,
which holds the built-in `ragnarok` account) in the GM suit, whatever its job,
and styles its name and chat as a GM's. These are only looks; GM commands come
from the server. A mod can turn each part off:

```js
if (api.players?.gmLookSupported?.()) {
    api.players.gmLook({ sprite: false });              // drawn as their class
    api.players.gmLook({ name: false, chat: false });   // and named and heard like anyone
}
```

Leave a key out to keep it as it is. `gmLook` returns the look now in force
(`{ sprite, name, chat }`). It applies to characters drawn from then on, so
call it from `init`, and it is put back when the mod is turned off. An app
before 1.4.5 has no `api.players`, and a client without the switches answers
`gmLookSupported()` with `false` (`gmLook` then returns `null`). It reads `Session.AdminLook` in the
roBrowser fork. See [`mods/gm-class-look`](../mods/gm-class-look).

### Window sizes — `api.ui.scale`

Browser zoom (Ctrl +) makes every window larger at once and leaves the 3D view
as it is. `api.ui.scale` goes further, one window at a time: a hotbar large
enough to read from the couch, a chat that takes less room.

```js
if (api.ui?.scale?.supported()) {
    const scale = api.ui.scale;
    scale.setGlobal(api.preferences.get('all', 1));          // every window
    scale.set('ShortCut', api.preferences.get('ShortCut', 1)); // times this one
}
```

A window is drawn at the global factor times its own, and both are kept
between 0.5 and 3; `set` and `setGlobal` return the factor in force (the
client clamps), or `null` on a client that cannot scale. Setting a window to 1
gives it the global factor back.

Only the windows `windows()` names can be scaled: the hotbar (`ShortCut`,
`ShortCuts`), the chat (`ChatBox`), `Inventory`, the status icons
(`StatusIcons`), the HP/SP window (`BasicInfo`), `MiniMap`, the gamepad
hotbar along the bottom (`JoystickUI`) and other windows
the client has checked to keep dragging, resizing and scrolling at another
size. A name it doesn't list is a `TypeError`, and so is a value that is not a
number. A version of a window is scaled by its public name (the client's
`InventoryV3` is `Inventory`), and every whisper window by `WhisperBox`.

The client remembers nothing. Everything starts at 1, so a mod keeps the
player's choice itself, in `api.preferences`, and sets it again in `init`,
before the windows open. Turning the mod off puts back what it changed. The
list and the drawing are `UI/UIScale.js` in the roBrowser fork.
[`mods/ui-scale`](../mods/ui-scale) is a complete one: a window of sliders,
opened from a button in the option menu.

### A button in the option menu — `api.ui.menuButton`

The option menu, the window Escape opens (and the basic info window's Option
button), can carry a button of the mod's own. It comes after the menu's
settings buttons and before Exit, and hides with them on the death menu.

The menu's buttons are pictures with the label painted in, so a mod's is
too: three of them in the client's interface folder, at rest, under the
pointer and pressed, 221 x 20 like the menu's `esc_06a.bmp`. Ship them in the
mod's `data/texture/ui/`:

```js
api.ui.menuButton({
    background: 'esc_mymod_a.bmp',
    hover: 'esc_mymod_b.bmp',
    down: 'esc_mymod_c.bmp',
    title: 'My Mod',               // tooltip and screen readers
    onClick: () => win.toggle(),
});
```

A picture is a plain relative name in that folder (`..`, a URL or anything
but `.bmp`, `.tga`, `.png` or `.jpg` is a `TypeError`). `hover` and `down`
are optional. Pressing the button leaves the menu open, as the settings
buttons do. It returns a function that takes the button out, and the button
also goes with the mod. A client without the menu hook has nowhere to put it,
and the call does nothing. It is `UI/MenuHooks.js` in the roBrowser fork.
[`mods/ui-scale/tools/make-menu-button.py`](../mods/ui-scale/tools/make-menu-button.py)
letters a button of your own from the menu's Settings button.

---

## Host routes

A host route is JavaScript of the mod's own that runs **on the host's
computer** and answers HTTP requests from the game — from the host's own game
window and from every friend invited through a sharing link. It is for what a
friend's browser cannot do by itself: reach a program on the host's machine,
such as a local AI model, and give everyone the same answer.

It is somebody else's code running on the host's computer, so it runs in a
box (below), it can connect only to the addresses its `mod.json` names, and it
does **nothing until the host switches it on**.

### mod.json

```json
{
  "name": "host-local-ai",
  "host": {
    "entry": "host/index.js",
    "connect": ["http://127.0.0.1:8080"]
  }
}
```

- **`entry`** — an ES module inside the mod's `host/` folder. Only `host/` is
  served to the handler: it cannot read the rest of the mod, or anything else
  on disk. `..`, absolute paths and links that lead out of `host/` are
  refused.
- **`connect`** — up to 8 origins the handler may `fetch`: `http://` or
  `https://`, host and port, no path (`"http://127.0.0.1:8080"`, written the way
  a browser writes it, so no trailing `/` and no `:80`). Leave it out, or `[]`,
  for a handler that reaches nothing. The app's own ports — the asset server
  (3338), login (6900), char (6121), map (5121), the agent API (7490) and the
  sharing gateway (3339), or this copy's own if they were moved — are refused
  on **any** host name, since a name can lead back to this machine.

A mistake in `"host"` does not stop the rest of the mod from loading; its card
in Settings says what is wrong, and the route stays off.

### The handler

```js
// host/index.js
export default async function handle(request, host) {
    if (request.method === 'GET' && request.path === '/hello') {
        return { body: { hello: request.from } };
    }
    return { status: 404, body: { error: 'Not found' } };
}
```

`request`:

| | |
|---|---|
| `method` | `GET`, `POST`, `PUT` or `DELETE` |
| `path` | what follows the mod's name, starting with `/` (`/_friend/mod/host-local-ai/complete` → `/complete`) |
| `query` | the query string without `?`, or `''` |
| `headers` | `content-type` and `accept` only, when sent |
| `body` | text, or `null`. JSON arrives as text: `JSON.parse(request.body)` |
| `from` | `'host'` or `'friend'` |

Return `{ status, type, body }`: `status` 200–599 (default 200); `body` a
string, or an object sent as JSON; `type` the content type (default
`application/json` for an object, `text/plain` for a string). Throwing, or
returning anything else, answers 502 with a fixed message, and the details go
to the host's app log only.

`host` has `host.name`, `host.connect` and `host.log(...)`, which writes a
line to the host's app log under the mod's name (at most 30 a minute). It has
nothing else: no files, no Node, no Electron, no other mod.

The module is loaded once and kept, so it can hold state between requests in
module variables. It is started on the first request after the app starts,
and again after it crashes, hangs, or the mod is updated or switched.

### Asking it from the game

```js
const answer = await api.host.request('/complete', { method: 'POST', body: { prompt: 'Hi' } });
if (answer.status === 200) console.log(answer.data.text);
```

`api.host.request` reaches only this plugin's own mod's route: the client
binds the mod's name. On the host's window it goes to the app directly; on a
friend's it is `fetch('/_friend/mod/<mod>/<path>')` on the sharing link. A mod
that is off, not switched on as a host service, or has no route answers 404.

All plugins share one page, so this is a convenience, not a wall between mods:
a plugin can always `fetch` another mod's path on a friend's page itself.
What *is* enforced is everything on the host's side.

### The box, and the limits

Each mod's handler runs in a hidden window of its own
([`electron/mod-host/sandbox.js`](../electron/mod-host/sandbox.js)):

- a sandboxed renderer with context isolation, no Node and no Electron APIs,
  which cannot show itself, navigate, open windows, download, or be granted
  any permission;
- a session of its own, in memory only: no cookies, storage or cache shared
  with the game, another mod, or the next start;
- every request it makes is checked before it leaves: its own `host/` files,
  and URLs whose origin is exactly one in `connect`. Anything else — another
  host or port, WebSockets, `file:`, `data:` — is cancelled and logged, and
  the page's Content-Security-Policy says the same again. Responses from the
  `connect` origins are given CORS headers, so a local server that sends none
  can still be read.

The app enforces, outside the box:

| | |
|---|---|
| request body | 200 KiB → 413 |
| response body | 1 MiB → 502 |
| time | 30 s per request → 504 |
| at once | 4 requests per mod → 429 |
| rate | 60 requests a minute per friend (and 60 for the host) → 429 |

A friend's request carries no cookie, address or other header to the handler,
and the answer carries back only its status, content type and body, under a
Content-Security-Policy that stops it running script on the sharing link.
`POST`, `PUT` and `DELETE` must come from the game's own page, with a JSON or
plain-text body.

### Switching it on

**Settings → Mods** shows, in the open row of a mod that declares a host route, *"Runs a
host service on this computer that friends you invite can use, and that may
connect to: …"* with a switch. It is off for every mod until the host ticks it,
and it takes effect at once, without Apply. The choice is stored, with the
list it was made for, in `state/mod-host.json`; a mod update that changes
`connect` switches it off again until the host has seen the new list. Removing
the mod forgets it.

### Who can reach it

| | |
|---|---|
| the host, in the app | yes |
| a friend, through a sharing link (Cloudflare) | yes, while sharing is on |
| a player who joined over **LAN** | **no** |

A LAN player loads the game straight from the host's asset server, not
through the sharing gateway, and the asset server forwards only
`/_friend/remember/` to the app (for remembered logins). `api.host.request`
answers 404 there, the same as a mod with no route, so a mod should treat 404
as "not available here". Inviting LAN players with a sharing link works.

See [`examples/mods/host-local-ai`](../examples/mods/host-local-ai).

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
from Settings → Mods, it goes in the registry, and the pull request is the
review: **[Adding a mod to the registry](MOD_REGISTRY.md)**. There are two ways
in. The mod's folder can live in this repository, and the app downloads it file
by file and checks every one against its digest. Or the entry can point at your
own GitHub repository, and the app installs your latest release — the same zip
(or RAR) you would hand a friend — and offers each newer release to players as an
update, without another pull request here.
