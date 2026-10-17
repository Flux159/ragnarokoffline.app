# skill-tuning

Changes how a handful of stock skills work, without touching the server. Use it
as a reference for changing skills: what a mod can change, where each change
goes, what to watch out for, and what is still out of reach.

| Skill | Change | How | Switch |
|---|---|---|---|
| Blessing | lasts twice as long | `db/` Duration1 | always |
| Arrow Shower | 5×5 area at every level, no knockback, 10 SP | `db/` SplashArea, Knockback, SpCost | always |
| Arrow Shower | turns Wind while Improve Concentration is on | `lua/` `element` | always |
| Bash | +30% damage (adjustable), +10 hit | `lua/` `ratio`, `hit` | `bash_bonus` |
| Fire Bolt, Cold Bolt | cast 20% faster, renewal fixed cast halved | `db/` CastTime, FixedCastTime, one file per era | `faster_bolts` |
| Monk combos | 300 ms longer to press the next combo skill | `db/` AfterCastActDelay | `longer_combo_window` |
| Cold Bolt | 5% chance to freeze | `lua/` `on_hit` | `freezing_cold_bolt` (off by default) |

**Look at first:** [`db/skill_db.yml`](db/skill_db.yml), then
[`lua/skill_hooks.lua`](lua/skill_hooks.lua). Every file is commented. The
README is the overview; the comments explain each line.

```
skill-tuning/
├── mod.json                                     settings, and the two era folders
├── db/skill_db.yml                              always on: Blessing, Arrow Shower
├── db/when/longer_combo_window/skill_db.yml     only while that setting is on
├── pre-renewal/db/when/faster_bolts/skill_db.yml   pre-renewal numbers for the bolts
├── renewal/db/when/faster_bolts/skill_db.yml       renewal numbers for the bolts
├── lua/skill_hooks.lua                          always on: Bash, Arrow Shower
└── lua/when/freezing_cold_bolt/cold_bolt.lua    only while that setting is on
```

## Two layers: numbers and formulas

A skill is two things on the server:

- **Its numbers**, kept in rAthena's skill table (`db/pre-re/skill_db.yml`
  or `db/re/skill_db.yml`): cast time, delays, cooldown, SP cost, range, area,
  hit count, element, durations, requirements and flags. A mod changes these
  with its own `db/skill_db.yml`.
- **Its formulas**, written in the server's C++: how much damage a hit does,
  how likely it is to land, and what happens when it lands. A mod reaches
  these through Lua hooks in `lua/`.

| You want to change | Layer | Field or hook |
|---|---|---|
| cast time | `db/` | `CastTime`; renewal also `FixedCastTime` |
| aftercast delay (no skills for a while) | `db/` | `AfterCastActDelay` |
| no walking for a while after the skill | `db/` | `AfterCastWalkDelay` |
| cooldown of this one skill | `db/` | `Cooldown` |
| how long a buff, debuff or ground effect lasts | `db/` | `Duration1`, `Duration2` |
| SP, HP, zeny, item, weapon or ammo needed | `db/` | `Requires:` |
| range, area, number of hits, knockback | `db/` | `Range`, `SplashArea`, `HitCount`, `Knockback` |
| the skill's fixed element | `db/` | `Element` |
| behaviour switches (can't be used on bosses, ignores Land Protector, ...) | `db/` | `Flags:`, `DamageFlags:`, `CastTimeFlags:`, `CastDelayFlags:` |
| damage (the skill's damage %) | `lua/` | `ratio` |
| accuracy | `lua/` | `hit` |
| element depending on the situation | `lua/` | `element` |
| something extra on hit (status, heal, drain, autocast, polymorph) | `lua/` | `on_hit` |
| a Monk's combo window | `db/` | `AfterCastActDelay` of the skill that opens it |

Every field, with its meaning, is listed at the top of rAthena's
`db/pre-re/skill_db.yml`. Every hook, and everything `c` holds, is in
[docs/MODDING.md → lua/](../../docs/MODDING.md#lua--changing-how-a-skill-or-item-works).

## Changing a skill's numbers

1. Find the skill in rAthena's own table for your era:
   `vendor/rathena/db/pre-re/skill_db.yml` or `.../db/re/skill_db.yml`.
   Note its `Id` and `Name`, and the stock values you are about to change.
2. Write an entry in your mod's `db/skill_db.yml` with the `Id`, the `Name`
   and **only the fields you change**. Any field you leave out keeps rAthena's
   value.
3. Copy the header `Type: SKILL_DB` / `Version: 4` from
   `vendor/rathena/db/import-tmpl/skill_db.yml`.
4. Press **Apply** in Settings. The server restarts with the new table.

```yaml
Body:
  - Id: 47
    Name: AC_SHOWER
    Knockback: 0
    Requires:
      SpCost: 10     # the bow and the arrow it needs are untouched
```

A value is either one number, which applies to every level
(`AfterCastActDelay: 1000`), or a list of `- Level: N` / `Time: ms` pairs,
which sets each level.

## Changing a skill's formula

```lua
skill("SM_BASH", {
  ratio = function(c, stock) return stock * 130 // 100 end,  -- +30% damage
  hit   = function(c, stock) return stock + 10 end,           -- +10% to hit
})
```

`stock` is what the server worked out. Return a new value, or `nil` to keep
it. `ratio` is the skill's damage %. The usual modifiers (ATK, DEF, size,
race, element, cards) are applied after it, as in stock. Settings from
`mod.json` are read with `setting("skill-tuning", "bash_bonus", 30)`.

## Turning parts on and off, and the two eras

- **`db/when/<setting>/` and `lua/when/<setting>/`** are used only while that
  yes/no setting is ticked. A table there is **added** to the mod's own copy
  of the same table, and a Lua file there runs as its own part of the mod. This
  mod's three switches use them.
- **`renewal/` and `pre-renewal/`** are named in `mod.json` as
  `renewalFolder` and `prerenewalFolder`. Only the running era's folder is
  read. A file there at the same path as one in the mod's own folders
  **replaces** it; it does not add to it. The bolts need different numbers
  in each era, so this mod puts them in `<era>/db/when/faster_bolts/`. That is
  "add" rather than "replace", so `db/skill_db.yml` stays in effect beside
  them.

## Measured

Every change was checked on the rAthena commit `config/VENDOR_PINS` pins
(`5209ce0`), built for each era. The test used the app's own mod assembly and
compared a stock server with one running this mod. The characters were the
same in both runs: base 98 at low AGI and DEX.

| | pre-renewal: stock → mod | renewal: stock → mod |
|---|---|---|
| Fire/Cold Bolt Lv 10, cast bar | 6813 → 5450 ms | 3826 → 2701 ms |
| Blessing Lv 10 | 240 → 480 s | 240 → 480 s |
| Bash Lv 10 damage % (map log) | 400 → 520 | 400 → 520 |
| Monk combo window after Triple Attack | 958 → 1258 ms | 1258 ms with the mod |
| Arrow Shower on a Pupa (Earth) with Concentration | 40 → 23 damage | 314 → 302 damage |

The Arrow Shower damage goes *down* because Wind does only half damage to
Earth monsters. In renewal it hardly moves, because status ATK is always
Neutral there and only the bow and arrow part of the damage takes the new
element.

To watch the hooks in your own game, tick **Log every hook call** and read the
map server's log:

```
[Info]: Lua: skill-tuning: stsword Bash Lv 10 ratio 400 -> 520
[Info]: Lua: skill-tuning: starcher Arrow Shower turns Wind
[Info]: Lua: skill-tuning/freezing_cold_bolt: stmage Cold Bolt hit Golem for 180 - rolled freeze
```

At start-up it also prints
`Lua: loaded 3 of 3 file(s), 4 skill hook(s) across 3 skill(s)`.

## What to watch out for

- **A per-level list replaces every level, not just the ones you list.**
  rAthena fills the levels above your last one, either by continuing the
  trend of the levels you listed or by repeating the last one. List all of a
  skill's levels.
- **`Name` renames.** On an existing skill the `Id` picks the skill, and
  `Name` is written over its name without any check. A typo renames the skill
  and breaks every script and Lua hook that uses the old name. Copy it
  exactly, or leave it out.
- **Each era has its own stock numbers.** Fire Bolt is 0.7 s a level in
  pre-renewal and 0.5–3.2 s plus a fixed cast in renewal. A value written for
  one era is a different change in the other. Put such entries in era folders,
  as this mod does with the bolts.
- **`FixedCastTime` does nothing in pre-renewal.** That server does not read
  the field. To limit a pre-renewal skill in a way DEX can't remove, raise its
  `AfterCastActDelay`.
- **In an era folder, a file at the same path replaces the mod's own.** A
  `pre-renewal/db/skill_db.yml` would hide `db/skill_db.yml` completely. Use
  `when/` folders, or put every entry in both era files.
- **Aftercast delay applies to every skill.** `AfterCastActDelay` blocks all
  skills for that long, not only this one. To limit one skill alone, use
  `Cooldown`.
- **The Monk combo window is the combo skill's delay.** A longer window is
  also a longer pause before the Monk can do anything else. The window is
  `AfterCastActDelay − (4 × AGI + 2 × DEX)`, with 1000 used when the skill
  has none. A mod can change the 1000, not the formula.
- **The client keeps its own text and effects.** Skill descriptions in game
  still show the stock numbers unless the mod ships edited client files, and
  the client draws a skill's animation without reading the server's table. A
  wider `SplashArea` hits a wider area, but the effect looks the same.
- **Statuses from `c:status()` can be resisted.** The chance is a chance to
  *try*: Freeze is resisted by MDEF, and undead and boss monsters are immune,
  just like a card's effect.
- **A multi-hit bolt is one attack.** `on_hit` and `ratio` run once for a
  Lv 10 Cold Bolt, not ten times. `c.damage` is the whole cast's damage.
- **Hooks on one skill chain.** If two mods hook Bash's `ratio`, the one with
  the lower `priority` runs first, and the next gets its result as `stock`.
  Don't assume `stock` is the stock value.
- **Two mods changing the same skill in `db/` both apply.** Their entries go
  into one table in mod order, so where both set a field the later mod's value
  wins, and fields only the earlier mod set stay. Settings → Mods does not
  report it, unlike a clashing item or monster id.
- **`ratio`, `hit` and `element` only work on skills with a C++ class.** That
  is about 1,060 skills, including every damaging player skill. For any other,
  the log says
  `has no skill class in this server, so its ratio, hit and element hooks cannot run`.
  `on_hit` works on all of them.
- **`hit` only matters for attacks that can miss.** Magic and most ground
  skills always hit, and the server caps the result at its minimum and
  maximum hit rate (5–100% by default).
- **Every change needs Apply.** The tables and the Lua are read when the server
  starts, and Apply restarts it.

## What a mod cannot change (yet)

Each of these is C++ in the server, or a server setting mods are not allowed
to set. Changing one means a small, general hook in
[our rAthena fork](https://github.com/Flux159/rathena), off by default:
propose it on an issue first.

- **How stats change cast and delay.** DEX and INT shortening cast time,
  `castrate_dex_scale`, `delay_rate`, and the AGI/DEX part of the Monk combo
  formula. `conf/` takes only a short allowlist of settings, and these aren't
  on it.
- **`combo_delay_rate`**, the extra pause after a combo skill during which a
  Monk can't attack or walk.
- **What a status does.** How much STR Blessing gives, how fast Increase AGI
  makes you, how much Provoke lowers DEF. `Duration1`/`Duration2` change how
  long it lasts, not what it does. A mod can decide a server status's
  duration as it starts, or refuse it, and add statuses of its own:
  [New skills, passives and statuses](../../docs/mods/CUSTOM_SKILLS.md).
- **Healing.** How much Heal or Sanctuary restores. `ratio` is for damage.
- **Which stock skill leads into which**, and the spirit sphere checks
  between Monk combos. A combo of a mod's own is in reach: a status for the
  window, and `can_cast` to require it, as in
  [custom-skills](../custom-skills).
- **The damage formula around the ratio.** How DEF, MDEF, size or element
  apply. Those are the same for every skill, and `ratio` can only scale what
  comes before them.
- **Other on-hit effects.** On a hit, a hook can apply a status, heal, drain,
  cast a skill or polymorph. It can't push the target back or move it. The
  final damage of a hit can be changed, from a learned skill's or a status's
  `damage_dealt` and `damage_taken`.
- **A skill's cast time or delay depending on the caster.** `db/` numbers
  are the same for everyone. `can_cast` and `cost` run before a use, but only
  refuse it or change what it costs, and `c:cut_delay` shortens a delay only
  after the fact.

Two related changes *are* in reach without a server change. Which skills
monsters use, and how often, is `db/mob_skill_db.txt`. Which skills a job
can learn, and what each needs first, is `db/skill_tree.yml`. A mod can ship
both, the same way as `skill_db.yml`. Skills of a mod's own, passive or used,
are in reach too: [custom-skills](../custom-skills) adds seven.

## Trying it

Copy the folder into the mods directory (see the
[examples README](../README.md)), switch it on in **Settings → Mods**, choose
its options and press **Apply**.
