# blaze-shield-drain

Make HP/SP drain bonuses fire on every Blaze Shield pillar hit, not only on
weapon attacks. One `on_hit` hook, in
[`lua/blaze_shield.lua`](lua/blaze_shield.lua).

## What it does

Stock rAthena only runs the drain family on weapon attacks, so a Ninja
channelling Blaze Shield with Moonlight Dagger never gains SP from a pillar.
The hook calls `c:drain()` on each pillar hit — the same action the
weapon-attack path already does, so every drain bonus follows along:

- `bonus bSPDrainValue,val` — the motivating case, Moonlight Dagger (3 SP per hit)
- `bonus bHPDrainValue,val`
- `bonus2 bSPDrainValueRace,race,val` and `bonus2 bHPDrainValueRace,race,val`
- `bonus2 bSPDrainValueClass,cls,val` and `bonus2 bHPDrainValueClass,cls,val`
- The drain-rate variants (`bSPDrainRate`, `bHPDrainRate`, and their race variants)

Scoped to `NJ_KAENSIN`, so Fire Wall and other placed magic skills stay
stock.

## Verifying

Roll a Ninja, learn Blaze Shield, equip Moonlight Dagger, cast the skill on
a group of Porings. With the mod off: SP only decreases. With the mod on:
SP ticks +3 per pillar hit and stays positive through a full field of them.

## Requires

App 1.3.9 or newer — the version that added the Lua skill hooks. See
[docs/MODDING.md → lua/](../../docs/MODDING.md#lua--changing-how-a-skill-works)
for the hooks, what `c` holds, and what `c:drain()` does.

## Applying it

`lua/` is read when the server starts. Settings → Restart server is
enough — no app restart, no rebuild.
