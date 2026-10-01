# Adding a mod to the registry

Settings → Mods → **Find Mods** lists every mod in this repository's
[`registry/`](../registry). Getting one listed is a pull request here, and that
review is what stands between a stranger's code and somebody's game.

A mod is not data. It can ship NPC scripts the server executes, a
`conf/groups.yml` deciding which commands players get, and a `client/index.js`
that runs inside the game page. Nothing in the app tries to make an unreviewed
mod safe to install, because nothing could. What the registry offers is a
reviewed list and a delivery that cannot be tampered with on the way.

Writing the mod itself is [Making mods](MODDING.md). This page is about
listing one.

> **The registry format is being redesigned.** The community is working out a
> fuller "packages" format on the Discord. What is described here is the format
> the app reads today, including the `source` field added for mods that live in
> their own repository. It is deliberately small so it can fold into whatever
> comes next; if you are designing that, this page is the current contract.

## Two kinds of entry

| | **Files in this repository** | **Your own repository, with releases** |
|---|---|---|
| What you add here | the whole mod, as `registry/mods/<name>/` | a `mod.json` that says where the mod lives, plus optional pictures |
| What is reviewed | every file, every version | the repository, once, when it is added |
| How an update reaches players | another pull request here | you publish a GitHub Release; players see **Update available** |
| What the app checks on delivery | every file against a SHA-256 in the index | the release unpacks safely, is a valid mod, and suits this app version |
| Good for | small, stable mods; anything a reviewer should read each time it changes | mods under active development, released often |

Both kinds show up in the same list and install with the same button. A mod
from its own repository is marked **from GitHub**, and its install dialog says
which repository and release it is about to install.

If you are unsure, start with files in this repository. Moving to your own
repository later is a one-file pull request.

## Files in this repository

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

**There is no zip.** The app downloads each file from this folder and checks it
against a SHA-256 recorded in the index, then writes the whole mod into place or
none of it. A zip beside the source would be a second copy of the same bytes
that can drift from the reviewed one.

The index only carries these extensions, so anything else is a decision to make
in [`scripts/mod-index.py`](../scripts/mod-index.py), not a file to sneak in:
`.json .yml .yaml .txt .lua .lub .js .mjs .css .html .png .bmp .jpg .gif .spr
.act .gat .gnd .rsw .rsm .wav .mp3 .ttf .md`.

To update: raise `version` in `mod.json`, change the files, regenerate the index
and open another pull request. The app compares versions and offers the update.

## Your own repository, with releases

For a mod that changes faster than a pull request here could keep up with. The
entry is a reviewed pointer; the mod itself lives in your repository, and each
release you publish is what players install.

```
registry/mods/standart-npc/
└── mod.json
```

```json
{
  "name": "standart-npc",
  "author": "MondoTruth and the Ragnarok Offline community",
  "description": "Warper, Buffer, Job Master and a town's worth of other custom NPCs in one mod.",
  "tags": ["npc", "warper", "buffer", "quality-of-life"],
  "homepage": "https://github.com/MondoTruth/standart-npc",
  "source": {
    "github": "MondoTruth/standart-npc",
    "asset": "standart-npc-*.zip"
  }
}
```

| `source` field | |
|---|---|
| `github` | `owner/repo`. The only repository the app will fetch this mod from |
| `asset` | optional. Which file of a release is the mod: a name with `*` (any run of characters) and `?` (one character), ending in `.zip`. Matched against the whole asset name, case-insensitively |

Without `asset`, or when no asset of a release matches it, the app installs
GitHub's own **Source code (zip)** of the release tag. That works for a
repository that keeps the mod at its root, at the cost of shipping whatever else
is in the repository (README, CI files) into the player's mods folder. An asset
is cleaner.

The registry folder for a source entry holds `mod.json` and, if you want them,
pictures for the list (`icon`, `screenshots`, as in any entry). Nothing else:
the mod's files belong in your repository, and `mod-index.py` refuses anything
that is not a picture. It also refuses a `version` here, because the version is
whichever release is latest — the one in that release's own `mod.json`.

### Cutting a release the app picks up

1. **Raise `version` in your `mod.json`** and commit. This is what the app shows
   as the installed version.
2. **Tag it and publish a GitHub Release** for the tag. The tag is what the app
   compares to decide whether there is an update: `v4.8.0` and `4.8.0` are both
   fine, and are compared as dotted numbers (`v4.10.0` is newer than
   `v4.9.0`). Keep tags increasing.
3. **Attach the mod as a zip** whose name matches your `asset` pattern —
   `standart-npc-4.8.0.zip`. Either layout works:

   ```
   standart-npc-4.8.0.zip            standart-npc-4.8.0.zip
   └── standart-npc/                 ├── mod.json
       ├── mod.json                  ├── npc/…
       ├── npc/…                     └── db/…
       └── db/…
   ```

   That is, `mod.json` at the top of the zip, or inside its one top-level
   folder. Whatever the folder is called, the mod is installed under the
   registry's name, because that is its identity: it is what `disabled.txt`
   lists and what the player's settings are stored under.
4. **Publish it as a full release.** Drafts and pre-releases are never offered;
   the app asks GitHub for `releases/latest`, which is the newest non-draft,
   non-prerelease release. Use a pre-release to test something with a few
   people before everyone is offered it.

What the app refuses, so there is no point shipping it: a zip over **50 MB**,
one that unpacks to more than **96 MB** or **2000 files**, any path that climbs
out of the folder (`../`), absolute paths, symbolic links, and a `mod.json` the
app's own manifest reader would refuse (unknown `requires` keys, bad settings).

**`requires.app`** in the release's `mod.json` is checked before anything is
replaced. A player on an older app is told which version they need, and keeps
the version they have:

> standart-npc 4.9.0 needs app >=1.5.0, and this is 1.4.1. Update the app
> first; nothing was changed.

So raise `requires.app` whenever you start relying on something new in the app,
and players on older builds simply stay on your last release that worked for
them.

### How updates reach players

Nothing updates by itself. When a player opens Settings → Mods, or presses
**Check for updates**, the app asks GitHub for the latest release of each mod
they installed from its own repository. A newer one shows as

> Update available (v4.7.1 → v4.8.0) **Update…** · Release notes

**Update…** downloads the release, checks it, and only then shows a dialog
with the repository, the tag, the file and its SHA-256, what kind of code the
release carries, and the start of your release notes. The new version replaces
the old one in a single rename; if anything fails before that, the old version
is untouched. The player's options for the mod and whether it is switched on
live outside the mod's folder, so an update keeps them — provided your setting
keys keep their names. Renaming a key is, to the app, removing one option and
adding another.

Write release notes for players: they see the first few hundred characters in
that dialog, and the rest is one click away.

Lookups go to `api.github.com` without signing in, which GitHub limits to 60 an
hour per network. The app caches each answer for five minutes and only looks
when asked, so this is hard to reach in practice; when it is reached, the player
is told when to try again.

The installed copy carries a small `.source.json` (repository, tag, asset name,
SHA-256 of the downloaded zip, install time). That is how the app knows where
to look for updates; a copy installed from a zip by hand has none and is never
updated over.

## mod.json in the registry

The index is generated from these files, never hand-written.

| Field | |
|---|---|
| `name` | must match the folder name: lowercase letters, digits, `-` and `_` |
| `description` | the one thing every reader sees before installing. Say what changes |
| `author` | shown next to the name |
| `tags` | up to eight; lowercase letters, digits and `-`, up to 24 characters. What search matches and what a reader clicks to find more of the same |
| `icon` | one picture inside the folder, shown in the list |
| `screenshots` | up to four pictures inside the folder, shown on the mod's page |
| `homepage` | optional, `https` only. Defaults to the repository for a source entry |
| `version` | files-in-repository entries only |
| `requires.app` | the app version you need, e.g. `">=1.3.4"`. For a source entry, put it in each release's own `mod.json` |
| `requires.era` | `renewal`, `pre-renewal` or `any` |
| `requires.mods` | other mods this one cannot work without |
| `after` | mods you are applied after, so your copy of a shared table wins |
| `source` | a source entry: `{ "github": "owner/repo", "asset": "pattern.zip" }` |

Pictures are paths inside the registry folder, never URLs. The app fetches them
from this repository and checks them against the index like any other file, so
a picture is as reviewed as the entry: `.png`, `.jpg`, `.gif`, `.webp`.

The full `mod.json` reference for the mod itself — settings, `settingsPage`,
`default`, the folders a mod can ship — is [Making mods](MODDING.md).

## Opening the pull request

```sh
python3 scripts/mod-index.py          # rebuilds registry/index.json
python3 scripts/mod-index.py --check  # what CI runs
```

Commit the regenerated `registry/index.json` with your folder. CI runs the
check, so an index that does not match the folders fails before anyone reads
it. The check never talks to GitHub: for a source entry it validates the shape
of `source`, not the repository behind it.

An app that predates source entries ignores them — it sees an entry with no
`mod.json` among its files and drops it — so adding one cannot break older
builds.

## Review and trust

For **files in this repository**, a reviewer reads the mod, and every later
version is reviewed again. Read it as code, because some of it is:

- `conf/groups.yml` and `conf/atcommands.yml` decide what commands players get.
- `npc/` is script the server executes; `client/` runs in the game page.
- `db/` changes the rules of the world — cheap to read, and where an honest
  mistake does the most damage.
- Does the description match what the files do?

For **your own repository**, the review is of the repository and its author,
once. Expect a reviewer to read the current release as above, and also to ask:

- Is the repository public, and are releases built from what is in it? A
  release asset somebody uploaded by hand from their own machine is not
  something anyone can read.
- Does it have a licence? Players are installing your code; a licence says what
  they and others may do with it. The registry does not require one today, but
  a reviewer will ask.
- Is there a history of releases that match their notes?

**The registry vouches for the repository, not for each release.** Once listed,
your releases reach players without review here, and the app says so in the
install dialog, naming what the release carries — server scripts, game-window
code, command permissions. That is a real grant of trust from every player who
clicks Update. If a listed repository starts shipping something it should not,
removing its entry from the registry stops the app offering it and its updates
to anyone; players who already installed it keep their copy, the same as for a
removed in-repository mod.

What the app enforces regardless of kind is about delivery, not trust: files
come only from this repository or the named GitHub repository over HTTPS;
nothing is unpacked outside the mod folder; nothing is installed until the
player has seen what it is and said yes; and a mod installs whole or not at all.

## Testing locally

**The mod itself.** Drop the folder (or your release zip, through **Install
from a folder…**) into a test install and switch it on — see
[Making mods](MODDING.md). A release zip that installs that way will install
from the registry the same way: both go through the same unpacking and checks.

**The registry entry.** `python3 scripts/mod-index.py --check` after
regenerating. To see the entry in the app before it is merged, push the branch
to your fork and point the app at that branch's index — the app fetches every
other file relative to it:

```sh
RAGNAROK_MOD_INDEX=https://raw.githubusercontent.com/<you>/ragnarokoffline.app/<branch>/registry/index.json \
RAGNAROK_OFFLINE_HOME=/tmp/ro-test npm start
```

`RAGNAROK_OFFLINE_HOME` gives that run a scratch data folder, so the test never
touches your real mods. Quit any other copy of the app first (see
[CONTRIBUTING.md](../CONTRIBUTING.md)).

**The update path.** Install your second-newest release, then publish (or
already have) a newer one: opening the Mods tab should show **Update available**.
The automated tests do this against a fake GitHub on localhost —
[`tests/mod-source.test.cjs`](../tests/mod-source.test.cjs) — and are the
quickest way to try a change to the mechanism itself.

## Removing an entry

Delete the folder and regenerate the index. Anyone who already installed the
mod keeps their copy — it lives in their own mods directory — but they stop
being offered it, and for a source entry, its updates.
