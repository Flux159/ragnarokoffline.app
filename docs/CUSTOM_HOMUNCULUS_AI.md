# Custom homunculus AI

A homunculus or mercenary runs a Lua script that decides what it attacks, when it
casts and when it follows you. The client ships a basic one. Players have written
far better ones, and the best known is
**[AzzyAI](https://github.com/SpenceKonde/AzzyAI)**.

The game client in the app runs these scripts itself, so AzzyAI works without a
mod and without changing anything in the app. You copy its files into your own
client folder and switch it on in game.

---

## Where the files go

Use the client folder you chose when you set up the app: the one holding
`data.grf` (or its `dll_exe/` folder, if your client nests everything there).
The AI lives in the `AI` folder beside `data.grf`:

```
your client folder/
├── data.grf
├── BGM/
├── System/
└── AI/
    ├── AI.lua, AI_M.lua, Const.lua, Util.lua    the client's default AI
    └── USER_AI/                                 the custom AI goes here
```

The app finds `AI/` next to `data.grf` on its own. There is nothing to select in
Settings.

## Installing AzzyAI

1. **Download it.** From [the AzzyAI repository](https://github.com/SpenceKonde/AzzyAI)
   choose **Code → Download ZIP** and unzip it. You only need its `USER_AI`
   folder.
2. **Copy the contents of AzzyAI's `USER_AI` into your client's
   `AI/USER_AI/`**, replacing files when asked.
3. **Keep `Util.lua` and `Const.lua` in `AI/USER_AI/`.** The client loads both
   before AzzyAI's own files, and AzzyAI does not ship either. See the warning
   below.
4. **Quit and reopen the app.** Your AI files are picked up when the server
   starts.
5. **Summon your homunculus and type `/hoai`** in chat. The client announces
   that custom AI is on. For a mercenary, type `/merai`.

`/hoai` and `/merai` are switches: type the command again to go back to the
default AI. They are off each time the game loads, so type them again after you
restart.

### Do not let `Util.lua` and `Const.lua` be deleted

If either file is missing from `AI/USER_AI/`, the client cannot load a custom AI,
and it turns off **all** homunculus and mercenary AI, the default included. Your
homunculus stands still and no error appears in game.

How you copy decides whether they survive:

- **Windows Explorer** merges folders, so copying AzzyAI's `USER_AI` folder onto
  yours keeps both files.
- **macOS Finder** offers to *Replace* when you drag a folder onto one with the
  same name, and Replace deletes everything already inside it. Hold **Option**
  while dragging and choose **Merge**, or copy the files rather than the folder.

If they are already gone, copy `Util.lua` and `Const.lua` from `AI/` into
`AI/USER_AI/`. The default copies are the ones you want.

## Configuring AzzyAI

AzzyAI's settings are ordinary Lua files in `AI/USER_AI/`, and its bundled
`Documentation.pdf` explains each option:

| File | What it sets |
|---|---|
| `H_Config.lua`, `H_Tactics.lua` | homunculus behaviour, and how it treats each monster |
| `M_Config.lua`, `M_Tactics.lua` | the same for a mercenary |

Edit them in any text editor, then quit and reopen the app.

AzzyAI also comes with `AzzyAIConfig.exe`, a settings editor. It is a Windows
program. On a Mac or Linux machine, edit the files by hand, or use the editor on a
Windows PC and copy the files it saves.

## What works differently from the Windows client

The script runs inside the game window rather than on your disk, and that
changes a few things:

- **Nothing AzzyAI writes is kept.** On Windows it saves files as it runs: your
  friends list, skill timers, its log and its startup check (`AAIStartH.txt`).
  Here those exist only while the game is open, and none of them appear in your
  client folder. Anything you want to keep belongs in the config files above.
- **Leave `UseAvoid` off.** It is `0` unless you change it. When it is on and a
  monster you asked it to avoid appears, AzzyAI quits the Lua script, which here
  stops the AI until you restart.

## App updates leave your AI alone

The app reads your client folder and never writes to it. Updating the app,
enabling or disabling mods, and even
[starting over](ADVANCED_FEATURES.md#starting-over) all leave `AI/USER_AI/` as
you left it. To remove AzzyAI, delete its files from `AI/USER_AI/`, or just stop
typing `/hoai`.

## When the homunculus does nothing

| Symptom | Likely cause |
|---|---|
| Stands still with custom *and* default AI | `Util.lua` or `Const.lua` missing from `AI/USER_AI/` |
| Behaves exactly as before | `/hoai` not typed since the game loaded, or `USER_AI` is not inside the `AI` folder beside `data.grf` |
| Config changes have no effect | the app has not been restarted since you edited the files |
| Worked, then stopped mid-fight | `UseAvoid` is on, see above |

AzzyAI's author no longer maintains it. Problems in its behaviour are for its
[issue tracker](https://github.com/SpenceKonde/AzzyAI/issues), and problems
loading it in the app are for ours.
