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
