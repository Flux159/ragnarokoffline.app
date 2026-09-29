# settings-window

A mod with **its own settings window**. Two NPCs by the Prontera fountain and
a page that lays them out the way the mod wants: the NPCs in
a foldable group with one switch for both, and buttons to save and to restart
the server — without the player going back to the Mods tab.

| look at | for |
|---|---|
| `mod.json` | `"settingsPage": "settings/index.html"`, next to ordinary `settings` |
| `settings/index.html` | `window.modSettings.get()`, `.set()` and `.apply()` — the whole API |
| `npc/when/<key>/` | the NPCs each setting switches on and off |

The group switch is not a setting: it is worked out from the two NPC settings
and sets both when clicked. That is the point of a page of your own — logic
like "one switch for a group" lives in the mod's page, not in `mod.json`.

The page runs in a locked-down window. It can only read and change **this**
mod's declared settings and restart the server; it cannot reach the internet or
read files outside the mod folder. On an app without settings windows the same
options simply appear under the mod in the Mods tab.
