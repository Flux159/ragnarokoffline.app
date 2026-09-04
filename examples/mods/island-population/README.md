# island-population

**This mod does not work, and the reason is worth more than the mod would be.**

It is here because §3.7 of the brief asks whether a mod can put AI characters on
a custom map, and the answer — read out of the loader rather than guessed — is
no, not without a change to the engine.

## The wall

The Population Engine is a source modification to rAthena, not stock rAthena,
and it does not participate in the `db/import` mechanism at all. Every one of
its tables is loaded from exactly one path:

```cpp
// third-party/population-engine/files/src/map/population_engine/config/population_config.cpp
static std::string population_config_join_db(const char *basename)
{
	return std::string(db_path) + "/" + basename;
}
```

`db_path` is `db`, so `population_spawn.yml` is read from `db/population_spawn.yml`
and from nowhere else. There is no import path in the list, no era subdirectory,
and no second load that could merge one in.

Meanwhile `scripts/apply-server-mods.sh` copies the engine's tables into the
rAthena checkout at **image build time**, so the file that is actually read
lives inside the container image. A mod's `db/population_spawn.yml` is mounted
at `db/import/population_spawn.yml`, which nothing opens.

The server does not complain. It loads its own copy, reports
`Loading '14' entries in 'db/population_spawn.yml'`, and the island stays
empty — which is indistinguishable from a mod that loaded and did nothing.

## What it would take

Six lines in the engine, and an image build to ship them:

```cpp
static std::string population_config_join_db(const char *basename)
{
	// A mod's tables arrive at db/import; prefer one when it is there.
	std::string import = std::string(db_path) + "/" + DBIMPORT + "/" + basename;
	if (std::filesystem::exists(import))
		return import;
	return std::string(db_path) + "/" + basename;
}
```

That is replace-not-merge, which is the right shape for this table: the spawn
config is a distribution across the whole world, and a partial override that
merged would silently halve somebody else's population. It also means a mod
that touches it must ship the whole file — which is why the one in `db/` here
is complete rather than a fragment.

The narrower alternative — the supervisor bind-mounting a merged file over
`/rathena/db/population_spawn.yml` — was considered and does not survive
contact: single-file binds are unreliable when the host path contains a space,
and on macOS the state directory is under `Application Support`.

## The trap that is already documented, and still applies

`third-party/population-engine/validate.py` exists because this YAML has two
failure modes the server never reports:

- **A job belongs to exactly one profile, and the last block parsed silently
  wins.** A profile that loses all its jobs is skipped without a word and the
  maps it owns just stay empty.
- **A gear item in the wrong slot is rejected at load** and the shell spawns
  naked.

Run it over anything you write here:

```
python3 third-party/population-engine/validate.py
```

## Status

Blocked. Tracked against issue
[#6](https://github.com/Flux159/ragnarokoffline.app/issues/6)'s wider "mods
should reach further into the server" theme; the engine change belongs in the
next image build, not in a mod.
