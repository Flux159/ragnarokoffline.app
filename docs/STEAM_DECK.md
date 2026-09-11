# The Steam Deck

**The app runs on a Steam Deck.** Confirmed on SteamOS 3.8.16: the microVM
boots, the server comes up, and the client draws the login screen. It needs one
Chromium flag and, for now, to be run extracted rather than as an AppImage —
both below.

On an *older* SteamOS it cannot start at all, and the reason is not the one
people assume: the Electron shell is fine, and everything behind it is linked
against a newer glibc than SteamOS has, so the window opens and nothing behind
it runs.

Measured on the same physical Deck, before and after a system update:

| | SteamOS 3.2 (2022-05) | SteamOS 3.8.16 (2026-07) |
|---|---|---|
| glibc | 2.33 | 2.41 |
| kernel | 5.13 neptune | 6.16.12-valve24.5 |
| v1.2.0 payload binaries | none start | all start |
| `libkrun.so.1` | unresolved symbols | resolves |
| `nebula up` | impossible | **`vm Running, agent healthy` in 2.7 s** |

So [#87](../../../issues/87)'s question — can nebula spin up VMs on a Steam
Deck — is answered: yes, on a current SteamOS, with the build that already
ships. What follows is about the Decks that are not current.

## What was measured on the old build

A Steam Deck on **SteamOS 3.2**, build `20220526.1`, kernel
`5.13.0-valve15-1-neptune`, glibc **2.33**. The v1.2.0 AppImage, downloaded and
run in Desktop Mode:

```
$ ./RO.AppImage --no-sandbox
[...] No such interface "org.freedesktop.portal.FileChooser"
[...] GetVSyncParametersIfAvailable() failed
```

It **starts**. The window opens, `~/.local/share/Ragnarok Offline/state` is
created, and there is no glibc complaint, because Chromium deliberately targets
an old one. Then, from the payload inside that same AppImage:

```
$ payload/bin/nebula --version
/usr/lib/libc.so.6: version `GLIBC_2.34' not found
/usr/lib/libc.so.6: version `GLIBC_2.39' not found
```

Every native binary in the Linux payload, against a system providing 2.33:

| binary | needs |
|---|---|
| `nebula`, `nebulad` | glibc 2.39 |
| `ragnarok-stack` | glibc 2.39 |
| `ro-randomizer` | glibc 2.39 |
| `docker-slim` | glibc 2.34 |
| `robrowser-remoteclient` | glibc 2.34 |

Not one of them can start. The microVM never boots, so the server never runs,
so the app is a window with nothing behind it.

## Why an old SteamOS is not supported

The binaries are built on `runs-on: ubuntu-latest`, which is Ubuntu 24.04 and
ships glibc 2.39. Nothing pins that floor, so it follows the runner.

We deliberately do not build lower. Keeping a Deck on SteamOS 3.2 working would
mean a second Linux build in an old-glibc container, plus the same for nebula's
embed kit, plus a floor check in both repositories to stop the floor drifting
up again — a permanent second build target for a four-year-old system image
that Valve updates automatically.

**If someone reports the app not starting on a Deck, ask for their SteamOS
version first.** `ldd --version` at a terminal, or Settings → System. Anything
from 3.5 onwards is glibc 2.37+, and updating is the fix. The symptom is
distinctive: the window opens normally and nothing behind it ever starts,
because Chromium targets an old glibc deliberately and the payload does not.

For reference, if that floor ever needs lowering: `rust:1-bullseye` is glibc
2.31, and the same sources built there ask for 2.30 — under every SteamOS there
has been. That was measured, for nebula and libkrun as well as for this
repository's binaries. It is a known, working option, not a theory.

## Things that are fine

- `/dev/kvm` is present and mode `crw-rw-rw-`, so the microVM needs no group
  changes or elevation.
- SVM is enabled; 8 cores report it.
- 14.8 GB RAM, and `/home` had 319 GB free.
- libfuse2 is present, which the AppImage runtime needs.
- The Deck's wifi is not a constraint: 5 GHz, 80 MHz, 866 Mbit/s tx.

## Running it: what a Deck needs

Confirmed on SteamOS 3.8.16 in Desktop Mode, with a real client's GRFs. The
stack reaches **Ready** — microVM, containers, MariaDB, login/char/map — and
the asset server answers on :3338 with the login screen drawn.

Two things are needed to get there, and neither is obvious from a crash log.

**`--disable-gpu-sandbox`.** Without it the app opens, draws the login screen,
and then Chromium kills itself:

```
ERROR:gpu_process_host.cc(976)] GPU process launch failed: error_code=1002   (x5)
FATAL:gpu_data_manager_impl_private.cc(423)] GPU process isn't usable. Goodbye.
```

With the flag: zero GPU errors. The game needs WebGL, so `--disable-gpu` is not
an alternative.

**Run the extracted directory, not the AppImage.** Three launches from the
AppImage, three crashes, all `SIGBUS`, always from the FUSE mount:

```
SIGBUS  /tmp/.mount_RO.AppfvdAeX/ragnarokoffline
SIGBUS  /tmp/.mount_RO.AppC9y3Nn/ragnarokoffline
SIGBUS  /tmp/.mount_RO.AppK84mj6/ragnarokoffline
```

The same build extracted with `--appimage-extract` and started through `AppRun`
is stable. The AppImage file itself is intact — 240617795 bytes, the release's
own size — so this is the squashfuse mount on SteamOS rather than a bad
download. Not yet diagnosed further.

### A trap for anyone testing over SSH

SteamOS sets `KillUserProcesses=True`, so logind kills everything in an SSH
session's scope the moment that session ends. The app dies roughly a minute
after each command returns, the log shows the asset server exiting on `SIGHUP`,
and it looks exactly like a crash. It is not, and it does not affect a Deck
being used normally. Launch it as a user unit instead:

```sh
systemd-run --user --unit=ragnarok --collect \
  --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
  --setenv=WAYLAND_DISPLAY=wayland-0 \
  --setenv=APPDIR=$HOME/rotest/squashfs-root \
  $HOME/rotest/squashfs-root/AppRun --no-sandbox --disable-gpu-sandbox \
  --ozone-platform=wayland --enable-features=UseOzonePlatform
```

## What is still outstanding

**The on-screen keyboard does not open**, so the login screen cannot be typed
into. Steam Deck's Desktop Mode keyboard is STEAM + X; it did not come up over
the app's window. Likely the Wayland text-input protocol not being advertised
to Electron. Without this a Deck owner cannot log in at all, so it is the first
thing to fix.

**The quest window traps you.** Opening a quest leaves the window up with no
way out except going back to character select and logging in again. Worth
knowing what was already ruled out: at packetver 20221005 the client uses the
renewal `Quest` window, which *does* wire its close button
(`close-quest-container-btn` → `onClose()`), and Escape is bound as well. So it
is not simply an unwired button. The remaining suspects are the `mobile-ui`
mod, which relabels that button and is enabled by default, and touch input not
reaching it. Not yet reproduced away from the device.

**Game Mode is untested.** Everything here is Desktop Mode.
