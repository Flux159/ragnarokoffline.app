-- Genetic, from the Third Class Redesign: two of its passives, Caustic Splash
-- and (in the Economy tab's version) Bottle Recycling. The sampler adds no
-- skill IDs of its own, so both hang on Acid Demonstration itself here; a real
-- mod gives them their own passives and checks c.caster:skill_lv(...).
--
-- Shows: c:hurt, damage that is no blow (no defence, no element, no hook
-- set off by it); c:give_item.

skill("CR_ACIDDEMONSTRATION", {
  -- Caustic Splash: a fifth of each hit splashes onto the monsters next to
  -- the target. Monsters only, as the tab says.
  on_hit = function(c)
    if not c.connected then
      return
    end
    local splash = c.damage // 5
    if splash <= 0 then
      return
    end
    for _, u in ipairs(units_around(c.target, 1, { enemy_of = c.caster, kind = "mob", exclude = c.target })) do
      c:hurt(splash, u)
    end
  end,

  -- Bottle Recycling, as the Economy tab has it: the bottles are used up, and
  -- 30% of the time an Empty Bottle comes back.
  on_cast = function(c)
    if c:chance(3000) then
      c:give_item("EMPTY_BOTTLE", 1)
    end
  end,
})
