# quest-npc

An NPC in Prontera with a menu, a branch, a character variable that survives a
relog, and a reward given exactly once. That is a quest in everything but the
quest log, and it exercises the part of rAthena most people actually want.

Talk to **Herbalist Yuna** at `prontera 150 193` — a few steps south of the
fountain.

## What to look at first

`npc/herbalist.txt`, and specifically the variable named `ro_herbs`.

rAthena's variable scope is spelled in the prefix, and getting it wrong is the
single most common way a quest half-works:

| written | lives until |
|---|---|
| `.@name` | the end of this script run |
| `@name` | the character logs out |
| `name` | forever, on that character, in the database |
| `$name` | forever, on the server, shared by everyone |

`ro_herbs` has no prefix, so it is a permanent character variable, stored in
the `char_reg_num` table. **Verify that yourself**: take the quest, log out to
character select, log back in, and talk to her again. She should remember.

That test matters more here than it looks. Each era keeps its characters in its
own database volume — renewal and pre-renewal are separate saves — so a quest
variable is per-character *and* per-era, and a quest you finished in renewal
has not been started in pre-renewal.

## The `ro_` prefix

There is no namespacing in rAthena's variables. A mod that calls its variable
`progress` will collide with the next mod that does, on the same character,
silently. Prefix everything.

## Tabs

The fields in the NPC header line are separated by **tab characters**, not
spaces. An editor that expands tabs produces a line rAthena reports as a
parse error naming the file and the line — which is at least loud. Inside the
script body, indentation is free.

## Applying it

`npc/` is read when the **server** starts. Restart the server from Settings;
the app does not need restarting.

Check the map server log: a script rAthena cannot parse is named with its file
and its offending line. A script that parsed adds to the NPC count printed at
the end of startup.
