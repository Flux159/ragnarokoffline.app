# How the mod system works, and where its walls are

[MODDING.md](MODDING.md) is for someone making a mod. This is for someone
changing the mod system: what each layer does under the hood, what was measured
rather than assumed, and which of the remaining limits are decisions rather than
bugs.

Everything below was run against a real server on macOS, in both eras, with a
kRO 2022 client. Where something is a hypothesis it says so.

## The layers, and who assembles them

| layer | lands at | assembled by |
|---|---|---|
| `db/` | bound at `/rathena/db/import` | `mods::assemble` |
| `npc/` | bound at `/rathena/npc/mods/<name>/`, plus `npc:` lines | `mods::assemble` |
| `conf/` | appended to the generated `conf/import/*.txt` | `mods::assemble` → `cmds::up` |
| `data/` | copied over `state/assets/data`, served ahead of the GRFs | `assets::overlay_mods` |
| `System/` | copied over the merged `System/`, after the translation | `assets::overlay_mods` |
| `client/index.js` | copied to `state/assets/plugins/<name>/`, named in `Config.local.js` | `assets::overlay_mods` |
| custom maps | `map_cache.dat` + `map_index.txt` in the `db/import` tree, plus `map:` lines | `mods::assemble` → `mapcache` |
| `mod.json` | parsed, and `requires` enforced | `mods::read_manifest` |

`state/modbuild` is rebuilt from scratch on every start, so a removed mod stops
affecting the server. A stale merge would be indistinguishable from a mod that
is still installed.

Server-side layers (`db/`, `npc/`, `conf/`, custom maps) apply on a **server**
restart. Client-side layers (`data/`, `System/`, `client/`) are laid down by
`link-assets`, which the app runs at startup, so they need the **app**
restarted.

## One list of enabled mods, not three

`mods::scan` is the only thing that decides what is applied. `assemble`, `list`
and `overlay_mods` all read it.

That was not true before. `overlay_mods` used to do its own pass over
`state/mods` and did not read `disabled.txt`, so a mod switched off in Settings
stopped reaching the server and went on overlaying its sprites and loading its
plugin. Half of it stayed on, with nothing in the interface to say so.

`scan` also reads two roots: mods shipped with the app under `<runtime>/mods`,
and mods the player installed under `state/mods`. A name in both resolves to
the player's copy, which is what makes a bundled mod a starting point rather
than a locked cabinet.

## The manifest

`mod.json` used to be decoration: `mods.rs` read only `description`, and read it
by splitting the file on `"description"` and hunting for the next pair of
quotes. Nothing validated the file, and `name`, `version` and `author` were
never read at all. A mod that was wrong for the build installed silently and
then misbehaved in whatever way its contents happened to cause.

It is now parsed by `stack/src/json.rs` — a real reader, about 300 lines,
written because the alternative was extending a quote-hunting hack that mangles
any description containing an escaped quote. It is the only JSON parser in the
tree and nothing else should grow a second one.

`requires.app` and `requires.era` are enforced in `mods::scan`, and a refused
mod is left out of **every** layer, named in the log and shown in Settings with
its reason. Half-applying it — tables loaded, geometry missing — produces a
server that runs and is quietly wrong, which is the failure the whole mechanism
exists to prevent.

### Where the version comes from

`package.json` is the single source. `scripts/package.sh` copies its `version`
into `payload/APP_VERSION`; `config::app_version` reads that file, and falls
back to reading `package.json` itself one level above the payload, which is what
a source checkout looks like. Nothing in `stack/` carries a version constant.

This is deliberately not the same file as `payload/VERSION`, which is the git
short hash and exists so the app knows when to re-materialise its runtime tree.
That one changes on every commit; `APP_VERSION` is the number a human sees.

A build that cannot determine its own version **warns once and allows the mod**.
Refusing everything because a build marker is missing would be a worse failure
than the one being guarded against.

## Custom maps: settled, and how

This was the open question, and it is closed: **custom maps work end to end**.
A character created after the change wakes up on a generated island, walks on
it, fights Porings on it, and takes a ferry back to Prontera.

Getting there needed three things, and the interesting part is that the
documented route named only one of them.

### 1. `map:` lines — the one nothing documented

The map server builds its map list from `map:` directives read by
`map_config_read` (`src/map/map.cpp:4170`). `conf/maps_athena.conf` is twelve
hundred of them. Only then does it look each name up in a cache.

A map that is cached and indexed but never named in a `map:` line is simply not
in the list, and **the server says nothing at all**. No warning, no count, no
mention. This cost the first afternoon of the investigation: the cache was
correct, the index was correct, and the map count did not move.

`conf/import/map_conf.txt` is imported after `maps_athena.conf` and accepts
`map:`, so the supervisor emits one line per custom map into the file it was
already generating for `npc:` lines.

### 2. `db/import/map_index.txt` — honoured, and additive

`mapindex_init` (`src/common/mapindex.cpp:139`) reads `map_index.txt` and then
`import/map_index.txt`, carrying `last_index` across both files. So an entry
with no explicit index continues numbering after the stock table, and the
documented claim in the old MODDING.md — that a custom map is registered "by
overriding `db/map_index.txt`" — was right in substance and wrong in wording:
it is an *import*, and it adds rather than overriding.

Indices are not persisted anywhere. `last_map` in the character table is a map
*name*, so adding or removing a mod may shift the numbers and nothing breaks.

### 3. `db/import/map_cache.dat` — honoured, additive, and first

`map_readallmaps` (`src/map/map.cpp:3925`) opens three caches and keeps all of
them:

```
db/import/map_cache.dat
db/<re|pre-re>/map_cache.dat
db/map_cache.dat
```

For each map it takes the first cache that has it. So the import cache is both
additive and highest priority, and nothing has to reproduce the 1,265 stock
maps.

What did **not** exist was any way to get a modder's geometry into that file.
Upstream builds it with `src/tool/mapcache.cpp`, a separate binary that links
against the whole server and reads `.gat`/`.rsw` out of a GRF through `grfio`.
It is not built into the shipped image, and putting it there would mean a
custom map needed a Docker rebuild — the one thing the mod system exists to
avoid.

So the supervisor builds the cache itself, in `stack/src/mapcache.rs`, from the
loose `.gat`/`.rsw` the mod already has to ship for the *client* to draw the
map. One copy of the geometry, two consumers.

The format is a header and a run of records, and the only awkward part is that
the cells are zlib-compressed. `stack/` has no dependencies, so the module
emits **stored** deflate blocks — a valid zlib stream that is framed but never
actually compressed, which `uncompress()` accepts. Forty lines instead of a
compression dependency, at the cost of a 400 × 400 map being 160 KB rather than
8 KB. A mod ships one or two maps, not twelve hundred.

### Making geometry from nothing

`scripts/mkmap.py` writes a complete, original map: `.gat`, `.gnd`, `.rsw`, a
ground texture and a minimap bitmap. It exists because the alternative — copying
a stock map out of a GRF and renaming it — produces a mod that cannot ship in a
public repository, and because a from-scratch map is the honest proof that the
pipeline needs nothing from Gravity.

Formats were read out of the parsers that consume them: `src/tool/mapcache.cpp`
and `src/common/grfio.cpp` on the server side, `src/Loaders/Ground.js` and
`src/Loaders/World.js` on the client side. Three things are worth recording
because they are invisible when wrong:

- **The `.gnd` is half the `.gat`'s resolution.** Stock `prt_fild08` is a
  400 × 400 `.gat` and a 200 × 200 `.gnd`.
- **`.rsw` version 2.1 puts the water level at byte 166**, which is where
  `grfio_read_rsw_water_level` reads it for anything below 2.02. Bumping the
  version without moving the field leaves every walkable cell below the water
  line as dry land.
- **A `.gnd` lightmap cell is 64 bytes of shadow followed by 64 RGB triples of
  additive coloured light.** Filling the cell with `0xff` — the obvious thing —
  adds full white light to every pixel and renders the map as a flat white
  sheet with the texture washed out of it. This was the first version's bug and
  it looked exactly like a texture that had failed to load.

## The starting location: decided, and implemented

`cmds.rs` writes `start_point` (or `start_point_pre`) into `char_conf.txt` on
every start, from a literal. That regeneration is deliberate — settings and
server config drifting apart caused a real bug — so a mod could not change the
start point and neither could a player editing the generated file by hand.

There was no `conf/` mod layer at all.

**The decision: a `conf/` layer with a narrow allowlist**, rather than a
passthrough or a set of bespoke supervisor settings.

`CONF_ALLOWED` in `stack/src/mods.rs` currently permits seven keys, all in
`char_conf.txt`, all about the character a player is about to create.
Everything else a mod asks for is **named in the log and dropped**, never
quietly applied.

The reason it is an allowlist and not a passthrough: `conf/` is where
`login_ip`, `char_ip` and `map_ip` live. A mod that could write those could
point a player's client at somebody else's server, and the mod would look
exactly like one that works. That is not a hypothetical class of bug; it is a
one-line mod.

Mod lines are appended **after** the supervisor's own, because rAthena's config
reader takes the last assignment of a key —
`char_config_split_startpoint` clears the array before filling it, so the last
`start_point:` line is the whole answer rather than an addition.

Widening the list is a code change and should stay one. The bar is: could a mod
use this to reach outside the machine, or to overwrite something the player set
in Settings?

## AI population on a modded map: blocked, and why

**A mod cannot configure the Population Engine today.** This is read out of the
loader, not inferred.

Every population table is loaded from exactly one path
(`third-party/population-engine/files/src/map/population_engine/config/population_config.cpp`):

```cpp
static std::string population_config_join_db(const char *basename)
{
	return std::string(db_path) + "/" + basename;
}
```

`db_path` is `db`, so `population_spawn.yml` is read from
`db/population_spawn.yml` and nowhere else. No import path, no era
subdirectory, no second load that could merge one in. The engine is a source
modification rather than stock rAthena, so it does not participate in the
`db/import` mechanism that every other table uses.

Meanwhile `scripts/apply-server-mods.sh` copies the engine's tables into the
rAthena checkout at **build** time, so the file that is actually read lives
inside the container image.

A mod's `db/population_spawn.yml` therefore lands at
`db/import/population_spawn.yml`, which nothing opens. The server loads its own
copy, reports `Loading '14' entries in 'db/population_spawn.yml'`, and the
modded map stays empty — indistinguishable from a mod that loaded and did
nothing.

**What it would take:** an import-aware `population_config_join_db`, roughly six
lines, plus an image build to ship it. Replace-not-merge is the right shape:
the spawn config is a distribution across the whole world, and a partial
override that merged would silently halve somebody else's population.

**What was ruled out:** bind-mounting a merged file over
`/rathena/db/population_spawn.yml`. Single-file binds are unreliable when the
host path contains a space, and on macOS the state directory is under
`Application Support`. Mounting a merged `/rathena/db` wholesale would mean
copying tens of megabytes out of the image on every start, and `docker cp` from
a created-but-not-running container silently copies nothing under the bundled
slim client.

[`examples/mods/island-population`](../examples/mods/island-population) carries
the file that would work and a README that names the wall.

## The client plugin loader changed under us

`vendor/roBrowserLegacy` is ESM now. `Plugins/PluginManager.js` loads a plugin
with a dynamic `import()` and calls `module.default(params)`.

The shipped `mobile-ui` mod was written in the older AMD style —
`define(function () { return { init: … } })` — which throws on import. The
plugin manager catches it and reports to a console that `ConsoleManager` has
muted. So the one client-side example in the repository **loaded, did nothing,
and said nothing**, and `docs/MODDING.md` documented the broken form.

Both are fixed. If a plugin ever seems inert, this is the first thing to check:
the file is fetched with a 200 either way.

The second thing is shadow roots. Every roBrowser window is a custom element
with its own shadow root, and a `<style>` in the document head does not cross
that boundary. `mods/mobile-ui` builds one `CSSStyleSheet` and adopts it into
each shadow root as it appears, with a `MutationObserver` for the windows made
later.

## What the randomizer turned up

`examples/mods/randomizer` was built to answer "could a mod be a Ragnarok
randomizer?". It can, and getting there established three things about
`db/import` that are not written down anywhere else.

**Identity shuffling is the way around the no-removal rule.** A mod cannot
remove a stock monster spawn — the ~3,000 spawn lines load before any mod and
nothing can unload them. But every spawn line names an *ID*, and an ID is a
label on a block of numbers. Permuting the blocks across the IDs reshuffles the
whole world with the spawn scripts untouched. The same shape would work for
items and skills.

**`Rate: 0` discards the monster, not the drop.** There is no way to delete a
drop slot from an import, so blanking one looks like a zero rate.
`asUInt16Rate` rejects it (`Node "Rate" needs to be at least 1`), and because
the failure propagates, `parseBodyNode` returns early and the *entire* entry is
thrown away — silently leaving the monster as it was. The lowest usable rate is
1, i.e. 0.01%.

**Part of `mob_db` is not monsters.** 45 of the 1,004 pre-renewal entries are
the emperium, WoE barricades, guild flags and the elemental crystals, and they
set `Ignore…` modes that switch off whole damage types. Anything given one of
those blocks cannot be killed by ordinary means. Any tool that rewrites the mob
table wholesale needs to know they are in there.

Warp shuffling was tested and works, and is not shipped. Stock warps are
ordinary named NPCs (`prt01`, `prt001`, …), `disablenpc` resolves them through
`npcname_db`, and a mod warp placed on the same square takes over with no
duplicate-name complaint — verified by rerouting Prontera's south gate to a
modded island. What it needs before it is safe to ship is reciprocal pairing,
so shuffling the way into a dungeon also shuffles the way out; and the warp
files are split between `npc/warps/` and `npc/<era>/warps/`, which overlap.

## Client asset facts worth not rediscovering

- **The asset server resolves `SERVER_ROOT` loose files before
  `DATA_OVERRIDE_PATH` and before the GRFs.** Verified by putting a marker file
  at `state/assets/data/texture/…/loading01.jpg` and reading it back over HTTP.
- **It caches every file it has served, in memory, keyed by path.** A changed
  `data/` file that appears not to take is a cached one. This is why
  `link-assets` stops the asset server before rebuilding the tree.
- **Interface paths are CP949 bytes read as Latin-1**, all the way to the
  filesystem: `data/texture/À¯ÀúÀÎÅÍÆäÀÌ½º/`. The English translation tree
  stores them the same way, which is what makes the two overlay cleanly.
- **The login background is twelve images** for packet versions 2018-11-14 to
  2022-12-07, laid out 4 × 3 (`UI/Background.js`, `getLoginBackgroundName`).
  Above and below that range it is one, `t_login.jpg` or `bgi_temp.bmp`.
- **Loading screens already rotate**, at random, over a fixed list of ten names.
  `Background.init()` accepts a list — it is meant to come from
  `clientinfo.xml` — but every call site passes nothing.
- **Extensions are advisory.** These files are decoded by the browser, which
  sniffs content, so a JPEG saved as `.bmp` works and is a tenth of the size.
  The login-screen example is 200 KB rather than 2.4 MB because of this.

## Still open

- **Installing a mod is still "find your platform's state directory and drop a
  folder in it".** Settings can list and toggle mods and open the folder, but
  cannot accept a dragged-in folder or a zip. That is a product decision, not a
  missing capability.
- **A mod cannot remove anything.** Stock spawns, stock NPCs and stock warps are
  loaded before any mod and there is no way to unload a script a mod did not
  add. Adding is the whole vocabulary.
- **`System/` has no worked example.** The layer is wired and `itemInfo.lua` is
  force-linked from the translation with a mod able to replace it, but nothing
  in `examples/` exercises it — a custom item needs a `db/item_db.yml` entry, a
  sprite and an `itemInfo.lua` entry together, and that is the example that
  would justify the layer.
- **AI population for modded maps**, above.
