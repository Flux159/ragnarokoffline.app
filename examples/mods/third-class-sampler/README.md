# third-class-sampler

About twenty skills from a third-class redesign, two or three for each
third class, built on the skill IDs the classes already have. It is a worked
example of the Lua interface for reworking whole classes: passives with caps
and stacks, a shield, a decoy, a spell that is stored and let go later, a
field that echoes, crafting under a shared cap, a skill that is the only one
usable in Berserk. [New skills, passives and statuses](../../../docs/mods/CUSTOM_SKILLS.md)
is the guide behind it, and its
[recipes](../../../docs/mods/CUSTOM_SKILLS.md#recipes-what-a-class-rework-is-made-of)
are taken from these files.

It adds no skill to any job and takes none away: every skill here is one the
class already learns, given a new effect. That keeps the client's skill
window, names and icons as they are. A mod that also moves skills between
jobs adds `db/skill_tree.yml` and the client's tables, as
[custom-skills](../custom-skills) does.

| Class | Skill (ID reused) | What it does here | How |
|---|---|---|---|
| Guillotine Cross | Hallucination Walk, passive | +2 Perfect Dodge a level, never past 30; each perfect dodge adds a stack of Flurry | `stats` (`s.flee2`), `on_hit_taken` |
| | Dark Illusion, passive | each normal attack adds a stack of Flurry: faster attacks, and once at the ASPD limit, the rest as ATK | `on_attack`, a status with `stats` (`s.amotion`, `s.amotion_min`) |
| | Research New Poison | Create Deadly Poison +2% a level, under the shared +15 cap; at level 10 a failure's HP loss is given back | `craft`, `on_craft`, `tick`, `on_death` |
| | Toxin | Envenom, Venom Knife and EDP hits stack it; +3% damage taken from its poisoner a stack; Green Potion and Detoxify clear it | a status with `per_source`, `max_stacks_boss`, `decay`; `item(...)` `on_use` |
| Shadow Chaser | Reproduce | used on a monster: copies one of its skills that Plagiarism could | `replace`, `unit:mob_skills()`, `c:copy_skill` |
| | Feint Bomb | a decoy at your feet that monsters turn on, and two seconds of Hiding | `before_cast` (`c:summon`, `return false`), `on_cast` (`c:set_target`) |
| | Triangle Shot | a buff: each Double Strafe also hits two more enemies nearby | `replace`, `on_hit`, `c:attack` |
| Arch Bishop | Adoramus | needs Grace, which heals build; +40% a stack, more against Undead and Demons; spends it | `can_cast`, `ratio`, `on_cast`, `heal` (`heals.lua`) |
| | Sacrament, passive | each skill cast from the same cell adds Focus (shorter cast times); a step ends it | `on_skill`, `tick`, a status with `bonus` |
| Royal Guard | Prestige | you and your Devotion targets take 3% less damage a level; Devotion reaches 2 cells farther | `replace`, `damage_taken`, `unit:devotees()`, `c:status_val` |
| | Inspiration | Sacrifice hits harder the more HP you miss; its kills give its HP back; others' heals and thrown potions do nothing | `damage_dealt`, `on_kill`, `heal`, `bonus` (`bSkillHeal2`) |
| | Ray of Genesis | Grand Cross costs no HP, does not hurt you, and leaves a holy cross on the ground | `cost`, `damage_taken`, `c:place_unit` of the mod's own `RGX_HOLY_FIELD` |
| Sura | Energy Gain, passive | normal and combo hits may add a sphere, or SP once you are at the limit | `on_attack`, `c:spheres` |
| | Knuckle Arrow, passive | Snap deals Knuckle Arrow to every enemy on its way | `before_cast` on Snap, `units_in_line`, `c:attack` |
| Mechanic | Repair Weapon (Masterwork) | an Oridecon for 4 refines' worth of ATK, or an Elunium for 4 DEF, for 10 minutes | `replace`, `can_cast`, `c:take_item`, statuses with `bonus` |
| | Axe Training | an axe attack may also hit every other enemy next to you | `on_attack`, `units_around`, `c:attack` |
| Warlock | Reading Spellbook, Release | the next spell is stored, paid for; Release lets it go at once (two with Release 2) | `before_cast` returning `false`, `c:cast`, `stock_checks = false` |
| Sorcerer | Spell Fist | charges your Auto Spell's bolt into your weapon: the next 2 + level/2 melee hits each release it | `replace`, `stock_checks = false`, `unit:status_info`, a status's `on_attack` with `c:cast` |
| Genetic | Acid Demonstration | a fifth of its damage splashes next door; 30% chance to get the bottle back | `on_hit` (`c:hurt`), `on_cast` (`c:give_item`) |
| Rune Knight | Refresh | ends your debuffs, then none start for 30 s | `unit:statuses({ debuff = true })`, `c:end_status`, `status("*", { chance })` |
| | Stone Hard Skin | a shield of 20% of max HP; when it breaks it knocks enemies 3 cells back | a status: `damage_taken` and `on_hit_taken` sharing a table, `on_end`'s reason, `c:knockback` |
| | Phantom Thrust | also pulls the enemies that stood next to the target | `before_cast` notes the cell, `on_cast` `c:slide` |
| | Wind Cutter | two-handed swords only; restarts Two-Hand Quicken; the one skill usable in Berserk | `can_cast`, `db/status.yml` (Berserk's `NoCast`), a status's `can_cast` |
| Ranger | Fear Breeze | Double Strafe fires up to 3 more arrows, and uses them | a status's `cost` (`ammo_qty`), `hits`, `on_cast` `c:take_item` |
| | Camouflage | the first Sharp Shooting out of it always crits (not against players) | `critical` |
| | Detonator | sets off all your damage traps where they lie, at 150% | `unit:ground_units`, `units_around` a cell, `c:attack`, `c:end_unit` |
| Minstrel, Wanderer | Reverberation | a 5×5 field for 10 s: an Arrow Vulcan at a target inside echoes to the other enemies inside at 40% | `before_cast` returning `false`, `c:place_unit` of `MWX_RESONANCE` (`Interval: -1`), `unit:in_skill_area` |

**Look at first:** [`db/skill_db.yml`](db/skill_db.yml), then the file for a
class in [`lua/`](lua). Each file starts with what it changes and what it
shows of the interface, and the comments explain each part.

```
third-class-sampler/
├── mod.json                  renewal only: the classes are third classes
├── db/skill_db.yml           new target types for the reused skills; two ground skills of the mod's own
├── db/status.yml             Berserk no longer stops skills (Wind Cutter's own check refuses the rest)
├── db/mob_db.yml             the decoy, SCX_DECOY (25300)
├── db/mob_avail.yml          ...drawn as a Marine Sphere
└── lua/
    ├── guillotine_cross.lua  Hallucination Walk, Dark Illusion, Research New Poison, Toxin
    ├── shadow_chaser.lua     Reproduce, Feint Bomb, Triangle Shot
    ├── arch_bishop.lua       Adoramus, Sacrament
    ├── heals.lua             the heal hook shared by Adoramus and Inspiration
    ├── royal_guard.lua       Prestige, Inspiration, Ray of Genesis
    ├── sura.lua              Energy Gain, Knuckle Arrow
    ├── mechanic.lua          Masterwork, Axe Training
    ├── warlock.lua           Reading Spellbook, Release
    ├── sorcerer.lua          Spell Fist
    ├── genetic.lua           Acid Demonstration
    ├── rune_knight.lua       Refresh, Stone Hard Skin, Phantom Thrust, Wind Cutter
    ├── ranger.lua            Fear Breeze, Camouflage, Detonator
    └── minstrel_wanderer.lua Reverberation
```

## How the pieces fit

- **A reused skill keeps its name, icon and animation**, and the client's
  description of what it used to do. `db/skill_db.yml` changes only what the
  new effect needs: an active that became a passive gets
  `TargetType: Passive`, a buff that now starts a status of the mod's own
  gets `Status: None`, and a skill the mod hits with gets a `Type` and a
  `HitCount`. Every other field stays the server's.
- **`replace = true`** swaps a skill's own code for the generic kind, so
  `on_cast` is its whole effect. Without it, the stock effect still happens
  and the hooks add to it (Phantom Thrust's pull, Grand Cross's field), or
  `before_cast` returning `false` stops it (Feint Bomb, Reverberation).
- **`stock_checks = false`** turns off a check the server makes for that
  skill alone, when the new effect no longer fits it: Spell Fist could only
  be used while casting a bolt, and Release at level 2 needed a summoned
  sphere.
- **The statuses** are in the class's file, beside the skill that puts them
  on.

## Measured

Every row of the table was checked on a server built from the rAthena fork,
renewal. A headless client logged a character in, a script took it through
each class in turn (each starting with none of the last class's skills or
statuses), and a second mod watched from the outside: it logged each blow
before the statuses' hooks and what it dealt in the end, and the
character's statuses every second. 43 checks; all passed, on two runs. The
test is `tools/lua-test/run.sh third-class-sampler` in the rAthena fork.

| | renewal |
|---|---|
| Hallucination Walk 5 | Perfect Dodge 4 → 14 |
| Dark Illusion 5, three and a half seconds of attacks | Flurry 5, ASPD 174 → 177 |
| Envenom, then Green Potion | Toxin on the target; the Toxin put on the player is gone after the potion |
| Create Deadly Poison, failing | chance 64.8% → 79.8% (the cap); HP 21760 → 16320 → 21760 within the second; no bottle |
| Reproduce on an Elder Willow | Fire Bolt 3 in the Reproduce slot |
| Feint Bomb next to a biter | hidden; the biter's blows go on the decoy (2000 → 1994 HP) |
| Triangle Shot, then Double Strafe | 1306 and 1302 on two dummies beside the target |
| Adoramus with no Grace | refused, no damage |
| Two Heals, then Adoramus | Grace 2 → 4; Adoramus 390; Grace spent |
| Three Blessings from one cell, then a step | Focus up to 5; gone after the step |
| Prestige 5, a monster's blows | 329 → 279, 375 → 318, 351 → 298, 319 → 271: 15% less each |
| Inspiration, Sacrifice killing a 4000 HP monster in two hits | HP 21100 → 19318: one hit's 9% of max HP back |
| Ray of Genesis, then Grand Cross | no HP spent, no damage taken; the cross hits 220 a second |
| Energy Gain 5, six seconds of attacks | 2 spheres |
| Snap past two dummies | 4805 on each; the Sura lands 6 cells on |
| Masterwork with an Axe | 1 Oridecon used, ATK +8 (4 refines at weapon level 1) |
| Axe Training 10, six seconds of attacks | 3 cleaves of 397 on the dummy beside |
| Reading Spellbook, then Fire Bolt 5 | 20 SP spent, no damage; Release (level 2, no sphere): 720 |
| Spell Fist 5 with Auto Spell holding Fire Bolt 3 | 4 melee hits, 4 Fire Bolts |
| Acid Demonstration, four casts | 55840 on the monster beside the target; 3 bottles back |
| Refresh on a poisoned Rune Knight | the poison ends; a new one does not start |
| Stone Hard Skin, two blows of 3598 and 3131 | the first taken whole by the shield, the second deals 1967; the break knocks the monster beside 3 cells away |
| Phantom Thrust | the monster beside the target ends up in front of the Rune Knight |
| Berserk with a two-handed sword | Bash refused; Wind Cutter goes off and starts Two-Hand Quicken |
| Fear Breeze 5, then Double Strafe | 5 hits; 4 arrows used |
| Sharp Shooting out of Camouflage | a critical |
| Two Claymore Traps, then Detonator | both go off at once: 8917 and 8751 on the monsters beside them |
| Reverberation, then Arrow Vulcan inside it | 9423 on the target; 3769 (40%) on the other monster inside; nothing on the one outside |

## What to watch out for

- **Renewal only.** The classes are third classes, so `mod.json` asks for
  renewal.
- **Don't switch it on with [custom-skills](../custom-skills).** Both rework
  the Guillotine Cross: custom-skills takes Dark Illusion and Hallucination
  Walk away, which this mod turns into passives.
- **One hook of a kind per skill in a mod.** A second `heal` hook on
  `AL_HEAL` in another file of this mod would replace the first, so
  Adoramus's Grace and Inspiration's refusal share one, in `heals.lua`.
  Different hooks on one skill are fine: Double Strafe has Triangle Shot's
  `on_hit` and Fear Breeze's `hits` and `on_cast`.
- **The descriptions are the old ones.** The client's skill tables still
  describe what each skill used to do; a mod for players ships its own
  `skilldescript.lub` rows (see custom-skills).
- **A field of the mod's own has no animation.** Holy Field and Resonance
  are `Dummyskill` units: they work, and the client draws nothing for them.
- **The mod's statuses end with a logout.** They live in the server's
  memory.

## Trying it

Copy the folder into the mods directory (see the [examples README](../README.md)),
switch it on in **Settings → Mods**, and restart the game. On a GM character,
`@jobchange` to a third class (4059 Guillotine Cross, 4073 Shadow Chaser,
4057 Arch Bishop, 4066 Royal Guard, 4070 Sura, 4058 Mechanic, 4055 Warlock,
4067 Sorcerer, 4071 Genetic, 4054 Rune Knight, 4056 Ranger, 4068 Minstrel,
4069 Wanderer), then `@allskill` or `@skillpoint 50` and the skill window.
