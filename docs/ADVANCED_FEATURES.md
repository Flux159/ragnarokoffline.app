# Advanced features

Everything here is optional. The app manages its own data and you never have to
touch any of it — this is for when you want to move your characters to another
machine, work out what is using disk space, or start over from scratch.

---

## Managing owner and friend accounts

Start your own server, then open **Settings → Accounts → Refresh accounts**.
The panel names the selected era, account ID, privilege group and enabled state.
Renewal and pre-renewal use different databases: a password change applies only
to the era shown. If an era switch did not finish, account operations refuse to
write to a database whose actual volume does not match the selected era.

Select `ragnarok` and use **Change GM/admin password**, entering the new password
twice. The new value must be 8–23 printable ASCII characters; spaces and
punctuation are supported. The pinned game login packet has only 24 bytes for
the password including its terminator. Inputs are rejected rather than silently
truncated. This setting preserves the account ID, GM privileges and characters.
Passwords are cleared from the form after an attempted change and are excluded
from application diagnostics. This build uses rAthena's default plaintext game
password format. Custom login imports and MD5 mode are rejected for password
writes and need an explicit migration; this is not modern web password hashing.

The same panel creates ordinary group-0 friend accounts, resets passwords and
disables or enables logins. Changes disconnect active players and restart the
previously running game services, preventing an older in-memory account record
from overwriting a password change. A restart failure explicitly says whether
the account was already updated. Refresh the panel and start the server before
reconnecting. The panel currently supports up to 250 accounts.

The first database initialization seeds `ragnarok/ragnarok`. Startup, Repair
and switching eras no longer recreate that login in an existing database when
it has been deleted or renamed. Resetting a password never changes the account's
enabled/disabled state. A backup contains the account state and credentials from
when it was made; restoring it restores those values too.

Account settings require a bundled `docker-slim` that advertises
`exec-stdin-eof-v1` (nebula PR #33). Older runtimes are rejected before stopping
game services. This account foundation does not enable internet hosting;
restricted registration, service-secret rotation, invitations and tunnel
protection remain separate work for issue #4.

---

## Backing up and restoring your characters

Accounts and characters live in a MariaDB database inside the microVM, not in a
file you can copy. Settings has the two buttons that get them in and out:

**Settings → Save data → Back up…** writes a single `.sql` file wherever you
choose. It is a plain text dump — accounts, characters, inventories, storage,
guilds — and it is safe to take while you are logged in and playing.

**Settings → Save data → Restore…** reads one back.

A few things worth knowing:

- **The server has to be running.** Both operations talk to the live database,
  so start the app normally first. Backing up with the server down fails with
  "the database did not produce a dump".
- **Restoring replaces everything.** The dump recreates the whole `ragnarok`
  database rather than merging into it, so anything created since that backup is
  gone. If the restore itself fails, the existing database is left untouched.
- **A backup is portable.** The file is ordinary SQL, so restoring it on another
  machine — or after deleting the data folder below — brings your characters
  with it. This is the supported way to move an install.

Keep one before you experiment with rates or NPC scripts.

---

## Where the app keeps its data

One folder holds everything the app generates: the microVM, its disks, the
server runtime and your settings.

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/Ragnarok Offline` |
| Windows | `%APPDATA%\Ragnarok Offline` (that is `AppData\Roaming`, not `Local`) |
| Linux | `~/.local/share/Ragnarok Offline` (or `$XDG_DATA_HOME/Ragnarok Offline`) |

Inside it:

| Entry | What it is |
|---|---|
| `nebula/` | The microVM: guest kernel, container images, and the virtual disks. Nearly all of the size. |
| `runtime/` | The server runtime — rAthena config, SQL schema, the client. Replaced wholesale by each app update. |
| `state/` | Generated config, seeded schema, and staged backups. Deliberately outside `runtime/` so an update cannot wipe it. |
| `state/mods` | Location of mod folders |
| `client.json` | Which folder your GRFs are in, and whether you are hosting or joining. |

**Your Ragnarok client is not in here.** The GRFs stay wherever you put them and
are read in place, so a 3.5 GB client is never duplicated and is never at risk
from anything on this page.

> [!NOTE]
> If you wipe your app data directory, you will lose any mods you downloaded. Make sure to copy the `state/mods` folder
to a safe place before deleting so you can recover your mods.

---

## How much disk it uses

About **4.5 GB** once you have played, on top of the app itself. A representative
install:

| | Size |
|---|---|
| `nebula/disks` — the VM's root and data disks | 2.0 GB |
| `nebula/images` — container images | 1.0 GB |
| `nebula/cache` | 1.0 GB |
| `nebula/kernel` | 48 MB |
| `runtime/` | 155 MB |
| `state/` | 39 MB |
| **Total** | **~4.4 GB** |

Most of that arrives on first launch, when the runtime is unpacked and the
container images are loaded. It grows slowly after that — the database is the
only part that keeps changing, and characters are small.

**`data.img` will look enormous and is not.** It is a sparse file: `ls` reports
its 16 GB maximum size, while the space actually consumed is what the table above
shows. Measure the folder with `du -sh` rather than trusting the file listing.

---

## Starting over

Deleting that folder resets the app to a fresh install — the state it was in
before you first ran it.

1. **Back up first** if you want your characters (above). Once the folder is
   gone they cannot be recovered.
2. **Quit the app**, and make sure it has fully shut down. It stops the microVM
   on its way out, and deleting the folder while that is still running leaves a
   process with no files underneath it.
3. Delete the folder for your platform from the table above.

Next launch behaves exactly like the first one: it asks for your client folder
again, unpacks the runtime, boots the microVM and initialises an empty database —
the few minutes the first run takes, not the seconds a normal one does.

You lose your characters, your rate settings, and the app's memory of where your
GRFs are. You do not lose the GRFs themselves. This is also the reliable fix for
an install that has got itself into a state no amount of restarting clears.

## Opening Settings instead of the game

Launching the app opens the game window, which starts the server for you. That
is what almost everyone wants, and it is the default.

If you spend more time changing settings than playing — switching era, testing a
mod, moving rates around — turn on **Settings → General → Startup → At startup:
open Settings instead of the game**. The next launch opens Settings and nothing
else. No server starts on its own, so press **Start** and then **Open game**
under **Server** when you actually want to play.

Closing that window quits the app, the same as closing the game window does.
Turn the option off to go back to the game opening first.

## Finding your way around

Open **Navigation** in the game client to search every entry, or just NPCs, or
just monsters. Results sharing a name are grouped: pick the map and coordinates
on the right, then choose **Find**. The route is drawn on the ground using the
navigation art from your own client, and clears itself when you arrive.

The chat command takes either a destination or a name:

```
/navi lhz_in02 100/143
/navi Kafra
```

### When searches come back empty

The tables behind the search are read from your own client archives, and they
normally match the maps that client shipped with. Some optional English GRFs
replace those tables with data this client cannot read, and then every search
returns nothing.

If that happens, turn on **Settings → Mods → navigation-english-tables**. It
supplies a known-good English set in place of the ones your GRF provides.

It is off by default deliberately. Your client's own tables are the better
source whenever they work, because they match its maps and may list places the
bundled copy does not. Turn this on only when the search is actually empty.
