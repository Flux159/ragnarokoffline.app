# island-population

Puts twelve AI characters on the custom island from
[`custom-map`](../custom-map), and leaves every other map exactly as it was.

The whole mod is four lines of body in `db/population_spawn.yml`:

```yaml
Body:
  - Profile: combat_pve_low
    FieldsAdd:
      - ro_isle
    FieldsPopulationAdd: 12
```

## Why `FieldsAdd` and not `Fields`

`Fields:` **replaces** that profile's field list. Writing it here would take
`combat_pve_low`'s low-level characters off every field map they are supposed
to be on and strand all of them on the island — and it would need the twenty
map names already in the profile restated, which would then go stale the next
time the shipped table changes.

`FieldsPopulationAdd:` is the same argument for the headcount. A category's
population is divided between its maps, so adding a map without adding
characters just spreads the existing ones thinner.

To own the table outright instead of adding to it, put `Clear: true` in the
header. rAthena empties a database before reading a file that asks for it, so
the shipped table goes and only this one remains. That is the right shape for
a server where the AI characters should be nowhere except where you say.

## This did not used to work

Until 1.3.0 it could not. The Population Engine is a source modification to
rAthena rather than stock rAthena, and it read each of its tables from exactly
one path:

```cpp
static std::string population_config_join_db(const char *basename)
{
	return std::string(db_path) + "/" + basename;
}
```

`db_path` is `db`, so the table came from `db/population_spawn.yml` and nowhere
else, while a mod's copy is mounted at `db/import/population_spawn.yml`. The
server did not complain. It loaded its own copy, reported `Loading '14' entries
in 'db/population_spawn.yml'`, and the island stayed empty — indistinguishable
from a mod that loaded and did nothing.

What fixed it was a `Footer: Imports:` on the shipped table, which is how every
stock rAthena table has always taken an override, plus a stub in
`db/import-tmpl` so the import resolves when no mod supplies one. The `…Add`
forms came with it, because per-profile override alone still meant restating a
list to add one entry to it.

**The other eight population databases are still not wired this way** — chat
lines, names, gear sets, vendor placement. A mod's copy of those lands in a
directory nothing opens, exactly as this one used to.

## The trap that has not gone away

`third-party/population-engine/validate.py` exists because this YAML has two
failure modes the server never reports:

- **A job belongs to exactly one profile, and the last block parsed silently
  wins.** A profile that loses all its jobs is skipped without a word and the
  maps it owns just stay empty.
- **A gear item in the wrong slot is rejected at load** and the character
  spawns naked.

Run it over anything you write here:

```
python3 third-party/population-engine/validate.py
```
