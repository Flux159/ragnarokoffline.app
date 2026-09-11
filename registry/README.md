# The mod list

Every mod the app can find and install is a folder in here. Getting one in is a
pull request, and that review is the only thing standing between a stranger's
code and somebody's game — so it is worth doing properly.

## Submitting a mod

1. Add your mod as `registry/mods/<name>/`, exactly the folder somebody would
   drop into their own mods directory. It needs a `mod.json`.
2. Run `python3 scripts/mod-index.py`, which rebuilds `index.json` from the
   folders. Commit that too.
3. Open a pull request. CI runs `python3 scripts/mod-index.py --check`, so an
   index that does not match the files fails before anyone reads it.

Folder names are the mod's identity: lowercase letters, digits, `-` and `_`.

## What a reviewer is looking for

A mod is not data. Read it as code, because some of it is.

- **`conf/groups.yml` and `conf/atcommands.yml` decide what commands players
  get.** A mod that ships either is changing who can do what on somebody's
  server. The app already labels these mods in Settings; the review is where it
  gets decided whether that is what the mod is for.
- **`npc/` is script the server executes**, and `client/index.js` is a module
  that runs in the game page with access to the client's own interface.
- **`db/` changes the rules of the world.** Cheap to read, and the place where
  an honest mistake does the most damage.
- **Check that the description matches what the files do.** That is the part a
  player reads before deciding, and it is the part nothing else can verify.

## What the app enforces

Not trust — the review is the trust. The app makes sure the bytes that arrive
are the bytes that were reviewed:

- every file is checked against the SHA-256 in the index;
- files are fetched from this repository's own path and nowhere else, so an
  entry cannot point its download at an unreviewed host;
- a mod installs whole or not at all, so an interrupted download cannot leave
  a half-mod behind;
- paths that climb out of the mod folder are refused.
