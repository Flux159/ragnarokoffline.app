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

## What mod.json can say about itself

Everything below is optional and everything is read out of the folder, so the
index is never hand-written.

```json
{
  "name": "no-seed-cost",
  "version": "1.0.1",
  "author": "Your Name",
  "description": "One or two sentences. This is what somebody reads before deciding.",
  "tags": ["homunculus", "quality-of-life"],
  "icon": "images/icon.png",
  "screenshots": ["images/one.png", "images/two.png"],
  "homepage": "https://github.com/you/your-mod",
  "requires": { "app": ">=1.2.0", "era": "renewal", "mods": ["another-mod"] },
  "after": ["another-mod"]
}
```

- **`tags`** are up to eight short labels, lowercase letters, digits and `-`.
  They are what the search matches on and what a reader clicks to find more of
  the same, so `quality-of-life` is worth more than `mod`.
- **`icon`** and **`screenshots`** are paths to pictures *inside your folder* —
  never URLs, so the app fetches them from the same reviewed place as the rest
  of your mod and checks them against the same digests. Up to four screenshots,
  `.png`, `.jpg`, `.gif` or `.webp`. Keep them to a size somebody on a slow
  connection will forgive.
- **`requires.mods`** refuses to load your mod unless those are installed and
  switched on. **`after`** only says you should be applied later than them, so
  your copy of a shared table wins. Use `after` when you merely have a
  preference and `requires` when you genuinely cannot work without it.

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
