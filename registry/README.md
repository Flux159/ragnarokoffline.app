# The mod list

Every mod the app can find and install is a folder in here. Getting one in is a
pull request, and that review is the only thing standing between a stranger's
code and somebody's game.

**The guide is [docs/mods/publishing.md](../docs/mods/publishing.md)**, also on
the site at <https://ragnarokoffline.app/docs/mods/publishing>. It covers the
folder layout, every `mod.json` field, updating and removing a mod, what a
reviewer reads for, and what the app enforces on delivery.

The short version, for anyone already here:

1. Add `registry/mods/<name>/` — exactly the folder somebody would drop into
   their own mods directory, with a `mod.json` in it. No zip: the app fetches
   each file and checks it against a digest in the index.
2. Run `python3 scripts/mod-index.py`, which rebuilds `index.json` from the
   folders, and commit that too.
3. Open the pull request. CI runs `python3 scripts/mod-index.py --check`, so an
   index that does not match the files fails before anyone reads it.

Folder names are the mod's identity: lowercase letters, digits, `-` and `_`.
