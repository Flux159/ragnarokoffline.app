# Driving the game from the command line

`scripts/rotest` plays the game one command at a time. It runs a throwaway
world (its own server VM, database and save), opens the real client in a
browser, and gives you a command for each thing a player does: log in, run GM
commands, walk, attack, cast, look. Each command prints JSON, and screenshots
land in `artifacts/rotest/`.

It was written so an agent can reproduce and verify client and server bugs
without a person at the keyboard. It works just as well by hand.

The client patch behind it, `patches/client/AgentHook.mjs`, does nothing
unless the page opts in. Shipped builds carry it switched off.

## Setting up a world

Quit the packaged app first and wait for it to leave the Dock. The ports are
fixed, so only one world can run at a time.

Build what the world copies in. The client has to be the **full** build:
`api.html`, which the landing page opens, is only written by `build:all`.

```sh
bash scripts/vendor-fetch.sh roBrowserLegacy vendor/roBrowserLegacy
bash scripts/vendor-fetch.sh ROenglishRE vendor/ROenglishRE
bash scripts/patch-client.sh
npm ci --prefix vendor/roBrowserLegacy
npm --prefix vendor/roBrowserLegacy run build:all
bash scripts/patch-bundle.sh vendor/roBrowserLegacy/dist/Web
cargo build --manifest-path stack/Cargo.toml
bash scripts/build-remoteclient.sh
gh release download images --pattern "images-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/').tar.gz" --dir dist \
  && mv dist/images-*.tar.gz dist/images.tar.gz   # the server images CI last published
npm ci && npx playwright install chromium
```

Then create and boot the world. It defaults to `artifacts/agent-world`, and
takes the VM runtime and your GRF selection from the installed app's data
folder (override with `RO_E2E_RUNTIME` and `RO_E2E_CLIENT_JSON`):

```sh
scripts/rotest world prepare   # once; refuses an existing folder
scripts/rotest world up        # boots the VM and the servers (a few minutes the first time)
scripts/rotest start           # asset server + browser; add --headed to watch
```

`world up` makes sure the world has two accounts:

| Account | What it is for |
|---|---|
| `tester` / `tester123` | **Use this one.** In the GM group, so `@commands` work, but not on the client's admin list, so the client draws it as its class. Screenshots of jobs, outfits and skill effects come from here. `login` uses it by default. |
| `ragnarok` / `ragnarok` | The built-in GM account every install has. It is on the client's `adminList` (`config/Config.local.js`), so the client draws it with the GM "operator" sprite whatever its job. Use it only to see what a player on the default account sees. |

`rotest world tester` adds `tester` to a world made before `up` did this.
`tester` is still a GM on the server, so for a bug where GM permissions might
matter, check on a group-0 account as well.

```sh
scripts/rotest login tester tester123
scripts/rotest create 0 Tester    # first time only
scripts/rotest char 0
```

## Commands

| Command | What it does |
|---|---|
| `login [user] [pass]` | the real login form; waits for character select |
| `create <slot> <name>` | the real creation window |
| `char <slot>` | enters the game; returns once the map is loaded and the camera is set |
| `gm <text>` | types into the chat box and sends it; waits out a warp |
| `say <text>` | the same, without the warp wait |
| `state [radius]` | the player, nearby entities (with their click points), chat, mouse, new errors |
| `skills [filter]` | the character's skills: id, name, level, SP, range, target type |
| `shot [name]` | a screenshot; prints the file path |
| `walk <x> <y>` | clicks the map cell, waits for the walk to finish |
| `attack [gid\|nearest]` | clicks the monster where the client picks it |
| `skill <id> [lv] [--target <gid\|nearest>] [--cell <x> <y>] [--burst N]` | starts the cast the way the skill window does, then clicks the target; `--burst` takes N frames 150 ms apart, cropped to the player, from the moment of the cast |
| `equip <itemId>` | equips an item already in the inventory (`gm "@item <id>"` first) |
| `hover <x> <y> [--px]` | puts the cursor on a cell (or pixels) and reports what the client sees there |
| `click <x> <y> [right]`, `key <key>` | raw input |
| `eval <js>` | runs JavaScript in the page and prints the result; `window.roAgent` is there |
| `errors` | every page error, console error and failed request since `start` |
| `server <args>` | the world's `ragnarok-stack`: `server logs map 200`, `server sql "SELECT ..."` |
| `stop` | closes the browser and the asset server |
| `world down` | stops the VM; the world folder, its save and backups stay |

Every command that acts also returns the page errors it caused, so a client
exception shows up next to the step that triggered it.

## A session

```sh
scripts/rotest gm "@warp prontera 150 180"
scripts/rotest gm "@baselvl 199"; scripts/rotest gm "@joblvl 49"
scripts/rotest gm "@jobchange 4252"          # Dragon Knight
scripts/rotest gm "@allskill"
scripts/rotest skills servant
scripts/rotest gm "@item 1163"; scripts/rotest equip 1163    # a two-handed sword
scripts/rotest gm "@monster poring 1"
scripts/rotest skill 5208 10 --target nearest               # Hack and Slasher
scripts/rotest shot after-hack
```

`@warp` to a map before testing anything map-specific. `@monster <name|id>
<count>` puts targets next to you. `@item`, `@baselvl`, `@joblvl`,
`@jobchange`, `@allskill`, `@heal` and `@speed` cover most set-up.

## Sweeping a job's skills

`scripts/rotest-skill-sweep.cjs` casts every 3rd/4th-job skill of the jobs you
name, one JSON line per skill. Before each cast it gives the character what
rAthena's `skill_db` requires (a weapon of the right type, ammo, a shield, a
mount, a cart), so a refusal is the game's rule and not a missing weapon. Each
cast gets a tiled sheet of burst frames, so the effect can be checked by eye.
It records the server's chat lines, SP spent, whether the target took damage,
client errors and warnings, and files the asset server could not find.

```sh
python3 scripts/rotest-skill-reqs.py vendor/rathena > artifacts/sweep/skill-reqs.json
node scripts/rotest-skill-sweep.cjs artifacts/sweep/skill-reqs.json 4252 4253 > sweep.jsonl
```

Do it on a field map (`@warp prt_fild08 170 360`); towns forbid some skills.

- `SWEEP_SKILLS=5201,5208` limits it to those ids; `SWEEP_MIN_ID=0` includes
  skills below 2000 (with a `REQS_MIN_ID=0` requirements file).
- `SWEEP_BURST=16 SWEEP_EVERY=250` takes four seconds of frames, for long casts.
- Each line carries `effects`: the effect ids the client started (from
  `roAgent.effects(since)`), with `(not in EffectTable)` on any it could not
  find, and `unhandled`: packets received that the client has no handler for.
- 4th-job skills cost AP, which `@heal` does not restore:
  `rotest server sql --write "UPDATE \`char\` SET ap=max_ap WHERE name='Tester'"`
  while logged out.

## How it works, and what to watch for

- **Never press Escape to cancel something.** Escape opens Game Options, whose
  first button is Character Select, and the next Enter logs the character
  out. `skill` cancels a pending target with a right-click, and `gm`/`say`
  refuse while a menu or dialog is open rather than pressing Enter into it.

- **Clicks are real input.** `walk` projects the cell to the screen and
  clicks it. `attack` and `skill --target` click the middle of the box the
  client itself tests for picking (`EntityManager.intersect`). If the client
  would not pick a monster there, `pickedByClient` comes back `false`. That is
  a finding, not a harness fault.
- **Windows in the way.** A click on a window never reaches the map. `walk`
  and `hover` name the window covering the point instead of clicking it.
- **GM accounts look like GMs.** The client draws any account on its admin
  list with the GM "operator" sprite, whatever the job, as the official client
  does. To check how a job *looks*, use a non-GM account.
- **What the client sent is not what the server did.** Read the chat lines
  each command returns ("The skill cannot be used with this weapon.") and the
  server's own log (`rotest server logs map 200`) before blaming either side.
- **Missing files** are logged by the asset server in the world's
  `state/assets/logs/missing-files.log`. A 404 there names the file.
- **Headless WebGL works**, through ANGLE. `start --headed` shows the window.

## The in-page hook

`window.roAgent` exists only when `localStorage.roAgent` is `'1'`, which the
harness sets before the page loads:

- `player()` and `entities({ type, radius })`: positions, HP, and `click`,
  the screen point a click selects the entity at.
- `project(x, y)`: a map cell in page pixels.
- `skills()`, `useSkill(id, level)`, `chat(n)`, `mouse()`.
- `net(since)`: packets sent and received since a timestamp, with
  `(no handler)` on any the client received and ignored. This is how to tell
  "the client never sent the cast" from "the server refused it" from "the
  server answered and the client did nothing". A refused skill arrives as
  `ZC_ACK_TOUSESKILL`, whose `cause` is rAthena's `useskill_fail_cause`
  (`src/map/clif.hpp`; 9 is overweight, which a long sweep's `@item` stacks
  will reach -- `gm "@itemreset"` clears them).
- `modules`: `Session`, `EntityManager`, `DB`, `Network`, `PACKET`,
  `UIManager` and others, for `rotest eval`.

`roClientDiagnostics` is separate and stays read-only; mods and the e2e suite
use it.
