# New skills, passives and statuses

A mod can give a job skills it never had, take stock skills away from it, and
give those skills buffs and debuffs of their own, with stacks. That is enough
to rework a class: fewer skills, new passives, new statuses for them to build
and spend, and stock skills that work differently. The server side is the
mod's `db/` and `lua/`. The client side is four small tables under `data/`.
Nothing is rebuilt.

This page covers what a new skill is made of, how each kind works, how to take
a skill away without costing players their points, and what the client can and
cannot show. [Making mods → lua/](../MODDING.md#lua--changing-how-a-skill-or-item-works)
is the reference for every hook, field and action used here.
[`examples/mods/custom-skills`](../../examples/mods/custom-skills) is a
complete example: a Guillotine Cross that loses two skills and gains seven.

## What goes in the mod

```
my-class-rework/
├── mod.json
├── db/
│   ├── skill_db.yml        the new skills: id, name, levels, kind, range, cost, delays
│   └── skill_tree.yml      who learns them, and which stock skills go away
├── lua/
│   ├── passives.lua        what the passives do
│   ├── actives.lua         what the new skills do beyond their table entry
│   └── statuses.lua        the buffs and debuffs they use
├── npc/
│   └── refund.txt          skill points back for the skills taken away
└── data/luafiles514/lua files/skillinfoz/
    ├── skillid.lub         the new skills' names, for the client
    ├── skillinfolist.lub   icon, name, levels, SP, range, what it needs
    ├── skilldescript.lub   the description
    └── skilltreeview.lub   where each goes in the skill window, and what it leaves out
```

| | read by | decides |
|---|---|---|
| `db/skill_db.yml` | the map server, at start | that the skill **exists**: its id, name, levels, target, range, element, cast time, delays, cooldown, cost and area |
| `db/skill_tree.yml` | the map server, at start | which jobs learn it and what it needs first, and which stock skills a job no longer has |
| `lua/*.lua` | the map server, at start | what the skill **does**: its damage, what follows a hit, what a passive gives |
| `data/.../skillinfoz/*.lub` | the client, at load | what the player **sees**: the name, icon, description and place in the skill window. Nothing else |

They are joined by the skill's **name**, `GCR_VENOM_BURST`, and the client's
tables also by its **id**, 3103.

## Ids and names

rAthena's own skills stop at 3045 and start again at 5001, so **3100–4999 is
free in both eras**. Take a block and keep to it. A second mod with the same
id is the same skill: its entry is merged over yours, and Settings → Mods does
not report it the way it reports a clashing item or monster id. The fork has
room for 1,000 skills from mods on top of rAthena's own.

The name is the skill's AegisName. `skill_tree.yml`, Lua, NPC scripts
(`skill "GCR_VENOM_BURST", 5;`) and the client's `SKID` table all use it.
Give yours a prefix of your own (`GCR_`, for "Guillotine Cross rework"), so it
can never be a stock skill's name.

## A passive

A skill with no `TargetType` is learned and never used:

```yaml
# db/skill_db.yml
Header:
  Type: SKILL_DB
  Version: 4

Body:
  - Id: 3100
    Name: GCR_CONTACT_POISON
    Description: Contact Poison
    MaxLevel: 5
```

What it does is its hooks. They run for every player who has learned it,
whatever that player is doing, and `c.skill_lv` is the level learned:

```lua
-- lua/passives.lua: 10% a level that a normal attack which lands poisons.
skill("GCR_CONTACT_POISON", {
  on_attack = function(c)
    if c.attack_skill_id == 0 and c.connected and c:chance(1000 * c.skill_lv) then
      c:apply_status("GCR_TOXIN", { stacks = 1 }, "target")
    end
  end,
})
```

| Hook | Runs | `c.caster` | `c.target` |
|---|---|---|---|
| `bonus(c)` | whenever the player's stats are worked out | the player | — |
| `on_attack(c)` | the player attacked, normal or skill, hit or miss | the player | what it attacked |
| `on_hit_taken(c)` | the player was attacked | the attacker | the player |
| `damage_dealt(c, damage)` | the final damage of the player's blow. Return a new one | the player | what it hit |
| `damage_taken(c, damage)` | the final damage of a blow at the player | the attacker | the player |
| `on_kill(c)` | the player killed something | the player | what died |
| `on_death(c)` | the player is about to die. `c:survive()` keeps them at 1 HP | the killer, or nil | the player |
| `on_skill(c)` | the player used a skill: `c.used_skill`, `c.used_skill_id`, `c.used_skill_lv`, and `c.x`, `c.y` | the player | the skill's target; nil for a ground skill |
| `tick(c)` | every second, while the player is online and alive | the player | the player |
| `stats(c, s)` | whenever the player's stats are worked out: change `s.amotion` (attack speed), `s.maxhp`, `s.flee2`, ... as a status's `stats` does | the player | the player |
| `craft(c, rate)` | the player is about to craft `c.item_name` with `c.craft_skill`. Return the chance, out of 10000 | the player | — |
| `on_craft(c, item)` | the player made `item`: change `item.amount` or `item.options` before it goes into the bag | the player | — |
| `on_use(c)` | the player is using a consumable, `c.item` (with `creator`, for a potion they brewed) | the player | the player |

`stats` is for what an item bonus cannot say, such as a cap: Perfect Dodge
that never goes past 30, or attack speed that turns into ATK at the server's
limit. `bonus` takes item bonuses by name, exactly as rAthena's `doc/item_bonus.txt`
lists them: `c:bonus("bFlee2", c.skill_lv)`, `c:bonus2("bSkillAtk",
"AS_SONICBLOW", 20)`, and so on up to `c:bonus5`. `c:grant_skill("AL_HEAL", 3)`
lends a skill the way a card does. Everything a bonus gives shows in the
status window.

These hooks work on stock skills as well: `skill("AS_KATAR", { bonus = ... })`
gives something to every player with Katar Mastery. They run for players only;
a monster or homunculus with the skill does not run them.

## A skill a player uses

Give it a `TargetType`, what it costs, and `custom = true` in its Lua:

```yaml
  - Id: 3103
    Name: GCR_VENOM_BURST
    Description: Venom Burst
    MaxLevel: 5
    Type: Weapon
    TargetType: Attack
    Range: 1
    Hit: Single
    HitCount: 1
    Element: Weapon
    AfterCastActDelay: 1000
    Cooldown: 2000
    Requires:
      SpCost: 30
```

```lua
skill("GCR_VENOM_BURST", {
  custom = true,
  ratio = function(c, stock) return stock + 60 * c.skill_lv end,
})
```

What a stock skill does is C++ in the server, a class for each skill. A new
skill has none. `custom = true` gives it one that does what its table entry
says:

| `TargetType` | What it does |
|---|---|
| `Attack` | hits its target. With a `SplashArea`, everything around the target too |
| `Self` | starts its `Status` on the caster. With a `SplashArea` and a `Type` that deals damage, hits everything around the caster |
| `Support` | starts its `Status` on the target |
| `Ground` | places its `Unit`. With none, hits everything in its `SplashArea` once |

The damage is the skill's `Type` (`Weapon`, `Magic` or `Misc`) at its `ratio`,
100% unless the hook says otherwise, through the server's usual formula: ATK or
MATK, DEF, element, size, race and cards. `Element`, `HitCount`, `Range`, cast
time, delays, cooldown and cost are the table's, as for any skill. A splash
passes over enemies that are hiding when `DamageFlags` has `Splash: true`, as
Magnum Break's does.

`Status` is one of the server's own (`IncreaseAgi`, `Angelus`, ...). To start
one of the mod's own statuses instead, call `c:apply_status` from `on_cast`.

A ground skill that hits over time takes the `Dummyskill` unit. Each
`Interval` it deals the skill's damage to the enemies standing in it, for
`Duration1`, with nothing else built in:

```yaml
    TargetType: Ground
    Duration1: 6000
    Unit:
      Id: Dummyskill
      Layout: 2          # 5x5
      Interval: 1000
      Target: Enemy
```

Any other unit does what it does for its own stock skill, which is rarely what
a new skill wants.

Whatever else the skill does is its hooks: `on_hit` after each hit, `on_cast`
once per use.

**To rework a stock skill from scratch**, give it `replace = true` instead.
It keeps its id, name and table entry, and its own class is swapped for the
one a new skill gets. Checks and formulas the server keeps elsewhere for that
skill's id, which some skills have, still apply. To change only its damage, or
what follows a hit, hook it without `replace`.

## When a skill may be used, and what it costs

More hooks work on any skill, a stock one or a mod's own:

- `can_cast(c)` runs when a player starts to use it. Returning `false`, with
  a message, refuses the use and shows the player the message.
- `cost(c, cost)` changes what a use costs, in place: `cost.sp`, `cost.hp`,
  `cost.ap`, `cost.zeny`, `cost.spiritball`, `cost.ammo_qty`, and `cost.items`,
  a list of `{ item = "RED_POTION", amount = 1 }`. The server asks for it
  several times for one use, so it must only compute: no actions, and nothing
  that counts or remembers. When it checks again at the end of the cast and
  takes the cost, `c.target` is the target (`c.x`, `c.y` for a ground
  skill): a cheaper strike on a marked enemy is a `cost` hook. The first
  check, before the cast, has no target yet.
- `range(c, range)` says how far the skill reaches for `c.caster`, from the
  server's own (`range`, its `Range` with Vulture's Eye and the like): a
  longer reach for those who have a passive or a status. On a status, it
  works for every skill its holder uses.
- `before_cast(c)` runs once per use just before the effect, while the
  caster still stands where it cast from: the place for a dash, or for what
  lies on the way. Returning `false` stops the effect: the use is paid for
  and nothing else happens.
- `on_cast(c)` runs once per use, after the skill's effect, for monsters as
  well as players. `c.x` and `c.y` are where.
- `hits(c, stock)` and `critical(c, stock)` decide how many hits it deals
  and whether a weapon hit is a critical.

Together they make a combo window: a skill that opens it, a status that is the
window, and a skill that needs it.

```lua
status("GCR_SONIC_WINDOW", { icon = "EFST_COMBOATTACK", duration = 3000 })

skill("AS_SONICBLOW", {
  on_cast = function(c) c:apply_status("GCR_SONIC_WINDOW", {}, "caster") end,
})

skill("GC_CROSSIMPACT", {
  can_cast = function(c)
    if not c.caster:has_status("GCR_SONIC_WINDOW") then
      return false, "Cross Impact follows a Sonic Blow."
    end
  end,
  cost = function(c, cost) cost.sp = cost.sp // 2 end,
  on_cast = function(c) c:remove_status("GCR_SONIC_WINDOW", "caster") end,
})
```

Count the opener's own delays into the window. A player cannot use the next
skill before the opener's `AfterCastActDelay` has passed, nor use a skill that
needs to move (`State: Move_Enable`) before its `AfterCastWalkDelay` and the
server's 300 ms walk delay have. Pre-renewal's Sonic Blow holds the caster
for 2.3 seconds, so a 3-second window there leaves 0.7.

## Statuses: buffs, debuffs, marks and windows

`status("<NAME>", { ... })` defines a status of the mod's own: a name, how
long it lasts, how many stacks it can hold, and hooks.

```lua
-- lua/statuses.lua
status("GCR_TOXIN", {
  icon = "EFST_TOXIN",
  duration = 8000,
  max_stacks = 10,
  max_stacks_boss = 3,
  max_stacks_player = 5,
  per_source = true,
  decay = { every = 4000, stacks = 1 },

  -- Whoever poisoned the unit hits it 2% harder a stack.
  damage_taken = function(c, damage)
    if c.source and c.caster and c.caster.id == c.source.id then
      return damage * (100 + 2 * c.stacks) // 100
    end
  end,

  -- 4 HP a stack every second, dealt by the poisoner.
  tick = function(c) c:hurt(4 * c.stacks) end,
})
```

| Field | Means | Default |
|---|---|---|
| `icon` | the icon a player sees while it lasts: one the client has, by its `EFST_` name | none |
| `duration` | how long it lasts, in ms | 0: until it is taken off |
| `refresh` | a new application starts the duration again | `true` |
| `max_stacks` | the most stacks it holds | 1 |
| `max_stacks_boss`, `max_stacks_player` | the most on a boss, and on a player | `max_stacks` |
| `per_source` | each unit that applies it keeps a count of its own | `false` |
| `decay` | `{ every = ms, stacks = n }`: loses `n` stacks every `ms` | never |
| `end_on_death` | ends when the unit dies. `false` keeps it on a player; a monster's ends anyway | `true` |

Its hooks see `c.status_name`, `c.unit` (who has it), `c.source` (who applied
it, or nil once that unit has logged out or gone), `c.stacks` and
`c.remaining` (ms, or -1 for no end):

| Hook | Runs | Return |
|---|---|---|
| `bonus(c)` | a player who has it has their stats worked out | nothing. `c:bonus(...)`, as in a passive |
| `stats(c, s)` | any unit who has it has their stats worked out, monsters too | nothing. Change `s.def`, `s.def2`, `s.mdef`, `s.mdef2`, `s.hit`, `s.flee`, `s.flee2`, `s.cri`, `s.speed`, `s.batk`, `s.atk`, `s.matk_min`, `s.matk_max`, `s.amotion`, `s.maxhp`, `s.maxsp`. `flee2` and `cri` are in tenths: +30 is 3 more. `s.str` to `s.luk` are there to read |
| `damage_dealt(c, damage)` | the final damage of a blow by the unit | the damage |
| `damage_taken(c, damage)` | the final damage of a blow at the unit | the damage |
| `on_attack(c)`, `on_hit_taken(c)`, `on_kill(c)` | the unit attacked, was attacked, killed something | nothing; actions |
| `on_death(c)` | the unit, player or monster, is about to die. `c:survive()` keeps it at 1 HP | nothing |
| `on_skill(c)` | the unit used a skill, `c.used_skill` | nothing; actions |
| `cost(c, cost)`, `can_cast(c)` | for every skill the player who has it uses: a discount, a lock | as a skill's own |
| `critical(c, stock)` | every weapon hit by the unit; `c.used_skill_id` is 0 for a normal attack | `true` or `false` |
| `craft(c, rate)`, `on_craft(c, item)`, `on_use(c)` | as a passive's | as a passive's |
| `on_start(c)` | it starts | nothing; actions |
| `on_end(c)` | it ends. `c.reason` is `"expired"`, `"decayed"`, `"removed"` or `"death"` | nothing; actions |
| `tick(c)` | every second | nothing; actions |

A hook that can act puts it on with `c:apply_status(name, { stacks = 1,
duration = ms, source = unit }, who)` and takes it off with
`c:remove_status(name, who, stacks, source)`. `who` is `"target"`, the
default, or `"caster"`, or a unit, such as one from `c.caster:party(5)`. The
status is applied by the hook's owner — the player who learned the passive,
the unit that has the status — unless `source` names someone else. With no
`stacks`, `remove_status` takes them all; with a `source`, only the ones that
unit applied. `unit:has_status(name)` and `unit:status_stacks(name, source)`
ask about it from any hook.

A status with no hooks at all is a marker, like the combo window above, for
other hooks to ask about.

A mod's status lives in the server's memory. It ends with a logout or a server
restart, and with the unit's death unless `end_on_death = false`. With
`persist = true`, a player keeps it over a logout and a restart: it is kept in
the mod's [char store](../MOD_STORE.md) with its stacks and the time it had
left, and goes on when they are back.

### The server's own statuses

`status()` with a server status's name takes `on_start`, `on_end` and
`chance`. `on_start` sees `c.duration` and `c.val1` to `c.val4`, and returns a
new duration in ms, or `false` to refuse the status. `chance(c, rate)` returns
how likely it is to land, out of 10000 before the target's resistance. All
three see `c.status_name`, `c.debuff` and `c.by_skill`, the skill that started
it as far as the server knows. `c.caster` is whoever started it, and
`c.target` whoever gets it:

```lua
-- Cloaking Exceed lasts 10% longer a level of Shadow Instinct.
status("SC_CLOAKINGEXCEED", {
  on_start = function(c)
    local lv = c.caster and c.caster:skill_lv("GCR_SHADOW_INSTINCT") or 0
    if lv > 0 and c.duration > 0 then
      return c.duration * (100 + 10 * lv) // 100
    end
  end,
})
```

`status("*", { ... })` takes the same three hooks for every server status at
once: an immunity, a cleanse, a log of what lands.

What a server status *does*, such as how much STR Blessing gives, is still its
C++, but the numbers it works from are its `val1` to `val4`:
`unit:status_info("SC_POISONREACT")` reads them, and
`c:status_val("SC_POISONREACT", 2, 6)` changes one while it runs (Poison
React's counters, here). `on_start` is asked once the status has got past the target's resistance,
and the server can still turn it away after that: an Undead is immune to
Freeze, and some statuses cannot start again while they last. A status a
character logs in with does not ask `on_start`, but one it logs out with runs
`on_end`.

## Recipes: what a class rework is made of

Most effects a reworked class wants are a few lines of the hooks and actions
above, put together. Each recipe is the shape of one;
[`examples/mods/third-class-sampler`](../../examples/mods/third-class-sampler)
has them working, with the numbers measured.

**A splash, a bounce, an echo.** One more hit of the skill on others nearby,
at part of the damage. `c:attack` runs no hook that can act, so the bounce
cannot bounce again:

```lua
skill("CR_SHIELDBOOMERANG", {
  on_hit = function(c)
    if not c.connected then return end
    local near = units_around(c.target, 3, { enemy_of = c.caster, exclude = c.target, limit = 2 })
    for _, u in ipairs(near) do
      c:attack("CR_SHIELDBOOMERANG", c.skill_lv, u, { power = 50 })
    end
  end,
})
```

**A proc with a cooldown of its own.** The cooldown is a status with no
hooks; the proc checks for it and puts it on:

```lua
status("WL_COLD_SNAP_CD", { duration = 8000 })

skill("WL_COLD_SNAP", {   -- a passive
  on_hit_taken = function(c)
    if c.ranged or c.target:has_status("WL_COLD_SNAP_CD") then return end
    if c:chance(500 * c.skill_lv) then
      c:apply_status("WL_COLD_SNAP_CD", {}, "target")
      c:cast("WZ_FROSTNOVA", 5, "target", { by = "target" })  -- cast by the one who was hit
    end
  end,
})
```

**A shield.** A status whose stacks are the HP it has left. `damage_taken`
works out what it absorbs; it cannot act, so `on_hit_taken`, which runs
after it, takes the stacks off. A local table carries the number between
the two:

```lua
local absorbed = {}

status("RK_STONE_SKIN", {
  max_stacks = 100000, duration = 30000,
  damage_taken = function(c, damage)
    local take = math.min(damage, c.stacks)
    absorbed[c.unit.id] = take
    return damage - take
  end,
  on_hit_taken = function(c)
    local take = absorbed[c.unit.id]
    absorbed[c.unit.id] = nil
    if take and take > 0 then c:remove_status("RK_STONE_SKIN", "target", take) end
  end,
  on_end = function(c)   -- broken: push everyone back
    if c.reason == "removed" then
      for _, u in ipairs(units_around(c.unit, 2, { enemy_of = c.unit })) do
        c:knockback(u, 3, c.unit)
      end
    end
  end,
})
```

**Stacks that change stats.** A status's `stats` hook can change attack
speed (`s.amotion`, in ms: lower is faster), and works on monsters too:

```lua
status("GCX_FLURRY", {
  max_stacks = 10, duration = 5000,
  stats = function(c, s)
    s.amotion = s.amotion - 4 * c.stacks   -- kept within the server's ASPD limit
    s.batk = s.batk + 2 * c.stacks
  end,
})
```

**A window, a finisher, a mark.** A status with no hooks is a marker: one
skill puts it on, another needs it (`can_cast`) or does more against it
(`ratio`), and takes it off (`on_cast`). The Sonic Blow → Cross Impact
example above is one; a mark on a target is the same with `"target"`.

**Changing a server status while it runs.** `unit:status_info` reads
`val1` to `val4`, `c:status_val` changes one. A server status's `on_start`
can act, a moment after the status has started. It sees the values the
status was asked to start with: those the server works out itself (Poison
React's counters, half its level) are set just after, and the action lands
after that:

```lua
status("SC_POISONREACT", {
  on_start = function(c)   -- two more counters (val2 counts them)
    c:status_val("SC_POISONREACT", 2, c.val1 // 2 + 2, "target")
  end,
})
```

**An immunity, a cleanse.** `unit:statuses({ debuff = true })` lists the
debuffs a unit carries, the common ailments (poison, stun, freeze and the
rest) among them; `c:end_status` ends each. `status("*", { chance = ... })`
returning 0 keeps new ones off:

```lua
status("RK_REFRESH_GUARD", { duration = 30000 })

status("*", {
  chance = function(c, rate)
    if c.debuff and c.unit:has_status("RK_REFRESH_GUARD") then return 0 end
  end,
})
```

**A crafting bonus under a shared cap.** `craft` sees the server's own
chance as `c.base`, and each hook sees the one before's result: capping at
`c.base + 1500` keeps every bonus together under +15 points.

```lua
skill("GCX_RESEARCH_NEW_POISON", {
  craft = function(c, rate)
    if c.craft_skill == "ASC_CDP" then
      return math.min(rate + 200 * c.skill_lv, c.base + 1500)
    end
  end,
})
```

**Better potions for their brewer.** `on_use` sees the item, with the char
id of whoever brewed it:

```lua
skill("GNX_SIGNATURE_BREW", {
  on_use = function(c)
    if c.item.creator == c.caster.char_id and c.item.name:find("Potion") then
      c:heal(c.caster.maxhp * c.skill_lv // 100, 0, "caster")
    end
  end,
})
```

**A decoy.** `before_cast`'s actions happen before the effect, and `false`
keeps the stock effect (Feint Bomb's bomb) from happening at all, the use
still paid for. The decoy is there when `on_cast`, which runs all the same,
turns the monsters on it. The decoy itself is a monster of the mod's own in
`db/mob_db.yml`:

```lua
local DECOY, DECOY_ID = "SCX_DECOY", 25300

skill("SC_FEINTBOMB", {
  before_cast = function(c)
    c:summon(DECOY, { duration = 3000 * c.skill_lv, x = c.caster.x, y = c.caster.y })
    c:status("SC_HIDING", 10000, 2000, 1, "caster")
    return false
  end,
  on_cast = function(c)
    local decoy
    for _, u in ipairs(units_around(c.caster, 1, { kind = "mob" })) do
      if u.master_id == c.caster.id and u.mob_id == DECOY_ID then decoy = u end
    end
    if not decoy then return end
    for _, m in ipairs(units_around(c.caster, 9, { enemy_of = c.caster, kind = "mob" })) do
      c:set_target(m, decoy)
    end
  end,
})
```

**Movement.** `c:slide` moves a unit to a cell at once (a dash, a pull),
`c:knockback` pushes it away from a unit or a cell, `c:teleport` sends it
somewhere random. `before_cast` still sees the caster where it was, which is
what a skill that hits everything on its way needs:

```lua
skill("MO_BODYRELOCATION", {   -- Snap deals Knuckle Arrow to what it passes
  before_cast = function(c)
    local lv = c.caster:skill_lv("SR_KNUCKLEARROW")
    if lv == 0 then return end
    local landing = { map = c.caster.map, x = c.x, y = c.y }
    for _, u in ipairs(units_in_line(c.caster, landing, 1, { enemy_of = c.caster })) do
      c:attack("SR_KNUCKLEARROW", lv, u)
    end
  end,
})
```

A skill hit with `c:attack` needs a `Type` and a `HitCount` in
`skill_db.yml`: a passive the mod hits with (Axe Training's cleave) gets
both there.

**Fields on the ground.** `c:place_unit` puts a ground skill down outside its
own limit, `unit:ground_units` and `ground_units_around` find them (`x`, `y`
the middle of the cells), `c:end_unit` removes one, and `unit:in_skill_area`
says who stands in one. A field of the mod's own is a skill in
`db/skill_db.yml` with a `Dummyskill` unit: a square `Layout`, or one cell
placed many times for any other shape. Grand Cross leaving a holy cross
behind:

```lua
local CROSS = { {0,0}, {1,0}, {2,0}, {-1,0}, {-2,0}, {0,1}, {0,2}, {0,-1}, {0,-2} }

skill("CR_GRANDCROSS", {
  on_cast = function(c)
    for _, d in ipairs(CROSS) do
      c:place_unit("RGX_HOLY_FIELD", c.skill_lv, c.x + d[1], c.y + d[2], { duration = 4000 })
    end
  end,
})

skill("RGX_HOLY_FIELD", { custom = true, ratio = function(c) return 50 + 20 * c.skill_lv end })
```

A `Dummyskill` unit hits whoever stands in it every `Interval`, with the
skill's `Type`. With `Interval: -1` it never acts on anyone: a zone only
`in_skill_area` reads (the sampler's Reverberation).

A `power` on `c:place_unit`, or on a `c:cast` of a ground skill, reaches the
hits its units deal later: a Storm Gust echoed at half power ticks at half
power.

**Holding a skill back.** `before_cast` returning `false` stops a use's
effect once it is paid for: a spell can be stored and let go later with
`c:cast`.

**A reused skill whose own check no longer fits.** The server checks some
skills in ways written for that skill alone: Spell Fist only while a bolt is
being cast, Release at level 2 only with a summoned sphere. A mod that gives
the skill a new effect turns those off with `stock_checks = false`, and adds
its own with `can_cast`:

```lua
skill("SO_SPELLFIST", {
  replace = true,
  stock_checks = false,
  can_cast = function(c)
    if c.caster:status_info("SC_AUTOSPELL") == nil then
      return false, "Cast Auto Spell first."
    end
  end,
})
```

**Arrows.** A `cost` hook's `ammo_qty` is how many arrows a use needs; the
server still uses up only the skill's own `AmmoAmount`. To use more, take
them in `on_cast` with `c:take_item(c.caster.ammo_id, n)` (the sampler's
Fear Breeze).

**A longer reach.** A trap passive that adds a cell of placement range per
level, for those who learned it:

```lua
for _, trap in ipairs({ "HT_LANDMINE", "HT_ANKLESNARE", "HT_CLAYMORETRAP" }) do
  skill(trap, {
    range = function(c, range) return range + c.caster:skill_lv("RAX_FIELD_ENGINEERING") end,
  })
end
```

**Cooldowns.** `c:cooldown(skill, ms)` starts a skill's cooldown as a use
would (the hotkey bar shows it), `0` ends it, and `unit:cooldown_left(skill)`
reads what is left: one skill that puts another on cooldown, a proc that
resets one.

**The server's numbers.** `battle_config("max_parameter")` reads the battle
config; `element_rate`, `size_rate` and `def_rate` are the element table, the
size table and the era's hard DEF formula, for a hook that works out a blow
of its own (a pierce that gives back part of what DEF took, a fist that
ignores size).

**Copying and lending skills.** `c:copy_skill` fills Plagiarism's or
Reproduce's slot (`unit:mob_skills()` lists a monster's), and `c:itemskill`
lets a player use a skill once, as a scroll does. `c:produce_menu` opens a
crafting window, for a skill that crafts.

**Mounts.** `c:mount("mado", true)` puts a Mado Gear on a player;
`unit.riding` says what it rides. Whether the client draws that class on it
is the client's affair.

**What `status.yml` decides.** A server status's flags (that it stops skills,
that it stops movement, that dispelling ends it) are in `status.yml`, and a
mod's `db/status.yml` can change them. To let one skill be used in Berserk,
take `NoCast` off Berserk there, and refuse the others with a status's
`can_cast`, which sees every skill its holder uses.

**State.** A local table in the file keeps anything until the server
restarts: a last target, a count, a timestamp from `now()`. What must outlast
a restart or a logout goes in the [mod store](../MOD_STORE.md#from-a-lua-hook)
(`store.char`).

## Taking a skill away

`MaxLevel: 0` in a job's `skill_tree.yml` removes a skill from that job, and
from every job that inherits its tree:

```yaml
# db/skill_tree.yml
Header:
  Type: SKILL_TREE_DB
  Version: 1

Body:
  - Job: Guillotine_Cross
    Tree:
      - Name: GC_DARKILLUSION
        MaxLevel: 0
      - Name: GC_PHANTOMMENACE      # needed Dark Illusion 5
        MaxLevel: 1
        Requires:
          - Name: GC_DARKILLUSION
            Level: 0                # a requirement at Level 0 is taken away
```

- **Check what needed it.** A skill whose requirement is gone can no longer be
  learned, and a character who has it loses it. Take the requirement away, as
  above, or point it at another skill.
- **Every entry needs its `MaxLevel`.** A skill that only gets new
  requirements repeats its stock one. A requirement listed is added or
  changed; the skill's others stay.
- **Know which jobs inherit.** rAthena's own `db/re/skill_tree.yml` says,
  under `Inherit:`. The transcendent and baby third jobs and the fourth jobs
  inherit the third job's tree, so a change there reaches them all.
- **Mind the skill points.** A job has as many skill points as its job levels
  give, so every skill added costs the player one taken somewhere else. Taking
  a stock skill away is what makes room.

### The points it cost

A character who had learned a skill that is taken away loses it, and the
points it cost: the server forgets a skill that is no longer in the job's
tree, and the character's next save drops it from the database for good.
Until that save, the database still has it.

The example's [`npc/refund.txt`](../../examples/mods/custom-skills/npc/refund.txt)
reads those rows when a character logs in and gives the points back, once.
Copy it, and list the ids your mod takes away. It also clears the level the
server still holds for the rest of that session; without that, a skill reset
in the same session would pay the points out a second time. A character whose
job still has the skill keeps it and is not paid.

### In the skill window

The client draws a job's skill window from its own tables, so a skill taken
away stays in it, unlearnable, until the mod's `skilltreeview.lub` leaves it
out with `SKILL_TREEVIEW_HIDE` (below).

## What players see: the client's skill tables

The client knows a skill by four tables, in
`data/luafiles514/lua files/skillinfoz/`. Each is one table for every skill in
the game, so a mod does not replace them: it ships files of the same names
holding only its own rows, and the app adds them to the client's. Mods are read
in order after the client's own tables, every mod's `skillid.lub` first, so a
later mod's row for a skill wins.

### skillid.lub

The new skills' names and ids, for the other three tables:

```lua
SKID = {
	GCR_CONTACT_POISON = 3100,
	GCR_VENOM_BURST = 3103,
}
```

Only the new skills: the client knows the rest.

### skillinfolist.lub

What the skill window knows of a skill: its icon, name, levels, SP, range and
what it needs first.

```lua
SKILL_INFO_LIST = {
	[SKID.GCR_VENOM_BURST] = {
		"GC_VENOMPRESSURE";
		SkillName = "Venom Burst",
		MaxLv = 5,
		SpAmount = { 22, 24, 26, 28, 30 },
		bSeperateLv = true,
		AttackRange = { 1, 1, 1, 1, 1 },
		_NeedSkillList = {
			{ SKID.GCR_CONTACT_POISON, 1 },
		},
	},
}
```

- **The first value names the icon**: the client draws `<it>.bmp` from the
  `item` folder of its interface textures, where the stock skills' icons are.
  A stock skill's name borrows that skill's icon, so a mod needs no image.
- **A row replaces the client's whole row** for that skill. To change a stock
  skill's requirements in the window, as `skill_tree.yml` changed them on the
  server, ship its full row.
- **`bSeperateLv`** (the client's spelling) lets the player choose the level
  to use. A passive has `false`.

### skilldescript.lub

The description the skill window shows, a line per string. `^rrggbb` starts a
colour and `^000000` goes back to black:

```lua
SKILL_DESCRIPT = {
	[SKID.GCR_VENOM_BURST] = {
		"Venom Burst",
		"Max Level:^777777 5 ^000000",
		"Requirement:^777777 Contact Poison 1 ^000000",
		"Skill Form:^777777 Offensive ^000000",
		"Description:^777777 A strike that bursts your Toxin on the target. ^000000",
	},
}
```

### skilltreeview.lub

Where a job's skill window puts each skill, by slot: counted from the top left,
seven to a row. A skill already on a slot a mod takes moves to the first free
one.

```lua
SKILL_TREEVIEW_FOR_JOB = {
	[JOBID.JT_GUILLOTINE_CROSS] = {
		[7] = SKID.GCR_VENOM_BURST,       -- Dark Illusion's place
	},
	[JOBID.JT_GUILLOTINE_CROSS_H] = {
		[7] = SKID.GCR_VENOM_BURST,
	},
}

SKILL_TREEVIEW_HIDE = {
	[JOBID.JT_GUILLOTINE_CROSS] = { SKID.GC_DARKILLUSION },
	[JOBID.JT_GUILLOTINE_CROSS_H] = { SKID.GC_DARKILLUSION },
}
```

`SKILL_TREEVIEW_HIDE` is not in the client's own file. It is how a mod takes a
skill out of a job's window. A job whose window shows that job's tab leaves it
out as well: the Shadow Cross's window shows the Guillotine Cross's skills.
The transcendent (`_H`) and baby (`_B`) jobs have windows of their own, so list
them too.

- **A tab can hold an earlier job's skills.** A first job's window shows the
  Novice's skills on the same tab, and a transcendent second job's the second
  job's. A slot one of those fills is not the mod's to take; the mod's skill
  goes to the first free slot instead.
- **A name the client does not know is left out**, and the browser console
  says so, rather than landing on the Novice's window.

The client keeps what it has downloaded. After changing a table, see
[The client caches, hard](../MODDING.md#the-client-caches-hard).

## Limits

- **A new skill has no animation of its own.** The client draws a skill's
  effect from its own code, by the stock skills' ids. A new skill shows its
  cast bar, its damage and the status icons, and nothing more.
- **A status icon is one the client already has.** It takes the stock status's
  tooltip with it.
- **A mod's statuses end with a logout or a restart**, unless `persist = true`
  keeps a player's.
- **Passives and `cost`/`can_cast` are for players.** A monster that uses a
  skill runs its `ratio`, `on_hit` and `on_cast`, and nothing a learner would.
- **`custom = true` covers the four kinds above.** What a skill does beyond
  them is its hooks and actions: a push or a pull (`c:knockback`,
  `c:slide`), a dash, a line (`units_in_line` and `c:attack`), a field
  (`c:place_unit`). What no hook can reach is a request for a general one in
  [the fork](https://github.com/Flux159/rathena), made on an issue first.
- **`tick` hooks run every second for every player who has the skill.** Keep
  them short.
- **A reused skill keeps the server's own checks for it**, the ones written
  for that skill alone (Spell Fist only while casting a bolt), until
  `stock_checks = false` turns them off. Its `skill_db.yml` requirements
  still apply either way.

## Checking your work

At start-up, the map server's log says what loaded. For the example:

```
[Status]: Lua: loaded 4 of 4 file(s), 16 skill hook(s) across 9 skill(s), 0 item hook(s) across 0 item(s), 4 status(es) of mods' own and hooks on 1 of the server's.
```

A table that does not parse is named under Settings → Mods, and a hook that
fails is switched off and named in the log. `log(...)` from any hook writes a
line of your own there.

To see what the hooks do, a second mod can watch from the outside: a passive
of its own, given to a test character, whose `damage_taken` logs each blow
before the statuses' hooks change it (passives run first), whose
`on_hit_taken` logs what the blow dealt in the end, and whose `tick` logs the
character's statuses. The third-class-sampler's test works that way. Both
examples' tests are in the rAthena fork's
[`tools/lua-test`](https://github.com/Flux159/rathena/tree/ragnarokoffline/tools/lua-test),
with a headless client that plays them against a local server.

In game, a GM character can try it all at once: `@jobchange 4059` for a
Guillotine Cross, `@skillpoint 20` for points to spend, and `@resetskill` to
get them back.
