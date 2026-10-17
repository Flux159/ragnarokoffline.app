# thorns-plate

An armor that bleeds anyone who hits it with a physical attack. Magical
and misc damage passes through. One `item(...)` hook, in
[`lua/thorns_plate.lua`](lua/thorns_plate.lua).

## What this example shows

- **Filtering `on_hit_taken` by attack type.** `c.weapon_type` is
  `"weapon"`, `"magic"` or `"misc"`, matching rAthena's `BF_WEAPON`,
  `BF_MAGIC` and `BF_MISC` masks. One guard clause at the top of the
  hook is all it takes to make the effect physical-only.
- **Gating by damage amount.** The hook only fires on hits over 10
  damage. A `0`-damage grazing hit does not fire the bleeding effect.
- **Delivering damage with a status instead of a direct call.**
  `SC_BLEEDING` for 3 seconds delivers percent-based damage over time.
  `c:hurt(n)` would take a flat amount of HP at once; it works outside
  the damage pipeline, so it sets off no hook and cannot loop.

## Pair with `arcane-ward` and `mirage-cloak`

Three example mods, three filter patterns:

| Mod | Filter | What it reacts to |
|---|---|---|
| [`thorns-plate`](.) | physical only (`c.weapon_type == "weapon"`) | hits that connected |
| [`arcane-ward`](../arcane-ward) | magical only (`c.weapon_type == "magic"`) | hits that connected |
| [`mirage-cloak`](../mirage-cloak) | both | hits that **missed** |

They demonstrate the three questions `on_hit_taken` can gate on:
attack type (`c.weapon_type`), connection result (`c.connected`), and
the attacker/target identity (`c.caster`, `c.target`).

## Try it

```
@item 50301
@equip 50301
@monster PECOPECO 15      // physical attackers
@monster HORONG 15        // magical attackers
```

Watch the log. Only the PecoPeco hits print:

```
[Info]: Lua: thorns-plate: Thorns Plate: bled PecoPeco (34 dmg, weapon)
```

Horong casts Fire Bolt and nothing fires on the plate side.

## Requires

App 1.3.9 or newer. See
[docs/MODDING.md -> lua/](../../docs/MODDING.md#lua--changing-how-a-skill-or-item-works)
for the hook reference.
