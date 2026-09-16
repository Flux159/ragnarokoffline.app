# AI companions

Population Engine characters can join a real party as temporary AI companions.
They follow their recruiter between maps, fight and support the party, and obey
combat orders from the party leader. Up to four companions can be recruited
into one party.

The feature is available whenever **Settings → Population → Fake players** is
enabled. It does not alter characters or save data.

## Recruit a companion

1. Create a party and make sure you are its leader. (`/organize <partyname>`).
2. Whisper `party`, `pt`, `join`, or `invite` to a Population Engine character.
3. The character stops moving and answers. You have 60 seconds to right-click
   it and choose **Party Invitation**.
4. The character accepts automatically and becomes a companion.

The invitation window expires after 60 seconds, after which an unrecruited
character resumes its normal behaviour. If the party already has four
companions, the character replies with the limit instead.

Companions follow the player who recruited them. They teleport nearby when
they fall outside the visible area or when their owner changes maps. When the
party stops, companions use separate formation cells around their owner rather
than standing on top of one another.

Removing a companion from the party releases it. Companions are temporary and
are not restored after the local server or app is shut down.

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

## Death and resurrection

A defeated companion stays in the party as a corpse while its owner remains on
the same map. It can be revived in either of two ways:

- Priest class companions automatically cast level 3 Resurrection on dead party
  members, including real players and other companions. Their virtual Blue
  Gemstone supply is unlimited because shells have no player-accessible
  inventory.
- A real player can use a Yggdrasil Leaf on the dead companion.

Level 3 Resurrection restores 50% HP. Resurrection remains available in every
combat mode and role because recovery is treated as a class capability rather
than an offensive action.

If the companion's owner leaves the map while the companion is dead, the corpse
is released and removed from the party. It cannot be recovered afterwards.

## Current scope

- Companions are recruited from the existing Population Engine population;
  there is no guild board or character-creation menu yet.
- Classes, equipment, skills, looks, names, and ambient chat come from the
  editable YAML files in `third-party/population-engine/files/db/`.
- Role assignment and combat mode are runtime state and are not persisted
  across a server restart.
- Standard rAthena party rules still apply, including the overall party-member
  limit and EXP-sharing requirements.

Implementation details, invariants, verification evidence, and planned work are
documented in the [AI companion development guide](COMPANION_DEVELOPMENT.md).
