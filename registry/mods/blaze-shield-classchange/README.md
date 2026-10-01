# blaze-shield-classchange

Let Hylozoist Card's polymorph roll on every Blaze Shield pillar hit, not
only on weapon attacks. One `on_hit` hook, in
[`lua/blaze_shield.lua`](lua/blaze_shield.lua).

## What it does

Stock rAthena only rolls `bonus bClassChange,rate` on weapon attacks, so a
Ninja carrying Hylozoist Card (`bonus bClassChange,100`) and channelling
Blaze Shield never sees a proc. The hook runs on every pillar hit: if the
caster has any `classchange` bonus, it rolls at that rate and calls
`c:polymorph()` — the same action the card already does on weapon hits,
which picks a random monster from `MOBG_BRANCH_OF_DEAD_TREE` and never a
boss or status-immune one.

Scoped to `NJ_KAENSIN`, so Fire Bolt, Meteor Storm and the rest of the
magic skill list stay stock — the intent was not to turn Hylozoist Card
into a general polymorph engine.

## Verifying

Roll a Ninja, equip an accessory with Hylozoist Card slotted (`@item 4321`
gives the card), cast Blaze Shield on a cluster of Porings. Roughly 1 in
100 pillar hits transforms the Poring under it.

## Requires

App 1.3.9 or newer — the version that added the Lua skill hooks. See
[docs/MODDING.md → lua/](../../docs/MODDING.md#lua--changing-how-a-skill-works)
for the hooks, what `c` holds, and what `c:polymorph()` does.

## Applying it

`lua/` is read when the server starts. Settings → Restart server is
enough — no app restart, no rebuild.
