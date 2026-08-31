# Advanced features

Everything here is optional. The app manages its own data and you never have to
touch any of it — this is for when you want to move your characters to another
machine, work out what is using disk space, or start over from scratch.

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
| `client.json` | Which folder your GRFs are in, and whether you are hosting or joining. |

**Your Ragnarok client is not in here.** The GRFs stay wherever you put them and
are read in place, so a 3.5 GB client is never duplicated and is never at risk
from anything on this page.

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
