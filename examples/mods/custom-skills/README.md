# custom-skills

A Guillotine Cross reworked from a mod folder. It loses two skills, gains
seven, and has a stacking poison and a combo window. Use it as a reference
for adding skills, passives and statuses, and for taking skills away. It
shows what each part does, where each part goes, and what was measured.
[New skills, passives and statuses](../../../docs/mods/CUSTOM_SKILLS.md) is the
guide behind it.

| | What it does | How |
|---|---|---|
| Dark Illusion, Hallucination Walk | taken away from the Guillotine Cross and the jobs after it; their skill points given back | `db/skill_tree.yml` `MaxLevel: 0`, `npc/refund.txt`, `SKILL_TREEVIEW_HIDE` |
| Phantom Menace, Dark Claw | no longer need Dark Illusion | `db/skill_tree.yml`, a requirement at `Level: 0` |
| **Contact Poison** (3100), passive | a normal attack that lands may poison: a stack of Toxin, 10% a level | `on_attack` |
| **Executioner** (3101), passive | +5% damage a level to a target under 35% HP; a kill gives back SP and cuts the after-cast delay | `damage_dealt`, `on_kill` |
| **Shadow Instinct** (3102), passive | +1 Perfect Dodge a level; each perfect dodge builds Momentum; Cloaking Exceed lasts 10% longer a level | `bonus`, `on_hit_taken`, `status("SC_CLOAKINGEXCEED")` |
| **Venom Burst** (3103), a strike | 100% + 60% a level, and 15% a level more for each stack of the caster's Toxin, which it uses up | `custom`, `ratio`, `on_cast` |
| **Toxic Cloud** (3104), ground | a 5×5 poison cloud for 6 s; each second it hits everything in it and adds a stack of Toxin | `custom`, a `Dummyskill` unit, `on_hit` |
| **Shadow Pact** (3105), passive | the player and party members within 5 cells: +5 HIT and +3 FLEE a level | `tick`, a status with a `stats` hook |
| **Shadow Dance** (3106), around the caster | hits every enemy within 2 cells; each one hit adds a stack of Momentum | `custom`, `Self` with a `SplashArea`, `on_hit` |
| Sonic Blow → Cross Impact | Cross Impact only within 3 s of a Sonic Blow, at half the SP | `on_cast`, `can_cast`, `cost` |
| Toxin | a debuff: up to 10 stacks (3 on a boss, 5 on a player), one count for each poisoner, losing a stack every 4 s; its poisoner hits 2% harder a stack, and it costs 4 HP a stack every second | `status()` |
| Momentum | a buff: +3 Critical a stack, up to 5, for 6 s | `status()` with a `bonus` hook |

**Look at first:** [`db/skill_db.yml`](db/skill_db.yml) and
[`db/skill_tree.yml`](db/skill_tree.yml), then the four files in
[`lua/`](lua). Every file is commented. This README is the overview, and the
comments explain each line.

```
custom-skills/
├── mod.json                     renewal only: pre-renewal has no Guillotine Cross
├── db/skill_db.yml              the seven new skills, ids 3100-3106
├── db/skill_tree.yml            two taken away, two requirements moved, seven added
├── lua/passives.lua             Contact Poison, Executioner, Shadow Instinct, Shadow Pact
├── lua/actives.lua              Venom Burst, Toxic Cloud, Shadow Dance
├── lua/reworks.lua              Sonic Blow and Cross Impact
├── lua/statuses.lua             Toxin, Momentum, the Sonic Blow window, Pact; Cloaking Exceed
├── npc/refund.txt               the skill points back, once per character
└── data/luafiles514/lua files/skillinfoz/
    ├── skillid.lub              the new skills' names and ids
    ├── skillinfolist.lub        icon, levels, SP, range, what each needs
    ├── skilldescript.lub        the descriptions
    └── skilltreeview.lub        places in the skill window; the two taken away left out
```

## How the pieces fit

- **The server** learns that a skill exists from `db/skill_db.yml`, who
  learns it from `db/skill_tree.yml`, and what it does from `lua/`. A skill
  with no `TargetType` is a passive: its hooks run for whoever has learned
  it. A skill a player uses has `custom = true`, which gives it the server's
  generic behaviour for its `TargetType`. Its damage is its `ratio`.
- **The client** knows nothing about a new skill until the four tables in
  `data/` name it, describe it and give it a place in the skill window. They
  hold only this mod's rows. The app adds them to the client's own tables.
  The icons are stock skills' icons, borrowed by name.
- **The statuses** live in `lua/statuses.lua`. Any hook that can act puts
  one on (`c:apply_status`) or takes it off (`c:remove_status`), and the
  status's own hooks do the rest. Toxin is put on by Contact Poison and Toxic
  Cloud, and spent by Venom Burst. Momentum is built by perfect dodges and by
  Shadow Dance.

## Measured

Every row of the table above was checked on a server built from the rAthena
fork with these hooks. A headless client logged a character in, a script made
it fight, and a second test mod watched this one's hooks. The same test ran on
a pre-renewal server, with the skills put on an Assassin Cross. It is in the
rAthena fork, as `tools/lua-test/run.sh custom-skills`; its README has the
setup.

| | renewal |
|---|---|
| A character who had Dark Illusion 5 and Hallucination Walk 3 | both gone; 8 skill points back at the next login, once. A skill reset afterwards does not pay them again |
| A new skill learned from the client | Contact Poison 1, with the client's own skill-up |
| Phantom Menace | learned without Dark Illusion |
| Shadow Instinct 5 | Perfect Dodge +5 |
| Venom Burst 5 on 8 stacks of Toxin | 1000% (100 + 300 + 8 × 75) |
| Cross Impact without a Sonic Blow | refused, with the message |
| Cross Impact after one | 20 SP instead of 40, and the window closes |
| Toxic Cloud | hits every second, as Poison, and stacks Toxin |
| The poisoner's blows on 1 and 7 stacks of Toxin | 726 → 740, 493 → 562: +2% a stack. Others' blows unchanged |
| Toxin on a boss | 3 stacks at most |
| Executioner 5 on a target at 28% HP | 516 → 645: +25%. At 42%: unchanged |
| A kill | Toxin on the dead ends, with the reason `"death"` |
| Shadow Dance | hits the two enemies within 2 cells and not the one 4 away; +2 Momentum |
| Shadow Pact 3 | HIT 402 → 417 |
| Cloaking Exceed for 10 s | 15 s with Shadow Instinct 5 |

In pre-renewal every check passed as well. Cross Impact costs 25 SP there, so
half is 12.

The test's own hooks also covered what this mod does not use: `give_item`,
`grant_skill`, `on_death` with `c:survive()`, doubling a server status's
duration, and the other kinds of new skill — an attack with a `SplashArea`,
a ground skill without a unit, and `Self` and `Support` skills that start a
server status.

## What to watch out for

- **Renewal only.** Pre-renewal has no Guillotine Cross, so `mod.json` asks
  for renewal. A mod for both eras keeps its job-specific trees in
  [era folders](../../../docs/MODDING.md#renewalfolder--prerenewalfolder--one-mod-for-both-eras).
- **The skill points of a skill taken away are lost on the next save**
  unless something gives them back. `npc/refund.txt` does, at the first login
  after the mod is installed. List your own ids in it.
- **The client's skill window and the server must agree.** The server
  decides who may learn what. The window shows what `skillinfolist.lub`
  says each skill needs, so this mod ships the rows of the two stock skills
  whose requirements changed.
- **A combo window has to outlast the opener's delays.** Cross Impact needs
  the caster to be able to move. Pre-renewal's Sonic Blow holds the caster
  for 2.3 s, which leaves 0.7 s of a 3-second window there.
- **A borrowed icon brings its tooltip.** Toxin's icon is the stock Toxin
  poison's, and Momentum's is a critical-rate buff's. The Pact borrows
  Hallucination Walk's icon, which is free because this mod takes that skill
  away.
- **The mod's statuses end with a logout.** They live in the server's
  memory.
- **New skills have no animation.** The client has none for an id it does
  not know. They show the cast bar, the damage and the status icons.

## Trying it

Copy the folder into the mods directory (see the
[examples README](../README.md)), switch it on in **Settings → Mods**, and
restart the whole app: the mod has a `data/` folder. Then, on a GM character,
use `@jobchange 4059` to become a Guillotine Cross and `@skillpoint 20` for
points to spend, and open the skill window.
