# vampiric-blade

A new one-handed sword that lifesteals on every hit, heals extra on
critical, and stuns anyone who critically hits its wielder. One `item(...)`
registration with both an `on_attack` and an `on_hit_taken` hook, in
[`lua/vampiric_blade.lua`](lua/vampiric_blade.lua).

This mod is the "both hooks on one item" case. For armor examples that
filter by attack type (physical, magical, dodged), see
[`thorns-plate`](../thorns-plate), [`arcane-ward`](../arcane-ward) and
[`mirage-cloak`](../mirage-cloak).

## What this example shows

- **Adding a new item through a mod.** `db/item_db.yml` gives the sword
  stats and an id; `System/itemInfo.lua` gives it a name, art and
  description client-side; `npc/npc_vendor.txt` is a shortcut vendor so
  you can hold one and attack something.
- **The `item(...)` Lua registration function.** The AegisName matches the
  one in `db/item_db.yml`, and the whole hook table is picked up at server
  start. No C++ change, no feature flag.
- **Both of the new hooks on one item.** `on_attack` fires for every
  swing or skill the wielder makes; `on_hit_taken` fires for every attack
  landed or dodged against them.
- **Reading the hit outcome off `c`.** `c.connected`, `c.critical` and
  `c.damage` cover every case we need; dodge/evade are just
  `c.connected == false`, crit is `c.critical == true`.
- **Reacting with the shared action set.** `c:drain()`, `c:heal(hp, sp)`
  and `c:status(...)` are the same actions `on_hit` has used since Lua
  skill hooks shipped -- an `item(...)` hook can use any of them.

## What it feels like in game

Equip the sword:

- Every connecting hit lifesteals 10% of the damage dealt (25% on a
  critical). Over a long fight this is a lot of sustain -- the sword
  rewards aggressive play more than defensive gear.
- The sword is dark-element, so it hits undead and demon targets harder
  and holy-defended targets softer. (The element is set by the item
  bonus in `db/item_db.yml`; the Lua hook does not touch element.)
- Any mob that lands a critical on you is stunned for 2 seconds. The map
  server log prints a line each time it happens, so you can see the
  trigger before the stun icon catches up.

## Try it

```
@item 30101
@useskill 0 0 0  // nothing, just to equip
@equip 30101     // if the inventory window is awkward from the console
@monster PORING 20
```

Hit the Porings. SP will not change (Porings do not crit you, mostly) but
HP ticks up on every hit. Swap to a boss like Osiris (`@monster OSIRIS 1`)
and the stun fires back the first time it criticals.

## What makes this different from a `db/item_db.yml` autobonus

A stock weapon can already have `bonus bHPDrainValue,...` or `bonus
bAutoSpell,...` through its item script. The limits are:

- Autobonus runs an rAthena script string, not Lua. There is no
  `c:polymorph()` or `c:heal(c.damage // 4)` -- just existing script
  commands against a fixed trigger.
- Autobonus triggers are coarse: `bf_short`, `bf_long`, `bf_weapon`,
  `bf_magic`, and the `bAutoSpellWhenHit`/`bAutoSpellOnSkill` families.
  Branching on "critical and connected and over 1000 damage" is awkward
  or impossible.
- A mod cannot inject brand-new behavior through autobonus -- it is
  limited to spells and bonuses the server already supports.

The item() hook sits above all of that. The sword's `Script:` field still
sets the dark element and anything else the game's bonus system already
knows how to do; the Lua hook adds the behavior that would otherwise need
a server change.

## Requires

App 1.3.9 or newer -- the version that added the item() Lua hooks. See
[docs/MODDING.md -> lua/](../../docs/MODDING.md#lua--changing-how-a-skill-or-item-works)
for the full hook reference, every field on `c`, and what each action
does.

## Applying it

`lua/`, `db/`, `npc/` and `System/` are read when the server (and asset
server) starts. **Apply** rebuilds everything in one go.
