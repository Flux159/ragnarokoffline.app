# refine-matk

Weapon refining also grants MATK, so a blacksmith is worth visiting as a
magic-damage class.

Install it from **Settings → Mods → Browse**, then relog. Untick it under
**Settings → Mods** to switch it off again.

## The problem it fixes

In rAthena, refining a weapon only touches its ATK. The refine table
(`db/(pre-)re/refine.yml`) has fields for a flat weapon-ATK bonus, a random
extra spread and blacksmith blessing counts — none for MATK. The status
recalculator in `src/map/status.cpp` reads those and writes them into the
weapon's ATK slots (`wa->atk2`, `wa->atk` for the random spread) and never
into `wa->matk`.

The visible result: a Wizard's +10 staff and their +0 staff are worth exactly
the same MATK. Everything a blacksmith does for a swordsman does nothing at
all for a caster.

## What it grants

Every equipped weapon contributes a flat MATK bonus scaled by its **weapon
tier** (Lv1..Lv4) — the same tier the game uses for ATK refining in
`db/(pre-)re/refine.yml`, where a +10 bow is worth much more ATK than a
+10 dagger. The formula is per-hand:

    per-hand MATK = (hand's refine level) × (matk_lvN for that hand's tier)
    total MATK    = R-hand contribution + L-hand contribution

`matk_lv1..lv4` are four settings under **Settings → Mods → refine-matk**,
range `0..50` each. Defaults:

| weapon level | example                         | default MATK per +1 refine |
|--------------|---------------------------------|----------------------------|
| Lv1          | Knife, Novice Rod               | 1                          |
| Lv2          | Rod, Mace, 1H sword             | 2                          |
| Lv3          | Staff, Wizardry Staff, 2H sword | 3                          |
| Lv4          | Bow, Survivor's Rod, top-tier   | 4                          |

Worked examples at the defaults:

| loadout                                       | MATK bonus              |
|-----------------------------------------------|-------------------------|
| +7 Rod (Lv2)                                  | 7 × 2 = **+14**         |
| +10 Staff (Lv3, two-hand)                     | 10 × 3 = **+30**        |
| +15 Wizardry Staff (Lv3, two-hand)            | 15 × 3 = **+45**        |
| +10 Survivor's Rod (Lv4)                      | 10 × 4 = **+40**        |
| +10 dagger + +10 dagger (Lv1 dual-wield)      | 10×1 + 10×1 = **+20**   |
| +8 dagger (Lv1) + shield                      | 8 × 1 = **+8**          |
| +10 rod (Lv2) + +7 dagger (Lv1, dual-wield)   | 10×2 + 7×1 = **+27**    |
| any weapon                                    | 0 (settings all 0)      |

The settings take effect on the next **Apply** (server restart). Set every
`matk_lvN` to `0` to switch the bonus off without disabling the mod —
useful for A/B-testing something else with the mod still ticked.

**Two-handed weapons are only counted once.** A staff or two-handed sword
occupies both `EQI_HAND_R` and `EQI_HAND_L` slots internally, so the mod
detects that (by the item's equip-location bitmask) and skips the L-hand
pass — otherwise a +10 Lv3 staff would incorrectly be worth +60 MATK
instead of +30.

**Shields don't contribute.** A shield in the left hand reports weapon
level 0, so the same filter that keeps non-weapons out also excludes it.

**Mixed-tier dual-wielders are handled per hand.** If the R-hand is a Lv3
staff and the L-hand is a Lv1 dagger, each hand independently uses its
own tier's setting — the mod doesn't force one tier over the other.

## What it does not touch

- **Armor refining.** Only weapons.
- **The refine.yml table.** rAthena's refine data is left alone, so ATK
  bonuses from refining are exactly as upstream ships them. This mod adds
  MATK on top; it does not rebalance ATK.
- **Cards, enchants and item scripts.** Any `bonus bMatk` already on your
  weapon still applies; this mod stacks with them, it does not replace them.

## How it works

There is no data field in rAthena to declare "MATK per refine", so the mod is
one NPC script (`npc/refine_matk.txt`) with three moving parts:

1. **`OnPCLoginEvent`** starts a per-player refresh loop as soon as the
   character connects.
2. **The loop** reads `getequipid(EQI_HAND_R)`, `getequiprefinerycnt(EQI_HAND_R)`
   and the weapon's `ITEMINFO_WEAPONLEVEL`, computes the target MATK, and
   applies it every 4 seconds through `bonus_script "bonus bMatk,<n>;"` with
   a 5-second duration and flag 1024 (`BSF_FORCE_REPLACE`), which makes an
   identical bonus push its expiry out rather than be dropped as a duplicate.
3. **The short duration** is kept alive by the loop refreshing it. Swap to a
   different refine and the old value lapses within about a second; log out
   and it is dropped (flag 8).

`bonus_script` is used rather than a status-change (SC) so no visible buff
icon is added to the player's status bar, and so the bonus never fights with
a real food or potion buff for the same SC slot.

Because the loop is kicked off by `OnPCLoginEvent`, players logged in at the
moment the mod is enabled need to relog for the bonus to start applying — the
same "restart the server, then relog" flow the app already prompts for when
you tick the checkbox.

## Files

    refine-matk/
    ├── mod.json
    ├── README.md
    └── npc/
        └── refine_matk.txt

`npc/` only — the mod ships no `data/`, `System/` or `client/`, so
**Apply** restarts the server but not the whole app.
