-- Blaze Shield (NJ_KAENSIN): Hylozoist Card's polymorph on every pillar hit.
--
-- Stock rAthena only rolls bClassChange on weapon attacks, so a Ninja carrying
-- Hylozoist Card and channelling Blaze Shield never sees a proc. This hook
-- rolls the card's rate on every pillar hit. c:polymorph() picks a random
-- monster from the Dead Branch list and leaves bosses and status-immune
-- monsters alone itself.

skill("NJ_KAENSIN", {
  on_hit = function(c)
    if c.target.kind == "mob" and c.caster.classchange > 0 and c:chance(c.caster.classchange) then
      c:polymorph()
    end
  end,
})
