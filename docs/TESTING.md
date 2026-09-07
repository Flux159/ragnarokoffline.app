# Testing the implementation branches

These branches are for review and testing; do not merge until the user has
tested the assembled app. The implementation scope is the plan in
`~/Downloads/ragnarokastraplan.md`.

## Asset process ownership (#22)

Build the exact Rust asset-server revision named in `config/REMOTECLIENT_PIN`:

```sh
bash scripts/build-remoteclient.sh
REMOTECLIENT_BIN="$PWD/bin/robrowser-remoteclient" npm test
node --check electron/main.js
```

On Windows, run the script in Git Bash and append `.exe` to `REMOTECLIENT_BIN`.
Build the supervisor with `cargo build --manifest-path stack/Cargo.toml` and set
`STACK_BIN` to its absolute `.exe` path for Windows tests. The shell uses the
bundled supervisor's `process-identity PID` command to read native process
creation time and executable path; PowerShell startup is no longer involved.
The unit fixtures use temporary directories and random ports. The two Rust
integration tests use synthetic GRFs, including a real force-killed-parent
test; they do not use your characters, assets or running game. Without
`REMOTECLIENT_BIN`, those two tests explicitly skip.

The binary pin is a full source commit, including dependency PR commits. This
allows testing stacked work before merging or releasing the Rust dependency.
The script uses the pinned Cargo lockfile and writes SHA-256/source-commit
sidecars. Packaging verifies managed protocol 1; an old sibling binary cannot
silently enter a new app bundle. The existing release signing step may change
the Mach-O file hash; runtime ownership hashes the installed executable itself.

For packaged acceptance on macOS, Linux and Windows:

1. Quit any other copy fully. Launch the test app, log in, then quit normally.
   Confirm the asset server exits and the next launch starts a fresh process.
2. Force-quit the shell; its managed Rust child should also exit. Relaunch and
   confirm it recovers any stale record and uses the current build.
3. Change era, client locations, LAN setting or mods and restart. Check the
   latest `state/assets.log` launch header for the new configuration and PID,
   then complete login, character selection and entry to the map.
4. With the app fully stopped, run an unrelated temporary HTTP server on 3338.
   Launch the app: it should explain the conflict and leave that server alive.
   Stop the test server by its own PID and retry. Do not kill by a command-line
   pattern or executable name.

The app records ownership in `state/asset-owner.json` and keeps the installation
control secret in `state/asset-control.secret`, outside the served asset root.
Never include the secret in bug reports. The public health endpoint is only a
minimal status response; an HTTP 200 is not proof of process ownership.

Automated process tests are not evidence of successful packaged gameplay.
Record platform/build and the manual acceptance results separately.

## Archives and client folders on different volumes (#5, #24)

The source-backed asset change is stacked on #22 and needs its pinned Rust
dependency. Run the full synthetic assembly/HTTP test locally:

```sh
bash scripts/build-remoteclient.sh
cargo build --locked --manifest-path stack/Cargo.toml
STACK_BIN="$PWD/stack/target/debug/ragnarok-stack" \
  REMOTECLIENT_BIN="$PWD/bin/robrowser-remoteclient" npm test
```

The integration fixture calls the real supervisor and serves the results with
the real Rust binary. It checks absolute manifests, archive priority, translated
tables, generated client config, mod music and restoring original music, source
byte preservation, and refusal to download private manifests/raw archives.
Supervisor tests exercise interruption at every commit rename, rollback after a
real rename failure, era switching, missing inputs and read-only source copies.

CI reports actual fixture drive roots. A hosted Windows CI run is not proof of
standard-user operation or packaged gameplay. For that acceptance, log into a
standard Windows account with Developer Mode off and run from the checkout:

```powershell
.\scripts\test-windows-install.ps1 -CrossVolume `
  -ClientTestRoot 'D:\asset-tests' -StateTestRoot 'C:\asset-tests' `
  -AppTestRoot 'C:\asset-tests' `
  -StackBinary '.\stack\target\debug\ragnarok-stack.exe' `
  -RemoteClientBinary '.\bin\robrowser-remoteclient.exe'
```

Use existing writable test folders. This mode checks the actual volume IDs,
uses only newly created synthetic fixtures, and does not boot a VM or touch an
existing save. Repeat with AppTestRoot on D:, StateTestRoot on C: and
ClientTestRoot on E:. Its archive selections span all three test roots.
The older install-loop mode deletes a VM data disk and requires the separate
`-ConfirmDestructive` flag; it is not part of this asset test.

Then test the assembled app on those layouts with real assets: login → character
→ map, sprites, music and a translated item; enable/disable BGM and System mods;
switch both eras; unplug/reconnect an external drive; upgrade a legacy selection.
Record app/OS versions, actual volumes, account privileges, Developer Mode state,
source hashes, state disk growth and screenshots. These manual gates remain
outstanding until recorded; do not close #5/#24 based only on synthetic tests.

Generated `Config.local.js` and the landing page now live in `state/assets/`.
The private manifest and selected directory paths live in `state/asset-config/`.
The installed web payload is untouched by asset assembly. A rebuild must run
while RemoteClient is stopped; `.asset-update` records recoverable commits.
Rebuilds hold a separate OS-managed file lock; a competing CLI rebuild is refused
and a crashed process releases the lock without an age-based stale-lock guess.
This uses [standard-library file locking](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock)
and sets the supervisor's minimum Rust version to 1.89 without adding crates.
# Client controls in a real game

The client API and WASD branch includes `npm run test:e2e`. It joins a running
**disposable** world through the owned Rust asset server and checks actual
rAthena movement acknowledgements. It does not start or reuse a player's VM.
See [Playwright's browser setup](https://playwright.dev/docs/browsers) for browser
installation. Playwright is a development dependency and is not packaged.

Quit the packaged app and let it finish quitting before preparing or starting
the test world. Fixed game ports still prohibit running two worlds at once.
Build the pinned client and current supervisor/RemoteClient first:

```sh
bash scripts/vendor-fetch.sh roBrowserLegacy vendor/roBrowserLegacy
bash scripts/patch-client.sh
npm ci --prefix vendor/roBrowserLegacy
npm --prefix vendor/roBrowserLegacy run build -- --O --T --H
cargo build --manifest-path stack/Cargo.toml
bash scripts/build-remoteclient.sh
npm ci
npx playwright install chromium
```

Use a new directory for `RO_E2E_WORLD`. `RO_E2E_RUNTIME` must name an unpacked
working app runtime with current `bin/nebula`, its signed helpers, guest images
and packaged container images; the source tree's old nebula binary is unsuitable.
`RO_E2E_CLIENT_JSON` supplies only the selected GRF/BGM paths. Preparation copies
runtime/build inputs, creates its own save and reads the selected archives in
place. It refuses an existing world directory, and never deletes a data disk.

macOS example (use equivalent runtime/client-selection paths on Windows/Linux):

```sh
export RO_E2E_WORLD="$PWD/artifacts/issue-6/my-world"
export RO_E2E_RUNTIME="$HOME/Library/Application Support/Ragnarok Offline/runtime"
export RO_E2E_CLIENT_JSON="$HOME/Library/Application Support/Ragnarok Offline/client.json"
node tests/e2e/world.cjs prepare
node tests/e2e/world.cjs up
node tests/e2e/world.cjs serve
```

Keep `serve` in that terminal. Open `http://127.0.0.1:3338/`, log into the new
world using its shipped local GM account, and create a character in slot 1.
This first creation exercises the real character UI; no position assignments or
database character fabrication are used. In a second terminal with the same
`RO_E2E_WORLD`:

```sh
node tests/e2e/world.cjs backup
npm run test:e2e
```

Optional `RO_E2E_ACCOUNT` and `RO_E2E_PASSWORD` select another disposable test
GM account. Keep a playable character in slot 1 and slot 3 empty. The layout
suite opens creation in the empty slot and cancels; the two-thumb suite uses a
real `@warp prontera 150 180` command to start on a repeatable walkable path.
The harness authenticates the private asset ownership control endpoint,
checks the executable hash and OS process identity, then uses the actual login
UI. It never records authentication fill actions or raw WebSocket frames.
Tracing starts after login/map entry. Reports include browser/packet versions,
configuration/executable fingerprints, server movement acknowledgement counts,
page/console errors, failed HTTP paths and WebSocket lifecycle.

Screenshots and traces are under `artifacts/issue-6/local/playwright/` (override
the build label with `RO_E2E_BUILD`). `map-before.png` and `map-after.png` bracket
the movement test; they are **not** a comparison with the previous app version.
Inspect screenshots alongside the JSON report. Expected asset fallbacks and
upstream console diagnostics must be reviewed rather than called a clean console.

Stop `serve` with Ctrl-C, then run `node tests/e2e/world.cjs down`. Save backups
remain in the world folder. For a new build, use a new world path or explicitly
stop the existing host before replacing its runtime inputs.

Current automated coverage: desktop login/relogin, W/A/S/D and arrows, actual
server movement, release, chat typing, per-browser disable/persistence and
stable source counts after reload. Unit tests additionally cover diagonals,
opposing directions, camera rotation, input ownership, cancellation, shortcut
priority and plugin cleanup/timeouts.

`mobile.spec.cjs` uses Chromium CDP multi-touch input with distinct pointer IDs,
checks both release orders and cancellation, and verifies exactly one delivery
to the native attack handler. It also requires server movement acknowledgements
and unchanged camera direction; dispatching an attack with no nearby monster
does not establish combat correctness.

`mobile-layout.spec.cjs` captures desktop, two phone portrait sizes, their
landscape sizes and tablet. It exercises tap login/selection, creation-screen
access, map and inventory; it checks viewport bounds and primary target sizes.
Review the screenshots as well as assertions. Run a subset with
`npx playwright test mobile.spec.cjs` or `mobile-layout.spec.cjs` while the owned
test world is running.

`mobile-preferences.spec.cjs` checks 125% controls without overlap, input
suspension in Display, saved size, Off/On reloads, separate geometry banks and
the legacy first-touch detector respecting Off. It seeds only a browser window
preference; gameplay still uses the real server.

`mobile-commerce.spec.cjs` uses portrait and landscape phone profiles with an
ordinary NPC tool dealer and real GM fixture commands in the disposable world.
It rejects an excessive deposit quantity, verifies item conservation across
quantity and whole-stack deposit/withdraw operations, checks server-confirmed
inventory and Zeny changes for buying/selling, and checks the shop's separate
phone preference bank. It also exercises rapid native-panel taps near NPCs,
which must not click through into the map. The fixture adds Red Potions/Zeny
to the test character, restores those amounts after a successful run, and uses
the pinned renewal dealer at `prt_in (126,76)`;
run it with a GM account and the renewal test world. Screenshots and traces are
recorded after login. Run with the same `RO_E2E_WORLD` and `RO_E2E_BUILD` settings
as the other suites, using `node node_modules/@playwright/test/cli.js test
mobile-commerce.spec.cjs`.

`mobile-actions.spec.cjs` checks native item/shortcut healing and inventory
counts, distant one-tap pickup, cancellation of a queued pickup by a new touch
joystick direction, and Poring combat. Damage and experience messages come from
received server packets; a button click or unknown monster HP does not prove a
kill. The fixture clears old floor loot in its disposable town, adds five Red
Potions, damages/heals the test character, drops the healing stack and spawns a
Poring. Successful runs restore potion count and HP; experience and F2's potion
assignment persist. It records browser/viewport, page and console errors, HTTP
failures, WebSocket lifecycle (not frames), screenshots and a post-login trace.
`phone.cjs` shares native phone login/menu/chat/warp helpers with commerce tests.

Learned skill use/targeting, further combat cases, player vending and remaining NPC/quest flows, plus
orientation/keyboard transitions, death/IME/background gameplay cases, Firefox,
packaged Electron and physical Android/iPhone testing remain release gates for
issue #6. Chromium device emulation is not a physical Safari/Android pass.

## Owner account integration (opt-in, disposable world only)

`tests/e2e/accounts-settings.cjs` launches real Electron Settings and a Chromium
phone client against an already running disposable test world. Install the app's
Node dependencies and build/copy the current supervisor into that world's runtime;
its `docker-slim capabilities` must include `exec-stdin-eof-v1` (nebula PR #33).
The world must contain the marker from `world.cjs prepare`, a playable renewal GM
character in slot 1, and no `client.json`. The missing client selection makes the
test shell's boot page wait instead of starting another supervisor. The fixture
uses its own Electron user-data directory and verifies asset ownership first.

```sh
RO_E2E_WORLD=/absolute/path/to/disposable-world node tests/e2e/accounts-settings.cjs
```

It rejects an overlength paste without truncating it, checks that password fields
clear, creates an ordinary friend, disables/enables that account, and changes the
GM password through real IPC. It then verifies native rejection of the old
password and reaches a playable map with the new one. The supervisor waits for a
map-ready log newer than the restarted char-server's `StartedAt`; retained logs
from a previous process cannot report readiness. Node tests separately check
private stdin transport and redaction, while Rust tests cover credential limits,
SQL encoding, reserved names and the operation lock.

This test intentionally changes only the disposable world's GM password and adds
a unique friend account. Generated test credentials stay in mode-600
`account-test-credentials.json` and `friend-test-credentials.json` outside the
served root. A pending GM credential file is retained if the write outcome is
uncertain. Later gameplay tests must load the current test password into
`RO_E2E_PASSWORD` without printing it. Screenshots and JSON reports go under
`<world>/account-tests/<timestamp>/`; no password-filled trace is recorded. The
test exits its shell directly so the externally owned world remains running.

`tests/e2e/era-settings.cjs` takes ownership of a **stopped** disposable world,
opens real Settings, switches renewal → pre-renewal → renewal, checks the
served `Config.local.js` and account panel, and logs into a playable map in
each era. It retains one browser context across switches and asserts the loaded
era flag as well as the served config. It requires private `account-test-credentials.json` and
`prerenewal-account-test-credentials.json` files with `{account,password}` for
already changed GM passwords. Renewal needs a character in slot 1; pre-renewal
creates `AstraEra` there if empty. No other host may be running.

```sh
RO_E2E_WORLD=/absolute/path/to/disposable-world \
RO_E2E_CLIENT_JSON=/absolute/path/to/client-selection.json \
node tests/e2e/era-settings.cjs
```

The selection file is read only. The harness temporarily writes a local-only
selection inside the test world and removes it after stopping the owned server.
On teardown failure it retains that selection for recovery. Reports and
screenshots live under `<world>/account-tests/settings-eras-<timestamp>/`;
passwords never enter traces. Use the current image containing both
`char-server-prere` and `map-server-prere`, not an older local archive.

Startup/Repair recovery acceptance also requires a backed-up disposable DB:
rename the GM, delete its login row, and disable it in separate cases; run both
startup and Repair; prove no default login appears and character IDs/rows remain
unchanged; then restore the fixture's original row. Resetting a disabled account's
password must leave it disabled. Keep snapshots and passwords private, stop game
services before direct fixture changes, and never run these cases on player data.
Check independent first-era initialization and preservation in both directions.
Full packaged payloads and internet-mode safeguards remain release gates; these
account tests alone do not close issue #4.

## HTTPS join transport (opt-in)

`node tests/e2e/join-settings.cjs` launches the source shell against disposable
loopback HTTP and HTTPS fixtures, without a VM. It checks invite-required
responses, fragment handoff/clearing, saved host origins, log redaction, game
IPC denial, and blocked navigation to other origins. Applying Settings while
joining must not start a local server. The test has its own temporary home and
Chromium profile; it never uses a player's save.

With a verified disposable renewal world already running and serving assets:

```sh
RO_E2E_WORLD=/absolute/path/to/disposable-world node tests/e2e/https-game.cjs
```

The game test sends the built client through a loopback TLS terminator to the
actual Rust asset/WS proxy and rAthena. It requires the private test GM credential
file described above and a playable slot 1. It verifies all three native login,
character and map WS connections, host-side loopback targets, server-acknowledged
movement, root-link fragment preservation, and no insecure HTTP requests from the
HTTPS page. Screenshots/reports are written below the world; no credential or
packet-frame traces are recorded. The temporary TLS listener closes on completion;
the externally owned game world remains running.

Both TLS integration fixtures use the public test certificate in
`tests/fixtures/tls/`. Node trusts that exact fixture only in the test child;
Chromium receives an exact SPKI exception for it. Neither alters a system trust
store. These establish local transport behavior, **not** trusted public-certificate,
Cloudflare/ngrok, or external-network acceptance. Unit tests separately prove
rejection of an untrusted certificate and HTTPS-to-HTTP downgrade. Fixture keys
are never part of the application payload.

To also test a real host stopping when it becomes a joiner, run the stopped-world
era harness above with `RO_E2E_JOIN_AT_END=1`. It verifies that all local game and
engine ports close, and that applying Settings in Join mode keeps them closed.


### Owner account creation policy

`tests/e2e/registration-settings.cjs` owns a stopped disposable world, using the
same `RO_E2E_WORLD` / `RO_E2E_CLIENT_JSON` inputs as the era Settings fixture. It
checks actual game signup when enabled, rejected `_M` and `_F` signup with owner
policy, group-0 account creation through Settings, existing GM characters in both
eras, and policy persistence through Repair and renewal → pre-renewal → renewal.
It saves Settings/game screenshots and a credential-free JSON report under the
world's `account-tests/registration-*` directory. Test accounts stay in that
disposable database; the fixture restores the original local settings and stops
its server before exiting. Do not run it against a player save.

### Internal service credentials

`tests/e2e/service-credentials-settings.cjs` uses those same stopped-world inputs
and existing per-era GM fixture credentials. Use the bundled image advertising
`private-db-files=v1`. The test secures renewal and pre-renewal, switches back,
and verifies existing native character login, unchanged player identities and
passwords, independent durable service credentials, and rejected legacy SQL root
authentication. It also exercises managed backup/restore with a legacy interserver
row, recovery from interrupted password changes, and ordinary account creation,
password changes, disabling and enabling through the owner IPC.

Recovery deliberately changes the disposable SQL root password back to its known
legacy value after stopping game writers and removing the pending journal's ready
marker. Never use this fixture on a player save or publicly reachable host. The
test restores ordinary Settings and stops its server, but retains managed service
journals, private backups and test accounts for subsequent acceptance work. Keep
that private state with the disposable VM disk. Reports and Settings/game
screenshots are under `account-tests/service-credentials-<timestamp>/`; they do
not contain passwords. Native packaged migration on Windows/Linux and full
internet-hosting safeguards remain separate acceptance requirements.

### Startup recovery

Electron acceptance scripts pass `--quiet` to the regular app, which mutes all
of its windows for that run. For a quiet manual launch, use `npm start -- --quiet`.
Omit the flag when checking sound. The flag does not persist an audio preference
or change the Mac's system volume.

`node tests/e2e/startup-recovery.cjs` launches an isolated Electron profile and
an ephemeral loopback HTTP fixture, without starting a VM. It closes/reopens
setup, drops the game-page response after a successful host probe, verifies
that recovery waits for Retry, then crashes only its own renderer and verifies
another successful Retry. The remote fixture is denied owner IPC throughout.
Screenshots are written to the reported temporary evidence directory.

### Phone skill actions

`tests/e2e/mobile-skills.cjs` owns a stopped disposable world with the same
`RO_E2E_WORLD` / `RO_E2E_CLIENT_JSON` inputs and Renewal GM fixture credentials.
It completes actual setup, logs in through the phone UI, damages/heals its test
character, and verifies that the selected First Aid skill changes server-owned
HP/SP. It opens and closes native skill information in a phone viewport, checks
the close control after rotating to landscape, assigns F3 and casts again from
the HUD. This exercises native packets, not a mocked cast handler. It backs up
the disposable database; the F3 assignment remains in that test character.
Reports and screenshots stay under `account-tests/mobile-skills-<timestamp>/`.
It restores local settings and stops its owned world. Desktop/mobile browser
emulation does not replace physical iOS/Android acceptance.
