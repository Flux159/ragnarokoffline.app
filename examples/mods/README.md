# Example mods

Eight mods, each one actually run against a real server, each with a README
saying what it demonstrates and what to look at first. Open the one closest to
what you want and copy it.

Install by copying a folder into the mods directory:

    macOS    ~/Library/Application Support/Ragnarok Offline/state/mods/
    Windows  %APPDATA%\Ragnarok Offline\state\mods\
    Linux    ~/.local/share/Ragnarok Offline/state/mods/

Then restart the server from Settings — or the whole app, if the mod has a
`data/`, `System/` or `client/` folder. [docs/MODDING.md](../../docs/MODDING.md)
explains what each layer does.

Every one of these carries only the layers it actually needs, which is worth
noticing: a `data/`-only mod has no empty `npc/` folder for symmetry.

| mod | layers | what it shows |
|---|---|---|
| [login-screen](login-screen) | `data/` | Your own art on the login screen — which is twelve images, not one. |
| [loading-screens](loading-screens) | `data/` | Ten loading screens, drawn at random. The rotation is already in the client. |
| [tougher-monsters](tougher-monsters) | `db/` `npc/` | Both ways to change what you fight, and how `Drops:` differs from every other field. |
| [quest-npc](quest-npc) | `npc/` | A menu, a branch, a character variable that survives a relog, and a reward. |
| [custom-item](custom-item) | `db/` `System/` `npc/` | An item in no client: stats, a name, and an NPC who gives you one. Ten lines of `System/`, not five megabytes. |
| [custom-map](custom-map) | `data/` `npc/` | A map that is in nobody's GRF, with monsters and an NPC on it. |
| [island-ferry](island-ferry) | `npc/` | A warp square and an NPC that takes you to it. Needs `custom-map`. |
| [island-population](island-population) | `db/` | **Blocked.** Why AI population cannot be configured for a modded map yet. |
| [start-in-your-town](start-in-your-town) | `conf/` `npc/` | New characters wake up on your island. Needs `custom-map`. |

One folder here is **not** a mod:

| | |
|---|---|
| [randomizer](randomizer) | A program that *writes* a mod. `ro-randomizer --seed 12345` reads the monster table out of the running server, shuffles it, and writes an installable folder. Ships as a binary with the app, so there is nothing to build. |

`mobile-ui` used to live here. It now ships **with** the app, in
[`mods/`](../../mods/mobile-ui) — it is on by default and is still the
shortest complete example of the `client/` layer.

## Installing all of them at once

They are built to coexist, and installed together they are close to a small
server of somebody's own: your art on the login and loading screens, an island
you start on, a ferry back to Prontera, a quest in town, and fields that fight
back.

```sh
# macOS
cp -R examples/mods/* ~/Library/"Application Support"/"Ragnarok Offline"/state/mods/
```

Two of them depend on `custom-map` — `island-ferry` and `start-in-your-town` —
because there is no island without it. `island-population` does not work at all
and says so; it is here because a half-example that names the wall is worth
more than a gap.

## Tools these were built with

- [`scripts/mkmap.py`](../../scripts/mkmap.py) — writes a playable map from
  nothing: `.gat`, `.gnd`, `.rsw`, a ground texture and a minimap.
- [`scripts/mkloginbg.py`](../../scripts/mkloginbg.py) — cuts one picture into
  the twelve tiles the login screen is actually made of.
- [`randomizer/`](randomizer) — the one that ships with the app, because
  generating a seed should not need a Python install. Its source is worth
  reading for the `db/import` traps it had to work around.

## About the artwork

The images in `login-screen` and `loading-screens` were generated for this
repository and depict no Gravity characters, logos or artwork. Like the app's
icon, they are here so the examples work when you copy them — replace them with
your own.
