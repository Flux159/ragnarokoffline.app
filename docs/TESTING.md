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
