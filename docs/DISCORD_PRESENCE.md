# Discord Rich Presence

While the game window is open, the player's Discord profile can say what they
are playing:

> **Ragnarok Offline**
> Lv 99/50 Assassin Cross
> Prontera · In a party (3 of 12)
> 12:34 elapsed

## How it works

- `patches/client/DiscordPresence.mjs`, wired in by `ExtensionBridge.mjs`,
  reads the character from the game page (map, job id, base and job level,
  party size, name). It sends `presence_update` to the app when one of those
  changes: on entering a map, and on a slow 15-second look for level and party
  changes. It does nothing in a browser tab, which has no `invoke`.
- `presence_update` in `electron/main.js` takes reports only from the game
  window's main frame. It keeps short strings and small numbers, and nothing
  else (`discordState`), because on a joined world the page comes from the other
  host.
- `electron/discord-presence.js` turns the report into an activity
  (`buildActivity`) and sends it to the Discord desktop app over its local IPC
  socket (`discord-ipc-0..9`), using Discord's framed-JSON protocol. It has no
  dependencies. Changes closer together than five seconds are merged, to stay
  under Discord's rate limit. When Discord isn't running, it checks again every
  30 seconds and logs that once.
- Job names come from `tools/control-panel/job-names.js` (rAthena's own English
  names), so they don't depend on the client's code page.

## Who gets it

Only programs on the player's own computer can set their Discord status. So
presence works for:

- the host, playing in the app;
- a friend who joins through the app (Join), whose own app sets their own status.

A friend playing in a web browser gets none. A browser page cannot reach the
Discord socket, and the host cannot set another person's status.

## Settings

Settings → General → Discord. Each switch is saved straight away, with no
server restart.

| Key | Default | Shows |
|---|---|---|
| `discord_presence` | on | anything at all |
| `discord_show_name` | **off** | the character's name |
| `discord_show_map` | on | the map name |
| `discord_show_party` | on | "In a party" and its size |

Job and level are always shown while presence is on.

## Setting up the Discord application

1. At <https://discord.com/developers/applications>, create an application. Its
   name is what Discord shows as the game ("Playing Ragnarok Offline").
2. Under **Rich Presence → Art Assets**, upload the logo with the key `logo`
   (at least 512×512).
3. Copy the **Application ID**. It isn't secret.
4. Paste it into **Settings → General → Discord → Application ID** and press
   **Save**. Each player can use their own, and the status then says "Playing
   <their application's name>". Otherwise the app's own ID is used
   (`DISCORD_APP_ID` in `electron/main.js`). `RAGNAROK_OFFLINE_DISCORD_APP_ID` overrides both,
   which is handy for testing.

   With no ID anywhere, the feature is off, and Settings asks for one.

## Art

Upload these under **Rich Presence → Art Assets** in the Discord application,
using exactly these names. Only `logo` is needed. The app asks Discord which
pictures the application has (the same public list the developer portal shows)
and shows the logo in place of any that are missing, so a partial set is fine.

`scripts/make-discord-art.py` makes the whole set from the game's own files:
the town minimaps for the regions, and each job line's first job, standing with
a default head, for the jobs. Run it while the app is running, since it reads
them from the asset server, then upload what it saves.

- `logo`: shown when the map is hidden, or has no picture of its own.
- One picture per region, shown as the large image. Each town's fields and
  dungeons share its picture (`prt_fild08` shows `map_prontera`):
  `map_prontera`, `map_izlude`, `map_geffen`, `map_payon`, `map_morocc`, `map_alberta`, `map_aldebaran`, `map_comodo`, `map_juno`, `map_einbroch`, `map_lighthalzen`, `map_rachel`, `map_veins`, `map_hugel`, `map_glastheim`, `map_niflheim`, `map_amatsu`, `map_gonryun`, `map_louyang`, `map_ayothaya`, `map_umbala`, `map_moscovia`, `map_brasilis`, `map_dewata`, `map_malangdo`, `map_eclage`, `map_splendide`, `map_guild`, `map_pvp`.
- One icon per job line, shown as the small image, with the job's name on
  hover: `job_novice`, `job_swordman`, `job_mage`, `job_archer`,
  `job_acolyte`, `job_merchant`, `job_thief`, `job_taekwon`, `job_gunslinger`,
  `job_ninja`, `job_summoner`, `job_druid`. Every job uses the icon of the line it comes
  from, so Rune Knight shows `job_swordman`.

The regions are `REGIONS` in `electron/discord-presence.js`, and the job lines
are `FAMILIES`. The status can also carry two public links, "Get Ragnarok
Offline" and "Join the Discord", which Settings → Links turns off. Neither
leads into the player's world.

## Linux

Wayland doesn't matter here, because this uses a socket and not the window.
The socket is looked for in `$XDG_RUNTIME_DIR`. It is also looked for in the
folders the Flatpak (`app/com.discordapp.Discord`) and Snap (`snap.discord`)
builds use, then `$TMPDIR` and `/tmp`. Vesktop needs its arRPC option turned on.
Discord running in a web browser has no socket.
