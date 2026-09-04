# tougher-monsters

Two independent ways to change what you fight, in one mod, because they fail
differently and it is worth seeing both.

## `db/mob_db.yml` — changing what a monster *is*

Poring gets more HP, hits harder, gives more experience and drops a Red Potion
sometimes. Every Poring on every map, including ones spawned by scripts that
were written years before this mod existed.

Only the fields named in the file are changed. The sprite, the AI, the size and
the element are untouched, because `db/import` layers over rAthena's own table
rather than replacing it.

**`Drops:` is the exception, and it is the one that bites.** A drop entry
without an `Index:` is *appended* to the monster's existing list, not swapped
for it. Poring already has most of its ten slots filled, so appending three
overflows the cap and rAthena reports:

```
[Error]: Maximum of 10 monster Drops met, skipping.
[Error]: Occurred in file 'db/import/mob_db.yml' on line 34 and column 8.
```

With an `Index:`, the entry overwrites that slot instead
(`MobDatabase::parseDropNode`, `src/map/mob.cpp`). This mod uses indices 0 and
1 — Poring's Jellopy and its rare knife — which is why it changes two drops
rather than adding two.

**Check it loaded** in the map server log:

```
Loading '1' entries in 'db/import/mob_db.yml'
```

If instead you see a warning about the database version being outdated, the
`Version:` in the header does not match the build. Copy the number out of
`vendor/rathena/db/import-tmpl/mob_db.yml`.

## `npc/spawns.txt` — changing which monsters are *where*

Forty Porings, twenty Lunatics and twenty Fabres on Prontera South Field, plus
five Poporings that have no business being there.

**Check it loaded**: the NPC total at the end of startup goes up. A spawn line
that rAthena cannot parse is reported by file and line, so a script error is
loud — but a *tab* that is really spaces is not: the fields in a spawn line are
separated by tab characters, and an editor that expands them produces a line
rAthena skips.

## What this mod cannot do

Remove the map's own spawns. Those come from the stock scripts in
`npc/pre-re/mobs/fields/`, they are loaded before anything here, and a mod has
no way to unload a script it did not add. Adding is the whole vocabulary.

If you want a map with exactly the monsters you chose, make a map — see
[custom-map](../custom-map).

## Applying it

`db/` and `npc/` are read when the **server** starts, so restarting the server
from Settings is enough. No app restart, no rebuild.
