-- Blaze Shield (NJ_KAENSIN): HP/SP drain bonuses on every pillar hit.
--
-- Stock rAthena only runs bHPDrainValue, bSPDrainValue and the rest on
-- weapon attacks, so a Ninja channelling Blaze Shield with Moonlight Dagger
-- never gains SP from a pillar. c:drain() applies the caster's drain bonuses
-- to the hit's damage -- the same action the weapon-attack path already does.

skill("NJ_KAENSIN", {
  on_hit = function(c)
    if c.caster.kind == "pc" and c.damage > 0 then
      c:drain()
    end
  end,
})
