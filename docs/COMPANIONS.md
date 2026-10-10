# AI companions

Population Engine characters can join a real party as AI companions.
They follow their recruiter between maps, fight and support the party, and obey
combat orders from the party leader. Four to eleven companions can be
recruited into one party; **Settings → Population → Party invitations** in
the app's settings sets how many your server allows.

The feature is available whenever **Settings → Population → Fake players** is
enabled. It does not alter characters or save data.

## Recruit a companion

1. Create a party and make sure you are its leader. (`/organize <partyname>`).
2. Whisper `party`, `pt`, `join`, or `invite` to a Population Engine character.
3. The character stops moving and answers. You have 60 seconds to right-click
   it and choose **Party Invitation**.
4. The character accepts automatically and becomes a companion.

The invitation window expires after 60 seconds, after which an unrecruited
character resumes its normal behaviour. If your companion limit is
reached, the character replies with the limit instead.

Companions follow the player who recruited them. They teleport nearby when
they fall outside the visible area or when their owner changes maps. When the
party stops, companions use separate formation cells around their owner rather
than standing on top of one another.

Removing a companion from the party releases it, but does not delete it: it goes back to your
saved list. A companion's name, job, level, equipment, duty and skill selection are stored, so they
survive a full server and app shutdown. Party membership does not survive - after a restart, open
the companion window's **Party** tab and press **Summon** to bring it back out.

Companions belong to the character that recruited them, not to the account. Each character of an
account has its own saved list. When a character logs out or goes back to character select, its
companions leave the world with it, and they come back when that character logs in again.

Companions saved by a build from before they were per character have no owning character yet.
The first character of that account to log in afterwards takes all of them. To move one to
another character, remove it from the first character's list and recruit it with the other.

## Loot

Monster drops earned by a recruited companion use its active same-map owner as
the loot owner. The owner's `@autoloot`, `@alootid`, and `@autoloottype`
settings therefore work for companion kills as well as the owner's own kills.

Recruited companions are not item-sharing recipients because their inventories
are not accessible to the player. Party item-sharing settings continue to
distribute loot normally between eligible real players. Ambient Population
Engine characters are never redirected and cannot generate loot for a player.

## Combat Modes

Only the current party leader can issue orders, and only messages sent through
party chat are interpreted. Commands are case-insensitive.

| Mode | Long command | Quick command | Behaviour |
|---|---|---|---|
| Attack | `attack` | `atk` | Independently attacks monsters within 12 cells of the owner. |
| Defensive | `defensive` | `def` | Attacks the owner's target and monsters threatening the party. This is the default. |
| Passive | `passive` | `pass` | Ignores monsters while continuing to follow, buff, heal, and resurrect. |

The long command may appear as a word in a sentence, for example `Everyone, attack now!`.
A quick command must be sent as a standalone party-chat message containing only the command word.
This prevents normal mentions of terms such as ATK or DEF from being interpreted as orders.
A message containing more than one combat mode is ignored.

Combat mode orders affect every companion in the party. The leader receives a
local confirmation with the selected mode and the number of affected shells.

## Combat Roles

Assign a role by writing the companion's exact name and one role in party chat.
The order of the words does not matter, and both names and roles are
case-insensitive:

```text
Mirarir attacker
Galashiel supp
Hanaban TK
```

| Role | Accepted words | Effect |
|---|---|---|
| Tank | `tank`, `tk` | Prioritises monsters threatening party members, intercepts nearby attackers, and does not use the normal low-HP or boss-avoidance behaviour. |
| Support | `support`, `supp` | Moves into range of injured allies and keeps ally-targeted healing and support skills in its rotation. |
| Attacker | `attacker`, `dd` | Concentrates on offensive actions and skips ally-targeted support skills. |

The named companion confirms a successful role change in party chat. Roles
shape the existing class skill list; they do not grant new skills. A Support
Assassin therefore does not become a healer, while a Priest can still use its
priest skills in any role. A shell without an assigned role keeps the role from
its Population Engine profile, or `None` when no profile role exists.

Combat modes and roles are independent: the mode decides *when* the group
engages, while each role decides *how* that companion behaves once involved.

## Roaming

By default a companion follows you. Set it to **Roam** and it walks the map on
its own instead, the way the AI players in the fields do: it picks a direction,
walks on, and covers the whole map. It stays in your party, its kills share
EXP with you as usual, and its drops go to you, so `@autoloot` picks them up
wherever it is. When you change maps it comes along, and goes on roaming there.

Roaming is off until **Settings → Population → Companion roaming** is ticked in
the app; it needs no mod. Off, every companion follows and nothing in game
mentions roaming. On, each companion is switched in the Companions window:
**Roaming** / **Following** on its row of the Party tab, or **Follow** / **Roam**
under *Movement* on the Battle tab for all of them. The choice is saved with
each companion, and a companion saved as roaming follows while the setting is
off. **Recall** on the Battle tab brings every companion back to you and has the
roaming ones follow again.

The stance still decides what a roaming companion fights, but around itself
rather than around you:

| Stance | A roaming companion |
|---|---|
| Free (`attack`) | Hunts any monster near itself. |
| Standard (`defensive`) | Fights what attacks it or a party member near it, and your target when it is close by. |
| Hold (`passive`) | Only walks. |

It rests between fights as a following companion does, and a monster that
merely walks past does not get it up; only one that attacks it or a party
member near it does.

## SP and resting

Companions pay the SP their skills cost, as players do, and regenerate it the
same way. Between fights, a companion low on SP or HP sits down to rest, which
recovers it twice as fast, and stands once both are back. It gets up at once
when it is needed: a monster to fight, a threat to the party, a hit on itself,
or its owner moving on. A companion that can heal also stays on its feet while
its owner is hurt.

When it rests is set on the Companions window's **Battle** tab, under
**Resting**, or with `@companion rest <below%> <until%>`: it sits below the
first percentage of its SP or HP and stands once both reach the second. Every
companion starts at 30% and 95%; 0 as the first means it never rests. Like the
healer thresholds, the choice applies to all of your companions and is saved
with each of them.

Other fake players rest the same way, at a fixed 30% and 95%.

## Its bag

By default a companion carries a free supply that never runs out: 10 HP and 5
SP potions of its level's kind (the table below), topped up after each full
rest, and whatever arrows and gemstones its skills ask for.

With **Settings → Population → Companion inventory** on, a companion owns what
is in its bag instead, and nothing refills it. It drinks the potions, fires the
arrows and pays the catalysts you give it, and when they run out it does
without:

- Trade it what it should carry. Equipment is put on, as before; everything
  else (potions, arrows, gemstones, traps) stays in its bag.
- It drinks a potion, at most one a second, while it is needed and below 40% HP
  or 20% SP; out of a fight it rests instead. It takes the potion a player of its
  level would buy (the table below) and, without one, the strongest other it
  carries: Condensed, White, Yellow, Orange and Red Potions and the herbs for HP,
  Blue Potion, Grape Juice and Blue Herb for SP.
- A skill that costs an item, such as a Blue Gemstone for Resurrection or
  Sanctuary, is cast only while the item is in its bag, and uses it up as it
  would for you.
- An archer or a gunslinger fires the ammunition it carries, any kind it can
  use, preferring an element that hurts its target; with none it stops
  attacking. A Ninja's shuriken and kunai, a Mechanic's cannonballs and a
  Genetic's throwing items come from its bag the same way.
- Its bag counts towards its weight, with rAthena's usual limits: above 50% (70%
  in renewal) it stops recovering on its own, and above 90% it can't attack.

The bag is saved with the companion and comes back with it. A companion saved
before the setting was on comes back once more with what it is spawned with, and
from then on that is its own. Turning the setting off again keeps the saved bag
for when it is back on. There is no window to look into the bag yet.

| Base level | HP | SP |
|---|---|---|
| 1-29 | Red Potion | Grape Juice |
| 30-54 | Orange Potion | Grape Juice |
| 55-79 | Yellow Potion | Blue Potion |
| 80 and up | White Potion | Blue Potion |

Other fake players, which are not companions, always carry the free supply.

## Death and resurrection

A defeated companion stays in the party as a corpse while its owner remains on
the same map. It can be revived in either of two ways:

- Priest class companions automatically cast level 3 Resurrection on dead party
  members, including real players and other companions. With Companion
  inventory on, only while they carry a Blue Gemstone.
- Minstrel, Wanderer, Troubadour and Trouvere companions revive dead party
  members with Death Valley, at the level they have learned.
- A real player can use a Yggdrasil Leaf on the dead companion.

Level 3 Resurrection restores 50% HP. Resurrection remains available in every
combat mode and role because recovery is treated as a class capability rather
than an offensive action.

When a companion dies it says so in party chat, with where it fell, for
example `Rover : I'm down! (prt_fild08 240, 362)`, and its row in the
Companions window is marked ✝ until it is revived. A roaming companion often
falls out of your sight, so the coordinates are how you find the corpse.

If the companion's owner leaves the map while the companion is dead, the corpse
is released and removed from the party. It cannot be recovered afterwards.

## The Companions window

Everything above can be done without typing: a **Companions** button sits in the
Basic Information window's shortcut strip, beside Attendance Check, and opens a
window with four tabs.

| Tab | What it does |
| --- | --- |
| Party | The saved companion list, with each one's job, level and state (✝ when it is down). Set duty, roaming (with Companion roaming on), summon, bench, favorite, or refresh. |
| Summon | Draft a brand-new companion of any job, grouped 1st / 2nd / Trans / 3rd / 4th, as Male, Female or Random. When companions are hired (below), only your own tier's jobs, with the fee. |
| Battle | Stance (Free / Standard / Hold), Movement (Follow / Roam, with Companion roaming on), Taunt and Recall, the healer thresholds, and when companions rest. |
| Gear | Take back equipment you gave the companion, per slot (`weapon`, `shield`, `armor`, …) or all of it. What it was generated or drafted with is its own and stays on it; when you take a piece back, it puts its own gear back on in that slot. Gear you gave that a new job cannot wear is handed back when it advances. |

Each companion on the Party tab has a **Skills** button, which lists the skills
it may use; untick one and it stops using it. The list order is also the
priority between buffs that cancel each other: a Bard's songs, a Dancer's
dances, stances such as Banding and Prestige. The companion keeps up the highest
one it has ticked, and doesn't cast a lower one over it until the higher one
runs out. To have it use a different song, untick the ones above it. A
performance already playing (an ensemble, or any pre-renewal song or dance)
holds until it ends, whatever its place in the list. A skill that requires the
buff it ends, such as an Inquisitor's Judge after First Faith Power, still takes
over, so a chain runs in order.

The window is a real client component, not an overlay: it is draggable, it
remembers its position, and clicks aimed at it do not reach the game. Each
control sends the same packet that typing the command sends, so the server
cannot tell a button press from a keystroke — the buttons and the commands below
are two ways to say the same thing.

### Weapon rules

By default a companion uses every skill it has, whatever it is holding: a
Minstrel sings with a bow in hand. **Settings → Population → Weapon rules**
holds companions, and every other fake player, to the weapon requirements a
player has. With it on, a skill the companion's weapon can't use is skipped
until you trade it a weapon that can. Some jobs start with gear that doesn't fit
all their skills: Clowns, Minstrels and Troubadours start with a bow and need an
instrument to sing, and Gypsies, Wanderers and Trouveres need a whip to dance.
Item costs are a separate setting, **Companion inventory**: off, arrows and
gemstones are never needed; on, they come from its bag (see [Its bag](#its-bag)).

## Free or hired

**Settings → Population → Companions** decides what a new companion costs:

| Setting | What it means |
| --- | --- |
| Free choice (the default) | The Summon tab drafts any job, at any time, as before. |
| Hired from the Companions panel | The Summon tab offers only jobs of your own class tier (1st, 2nd including transcendent, 3rd or 4th), and the companion comes at your base level, within the range its job's profile allows. Each hire costs the fee below. |
| Hired from a Companion Recruiter | The same rules, from a Companion Recruiter who stands two cells east of the healer in each main town. The Summon tab points you there. |

The fee is **Fee per level** zeny times the companion's level, and/or the
**Fee item** (an item id and an amount; 0 for none). It is taken only once the
companion exists, so a draft that fails costs nothing. Calling back a companion
you already have, from the Party tab or `@companion summon`, is always free.

`@companion terms` prints the rules for your character as one line,
`@CPTERMS|mode|tier|zeny|item|amount|item name|jobs`, which is what the
Companions window reads.

`@companion list raw` prints your saved companions the same way, one line each
and then `@CPEND|count`, which is how the Companions window draws its rows:

`@CP|name|job|base_level|active|favorite|live_level|live_job|pet|duty|rebirth|heal_at|emergency_at|rest_below|rest_until|roam|dead`

- `active` and `favorite` are 0 or 1. `live_level` and `live_job` are the
  summoned companion's current values, which differ from the saved ones once it
  has levelled.
- `pet`: -1 when the job cannot have one, otherwise 0 off or 1 on.
- `duty`: the duty the server holds for it: 0 none yet, 1 tank, 2 support,
  3 attacker. The window shows this one, not the last button pressed: the server
  changes the duty of a summoned companion only, so pressing Duty on one that is
  not out goes back to what the server holds.
- `rebirth`: -1 when the class cannot be reborn, 0 not yet, 1 ready.
- `heal_at` … `rest_until`: the Battle tab's thresholds, as saved.
- `roam`: 1 when it roams the map instead of following (`@companion roam
  [<name>] on|off`; no name sets all of them), -1 while Companion roaming is
  off, when the window draws no Roam control and the command does not exist.
- `dead`: 1 while the summoned companion is down. The server sends the list
  again when one dies and when it is revived, so an open window shows it at once.

## Current scope

- Companions can be recruited from the existing Population Engine population, or
  **drafted directly** (`@companion draft <job> [name] [m|f]`, or the Summon tab)
  without hunting the world for a matching character.
- A drafted companion's sex is yours to choose: `m`, `f`, `male` or `female`, as
  the first or the last word after the job (`@companion draft Knight f Aria` or
  `@companion draft Knight Aria f`). Leave it out and it is either, at random. A
  job that is only ever one sex keeps it: Bard, Clown, Minstrel, Troubadour and
  Kagerou are male; Dancer, Gypsy, Wanderer, Trouvere and Oboro are female. The
  Summon tab marks those jobs ♂ or ♀. The sex is saved with the companion, so it
  stays the same when you call it back. A Companion Recruiter does not ask; its
  hires are either sex.
- Classes, equipment, skills, looks, names, and ambient chat come from the
  editable YAML files in `third-party/population-engine/files/db/`.
- Combat mode, duty and the healer thresholds are stored per companion and
  restored on login; a companion's level, stats, job and equipment are saved as
  they change, and advancing jobs happens on its own at the usual level gates.
- Standard rAthena party rules still apply, including the overall party-member
  limit and EXP-sharing requirements.

Implementation details, invariants, verification evidence, and planned work are
documented in the [AI companion development guide](COMPANION_DEVELOPMENT.md).
