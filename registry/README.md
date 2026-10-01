# The mod list

Every mod the app can find and install has a folder in here. Getting one in is
a pull request, and that review is the only thing standing between a
stranger's code and somebody's game.

**The guide is [docs/MOD_REGISTRY.md](../docs/MOD_REGISTRY.md)**: both kinds of
entry, every `mod.json` field, cutting a release the app picks up, how updates
reach players, what a reviewer reads for, and testing locally.

The short version, for anyone already here:

1. Add `registry/mods/<name>/`, either
   - **the whole mod** — exactly the folder somebody would drop into their own
     mods directory, with a `mod.json` in it. No zip: the app fetches each file
     and checks it against a digest in the index; or
   - **a pointer to your own repository** — a `mod.json` with
     `"source": { "github": "owner/repo", "asset": "my-mod-*.zip" }` (and
     optional pictures). The app installs your latest GitHub Release and
     offers newer ones as updates.
2. Run `python3 scripts/mod-index.py`, which rebuilds `index.json` from the
   folders, and commit that too.
3. Open the pull request. CI runs `python3 scripts/mod-index.py --check`, so an
   index that does not match the files fails before anyone reads it. The check
   never contacts GitHub.

Folder names are the mod's identity: lowercase letters, digits, `-` and `_`.
