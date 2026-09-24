# Keeping the forks current with upstream

A runbook for bringing new upstream commits into
[Flux159/rathena](https://github.com/Flux159/rathena) and
[Flux159/roBrowserLegacy](https://github.com/Flux159/roBrowserLegacy), written
so an agent can run it on a schedule with no one watching. It extends
[FORKS.md](FORKS.md) → *Taking a newer upstream*; read that first for the
branch model.

The job ends at **two open pull requests per fork that moved**, never at a
merge. A person lands them, after playing the build.

## What the agent may and may not do

| May | May not |
|---|---|
| fetch anything | push to `ragnarokoffline` on either fork |
| fast-forward a fork's `master` to `upstream/master` and push it (a pure mirror) | force-push anything, anywhere |
| push `upstream-sync-*` branches to the forks | merge any pull request |
| open or update pull requests on the forks and on this repository | tag, or run `build.yml` |
| run `images.yml` by hand on its own branch (review artifacts only) | edit `vendor/` and call it a fix |

`ragnarokoffline` refuses force-pushes and every release pins a commit on it, so
a mistake pushed there is permanent. That is why the agent stops at a PR.

## Cadence

Weekly. roBrowserLegacy moves quickly — 80 commits in the three weeks before
the first sync, several in windows our patches touch — and a small merge is one
you can read. rAthena moves slowly; most weeks it has nothing.

If an `upstream-sync-*` pull request from an earlier week is still open, **merge
the new upstream into that same branch** and update its description, rather
than opening a second one. Two open sync branches for one fork would conflict
with each other.

## 1. Is there anything to do?

For each fork, in a clone of it with `upstream` added (URLs in FORKS.md):

```sh
git fetch origin && git fetch upstream
git rev-list --left-right --count origin/ragnarokoffline...upstream/master
```

The right-hand number is how far behind we are. Zero: report "nothing new" for
that fork and stop. `origin/master` behind `upstream/master` by a fast-forward:
push it (`git push origin upstream/master:master`). If `master` has diverged,
something is wrong — say so and do not touch it.

## 2. Merge

```sh
git switch -c upstream-sync-$(date +%F) origin/ragnarokoffline
git diff --stat upstream/master...HEAD > /tmp/ours-before.txt   # what we carry
git merge upstream/master                                       # never rebase
```

Resolving conflicts:

- **Upstream fixed the same thing we carry:** take upstream's version, so the
  fix does not appear twice. The commit message of our fix says what it fixed;
  check upstream's change does the same thing before discarding ours.
- **Upstream changed code our fix touches, for another reason:** keep both —
  re-apply our fix on top of upstream's new code, and say so in the PR.
- **Unsure:** keep ours, and flag the file in the PR under *needs a human*.

Then find the fixes that upstream has absorbed, which no conflict will tell you
about:

```sh
git diff --stat upstream/master...HEAD > /tmp/ours-after.txt
diff /tmp/ours-before.txt /tmp/ours-after.txt
```

A file that drops out of the list means we no longer differ from upstream
there. Name it in the PR, and update FORKS.md's *In the forks* list in the app
PR.

**roBrowserLegacy stores files with CRLF** (`* text=auto eol=crlf`). Before
committing, check `git diff --stat HEAD` for whole-file rewrites; a tool that
rewrote line endings shows every line of a file as changed.

## 3. Validate

Push the branch (`git push origin upstream-sync-<date>`), then in a checkout of
this repository on a new branch `pin-<fork>-upstream-sync-<date>`:

```sh
scripts/vendor-bump.sh roBrowserLegacy <merge commit>   # or rathena
```

For **rAthena**, also move the upstream pin to the commit you merged, so the
`server-language` diagnostics compare against it:

```sh
scripts/vendor-bump.sh rathena-upstream $(git -C <fork> rev-parse upstream/master)
```

Then run what CI runs (`.github/workflows/test.yml`) for the fork that moved.

**roBrowserLegacy**
- `scripts/patch-client.sh` twice on a fresh `scripts/vendor-fetch.sh`
  checkout: both runs must succeed and leave the same tree. The dozens of
  "LF will be replaced by CRLF" warnings are normal; a non-zero exit is not.
- If upstream changed `package.json`, regenerate `patches/package-lock.json`
  (`npm install --package-lock-only`, as `patch-client.sh` explains). If not,
  leave it alone.
- `npm ci && npm run build:all` in the patched checkout.
- `node --test tests/client-extensions.test.cjs`, `python3 scripts/mod-index.py --check`,
  and `node --test tests/*.test.cjs`.
- In the fork itself, `npm test` (vitest). It needs `patches/package-lock.json`
  copied in first.

**rAthena**
- `scripts/apply-server-mods.sh` twice on a fresh checkout. The population
  engine's patches are the likeliest thing to break on a big merge;
  `third-party/population-engine/README.md` covers regenerating them.
- Every `tests/diagnostics/verify-*.py` against `rathena-upstream` with
  `--expect-fault`, and against our fork without it. A diagnostic that **stops
  finding its bug upstream** means upstream fixed it: our commit can be resolved
  away in upstream's favour, and the diagnostic retired. Say which.
- Build the image. With no local Docker, push the app branch and run
  `gh workflow run images.yml --ref pin-rathena-upstream-sync-<date>`. A manual
  run publishes nothing, only review artifacts. It builds every packet version
  in `config/PACKETVERS`, which is the real test that a merge still compiles.

A patch anchor that no longer matches is fixed in this repository's
`scripts/patch-client.sh` or `patches/`, on the app branch. A fix to upstream's
own code is a commit on the sync branch.

## 4. Open the pull requests

1. **On the fork**, from `upstream-sync-<date>` into `ragnarokoffline`, titled
   `Merge upstream <short sha> (<date>)`.
2. **On this repository**, as a **draft**, from the pin branch, titled
   `Pin <fork> to the <date> upstream merge`.

Both descriptions carry the same report:

- the upstream range merged (`<old base>..<new sha>`, and how many commits),
  grouped by area — UI windows, packets, rendering, scripts, database;
- every conflict and how it was resolved;
- fixes of ours that upstream absorbed, and diagnostics that stopped finding
  their bug;
- what was run in step 3, and what was not;
- **what to play**: the areas upstream touched, so the person landing it knows
  which windows, skills or NPCs to try;
- **packet versions**: whether upstream added support for a newer client —
  a new `src/Network/Packets/packets<year>_len_main.js` or new
  `PACKETVER.value >= <date>` branches in roBrowserLegacy, new
  `PACKETVER_MAIN_NUM >= <date>` in rAthena. That is the signal to consider a
  new line in `config/PACKETVERS`;
- *needs a human*: anything you were unsure of.

## 5. Landing it (a person)

1. Play the build from the app PR: `scripts/bootstrap.sh` on its branch, or its
   CI artifacts. Log in, use skills and the hotkey bar, open the windows the
   report names.
2. Land the fork PR **by fast-forward**, so the commit the app PR pins does not
   change:
   ```sh
   git push origin upstream-sync-<date>:ragnarokoffline
   ```
   Merging it through GitHub makes a new commit instead; if that happens, run
   `scripts/vendor-bump.sh <fork>` on the app PR before merging it.
3. Mark the app PR ready, let CI pass, merge it. The next release carries it.

## Running it on a schedule

A weekly Claude Code routine (`/schedule`) —
a scheduled cloud agent with this repository and both forks cloned — whose
prompt is: *"Follow docs/UPSTREAM_SYNC.md for Flux159/rathena and
Flux159/roBrowserLegacy. Stop at pull requests."* It needs GitHub access that
can push branches to both forks and open pull requests on all three
repositories, and nothing more. Everything it does is reviewable before it
matters, and a week it finds nothing costs one `git fetch`.
