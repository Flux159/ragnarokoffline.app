# Getting your mod into the app

**The guide is [Adding a mod to the registry](../MOD_REGISTRY.md).** This page
is the short version.

Settings → Mods → **Find Mods** lists every mod in this repository's
`registry/`, and getting one listed is a pull request. That review is the
security model: a mod can ship server scripts, command permissions and code
that runs in the game page, and nothing in the app could make an unreviewed one
safe.

An entry is one of two kinds:

- **Files in this repository** — `registry/mods/<name>/` is the whole mod. The
  app fetches each file and checks it against a SHA-256 in the index. Every
  version is a new pull request, and every version is reviewed.
- **Your own repository, with releases** — `registry/mods/<name>/mod.json`
  carries `"source": { "github": "owner/repo", "asset": "my-mod-*.zip" }`. The
  app installs your latest GitHub Release and offers newer ones as
  **Update available**. The registry vouches for the repository once; your
  releases reach players without review here, and the install dialog says so.

Either way:

```sh
python3 scripts/mod-index.py      # rebuild registry/index.json
python3 scripts/mod-index.py --check
```

and commit the regenerated index with your folder.

[Adding a mod to the registry](../MOD_REGISTRY.md) covers the `mod.json`
fields, cutting a release the app picks up (asset naming, zip layout,
versioning, `requires.app`), how updates reach players, what a reviewer reads
for, and testing locally.

## See also

- [Making mods](../MODDING.md) — writing one in the first place.
- [Where the AI characters go](ai-characters.md) — the population engine's
  spawn table.
