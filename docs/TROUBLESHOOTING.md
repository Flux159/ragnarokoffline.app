# Troubleshooting

Answers to the things people have actually hit. If yours is not here, the
Settings window has a **Report a problem** button that copies everything a fix
needs — logs, paths, versions — and opens a new issue ready to paste it into.
Or ask in the [Discord](https://discord.gg/jUYC9dMbu5).

---

## Client files on another drive

GRFs and BGM can stay on a different drive from the app and its data directory.
They are read in place; Developer Mode and administrator privileges are not
needed. Small translation and mod overlays are copied into app-owned state.

If a saved client path cannot be read, reconnect the drive and check that its
drive letter has not changed. Use **Change asset locations** to reselect moved
files or clear a missing optional archive/BGM selection. An explicitly selected
missing archive is reported rather than silently dropped from the load order.

Older builds displayed “could not link” or “same drive” errors. Updating and
reselecting the existing files migrates those selections to the private manifest;
there is no need to move or duplicate the archives. Asset assembly failures leave
the previous generation intact. An interrupted commit is recovered on the next
asset rebuild; reconnect the sources and retry before starting the asset server.

## Windows: a reboot loop, or the machine restarts on launch

Kernel-level anti-cheat and this app cannot both drive the hypervisor. **Riot
Vanguard** (Valorant, League of Legends) loads at boot as a kernel driver and
claims virtualisation exclusively; starting the virtual machine alongside it has
put at least one machine into a reboot loop.

If you are in one: boot into Safe Mode, disable or uninstall the anti-cheat
service, and reboot normally.

To avoid it, fully quit the game **and** its anti-cheat service before launching
— for Vanguard that means the tray icon, `Exit Vanguard`, and often a restart,
since it starts with Windows. EasyAntiCheat in kernel mode, Faceit and ESEA are
likely to behave the same way. Anti-cheat that runs only while a game is open is
generally fine.

This is not something the app can work around: both want exclusive use of the
same hardware feature.

## Windows: "An Application Control policy has blocked this file"

Windows refused to run the app because our files are not code-signed yet, and
**Smart App Control** blocks programs it does not recognise. Nothing is wrong
with your computer and nothing is infected — it is a certificate we have not
finished buying.

It affects newer Windows 11 installs, because Smart App Control is on by default
there and turns itself off on machines that have been in use for a while. That
is why it works for some people and not others.

> [!NOTE]
> Unless you know what you are doing, it is not recommended to do this. Please
> wait for [#8](https://github.com/Flux159/ragnarokoffline.app/issues/8) to be completed to have a seamless experience,
> or try the app on Mac or Linux.

If you understand the trade and want to play now:

```
Windows Security -> App & browser control -> Smart App Control settings -> Off
```

**Turning it off is permanent** — Windows will not let it be switched back on
without reinstalling Windows. You would be disabling a security feature for
every program on that machine, not just this one, and you cannot undo it.

A signed release needs no change on your side. It is in progress and tracked in
[#8](https://github.com/Flux159/ragnarokoffline.app/issues/8); the certificate authority has to verify our identity
first, which takes weeks.

## Windows: the app cannot start its virtual machine

The server runs in a small Linux virtual machine, which needs two separate
things switched on. They fail the same way and are fixed differently, so check
in this order.

**1. Is virtualisation on in your firmware?**

Open **Task Manager** (Ctrl+Shift+Esc) → **Performance** → **CPU**, and look for
**Virtualization** on the right.

> [!NOTE]
> On a Windows that is not in English, that label and most of the command output
> below is translated — Portuguese shows *Virtualização*, and `systeminfo` and
> `dism` translate their headings too, so `findstr` for an English word finds
> nothing and looks like a clean result. `bcdedit` is the exception: its setting
> names are not translated. This is why the app reads these as numbers and
> booleans rather than by matching words, and why its own answer in the
> diagnostics bundle is worth more than any of these commands.

- *Enabled* — good, go to step 2.
- *Disabled* — turn it on in your BIOS/UEFI, under Advanced → CPU
  Configuration. On AMD it is **SVM Mode**, and most AMD motherboards ship with
  it off; on Intel it is **Intel Virtualization Technology**, sometimes written
  **VT-x**. The key to enter setup is shown briefly when the machine starts, and
  is usually Del or F2. Nothing on Windows can enable this for you.
- *You do not see the line at all* — a hypervisor is already running, which
  means it is on. Go to step 2.

**The quickest confirmation**, from a player who found it themselves: press
Windows+R and run **`optionalfeatures`**. If the **Hyper-V** box cannot be
ticked and hovering it says Hyper-V cannot be installed because virtualisation
support is disabled in the firmware, that is the answer outright — it is the
BIOS, and nothing else in this document applies until it is switched on.

**2. Is kernel-level anti-cheat running?** See the section above — Riot Vanguard
and similar drivers take the hypervisor exclusively.

**3. Is the Windows Hypervisor Platform switched on?**

Press Windows+R, run **`optionalfeatures`**, and make sure **Windows Hypervisor
Platform** is ticked. Reboot if you change it.

Or, in a **Command Prompt opened as Administrator**:

```
dism.exe /Online /Enable-Feature /FeatureName:HypervisorPlatform /All
```

Then restart the machine.

**Windows 11 Home is fine.** This is not the full Hyper-V role, which is
Pro-only — it is the same feature WSL2 and Docker Desktop use, and it is
available on Home.

**4. Has the hypervisor been switched off at boot?**

This is the one that survives everything above, and it is why "I already ticked
it and restarted, and I get the same error" is a common reply. Guides for
emulators, VirtualBox and various anti-cheat problems tell people to run
`bcdedit /set hypervisorlaunchtype off`. That setting is permanent, it is
invisible from anywhere in the Windows interface, and it stops the hypervisor
starting no matter how many times the feature is ticked or the machine
restarted.

In a **Command Prompt opened as Administrator**:

```
bcdedit /enum {current} | findstr -i hypervisorlaunchtype
```

Nothing printed means it is unset, which is the default and is fine. `Off` is
the fault. Put it back and restart:

```
bcdedit /set hypervisorlaunchtype auto
```

**What the app can see for itself.** From 1.1.8 the diagnostics bundle carries
all of this — the firmware setting, whether any hypervisor is running, whether
the platform API answers, and the boot setting where it can be read — under
`===== virtualisation =====`, along with a one-line reading of it. The boot
setting is the only one that needs an administrator, so a bundle will say
`unreadable without an administrator` there and print the command to ask for.

To check what Windows itself thinks, in PowerShell:

```powershell
(Get-CimInstance Win32_ComputerSystem).HypervisorPresent
```

`True` means a hypervisor is running. It is not on its own proof the app will
work: it is true whenever *any* hypervisor is running, including the one Memory
Integrity uses, and says nothing about the Windows Hypervisor Platform.

## Windows: it starts, then hangs with nothing happening

If the app reports that the virtual machine did not come up, and repairing does
not help, the guest image may have been damaged as it was written. Installing it
writes over a gigabyte, and antivirus software inspects every byte — a file
quarantined or truncated mid-write leaves a virtual machine that starts and then
does nothing at all.

Version 1.0.2 and later check for this on startup and say so. On earlier
versions, **Repair…** in Settings reinstalls the image. If it recurs, allow this
folder in your antivirus and repair once more:

```
%APPDATA%\Ragnarok Offline\nebula
```

## `ragnarok` / `ragnarok` does not work on the very first login

**Close the app and open it again**, then log in. This has fixed it for everyone
who has hit it.

The account is created the first time the server starts, and on a fresh install
that could race the database still importing its schema — the account creation
failed and nothing reported it. Reopening the app runs it again, against a
database that is now ready.

Fixed in the next release: the app now waits for the schema rather than just a
connection, and refuses to start with an error if the account is not there,
instead of leaving you at a login screen that cannot work.

## After switching era, the server will not start and mentions credentials

The error is:

```
Internet hosting requires this era's managed service credentials. Start in
Local mode, give each GM/admin account an 8-23 character password in
Settings -> Accounts, then use "Prepare server for friends" in
Settings -> Multiplayer.
```

and refreshing the account list answers `Start this era's server first`.

Nothing is wrong with the install, and no data is at risk. The credentials
internet hosting needs are generated separately for renewal and pre-renewal,
but the hosting choice is one setting for both. So preparing one era for
friends and then switching to the other left the setting pointing at an era
that was never prepared, and the server refused to start — including Repair.
The instructions in the message lead to Settings -> Accounts, which needs a
running server, so the two halves waited on each other.

**The way out on an affected build:** Settings -> Multiplayer, set hosting back
to **Local**, and start. Accounts and every other section work again from
there. Switching back to the era you had prepared restores friends hosting with
nothing to redo.

From the next release this is handled: an era that was never prepared for
internet hosting starts in Local mode and says so, instead of not starting.
Your hosting choice is kept, and the era you prepared still hosts.

## My characters are gone / I want to move them to another machine

Settings → **Back up…** writes everything to a single file, and **Restore…**
reads it back. Characters live inside the app's database, not in a folder you
can copy.

## It is slow, or my machine gets hot

Turn down **How busy** in Settings, or switch off **Fake players** entirely. The
AI characters are the only part of the server that costs meaningful CPU, and the
game itself runs on very little.

## A character, homunculus or pet is stuck in a state with no button for it

A homunculus that is nowhere to be seen but cannot be called, vaporized,
resurrected or replaced. A character the server still thinks is online. A pet
that will not come out. These are rows that have got into a combination the
game has no way to reach or leave, and there is nothing in Settings for them.

The server's database can be read and repaired from a terminal with the
supervisor the app already ships:

```sh
# macOS; on Linux the app's folder is ~/.local/share/Ragnarok Offline
"$HOME/Library/Application Support/Ragnarok Offline/runtime/bin/ragnarok-stack" \
  sql "SELECT char_id, name, homun_id FROM \`char\`"
```

```powershell
# Windows, in PowerShell
& "$env:APPDATA\Ragnarok Offline\runtime\bin\ragnarok-stack.exe" `
  sql 'SELECT char_id, name, homun_id FROM `char`'
```

**[docs/DATABASE.md](DATABASE.md)** has the paths for each platform, what is in
which table, and worked repairs — the homunculus one included. Writes go
through `--write`, which saves a backup and stops the game first, because an
edit made underneath a running map server is silently overwritten.

## An asset server is already using port 3338

The app will not reuse or stop a server it cannot identify as its own. Quit
any other Ragnarok Offline copy completely, then retry. A legacy orphan from
an older build may need to be stopped by its exact PID; include the port-conflict
message and `state/assets.log` in a report if you need help identifying it.
Do not kill every process matching an executable name or command-line pattern.

New builds authenticate their managed child and shut it down when the shell
exits or crashes. The log's launch header records the executable fingerprint,
configuration fingerprint and process ID; older logs are retained as
`assets.log.1` through `.3`.

If you close setup before selecting your client, use **Choose client files…**
on the waiting screen to reopen it. The same button is available after a host
startup failure, including when selected files have moved.

A failed game-page load or terminated game window now returns to a recovery
screen. **Retry** reopens the client so you can log in again. Joining a friend
also offers **Play on this computer** when their host is unavailable.
