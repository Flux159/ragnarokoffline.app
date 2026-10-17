# custom-achievement

Two achievements that exist in no client, in the game's own achievement window
(**Alt+K**):

- **Poring Patrol**, which the server counts by itself: defeat ten Porings. The
  fields just south of Prontera are full of them.
- **Old News**, which nothing in rAthena counts, so an NPC completes it: read
  the **Old Notice Board** at `prontera 146 187`.

Like a custom item, an achievement needs three layers: `db/` for what completes
it and what it gives, `System/` for what the window says about it, and `npc/`
for whatever the server does not count by itself.

Not yet run in game. The app's and the client's halves of loading the table
are tested on their own.

## What to look at first

**`System/achievement_list.lub` has two entries, not 360.**

The client's achievement table names every achievement in the game. A mod that
had to replace it to add one would take every other achievement's text with it,
and before app 1.6.4 that is what happened. Now the app copies a mod's table
aside as `achievement_list-<mod>.lub` and lists it in the client's
`customAchievementInfo`, which loads it after the stock table:

```js
customAchievementInfo: ['System/achievement_list-custom-achievement.lub'],
```

That list is generated for you, in mod order; a later mod's entry for the same
id wins.

**The two halves are joined by the id.** `900001` in `db/achievement_db.yml`
and `[900001]` in the `.lub` are the same achievement. One that is only in
`db/` completes and counts towards the rank, but it is never listed and its
reward can never be claimed. One that is only in the `.lub` is listed and never
completes.

**The reward button comes from the `.lub`.** Poring Patrol's
`reward = { item = 501 }` is what makes the window offer the button. The five
Red Potions themselves come from `Rewards:` in `db/`, and arrive by mail when
the button is pressed. Old News gives nothing, so its `reward` is empty.

**`major` and `minor` are the tab.** Poring Patrol is under Battle → Training,
Old News under Adventure → Rune Midgarts. The tabs are the client's own and a
mod cannot add one.

## Choosing an id

900001 and 900002. Stock achievements run from 110000 to 240020, so mods use
900000 and up, a block of a thousand each; this example has 900000–900999.
Pick another block for your own.

## Checking it worked

Server side, in the map server log:

```
Loading '2' entries in 'db/import/achievement_db.yml'
```

Client side: open the achievement window. Poring Patrol should be under Battle
→ Training and Old News under Adventure → Rune Midgarts, with every stock
achievement still there. If yours are missing, check that
`customAchievementInfo` in `Config.local.js` names the table.

Then read the board: the banner says "< Old News > achieved." Defeat ten
Porings for the other, press the reward button, and the potions are in your
mail.

## Applying it

Both halves. `db/` and `npc/` need the **server** restarted; `System/` is linked
when the **app** starts.

[Custom achievements](../../../docs/mods/CUSTOM_ACHIEVEMENTS.md) is the full
guide: the groups the server counts by itself, completing one from a script,
titles, and the traps between the files.
