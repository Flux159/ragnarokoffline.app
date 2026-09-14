# Contributing to Ragnarok Offline

> **Working with an AI coding agent?** Copy and paste this link to get Claude
> (or any agent) to read this file before it starts:
>
> ```
> https://raw.githubusercontent.com/Flux159/ragnarokoffline.app/main/CONTRIBUTING.md
> ```
>
> For example: *"Read
> https://raw.githubusercontent.com/Flux159/ragnarokoffline.app/main/CONTRIBUTING.md,
> then fix issue #123 in Flux159/ragnarokoffline.app and open a pull request."*

Thanks for helping. Most contributions here are made with an AI agent doing the
typing, and this guide is written so an agent can follow it end to end. Every
step is also written out by hand under [Developer setup](#developer-setup), if
you would rather do it yourself.

## The short version

1. Pick an [open issue](https://github.com/Flux159/ragnarokoffline.app/issues),
   or open one describing what you want to change.
2. Fork the repository, clone your fork, and make a branch.
3. Read [CLAUDE.md](CLAUDE.md) (also available as `AGENTS.md`), then the
   **Architecture** section of the [README](README.md).
4. Make the change, and build and test it the way [Testing](#testing) describes
   for that kind of change.
5. Open a pull request that says what you changed, how you checked it, and what
   you did not check.

## For AI agents

Follow these in addition to everything below:

- **Read [CLAUDE.md](CLAUDE.md) first.** It lists the traps this codebase has
  actually sprung: two RemoteClients (only the Rust one runs), roBrowser's own
  file cache, fixed ports, and more.
- **Ask the human for their Ragnarok client folder.** The game data is not in
  this repository and must never be committed. Do not guess a path.
- **Kill processes by PID** (`pgrep -x <name>`, then `kill <pid>`). Never
  `pkill -f`: in this repository it has matched the agent's own shell and ended
  the session.
- **Run one copy of the app at a time**, and quit the installed app, letting it
  finish quitting, before starting one from source.
- **Do not bump versions, create tags, or publish releases.** A `v*` tag starts a
  public release on its own. The maintainer releases.
- **Do not add dependencies to `stack/` or `examples/mods/randomizer/`.** They
  have none, on purpose; CLAUDE.md explains why.
- **Fixes to rAthena or roBrowserLegacy go to our forks, not into patch
  scripts.** See [Changing rAthena or roBrowserLegacy](#changing-rathena-or-robrowserlegacy).
- **Report what you actually verified.** A pull request that says "built on
  macOS, not run on Windows" is far more useful than one that implies
  everything was tested.

## Picking up an issue

Many issues are detailed reports: some came from the app's **Report a problem**
button, and some were written with an AI's help and already name a file and a
suggested fix. Treat a suggested fix as a lead, not a verdict. Confirm the cause
in the code before changing anything, and say in the pull request whether the
suggestion held up.

Leave a comment on the issue so nobody duplicates the work, and put
`Fixes #<number>` in the pull request description so the issue closes when it
merges.

## Where things live

| Path | What it is | When you change it |
|---|---|---|
| `electron/` | the desktop shell: windows, settings, IPC (`main.js` is privileged) | UI outside the game window, settings, launch flow |
| `stack/` | `ragnarok-stack`, the Rust supervisor that runs the VM, containers and asset server | starting, stopping, repair, mods, hosting |
| `config/` | the roBrowser config template, pins (`VENDOR_PINS`, `NEBULA_MIN_VERSION`, …), nebula config | versions of what the app builds against |
| `patches/`, `scripts/patch-client.sh`, `scripts/patch-client-controls.py` | the app's own additions to the game window | stylist, extension hooks, controls |
| [Flux159/roBrowserLegacy](https://github.com/Flux159/roBrowserLegacy) (`ragnarokoffline` branch) | fixes to the game window itself | a bug in roBrowserLegacy |
| [Flux159/rathena](https://github.com/Flux159/rathena) (`ragnarokoffline` branch) | fixes to the game server itself | a bug in rAthena |
| `third-party/population-engine/` | the AI population and companions, compiled into the server | fake players and companions |
| `containers/` | the rAthena and MariaDB images | how the server is built and run |
| `mods/`, `examples/mods/`, `registry/` | bundled mods, worked examples, the mod index | mods |
| `docs/` | contributor and player documentation | behaviour you changed |
| `docs-site/` | the published documentation site (Vite + MDX, built with bun) | the website |
| `tests/` | shell tests, client extension tests, rAthena diagnostics, Playwright end-to-end | alongside the code they test |

## Developer setup

### What you need

| | macOS (Apple silicon) | Windows (x64) | Linux (x64) |
|---|---|---|---|
| git | yes | yes, with **Git Bash** — every script is bash | yes |
| Node.js | 22, the version CI uses | 22 | 22 |
| Rust | stable, 1.89 or newer | stable, 1.89 or newer | stable, 1.89 or newer |
| Python | 3 | 3 | 3 |
| curl, tar | built in | built in to Git Bash | yes |
| Other | Xcode Command Line Tools | — | — |

You also need a Ragnarok Online client folder to play what you build: one
containing `data.grf` (and optionally `rdata.grf`) and a `BGM` folder. The
[README](README.md) explains what works.

Run every command below from the repository root, in bash (Git Bash on Windows).

### Get the code

```sh
# Fork https://github.com/Flux159/ragnarokoffline.app on GitHub first, then:
git clone https://github.com/<you>/ragnarokoffline.app.git
cd ragnarokoffline.app
git remote add upstream https://github.com/Flux159/ragnarokoffline.app.git
git switch -c <short-description-of-change>
```

Keep your branch current with `git fetch upstream && git rebase upstream/main`
before opening the pull request.

## Building and running locally

A working build has five parts: the game window (roBrowserLegacy, built from
source), the server images (rAthena and MariaDB), the nebula engine kit that runs
them in a microVM, the supervisor (`stack/`), and the asset server (a pinned Rust
binary). The steps below are the ones the release workflow,
[`.github/workflows/build.yml`](.github/workflows/build.yml), runs on every
platform for every release, so they are the proven path.

The Windows and Linux steps have been exercised in CI far more than by hand. If
something differs on your machine, a pull request fixing this file is welcome.

### 1. Build the game window (every platform)

```sh
mkdir -p vendor
scripts/vendor-fetch.sh roBrowserLegacy vendor/roBrowserLegacy
scripts/vendor-fetch.sh ROenglishRE vendor/ROenglishRE
scripts/patch-client.sh
(cd vendor/roBrowserLegacy && npm ci --no-audit --no-fund && npm run build:all)
scripts/patch-bundle.sh vendor/roBrowserLegacy/dist/Web
```

`vendor/` is not a working copy. The build patches it in place, and it can be
reset, so never make changes there you want to keep.

### 2. Get the engine kit and build the helpers (every platform)

Download the nebula embed kit for your platform:

| Platform | Kit |
|---|---|
| macOS | `nebula-slim-embed-aarch64-apple-darwin.tar.gz` |
| Windows | `nebula-slim-embed-x64-pc-windows.tar.gz` |
| Linux | `nebula-slim-embed-x64-unknown-linux.tar.gz` |

```sh
KIT=nebula-slim-embed-aarch64-apple-darwin.tar.gz   # pick yours from the table
NEBULA=v$(cat config/NEBULA_MIN_VERSION)
mkdir -p .kit
curl -fL -o .kit/kit.tar.gz "https://github.com/Flux159/nebula/releases/download/$NEBULA/$KIT"
tar xzf .kit/kit.tar.gz -C .kit
export NEBULA_EMBED_KIT="$PWD/.kit"

bash scripts/build-docker-slim.sh       # -> bin/docker-slim (.exe on Windows)
bash scripts/build-remoteclient.sh      # -> bin/robrowser-remoteclient (.exe on Windows)
export DOCKER_SLIM_BIN="$PWD/bin/docker-slim"                  # add .exe on Windows
export REMOTECLIENT_BIN="$PWD/bin/robrowser-remoteclient"      # add .exe on Windows
```

Both helpers are built from source at the commits in `config/`, so the first run
takes a few minutes.

### 3. Get the server images

Unless you are changing the server, use the images the project already built.
`images.yml` publishes them from `main` to a release named `images`:

```sh
ARCH=arm64   # arm64 on macOS; x64 on Windows and Linux
mkdir -p dist .ragnarokmac/sql
curl -fL -o dist/images.tar.gz \
  "https://github.com/Flux159/ragnarokoffline.app/releases/download/images/images-$ARCH.tar.gz"
curl -fL -o .ragnarokmac/rathena-sql.tar.gz \
  "https://github.com/Flux159/ragnarokoffline.app/releases/download/images/rathena-sql.tar.gz"
tar xzf .ragnarokmac/rathena-sql.tar.gz -C .ragnarokmac/sql
```

Changing the server (`containers/`, `third-party/`, `scripts/apply-server-mods.sh`,
or the rAthena pin) means building the images yourself; see
[Building the server images](#building-the-server-images).

### 4. Package the app

```sh
scripts/package.sh                 # tests and builds stack/, assembles payload/
npm install --no-audit --no-fund
```

Then build for your platform:

| Platform | Command | Result, under `dist/electron/` |
|---|---|---|
| macOS | `npx electron-builder --mac --arm64 --publish never` | `mac-arm64/Ragnarok Offline.app` and a `.dmg` |
| Windows | `npx electron-builder --win --x64 --publish never` | `Ragnarok Offline-<version>-x64.exe` |
| Linux | `npx electron-builder --linux --x64 --publish never` | `Ragnarok Offline-<version>-x64.AppImage` |

On macOS, the app's microVM helpers need a Developer ID signature with the
virtualization entitlement; `electron/afterPack.js` signs them when a "Developer
ID Application" identity is in your keychain and leaves them as the kit shipped
them otherwise. `scripts/release.sh` is the maintainer's one-step macOS build.
It insists on that signature, so without a Developer ID use the commands above.

Quit any installed copy of the app, wait for it to finish quitting, and open the
one you built.

### Running from source

For changes to `electron/`, running from source is quicker than packaging:

```sh
scripts/package.sh    # once, and again whenever stack/ or the client changes
npm install
npm start
```

`npm start` uses the same data folder as the installed app
(`~/Library/Application Support/Ragnarok Offline`, `%APPDATA%\Ragnarok Offline`,
or `~/.local/share/Ragnarok Offline`) and the same single-instance lock. If the
installed app is running, `npm start` just brings that window forward and exits;
if it is still quitting, the installed app comes back instead of yours. Quit it
completely first. The game ports (3338, 6900, 6121, 5121) are fixed, so only one
copy can run at a time.

### Building the server images

**macOS.** `scripts/bootstrap.sh [client-folder]` builds everything, server
images included, against a local nebula engine. It needs a nebula checkout built
at `~/Projects/nebula` (or `NEBULA_BIN` pointing at its `nebula` binary) with the
engine running (`nebula up`). Then save the images for packaging with
`scripts/precache.sh save`.

**Linux, with Docker.** Build them the way `images.yml` does:

```sh
PACKETVER=$(grep -m1 '^PACKETVER=' scripts/bootstrap.sh | cut -d= -f2)
docker build -t ragnarokmac/mariadb:11.4 containers/mariadb
scripts/vendor-fetch.sh rathena vendor/rathena
scripts/apply-server-mods.sh vendor/rathena
cp containers/rathena/Dockerfile vendor/rathena/Dockerfile.ragnarokmac
docker build -f vendor/rathena/Dockerfile.ragnarokmac --build-arg PACKETVER=$PACKETVER \
  -t ragnarokmac/rathena:$PACKETVER vendor/rathena
mkdir -p dist .ragnarokmac/sql
docker save ragnarokmac/rathena:$PACKETVER ragnarokmac/mariadb:11.4 | gzip > dist/images.tar.gz
cid=$(docker create ragnarokmac/rathena:$PACKETVER true)
docker cp "$cid:/rathena/sql-files/main.sql" .ragnarokmac/sql/01-main.sql
docker cp "$cid:/rathena/sql-files/logs.sql" .ragnarokmac/sql/02-logs.sql
docker rm "$cid"
```

**Windows.** There is no local path for building the server images yet. Build
the rest against the published images, and say in the pull request that the
server change needs building on macOS or Linux.

## Testing

Run what matches your change. CI runs the ones marked **CI** on every pull
request ([`test.yml`](.github/workflows/test.yml)); the rest only you can run.

| You changed | Run | CI |
|---|---|---|
| `stack/` | `cargo test --locked --manifest-path stack/Cargo.toml` | **CI**, all three OSes |
| `electron/` | `node --check electron/main.js`, then `REMOTECLIENT_BIN=<path> STACK_BIN=<path> node --test tests/*.test.cjs` (build both with steps 2 and 4) | **CI**, all three OSes |
| client patches or `patches/client/` | `scripts/patch-client.sh` twice (the second run must change nothing), a client build, then `node --test tests/client-extensions.test.cjs` | **CI** |
| server mods or the rAthena pin | the `tests/diagnostics/verify-*.py` checks, as `test.yml` runs them | **CI** |
| `registry/` or bundled mods | `python3 scripts/mod-index.py --check` | **CI** |
| anything a player sees | build the app (above) and use the feature in a real game | no |
| client controls or Settings flows | `npm run test:e2e` against a disposable world; see [docs/TESTING.md](docs/TESTING.md) | no |
| Windows install paths | `scripts/test-windows-install.ps1`; see [docs/TESTING.md](docs/TESTING.md) | no |
| `docs-site/` | `cd docs-site && bun install && bun run build` | no (deployed from `main`) |

Nothing in CI starts the app or a virtual machine, and the installers are only
built when a release is tagged. For anything a player can see, a build you have
actually played is the real test. Say in the pull request which platforms you
ran it on.

## Changing rAthena or roBrowserLegacy

The app builds both from our forks, and [docs/FORKS.md](docs/FORKS.md) is the
full guide. The rules that matter most:

- **A bug in rAthena or roBrowserLegacy is fixed on the fork**, as a commit on
  its `ragnarokoffline` branch, through a pull request against that branch.
  Anything specific to this app (the population engine, the stylist, extension
  hooks) is added by the scripts here instead.
- **Then move the pin here** with `scripts/vendor-bump.sh <rathena|roBrowserLegacy>`,
  build, test, and open a pull request with that change in this repository.
- **Work in a clone of the fork**, not in `vendor/`.
- **`ragnarokoffline` never rewinds.** No force-pushes (the branch refuses them),
  and upstream is merged in, never rebased.
- **roBrowserLegacy checks files out with CRLF line endings.** If `git diff
  --stat` shows a whole file changed, something rewrote its line endings; fix
  that before committing.
- Fixes on the forks are meant to go back upstream. If you would like to send
  one to rAthena or roBrowserLegacy, FORKS.md shows how.

## Opening a pull request

- **One change per pull request.** A bug fix and an unrelated tidy-up are two
  pull requests.
- **Title:** a plain sentence saying what changes, in the style of the history —
  "Drag and drop into the cart", "Wait for the engine to leave before saying it
  has stopped". No `feat:`-style prefixes.
- **Description:** what was wrong or missing, what you changed, and a
  **Verification** section with what you ran and on which platforms. End with
  anything you did not test. Link the issue with `Fixes #<number>`.
- **Screenshots or a short recording** for anything visible.
- **Do not change the version** in `package.json`, and do not add release notes;
  the maintainer does both when releasing.
- **CI must pass.** If a check fails for a reason unrelated to your change, say
  so in the pull request rather than working around it.

Pull requests are squash-merged, so the title becomes the commit on `main`; your
branch's individual commits do not need to be tidy.

## Things that will catch you out

- **The asset server never serves wrong content.** If the game window draws
  nothing, `state/assets/logs/missing-files.log` in the data folder names the
  missing file.
- **roBrowser caches downloaded files** in Chromium's `File System/` folder in
  the data folder, so a replaced file can appear unchanged after a rebuild.
- **The packet version (20221005) is set in two places** — `scripts/bootstrap.sh`
  for the server and `config/Config.local.js` for the client — and they must
  match.
- **Database edits under a running server are lost.** Use
  `ragnarok-stack sql --write`, which stops the game first;
  [docs/DATABASE.md](docs/DATABASE.md) explains.
- **`vendor/roBrowserLegacy-RemoteClient-JS` is not the asset server.** It is the
  old Node reference. The app uses the Rust one in `bin/`.
