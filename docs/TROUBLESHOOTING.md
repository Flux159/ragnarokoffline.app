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

- *Enabled* — good, go to step 2.
- *Disabled* — turn it on in your BIOS/UEFI. It is usually called
  **Intel VT-x**, **AMD-V** or **SVM Mode**, and the key to enter setup is shown
  briefly when the machine starts. Nothing on Windows can enable this for you.
- *You do not see the line at all* — a hypervisor is already running, which
  means it is on. Go to step 2.

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

To check what Windows itself thinks, in PowerShell:

```powershell
(Get-CimInstance Win32_ComputerSystem).HypervisorPresent
```

`True` means a hypervisor is running and the app should work.

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

## My characters are gone / I want to move them to another machine

Settings → **Back up…** writes everything to a single file, and **Restore…**
reads it back. Characters live inside the app's database, not in a folder you
can copy.

## It is slow, or my machine gets hot

Turn down **How busy** in Settings, or switch off **Fake players** entirely. The
AI characters are the only part of the server that costs meaningful CPU, and the
game itself runs on very little.
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
