# exp-card

Every monster kill has a small chance to drop an **Exp Card**, bound to the
killer for the standard pickup window. Two families — **Base Exp Cards** and
**Job Exp Cards** — each with ten levels. Higher-level monsters drop
higher-level cards. Using a card grants a fixed chunk of experience.

The point: streamline the offline experience without touching per-mob drop
tables. Any mob, any map, one uniform bonus channel that scales with the
content the player is fighting.

## The cards

Exp per card follows a roughly geometric curve (~2× per level), anchored so a
Lv 10 card is about 5% of a level-98 Renewal character's next-level bar and
each lower level is roughly the same 3–5% at the player level *that band of
mobs suits* — matching the shape of rAthena's own NextBaseExp curve.

| Level | Exp | Required base level | Item ids (base / job) |
|---|---|---|---|
| 1  | 100    | 1  | 50051 / 50061 |
| 2  | 250    | 11 | 50052 / 50062 |
| 3  | 500    | 21 | 50053 / 50063 |
| 4  | 1,000  | 31 | 50054 / 50064 |
| 5  | 2,000  | 41 | 50055 / 50065 |
| 6  | 4,000  | 51 | 50056 / 50066 |
| 7  | 7,500  | 61 | 50057 / 50067 |
| 8  | 15,000 | 71 | 50058 / 50068 |
| 9  | 30,000 | 81 | 50059 / 50069 |
| 10 | 60,000 | 91 | 50060 / 50070 |

Base cards grant only base exp; Job cards grant only job exp. The two are
symmetric — a Base Lv 10 gives 60,000 base exp, a Job Lv 10 gives 60,000
job exp.

**Level gate.** Each card has an `EquipLevelMin` matching its tier — a Lv 10
card needs base level 91 to use, a Lv 5 needs 41, and so on. rAthena's
`pc_isUseitem` refuses to consume the item below the threshold, so a
low-level character who happens to pick up a high-tier card just carries
it in the bag until they reach the level. Prevents a level 20 alt from
downing a Lv 10 base card for two-thirds of a level in one click.

If you want a different curve, edit the twenty scripts in `db/item_db.yml`
and update the `EXP_BY_LEVEL` table in `System/itemInfo.lua` to match (so
the tooltips still show the right numbers).

## How drops work

The `exp_card_ctrl` NPC hooks `OnNPCKillEvent`, rolls one dice against the
configured chance, and — on a hit — picks *which* card:

- **Level** comes from the dead mob's `MOB_LV`, clamped to `1..10`:
  ```
  card_level = clamp((mob_level + 9) / 10, 1, 10)
  ```
  So mob levels 1–10 give a Lv 1 card, 11–20 give Lv 2, …, 91+ gives Lv 10.
- **Family** is a coin flip — 50% Base Exp Card, 50% Job Exp Card.

The card lands at the killer's position and is bound to their `char_id`
via `makeitemowned`. Nobody else can pick it up during the standard
`item_first_get_time` window (see `battle.conf`); after that, it's free.

The mob's own drop table is untouched.

## Settings

**Settings → Mods → exp-card** exposes one number, read through
`F_ModSetting` on each server start (so **Apply** takes effect on the
next restart):

- **Drop chance** (`drop_chance`, default 225 = 2.25%) — in 0.01% units,
  matching rAthena's drop-rate convention. 1,000 is 10%, 10,000 is
  guaranteed.

  Sizing rule of thumb: at ~150 kills per hour and the 50/50 base/job
  split, `drop_chance` × 0.0006 is roughly the "% of a level per hour"
  bonus on whichever axis the player is currently pushing. At the default
  2.25% that is ~5–9% of a level per hour — meaningful without
  trivialising the grind. Bump to 500 for a more generous curve, drop to
  100 for background-noise pace.

Card exp values are hard-coded in `db/item_db.yml` (twenty scripts, one
per card). Change them there if you want a different curve.

The cards grant exp through `getexp`, which rAthena scales by
`quest_exp_rate` -- the **Quest EXP** rate in the app's server settings, not
the kill-exp rate. At 1x a Lv 10 card is exactly 60,000; at 2x it is
120,000.

## Requirements

- `requires.app` is **`>=1.3.9`** — the first release whose pinned
  rAthena ships the native `makeitemowned` script command the on-kill
  drop uses. On an older build the command does not exist and the
  on-kill event logs a one-line error per kill; nothing else on the
  mod is affected (the items still exist and can be granted with
  `@item Base_Exp_Card_1` and friends).

## Installing

**Settings → Mods → Browse**, find exp-card, install. An installed mod is on;
untick it under **Settings → Mods** to switch it off again.

Or copy this folder into your mods directory and restart the app:

    macOS    ~/Library/Application Support/Ragnarok Offline/state/mods/
    Windows  %APPDATA%\Ragnarok Offline\state\mods\
    Linux    ~/.local/share/Ragnarok Offline/state/mods/

## Checking it loaded

- The supervisor prints `mods: exp-card` on start.
- The map-server log's NPC count goes up by one (`exp_card_ctrl`). A
  parse error names the file and line.
- In game: `@item Base_Exp_Card_10` gives you one, and using it grants
  60,000 base exp; that isolates the item side from the on-kill roll.

## What to look at first

`npc/exp_card.txt` is the whole feature in one screen: an `OnInit` that
reads the chance from Settings, and an `OnNPCKillEvent` that rolls it,
picks a card level from `MOB_LV`, flips for family, and calls
`makeitemowned`. Everything else is item entries (`db/item_db.yml`,
twenty scripts) and their client-side names built with a small loop
(`System/itemInfo.lua`).
