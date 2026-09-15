# Modding Ragnarok Offline: getting started

You don't need to compile anything, install Docker, or repack a GRF. **A mod is
a folder.** Put it in the mods folder, switch it on, and the game picks it up.

This page gets you from nothing to a working mod in about ten minutes. When you
want the details, the full reference is
[MODDING.md](../../MODDING.md).

---

## What you can change

A mod contains only the folders it needs. Here are the common ones:

| Folder | What it changes | Written in |
|---|---|---|
| `npc/` | NPCs, quests, shops, warps, monster spawns, **custom commands** | rAthena script (`.txt`) |
| `db/` | numbers: monster HP, drops, item stats, EXP tables | YAML |
| `data/` | what things look like: sprites, textures, loading screens, maps | the game's own files |
| `System/` | item names and descriptions in the client | Lua |
| `client/` | the game window itself: UI tweaks, styling | JavaScript |

If you've never modded RO before, **start with `npc/`**. It's the quickest to
get working, and you'll see the result as soon as you log in.

---

## 1. Find the mods folder

Open **Settings → Mods → Open mods folder**. Or go there yourself:

| | |
|---|---|
| macOS | `~/Library/Application Support/Ragnarok Offline/state/mods` |
| Windows | `%APPDATA%\Ragnarok Offline\state\mods` |
| Linux | `~/.local/share/Ragnarok Offline/state/mods` |

## 2. Make your first mod

Create this inside the mods folder:

```
hello-mod/
├── mod.json
└── npc/
    └── hello.txt
```

**`hello-mod/mod.json`** holds the name and description that Settings shows:

```json
{
  "name": "hello-mod",
  "version": "1.0.0",
  "author": "you",
  "description": "My first mod: a friendly NPC in Prontera."
}
```

**`hello-mod/npc/hello.txt`** is the NPC:

```
prontera,155,185,4	script	Hello#hellomod	4_F_KAFRA1,{
	mes "[Hello]";
	mes "If you can read this, your mod works!";
	close;
}
```

> ⚠️ **The gaps in the first line must be TABs, not spaces.** This catches
> everyone at least once. If you copied the line from a web page, your editor
> may have turned the tabs into spaces, and then the NPC doesn't appear and
> nothing tells you why. Retype those three gaps with the Tab key.

What the first line means:

```
prontera,155,185,4   script   Hello#hellomod   4_F_KAFRA1,{
└─ map ─┘└ x,y ─┘└ facing     └ name ┘└ hidden   └ sprite
```

The part after `#` in the name isn't shown in game. It keeps your NPC's name
unique, so it can't clash with an NPC from another mod.

## 3. Switch it on

1. Open **Settings → Mods**. `hello-mod` should be in the list, already ticked.
2. Click **Apply**. This restarts the server.
3. Log in and walk to Prontera, just north of the fountain. The default
   `ragnarok` account is a GM, so you can also type `@warp prontera 155 185`.
4. Click the NPC.

That's a mod. You can zip the `hello-mod` folder and send it to someone, and it
will work for them too.

## 4. It didn't work?

Go through these in order:

1. **Is it in Settings → Mods at all?** If it says *Not loaded*, the reason is
   written next to it.
2. **Did you click Apply?** Changes to `npc/`, `db/` and `conf/` take effect
   when the server restarts.
3. **Tabs.** See the warning above. This is the cause most of the time.
4. **Read the server log.** The app includes a tool that prints it:

   ```sh
   # macOS
   ~/Library/Application\ Support/Ragnarok\ Offline/runtime/bin/ragnarok-stack logs map 100
   ```

   On Windows it is `%APPDATA%\Ragnarok Offline\runtime\bin\ragnarok-stack.exe`.
   rAthena prints a script error with the file name and line number.
5. **Changed art or client files?** `data/`, `System/` and `client/` need the
   **whole app restarted**, not only the server.

---

## Where to go next

The fastest way to learn is to **copy an example that's close to what you want
and change it.** Each one has a README explaining how it works:
[examples/mods](../../../examples/mods)

| I want to… | Start from |
|---|---|
| write a quest | `quest-npc`: a menu, a saved variable, a reward |
| add a new item | `custom-item`: stats, a name, and an NPC that hands it out |
| make monsters harder | `tougher-monsters`: changing stats and drops |
| make my own map | `custom-map`, then `island-ferry` for a way to get there |
| change the login or loading screen | `login-screen`, `loading-screens` |
| let normal players use `@autoloot` etc. | the bundled `player-commands` mod |
| add a chat command like `@give` | the [`@give` tutorial](giveguide.md) |

**Learning the script language:** rAthena's
[script_commands.txt](https://github.com/rathena/rathena/blob/master/doc/script_commands.txt)
lists every command, with examples. It's long, so search it for what you need
(`getitem`, `select`, `warp`…) rather than reading it from the top.

**Stuck?** Ask in the [Discord](https://discord.gg/jUYC9dMbu5).

---

## Five things worth knowing early

- **Mods are applied in alphabetical order.** If two mods change the same
  thing, the one later in the alphabet wins, and Settings tells you when that
  happens.
- **Give your variables a prefix.** A script variable called `progress` is
  shared with every other mod that also uses `progress`. Call yours
  `hellomod_progress` instead.
- **If an NPC doesn't show, check the sprite name.** A wrong sprite name
  doesn't cause an error. The NPC still loads, but it's invisible. Copy sprite
  names from an example.
- **Test on a spare character.** Mods can change what is saved on your
  characters.
- **Mods are code.** A mod you download can run scripts on your server and
  JavaScript in your game window. Only install mods from people you trust.
