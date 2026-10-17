# Custom achievements

An achievement in the game's own achievement window (**Alt+K**): it has a
tab, a title and a goal list there, the server counts the player's progress
and keeps it on the character, completing it shows a banner and adds its score
to the player's achievement rank, and its reward is claimed from the window.
All of it comes from a mod folder, with no server rebuild. This page covers
what such an achievement is made of and the traps between the files involved.
[Making mods](../MODDING.md) is the reference for the rest of the mod format.

An achievement needs **app 1.6.4 or later**: an older app replaces the
client's whole achievement table with the mod's, and every stock achievement
loses its text. Say so in `mod.json`:

```json
"requires": { "app": ">=1.6.4" }
```

## What goes in the mod

```
my-achievements/
  mod.json
  db/
    achievement_db.yml          the achievement: its id, what completes it, its reward and score
  System/
    achievement_list.lub        what the achievement window says about it
  npc/
    my-achievements.txt         scripts for whatever rAthena does not count by itself
```

Each file has a job the others cannot do:

| | read by | decides |
|---|---|---|
| `db/achievement_db.yml` | the map server, at start | that the achievement **exists**, what completes it, the reward the player gets and the score |
| `System/achievement_list.lub` | the game client, at load | the tab, title, texts, goals and *displayed* reward in the achievement window — nothing else |
| `npc/*.txt` | the map server | completing an achievement the server has no trigger for |

They are joined by one number, the **achievement id**. It must be the same in
all of them.

[`examples/mods/custom-achievement`](../../examples/mods/custom-achievement)
is this page's two achievements as a mod you can install and copy.

## A hunting achievement, end to end

Kill ten Porings, collect five Red Potions. Achievement id `900001` (see
[Achievement ids](#achievement-ids) for why).

### db/achievement_db.yml

```yaml
Header:
  Type: ACHIEVEMENT_DB
  Version: 2

Body:
  - Id: 900001
    Group: Battle
    Name: Poring Patrol
    Targets:
      - Id: 0
        Mob: PORING
        Count: 10
    Rewards:
      Item: Red_Potion
      Amount: 5
    Score: 10
```

`Mob` is the monster's **AegisName**. A monster your mod adds in its own
`db/mob_db.yml` works too: monsters are loaded before achievements. Only the
character who gets the kill counts it, not their party.

### System/achievement_list.lub

```lua
achievement_tbl = {
	[900001] = {
		UI_Type = 0,
		group = "BATTLE",
		major = 3,
		minor = 1,
		title = "Poring Patrol",
		content = {
			summary = "Teach the Porings some manners.",
			details = "Defeat 10 Porings anywhere in the world."
		},
		resource = { [1] = { text = "Defeat 10 Porings" } },
		reward = { item = 501 },
		score = 10
	},
}
```

Only your own achievements go in this file. The app keeps it aside as
`achievement_list-<mod>.lub` and has the client load it after the stock
table, so every other achievement keeps its text. `major` and `minor` put it
under **Battle → Training** ([the tabs](#the-achievement-window)).

### Applying it

`db/` is read when the **server** starts and `System/` when the **client**
loads. Switch the mod on in **Settings → Mods**, restart the server, and reload
the game window.

What the player then sees: *Poring Patrol* under Battle → Training, with its
goal and the Red Potion as its reward. After the tenth Poring, the banner
"< Poring Patrol > achieved.", the score added to the rank, and a reward button
in the achievement window. Pressing it sends the potions to the player's mail.

## achievement_db.yml

rAthena's own format, unchanged; the stock tables are in
`vendor/rathena/db/re/achievement_db.yml` and `…/pre-re/achievement_db.yml`.
A mod's file is added to `db/import/achievement_db.yml` like any other table
([db/](../MODDING.md#db--changing-the-worlds-numbers)), so the header is
`Type: ACHIEVEMENT_DB`, `Version: 2`.

| Field | |
|---|---|
| `Id` | the achievement id. Required. |
| `Name` | required for a new achievement. The server's own name for it, used in its log and in the reward mail; the player sees the `.lub` title instead. |
| `Group` | what counts towards it. See below. Default `None`. |
| `Targets` | up to ten counters (`Id` 0–9), each with a `Count` and, for `Battle` and `Taming`, a `Mob`. |
| `Condition` | for the `Goal_…` groups, a script expression that completes it when true, such as `" BaseLevel >= 99 "`. |
| `Dependents` | achievements that must be completed first, as `<id>: true`. |
| `Rewards` | `Item` (an AegisName) and `Amount`, a bonus `Script`, a `TitleId`. |
| `Score` | the points it adds to the player's achievement rank. |

The groups rAthena counts by itself include `Battle` (killing a `Mob` target),
`Taming` (taming one), `Goal_Level` and `Goal_Status` (a `Condition` on level
or stats, checked as they change) and `Goal_Achieve` (a `Condition` on
`AchievementLevel`). The stock tables show each of them in use.

**Anything else is `Group: None`, the default, and a script.**
`achievementcomplete` completes an achievement for the attached player,
whatever its targets say:

```yaml
  - Id: 900002
    Name: Old News
    Score: 5
```

```
prontera,146,187,4	script	Old Notice Board#myach	2_BULLETIN_BOARD,{
	mes "[Old Notice Board]";
	mes "The ink has faded. Nobody has read this in years.";
	if (!achievementexists(900002))
		achievementcomplete 900002;
	close;
}
```

It still needs its entry in the `.lub` to be listed. The fields of the header
line are separated by **tabs**, as in every NPC script.

`achievementupdate <id>, ACHIEVEINFO_COUNT1, <n>;` keeps a counter on the
character and `achievementinfo` reads it back, but neither completes the
achievement, and this client's window does not show counters: compare it
yourself and call `achievementcomplete`.
[rAthena's script reference](https://github.com/Flux159/rathena/blob/ragnarokoffline/doc/script_commands.txt)
lists all of them.

An achievement with **only** `Dependents` (no targets, no condition) completes
by itself once they are all done — but only in the groups `Battle`, `Taming`
and `Adventure`.

## The achievement window

The client's table is what the window shows. An achievement the server knows
and the table does not is never listed, shows no banner when completed, and its
reward cannot be claimed — only its score still counts.

| Field | |
|---|---|
| `major` | the tab. |
| `minor` | the sub-tab under it. |
| `title` | the name in the list, the details and the banner. |
| `content.summary` | the line under the title in the list. |
| `content.details` | the text in the details. |
| `resource` | the goal lines in the details, `{ [1] = { text = "…" }, [2] = … }`. |
| `reward` | what the details show as the reward: `item` (an item id), `buff` (a skill id, for a `Script` reward) and `title` (a title id). |
| `score` | the points shown beside it. |
| `group` | the icon beside it: a stock group's name, as in the stock table (`BATTLE`, `ADVENTURE`, `GOAL_LEVEL`…). |
| `UI_Type` | not read; copy the `0`. |

**The tabs are the client's own**, and a mod cannot add one:

| `major` | Tab | `minor` |
|---|---|---|
| 1 | General | 0 Character, 1 Action, 2 Other |
| 2 | Adventure | 0 Rune Midgarts, 1 Schwartzvald, 2 Arunafeltz, 3 New World, 4 Localizing, 5 Dungeon |
| 3 | Battle | 0 Duel, 1 Training |
| 4 | Quest | 0 Episode, 1 General |
| 5 | Memorial | 0 Midgard, 1 New World, 2 Other |
| 6 | Feat | none; use 0 |

An entry with another `major` is in no tab at all, and one with another
`minor` is listed only under its tab's own heading, in no sub-tab.

## Achievement ids

The stock achievements run from **110000 to 240020** in both eras. **Use ids
from 900000 up**, a block per mod — `900000 + 1000 × n` — and write the block
in your mod's README so the next author can avoid it. If two enabled mods
define the same id, Settings → Mods says so under the one whose version is not
in effect. Never reuse an id for a different achievement: characters keep the
old one's progress.

## Titles

`TitleId` must be one of the client's titles, **1000 to 1046**. Any other
value makes the server drop the whole entry, with `Reward Title ID … does not
exist` in the map server log. A mod cannot add a title of its own.

## Pitfalls

- **The reward button needs `reward` in the `.lub`.** The window offers the
  button only when the entry's `reward` names something. With `reward = {}`
  the player can never claim what `achievement_db.yml` gives.
- **ASCII only** in the `.lub`. The client reads it in the game's codepage,
  never as UTF-8: an accented letter or a typographic quote comes out as
  garbage.
- **One table, named `achievement_tbl`, set by the file itself.** Each mod's
  file is run on its own and its `achievement_tbl` read; a file that adds to
  one it expects to be there (`achievement_tbl[900001] = …`) fails and adds
  nothing. Copy the example's first line.
- **The file goes directly in `System/`**, named `achievement_list.lub` (or
  `.lua`). The translation's name, `achievements.lub`, is not read.
- **A `.lub` entry replaces, not merges.** A mod that redefines a stock
  achievement to fix its text has to give the whole entry.
- **Era folders, not `db/re/`.** A mod's `db/re/achievement_db.yml` ends up at
  `db/import/re/achievement_db.yml`, which rAthena never reads, and nothing
  says so. An achievement for one era goes in the mod's
  [era folder](../MODDING.md#renewalfolder--prerenewalfolder--one-mod-for-both-eras)
  (`renewal/db/achievement_db.yml`), and that file **replaces** the mod's own
  `db/achievement_db.yml` for that era; it is not added to it.
- **Switching the mod off can delete players' progress.** With the mod off, its
  achievements are gone at the next server start; the server drops them from
  each character as it logs in (`Achievement 900001 not found in
  achievement_db` in the log), and the next save of that character's
  achievements deletes the rows.
- **The client caches files by name.** Switching a mod on or off clears that
  cache; editing the `.lub` inside an installed mod may not. If the old text
  persists, restart the app.
