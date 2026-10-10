# Companion strategies: roadmap

What companion strategies (`db/population_strategy.yml`,
[docs/mods/companion-strategies/](mods/companion-strategies/README.md)) have, and
what they still need. The first part is the state of things. The second,
[Not done yet](#not-done-yet), is written so that each open item can be picked
up later without this conversation: what is missing, why it was not done now,
how it would work, what it would add, and where to start.

## Status

| # | Item | Status |
|---|---|---|
| 1 | Holding position wins over following | built, played (Phreeoni) |
| 2 | Leaving hostile ground (`Leave:`) | built, not yet played |
| 3 | Choosing who to help or fight (selectors, `SetTarget`) | built, played (Phreeoni) |
| 4 | Items and gear | [inventories](#inventories-the-foundation), catalysts and [using items](#using-items) (`UseItem`) built; [switching gear](#switching-gear-to-the-situation) **not done** |
| 5 | [Time and memory](#5-time-and-memory) | step 1 (time in strategy and fight, renewing before a status lapses) built, not yet played; step 2 (flags and counters) **not done** |
| 6 | Companions coordinating | signals and claims built, not yet played; role plans built and played; [roles that change in a fight](#6-coordination-roles-that-change-in-a-fight-and-claims) **not done** |
| 7 | Boss mechanics (MVP survey, A to F) | built; phases, reacting to a summon and revealing a hidden boss played |
| 8 | [AI raid parties](#8-ai-raid-parties) | **not done** |

Built since the list was first written, and played against Phreeoni unless
noted:
- role plans for any boss (`Mob: Boss`, `examples/mods/companion-roles`), with
  the role taken from the class family and overridden by the party-chat Duty;
- `Job:` lists and class families;
- layered `Rotation`; `Allow` and `Ban`, which also bind the engine's own heals
  and buffs; `Attack: false` and `Exact` (not yet played);
- `Cast:` lists, which pick a spell by element;
- kinds of monster (`Mob: { Race, Element }`) and `Disable` (not yet played);
- `Sit: true`, sitting down while a rule applies and standing up when none does
  (not yet played).

Engine fixes along the way, active with or without plans:
- a companion that cannot move takes no turn;
- Sanctuary is never placed where it would heal a monster;
- healers pass over allies their heals cannot help (undead armour).

**Phreeoni has been beaten** by a Priest, a Wizard and an Assassin Cross beside
their owner, with companion-roles and companion-tactics. See
[Playtest: Phreeoni](#playtest-phreeoni).

# Built

## 1. Holding position wins over following

**The problem.** Owner-follow and its leash run before the companion's turn
(`pop_companion_follow_owner`). The companion loop also stops an idle
companion's walk and sends it to its formation cell. So `Hold`, `MoveTo`,
`KeepDistance`, `Retreat` and `Leave` lost as soon as the owner walked a few
cells away. Standing on a Land Protector or in a ring of Blaze Shield could not
last.

**What it does.** A rule that positions the companion holds it there for a
moment (`population_strategy_holds_position`). While it holds:

- the leash does not walk it back;
- the idle formation step does not move it;
- the idle stop does not cancel the walk the rule started.

Each positional action (or standing where `MoveTo` wanted it) renews the hold.
When no positional rule applies any more, following resumes within a turn.

**What it does not do.** It never stops the warps: a companion still follows its
owner to another map, and is still pulled back once the owner is out of sight
(`AREA_SIZE + 2`). Holding is for a fight on one screen, not a way to leave a
companion behind.

## 2. Leaving hostile ground

`Leave: { Field, Owner, Within }`. If the companion stands on a ground unit
placed by `Owner` (default `enemy`: anyone outside the party, monsters
included), it walks to the nearest free cell with none. `Field` narrows it to
one skill (Storm Gust, Meteor Storm, a trap); without it, any such unit counts.
Not standing on one: the rule passes.

## 3. Choosing who to help or fight

The case that drives it: **a tank that provokes whatever is hitting someone
else.** Today a rule's `Target` is fixed (`enemy`, `owner`, `event`...), so a
tank can only provoke what it already fights.

**Monster selectors** for `Target`, picked deterministically (closest to the
companion, then lowest id):

```yaml
- Name: peel
  Priority: 80
  Requires: { Role: tank }                      # the party role, set in party chat
  Cast: SM_PROVOKE
  Target: { Enemy: attacking, Who: party, NotSelf: true, Prefer: support }
  When: not_enemy_provoke                       # When's enemy_* is the chosen monster
  SetTarget: true                               # and keep fighting it
  OnePerParty: true                             # two tanks never provoke the same one
```

- `Enemy: attacking` with `Who: owner | party | support | self`; `NotSelf` for
  "hitting someone other than me". It reads each monster's target, which the
  engine already tracks per companion.
- Also `Enemy: nearest | lowest_hp | boss | slaves | casting`.
- With a selector, `When`'s `enemy_*` tokens ask about **the chosen monster**,
  not the current target, so `not_enemy_provoke` checks the right one.

**Ally selectors** for buffs and heals: `Target: { Ally: lowest_hp, Job: Knight }`,
`{ Ally: nearest, Role: tank }`, `{ Ally: missing, Status: SC_BLESSING }`.

**`SetTarget: true`** makes the chosen monster the companion's combat target for
3 s, renewed while the rule keeps applying. It needs no new engine line:
`population_strategy_target` already has the last word over the party
controller's choice, the same way holding position overrides following.
Assisting is a selector: `Target: { Enemy: target_of, Who: tank }` with
`SetTarget: true` takes the tank's target instead of the owner's.

Provoke itself fails on status-immune monsters (bosses, so Phreeoni) and on
Undead, and succeeds by chance otherwise (rAthena's `skills/swordman/provoke.cpp`).
Against Phreeoni, the tank's Provoke is for its slaves.

**`Requires: { Role: tank }`** gates a rule on the party role assigned in chat
(`<name> tank`), so one table serves a party arranged differently each time.
This was listed under 6; it belongs here because peeling is a tank's job.

Range: a monster out of the skill's range is not chosen for a `Cast`, so a tank
provokes what it can reach. If the playtest shows it should walk to one first,
that is an `Approach:` option on the rule.

## 7. Boss mechanics: what the MVPs do that rules could not answer

A survey of every MVP's `mob_skill_db` rows (renewal: 90 MVPs with skills, about
1,950 rows; the conditions are `always` 1054, `myhpltmaxrate` 390, `slavele` 159,
`rudeattacked` 135, `skillused` 85, `longrangeattacked` 34, `attackpcge` 15,
`casttargeted` 12, and a few others). Most boss skills are **instant**, and an
instant skill cannot be seen coming. A rule can only answer its *result*: a
status on the boss, a ground field, new monsters. These are what that needed.

| | Gap | What it answers | Status |
|---|---|---|---|
| A | `Ban` and `Rotation` per **strategy**, not only per plan | Reflect Shield (14 rows), Magic Mirror (7), Auto Guard, Stone Skin (11), a boss in its own Pneuma (14) or Safety Wall (6): "no magic / no melee / no ranged until it drops" is a strategy whose rotation is limited | built |
| B | `Field: { ..., At: target }`: ground units around the rule's target | the boss standing in its own Pneuma, Safety Wall or Land Protector (16) | built |
| C | `Enemy: { Element, Race, Size, Boss }` on a rule | bosses that change element (NPC_CHANGEHOLY, CHANGETELEKINESIS...); `When` cannot express element or race | built |
| D | **Counting** monsters around a point (D1), and a cap on how many companions take one target (D2) | instant Call Slave (152 rows): "3 slaves around the boss → AoE"; `attackpcge` (15): bosses that answer N attackers with an AoE | built: `Count:` and `Targeting: { MaxAttackers }`. rAthena's `attackpcge` counts every unit targeting the boss; the cap counts the owner and the party's companions, lower companion ids first |
| E | **Can the boss reach me?** A path check before attacking from range | `rudeattacked` → Teleport, **135 rows, the commonest boss reaction**: hitting a boss from where it cannot walk to makes it vanish. rAthena decides it in `mob.cpp` (can it hit back from where it stands; can it move; `unit_can_reach_bl` within its chase range), so a rule can ask the same question. Holding a boss in place (Ankle Snare, Spider Web) counts as "cannot reach back" too | built: `Reach: false` on a rule, and `MoveTo: reachable` |
| F | **Encounter ended / target lost** events | after a Teleport the encounter plan just stops applying: "it teleported, regroup on the owner" | built (`encounter_ended`, `target_lost`, each with `Reason: died \| vanished`) |

Not answerable: an instant skill before it lands (Teleport, Call Slave, instant
summons, Power Up, Heal, instant Meteor / Land Protector / Heaven's Drive /
Pneuma, Dispel, Full Strip). Rules answer what follows: the status
(`enemy_*`, `Ally: having`, `Ally: missing` to rebuff after Dispel), the field
(`Field`, `Leave`), the monsters (D). Gear stripped or broken (Full Strip, the
breaks) waits for inventories.

Already answerable: the cast-time AoEs (Hell Judgement 30, Earthquake 29, Lord
of Vermilion 26, Meteor 22, Storm Gust 21, the Wide statuses ~60 together) with
`On: casts`; summons with a cast time (151); reactions to our own skills
(`skillused`, `groundattacked`, `casttargeted`) with a plan's `Ban`.

# Not done yet

Each item below has the same headings, so it can be picked up cold.

## Inventories: the foundation

**Built**, behind **Settings → Population → Companion inventory**
(`population_engine_companion_inventory`, off by default). With it on, a
recruited companion owns its bag (`runtime/population_shell_inventory.cpp`):
- Nothing refills it. The engine's potion stock and ammunition top-up are for
  ambient shells only; a companion drinks and fires what it carries, and drinks
  any healing or SP potion it has when its level's kind is missing. Ammunition
  comes from the engine's lists (`population_shell_ammo.cpp`, element-aware) and,
  when they have nothing for it, from any stack of the right kind it carries
  (cannonballs and throwing items included).
- Patch `0033` lifts the `skill_get_requirement` waiver for companions, so rAthena
  checks and takes their item and ammunition costs as a player's.
  `pop_skill_state_ok` and the Resurrection check pass over a skill whose items
  are not in the bag, instead of having it refused on every turn.
- A trade leaves everything but equipment in the bag; equipment is worn, as
  before.
- The whole bag (every unworn stack and the worn ammunition, in full) is saved in
  `cp_companion_persistence.inventory_detail` and put back on recall. It is
  written when the gear is (trade, recall, logout) and otherwise at most every
  10 seconds while it changes. A row saved before this keeps what the recall
  spawn gives, once.
- `max_weight` comes right at the end of recall, so the `overweight` event and
  rAthena's weight limits see the real bag.

**Still missing.**
- A window for the owner to see the bag and take items back (the companion
  panel). Until then the bag is filled by trade only.
- Deleting a saved companion loses its bag.
- The engine's potion drinking is to become a setting, so a plan can take it
  over (see Using items).

### Catalysts for skills

**Built** with inventories (with the setting on): a companion's Blue Gemstone, Holy Water or Flame
Stone comes from its bag, and rAthena takes it when the cast lands, as for a
player. A `Consume: true` rule needs no switch: `pop_skill_state_ok` refuses the
cast when the bag lacks the items. `kPayCatalysts` stays off, because it would
pay a second time. Rules can react to running low with `item_below`.

### Using items

**Built**: the rule action `UseItem: <item>` (or a list, the first one in the
bag), described in the [reference](mods/companion-strategies/reference.md#rules).
It calls rAthena's item use, `pc_useitem`, the path the engine's potion drinking
uses. A rule exists only for a companion that carries the item. An item that
casts a skill (a converter, a Fly Wing) only arms that skill for a client to
cast; a shell has no client, so the module casts it, on the companion or on the
rule's `Target`.

Played on the test server with an Assassin Cross carrying five of each: an
Awakening Potion while it lacks the status, a Green Potion when poisoned, a wind
converter against a Water monster, a Fly Wing on a party-chat word. Each took
one from the bag and had its effect.

**Still missing.**
- Items aimed at someone else are written but not played: a Yggdrasil Leaf on
  `Target: { Ally: dead }` goes through the same cast step.
- A Fly Wing moves the companion, and following brings it back once its owner
  is out of sight. It is of use only where a companion may be apart from its
  owner.
- Rules run on a companion's combat turns, so an ailment is cured in a fight,
  not while walking behind its owner.
- The engine's potion drinking is still its own; a setting would let a plan
  take it over entirely.

**What it adds.** Survival without a healer, revives without a Priest, and
consumables as part of boss plans (a Yggdrasil Berry at Phreeoni's Power Up).

**Where to start.** A new action in `parse_rule` and `run_rule`
(`strategy/population_strategy.cpp`), modelled on `Cast`.

### Choosing ammunition: Archers, Gunslingers, Ninjas

**What is wanted.** An Archer fighting an earth monster checks whether it carries
Fire Arrows. If so, it equips them, and afterwards goes back to its default
ammunition. The same goes for a Gunslinger's bullets and spheres, and a Ninja's
shuriken and its elemental kunai.

**What exists already.** The engine does the element part on its own
(`runtime/population_shell_ammo.cpp`):
- every shell is stocked with each kind of ammunition its weapon uses (arrows,
  bullets, spheres, shuriken, kunai), 500 of each, refilled below 100;
- before each attack, it equips the kind that is strongest against the target's
  element (`pe_shell_elemstrong`) and avoids one the target resists
  (`pe_shell_elemallowed`), so an Archer already shoots Fire Arrows at an earth
  monster;
- skills that need a particular ammunition get it
  (`population_shell_equip_ammo_for_skill`).

This is a virtual supply, like the engine's potions. Nothing limits it, and a
companion's owner never provides it.

**What is missing.**
1. **Plan control.** A plan can't say which ammunition to prefer or avoid.
   Examples: "Silver Arrows against the undead even though Fire would do more",
   "never Poison Arrows here", "save the rare ones for the boss". A plan also
   can't name a default to return to: today, the next target's element simply
   decides again.
2. **Real ammunition.** With inventories, the choice should come from what the
   companion actually carries ("if it has Fire Arrows"). It should stop when a
   kind runs out, and the virtual stock becomes a setting.

3. **Running out.** `item_below` reacts to one particular item. Nothing reacts to
   "low on *any* ammunition my weapon can use", and with a real inventory that is
   what matters: a Hunter with no arrows left should say so and fall back.

**Why not now.** It waits for the real inventory, which is being built as its
own PR; that one is to be accepted first. With today's virtual stock nothing
ever runs out (it refills below 100), and the automatic choice by element
already covers the common case.

**How it would work** (agreed shape):
- **`Ammo: { Prefer: [...], Avoid: [...] }`** on a plan or a strategy, layered
  like `Allow`: the most specific plan that says something decides. The
  engine's ammunition choice asks the strategy module for each kind it scores:
  one more marked call in `pe_shell_ammochange`, the size of the `Allow` hook.
  `Prefer` adds a bonus that outranks the element bonus; `Avoid` drops a kind.
  Examples: "Silver Arrows against the undead", "never Poison Arrows here",
  "save the rare ones for the boss".
- **An "out of ammunition" event and condition:** `On: { Event: ammo_below,
  Value: 50 }` fires once when the total of ammunition the current weapon can
  use drops below `Value`. `Ammo: { Below: 50 }` as a rule condition holds while
  it is that low, so a rule can keep acting on it: "out of arrows: stay by the
  owner and plain-attack", "say so once".
- **With the real inventory:** the engine chooses only from what is in the bag,
  and the virtual stock becomes a setting.

**Effort.** About the size of `Claim`: a plan key, one engine call, the event
and condition, and a source-pin test.

**Risks, and the guard for each.**
1. **An `Avoid` that removes every usable kind** would leave a ranged class
   unable to shoot. Guard: if nothing is left, ignore `Avoid` for that attack
   and say so in the trace.
2. **A preferred kind the target absorbs or resists** (Fire Arrows at a fire
   monster) would heal it or do nothing. Guard: a preference never overrides the
   engine's "avoid what the target resists" check (`pe_shell_elemallowed`); it
   only reorders the allowed kinds.
3. **Skills that need a particular ammunition** have their own path
   (`population_shell_equip_ammo_for_skill`). Guard: leave it alone; the
   preference applies only to the normal choice.
4. **More swapping** when a preference disagrees with the element choice. Low
   risk: swapping is cheap, and rAthena's swap delay (after Desperado, Arrow
   Vulcan) is already respected (`canequip_tick`).
5. **Regular AI characters** are only affected through plans marked
   `For: shells` or `For: all`, as with everything else.

**What it adds.** Ammunition as part of a boss plan, as a resource the owner
provides, and a sensible reaction when it runs out.

**Where to start.** `pe_shell_ammochange` in `runtime/population_shell_ammo.cpp`
(the choice); the strategy module for `Ammo:` and `ammo_below`; the inventory PR
for what is in the bag.

### Switching gear to the situation

**What is missing.** A companion wears one set of gear whatever it fights.

**Why not now.** The bag can hold the other sets now, but traded equipment is
worn at once, so there is no way yet to hand a companion a spare set.

**How it would work.** Named gear sets on a plan (`Gear: { ghost: [...] }`) and a
rule action `Equip: <set>`, which equips the set's pieces from the bag. The
plan layers already describe *when*:
- an elemental weapon in a kind plan (`Mob: { Element: Ghost }`);
- an armour against a boss's element in that boss's plan;
- the normal set back under `Mob: All`.

Swapping costs a moment, so a set is switched once per fight, not per target. A
strategy is the natural place: entering it equips its set.

**What it adds.** The second half of fighting by element, after spells: the
right weapon against Ghosts or the undead, the right armour against a boss's
element. Also the answer to Strip and to broken gear (`equip_broken` is already
an event).

**Where to start.** The worn-gear code in `population_engine.cpp`
(`gear_detail`, the gear-return patches `0007` and `0025`); a new action in the
strategy module, beside `UseItem`.

**Asked for, and put off (2026-10).** Found while writing boss plans: a plan
names gear a member should wear for a fight (a Raydric garment against Dark
Lord, an Alice shield, fire armour against Meteor Storm), and the companion puts
it on when the encounter starts. The boss tests gave a member an armour element
by script instead. The test to pass: a plan for Dark Lord that says "Raydric
garment", and the companion wears one while Dark Lord is within 14 cells. To
settle before writing it:
- what a gear rule does with Companion inventory off, when there is no bag to
  take the piece from;
- what puts the earlier piece back when the encounter ends (`encounter_ended`,
  or leaving the strategy);
- how a swapped piece sits with the given-gear mask and the `gear_detail`
  snapshot, so a recall does not bring the companion back in its boss gear, and
  a piece the owner gave is still handed back as the owner's.

## 5. Time and memory

**What is missing.** A plan knows the present (HP, statuses, who is where) and
which strategy it is in. It does not know how long it has been in that
strategy, how long a status has left, or what it already did this fight.

**Why not now.** Phreeoni did not need it: its phases follow its HP, which the
plan can read. A boss whose pattern runs on a clock or on counts (every 30 s; at
the third summon) would.

**How it would work.** Kept per plan and per fight, reset when the plan starts
over:
- **Time** as conditions: time in the current strategy (`in_strategy_gt10s`),
  time since the fight began.
- **Time left on a status**, from rAthena's status timer:
  `ally_blessing_left_lt10s`, so a buff is renewed before it lapses rather than
  after.
- **Flags and counters**, as rule actions (`Set: lex_done`, `Inc: summons`,
  `Clear: ...`) and as conditions (`flag_lex_done`, `count_summons_ge3`). They
  turn "once per fight" and "after the third summon" into plain rules.

All of it lives in the strategy module's per-companion state, beside the active
strategy.

**What it adds.** Periodic actions ("every 30 s"), buffs without gaps,
once-per-fight openers, sequences longer than one state, and bosses with timed
patterns.

**Risks, and what to test for each.**
1. **Stale memory.** A flag from the last boss must not carry into the next
   fight. Flags reset when the plan starts over (a new boss). A `Mob: All` plan
   never starts over, so its flags also reset after a stretch with no fight.
   *Test:* set a flag at one boss, then check it's clear at the next boss, and
   after leaving and coming back.
2. **Time measured in turns.** A companion that takes no turns (resting, unable
   to move, not watched) would not see time pass. Measure from timestamps, not
   turn counts. *Test:* a timed rule fires on time after the companion rested
   or was frozen in between.
3. **Statuses with no timer** (they last until removed) have no "time left".
   Treat them as never lapsing, and document it. *Test:* a status with a timer
   and one without.
4. **Invisible state.** Counters and flags make a plan harder to follow. Every
   `Set`, `Inc` and `Clear` must show in the trace, and so must the timers a
   rule waits on. *Test:* the trace of a plan that switches on a counter
   explains the switch.
5. **Name clashes.** Two mods using one flag name in a plan would share it.
   Prefix flags with the mod's name, the same convention as rule names (see
   the [reference](mods/companion-strategies/reference.md#more-than-one-mod)).
   *Test:* two mods with differently prefixed flags stay apart.
6. **Engine:** none. All of it lives in the strategy module, and nothing changes
   for a plan that doesn't use it. *Test:* the example mods behave as before
   (load counts, a Phreeoni run).

**Step 1, built.** Time in the strategy and the fight are rule conditions,
`InStrategy` and `InFight` (ms). They are not `When:` tokens, which would have
meant changing the engine's shared condition parser. Time left on a status is a
selector option, `{ Ally: missing, Status, Expiring: ms }`. companion-roles uses
it: the healer renews Blessing, Increase AGI and Impositio with 3 s left.
Risks 2, 3 and 6 are covered by `tests/companion-strategy-time.test.cjs`
(timestamps, statuses without a timer, the parser knowing the keys) and by the
load test. A playtest still has to confirm them in a fight.

**Step 2, open:** flags and counters, with their reset rules and trace output
(risks 1, 4 and 5). To be done when a boss needs them.

**Where to start (step 2).** `PlanState` in `strategy/population_strategy.cpp`
(where the active strategy lives), beside the `InStrategy` and `InFight`
bookkeeping.

## 6. Coordination: roles that change in a fight, and claims

### Roles that change in a fight

**What is missing.** A role is the party-chat Duty, or the class family through
a `Requires: { Role: [..., none] }` on a role plan. It does not change during a
fight. Selectors like `Who: support` only see a typed Duty. Regular shells have
no roles at all.

**Why not now.** It was designed after the Phreeoni playtests and deliberately
left for after the PR, so a test result is never mixed with a new feature.

**How it would work** (agreed design):
- A `Roles:` list in the same table, scoped like plans (a monster, a kind,
  `Boss`, `All`). Each entry names a role, a `Job`, and optional `When:` and
  `Stats: { Flee: ">=180", Def: ">=60", MaxHp: ... }`.
- Worked out for every party member, the owner included, before the plans are
  chosen: role, then plans, then rules. Re-checked every turn, with a minimum
  hold of about 3 s so a flickering condition does not flap.
- The first match wins, most specific scope first.
- A typed Duty replaces the defaults (entries without `When`). An entry marked
  `OverridesDuty: true` can still override it while its condition holds.
- Everything that reads roles (`Requires: { Role }`, `Who:`, `Role:` in
  selectors) reads this result.
- All of it in the strategy module, with `Stats:` read there too, so no engine
  change. The engine's own role behaviour keeps reading the Duty.

```yaml
- Mob: Boss
  Roles:
    - { Role: tank, Job: Monk, When: self_steelbody, OverridesDuty: true }
    - { Role: tank, Job: Assassin, Stats: { Flee: ">=180" } }
    - { Role: support, Job: Priest }
    - { Role: attacker, Job: All }
```

**What it adds.** Roles that follow the fight: a Monk under Steel Body becomes
the tank and the healer's tank rules follow it; an Assassin with enough Flee
tanks. The role plans can say plain `Role: support` instead of the
family-default lists. Regular shells get roles, and with them role plans.

**Where to start.** `plans_for` and `requires_ok` in
`strategy/population_strategy.cpp`; `member_is` for `Who:`.

### Claims (built)

`Claim: lex`, or `Claim: { Name: lex, For: 10000 }`, on a rule. Acting puts a
party-wide claim on the rule's target under that name, for `For` ms (default 5
s), renewed while the companion keeps acting on it. Any other companion's rule
with the same claim name passes a claimed target over, and its selector picks
the next one. This spreads crowd control over different monsters and keeps Lex
Aeterna to one per boss. Built and loaded; not yet played. See the
[reference](mods/companion-strategies/reference.md#rules).

## 8. AI raid parties


Shells fighting an MVP on their own, as a party, with nobody's character in it.

**What exists.** Every ambient shell already belongs to a synthetic party, one per
map (`0x70000000 | map`, `population_engine.cpp`), so party-only skills such as
Kyrie and Devotion work between shells; with `PackBehavior`, idle shells share a
target. The PvP arena spawns teams in synthetic parties of their own
(`population_arena_start`, `npc/custom/population/arena.txt`). So shells fight side
by side, but as "everyone on this map": no leader, no goal, no plan.

**What a raid party needs:**

1. **A group**: a synthetic party per group, spawned by a script command in the
   arena's style. Engine work; a new script command also touches the engine's
   rAthena patch (`custom/script.inc`).
2. **A leader with a goal**: go to the MVP, find it, and the others follow that
   shell. Engine work: owner-follow knows only real players.
3. **Strategies for them**: let a raid group's shells (not ambient ones) run the
   strategy module, and let the module list a synthetic party's members (it asks
   rAthena's party table today, which does not know them). Module only, small.
   The plans themselves carry over unchanged.
4. **Someone watching**: shells only take combat turns while a real player has
   them in view (`pop_combat_tick_per_real_pc`); companions are the exception. A
   raid party would fight while watched, not on an empty map.
5. **A decision on rewards**: an AI party that kills an MVP takes it from players,
   and its MVP item and drops need an inventory (item 4) to go anywhere.

**Why not now.** It is mostly engine work: groups, a leader and a goal. It also
raises a game-design question, rewards, that the strategies do not answer. The
strategies themselves carry over unchanged.

**What it adds.** MVPs contested and killed by the world's AI characters:
something to watch, to race, or to join.

**Where to start.** `population_arena_start` (synthetic parties, spawning by
script) and the party listing in the strategy module (`party_members`).

## Combining plans across mods: name clashes and Allow

**What is missing.** When two mods give the same plan (monster, job, build),
their rules merge by `Name`: new names are appended, the same name replaces the
earlier rule. That is how a later mod extends an earlier one. But a clash is
silent: two unrelated mods that both call a rule `heal` replace each other with
nothing in the log. And the plan settings combine unevenly: a later `Ban` adds to
the earlier list, while a later `Allow` replaces it.

**Why not now.** Merging works as designed for the example mods. Nothing has
clashed yet, and the right rule for `Allow` (combine, or replace) is a decision
to make with more mods in hand.

**How it would work.**
- A load-time notice whenever a rule replaces an earlier one of the same name,
  naming the plan.
- A naming convention in the docs: prefix a rule with the mod
  (`phreeoni_basics.meteor_the_slaves`) unless it is meant to replace a rule.
- Decide how two `Allow` lists in one plan combine: a union (the later mod
  allows more), an intersection (only what both allow), or replacement as now.
  Then make `Allow` and `Ban` consistent.

**What it adds.** Mods that extend each other safely: a generic plan from one
mod, specific additions from another, with any overlap visible.

**Where to start.** `merge_rules` and `merge_job` in
`strategy/population_strategy.cpp`; "More than one mod" in
[the reference](mods/companion-strategies/reference.md#more-than-one-mod).

## Measuring the cost

**What is missing.** How much a strategy turn costs on a busy map has not been
measured. Companions take turns all the time. Ambient shells only do so with a
`For: shells` or `For: all` plan, and only while a player watches them.

**Why not now.** The load tests run without a player online, so shells never
take turns there.

**How it would work.** A live session with traces off, timing
`population_strategy_turn` per shell on a crowded map, with and without a
`For: all` plan.

**What it adds.** A number to put beside "keep their plans short".

# Played

## Playtest: Phreeoni

The first played boss fight, after 1 and 2: a tank, a Priest and a damage dealer
with Wizard support, traces on (`<name> trace`).

Why Phreeoni. Its `mob_skill_db` (renewal adds All Heal; the rest is the same in
both eras) tests most of what the rules are for:

| Phreeoni does | What it tests |
|---|---|
| **Teleports** when attacked by someone it cannot reach (`rudeattacked`) | ranged companions placed badly lose the boss; positioning (1) |
| **Summons and calls slaves** | targeting: boss or slaves (3, `Targeting: Ignore`) |
| **Wide Stone Curse** below some HP (petrify around itself, 0.5 s cast) | `On: casts` + `KeepDistance`/`Retreat` in time |
| **Petrify Attack**, **Lick**, **Helm Break** | Priest reactions (Status Recovery), gear (4) |
| **Power Up** and **Hiding** below some HP | phases (5); Hiding is the "where did it go" moment |
| **Heal**; **All Heal** in renewal when hit hard | burst timing, focus (3, 5) |
| Renewal: 300,000 HP, defence 269, magic defence 98. Pre-renewal: 188,000 HP, defence 10 | a long fight; SP and consumables (4) |

Land Protector does not help against Phreeoni itself. Its Wide Stone Curse is
a petrify around the boss, not a ground spell, and its Heaven's Drive is instant,
so nothing sees it coming. Signals still matter there: gathering for heals or a
Sanctuary when it powers up, or "it is hiding" when it vanishes.

**Result.** Over seven playtests, each fix came from something that went wrong;
they are in
[Writing plans that hold up](mods/companion-strategies/reference.md#writing-plans-that-hold-up-in-a-fight).
The party of a Priest, a Wizard and an Assassin Cross beside their owner then
beat Phreeoni. Nothing in the fight needed items 4, 5, 6 or 8. The next
test is a second boss with a different kit, to show whether the role plans
generalise.
