# Running Ragnarok Offline headless

The app hosts its server on its own: when it starts, its game window opens a
boot page that brings up the VM, rAthena and the asset server. Nobody has to
log in. The server is up and accepting players while the window sits at the
login screen.

So a Linux machine with no screen can host by running the **unmodified app**
against a virtual display. `run-headless-after-configuration.sh` does that.
Nothing in the app is changed, so pulling upstream never conflicts with this.

```sh
./run-headless-after-configuration.sh "/opt/ragnarok/Ragnarok Offline-x64.AppImage"
```

## What the machine needs

- **x64 Linux with KVM.** `/dev/kvm` must exist, and the account must be in
  its group: `sudo usermod -aG kvm "$USER"`, then log in again.
- **A normal account, not root.** Chromium refuses to start as root without
  turning its sandbox off.
- **Xvfb**, the virtual display: `sudo apt install xvfb`.
- **The libraries any Electron app needs.** A desktop distribution has them.
  A minimal server image may not. On Debian/Ubuntu:
  `sudo apt install libgtk-3-0 libnss3 libasound2 libgbm1`.
  If the app exits at once, run it once by hand to see which library is
  missing.
- **The Linux release AppImage**, made executable (`chmod +x`). FUSE is not
  needed: without it, the script tells the AppImage to extract itself instead.
- **Your game client's files** (`data.grf`, optionally `rdata.grf` and `BGM/`)
  somewhere on the machine.

## Configure it

The script runs whatever the app last saved, so set it up first. The app keeps
its configuration in two files, under
`~/.local/share/Ragnarok Offline/` for the account that runs it:

| File | Holds |
|---|---|
| `client.json` | where the GRFs are, host or join, the VM's memory |
| `state/settings.json` | everything in the Settings window: rates, era, client version, LAN… |

Use either of these routes.

**A. Use the app's own windows, once.** Run the app with a display you can see,
on the same account, over SSH X forwarding (`ssh -X`) or VNC. Pick your client
in the setup window, set everything in Settings, press Apply, and quit.

**B. Configure on your desktop, then copy.** Set it up in the app on your own
computer, then copy across:

- `state/settings.json`, which holds all the Settings choices;
- `state/mod-settings.json` and the `state/mods/` folder, if you use mods.

`client.json` holds paths on *your desktop*, so do not copy it. Write the
headless machine's own:

```json
{
  "mode": "host",
  "lan": true,
  "data_grf": "/srv/ragnarok-client/data.grf",
  "rdata_grf": "/srv/ragnarok-client/rdata.grf",
  "bgm_dir": "/srv/ragnarok-client/BGM"
}
```

Either way, three settings decide whether it hosts usefully. The script checks
them before it starts:

| Setting | Must be | In the file |
|---|---|---|
| Settings → Multiplayer → Mode | **Host a server** | `"mode": "host"` in `client.json` |
| Settings → Multiplayer → Allow LAN connections | **on**, for anyone else to connect | `"hosting_scope": "lan"` in `settings.json` |
| Settings → Startup → open Settings instead of the game | **off** | `"open_settings_first": false` in `settings.json` |

## Run it

```sh
./run-headless-after-configuration.sh /path/to/Ragnarok-Offline.AppImage
```

(or set `RAGNAROK_APP` to the path.) On the first run, starting takes a few
minutes: the app installs the VM image and the server. Players then connect to
`http://<this machine's address>:3338/`, from a browser or from the app's
**Join a friend**.

Stop it with **Ctrl-C** or `SIGTERM`. The script passes the stop on, and the
app shuts the server down cleanly before exiting. That takes up to a few
minutes, and the virtual display stays up until it has finished. If the app
exits on its own, the script exits with the app's exit code.

### Is it up?

```sh
cat ~/.local/share/"Ragnarok Offline"/state/phase    # "Ready" once the server is up
curl -sI http://127.0.0.1:3338/ | head -1           # the asset server answering
```

If a start fails, the app shows the error **in its window**, which nobody can
see here, and keeps running with nothing hosted. The script cannot tell that
apart from a server that is running. So if `phase` is not `Ready` after a few
minutes, read `state/app.log` (and `state/logs/`) for the reason, fix it, and
restart.

### As a service

```ini
# /etc/systemd/system/ragnarok.service
[Unit]
Description=Ragnarok Offline (headless)
Wants=network-online.target
After=network-online.target

[Service]
User=ragnarok
Environment=HOME=/home/ragnarok
ExecStart=/opt/ragnarok/run-headless-after-configuration.sh "/opt/ragnarok/Ragnarok Offline-x64.AppImage"
KillMode=mixed
TimeoutStopSec=300
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- `User=` is the account you configured. The settings live in its home folder.
- `KillMode=mixed` sends the stop to the script alone, which hands it to the
  app. Without it, systemd signals everything at once. The VM could then die
  before the database has stopped, and a database killed that way can lose
  data.
- `TimeoutStopSec=300` gives that shutdown time to finish.

## Changing settings later

Stop it, change the settings (route A or B above), and start it again. The app
reads its configuration when it starts.

## Updating

Download the new release AppImage, and point the script or service at it. The
app updates its own runtime on first start, as it does on a desktop.

## Good to know

- The game window really exists, on the virtual display, and sits at the login
  screen. It draws in software, so expect a small, steady CPU cost.
- It is the real app, so everything the desktop app does works, including
  sharing with friends over the internet (Settings → Multiplayer).
- Only one copy at a time per account: the app and a headless run use the same
  ports and the same database.
