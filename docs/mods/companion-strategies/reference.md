# Companion strategies: reference

Every building block of the plan table, `db/population_strategy.yml`, and what
each one does. New to it? Start with the [guide](guide.md). For party play see
[team play](team.md), for copyable recipes the [cookbook](cookbook.md), and the
[FAQ](faq.md) when something does not behave.

## Index

**An entry** (one per monster or kind of monster):

| Key | What | Section |
|---|---|---|
| `Mob` / `Mobs` | a monster (AegisName or id), `Boss`, `All`, a kind `{ Race, Element }`, or a list | [The shape](#the-shape), [Any boss](#any-boss-mob-boss), [Kinds](#kinds-of-monster-mob--race-element-) |
| `Encounter: true` | the monster's plans apply while one is near, not only while targeted | [Encounters](#encounters-boss-fights) |
| `Targeting: { Priority, Ignore, MaxAttackers }` | which monster companions take on | [Targeting](#targeting) |
| `Jobs: [...]` | the job entries below | |

**A job entry** (one plan: monster + job + build):

| Key | What | Section |
|---|---|---|
| `Job` | a job (its family), a list, `All` | [Jobs and families](#jobs-and-families) |
| `Exact: true` | only the jobs named and their own family, not classes built on them | [Plain attacks](#plain-attacks-attack-false) |
| `Build` + `Requires` | one way to play the job, for companions that meet `Requires` | [The shape](#the-shape) |
| `For` | `companions` (default), `shells`, `all` | [Regular shells](#regular-shells) |
| `Rules: [...]` | rules for every strategy of the plan | [Rules](#rules) |
| `Strategies: [...]`, `Start` | the states of the plan's state machine, and the first | [Strategies](#strategies-a-state-machine-per-plan) |
| `Rotation` | the engine's skill rotation on or off | [Rules](#rules) |
| `Allow`, `Ban` | which skills the engine may cast on its own; which nobody may | [Which skills](#which-skills-allow-and-ban) |
| `Attack` | plain attacks on or off | [Plain attacks](#plain-attacks-attack-false) |
| `Disable` | other plans' rules, by name, put aside while this plan applies | [Disable](#putting-a-broader-rule-aside-disable) |
| `Remove`, `Reset` | delete or restart this plan (in a later mod) | [More than one mod](#more-than-one-mod) |

**A strategy** takes `Name`, `Rules`, and its own `Rotation`, `Allow`, `Ban`,
`Attack`, `Disable`, which count while it is active; `Remove: true` deletes it.

**A rule** has a `Name` and a `Priority`, any number of conditions, and one action:

| Conditions | | Actions (one per rule) | |
|---|---|---|---|
| `Requires` | skills, lacks, items, level, role | `Cast` (+ `Level`, `Target`, `Consume`) | a skill, or the best of a list by element |
| `On` | an [event](#events) happened | `KeepDistance` | stay in a distance band |
| `When` | a [condition](#when-conditions) holds | `Kite` | run the monster round an anchor |
| `Charges` | a status's counter | `Retreat` (+ `Distance`) | step away, or back to the owner |
| `Field` | ground units nearby | `MoveTo` | to an event, a cell, a field, a reachable cell |
| `Count` | monsters nearby | `Leave` | off hostile ground |
| `Present` / `Absent` | a selector finds someone / nobody | `Hold` | stand still |
| `Reach` | the monster could fight back here | `Sit` | sit down, regenerating faster |
| | | `UseItem` | an item from its own bag |
| | | `Aim` (with a ground `Cast`) | the cell it lands on |
| `Enemy` | the monster's element, race, size, boss | **Also, with or without an action:** | |
| `Cooldown` | not fired for so long | `Say` (+ `Channel`) | speak |
| `OnePerParty` | no other companion just did it | `Switch` | change strategy |
| `Claim` | pass over targets another companion claimed | | |
| `InStrategy`, `InFight` | how long in this strategy, in this fight | | |
| | | `Signal` | tell the other companions |
| | | `SetTarget` | make the rule's monster the target |

**Targets and selectors** for `Target:`, `Present`, `Absent`, `Count`:
`enemy`, `self`, `owner`, `event`, `source`, `ally_lowest_hp`, `dead_ally`, or a
[selector](#choosing-who-selectors): `{ Enemy: attacking | target_of | nearest |
lowest_hp | boss | slaves | casting | hidden, ... }` or `{ Ally: lowest_hp | nearest
| missing | having | attacked | dead, ... }`.

**Events** for `On:`: `casts` / `monster_casts`, `party_chat`, `party_member_died`,
`signal`, `encounter_ended`, `target_lost`, `hp_below`, `owner_hp_below`,
`weight_above`, `equip_broken`, `item_below`, `status_gained`. See [Events](#events).

## The shape

```yaml
Header:
  Type: POPULATION_STRATEGY_DB
  Version: 1

Body:
  - Mob: STALACTIC_GOLEM          # AegisName, id, Boss, All or { Race, Element }; Mobs: [..] for several
    Targeting: { Priority: 50 }   # optional
    Jobs:
      - Job: Monk                 # Monk (the family), [Wizard, Sage], JOB_NINJA, 15, or All
        Build: combo              # optional: one way to play the job
        Requires: { Skills: [MO_CHAINCOMBO], Lacks: [MO_EXTREMITYFIST] }
        Rotation: false           # optional: the normal skill rotation (see below)
        Allow: [...]              # optional: the only skills it may use (see below)
        Ban: [MO_FINGEROFFENSIVE] # optional: these skills not against it
        Start: approach           # the strategy each new fight starts in
        Rules: [...]              # rules for every strategy
        Strategies:
          - Name: approach
            Rules: [...]
          - Name: fight
            Rules: [...]
```

A monster, a job and a build together make a **plan**. A companion uses every
plan that matches what it is fighting:

1. the monster it targets, then any **encounter** monster near it (below), then
   that monster's [kind](#kinds-of-monster-mob--race-element-) (race and
   element), then `Mob: Boss` while a boss is near, then `Mob: All`;
2. its own job, then its family, then its 1st class, then `Job: All`
   ([Jobs and families](#jobs-and-families));
3. within those, each `Build` whose `Requires` it meets, before the entry
   without a `Build`.

### Jobs and families

`Job: Priest` names the whole **family**: Priest, High Priest, Arch Bishop,
Cardinal and Baby Priest. A Champion uses `Job: Monk`, and a Lord Knight uses
`Job: Knight`. A plan for one job only names that job (`Job: High_Priest`); it
comes before the family's plan. A 1st class names everything built on it:
`Job: Acolyte` is Priests and Monks alike, so use it with care.

A list is several families: `Job: [Wizard, Sage]`. A job this server's era lacks
(a 4th class in pre-renewal) is passed over without a word, so one list serves
both eras. A name that is no job at all is a warning. `Job` in a
[selector](#choosing-who-selectors) works the same way.

### Encounters: boss fights

A monster's plan normally applies only while the companion targets that monster.
In a boss fight that is too narrow: the Priest heals with no target at all, and
the Wizard spends half the fight on the slaves. `Encounter: true` makes the
monster's plans apply while one is within 14 cells of the companion, whatever it
is fighting:

```yaml
- Mob: PHREEONI
  Encounter: true
  Jobs: [...]
```

The plan's strategy starts over with each new boss, not with each new target.
Its `enemy_*` conditions still ask about the companion's current target, which
may be a slave; ask about the boss with a selector:
`Target: { Enemy: boss }` and `When: enemy_hp_pct_lt80`.
[`examples/mods/companion-tactics`](../../../examples/mods/companion-tactics) has a
whole Phreeoni encounter.

### Any boss: `Mob: Boss`

`Mob: Boss` is a plan for every boss-class monster, MVPs and mini-bosses alike.
It applies while one is within 14 cells: the one the companion fights if that is
a boss, otherwise the nearest. It works like an encounter. Its strategy starts
over with each new boss, and `encounter_ended` fires when that boss dies or
teleports away. It is where a role's general boss behaviour goes. A particular
boss's plan comes before it and adds that boss's mechanics:

```yaml
- Mob: Boss
  Jobs:
    - Job: Priest
      Build: healer
      Requires: { Role: [support, none] }   # the family's part, unless told otherwise
      Rotation: false
      Rules: [...]
```

`Requires: { Role: [support, none] }` is how a role follows the class by default
and the party-chat Duty overrides it. A Priest given no Duty, or told `support`,
heals. A Priest told `attacker` does not use this plan.

`Encounter` and `Targeting` need a particular monster, not `Boss`.

### Kinds of monster: `Mob: { Race, Element }`

A plan can be for every monster of a race, an element, or both:

```yaml
- Mobs: [{ Race: Undead }, { Element: Undead }]   # either: Heal hurts both
  Jobs: [...]
- Mob: { Race: Demon, Element: Dark }             # both must hold
  Jobs: [...]
```

Races and elements are rAthena's names, with or without the prefix: `Undead`,
`DemiHuman`, `RC_BRUTE`; `Fire`, `Ghost`, `ELE_WATER`. The kind is read from the
monster the companion fights. With no target, it is read from the nearest
monster on the party, because a Priest seldom has a target of its own. The
element is the monster's current one: a frozen monster counts as Water. A plan
for race and element together comes before one for either alone.

The rotation already picks spells by element: a Mage casts Cold Bolt at a fire
monster and never casts a spell that would heal its target. A kind plan is for
what the rotation does not do. Examples: Heal as an attack on the undead,
Aspersio on the melee against Ghost monsters, Lex Aeterna first on demons.

`Race` and `Element` also narrow an Enemy [selector](#choosing-who-selectors) or
a `Count`. `Target: { Enemy: attacking, Race: Undead }` is the undead monster
on the party, whatever kind of plan the rule is in.

### Putting a broader rule aside: `Disable`

A more specific plan can switch off rules of the broader ones, by `Name`, while
it applies:

```yaml
- Mob: STALACTIC_GOLEM
  Jobs:
    - Job: Priest
      Disable: [stay_back]        # the role's 5 cells; this plan has its own
      Rules:
        - Name: stay_back
          Priority: 74
          Target: { Enemy: boss, Range: 14 }
          KeepDistance: 4
```

The plan's own rules of that name are not affected. A strategy can carry its own
`Disable`, which counts while it is active. A name no rule has is a warning at
load. Names are shared by every plan a companion uses, so give a role's rules
names that say what they do (`stay_back`, `heal_attacked`), and disable them by
those names.

### Priorities between mods

When a role mod and a boss mod both apply, their rules go into one list by
`Priority`. The example mods keep to these bands, so a boss's mechanics come
before a role's routine without either mod knowing the other's numbers:

| Priority | For |
|---|---|
| 100 and up | survival and resurrection |
| 80 – 99 | a boss's own mechanics |
| 40 – 79 | the role's core: heals, position, buffs |
| below 40 | filler, and `Hold` |

## Rules

Every turn (every 100 ms while it fights) the companion goes down its rules,
highest `Priority` first, and does what the first one that applies says. Ties go
to the more specific plan, then to file order. Nothing is random: the same
situation always gives the same decision.

A rule applies when all of the following hold:

| Key | The rule applies only... |
|---|---|
| `Requires: { Skills, Lacks, Items, BaseLevel, Role }` | to a companion that has (and lacks) these. `Role` is the party role set in chat (`tank`, `support`, `attacker`, `none`), or a list of them for any of those. A `Cast` rule also requires the skill itself, so a rule for a skill the companion doesn't have does not exist for it. Neither does one for a skill its owner unticked in the companion's skill selection: that choice stands over any plan. `Skills` and `Lacks` read that selection too: an unticked skill counts as one the companion lacks. Every companion has its whole tree, so the selection is how two builds of one class are told apart: `Requires: { Lacks: [MO_CHAINCOMBO] }` is the Champion whose owner unticked Chain Combo. A `UseItem` rule likewise exists only for a companion that carries the item. (Shells get their job's whole skill tree at spawn, so "has the skill" mostly means "the class has it".) |
| `On:` | within `Within` ms (default 3000) of an event, and once per event. See [Events](#events). |
| `When:` | while a condition holds: `enemy_hp_pct_lt30`, `self_spheres_ge1`, `not_enemy_aeterna`, `[a, b]` for AND, `{ OR: [a, b] }`. See [`When:` conditions](#when-conditions). |
| `Charges: { Status, Below \| AtLeast, Value }` | while a status's counter is in range. Cicada Skin Shed keeps its blocks left in its second value (the default), so `{ Status: SC_UTSUSEMI, Below: 2 }` is "1 or 0 left". No status counts as 0. |
| `Field: { Skill, Below \| AtLeast, Range, Owner, At }` | while that many ground units of the skill stand within `Range` cells (default 5; `0` is the cell itself) of the companion, or with `At: target` of the rule's target (the boss in its own Pneuma). `Owner` says whose: `self` (default: Blaze Shield's pillars, its own Fire Wall), `party` (a Sage's Land Protector), `monster`, `enemy`, `anyone`. |
| `Count: { Enemy, Who, Around, Range, Below \| AtLeast }` | while that many monsters stand within `Range` cells (default 5) of the companion, or with `Around: target` of the rule's target. `Enemy`: `any` (default), `attacking` (with `Who`, `NotSelf`), `boss`, `slaves`, `casting`. "Three slaves around the boss": `{ Enemy: slaves, Around: target, AtLeast: 3 }` with `Target: { Enemy: boss }`. |
| `Present: { Ally \| Enemy: ..., ... }` | while a selector finds **someone**: `Present: { Ally: dead, Range: 9 }` is "someone lies dead within Resurrection's reach". |
| `Absent: { Ally \| Enemy: ..., ... }` | while a [selector](#choosing-who-selectors) finds **nobody**: `Absent: { Ally: nearest, Job: Priest }` is "no living Priest within sight", the moment to fall back. |
| `Reach: false` / `true` | `Reach: true`: while the monster the rule is about could fight back against the companion where it stands: it can hit from there, or walk to it within its chase range. `Reach: false`: while it could not, **and has an answer to that**. rAthena answers a hit from out of reach with the monster's `rudeattacked` skill and nothing else (for most bosses, Teleport), and only in the state the skill is listed for. So `Reach: false` does not hold a caster back from a monster that has no such skill, nor from one that is busy with someone else in a state its skill is not for: Dark Lord teleports for it while idle or walking, never while it fights the tank. A monster counts as unable to walk as rAthena counts it: held by Spider Web and the like, not paused by its own attack or cast, and not merely because it never walks (Amon Ra is asked for a path like any other). |
| `Enemy: { Element, Race, Size, Boss }` | while the monster the rule is about (its selector's, or the current target) is one of those: `Element: [Holy, Ghost]`, `Race: Demon`, `Size: Large`, `Boss: true`. Names as rAthena writes them without `ELE_` / `RC_`. For a boss that changes element. |
| `Cooldown:` | when it has not fired in that many ms. "Every 30 s" is `Cooldown: 30000`. |
| `InStrategy: { Below \| AtLeast }` | while the plan's active strategy has been active for that long (ms): `InStrategy: { AtLeast: 60000 }` is "this phase has dragged on for a minute". |
| `InFight: { Below \| AtLeast }` | while the companion's current fight has lasted that long (ms): `InFight: { Below: 5000 }` is "the first 5 s". A fight begins when it has a target or a plan about a monster applies, after 5 s without either, and ends 5 s after the last. Out of a fight it counts as 0. Both are measured from timestamps, so a companion that took no turns in between (resting, frozen) still sees the time pass. |
| `OnePerParty: true` | when no other companion of the party has just fired it at the same target. |
| `Claim: name`, or `Claim: { Name, For }` | on a target no other companion of the party has claimed under that name. Acting puts the claim on the rule's target for `For` ms (default 5000), renewed each time it acts again. A selector passes claimed targets over and picks the next, so `Claim: frozen` on a Frost Diver rule spreads two Wizards over two monsters, and `Claim: { Name: lex, For: 10000 }` keeps a second Priest from a second Lex Aeterna on the boss. Unlike `OnePerParty`, it works across different rules: any rule with the same claim name respects it. When a rule finds no target because others hold the claims, the trace says so: `rule frost_spread: Poring is claimed (frozen) by Kira`. |

And then does one thing:

| Action | |
|---|---|
| `Cast:` skill or `[list]`, `Level:`, `Target:` | `enemy` (default), `self`, `owner`, `event` (who the event was about), `source` (the monster that caused it), `ally_lowest_hp`, `dead_ally`, or a [selector](#choosing-who-selectors). Ground skills land at the target's feet. Refused where the normal rotation would refuse it: SP, range, weapon, state. A list casts the one the target is weakest to by rAthena's element table, among those the companion knows and has the SP for; ties go to list order, and one the target would resist entirely (or be healed by) is never cast. `Cast: [MG_COLDBOLT, MG_FIREBOLT, MG_LIGHTNINGBOLT]` is a bolt by element. |
| `Aim: { Cells, From, Lead }` (with a ground `Cast`) | Where a ground skill lands, when not at the target's feet. `Cells: n` is the cell `n` cells from the companion on the straight line to the target; `From: target` counts from the target, toward the companion. `Lead: true` takes the target to be where its walk will have brought it when the cast lands (its path, its speed, the companion's cast time for the skill), so a spell with a cast time meets a monster that is walking; one standing still is where it is. Together: `Aim: { Cells: 2, From: target, Lead: true }` is two cells in front of where it will be. The cell lies strictly between the two: with the target no further off than `Cells`, the rule does not cast (`too close to aim 3 cells toward it`). A cell nobody can stand on is pulled back toward where the count began; with none, the trace says `no free cell to aim at`. Range, and "the cell is taken", are asked of the aimed cell. The trace shows it: `Ice Wall on Raydric at (63,71), 3 cells from itself, 4 from it`. What it is for: an Ice Wall between a Wizard and what is coming for it, not on top of it; a Fire Wall in a monster's path; a trap or a Quagmire ahead of a monster, since a trap cannot go on the cell it stands on; Storm Gust or Meteor Storm where a walking pack will be once the cast is done. |
| `Consume: true` (with `Cast`) | Marks a cast that pays its catalyst (a Flame Stone, a Blue Gemstone) as a player does. With **Companion inventory** on, every cast of a companion pays from its own bag through rAthena, marked or not, and a cast it cannot pay for is passed over. With it off, the cast goes ahead as if the catalyst were paid, as the engine does for every shell. |
| `UseItem:` item or `[list]`, `Target:` | Uses one of an item the companion carries, as a player does: the item's own delay, its job and level limits, its script, and one taken from the bag. A list uses the first one in the bag (`UseItem: [White_Potion, Yellow_Potion]`). A companion that carries none of them does not have the rule, so the same table serves a stocked companion and an empty one. An item that casts a skill (an elemental converter, a Fly Wing, a scroll) casts it on the companion, or on the rule's `Target` when the skill needs one. Without a `Cooldown` the rule waits 1 s between uses; say when with a condition, or it uses the item again as soon as it may (`When: not_self_aspdpotion1` for an Awakening Potion, `When: self_poison` for a Green Potion, `When: not_self_enchantarms` with `Enemy: { Element: Water }` for a wind converter). With **Companion inventory** off the bag holds only what the engine hands a companion, so these rules mostly have nothing to use. A Fly Wing moves the companion, and following brings it back to its owner as soon as the owner is out of sight. |
| `Retreat: away` / `owner`, `Distance:` | Steps that many cells away from the monster (or from an event's `source`), or walks back to the owner. |
| `MoveTo: event` | Walks next to whoever the event is about: the companion that sent a `signal`, the member who spoke in party chat. Already beside them: the rule passes. |
| `MoveTo: reachable` | Walks to the nearest cell (within 8) from which the monster could fight back, so hitting it from there does not make it teleport. Already on one: the rule passes. |
| `MoveTo: event_cell` | Walks to where an `On: casts` spell will land, while it is still being cast: onto a party Land Protector before it is down. |
| `MoveTo: { Field, Owner, Within, Depth }` | Walks onto the nearest cell of that ground field within `Within` cells (default 8). Already standing on one: the rule passes. `Depth: n` asks for a cell at least `n` cells inside the field's edge, so that what lands beside the field does not reach: a Meteor Storm that falls outside a Land Protector still hits whoever stands on its rim. `MoveTo: { Field: SA_LANDPROTECTOR, Owner: party, Depth: 3 }` is the middle 5x5 of a level 5 Land Protector. A field too small for that gives its deepest cells. |
| `MoveTo: { Sight: target, Within, Range }` | Walks to the nearest cell (within `Within`, default 8) from which the rule's target is in the clear and at most `Range` cells away (default 9): a caster or archer behind a tree, a wall or a corner steps round it and does not stand there with every cast refused (`no clear line to the target`). In the clear and within `Range`: the rule passes, and the cast below it runs. The target is the rule's own: the companion's current target by default, or an `Ally` selector's pick (a healer whose Heal is blocked). An `Enemy` selector does not pick a monster behind a wall in the first place, so leave the target at its default for monsters. Set `Range` to the reach of the spell the companion will cast. |
| `Leave: { Field, Owner, Within }` | Standing on a ground unit placed by `Owner` (default `enemy`: anyone outside the party, monsters included): walks to the nearest free cell within `Within` (default 8). `Field` narrows it to one skill; without it, any unit counts. Not standing on one: the rule passes. `Leave: true` is the same with every default. |
| `Kite: { Away, Within, Gap }` | Runs from the monster that is on the companion (else its target), staying within `Within` cells (default 7) of an anchor, the rule's target (else the owner), but no closer than `Gap` (default 3), so it never leads the monster onto the anchor. Each step takes the reachable cell furthest from the monster in that ring; a monster that keeps chasing is led round the anchor. At least `Away` cells (default 4) from the monster and inside the ring: the rule passes. For a damage dealer that has the boss's attention and needs the healer's heals. |
| `KeepDistance: { Min, Max }` | A band: closer than `Min`, step out; further than `Max`, come back in (to stay within a spell's range). Within it, the rule passes. Measured from the rule's selector pick when it has one: `Target: { Ally: attacked }` keeps a healer within reach of whoever is hit, `Target: { Enemy: boss }` keeps it out of the boss's. |
| `KeepDistance: n` | Closer than `n` cells to the monster: walks to the nearest open cell at least `n` away. Already that far: the rule passes, and the next rule (a cast) runs. |
| `Hold: true` | Stands still, without chasing or walking to the target. Without it, a turn no rule took is an ordinary turn, and an ordinary turn walks up to the target. |
| `Sit: true` | Sits down while the rule applies, as a player does: faster regeneration, and the effects tied to sitting (Gangster's Paradise, Peaceful and Happy Break). Not while its owner is walking, nor while casting, dancing or under a status that forbids it. It stands up again as soon as no `Sit` rule applies, and before any other rule acts: a sitting character can neither move nor cast. For "sit until 80 %", put the `Sit` rule in a strategy and switch out of it at 80 %. The engine's own rest (below a companion's rest threshold) is separate, and takes the turn while it lasts. |
| `Say:` text, `Channel: party` / `area` | Speaks. `{name}` `{owner}` `{target}` `{ally}` `{skill}` `{hp}` are filled in. A `Say` rule without an event waits 10 s between lines, and one with an event 2 s, unless it has a `Cooldown`. |
| `SetTarget: true` | Makes the rule's monster (a selector's, or `source`) the companion's combat target, held for 3 s and renewed while the rule applies. Alone, it does not end the turn. |
| `Switch:` strategy | Makes another strategy of the same plan active. |
| `Signal:` name | Tells the party's other companions, who react with `On: { Event: signal, Name }`. A signal rule without an event waits 5 s between sends, and one with an event (an answer to another signal) 2 s, so two rules can't signal each other every tick, unless it has a `Cooldown`. |

A companion that cannot move (petrified, frozen, stunned: whatever rAthena's
`unit_can_move` refuses) skips every movement rule; it does not walk away while
turned to stone.

`Cast`, `UseItem`, `Retreat`, `KeepDistance`, `MoveTo`, `Leave`, `Hold` and `Sit` end the companion's turn; only one
of them is allowed per rule. `Say`, `Switch` and `Signal` do not end it and can
come with any of them, after it has succeeded. When no rule acts, the companion takes its
ordinary turn: heals, buffs and the skill rotation (minus anything `Ban` or
`Rotation` takes away). The built-in Party Resurrection comes before all rules:
a dead party member is revived first, unless the companion's plan revives with
its own rule (a `Cast: ALL_RESURRECTION` it knows): then the plan decides when,
for instance only behind a Safety Wall.

**The normal skill rotation is off under a plan about a particular monster.** A
plan for `Mob: PHREEONI` says what to cast, and the companion casts that and
plain-attacks, nothing else from its class's rotation. Broad plans (`All`,
`Boss`, a kind of monster) describe general behaviour and leave the rotation as
it is. The built-in heals, buffs and
resurrection are not part of the rotation and keep running.

`Rotation: true` or `false` on a job entry (or on a strategy, while it is
active) overrides that default. With several plans applying, they are weighed
together:

1. any plan that says `false` wins;
2. otherwise any plan that says `true`;
3. otherwise the default: off if a plan about a particular monster applies.
   `All`, `Boss` and the kinds of monster have no opinion, so with only those
   the rotation is on.

So a boss plan that says nothing leaves it to the role plan. For example, the
melee plan in companion-roles turns the rotation on with a `Ban` list. A boss
plan that needs every cast counted (the Asura Monk) says `false`.

### `When:` conditions

`When:` takes one token, a list of tokens (all must hold), or a map of gates:

```yaml
When: self_hp_pct_lt50
When: [enemy_hp_pct_lt30, self_sp_ge120]           # all of them
When: { OR: [self_safetywall, not_self_targeted] }  # any of them
When:
  AND: [self_hp_pct_ge95, enemy_distance_le1]
  OR: [self_kyrie, self_utsusemi]                    # both gates must hold
```

Gates: `AND`, `OR`, `NAND`, `NOR`, `XOR`, `NXOR`, each over a list; they nest.
`not_` in front of any token inverts it.

A token is **who**, **what**, and for numbers a **comparison**:

| Who | asks about |
|---|---|
| `self_` | the companion |
| `enemy_` | the monster the rule is about: its selector's pick, or the current target |
| `ally_` | the party member the rule's `Ally:` selector picked |
| `master_` | the owner |

| What | Example | Means |
|---|---|---|
| `hp_pct`, `sp_pct` | `self_hp_pct_lt50`, `enemy_hp_pct_lt30` | HP or SP in percent |
| `hp`, `sp` | `self_sp_ge120` | HP or SP in points (keep SP back for a cast) |
| `distance` | `enemy_distance_le2` | cells between the companion and it |
| `spheres` | `self_spheres_ge5` | spirit spheres |
| a status, without `SC_` | `self_kyrie`, `not_enemy_aeterna`, `self_stonewait` | has that status now |
| `count_nearby` | `enemy_count_nearby_ge3`, `ally_count_nearby_ge2` | how many around (needs a comparison) |

Comparisons: `lt`, `le`, `gt`, `ge`, `eq`, then the number. A number with no
comparison means "more than 0".

These tokens stand on their own: `always`, `self_targeted` (a monster is on
it), `melee_attacked`, `range_attacked`, `self_being_cast_on`, `enemy_hidden`,
`enemy_casting`, `enemy_casting_ground`, `enemy_is_boss`. The engine's
`population_skill_db.yml` uses the same syntax, so conditions copied from there
work here too. A token that names nothing is a warning at load, with its line.

### Which skills: `Allow` and `Ban`

By default a companion may use every skill it has. A plan narrows that:

```yaml
- Mob: Boss
  Jobs:
    - Job: Priest
      Allow: []                   # nothing on its own: only what its rules name
    - Job: Hunter
      Allow: [AC_DOUBLE, AC_SHOWER, HT_BLITZBEAT]
- Mob: PHREEONI
  Jobs:
    - Job: All
      Ban: [MG_FIREWALL]          # nobody, not even a rule of another plan
```

**`Allow`** is what the engine may cast **on its own**: the rotation, and its
heals, buffs and emergency Hiding (a Priest's Sanctuary at a boss came from
there). A skill the engine wants must be in every `Allow` of the plans that apply
(no `Allow` lists everything), so a more specific plan can only narrow it, never
widen it. `Allow: []` lets the engine cast nothing; the companion then casts
only what its rules name. `Allow` does not bind rules: a rule is already an
explicit decision.

**`Ban`** binds everything: the engine's own casts and the rules of the
**other** plans. Use it, or `Disable`, when a more specific plan wants a broader
plan's skill gone.

A strategy's own `Allow` and `Ban` count too, while it is active. A plan never
stops a skill its own rules cast.

### Plain attacks: `Attack: false`

`Attack: false` on a job entry (or a strategy, while it is active) stops plain
attacks while the plan applies: the companion uses skills only, and out of SP it
stands. This is the engine's own `skill_only`. The most specific plan that says
anything decides, so a boss strategy can say `Attack: true` for a moment against
a broader `false`. With `For: all` it reaches the AI characters around the world
too:

```yaml
- Mob: All
  Jobs:
    - Job: [Priest, Wizard, Sage]
      For: all
      Attack: false
    - Job: [Acolyte, Mage]
      Exact: true                 # not the Priests and Monks built on them
      For: all
      Attack: false
```

`Exact: true` limits a job entry to the jobs it names and their own family (a
High Acolyte, a Baby Mage), not the classes built on them.

`Allow`/`Ban` decide *which* skills. Rules decide *when* and *at whom*. A class
with a rules plan (bolts at what is on the party, stand between casts) behaves
precisely; a class without one gets the engine's own behaviour, limited to what
the plans allow.

A caster under such a plan still takes ordinary turns whenever no rule acts, and
an ordinary turn walks up to its target and hits it. End a caster's rules with
the lowest-priority `Hold: true`: with nothing to cast, it stands. Its other rules
outrank it and still fire. But `Hold` ends the turn, and the engine's own buffing
and healing come later in it, so name the buffs it should keep up as rules
(`Target: { Ally: missing, Status: SC_BLESSING }`).

Shells also flee on their own below 30 % HP (the engine's FleeOnLowHP). A rule
that acts at low HP, such as stepping out and holding for heals, comes first.

### Choosing who: selectors

A `Target` written as a map lets the rule pick its own monster or party member.
The choice is deterministic: the best match by the pick (preferred first, lowest
HP first), then the nearest, then the lowest id. Only those within the cast's
range are considered (`Range` overrides; without a cast it is 14 cells). A rule
whose selector finds nobody does not apply.

| Selector | Picks |
|---|---|
| `{ Enemy: attacking, Who, NotSelf, Prefer, Job }` | a monster attacking `Who` (`party` by default; `owner`, `self`, `tank`, `support`, `attacker`, `any`). `NotSelf: true` leaves out the ones attacking the companion itself; `Prefer` puts those on one member first; `Job` keeps to those attacking a member of that job (`Job: Priest`: whatever is on the healer, Duty or not). |
| `{ Enemy: target_of, Who, Job }` | the monster `Who` is fighting (`owner` by default): assisting. |
| `{ Enemy: nearest \| lowest_hp \| boss \| slaves \| casting \| hidden, Skill }` | the nearest, the most hurt, a boss, a summoned slave, one that is casting, one that is hidden (Hiding, Cloaking, a Hode's burrow). `Skill` (one or a list) narrows `casting` to those casts: `{ Enemy: casting, Skill: [WZ_JUPITEL, MG_THUNDERSTORM] }` interrupts what matters and leaves a Lex Aeterna alone, for as long as the cast lasts. `Count: { Enemy: casting, Skill }` takes it too. `Boss: true` on any Enemy selector or `Count` keeps to bosses; `Race` and `Element` to that race or element (the element it has now); `Mob` to that monster, named as an entry names it (AegisName or id, or a list). `{ Enemy: boss, Mob: DARK_LORD }` is Dark Lord and not its Dark Illusions, which are boss-class too and of the same race, element and size; `Count: { Enemy: any, Mob: DARK_LORD, Range: 3, Below: 1 }` is "Dark Lord is not within 3 cells". |
| `{ Ally: dead }` | the nearest fallen party member. |
| `{ Ally: lowest_hp \| nearest \| missing \| having \| attacked, Role, Job, Status, NotSelf, NotOwner, Expiring }` | a party member (the companion included unless `NotSelf`, its owner unless `NotOwner`): the most hurt below 100 %, the nearest, the nearest lacking `Status`, the nearest with it (Status Recovery on the petrified), or the one the monsters in sight are on (a boss counts three times); only those with that `Role` (one, or a list for any of them: `Role: [attacker, support]` is everyone but the tank) or `Job` (a [family](#jobs-and-families), or a list). The owner has no role, so a `Role` leaves it out. A `Cast` passes over a member nobody can see (Hiding, Cloaking), on whom it would be refused every time. `Expiring: ms` widens `missing` to members whose status has less than that left, so a buff is renewed before it lapses; a status without a timer never expires. |

With an `Enemy` selector, `When`'s `enemy_*` tokens ask about the chosen monster,
so `not_enemy_provoke` means "that one is not provoked yet". With an `Ally`
selector, `ally_*` tokens ask about the chosen member.

A tank that peels:

```yaml
- Name: peel
  Priority: 80
  Requires: { Role: tank }
  Cast: SM_PROVOKE
  Target: { Enemy: attacking, Who: party, NotSelf: true, Prefer: support }
  When: not_enemy_provoke
  SetTarget: true
  OnePerParty: true
```

Provoke fails on status-immune monsters, bosses among them, and on Undead.

### Regular shells

The AI characters walking the world pick their skills from a rotation too, and
cast whatever comes next at whatever they fight. A plan marked `For: shells` is
theirs (`For: all`: theirs and companions'; `For: companions` is the default):

```yaml
- Mob: All
  Jobs:
    - Job: Wizard
      Build: shells_aoe           # a Build of its own, apart from the companions' Wizard plan
      For: shells
      Start: single
      Strategies:
        - Name: single            # one monster: no area spells
          Ban: [WZ_STORMGUST, WZ_METEOR, WZ_VERMILION, WZ_HEAVENDRIVE]
          Rules:
            - { Name: pack, Count: { Around: target, Range: 4, AtLeast: 3 }, Switch: pack }
        - Name: pack
          Rules:
            - { Name: no_pack, Count: { Around: target, Range: 4, Below: 3 }, Switch: single }
```

What differs for them:
- They have no owner, so rules about the owner (`Target: owner`,
  `Retreat: owner`, `master_*`, `owner_hp_below`) never apply.
- Their party is the synthetic one every shell on a map shares: for them, party
  members are the shells of it within sight, and a `Signal` reaches every shell
  of the map's crowd.
- `Targeting` (Priority, Ignore, MaxAttackers) and holding position against
  following are companion things; regular shells choose targets the way they
  always did, and a rule's `SetTarget` changes the current one.
- Trace one by typing its name and `trace` in your party chat while it is in
  sight; the trace comes to you.

The ambient crowd only takes combat turns while a player has it in view, but that
is still dozens of shells on a busy map: keep their plans short.

### Holding position

A companion normally follows its owner: once it is more than a few cells away,
it walks back, and when idle it takes its place in the formation around the
owner. A rule that positions it (`Hold`, `MoveTo`, `KeepDistance`, `Retreat`,
`Leave`, or standing where a `MoveTo` wants it) holds it there for 0.6 s,
renewed every turn the rule still applies. While it holds, following leaves it
where it is. When no rule holds it any more, it follows again within a turn.

The warps are never held back. A companion still follows its owner to another
map, and is still pulled back once the owner is out of sight.

### Combos

Chain Combo, Combo Finish, Glacier Fist, Chain Crush and the Taekwon kicks are
cast inside the previous step's after-cast delay, as a player does. rAthena checks
the order itself, so list the steps **last first**: a step out of order is
refused and the next rule is tried in the same turn. A combo Monk wants
`Rotation: false`, because a combo starts from a plain hit (Triple Attack).

## Strategies: a state machine per plan

Each plan is a small state machine. `Strategies` are the states, `Start` is
the first, and `Switch` moves between them. Rules outside any strategy apply in
all of them. Names are yours: `approach`, `defend`, `defend_earthquake`.

A strategy can also limit the skill rotation while it is active, with its own
`Ban` (added to the plan's) and `Rotation` (overriding the plan's). That is how a
companion answers a boss that reflects magic:

```yaml
      - Job: Wizard
        Start: normal
        Strategies:
          - Name: normal
            Rules:
              - { Name: mirror_up, When: enemy_magicmirror, Switch: mirrored }
          - Name: mirrored            # no spells while it reflects them
            Rotation: false
            Rules:
              - { Name: mirror_down, When: not_enemy_magicmirror, Switch: normal }
```

A monster's plan starts over in `Start` with every new monster of that kind.
A `Mob: All` plan keeps its strategy until a rule switches it. A `Switch` takes
effect in the same turn: the companion starts again from the top with the new
strategy's rules (at most three switches a turn, so two rules switching back and
forth cannot hang it).

```yaml
        Start: approach
        Strategies:
          - Name: approach
            Rules:
              - { Name: charge, When: self_spheres_lt5, Cast: MO_CALLSPIRITS }
              - { Name: engage, When: enemy_distance_le2, Switch: fight }
          - Name: fight
            Rules:
              - { Name: investigate, When: self_spheres_ge1, Cast: MO_INVESTIGATE }
```

## Events

| `On:` | Fires once when... | `event` is |
|---|---|---|
| `casts` `{ By, Skill, At }` | someone starts casting (that skill). `By`: `monster` (default), `party` (the companion included), `self`, `enemy`, `anyone`. `At`: who it is aimed at, `party` (default for monsters and enemies), `self`, `owner`, `anyone` (default otherwise). Ground spells count as aimed at whoever stands within 3 cells. A cast at the caster itself (a summon, Power Up, a heal) passes the default `At`. `monster_casts` is `casts` with `By: monster`. | who it is cast at; `source` is the caster; `MoveTo: event_cell` is where it lands |
| `encounter_ended` `{ Mob, Reason, Boss }` | an encounter monster (or the boss a `Mob: Boss` plan was for) that was near is not any more. `Reason: died` (dead or removed), `vanished` (alive but teleported, out of sight or on another map), or `any`. `Boss: true` only for a boss-class monster, `false` only for an ordinary one: a monster plan with `Encounter: true` makes every kill an encounter's end, and "the boss teleported, regroup" is not meant for those. Its own plan has stopped applying by then, so put the rule under `Mob: All`. | the monster |
| `target_lost` `{ Reason, Boss }` | the companion's target is gone the same ways. Switching to another target does not count. | the monster |
| `signal` `{ Name, From }` | another companion of the party sends `Signal: Name`. `From: anyone` also hears its own. | who sent it |
| `party_chat` `{ Match, From }` | a party member's line contains `Match` (any case). `From: anyone` (default), `owner` or `leader`. | who said it |
| `party_member_died` | a party member on the map dies. | who died |
| `hp_below` / `owner_hp_below` `{ Value }` | the companion's, or its owner's, HP drops below `Value` %. | the companion / the owner |
| `weight_above` `{ Value }` | its weight goes over `Value` %. | the companion |
| `equip_broken` `{ Slot }` | something it wears breaks. `Slot`: `weapon`, `shield`, `armor`, `garment`, `shoes`, `head_top/mid/low`, `accessory_left/right`, `any`. | the companion |
| `item_below` `{ Item, Value }` | it carries fewer than `Value` of an item (with Companion inventory on, its own bag). | the companion |
| `status_gained` `{ Status }` | it gets a status. | the companion |

Only skills with a cast time can be seen coming: an instant skill has landed
before anything could react.

### When the boss calls its slaves

Phreeoni's summon (`NPC_SUMMONSLAVE`) has a 0.7 s cast. A Wizard can start its
AoE as the summon starts, on the boss, where the slaves appear:

```yaml
- Mob: PHREEONI
  Jobs:
    - Job: Wizard
      Rules:
        - Name: aoe_on_summon
          Priority: 60
          On: { Event: casts, Skill: NPC_SUMMONSLAVE, Within: 4000 }
          Cast: WZ_STORMGUST
          Target: source          # a ground spell lands at the caster's feet
```

### Gathering on a signal

One companion watches, the others come to it. A Sage that sees a monster begin
a Storm Gust tells the party and lays Land Protector at its own feet; its 5 s
cast is the time the others have to arrive:

```yaml
- Mob: All
  Jobs:
    - Job: Sage
      Rules:
        - Name: lp_for_the_group
          Priority: 90
          On: { Event: casts, Skill: WZ_STORMGUST }
          Cast: SA_LANDPROTECTOR
          Target: self
          Signal: on_me
          Say: "On me!"
    - Job: All
      Rules:
        - Name: gather
          Priority: 88
          On: { Event: signal, Name: on_me }
          MoveTo: event              # next to the Sage; holds there while it applies
```

The signal goes out only once the Land Protector cast has started, so nobody
walks to a Sage who could not cast it.

### Not making a boss teleport

Most bosses teleport away when hit by someone they cannot fight back against. A
companion can check before it attacks, and step to where the boss could reach it:

```yaml
- Mob: All
  Jobs:
    - Job: All
      Rules:
        - Name: no_rude_attack
          Priority: 98
          Enemy: { Boss: true }
          Reach: false
          MoveTo: reachable
        - Name: no_rude_attack_hold   # nowhere it could reach: do not hit it at all
          Priority: 97
          Enemy: { Boss: true }
          Reach: false
          Hold: true
```

### Standing on a party member's Land Protector

```yaml
- Mob: All
  Jobs:
    - Job: Wizard
      Rules:
        - Name: lp_incoming          # the Sage is still casting: go where it will land
          Priority: 85
          On: { Event: casts, By: party, Skill: SA_LANDPROTECTOR }
          MoveTo: event_cell
        - Name: onto_lp              # it is down: get onto it, and stay
          Priority: 84
          MoveTo: { Field: SA_LANDPROTECTOR, Owner: party, Within: 8 }
```

Land Protector also stops ground skills inside it, the companion's own
included. A rule for Safety Wall or Blaze Shield can check
`Field: { Skill: SA_LANDPROTECTOR, Owner: anyone, Range: 0, Below: 1 }` first.
Standing on it counts as holding position (below), so the Wizard stays while
its owner moves about on the same screen.

## Targeting

`Targeting` on a monster changes which monster a companion takes on, never
whether it fights:

- `Priority: n` takes it before lower-priority monsters already in the party's
  fight (in Attack mode, any monster within 12 cells of the owner).
- `Ignore: true` leaves it alone unless the owner fights it or it attacks the
  party.
- `MaxAttackers: n` puts at most `n` of the party on it: the owner counts, then
  companions in a fixed order (lower ids first), and the rest take another
  monster or wait. For bosses that answer a crowd with an AoE (`attackpcge`).
  rAthena counts every unit targeting the boss; this counts the party.

Passive companions are never affected.

## More than one mod

The app combines every enabled mod's table into one, in mod order. A later mod
adds to what an earlier one said:

| A later entry... | |
|---|---|
| with a rule whose `Name` exists | replaces that rule |
| with a rule `Name: x, Remove: true` | deletes rule `x` |
| with new rules, strategies, `Ban` skills | adds them |
| with `Start`, `Rotation`, `Targeting` fields | changes only those |
| with `Reset: true` | starts that monster/job/build over |
| with `Remove: true` | deletes that monster/job/build |

Give rules a `Name` so another mod can replace or remove them. Mind that a
same-named rule from an unrelated mod replaces yours silently. **Prefix the
names** of rules, strategies, signals and claims with your mod's
(`golem_tactics.dodge_stun`, `Signal: golem_tactics.kyrie_me`) unless you mean
to replace or answer another mod's. A later `Allow` replaces
an earlier one in the same plan, while `Ban` lists add up. Both points are open
in the [roadmap](../../COMPANION_STRATEGY_ROADMAP.md#combining-plans-across-mods-name-clashes-and-allow).

## Writing plans that hold up in a fight

Learned in the Phreeoni playtests, each one from something that went wrong.
`examples/mods/companion-tactics` follows all of them.

**Name everything the companion should cast.** A plan about a monster turns the
normal skill rotation off, so the companion casts what the plan names and hits.
A Wizard that "randomly cast Ice Wall" was its rotation; with the plan in charge,
the Wizard needs its damage spell written down (Fire Bolt, the Meteors).

**A caster needs named spells; a ban list is not enough.** Melee did well on its
rotation minus a few skills. A Wizard did not. The rotation casts at the
engine's target, which can be a monster nobody is fighting, and walks into range
of it after every cast. It also takes whatever is ready: Thunder Storm at
nothing, Meteor Storm at a single Sandman. Name the bolts as one `Cast: [..]`
list (the engine picks by element), aim them with selectors at what is on the
party, and keep area spells for a `Count` of three.

**An event starts something; a condition keeps it going.** A rule with `On:` is
answered by its first action. "Walk to the body" as an event took one step, and
then the positioning rules pulled the Priest straight back. The fallen owner lay
10 cells off, out of Resurrection's 9, and was never revived. For a goal that
takes many turns, write a rule that holds while the goal is unmet:
`Target: { Ally: dead }` with `KeepDistance: { Max: 8 }`. Keep the event rule
only for what no selector can see (beyond 14 cells).

**Hold still while being petrified.** A member who runs from a Wide Stone Curse
drags the healer's Status Recovery after it. `When: self_stonewait` and `Hold`.

**End a caster's rules with `Hold`, and then name its buffs.** With nothing to
cast, an ordinary turn walks the companion up to its target and hits it: a
Priest meleeing Phreeoni with its staff. A last, lowest-priority `Hold: true`
stops that. But `Hold` ends the turn before the engine's own buffing and healing
come round, so the buffs the Priest should keep up (Blessing, Increase AGI,
Impositio) are rules too.

**Aim at what is within reach, not at the current target.** A rule's default
target is the companion's current target, which can be across the screen: a
Wizard stood idle because its Fire Bolt aimed at a slave out of range. A selector
(`Target: { Enemy: boss }`, then `{ Enemy: nearest }`) only looks within the
skill's range.

**Place a companion by who it serves, not only by what to avoid.** "At least 6
cells from the boss" left a Priest 12 cells from the people it heals, and with
`Hold` it never came back. Use a band (`KeepDistance: { Min, Max }`) and measure
it from the right one: out of the boss's reach (`Target: { Enemy: boss }`), within
Heal's reach of whoever is hit (`Target: { Ally: attacked }`).

**Low on HP, kite round the healer.** Stepping away from a chasing boss dragged
it off the screen; walking to the healer brings it onto the healer. `Kite` runs
from the monster but stays within the healer's reach, never on top of it.

**Make the rule ask about the right member.** "Whoever is lowest" is not "whoever
is being hit" (`Ally: attacked`), and "a status somewhere" is not "this member
has it" (`Ally: having`, `Ally: missing`).

**Be specific about hidden monsters.** `enemy_hidden` is any hidden monster in
sight, and Phreeoni's Hodes burrow, which is hiding: a Priest cast Ruwach over
and over. Ask for the one that matters within the skill's reach:
`Count: { Enemy: hidden, Boss: true, Range: 2, AtLeast: 1 }`.

**A status that lasts only while standing somewhere is not a guard.** Safety
Wall's effect is there only while the member stands on the wall, and members
move: a Priest re-walled the same Assassin again and again. Ask the ground
(`Field: { Skill: MG_SAFETYWALL, Owner: party, At: target, Range: 0, Below: 1 }`)
and give it a `Cooldown`.

**Keep resources back in absolute terms.** "Heal down to 10 % SP" left a small SP
pool below Resurrection's 60. Write `self_sp_ge70`, not `self_sp_pct_ge10`, when a
specific cast must stay affordable. Companions do not pay catalysts yet, so
nothing else runs out on its own.

**Check every phase of a status.** Stone Curse first sets in (`SC_STONEWAIT`; the
member can still walk) and then holds (`SC_STONE`). Status Recovery cures both;
curing in the first phase saves a member before they are stuck.

**Plan for the healer dying, and for the healer being alone.** Without a rule the
others fight on and die one by one. `Absent: { Ally: nearest, Job: Priest }`
switches to a strategy that falls back to the owner. A Priest left alone needs
the opposite of fleeing: heal itself, wall its own cell, Kyrie, then revive behind
the wall (`Present: { Ally: dead }`). A plan with its own Resurrection rule
replaces the engine's, which would start the cast at once and be broken by every
hit.

**Things the engine does on its own that a plan has to outrank:**
- shells flee from their target below 30 % HP (FleeOnLowHP): a rule that acts at
  low HP comes first;
- an ordinary turn walks up to the target and hits it: `Hold`;
- following the owner and the idle formation step: positional rules hold their
  ground;
- the built-in Party Resurrection: a plan's own Resurrection rule.

**YAML changes need a server restart, not a rebuild.** Only a change to the
engine or the strategy module needs a new server build.

## Finding out what it is doing

In party chat, the owner types the companion's name and `trace`:

    Seraphina trace

The companion then reports to its owner each rule it acts on, each event it
notices, each strategy change, and why a matching rule's cast was not made. The
same line again does not repeat for 3 s.

A refusal says what it was, with the numbers where there are any, because what
to do about it depends on which:

| The trace says | What to do |
|---|---|
| `out of range: 8 > 3` | bring the companion closer (`KeepDistance: { Max }`), or aim at something nearer |
| `no clear line to the target` | a wall is between them: `MoveTo: { Sight: target }` above the cast |
| `the cell is taken: Raydric stands on it` | a trap or field cannot go under a monster or beside a member: `Aim` it at a cell in front of the monster |
| `the cell is taken (another trap or field is there, ...)` | it is already placed, or the skill has as many as it may place |
| `not enough SP: needs 40, has 12` | keep SP back (`When: self_sp_ge40`) |
| `a catalyst is missing: 1 Blue_Gemstone` | stock the bag (Companion inventory) |
| `on cooldown, 12.4 s left` | give the rule that `Cooldown`, or a second skill to fall back on |
| `the wrong weapon for it`, `it must be riding`, `not enough spirit spheres: needs 5, has 2` | a `Requires` or a `When` that asks first |
| `its own state forbids it (silenced, ...)` | nothing to cast with: cure it, or hold |
| `Hela is hidden`, `Poring is dead` | the target cannot be cast at |
| `rAthena refused it (the skill's own check when a cast begins)` | a rule of that one skill; its entry in rAthena's skill code says which |

A trap or a field is checked for its cell before the cast: rAthena itself only
checks when the cast ends, when the catalyst is already spent and nothing is
placed. A companion still in its after-cast delay, or casting, is not reported:
that is every cast's ordinary wait.
Typing it again turns it off.

The server checks the table when it starts. An unknown monster, job, skill, item
or key, a rule with two actions, or a `Start` or `Switch` naming a strategy that
does not exist is reported with its file and line, and that piece is left out.
The rest still loads.

## What it cannot do yet

- **Switch gear.** A plan cannot name gear for a fight (a shield against a
  boss, armour of an element). Using items is built (`UseItem`), and catalysts
  are paid from the bag with Companion inventory on.
[Not done yet](../../COMPANION_STRATEGY_ROADMAP.md#not-done-yet) in the roadmap
describes each of these: why it waits, how it would work, what it would add.

- **Read a status's strength:** only whether it is there, and its counter.
- **Fight players.** Rules match monsters, and the arena's player-versus-AI
  fights do not run them.
- **React to instant skills**, or to anything between two turns that undoes
  itself before the next one.
