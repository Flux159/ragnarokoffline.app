# Keyboard movement

Enabled by default to preserve the app's existing WASD and arrow controls.
Hosts can disable **wasd-movement** in Settings → Mods. Each player can also
open **Controls** in the game to disable movement, remap physical keys, toggle
arrows or give battle shortcuts priority. Preferences are saved in that browser
on that server origin. Turning off keyboard movement preserves click-to-move.

Chat, text entry, IME composition and shortcut capture take priority. Keyboard
and touch share one movement owner; switching input or leaving a map cancels
held directions. Releasing a key stops new destination requests. The server can
finish an already accepted path of up to three steps; this is not an instant
stop or a change to server movement speed.
