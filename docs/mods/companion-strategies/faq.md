# Companion strategies: FAQ

The questions that come up when writing plans and watching companions follow
them. First step for almost all of them: type `<name> trace` in party chat and
watch what the companion reports.

**Writing plans**
- [Do I need a plan for every job?](#do-i-need-a-plan-for-every-job)
- [Can a mod add a plan for just one boss and one job?](#can-a-mod-add-a-plan-for-just-one-boss-and-one-job)
- [What's the difference between Allow, Ban, Disable and Rotation?](#whats-the-difference-between-allow-ban-disable-and-rotation)
- [Event or condition?](#event-or-condition)
- [Which priority should a rule get?](#which-priority-should-a-rule-get)
- [Does `Job: Priest` cover High Priests?](#does-job-priest-cover-high-priests)
- [How do two mods with plans for the same boss combine?](#how-do-two-mods-with-plans-for-the-same-boss-combine)
- [Do I need to rebuild after changing the YAML?](#do-i-need-to-rebuild-after-changing-the-yaml)

**When something doesn't work**
- [My rule never fires](#my-rule-never-fires)
- [I unticked a skill for my companion. Can a plan still make it cast it?](#i-unticked-a-skill-for-my-companion-can-a-plan-still-make-it-cast-it)
- [It casts skills my plan doesn't name](#it-casts-skills-my-plan-doesnt-name)
- [It walks up and hits with its staff or rod](#it-walks-up-and-hits-with-its-staff-or-rod)
- [It stays behind when the fight moves](#it-stays-behind-when-the-fight-moves)
- [It runs off at low HP](#it-runs-off-at-low-hp)
- [It keeps doing the same thing over and over](#it-keeps-doing-the-same-thing-over-and-over)
- [It doesn't react to a boss skill](#it-doesnt-react-to-a-boss-skill)
- [The healer doesn't revive someone](#the-healer-doesnt-revive-someone)
- [The healer ignores one party member](#the-healer-ignores-one-party-member)
- [It attacks monsters nobody is fighting](#it-attacks-monsters-nobody-is-fighting)
- [The boss teleported away](#the-boss-teleported-away)
- [The server says something about my table at start](#the-server-says-something-about-my-table-at-start)

**Limits**
- [Can it use items, potions, or switch gear?](#can-it-use-items-potions-or-switch-gear)
- [Do regular AI characters use plans too?](#do-regular-ai-characters-use-plans-too)
- [Does it run out of SP?](#does-it-run-out-of-sp)
- [Can it sit down to regenerate?](#can-it-sit-down-to-regenerate)

---

## Writing plans

### Do I need a plan for every job?

No. A plan is keyed by monster and job. A companion only uses the plans for its
job (`All` counts for every job). Any other class carries on with its broader
plans, or with the engine's default if it has none.

### Can a mod add a plan for just one boss and one job?

Yes. A mod containing only `Mob: PHREEONI`, `Job: Priest` changes Priests near
Phreeoni and nothing else. Note that a plan for one particular monster switches
that class's skill rotation off by default (it casts what the plan names),
unless the plan or a role plan says `Rotation: true`.

### What's the difference between Allow, Ban, Disable and Rotation?

| | Affects | Use it to |
|---|---|---|
| `Rotation: false` | the engine's skill rotation, on or off | let only the rules choose attack skills |
| `Allow: [..]` | what the engine casts **on its own** (rotation, heals, buffs). Every applying plan must allow a skill | narrow a class's skills, e.g. at a boss; `Allow: []` for "rules only" |
| `Ban: [..]` | everything, other plans' rules included | forbid a skill outright (no Fire Wall at Phreeoni) |
| `Disable: [name]` | other plans' rules, by name | replace one rule of a broader plan with your own |
| `Attack: false` | plain attacks | casters and healers that should never melee |

A plan never blocks the skills its own rules cast.

### Event or condition?

Use an **event** (`On:`) for "when X happens, do Y once": a cast starting, a
death, a chat line, a signal. Use a **condition** (`When:`, `Present:`,
`Count:`, a selector) for "while X is true, keep doing Y". An event rule is done
after its first action, so "walk to the body" as an event takes one step and
stops. Write goals that take several turns as conditions.

### Which priority should a rule get?

Higher runs first. The example mods use these bands, so mods fit together:
100 and up for survival and resurrection, 80–99 for a boss's mechanics, 40–79
for a role's routine, below 40 for filler and the closing `Hold`. Within your
plan, order rules from most to least urgent; a positioning rule usually sits
just above the casts it makes possible.

### Does `Job: Priest` cover High Priests?

Yes. A job names its family: Priest, High Priest, Arch Bishop, Cardinal, Baby
Priest. A 1st class covers everything built on it (`Job: Acolyte` is Priests
*and* Monks); add `Exact: true` to keep it to the class itself. A job your
server's era lacks is skipped silently, so one list works in both eras.

### How do two mods with plans for the same boss combine?

They merge. Rules with the same `Name` replace earlier ones, new names are
added, and `Remove: true` deletes one. `"after": ["other-mod"]` in `mod.json`
decides which mod is applied later and wins. Different jobs or `Build`s never
collide.

### Do I need to rebuild after changing the YAML?

No. Restart the server (or reinstall the mod and restart). Only engine changes
need a new build.

## When something doesn't work

### My rule never fires

Check, in this order:
1. **Does the plan apply?** Is the companion's job covered, is the monster the
   one it targets (or `Encounter: true`, or `Boss`/`All`), does it meet the
   `Build`'s `Requires`? A plan for a mod that isn't installed applies to nobody.
2. **Does a higher rule act first?** Only the first rule that acts runs each
   turn. A positioning rule or a `Hold` above yours can take every turn.
3. **Does its selector find anyone?** `Target: { Ally: attacked }` finds nobody
   while nobody is hit; selectors only look within the spell's range.
4. **Can it cast?** It must know the skill, and its owner must not have unticked
   it. The trace says why a cast was not made: "not cast (out of range: 8 > 3)",
   "(not enough SP: needs 40, has 12)", "(a catalyst is missing: 1 Blue_Gemstone)",
   "(the cell is taken: Raydric stands on it)", "(on cooldown, 12.4 s left)". The
   [reference](reference.md#finding-out-what-it-is-doing) lists them with what to
   do about each.
5. **Is the server reporting the rule at start?** A misspelled key, skill or
   status skips the rule (see below).

### I unticked a skill for my companion. Can a plan still make it cast it?

No. The companion's skill selection is your deliberate choice, and a plan's
rules respect it: a rule for an unticked skill does not exist for that
companion, and a `Cast:` list skips it. The engine's own party Resurrection is
the one exception: it revives whatever the selection says, because whether the
party can recover from a death is left to the class.

### It casts skills my plan doesn't name

Those come from the engine's own turn, which runs whenever no rule acts: its
rotation, heals and buffs. Use `Allow: []` (only rules cast), a shorter `Allow`,
or `Ban`. See [the table above](#whats-the-difference-between-allow-ban-disable-and-rotation).

### It walks up and hits with its staff or rod

An ordinary turn walks to the target and hits it. End the plan with a `Hold`
([recipe](cookbook.md#stand-still-instead-of-melee)), or set `Attack: false`
([recipe](cookbook.md#casters-never-melee)).

### It stays behind when the fight moves

A positioning rule or `Hold` stops it following its owner while it applies. If
it applies with no fight around, the companion stays put. Give `Hold` a
`Present: { Enemy: attacking, Range: 14 }`. Make sure distance rules have a
selector that finds nobody once the fight has moved on.

### It runs off at low HP

That's the engine's own flee below 30 % HP. A rule that acts at low HP comes
first: kite round the healer, or walk to it and wait
([recipe](cookbook.md#low-on-hp-kite-round-the-healer)).

### It keeps doing the same thing over and over

Usually a condition that stays true after the action: re-walling a member who
moved off the wall, re-casting a buff the target can't take. Add a `Cooldown`,
ask the ground (`Field: { ..., At: target, Below: 1 }`), or check the status the
cast gives (`When: not_ally_kyrie`).

### It doesn't react to a boss skill

Only skills with a cast time can be seen coming (`On: casts`). An instant skill
has landed before any rule could react. React to its result instead: a `Count`
of slaves, a status gained, HP dropping. Also check the window (`Within`): if
the companion is busy casting when the event happens, the window must outlast
that cast.

### The healer doesn't revive someone

Check:
- **Distance:** Resurrection reaches 9 cells. The healer walks to a body within
  sight (`close_to_the_fallen`).
- **Undead armor:** Resurrection fails on a member wearing undead armor (Evil
  Druid card), and so does Heal. Those members are passed over.
- **The healer is being hit:** with the [recipe](cookbook.md#walk-to-the-fallen-and-revive)
  it walls its own cell first. If Safety Wall can't be cast there, it waits.
  The trace shows why.
- **SP:** Resurrection needs 60 SP. The heal rules stop at 70 to keep it.

### The healer ignores one party member

Probably undead armor: Heal, Highness Heal, Resurrection, Aspersio and Sanctuary
fail or do nothing on them, so healers skip them and protect them with Kyrie,
Safety Wall and Assumptio instead.

### It attacks monsters nobody is fighting

In Attack mode a companion picks fights on its own. Defensive mode only fights
what attacks the party. Rules with `{ Enemy: attacking }` or `{ Enemy: boss }`
selectors never pick a bystander.

### The boss teleported away

Most bosses teleport when hit by someone they can't fight back against (from out
of their reach). The [no-rude-attack rules](cookbook.md#dont-make-a-boss-teleport)
make companions step to where the boss could reach them first. They apply only
where the boss would really answer: out of its reach, with a teleport for the
state it is in. When it happens anyway, `encounter_ended` with `Reason: vanished`
fires; add `Boss: true` so the rule is not set off by ordinary monsters of a plan
with `Encounter: true`.

### The server says something about my table at start

The map server checks the table at start and reports each problem with its file
and line. That piece is skipped and the rest loads:
- an unknown monster, job, skill, item, status or key;
- a rule with two actions;
- a `Start` or `Switch` naming a strategy that doesn't exist;
- a `Disable` naming no rule;
- `Consume` on a skill without a catalyst.

The log line `population_strategy.yml loaded (N rules)` tells you how many rules
made it.

## Limits

### Can it use items, potions, or switch gear?

Items, yes; gear, not yet. With **Settings → Population → Companion inventory**
on, a companion owns its bag. A `UseItem` rule uses what is in it (a potion, a
cure, an elemental converter, a Fly Wing), and a skill's catalyst or trap is
taken from it when the skill is cast. With the setting off, the bag holds only
what the engine hands a companion and catalysts are not charged. A plan cannot
yet name gear to wear for a fight; the roadmap's
[Switching gear](../../COMPANION_STRATEGY_ROADMAP.md#switching-gear-to-the-situation)
says what is open.

### Do regular AI characters use plans too?

Only plans marked `For: shells` or `For: all`. They have no owner, so owner rules
don't apply to them. See [Regular shells](reference.md#regular-shells).

### Does it run out of SP?

Yes, companions and AI characters have a real SP pool, immortal ones included. Casts cost SP,
and it regenerates as for players. The engine's own casts stop at 15 % SP. The
trace shows the SP on every cast line.

### Can it sit down to regenerate?

Yes, two ways. The engine rests on its own: below a companion's rest threshold,
with nothing going on, it sits until recovered. And a rule can say `Sit: true`
whenever its conditions hold: the companion sits while the rule applies and
stands up as soon as it doesn't, or before any other rule acts. The
[cookbook](cookbook.md#sit-down-to-regenerate-between-fights) has a "sit below
30 %, get up at 80 %" recipe. Sitting also triggers Gangster's Paradise for
Rogues sitting together, and a Taekwon's Peaceful and Happy Break.
