# How we change rAthena and roBrowserLegacy

The app builds two upstream projects it does not own: the
[rAthena](https://github.com/rathena/rathena) server and the
[roBrowserLegacy](https://github.com/MrAntares/roBrowserLegacy) client. It
changes both, and those changes come in two kinds, which live in two different
places:

| Kind | Where it lives | Why there |
|---|---|---|
| **A fix to the project itself** — a bug any user of it would want fixed | a commit on the `ragnarokoffline` branch of our fork | so it can be offered upstream as it is |
| **An addition that is ours** — the population engine, the stylist window, the app's wording, extension hooks | applied at build time by a script in this repository | it has no business upstream |

Until 1.2.5, both kinds were patches applied by scripts. The fixes are now real
commits, with authors and reasons, that can become upstream pull requests.

## The forks

| | Fork | Upstream |
|---|---|---|
| server | [Flux159/rathena](https://github.com/Flux159/rathena) | [rathena/rathena](https://github.com/rathena/rathena) |
| client | [Flux159/roBrowserLegacy](https://github.com/Flux159/roBrowserLegacy) | [MrAntares/roBrowserLegacy](https://github.com/MrAntares/roBrowserLegacy) |

Each has two branches that matter:

- **`master` mirrors upstream.** Nothing of ours is ever committed to it. Keep
  it current with GitHub's *Sync fork* button. Branches for upstream pull
  requests start here.
- **`ragnarokoffline` is ours.** It is an upstream commit plus our fixes, one
  commit per fix. This is what the app builds.

`ragnarokoffline` refuses force-pushes and deletion (a repository ruleset named
`ragnarokoffline-history`). That matters: every release pins a commit on it, and
a rewritten branch would leave those commits on no branch at all, where GitHub
may eventually discard them. So the branch only ever moves forward, and newer
upstream comes in **by merging, never by rebasing**.

## Pins

`config/VENDOR_PINS` says exactly what gets built:

```
#   name              url                                                commit                                    branch
roBrowserLegacy   https://github.com/Flux159/roBrowserLegacy.git   <40-character commit>                     ragnarokoffline
rathena           https://github.com/Flux159/rathena.git           <40-character commit>                     ragnarokoffline
rathena-upstream  https://github.com/rathena/rathena.git           <the upstream commit that fork is based on>
```

Builds read only the commit. `scripts/vendor-fetch.sh <name> <dest>` fetches
that one commit, locally, in CI and in the release workflow alike, so a tag
always says what was built. The branch column is for one script:

```sh
scripts/vendor-bump.sh rathena          # move the pin to the tip of ragnarokoffline
scripts/vendor-bump.sh rathena <sha>    # or to an exact commit
```

It prints a compare link for reviewing what the bump brings in. It builds
nothing, so bump in its own commit, having built and tested it.

`rathena-upstream` is upstream rAthena without our fixes. Only the diagnostics
in `test.yml` use it: each one must still find its bug upstream, and must not
find it in our fork. When one stops finding its bug upstream, upstream has fixed
it, and our commit can go at the next merge.

A change to `VENDOR_PINS` rebuilds the server images (`images.yml` watches it),
because a moved rAthena pin changes the server as surely as a patch used to.

## What is where

### In the forks

Everything on `ragnarokoffline` past its upstream base is listed on GitHub:
[rAthena](https://github.com/Flux159/rathena/compare/master...ragnarokoffline),
[roBrowserLegacy](https://github.com/Flux159/roBrowserLegacy/compare/master...ragnarokoffline).
When they moved over in 1.2.5 they were:

**rAthena** — the four fixes found by the sanitizer investigation
([SANITIZER_INVESTIGATION.md](SANITIZER_INVESTIGATION.md)): the language mask
shift, the base SP conversion, the level-zero skill lookup and the weapon bonus
array bounds; and `@autoloot`, `@autoloottype` and `@showexp` surviving a logout.

**roBrowserLegacy** — upstream's own renderer-callback fix (#1418), cherry-picked
because our pin predates it; the equipment and character-select canvas resets;
character select no longer stalling on a missing or unreadable Lua file, with
progress logged while it waits; component roots filling their host; the quest
lists actually showing; hat and robe sprite names kept as EUC-KR bytes; drops
onto the equipment window and the cart; item-compare and stat-tooltip colour
codes; the `msgstringtablel.txt` fallback; the walk fast-forward clock; the skill
tree lineage; and a dead player keeping the GID that resurrection needs.

Each commit's message carries the full reasoning and how it was verified. The
last paragraph says where it was carried before (for example "Carried as 0017 in
scripts/patch-client.sh … since 076fd2d"), so the history behind a fix is one
`git log` away.

### Still applied by scripts here

| Script | Project | What it adds |
|---|---|---|
| `scripts/patch-client.sh` | roBrowserLegacy | the lockfile (`patches/package-lock.json`); the stylist window (`patches/Stylist.*`); the database-failure wording; saving the window layout when the page goes away, with a hook for the shell; the V4 equipment attachment strip |
| `scripts/patch-client-controls.py` | roBrowserLegacy | the extension runtime and its hooks, from `patches/client/` |
| `scripts/patch-bundle.sh` | roBrowserLegacy, built output | the navigation window, via `scripts/patch-navigation-client.cjs` |
| `scripts/apply-server-mods.sh` | rAthena | the crash trace, the population engine (`third-party/population-engine/`) and its party-chat hook |

Three of these hold fixes that belong upstream but did not come apart cleanly
in 1.2.5, and are candidates for the forks next:

- **The navigation window.** `patch-navigation-client.cjs` edits the *bundle*,
  not the source, and mixes real fixes (Navi table initialisation, click
  coordinates, an `innerHTML` injection, a `display` bug) with our redesign.
  Every edit has a plain source location; splitting the fixes out means porting
  that script to source and testing navigation in a real game.
- **Mixed edits in `patch-client.sh`.** The attachment strip carries a real
  visibility fix (`style.display = ''` cannot show an element its stylesheet
  hides) under our layout; the layout save on `pagehide` is a fix, while
  `window.roPersistUI` is for our shell. Each needs splitting in two.
- **`patch-client-controls.py`.** Touch pickup waiting for the walk, and
  `inputMode='numeric'` on number inputs, are general fixes inside a file that
  is otherwise our extension hooks.

## Working on a fix

Keep a working checkout of each fork beside this repository, with upstream as a
second remote:

```sh
git clone https://github.com/Flux159/roBrowserLegacy.git ~/Projects/roBrowserLegacy
git -C ~/Projects/roBrowserLegacy remote add upstream https://github.com/MrAntares/roBrowserLegacy.git
# and the same for rathena, with https://github.com/rathena/rathena.git
```

A rAthena clone is large; `--filter=blob:none` makes it quick and fetches file
contents as they are needed.

`vendor/` is not a working checkout. It is a pinned copy the build patches in
place, and `vendor-fetch.sh` puts it back on its pin, so work done there is lost.

### Changing or adding a fix

1. Branch from `ragnarokoffline` in the fork checkout, make the change, and
   commit it as a fix upstream could take: one change, and a message that says
   what was wrong and how you know. Nothing specific to this app belongs in it.
2. To try it in the app before pushing, fetch the branch into `vendor/`:

   ```sh
   git -C vendor/roBrowserLegacy fetch ~/Projects/roBrowserLegacy my-fix
   git -C vendor/roBrowserLegacy checkout --detach FETCH_HEAD
   ```

   then build as usual (`scripts/bootstrap.sh`, or the client steps in
   [TESTING.md](TESTING.md)).
3. Merge it into `ragnarokoffline` and push. A pull request against the fork's
   `ragnarokoffline` branch is the reviewable way to do that.
4. `scripts/vendor-bump.sh roBrowserLegacy`, build, test, and commit the pin
   change here.

If the fix touches a line one of the scripts above anchors on, the script now
fails with "no longer matches". Update the script's anchor in the same pull
request as the pin bump.

**Line endings in roBrowserLegacy.** Its `.gitattributes` sets
`* text=auto eol=crlf`, so files check out with CRLF and are stored with LF.
Git handles that; an editor or script that rewrites a whole file with different
endings will show a whole-file diff. Check `git diff --stat` before committing.

### Taking a newer upstream

In the fork checkout:

```sh
git fetch upstream
git switch master && git merge --ff-only upstream/master && git push origin master
git switch ragnarokoffline && git merge upstream/master
```

Resolve conflicts. Where upstream has fixed something we carried, take
upstream's version, so the fix does not appear twice. Then push, and here:

1. `scripts/vendor-bump.sh rathena` (or `roBrowserLegacy`).
2. For rAthena, set `rathena-upstream` to the upstream commit you merged:
   `scripts/vendor-bump.sh rathena-upstream <sha>`.
3. For roBrowserLegacy, regenerate `patches/package-lock.json` against the new
   commit with `npm install --package-lock-only`, as `patch-client.sh` explains.
4. Build, run the scripts twice (`test.yml` does), and test in a real game.

The population engine's own patches apply on top of the rAthena fork, so a
large upstream merge can move them; `third-party/population-engine/README.md`
covers regenerating them.

### Sending a fix upstream

A branch from `master` with only that commit on it:

```sh
git switch -c fix/cart-drop upstream/master
git cherry-pick <commit on ragnarokoffline>
git commit --amend    # drop the "Carried as" paragraph and the trailers
git push origin fix/cart-drop
```

and open the pull request from the fork against upstream. When it merges, it
arrives on `ragnarokoffline` with the next upstream merge; resolve that conflict
in upstream's favour.

## After a pin moves, locally

Nothing to do but build again:

```sh
scripts/bootstrap.sh
```

`vendor/rathena` and `vendor/roBrowserLegacy` have the build's changes applied
in place. Moving git onto a new commit underneath those fails -- git refuses
with "Please commit your changes or stash them" -- and anything it did carry
across would be the old build's changes on the new source. So when
`scripts/vendor-fetch.sh` finds a checkout on a commit other than its pin, it
fetches the new commit, then discards everything in that checkout except
`node_modules` (it says so as it does it), and checks the new commit out.
The build then applies its changes again from nothing.

That includes anything you edited in `vendor/` yourself. Work on a fix belongs
in a fork checkout; see [Working on a fix](#working-on-a-fix). A checkout that
is already on its pin is never touched.
