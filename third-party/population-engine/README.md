# Population Engine

Server-side fake players for rAthena: "shells" that walk, fight, sit, chat and
open real vending stalls, and that appear to any client as ordinary players in
the player list. No client modification is involved, so nothing on the
roBrowser side of this app knows they exist.

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

Two behavioural changes, both marked `RAGNAROKMAC` in the vendored sources.
They exist because upstream is tuned for a public server with hundreds of real
players, and this app is nearly always one person and a couple of friends.

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
