# Example mods

Copy a folder from here into the app's mods directory and restart:

    macOS    ~/Library/Application Support/Ragnarok Offline/state/mods/
    Windows  %APPDATA%\Ragnarok Offline\state\mods\
    Linux    ~/.local/share/Ragnarok Offline/state/mods/

See [docs/MODDING.md](../../docs/MODDING.md) for what each folder in a mod does.

## mobile-ui

A `client/` plugin, and the smallest useful proof that one works. On a phone it
widens the viewport — without it the browser reports 980px and scales the whole
canvas down, which is most of what makes the game unusable on a small screen —
and enlarges touch targets to something a thumb can hit. On a desktop it does
nothing at all.
