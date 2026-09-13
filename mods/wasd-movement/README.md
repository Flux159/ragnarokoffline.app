# Keyboard movement, turning and attack

Enabled by default to preserve the app's existing WASD and arrow controls.
Hosts can disable **wasd-movement** in Settings → Mods. Each player can also
open **Controls** in the game to disable movement, remap physical keys, toggle
arrows or give battle shortcuts priority. Preferences are saved in that browser
on that server origin. Turning off keyboard movement preserves click-to-move.

## Turning and attacking

**Q** and **E** turn the camera while held, so the mouse is not needed to look
around. They obey the same limits a right-drag does, and indoor maps allow only
a narrow window — in `prt_in` the camera turns about thirty-five degrees in
total, so a key press there moves as far as the map permits and then stops.
That is the map's rule, not this mod's.

**Space** attacks the nearest living monster, walking into range first when it
is out of reach — the same thing clicking the monster does. It sends RO's
*continuous* attack, so the server keeps swinging until the target falls;
nothing loops here, and nothing looks for a new target once one dies. Holding
space does not re-issue the order, and a fresh press picks the nearest target
again. This is a control, not an auto-hunter: it never moves you anywhere you
did not aim at and never chooses a fight on its own.

**Skills stay where they already were.** roBrowser has its own shortcut bar on
F1–F9, remappable in game, and this mod does not touch it.

Each of the three — movement, turning, attack — can be switched off on its own
in **Controls**.

## Priority and cancellation

Chat, text entry, IME composition and shortcut capture take priority. Keyboard
and touch share one movement owner; switching input or leaving a map cancels
held directions. Releasing a key stops new destination requests. The server can
finish an already accepted path of up to three steps; this is not an instant
stop or a change to server movement speed.

Full key reference, including roBrowser's own shortcut bar and how the two
overlap: [docs/KEYBOARD_CONTROLS.md](../../docs/KEYBOARD_CONTROLS.md).
