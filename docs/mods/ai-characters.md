# Where the AI characters go

The crowd the population engine creates is not scattered at random. Every AI
character is placed from one table, `db/population_spawn.yml`, and a mod can
add to that table or take it over entirely.

This is the page for that table. [Making mods](../MODDING.md) is the general
guide; nothing here is needed to write an ordinary mod.

## What the table says

One entry per **profile**. A profile is a group of jobs, defined in
`db/population_engine.yml`; at spawn time the engine resolves the profile to
every job that inherits from it and picks one at random per character. There
are fourteen:

```
novice_default   combat_pve_low   combat_pve      pve_knight
pve_paladin      pve_caster       pve_archer      pve_monk
pve_assassin     pve_rogue        pve_merchant_cart
pve_taekwon      pve_gunslinger   pve_ninja
```

Each entry carries three map lists — towns, fields and dungeons — a headcount
for each list, and an optional per-map cap:

```yaml
  - Profile: combat_pve_low
    Towns:
      - prontera
    TownsPopulation: 40
    Fields:
      - prt_fild08
      - gef_fild07
    FieldsPopulation: 30
    FieldsMaxPerMap: 20
```

**The headcount is a total for the list, not a number per map.** Each map gets
`floor(N / count)` characters and the first `N % count` maps get one more, so
the total comes out exactly. `MaxPerMap` clamps each map afterwards, which
matters when one map in a long list would otherwise absorb the remainder.

Vendors are not placed from here. They have their own table,
`db/population_vendors.yml`, which is **not** moddable yet — see
[what is not wired up](#what-is-not-wired-up).

## Adding to it

Ship `db/population_spawn.yml` in your mod and name only the profiles you care
about. Entries are matched by `Profile:`, and only the fields an entry actually
names are touched, so everything you leave out keeps the value it had. A
profile that is not in the shipped table is added whole.

Every list and every count has two forms, and picking the wrong one is the
mistake worth avoiding:

| Replaces | Appends to | What it is |
|---|---|---|
| `Towns:` | `TownsAdd:` | the town map list |
| `Fields:` | `FieldsAdd:` | the field map list |
| `Dungeons:` | `DungeonsAdd:` | the dungeon map list |
| `TownsPopulation:` | `TownsPopulationAdd:` | characters across all town maps |
| `FieldsPopulation:` | `FieldsPopulationAdd:` | across all field maps |
| `DungeonsPopulation:` | `DungeonsPopulationAdd:` | across all dungeon maps |
| `TownsMaxPerMap:` | `TownsMaxPerMapAdd:` | per-map cap for towns |
| `FieldsMaxPerMap:` | `FieldsMaxPerMapAdd:` | for fields |
| `DungeonsMaxPerMap:` | `DungeonsMaxPerMapAdd:` | for dungeons |

**Prefer the `Add` forms unless you mean to own the profile.** A plain `Fields:`
replaces the list, so adding one map to `combat_pve` means restating the twenty
already in it — and those twenty are then frozen into your mod, so when the
shipped table changes your copy quietly wins and the new maps never appear.

Adding a map without adding characters only spreads the existing ones thinner,
which is what the matching `…PopulationAdd` is for.

A whole working mod:

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
    FieldsMaxPerMap: 12
```

Duplicate map names are dropped rather than counted twice. A category's
headcount is divided between its maps, so a map named twice would take two
shares of it.

## Replacing it

Put `Clear: true` in the header. rAthena empties a database before reading a
file that asks for it, so the shipped table goes and only yours survives:

```yaml
Header:
  Type: POPULATION_SPAWN_DB
  Version: 1
  Clear: true

Body:
  - Profile: combat_pve_low
    Fields:
      - ro_isle
    FieldsPopulation: 40
```

That is the right shape for a server where the AI characters should be nowhere
except where you say. It is a big hammer: every profile you do not list stops
being populated at all, including `novice_default`, so new characters arrive to
an empty starting map.

If another enabled mod also ships this table, the two are combined as usual —
one header, both sets of entries — and a `Clear:` from *either* one applies to
the merged result.

## A trap the server will not report

Run the validator over anything you write:

```
python3 third-party/population-engine/validate.py
```

It exists because this data has failure modes that pass silently:

- **A job belongs to exactly one profile, and the last definition parsed wins.**
  A profile that loses all its jobs is skipped without a word, and every map it
  owned just stays empty.
- **A gear item in the wrong slot is rejected at load** and the character spawns
  naked.

Neither produces an error. Both look like a mod that loaded and did nothing.

Also worth knowing: the population engine is **off by default**. Settings →
Population turns it on, and with it off these databases are never read at all,
so a mod here changes nothing until someone enables the crowd.

## What is not wired up

Only the spawn table takes a mod's override. The other population databases
still read from one path and ignore `db/import` entirely:

```
population_engine.yml    profiles and which jobs belong to them
population_vendors.yml   where the stalls stand
population_vendor_pop.yml
population_chat.yml      what they say
population_names.yml     what they are called
population_gear_sets.yml what they wear
population_skill_db.yml  what they cast
population_pvp.yml
```

A mod's copy of any of those lands in a directory nothing opens, and the server
reports a clean load either way. If you need one of them, say so — the fix is
the same three lines that fixed this one.

## Why it used to be impossible

Worth recording, because the shape of the failure is a useful thing to
recognise. The population engine is a source modification to rAthena rather
than stock rAthena, and it read each of its tables from exactly one path:

```cpp
static std::string population_config_join_db(const char *basename)
{
	return std::string(db_path) + "/" + basename;
}
```

`db_path` is `db`, so the table came from `db/population_spawn.yml` and nowhere
else, while a mod's `db/` is mounted at `db/import`. The server never
complained: it loaded its own copy, reported `Loading '14' entries in
'db/population_spawn.yml'`, and the mod's maps stayed empty — indistinguishable
from a mod that worked and changed nothing.

The fix was to give the table a `Footer: Imports:` block, which is how every
stock rAthena table has always accepted an override, plus a stub in
`db/import-tmpl` so the import resolves when no mod supplies one. A named
import that is not there is an error on every start.

Because the engine is compiled into the map server, this arrived with a
container image build rather than an app update.

## See also

- [`examples/mods/island-population`](../../examples/mods/island-population) —
  the four-line worked example.
- [Making mods](../MODDING.md) — everything else a mod can do.
- [Settings: Population](https://ragnarokoffline.app/docs/settings-population) —
  the switches a player sees.
