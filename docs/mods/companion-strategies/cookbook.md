# Companion strategies: cookbook

Short recipes, by what you want a companion to do. Each one goes into a job
entry's `Rules:` (or a strategy's) in your mod's `db/population_strategy.yml`.
Each is taken from the example mods, where it loads without warnings. The ones
from the Phreeoni plan have been played; others, the undead rules among them,
not yet. Adjust names, priorities and numbers to your plan. The
[guide](guide.md) explains the parts; [team play](team.md) has the priority bands.

**Healing and support**
- [Heal whoever is being hit](#heal-whoever-is-being-hit)
- [Keep buffs up on the party](#keep-buffs-up-on-the-party)
- [Buff the party, not the player](#buff-the-party-not-the-player)
- [Protect everyone but the tank](#protect-everyone-but-the-tank)
- [Wall a member before a stun lands](#wall-a-member-before-a-stun-lands)
- [Walk to the fallen and revive](#walk-to-the-fallen-and-revive)
- [Cure petrification](#cure-petrification)

**Positioning**
- [Stand still instead of melee](#stand-still-instead-of-melee)
- [Out of the boss's reach, within the party's](#out-of-the-bosss-reach-within-the-partys)
- [Low on HP: kite round the healer](#low-on-hp-kite-round-the-healer)
- [Leave hostile ground](#leave-hostile-ground)
- [Sit down to regenerate between fights](#sit-down-to-regenerate-between-fights)
- [Don't make a boss teleport](#dont-make-a-boss-teleport)
- [Stand inside a Land Protector, not on its rim](#stand-inside-a-land-protector-not-on-its-rim)
- [Step out from behind a wall](#step-out-from-behind-a-wall)
- [An Ice Wall between you and what is coming](#an-ice-wall-between-you-and-what-is-coming)

**Damage**
- [A bolt by element at what is on the party](#a-bolt-by-element-at-what-is-on-the-party)
- [Area spells only on a pack](#area-spells-only-on-a-pack)
- [Go for the boss, but take slaves off the healer](#go-for-the-boss-but-take-slaves-off-the-healer)
- [Two of a kind: split the targets](#two-of-a-kind-split-the-targets)
- [Turn heals on the undead](#turn-heals-on-the-undead)
- [Interrupt only the casts that matter](#interrupt-only-the-casts-that-matter)
- [A Fire Wall in its path](#a-fire-wall-in-its-path)
- [A trap in front of it, not under it](#a-trap-in-front-of-it-not-under-it)
- [An area spell where the pack will be](#an-area-spell-where-the-pack-will-be)
- [Two builds of one class](#two-builds-of-one-class)

**Boss mechanics**
- [Phases on the boss's HP](#phases-on-the-bosss-hp)
- [Change tactic when a phase drags on](#change-tactic-when-a-phase-drags-on)
- [React to a cast](#react-to-a-cast)
- [Fall back when the healer is down](#fall-back-when-the-healer-is-down)
- [That boss, not its miniboss slaves](#that-boss-not-its-miniboss-slaves)
- [Regroup when a boss teleports, not after every kill](#regroup-when-a-boss-teleports-not-after-every-kill)

**Items**
- [Drink, cure and endow from the bag](#drink-cure-and-endow-from-the-bag)

**Talking**
- [Ask another companion for something](#ask-another-companion-for-something)
- [Answer the player in party chat](#answer-the-player-in-party-chat)

**Limiting the engine**
- [Only these skills at a boss](#only-these-skills-at-a-boss)
- [Casters never melee](#casters-never-melee)
- [Do one role rule differently for one boss](#do-one-role-rule-differently-for-one-boss)
- [Regular AI characters: area spells only for packs](#regular-ai-characters-area-spells-only-for-packs)

---

## Heal whoever is being hit

```yaml
- Name: heal_attacked
  Priority: 78
  Cast: AL_HEAL
  Target: { Ally: attacked }          # whoever the monsters are on
  When: [ally_hp_pct_lt85, self_sp_ge70]
- Name: heal_low
  Priority: 77
  Cast: AL_HEAL
  Target: { Ally: lowest_hp }         # then whoever is lowest
  When: [ally_hp_pct_lt55, self_sp_ge70]
```

`self_sp_ge70` keeps SP back for Resurrection (60). An ally that Heal can't
help (undead armor) is passed over automatically.

## Keep buffs up on the party

```yaml
- Name: blessing
  Priority: 50
  Cast: AL_BLESSING
  Target: { Ally: missing, Status: SC_BLESSING, Expiring: 3000 }   # without it, or under 3 s left
  When: self_sp_ge120
```

`Expiring` renews the buff before it lapses rather than after. Needed whenever
the plan ends in `Hold`: `Hold` ends the turn before the engine's own buffing
would come round.

## Buff the party, not the player

`NotOwner` leaves the owner out: for a player who buffs differently, or who
cannot be buffed at all.

```yaml
- Name: bless_the_party
  Priority: 45
  Cast: AL_BLESSING
  Target: { Ally: missing, Status: SC_BLESSING, NotOwner: true, Expiring: 3000 }
```

## Protect everyone but the tank

A `Role` list is any of them. The owner has no role, so it is left out too:

```yaml
- Name: wall_the_squishy
  Priority: 90
  Cast: MG_SAFETYWALL
  Target: { Ally: attacked, Role: [attacker, support] }
  Cooldown: 4000
```

## Wall a member before a stun lands

```yaml
- Name: wall_the_stunned
  Priority: 80
  On: { Event: monster_casts, Skill: NPC_STUNATTACK, At: party }
  Cast: MG_SAFETYWALL
  Target: event                        # whoever it is aimed at
  OnePerParty: true
```

Only skills with a cast time can be seen coming.

## Walk to the fallen and revive

```yaml
- Name: wall_before_rez                # with something on it, a hit breaks the cast
  Priority: 108
  Present: { Ally: dead, Range: 9 }
  When: [self_targeted, not_self_safetywall]
  Cast: MG_SAFETYWALL
  Target: self
- Name: resurrect
  Priority: 106
  When: { OR: [self_safetywall, not_self_targeted] }
  Cast: ALL_RESURRECTION
  Target: dead_ally
  Say: "Getting you up, {ally}!"
- Name: close_to_the_fallen            # every turn until within Resurrection's 9
  Priority: 104
  Target: { Ally: dead, NotSelf: true }
  KeepDistance: { Min: 1, Max: 8 }
```

Write the walk as a condition, not as `On: party_member_died`: an event rule is
done after one step.

## Cure petrification

```yaml
- Name: unstone_early                  # while it is still setting in
  Priority: 102
  Cast: PR_STRECOVERY
  Target: { Ally: having, Status: SC_STONEWAIT }
- Name: unstone
  Priority: 101
  Cast: PR_STRECOVERY
  Target: { Ally: having, Status: SC_STONE }
```

And for everyone, so they don't run from the cure:

```yaml
- Name: wait_for_the_cure
  Priority: 100
  When: self_stonewait
  Present: { Ally: nearest, Job: Priest, NotSelf: true }
  Hold: true
```

## Stand still instead of melee

The last rule of a healer or caster:

```yaml
- Name: no_melee
  Priority: 1
  Present: { Enemy: attacking, Range: 14 }   # only while something is on the party
  Hold: true
```

Without the `Present` it would also hold when the fight has moved away, and get
left behind. For "never plain-attack at all", see
[Casters never melee](#casters-never-melee).

## Out of the boss's reach, within the party's

```yaml
- Name: stay_back
  Priority: 74
  Target: { Enemy: boss, Range: 14 }
  KeepDistance: 5                      # at least 5 from the boss
- Name: stay_near_the_hit
  Priority: 73
  Target: { Ally: attacked, NotSelf: true, Range: 14 }
  KeepDistance: { Min: 1, Max: 7 }     # within Heal's reach of them
- Name: stay_with_the_party
  Priority: 72
  Target: { Ally: nearest, NotSelf: true, Range: 14 }
  KeepDistance: { Min: 1, Max: 7 }
```

A caster wants a band off the boss instead: `KeepDistance: { Min: 6, Max: 8 }`.

## Low on HP: kite round the healer

```yaml
- Name: kite_round_the_healer
  Priority: 60
  When: self_hp_pct_lt30
  Target: { Ally: nearest, Job: Priest, NotSelf: true, Range: 14 }
  Kite: { Away: 4, Within: 7, Gap: 3 }     # away from the boss, near the healer, never onto it
- Name: go_to_the_healer               # nothing chasing it: just go and stand there
  Priority: 59
  When: self_hp_pct_lt30
  Target: { Ally: nearest, Job: Priest, NotSelf: true, Range: 14 }
  KeepDistance: { Min: 1, Max: 4 }
- Name: wait_for_heal
  Priority: 58
  When: self_hp_pct_lt30
  Present: { Ally: nearest, Job: Priest, NotSelf: true, Range: 14 }
  Hold: true
```

These come before the engine's own flee below 30 % HP, which would run it off
the screen.

## Sit down to regenerate between fights

Sit below 30 % SP when nothing is on the party, and get up at 80 % or as soon as
something comes for it. A strategy holds the "until":

```yaml
- Mob: All
  Jobs:
    - Job: All
      Start: up
      Strategies:
        - Name: up
          Rules:
            - Name: tired
              When: self_sp_pct_lt30
              Absent: { Enemy: attacking, Range: 14 }   # nothing on the party
              Switch: resting
        - Name: resting
          Rules:
            - Name: rested
              Priority: 6
              When: { OR: [self_sp_pct_ge80, self_targeted] }
              Switch: up
            - Name: rest
              Priority: 5
              Sit: true
```

A companion never sits while its owner walks, and stands up before any other
rule acts. Sitting also switches on what a player gets from it: two Rogues with
**Gangster's Paradise** sitting side by side are left alone by monsters, and a
Taekwon's **Peaceful Break** and **Happy Break** regenerate faster. This recipe
loads cleanly but hasn't been played yet.

## Leave hostile ground

```yaml
- Name: leave_hostile_ground
  Priority: 99
  Leave: { Owner: monster }            # out of Storm Gust, Meteor Storm, traps
```

## Don't make a boss teleport

Most bosses teleport when hit by someone they can't fight back against. `Reach:
false` holds only where rAthena would really answer the hit: the monster is out
of reach and has a `rudeattacked` skill for the state it is in. A boss busy with
the tank, or one with no such skill, does not hold anyone back:

```yaml
- Name: no_rude_attack
  Priority: 98
  Enemy: { Boss: true }
  Reach: false
  MoveTo: reachable                    # to where it could reach us
- Name: no_rude_attack_hold
  Priority: 97
  Enemy: { Boss: true }
  Reach: false
  Hold: true                           # nowhere: don't hit it at all
```

## Stand inside a Land Protector, not on its rim

A Meteor Storm that lands beside a Land Protector still hits whoever stands on
its edge. `Depth` asks for a cell that many cells inside:

```yaml
- Name: into_the_lp
  Priority: 84
  MoveTo: { Field: SA_LANDPROTECTOR, Owner: party, Within: 12, Depth: 3 }
```

Three deep is the middle 5x5 of a level 5 Land Protector. A smaller field gives
its deepest cells.

## Step out from behind a wall

A cast needs a clear line. A caster with a tree or a corner between it and its
target has every cast refused, and with a last `Hold` rule it stands there. Put
this above the casts:

```yaml
- Name: into_the_clear
  Priority: 61
  MoveTo: { Sight: target, Within: 8, Range: 8 }   # Range: the spell's reach
```

It steps to the nearest cell from which its current target is in the clear, and
passes once it stands on one. For a healer, give it the member: `Target: { Ally:
attacked }`.

## An Ice Wall between you and what is coming

A ground spell lands at its target's feet: an Ice Wall aimed at a monster goes
up on the monster, not in its way. `Aim` puts it on the line between the two:

```yaml
- Name: wall_it_off
  Priority: 78
  Cast: WZ_ICEWALL
  Target: { Enemy: attacking, Who: self }       # what is coming for me
  Aim: { Cells: 3 }                             # three cells from me, toward it
  Field: { Skill: WZ_ICEWALL, Owner: self, Range: 5, Below: 1 }   # none standing yet
  Cooldown: 3000
```

With the monster three cells off or closer there is no cell between the two that
far out, and the rule does not cast. The `Field` condition keeps it to one wall
at a time. Ice Wall blocks shots as
well as steps: follow it with a spell that needs no line (Storm Gust, Heaven's
Drive on a cell), or [step to a clear line](#step-out-from-behind-a-wall).

## A bolt by element at what is on the party

```yaml
- Name: bolt_my_attacker
  Priority: 43
  Cast: [MG_COLDBOLT, MG_FIREBOLT, MG_LIGHTNINGBOLT, WZ_EARTHSPIKE, MG_SOULSTRIKE]
  Target: { Enemy: attacking, Who: self }
  When: self_sp_pct_ge15
- Name: bolt_the_boss
  Priority: 41
  Cast: [MG_COLDBOLT, MG_FIREBOLT, MG_LIGHTNINGBOLT, WZ_EARTHSPIKE, MG_SOULSTRIKE]
  Target: { Enemy: boss }
  When: self_sp_pct_ge15
```

A `Cast:` list casts the one the target is weakest to; ties go to list order.
Selectors only look within the spell's range, so the caster never aims at
something across the screen, nor at a monster nobody is fighting.

## Area spells only on a pack

```yaml
- Name: aoe_the_pack
  Priority: 45
  Cast: [WZ_METEOR, WZ_STORMGUST, WZ_VERMILION, WZ_HEAVENDRIVE]
  Target: { Enemy: attacking }
  Count: { Enemy: attacking, Around: target, Range: 3, AtLeast: 3 }
  When: self_sp_pct_ge30
  Cooldown: 5000
```

## Go for the boss, but take slaves off the healer

```yaml
- Name: guard_the_healer
  Priority: 57
  Target: { Enemy: attacking, Job: Priest }
  SetTarget: true
  OnePerParty: true                    # one of the melee, not all of them
- Name: focus_boss
  Priority: 30
  Target: { Enemy: boss, Range: 12 }
  SetTarget: true
```

`SetTarget` only chooses the target; the engine (or a skill rule) does the
hitting.

## Two of a kind: split the targets

With two Wizards or two Priests in the party, claims keep them from doubling up:

```yaml
- Name: freeze_one
  Priority: 44
  Cast: MG_FROSTDIVER
  Target: { Enemy: attacking }         # passes over a monster the other Wizard claimed
  Claim: frozen
- Name: lex_once
  Priority: 45
  Cast: PR_LEXAETERNA
  Target: { Enemy: boss }
  When: not_enemy_aeterna
  Claim: { Name: lex, For: 10000 }     # the second Priest leaves the boss's Lex to the first
```

Any rule with the same claim name respects it, across plans and mods. Loads
cleanly; not played yet.

## Turn heals on the undead

In a plan for `Mobs: [{ Race: Undead }, { Element: Undead }]`:

```yaml
- Name: resurrect_the_undead           # destroys it; a boss shrugs it off
  Priority: 66
  Cast: ALL_RESURRECTION
  Target: { Enemy: attacking, Race: Undead }
  When: [not_enemy_is_boss, self_sp_ge150]
- Name: heal_the_undead
  Priority: 61
  Cast: AL_HEAL
  Target: { Enemy: attacking, Race: Undead }
  When: self_sp_ge120
```

Sanctuary is never placed where a living (not undead, not demon) monster would
stand in it and be healed.

## Interrupt only the casts that matter

`Skill` narrows `Enemy: casting` to the casts worth a Double Strafe, for as long
as the cast lasts (an `On: casts` event fires once):

```yaml
- Name: interrupt_thunder
  Priority: 70
  Cast: AC_DOUBLE
  Target: { Enemy: casting, Skill: [WZ_JUPITEL, MG_THUNDERSTORM] }
```

## A Fire Wall in its path

By the time a cast is done, a walking monster is no longer where it was. `Lead`
aims where its walk will have brought it, by its speed and the companion's cast
time:

```yaml
- Name: firewall_ahead
  Priority: 66
  Cast: MG_FIREWALL
  Target: { Enemy: attacking, Who: self }
  Aim: { Cells: 2, From: target, Lead: true }   # two cells in front of where it will be
  Cooldown: 2500
```

A monster that stands still is where it is, and `Lead` changes nothing.

## A trap in front of it, not under it

A trap cannot be laid on a cell a monster stands on (the trace: `the cell is
taken: Dark Lord stands on it`). Lay it where the monster is about to step:

```yaml
- Name: snare_its_path
  Priority: 72
  Cast: HT_ANKLESNARE
  Target: { Enemy: boss, Mob: DARK_LORD, Range: 9 }
  Aim: { Cells: 2, From: target, Lead: true }
  Cooldown: 6000
```

Ankle Snare needs two free cells round it: `Cells: 2` from the target, no less.

## An area spell where the pack will be

Storm Gust takes its time. Against monsters walking in, cast it where they will
be when it lands:

```yaml
- Name: gust_the_pack
  Priority: 50
  Count: { Around: target, Range: 4, AtLeast: 3 }
  Cast: WZ_STORMGUST
  Target: { Enemy: nearest }
  Aim: { Lead: true }
```

## Two builds of one class

Every companion has its class's whole skill tree, so the owner's skill
selection (the companion window, or `@companion skills <name> toggle <skill>`)
is what tells builds apart. An unticked skill counts as one the companion lacks:

```yaml
- Job: Monk
  Build: asura
  Requires: { Lacks: [MO_CHAINCOMBO] }     # Chain Combo unticked
  Rules: [...]
- Job: Monk
  Build: combo
  Requires: { Skills: [MO_CHAINCOMBO] }
  Rules: [...]
```

## Phases on the boss's HP

```yaml
- Mob: PHREEONI
  Encounter: true
  Jobs:
    - Job: All
      Start: opening
      Strategies:
        - Name: opening
          Rules:
            - Name: to_stone
              Target: { Enemy: boss }          # ask about the boss, not a slave
              When: enemy_hp_pct_lt80
              Switch: stone
              Say: "It's at 80%, petrify from here on."
        - Name: stone
          Rules:
            - Name: to_last
              Target: { Enemy: boss }
              When: enemy_hp_pct_lt30
              Switch: last
        - Name: last
          Rules: [...]
```

## Change tactic when a phase drags on

```yaml
- Name: drags_on
  InStrategy: { AtLeast: 60000 }       # a minute in this phase
  Switch: plan_b
  Say: "This takes too long, changing tactic."
- Name: opening_burst
  Priority: 50
  InFight: { Below: 5000 }             # only in the first 5 s of a fight
  Cast: WZ_METEOR
  Target: { Enemy: boss }
```

Loads cleanly; not played yet.

## React to a cast

```yaml
- Name: meteor_the_slaves
  Priority: 85
  On: { Event: casts, Skill: NPC_SUMMONSLAVE, Within: 10000 }
  Cast: WZ_METEOR
  Target: source                       # the boss: a ground spell lands at its feet
  Count: { Enemy: slaves, Around: target, Range: 5, AtLeast: 3 }
```

The event opens a window, here 10 s. The rule fires once within it, as soon as
its other conditions hold: here, once three slaves stand around the boss. Make
the window longer than the companion's own longest cast.

## Fall back when the healer is down

```yaml
      Start: fight
      Rules:
        - Name: healer_down
          Priority: 105
          On: party_member_died
          Present: { Ally: dead, Job: Priest }       # a Priest died...
          Absent: { Ally: nearest, Job: Priest }     # ...and no other is up
          Switch: fallback
      Strategies:
        - Name: fight
        - Name: fallback
          Rotation: false
          Rules:
            - { Name: healer_back, Priority: 103, Target: { Ally: nearest, Job: Priest }, Switch: fight }
            - { Name: to_owner, Priority: 102, Retreat: owner }
            - { Name: stand, Priority: 101, Hold: true }
```

## That boss, not its miniboss slaves

`{ Enemy: boss }` is any boss-class monster, and Dark Lord's Dark Illusions are
boss-class too, of the same race, element and size. `Mob` names the one:

```yaml
- Name: off_the_boss
  Priority: 74
  Target: { Enemy: boss, Mob: DARK_LORD, Range: 14 }
  KeepDistance: 4
- Name: pneuma_when_it_is_not_on_me
  Priority: 72
  Count: { Enemy: any, Mob: DARK_LORD, Range: 3, Below: 1 }
  Cast: AL_PNEUMA
  Target: self
```

## Regroup when a boss teleports, not after every kill

A monster plan with `Encounter: true` makes every kill the end of an encounter.
`Boss: true` keeps a rule for bosses:

```yaml
- Name: boss_gone_regroup
  Priority: 95
  On: { Event: encounter_ended, Reason: vanished, Boss: true }
  Retreat: owner
```

## Drink, cure and endow from the bag

`UseItem` uses an item the companion carries (Settings → Population → Companion
inventory, and the bag filled by trade). A companion without the item does not
have the rule. Say when, or it uses the next one as soon as it may:

```yaml
- Name: awakening
  Priority: 60
  When: not_self_aspdpotion1
  UseItem: Awakening_Potion
- Name: cure_poison
  Priority: 95
  When: self_poison
  UseItem: [Panacea, Green_Potion]         # the first one it carries
- Name: wind_against_water
  Priority: 58
  Enemy: { Element: Water }
  When: not_self_enchantarms
  UseItem: Elemental_Wind
```

A trap is an item too, but a skill's own cost: Ankle Snare takes its trap from
the bag when it is cast, with no `UseItem`.

## Ask another companion for something

The one asking:

```yaml
- Name: ask_for_kyrie
  Priority: 30
  When: self_hp_pct_ge90
  Signal: kyrie_me
  Cooldown: 6000
```

The one answering:

```yaml
- Name: kyrie_on_request
  Priority: 90
  On: { Event: signal, Name: kyrie_me, Within: 4000 }
  Target: event                        # who asked
  When: not_ally_kyrie
  Cast: PR_KYRIE
```

Signals reach the other companions of the party. The Stalactic Golem duo in
companion-tactics uses this pair.

## Answer the player in party chat

```yaml
- Name: wall_on_request
  Priority: 70
  On: { Event: party_chat, Match: "wall me" }
  Cast: MG_SAFETYWALL
  Target: event                        # who said it
  Say: "Wall on {ally}!"
```

## Only these skills at a boss

On the job entry:

```yaml
- Mob: Boss
  Jobs:
    - Job: Knight
      Allow: [KN_PIERCE, KN_BOWLINGBASH, KN_TWOHANDQUICKEN]
```

The engine then casts only these on its own near a boss. `Allow: []` means
nothing: only the plan's rules cast. To forbid one skill everywhere, use
`Ban: [MG_FIREWALL]`. (A Knight allowlist is an illustration; no example mod
has one.)

## Casters never melee

```yaml
- Mob: All
  Jobs:
    - Job: [Priest, Wizard, Sage]
      For: all                         # the AI characters around the world too
      Attack: false
    - Job: [Acolyte, Mage]
      Exact: true                      # not the Monks built on the Acolyte
      For: all
      Attack: false
```

## Do one role rule differently for one boss

The role's `stay_back` keeps a healer 5 cells off; the slow golem only needs 4:

```yaml
- Mob: STALACTIC_GOLEM
  Encounter: true
  Jobs:
    - Job: Priest
      Disable: [stay_back]             # the role's rule of that name
      Rules:
        - Name: stay_back              # this plan's own takes its place
          Priority: 74
          Target: { Enemy: boss, Range: 14 }
          KeepDistance: 4
```

## Regular AI characters: area spells only for packs

```yaml
- Mob: All
  Jobs:
    - Job: Wizard
      Build: shells_aoe
      For: shells
      Start: single
      Strategies:
        - Name: single
          Ban: [WZ_STORMGUST, WZ_METEOR, WZ_VERMILION, WZ_HEAVENDRIVE]
          Rules:
            - { Name: pack, Count: { Around: target, Range: 4, AtLeast: 3 }, Switch: pack }
        - Name: pack
          Rules:
            - { Name: no_pack, Count: { Around: target, Range: 4, Below: 3 }, Switch: single }
```
