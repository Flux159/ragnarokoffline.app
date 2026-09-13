# Playing from the keyboard

Ragnarok was built for the mouse, and the browser client inherits that. Two
separate things close the gap, and they come from different places:

- **The shortcut bar** is roBrowser's own, present whether or not you enable any
  mod. It is what puts skills and items on keys.
- **The `wasd-movement` mod** is ours, bundled and on by default. It adds
  walking, camera turning and an attack key.

Knowing which is which matters when something does not work: a skill that will
not fire is a shortcut-bar question, and a character that will not walk is a mod
question.

---

## Skills and items — the shortcut bar

This is built into the client. Nothing needs installing.

**Open it** with `ALT`+`M`, or find *Shortcuts* in the game's own menus. It is a
grid of slots; press `F12` to cycle how many rows are shown.

**Fill a slot** by dragging onto it:

- a skill from the skill window (`ALT`+`S`)
- an item from the inventory (`ALT`+`E`)

**Then press its key.** Four rows are bound out of the box:

| Row | Keys | Slots |
|---|---|---|
| 1 | `F1` … `F9` | 1–9 |
| 2 | `1` … `9` | 10–18 |
| 3 | `Q` `W` `E` `R` `T` `Y` `U` `I` `O` | 19–27 |
| 4 | `A` `S` `D` `F` `G` `H` `J` `K` `L` | 28–36 |

So **yes — number keys already work**, as row two. You do not have to remap
anything to get skills onto `1`, `2`, `3`.

**Rows three and four overlap the movement keys.** `W`, `A`, `S`, `D` are row-4
and row-3 slots, and so are `Q` and `E`. See *Resolving the overlap* below.

### Quickspell — casting from the mouse

The official client lets the mouse fire three of the hotkeys, and these are
toggles you turn on in chat. Both are off until you ask for them.

| Command | Does | Also |
|---|---|---|
| `/q1` | right click casts the **F9** slot | `/quickspell` |
| `/q2` | wheel up and down cast **F7** and **F8** | `/quickspell2` |
| `/q3` | both at once | |

Type the command again to toggle, or be explicit with `/q1 on` and `/q1 off`.
The choice is saved per browser, like every other client preference.

The slots are fixed at F7, F8 and F9 — that is the official client's choice, not
ours, and it is not configurable there either.

Two things worth knowing:

- **Right-drag still rotates the camera.** Only a right click that does not move
  the mouse casts, which is the same rule the client already used to decide
  whether to open a context menu.
- **The wheel still sets skill level while you are choosing a target.** That
  takes priority; quickspell only takes the wheel back afterwards, and zooming
  moves to whatever you have left.

### Remapping

Every binding above is remappable in the client's shortcut-configuration window,
and the choice is saved per browser. The full table also covers window toggles
(`ALT`+`E` inventory, `ALT`+`Q` equipment, `ALT`+`S` skills, `ALT`+`V` basic
info, `ALT`+`U` quests, `ALT`+`L` emotions, `CTRL`+`B` bank …), sitting on
`INSERT`, chat height on `F10`, and ten macro slots on `ALT`+`1`…`ALT`+`0`.

---

## Walking, turning and attacking — the `wasd-movement` mod

Bundled and enabled by default. A host can switch it off in **Settings → Mods**;
each player can configure it in game with the **Controls** button.

| Key | Does |
|---|---|
| `W` `A` `S` `D` | walk |
| Arrow keys | walk (optional, on by default) |
| `Q` / `E` | turn the camera while held |
| `Space` | attack the nearest monster |

Movement, turning and attack can each be switched off on their own.

### Walking

Ragnarok has no directional walk packet, only *walk to this cell*, so a held key
becomes a repeated destination a few cells ahead. The vector is rotated by the
camera, so **up is up the screen**, not up the map — turn the camera and `W`
still means "away from you".

Releasing a key stops new destinations being sent. Your character may finish the
few steps the server already accepted; that is not a stall, and there is no
instant stop in the protocol.

### Turning

`Q` and `E` turn while held, through the same limits a right-drag mouse
rotation obeys. **`Q` turns clockwise and `E` counter-clockwise.** These two are
not currently rebindable — the Controls dialog remaps the four movement
directions only.

**Indoor maps barely turn at all.** They clamp the camera to a narrow window —
`prt_in`, inside Prontera, allows about thirty-five degrees in total. A key
press there turns as far as the map permits and then stops. That is the map's
rule, not the mod's, and the mouse is equally limited.

### Attacking

`Space` attacks the nearest living monster, walking into range first if it is
out of reach — the same thing clicking the monster does.

It sends Ragnarok's *continuous* attack, so **the server keeps swinging until
the target falls.** There is no loop in the client. Holding space does not
re-issue the order; a fresh press picks the nearest target again, which is how
you move on after something dies.

Targeting uses the client's own nearest-entity search, which ignores corpses and
measures by walking distance rather than by line of sight, so it will not pick
something across a wall.

**This is a control, not an auto-hunter.** It never moves you anywhere you did
not aim, and never starts a fight on its own. If you want a bot, this is not it,
and deliberately so.

---

## Resolving the overlap

`W` `A` `S` `D` `Q` `E` are movement keys *and* shortcut slots. Only one can win,
and you choose which in **Controls → When battle shortcuts conflict**:

- **Movement takes priority** (default) — the mod keeps these keys. Skills on
  rows three and four will not fire from the keyboard; use rows one and two.
- **Battle shortcuts take priority** — a key you have bound to a shortcut goes
  to the shortcut instead, for movement, turning *and* attack alike. Keys with
  nothing bound still move you.

Battle-mode chat also matters: with the chat box in battle mode, letter keys
reach the game rather than the chat line.

## What always wins

No setting overrides these:

- **Chat and any text field.** Typing never walks you.
- **IME composition**, so composing in Korean or Japanese is safe.
- **Shortcut capture**, while the client is waiting for you to press a key to
  bind it.
- **An open NPC dialogue.** Space and enter belong to the conversation, and the
  server will not move a talking player.
- **Modal windows** — the escape menu, the world map, skill target selection,
  captcha prompts.
- **A hidden or unfocused page.** Held keys are released, and a fresh press is
  required afterwards, so alt-tabbing away never leaves you walking.

## When keys do nothing

| Symptom | Likely cause |
|---|---|
| Nothing moves at all | `wasd-movement` off in Settings → Mods, or movement off in Controls |
| Letters type instead of moving | chat has focus; press enter or click the game |
| Skills on `Q`/`W`/`E`/`A`/`S`/`D` never fire | movement has priority; switch it in Controls or use rows one and two |
| Camera barely turns | an indoor map, which clamps rotation; not a bug |
| Space talks instead of attacking | an NPC dialogue is open, which owns that key |
| Settings changes do nothing | Controls settings are per browser and per server; the app's own mod settings need **Apply** |
