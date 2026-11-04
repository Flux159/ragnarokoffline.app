# Server monsters for navigation

The navigation window's monster search normally reads the table in your own
client: kRO's spawns, with kRO's levels and elements. This server spawns what
rAthena's scripts say, with the stats in rAthena's monster database, and mods
add monsters, move them and change what they are.

With this mod on, the monster table is built from those instead:

- **where and how many:** the `monster` and `boss_monster` lines in the scripts
  the server loads for your era, the stock scripts other mods switch on
  (`stock-npc.txt`) less the ones they take out (`stock-npc-remove.txt`), and
  the scripts other mods ship;
- **what each one is:** name, level, element, race, size and whether it is an
  MVP, from rAthena's `mob_db` with every mod's `db/mob_db.yml` merged over it
  field by field, as the server merges them. A custom monster, or the
  randomizer's reshuffle, shows as it is in game.

It replaces the client's monster table rather than adding to it, so monsters
only kRO spawns stop appearing in search. The frequency column counts every
spawn line on the map, boxed areas included. NPCs, maps and routes still come
from your client -- or turn on `navigation-server-npcs` for NPCs too.

`mob-index.tsv` lists the pinned rAthena's spawn lines and monster database,
which live in the server image rather than on your machine. It is generated
from the pin with the app's server mods applied, and regenerated whenever the
rAthena pin moves (CI fails until it is):

```
scripts/navigation-index.sh
```
