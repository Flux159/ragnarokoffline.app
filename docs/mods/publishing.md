# Getting your mod into the app

Settings → Mods has a **Browse** list. Every mod in it is a folder in this
repository, and getting one in is a pull request.

That review is the whole security model. A mod is not data: it can ship NPC
scripts the server executes, a `conf/groups.yml` deciding which commands
players get, and a `client/index.js` that runs inside the game page. Nothing in
the app tries to make an unreviewed mod safe to install, because nothing could.
What the app guarantees is narrower and worth having: the bytes that arrive are
the bytes that were reviewed.

Writing the mod itself is [Making mods](../MODDING.md). This page is only about
publishing one.

## What you add

One folder, `registry/mods/<your-mod>/`, containing exactly what somebody would
drop into their own mods directory:

```
registry/mods/my-mod/
├── mod.json
├── db/skill_db.yml
├── npc/my_npc.txt
└── images/
    ├── icon.png
    └── screenshot.png
```

The folder name is the mod's identity. Lowercase letters, digits, `-` and `_`.

**There is no zip.** The app downloads each file from this folder and checks it
against a SHA-256 recorded in the index, then writes the whole mod into place
or none of it. A zip beside the source would be a second copy of the same bytes
that can silently drift from the reviewed one, and a reviewer would have to
verify the two match by hand. Zips are still how you hand a mod to a friend
directly — see [Sharing a mod](../MODDING.md#sharing-a-mod) — just not how the
registry works.

## mod.json

The index is generated from this, never hand-written:

```json
{
  "name": "my-mod",
  "version": "1.0.0",
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

| Field | What it does |
|---|---|
| `name` | must match the folder name |
| `description` | the one thing every reader sees before installing. Say what changes |
| `tags` | up to eight, lowercase letters, digits and `-`. What search matches and what a reader clicks to find more of the same. `quality-of-life` earns its place; `mod` does not |
| `icon` | one picture, shown in the list |
| `screenshots` | up to four, shown on the mod's page |
| `homepage` | optional, and only used when it is `https` |
| `requires.app` | the app version you need. A player on an older build gets a named refusal instead of a mod that half works |
| `requires.era` | `renewal`, `prerenewal` or `any` |
| `requires.mods` | refuses to load unless those are installed and switched on |
| `after` | you are merely applied later than those, so your copy of a shared table wins |

Use `requires.mods` when you genuinely cannot work without another mod, and
`after` when you only have a preference about order.

**Pictures must be paths inside your folder, never URLs.** The app fetches them
from the same reviewed place as the rest of your mod and checks them against
the same digests, so a picture is as reviewed as the code. `.png`, `.jpg`,
`.gif` and `.webp`. Keep them to a size somebody on a slow connection will
forgive.

## Opening the pull request

```sh
python3 scripts/mod-index.py     # rebuilds registry/index.json from the folders
```

Commit the regenerated `index.json` along with your folder, then open the pull
request. CI runs `python3 scripts/mod-index.py --check`, so an index that does
not match the files fails before a human reads it.

Limits the app enforces, so there is no point exceeding them: 16 MB per file,
96 MB per mod, 600 files.

## Updating or removing one

Raise `version` in `mod.json`, change the files, regenerate the index, and open
another pull request. The app compares versions and offers the update.

To remove a mod, delete the folder and regenerate. Anyone who already installed
it keeps their copy — it lives in their own mods directory, not in the app —
they simply stop being offered it.

## What a reviewer reads for

If you are reviewing one rather than submitting one, this is the list. Read it
as code, because some of it is.

- **`conf/groups.yml` and `conf/atcommands.yml` decide what commands players
  get.** A mod shipping either is changing who can do what on somebody's
  server. The app labels these in Settings; the review decides whether that is
  what the mod is *for*.
- **`npc/` is script the server executes.** `client/index.js` is a module that
  runs in the game page with access to the client's own interface.
- **`db/` changes the rules of the world.** Cheap to read, and where an honest
  mistake does the most damage.
- **Does the description match what the files do?** That is what a player reads
  before deciding, and the one thing no amount of tooling can check.

## What the app enforces

Not trust. The review is the trust. This is only about delivery:

- every file is checked against the SHA-256 in the index;
- files are fetched from this repository's own path and nowhere else, so an
  entry cannot point its download at an unreviewed host;
- a mod installs whole or not at all, so an interrupted download cannot leave
  half a mod behind;
- paths that climb out of the mod folder are refused.

## See also

- [Making mods](../MODDING.md) — writing one in the first place.
- [Where the AI characters go](ai-characters.md) — the population engine's
  spawn table.
