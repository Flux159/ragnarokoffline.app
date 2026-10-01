# arcane-ward

An accessory that silences and absorbs any caster who hits the wearer
with a spell. Weapon and misc attacks pass through. One `item(...)`
hook, in [`lua/arcane_ward.lua`](lua/arcane_ward.lua).

## What this example shows

- **Magical-only filter.** `c.weapon_type ~= "magic"` returns early.
  Fire Bolt and Lightning Bolt fire the hook; a Knight's Bash does
  not.
- **Routing a heal to the wearer, not the attacker.** `c:heal(hp, sp,
  who)` takes an optional third argument, `"caster"` (default, the
  attacker) or `"target"` (the defender). In `on_hit_taken` on an
  armor the wearer is the defender, so the hook passes `"target"`
  explicitly.
- **Combining a status with a numeric effect.** Silencing the caster
  is `c:status`; absorbing SP is `c:heal`. Both are queued into the
  same hit and applied together after the damage lands.

## Pair with `thorns-plate` and `mirage-cloak`

Three example mods, three filter patterns:

| Mod | Filter | What it reacts to |
|---|---|---|
| [`thorns-plate`](../thorns-plate) | physical only (`c.weapon_type == "weapon"`) | hits that connected |
| [`arcane-ward`](.) | magical only (`c.weapon_type == "magic"`) | hits that connected |
| [`mirage-cloak`](../mirage-cloak) | both | hits that **missed** |

## Try it

```
@item 30401
@equip 30401
@monster HORONG 15        // magical attackers (Fire Bolt)
@monster PECOPECO 15      // physical attackers
```

Only Horong's spells print:

```
[Info]: Lua: arcane-ward: absorbed 320 spell damage from Horong (+80 SP, silenced)
```

PecoPeco kicks you for 40 damage and no absorb runs.

## Requires

App 1.3.9 or newer. See
[docs/MODDING.md -> lua/](../../docs/MODDING.md#lua--changing-how-a-skill-or-item-works)
for the hook reference.
