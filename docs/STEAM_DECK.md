# The Steam Deck

**The app runs on a Steam Deck, and downloading it and double-clicking it is
all it takes.** Confirmed on SteamOS 3.8.16, in Desktop Mode, with a real
client's GRFs: the microVM boots, the server reaches Ready, the game draws, and
it is playable with the Deck's own controls. No flags, no terminal, no
workarounds.

That is a correction. An earlier round of testing recorded two hard blockers —
the AppImage crashing with `SIGBUS`, and Chromium killing itself over the GPU
sandbox — and a third, the on-screen keyboard never opening. **None of them are
real.** All three were produced by how the app was being launched over SSH, and
the section on that trap is at the bottom, because it cost a day and will cost
the next person one too.

On an *older* SteamOS it cannot start at all, and that part stands. See
[Why an old SteamOS is not supported](#why-an-old-steamos-is-not-supported).

## Installing it

Download the AppImage from the releases page in Desktop Mode and run it. There
is one step that is not a double-click, and it is not ours to remove:

**Firefox does not mark downloads executable.** So the first double-click opens
the file in an archive tool rather than running it. In Dolphin: right-click →
Properties → Permissions → *Is executable*. Or `chmod +x` in Konsole. Every
AppImage on every distribution has this problem.

After that it runs, and **the first run writes a launcher entry**, so the app
appears under Games in the application launcher and in search, with its icon,
like it would on any other system. That is `electron/linux-desktop-entry.js`:
an AppImage installs nothing, so nothing else would ever do it. The entry
points back at wherever the AppImage was saved, is rewritten if the file moves,
hides itself through `TryExec` if the file is deleted, and is skipped entirely
if some other entry already claims the name. `RAGNAROK_OFFLINE_NO_DESKTOP_ENTRY`
turns it off.

Verified on the Deck rather than only in tests: the module runs there under
the environment the AppImage runtime sets, writes an entry
`desktop-file-validate` accepts, copies the 1024×1024 icon into the user's
hicolor tree, and leaves the file untouched on a second run. The `Exec` line it
writes starts the app to **Ready** when run verbatim.

Game Mode needs a Steam shortcut, which a desktop entry is not. Untested.

## What works on the hardware

Measured by playing it, not inferred:

| | |
|---|---|
| On-screen keyboard | STEAM + X, types into the login screen |
| Left stick | movement |
| Right stick | moves the pointer |
| Right trackpad | moves the pointer |
| Touchscreen | works as a pointer |
| Virtual machine | `vm Running, agent healthy` in 2.7 s |

## Which layout you get, and why it moves

The bundled `mobile-ui` mod picks a layout automatically, and on a Deck it can
land either way, which looks arbitrary from the outside. The rule is a touch
screen *and* a short side of 900 pixels or less. The Deck's 1280×800 always
satisfies the second half, so it comes down to whether the desktop session
tells the app there is a touch screen — and that depends on the display
backend:

| Launched as | Ozone platform | Layout |
|---|---|---|
| plain double-click | X11, through Xwayland | desktop |
| `--ozone-platform-hint=auto` | Wayland | phone |

Both are playable. Neither is forced, deliberately: the default is whatever the
session gives, which is also what every other Linux distribution gets, so
nothing here changes behaviour anywhere else.

What was worth fixing is that the reason was invisible. The Display dialog's
Auto option now says which layout it is choosing and states the rule, instead
of reading "Auto — touch screens" and leaving a player to guess. Either way,
**Display → Phone layout → On/Off** overrides it.

## Why an old SteamOS is not supported

A Deck on **SteamOS 3.2**, build `20220526.1`, glibc **2.33**. The AppImage
starts — the window opens and the state directory is created, because Chromium
deliberately targets an old glibc — and then nothing behind it runs:

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

The same physical Deck, after updating:

| | SteamOS 3.2 (2022-05) | SteamOS 3.8.16 (2026-07) |
|---|---|---|
| glibc | 2.33 | 2.41 |
| kernel | 5.13 neptune | 6.16.12-valve24.5 |
| payload binaries | none start | all start |
| `libkrun.so.1` | unresolved symbols | resolves |
| `nebula up` | impossible | **2.7 s** |

The binaries are built on `runs-on: ubuntu-latest`, which is Ubuntu 24.04 and
ships glibc 2.39. Nothing pins that floor, so it follows the runner. We
deliberately do not build lower: keeping SteamOS 3.2 working would mean a
second Linux build in an old-glibc container, the same again for nebula's embed
kit, and a floor check in both repositories to stop it drifting up again — a
permanent second build target for a four-year-old image that Valve updates
automatically.

**If someone reports the app not starting on a Deck, ask for their SteamOS
version first.** Settings → System, or `ldd --version` in a terminal. Anything
from 3.5 onwards is glibc 2.37 or newer, and updating is the fix. The symptom
is distinctive: the window opens normally and nothing behind it ever starts.

For reference, if that floor ever needs lowering: `rust:1-bullseye` is glibc
2.31, and the same sources built there ask for 2.30 — under every SteamOS there
has been. That was measured, for nebula and libkrun as well as for this
repository's binaries. It is a known option, not a theory.

So [#87](../../../issues/87)'s question — can nebula spin up VMs on a Steam
Deck — is answered: yes, on a current SteamOS, with the build that already
ships.

## Things that are fine

- `/dev/kvm` is present and mode `crw-rw-rw-`, so the microVM needs no group
  changes or elevation.
- SVM is enabled; 8 cores report it.
- 14.8 GB RAM, and `/home` had 319 GB free.
- libfuse2 is present, which the AppImage runtime needs.
- The Deck's wifi is not a constraint: 5 GHz, 80 MHz, 866 Mbit/s tx.

## The trap: testing over SSH invents crashes

SteamOS sets `KillUserProcesses=True`, so logind destroys everything in an SSH
session's scope the moment that session ends. A GUI app started over SSH is
therefore killed about a minute after the command that started it returns —
and it does not die cleanly or all at once, which is what makes this expensive:

- **The squashfuse daemon dies first.** It is what backs the AppImage's mount
  at `/tmp/.mount_RO.App*`, and the app's executable pages are mapped from it.
  Every page fault after that point is `SIGBUS`. Three launches, three
  `SIGBUS`, always from the mount, all of it recorded as an AppImage bug on
  SteamOS. It is not. Mounting the same AppImage with `--appimage-mount` and
  reading all 187 files through it gives 0 errors.
- **Child processes are killed as they spawn.** `GPU process launch failed:
  error_code=1002` five times, then `GPU process isn't usable. Goodbye.`, which
  reads exactly like a sandbox incompatibility. Launched properly, there are no
  GPU errors at all and no flag is needed.
- **The window disappears while someone is testing it.** Which is how "STEAM +
  X does not open the keyboard" got written down.

Launch it as a user unit instead, which survives the session ending:

```sh
systemd-run --user --unit=ragnarok --collect \
  --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
  --setenv=WAYLAND_DISPLAY=wayland-0 \
  --setenv=DISPLAY=:0 \
  $HOME/RO.AppImage
```

`systemctl --user stop ragnarok` stops it, and `journalctl --user -u ragnarok`
has its output. Add `--ozone-platform-hint=auto` to get the native Wayland path
and the phone layout.

One more SSH-specific thing, in the other direction: `/proc/<pid>/environ` and
`/proc/<pid>/fd` are unreadable for a process you did not start, because
SteamOS sets `kernel.yama.ptrace_scope = 1`. `/proc/<pid>/cmdline` and
`/proc/<pid>/maps` still work, and the resolved Ozone platform is visible in
the *child* process arguments — `--ozone-platform=wayland` appears there even
when only the hint was passed.

## What is still outstanding

**Game Mode is untested.** Everything here is Desktop Mode, and Game Mode needs
a Steam shortcut rather than a desktop entry.

**The quest window.** Reported as trapping the player, with no way out but
character select and a relog. Worth recording what was ruled out: at packetver
20221005 the client uses the renewal `Quest` window, which *does* wire its close
button (`close-quest-container-btn` → `onClose()`) and *does* bind Escape, so it
is not an unwired button. It was seen under the phone layout, which is where
`mobile-ui` relabels that button, and that remains the leading suspect. Not yet
reproduced away from the device.
