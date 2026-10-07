# Population Engine

Server-side fake players for rAthena: "shells" that walk, fight, sit, chat and
open real vending stalls, and that appear to any client as ordinary players in
the player list. Ambient shells and party recruitment use normal rAthena
packets. Companion resurrection additionally needs the generic dead-PC
lifecycle correction on our roBrowserLegacy fork, described below.

| | |
|---|---|
| Upstream | https://github.com/YlenXWalker/Population-Engine |
| Vendored at | `a191b70` ("fix build in linux"), 2026-08-18 |
| Licence | GPL-3.0, same as rAthena. Attribution appreciated, not required |
| Forum thread | https://rathena.org/board/topic/149283-population-engine-advance-fake-players |

## Why it is vendored rather than cloned

Upstream ships as a **whole fork of rAthena**, not as a patch set — its history
is a squashed import of the rAthena tree with the engine committed on top. We
build from a clean upstream rAthena clone and have no interest in tracking
somebody else's fork of it, so what lives here is the engine's own delta,
extracted from `417f713..a191b70`:

    files/       new files, copied verbatim into the rAthena checkout
    patches/     the hunks that touch rAthena's own sources

`scripts/apply-server-mods.sh` puts both into a checkout, and both build paths
call it before `docker build` — `scripts/bootstrap.sh` locally and
`.github/workflows/images.yml` in CI.

## What we deliberately left out

The upstream fork carries changes we do not want:

- **`src/custom/defines_pre.hpp`** hard-codes `PACKETVER 20250716`. Ours comes
  from `--enable-packetver` and has to match the client era — see
  `containers/rathena/Dockerfile`.
- **`conf/import/*`** — the app bind-mounts its own `conf` directory over
  `/rathena/conf/import` at `stack/src/cmds.rs:401-406`, so anything upstream
  writes there is shadowed at runtime and would be silently dead. The one line
  that mattered (`import: conf/battle/population_engine.conf`) is unnecessary
  for us because every setting is registered in `battle_config_init.inc` with a
  default, and the app writes the two we expose directly into the mounted
  `battle_conf.txt`.
- **`db/import/*`** — upstream's own server data, including a 136,000-line
  `job_stats.yml`. Not required by the engine: `population_engine_equipment_strict_load`
  defaults to off, so gear rows referencing items we do not have are warned
  about and zeroed rather than failing the load.
- **MSVC project files**, which we have no build path for.

## What we added

`patches/0002-master-enable-switch.patch`, plus a matching guard in
`files/src/map/population_engine.cpp` (search `RAGNAROKMAC`).

Upstream has no master on/off switch — population is driven by whatever
`db/population_spawn.yml` asks for, and `population_engine_max_count` has a
minimum of 1, so there is no way to express "none". We add
`population_engine_enable`, defaulting to **0**, which:

- returns from `do_init_population_engine_load_databases()` before any of the
  nine YAML databases are parsed or the autosummon timer is registered, so a
  disabled engine costs nothing at all; and
- refuses `@populate` and `@reloadpopenginedb` with a message pointing at the
  app's settings, rather than half-starting an engine whose databases were
  never loaded.

The app writes `population_engine_enable` and `population_engine_max_count`
into the mounted `conf/import/battle_conf.txt` from the Population section of
the Settings window (`electron/main.js`, `toBattleConf`).

This switch is worth offering upstream.

## What we changed, beyond the switch

The behavioural changes below are marked `RAGNAROKMAC` in the vendored sources.
They exist because upstream is tuned for a public server with hundreds of real
players, and this app is nearly always one person and a couple of friends.

### Recruitable party companions

A real player can recruit shells into a normal rAthena party: four by default
and up to eleven, set by **Party invitations** in the app's Population
settings. The player first whispers `party`, `pt`, `join`, or `invite`; the
shell stops for a 60-second invitation window and accepts that player's formal
party request.
After joining it:

- follows its recruiter between maps and teleports back when separated;
- uses deterministic free cells around the recruiter while idle;
- shares EXP through the ordinary rAthena party system;
- attributes its monster-drop ownership to its recruiter while both remain on
  the same map, so the recruiter's `@autoloot`, `@alootid`, and
  `@autoloottype` settings work normally;
- is excluded as an item-sharing recipient, preventing loot from being placed
  in an inaccessible shell inventory while preserving normal distribution
  between real party members;
- uses the same class, equipment, and skill data it had as an ambient shell;
- obeys party-wide Attack, Defensive, and Passive modes; and
- accepts individual Tank, Support, and Attacker roles from the party leader.

Only party-leader messages in party chat are commands. Full mode words can sit
inside sentences; the `atk`, `def`, and `pass` aliases must be the entire
message to avoid collisions with normal stat discussion. Role commands require
the shell's exact name and answer in party chat so the assignment is visible.
See the [AI companion guide](../../docs/COMPANIONS.md) for the player-facing
command reference. Implementation invariants, verification evidence, and the
future-work backlog are kept in the
[AI companion development guide](../../docs/COMPANION_DEVELOPMENT.md).

Companion death uses real PC semantics. The original actor stays targetable on
the map and in the party. Priest-line shells can cast level 3 Resurrection with
an intentionally unlimited virtual Blue Gemstone supply, and Yggdrasil Leaves
work normally when a player targets the corpse. Leaving the map releases a dead
companion. Ambient mortal shells retain their original timed-respawn behaviour.

The matching roBrowserLegacy change is a commit on our fork's `ragnarokoffline`
branch ([docs/FORKS.md](../../docs/FORKS.md)): a dead PC keeps its
`EntityManager` GID until a genuine removal packet arrives,
allowing `ZC_RESURRECTION` to update the existing corpse instead of creating a
second visual actor.

Ranged companion ammunition is also virtual because shell inventories are not
player-accessible. A single runtime module provisions and validates arrows for
bow-line weapons, bullets (or pre-renewal grenade spheres) for every rAthena
gun weapon type, and shuriken or elemental kunai when a Ninja skill needs them.
It selects useful elemental ammo for the current target, repairs the equipped
stack after map changes, and stops stocking before the shell becomes
overweight. All ammo uses normal `pc_isequip`/`pc_equipitem` validation;
invalid items are never forced into the equipment slot.

### Appearance, names, and ambient chat

Hair and clothes now use rAthena's client-supported palette constants instead
of hard-coded ranges that selected invalid values and collapsed most shells to
the same red-haired fallback. Profile ranges remain able to narrow the choice.

The generated-name tables use a root, consonant bridge, and ending structure,
providing 16,896 pronounceable combinations before repetition. The same shape
is used by the compiled fallback when no YAML-generated name is available.

Ambient chat now reports whether its timer is enabled at server startup. The
existing configurable chat categories and cooldowns are otherwise unchanged.

### Demand-driven population

Upstream's autosummon timer walks every entry in `db/population_spawn.yml` on
every tick and tops up each map to its quota, whether or not a human is there.
The shipped YAML asks for **4,060 shells across 124 maps**. With a global cap the
fill also runs in database order, so a low cap produces a crowded Prontera and
empty dungeons rather than a thin scatter.

We keep the YAML's densities and change only which maps they apply to:

- an occupied-map set, refreshed at most once a second from a pass over the pc
  list. It cannot be read off `mapdata->users`, because shells increment that
  themselves (`population_engine.cpp:1802`);
- `fill_category` and the vendor-placement pass skip maps that are not live;
- shells on maps vacated longer than `population_engine_demand_grace_ms`
  (default 5 minutes) are released;
- the autosummon interval drops from 10s to 2s when demand mode is on, because
  per-tick work is now proportional to occupied maps rather than to 124.

Net effect: the same per-map density, on the two or three maps anybody is
standing on. Because profiles overlap — a town appears in ~13 of them — an
occupied town lands around 20-25 shells and a field or dungeon rather more.

`population_engine_demand_spawn: 0` restores upstream behaviour exactly.

### Density is a setting, not a rebuild

`population_engine_density_pct` (default 100, range 10-500) scales every
category total *before* the engine distributes it across its map list, and
scales `max_per_map` and vendor placement targets with it. The world keeps the
shape it was authored with -- same maps, same job mixes, same weighting between
towns, fields and dungeons -- and only its crowding changes.

Without it, "how busy does one map feel" was a property of a YAML file inside
the container image, which no player can reach. `max_count` looks like that dial
but is not: it is a global ceiling that a solo game never approaches, because
demand-driven spawning only ever builds the map you are standing on.

Surfaced in the app as **How busy** (25-300%), which reads out as an estimated
per-map count against the measured ~40 at 100%.

### The Prontera fields were missing from the main profile

`db/population_spawn.yml` is upstream's, with one edit. Its `combat_pve`
profile carries the largest field population and the widest job pool
(Swordsman, Mage, Archer, Acolyte, Thief, Priest, Assassin, Rogue, Alchemist),
and its field list covered `gef_fild*`, `moc_fild*` and `pay_fild*` — but no
`prt_fild` maps at all. The Prontera fields, which is where a new character
actually spends its first hours, were reachable only through `pve_knight`
(100 shells across 11 maps), so `prt_fild08` held nine knights spread over a
full-size map and read as empty.

We added `prt_fild01`-`prt_fild11` to `combat_pve` and raised its
`FieldsPopulation` from 1000 to 1440, holding the per-map density at ~30 across
the now-48 maps. With the `pve_knight` shells on top, an early Prontera field
lands around 39.

Note the arithmetic that makes this affordable: the population is *distributed*
across the map list, so widening the list without raising the total would have
thinned every other field. Under demand-driven spawning only occupied maps are
ever built, so the declared total is a shape, not a cost.

### Wander only where someone can see it

The combat tick was already proximity-driven (`population_engine.cpp:1208`,
`map_foreachpc` over real players), but the wander sweep was not: it walked
every shell in the world every 500 ms via a cursor
(`population_engine_path.cpp:133`), which was the entire idle CPU cost of the
engine. It now skips shells whose map holds no real player. A shell standing
still on an empty map is indistinguishable from one wandering there, and it
starts moving again the moment somebody arrives.

### Shells pick up their loot

Upstream shells never pick anything up: with `item_auto_get` off, as it is by
default, every kill leaves its drops lying until they expire, which no real
player does. `population_engine_loot_enable` (off by default; Settings ->
Population -> Loot, which sets every knob below) lets an ambient shell walk over
and take the drops of its own kills, those it holds first loot priority on,
through stock `pc_takeitem`, so the client sees the pickup and `picklog` records
it under the shell's char_id (95000000 and up). The logic is in
`runtime/population_shell_loot.cpp`, run from the combat tick before target
selection; `patches/0026-shell-looting.patch` registers the settings.

It loots the way a player does. Each drop is decided once, when the shell
notices it:

- **Rare drops are very likely, not certain.** A card, or a drop whose base
  rate in the monster's table is at most `population_engine_loot_rare_rate`
  (per 10000, default 100 = 1%), is wanted with
  `population_engine_loot_rare_pickup_pct` chance (default 95).
- **Common drops at a base rate.** Anything else is wanted with
  `population_engine_loot_common_pickup_pct` chance (default 70); the rest it
  walks past.

And then fetched with a player's priorities:

- **Rare first.** A rare drop is fetched even while monsters attack the shell,
  unless its HP is below `population_engine_loot_hp_abort_pct` (default 30).
- **Fight first, otherwise.** A common drop waits until nothing is attacking or
  targeting the shell; a hit on the way there sends it back to the fight. A
  drop a fight held back is forgotten with `population_engine_loot_forget_pct`
  chance (default 10) once the fight is over.
- **Not forever.** A drop not reached within
  `population_engine_loot_timeout_ms` (default 15000; twice that for rare ones)
  is given up.
- A short reaction delay before going for a fresh drop, and a pause between
  pickups, so it does not vacuum the screen in one frame.

It looks `population_engine_loot_radius` cells (default 9) around itself.
Recruited companions are left out: their loot priority already belongs to their
owner (0003). The shell's inventory is runtime-only, so what it picks up is gone
when it despawns; a pickup that fails (full bag) gives the item up.

**Weight.** A shell stops looting at
rAthena's first overweight step (`natural_heal_weight_rate`, 50% pre-renewal and
70% renewal), with the same cap and the same unbonused carry limit as the ammo
stock. Without that it would loot on to 90%, where `Weight90` stops it attacking
and using skills, and a field would fill with shells standing still. A drop
that would take it past the cap is left on the ground, as a player with a full
bag would leave it.

**Selling trips.** With looting enabled, ordinary ambient shells that have
successfully picked something up leave with a teleport effect when their bag
is nearly full: 90% of the loot weight cap, at most one free inventory slot,
or an owned drop that would exceed the cap. They wait until not being attacked
or casting. The population timer checks existing bags even outside the player's
view, on maps containing a real player; combat and floor-item searches stay
proximity-limited. Starting gear and ammunition alone never trigger a trip.

A small in-memory snapshot reserves the shell's map/profile population slot
for a random 2–4 minutes. The normal autosummon pass then returns the same
name, class, base/job level, sex, hairstyle, colors, mounted appearance and
worn equipment selections at a valid location on that map. It has a new
internal id, freshly provisioned supplies and no collected loot. This is a
simulated selling trip: no NPC sale, zeny payment or market stock is created.

Reservations prevent normal refill during the absence and respect the global
live-shell limit and spawn budget. When the global cap is below the map quota,
other profiles on that same map cannot take the reserved slot; other maps can
still use spare global capacity. A failed spawn retains its reservation for
retry. Returns wait while the map has no real players; abandonment follows the
normal grace window and capacity-pressure cleanup. Reduced quotas cancel excess
returns. Reloading profiles, stopping the engine or disabling looting clears
the snapshots; nothing survives a server restart. A conflicting online name
cancels that return. Companions, vendors, manual/script-spawned actors, pending
recruits, arena shells and script-held shells do not take these trips.

The queue, trigger and deferred-departure checks execute C++ without a game server:
`python3 tests/diagnostics/verify-shell-returns.py` (requires a C++17 compiler;
`CXX` can select it). CI runs them alongside the server diagnostics. The callback
and unloading checks compile verbatim `DIAGNOSTIC-BEGIN` / `DIAGNOSTIC-END`
regions with server-boundary stubs. Keep each marker pair around its whole
function; the harness validates the markers without relying on C++ indentation
or brace placement. For live acceptance,
observe pickup, departure, the reserved headcount and the same
appearance returning, including map abandonment and recruitment during looting.

**The log grows faster.** Every pickup is a `P` row in `picklog`, beside the `M`
row the drop already wrote. rAthena never trims that table, so with a few
hundred shells looting it gains tens of thousands of rows an hour, which take up
space on the server's disk. Nothing reads it back except mods that ask for it
(prontera-vendors' market reads only `V`/`B` rows, by `id`). A long-running
server that loots can clear old rows from Settings -> Tools -> Database, or with
`ragnarok-stack sql --write "DELETE FROM picklog WHERE time < NOW() - INTERVAL 7 DAY"`
while the game is stopped.
Settings writes all of them (`electron/population-conf.js`, `shellLoot`); a mod
can still change any of them at runtime with `setbattleflag`.

### Vendors a mod can add

Upstream places vendors per map with one `VendorPlacement` each, and picks the
shell's stock by its job. A mod can now add its own vendors without changing
either. The additions do nothing unless a mod uses them; with no mods, the
engine's vendors spawn exactly as upstream's do.

- `Type: Pool` in `population_vendors.yml`: each shell draws `PickCount` items
  from a list, rolls each price by `PriceJitterPct`, rarely drops a digit
  (`PriceMistakeOneIn`), picks a title from `TitleFromPool`, and is replaced
  after `RotationHours` (or `RotationMinutes`) ± `RotationJitterMinutes` with
  a fresh pick. `{name}` in a shop title is the shell's own name.
- `StockTitles:` on a mod vendor: signs that name what is for sale, each
  `{ Title, Needs: [items], Any: [items] }`. A mod stall picks its sign after
  its stock, from `TitleFromPool` plus every `StockTitles` sign that stock
  bears out (all of `Needs`, one of `Any`), so a sign never names an item the
  stall lacks. `{item}` and `{price}` in one are filled from a line it really
  carries ("S> {item} {price}" reads "S> Elunium 13k"). Older builds ignore
  the key, so item names belong there, not in `TitleFromPool`; without it a
  stall picks its sign exactly as before.
- **Customers for players' stalls** (`runtime/population_customers.cpp`):
  once a minute, every vending stall and buying store a real player has
  open (online or `@autotrade`) gets the customers a busy server would
  bring, by the item's market price and demand (a mod price table's `Min`,
  `Max`, `BuyersPerDay`, `SellersPerDay`), the asking price, cheaper fake
  stalls on the map and how busy the map is. The sale is half of rAthena's
  own (`vending_purchasereq`, `buyingstore_trade`): zeny, tax, cart or
  inventory, the autotrade rows and the stock report; nobody is shown. The
  time the server was off is caught up for restored `@autotrade` stalls (up
  to 48 h), and what they did is mailed by RODEX. Off unless a mod sets the
  `$@pop_customers_*` variables (the file's header lists them); with no
  price table named it does nothing, not even its clock
  (`$pop_customers_clock`). `@vendorinfo customers [ff <minutes>]` shows the
  model for the player stalls on a map, or fast-forwards them.
- **Per-item price percentage**: a mod may set `$@pop_item_pct[<item id>]`
  (unset or 0 = 100) to move one item's price at runtime. The engine applies
  it, on top of the mod's price level, wherever it prices mod stalls and mod
  buyers and in the customers' market price. prontera-vendors' dynamic market
  sets it from its own NPC script.
- `Spawns:` on a vendor entry makes it a mod vendor. Each block names a `Map`
  and either fixed `Positions` (one shell per seat; a taken seat stays empty
  until it is free) or `Count` shells in `Areas` (with optional `MinSpacing`).
  `Fill: Lanes` fills the `Areas` one at a time in the order listed, each
  shell on a free cell within two cells of one already in that area, the way
  players open shops next to a busy street; the next area gets shells once
  the earlier ones have their share. `LaneFillPct: [70, 80]` sets that share
  of a lane's usable cells, rolled per lane (default 100: full), which leaves
  natural gaps; once every lane has its share the rest fill in order.
  `Fill: Random` (the default) spreads them over all areas.
  A shell in `Areas` keeps `min_npc_vendchat_distance` (3 cells) from any
  NPC, as a player's own shop must, so an NPC another mod puts there is not
  covered by a stall; fixed `Positions` are taken as given.
  Counts are exact unless `ScaleWithDensity: true`. Mod vendors are spawned by
  their own pass after the engine's, never count toward a map's `MaxVendors`,
  and do count toward the global Limit.
- `PlacementBound: true` on a profile in `population_vendor_pop.yml` keys the
  profile by its `VendorKey` instead of its job, so the job is only the sprite.
  A mod vendor's look comes from the profile with its key.
- Pool stock lines can say what a player's cart really holds: `Refine: 7` (or
  `[min, max]`), a forged `Element: Fire` with `Stars: 0-3`, or `Cards: [...]`.
  `Price: [min, max]` rolls in a range, `Undercut: { Chance, StepPct }` lists
  some items just under the cheapest rival shell stall on the map, and no
  price goes below the NPC sell value except a fat-finger.
- A mod vendor stall that sells out packs up, and its spot refills.
- A `Market:` entry holds spots (`Spawns:`) and a weighted list of themes
  (`Themes: [{ Theme, Weight, Min, Max }]`, each theme an ordinary vendor
  entry without Spawns). Every time a spot gets a stall it rolls a theme:
  first any below its Min, then by weight, each theme's weight divided by
  one plus the stalls of it already standing, skipping any at its Max. So
  the stalls change as they rotate rather than only on a restart.
- `Buying: true` on a Pool vendor makes its shells open a real buying store
  instead of a stall: up to 5 items from the pool (only items rAthena lets a
  buying store take), each with its wanted amount and a price rolled in its
  range at the mod's price level, never below what an NPC pays. The shell
  gets one of each item, exactly the zeny it offers and room to carry it all;
  when its store closes (all bought, or out of zeny) it packs up like a
  sold-out stall. Its callouts come from `buyer_call` in population_chat.yml.
  Patch 0020 keeps shells' buying stores out of the database, as 0001 does
  for vending.
- Patches 0029 (vending) and 0030 (buying stores): behind the battle flag
  `population_engine_list_stalls` (off by default), a shell's stall is also written to
  `vendings` / `vending_items` / `buyingstores` / `buyingstore_items` like a player's, so a script
  or mod can search the fake players' shops (the whosell mod switches it on with
  `setbattleflag`). A shell has no cart_inventory rows, so a vending row's `cartinventory_id` is
  `0x80000000 | item id`; buying rows already hold the item id. Closing a stall and every sale
  always clean up, so turning the flag off leaves nothing behind.
- Patch 0021: a pet egg bought from a shell's stall is created for the buyer
  there and then (`pet_create_egg`), since a stall's eggs are placeholders
  with no pet row and would not hatch; unsold eggs leave nothing behind.
- `@vendorinfo` (patch 0019) lists the mod stalls on the GM's map, or shows a
  theme's stock and prices or a market's themes.
- A mod's price table, `db/population_vendor_prices/<prefix>.csv` with rows
  `Id,Name,Min,Max`, prices the plain stock lines of the vendors whose key
  starts with `<prefix>/`, over their YAML Price. Hand-editable in a
  spreadsheet.
- `Callouts: { EverySeconds: [min, max], MapGapSeconds }` paces a mod vendor's
  callouts and keeps stalls on one map from talking over one another.
- Script commands (patch 0018) let a mod's settings reach its vendors at
  startup, per VendorKey prefix: `population_vendor_count` (a total split
  across the mod's Spawns by their Counts), `population_vendor_rotation`
  (minutes), `population_vendor_callouts` (on/off and pace),
  `population_vendor_limit` (whether they wait for room under the population
  limit) and `population_vendor_price` (price level in percent).
- `{item}` and `{price}` in a chat line name a real item from the speaking
  shell's own stall. The shipped `vendor_call` lines use them.
- Both vendor databases import `db/import/`, with empty stubs in
  `db/import-tmpl/`, so a mod's file is read rather than ignored.

`registry/mods/prontera-vendors` is the worked example (its generator is in
`registry/tools/prontera-vendors`).

### Shell control for mods

Nine script commands let a mod's NPC script find shells (`population_is_shell`,
`population_shells`), take one from the AI for a while (`population_hold`,
`population_unhold`), make or remove one (`population_spawn`,
`population_despawn`), handle whispers to it (`population_whisper_event`,
`population_whisper`), and hear when its follow loses someone
(`population_lost_event`). Everything else a script does with a shell is stock:
it is a real character, so `unitwalk`, `unittalk`, `emotion`, `unitattack` and
`unitskilluseid` already work on it.

It is kept out of the engine's own files, so an engine update merges around it:

| | |
|---|---|
| `patches/0027-shell-control-api.patch` | the script commands, in rAthena's `src/custom/script.inc` and `script_def.inc` only |
| `files/src/map/population_engine/runtime/population_shell_control.cpp` | all of the engine side; `population_engine.cpp` includes it, as it does `population_customers.cpp` |
| `files/src/map/population_engine/population_shell_control.hpp` | its declarations |
| `files/src/map/population_engine/core/population_shell_hold.hpp` | the per-shell state, one member (`hold`) on `s_population` |

What remains in the engine's own files are one-line hooks, each marked
`RAGNAROKMAC`: the combat tick, reactive casts, wander sweep, ambient chat and
name-mention replies skip a held shell (`population_engine_shell_is_held`); the
whisper handler asks `population_shell_control_whisper` first; the drift check
and the two map-quota counts skip `sd->pop.hold`; and the combat timer calls
`population_shell_control_sweep` before its stale sweep.

A hold belongs to the NPC that took it, is bounded (30 minutes at most), and
ends by itself when it lapses or its NPC is unloaded. The sweep also does the
part of three stock commands a player's client would: it puts a held shell
that `pc_setpos` took off the map back on it (`unitwarp`), walks one with an
attack order into range (`unitattack`), and runs its `pcfollow` in place of
rAthena's follow timer, which would teleport it onto a target it cannot reach:
a target that left by a portal is followed into that portal after a short
pause, and one that left any other way ends the follow and runs the lost
event. A shell `population_spawn` made is left out of the map quota counts.
Companions and vendors are never handed out. Nothing changes until a script
calls one of the commands.

The player-facing reference is [docs/mods/shell-control.md](../../docs/mods/shell-control.md).

### Shells pay for their skills

Upstream's shells never spent SP, for two reasons:

- `population_engine_spawn_shell` set `sd->state.autocast = 1` on every shell to
  get past `skill_isNotOk`'s cast-spam check. rAthena treats `autocast` as a
  card's or item's free skill, so `skill_consume_requirement` set every SP cost
  to 0, companions included. The flag is no longer set (marked `RAGNAROKMAC`).
  The spam check it bypassed is off at `skill_amotion_leniency: 0`, rAthena's
  default, which the app keeps.
- The immortality guard 0001 puts in `status_damage` refused everything
  positive for a shell without the `mortal` flag, and a skill's cost arrives
  there through `status_zap`. `patches/0031-shells-pay-skill-costs.patch`
  narrows it: an immortal shell still refuses whatever someone else does to it,
  but its own sourceless SP and AP costs (skills, and the upkeep `status_charge`
  takes for maintained statuses) go through. Sourceless HP loss is still dropped,
  since poison and bleeding ticks have no source either.

Shells regenerate SP as players do: `map_addiddb` puts them on rAthena's regen
list at spawn, and the engine's casting checks (`sp_cost > sp`, the minimum-SP
floor for buffs) were already in place for when SP runs short.

Shells also carry potions (`pop_shell_stock_potions`): 10 HP and 5 SP potions of
their level's Tool Dealer kind, from Red Potion and Grape Juice up to White and
Blue Potions. While needed (the test that stands a resting shell up) and below
40% HP or 20% SP, `pop_shell_drink` uses one through `pc_useitem`, at most one a
second, so the item delay and the heal script are the player's own. The use
animation is sent by the engine (`ZC_USE_ITEM_ACK` to the area), because
`clif_useitemack` sends nothing for a character without a session. The stock is given on the first combat tick, so vendors never get
one and a recalled companion gets its restored level's kind, and it is topped
up when a rest ends at the upper mark. A shell back from a selling trip is
spawned anew, so it has a fresh stock too.

### Shells built to their level

Upstream rolled each stat straight from the profile's `Str`..`Luk` range, whatever
the shell's level, and a profile that declares no ranges got 90-109 in all six. The
shipped `novice_default`, `combat_pve_low`, `combat_pve_low_transcended`,
`combat_pve` and `combat_pve_high` declare none, so a level 10 Acolyte had about 100
in everything.

The rolls are now only the shape of the build (`pop_shell_spend_to_level`, marked
`RAGNAROKMAC`):
- every stat starts at 1;
- the shell gets the points a character of its level has, the stock table plus the
  transcendent bonus, as `pc_resetstate` gives them;
- it spends them a point at a time, at the stock cost and within the job's cap, on
  whichever stat is furthest behind its share of the target.

A stat a profile leaves out is not invested in. A profile that declares none gets its
job line's build (`pop_shell_job_build`) instead. Points left over stay in
`status_point`, for a companion's growth to spend. A recalled companion keeps the
stats saved with it.

Trait stats (`Pow`..`Crt`) work the same way (`pop_shell_spend_traits_to_level`):
- they start at 0;
- the shell gets the trait points a character of its level has (none up to level 200,
  about 4 a level after it, from `get_trait_table_point`);
- they are spent toward the rolled ranges at the stock cost and within the trait cap.

A trait the profile does not declare stays 0. Only the `companion_fourth_*` profiles
declare any.

## Measured cost

Alpine/musl, arm64, packetver 20221005, map server only, 4 GiB guest:

| | shells | map-server RSS | CPU |
|---|---|---|---|
| engine off | 0 | 439 MiB | ~1% |
| demand-driven, nobody logged in | 0 | 435 MiB | 0.9% |
| upstream behaviour (`demand_spawn: 0`), cap 200 | 163-184 | 510 MiB | 5.7% |
| upstream behaviour, cap 2000 | 1855 | 960 MiB | 22-25% |

The middle row is the point of the exercise: with the engine switched **on** and
nobody playing, it costs what having it off costs. The upstream row is what we
used to pay around the clock for a world nobody was looking at.

Per-shell resident cost is **~0.3-0.4 MB** — 0.38 MB at 184 shells, 0.28 MB at
1855 as allocator overhead amortises. Either way it is roughly five times
upstream's ~80 KB, which is the size of the struct rather than the resident cost
once inventory and skill arrays are counted. `src/settings.html` budgets on 0.4,
deliberately the pessimistic end.

**Memory is not the constraint; CPU is.** 1855 shells cost under a gigabyte in a
4 GiB guest, with the guest reporting no memory pressure — but they burn
22-25% of one core continuously with nobody logged in, against 5.7% at 184.
The map server is single-threaded, so that is a quarter of the budget the actual
game runs in, spent animating a world no one is looking at. This is exactly the
cost demand-driven mode exists to avoid: the same cap, with shells only on
occupied maps, costs nothing until somebody logs in.

`population_engine_max_count` is a ceiling, not a target: the spawn YAML asked
for 184 at a cap of 200. Densities also stack, because a map appears in many
profiles — a town is named by about 13 of them — so an occupied town lands
around 20-25 shells.

**Not yet measured:** cost with a real player online, which is when shells
actually tick, and therefore the true per-map count under demand-driven mode.
That needs a client session rather than a headless stack.

## Updating

1. Clone upstream, find the commit range over their rAthena import.
2. Regenerate `patches/0001-*` from the files rAthena already owns, and refresh
   `files/` from the rest.
3. Re-apply the `RAGNAROKMAC` guard to `files/src/map/population_engine.cpp`.
4. Delete `vendor/rathena` and re-run `scripts/bootstrap.sh` — the apply script
   stamps a checkout and refuses to re-patch one built from a different patch
   set.

`0001` is a patch against rAthena's own files and will rot as rAthena moves;
when a hunk stops applying the script fails loudly rather than shipping a
half-wired server.
