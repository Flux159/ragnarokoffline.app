# Server NPCs for navigation

The navigation window's NPC search normally reads the table in your own
client, which lists kRO's NPCs at kRO's positions. This server runs rAthena's
scripts instead, so that table can name NPCs that are not here, put some in
the wrong place, and never lists the ones a mod adds.

With this mod on, the NPC table is built from the scripts the server loads:
the stock ones for the era you are playing, the stock scripts other mods switch
on (`stock-npc.txt`) less the ones they take out (`stock-npc-remove.txt`), and
the scripts other mods ship. Search then finds what
is in the world, at the server's coordinates, under the name over its head.

It replaces the client's NPC table rather than adding to it, so NPCs only kRO
has stop appearing in search. Monsters, maps and the routes between them still
come from your client.

What it cannot see: an NPC a script hides or moves while it runs
(`disablenpc`, `movenpc`) is listed where its script first puts it.

`npc-index.tsv` lists the NPCs in the pinned rAthena's scripts, which live in
the server image rather than on your machine. It is generated from the pin with
the app's server mods applied, and regenerated whenever the rAthena pin moves
(CI fails until it is):

```
scripts/navigation-index.sh
```
