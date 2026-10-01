# mirage-cloak

A new garment that curses any attacker who misses -- physical **and**
magical. One `item(...)` registration with a single `on_hit_taken`
hook, in [`lua/mirage_cloak.lua`](lua/mirage_cloak.lua).

This is the "both attack types" case. For physical-only, see
[`examples/mods/thorns-plate`](../thorns-plate); for magical-only, see
[`examples/mods/arcane-ward`](../arcane-ward).

Paired with [`examples/mods/vampiric-blade`](../vampiric-blade), this
example demonstrates the two sides of the item hook system -- a weapon
reacting on the attacker's `on_attack` and an armor reacting on the
defender's `on_hit_taken`.

## What this example shows

- **Armor hooks, not just weapons.** The hook is keyed to the AegisName
  `Mirage_Cloak`, and the server fires it off the garment slot the same
  way it would fire off a weapon slot. Any equipment slot works -- shoes,
  helm, accessories, armor -- using the same `item(...)` registration.
- **Reacting to a miss.** `c.connected == false` covers every dodge
  outcome (`ATK_FLEE`, `ATK_LUCKY`, `ATK_MISS`). The hook only runs when
  the hit never landed, so the behavior naturally reads as "when the
  wearer evades."
- **Putting the status on the attacker, not the wearer.** The fifth
  argument to `c:status(...)` is `"caster"` instead of the default
  `"target"`. In an `on_hit_taken` hook `c.caster` is the attacker and
  `c.target` is the wearer, so routing the debuff to the attacker is
  exactly `"caster"`.
- **Random selection in the sandbox.** `math.random` is part of the Lua
  standard library this sandbox includes. The hook picks one of five
  curses with it, which keeps a single mod from flooding the chat with
  the same effect every proc.
- **Light gatekeeping with unit kind.** NPCs cannot receive statuses the
  normal way, and self-hits should not count, so the hook filters those
  before calling `c:status`. Nothing bad happens if you skip the filter --
  a status request on a non-receptive target just does nothing -- but
  the explicit check keeps the log clean.

## What it feels like in game

Equip the cloak:

- The item script gives you Flee +15 and Agi +2 so the cloak actually
  earns misses to react to.
- Every time a mob swings and misses, one of five statuses lands on
  that mob: Blind, Silence, Confusion, Poison, or Freeze. Durations are
  short to medium (3-15 seconds).
- The map server log notes each proc with the attacker's name and
  which status landed.
- Mobs that spam normal attacks (Pecopeco, Mandragora, Orc Warrior) are
  the best demo. A dense pull of them against a Thief/Rogue with the
  cloak gets properly chaotic in a few seconds.

## Try it

```
@item 30201
@equip 30201
@monster PECOPECO 30
```

Stand still and let them hit you. HP ticks down; every miss triggers
the cloak. In the server log:

```
[Info]: Lua: mirage-cloak: PecoPeco blinded for missing
[Info]: Lua: mirage-cloak: PecoPeco poisoned for missing
[Info]: Lua: mirage-cloak: PecoPeco frozen for missing
```

## What makes this different from a `db/item_db.yml` autobonus

Stock rAthena has `bonus bRaceDebuffRate,...` and `bonus3
bAddEffWhenHit,...` which look similar, but:

- `bAddEffWhenHit` fires on a **landed** hit, not on a dodge. There is
  no stock bonus that reacts specifically to a flee dodge.
- Even if there were, picking one of five statuses at random would need
  five separate bonus lines each with the right rate, which stack
  weirdly and cannot share durations.
- `c.caster.name` in the log line is not reachable from the bonus
  system at all; it is Lua context.

The hook sits above the item script, so the stock bonuses (`bFlee +15`,
`bAgi +2`) still apply. The Lua only adds behavior the server does not
otherwise support.

## Requires

App 1.3.9 or newer -- the version that added the item() Lua hooks. See
[docs/MODDING.md -> lua/](../../docs/MODDING.md#lua--changing-how-a-skill-or-item-works)
for the full hook reference, every field on `c`, and what each action
does.

## Applying it

`lua/`, `db/`, `npc/` and `System/` are read when the server (and asset
server) starts. **Apply** rebuilds everything in one go.
