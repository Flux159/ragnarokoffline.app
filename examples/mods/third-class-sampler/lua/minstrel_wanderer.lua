-- Minstrel and Wanderer, from the Third Class Redesign: Reverberation, on its
-- own ID.
--
--   WM_REVERBERATION  place a resonance field for 10 seconds; an Arrow Vulcan
--                     at a target inside it echoes to every other enemy
--                     inside, at 40% of its damage
--
-- Shows: before_cast returning false, to put something else in place of a
-- skill's effect; c:place_unit with a ground skill of the mod's own that
-- deals nothing (MWX_RESONANCE in db/skill_db.yml); unit:in_skill_area.

skill("WM_REVERBERATION", {
  -- db/skill_db.yml makes it a ground skill. Its stock effect is replaced by
  -- the field: the use is paid for, and false keeps the effect back.
  before_cast = function(c)
    c:place_unit("MWX_RESONANCE", c.skill_lv, c.x, c.y, { duration = 10000 })
    return false
  end,
})

-- The field itself: a 5x5 Dummyskill unit that never acts (its Interval is
-- -1), there only to be stood in.
skill("MWX_RESONANCE", { custom = true })

skill("CG_ARROWVULCAN", {
  on_hit = function(c)
    if not c.connected or not c.target:in_skill_area("MWX_RESONANCE", c.caster) then
      return
    end
    for _, u in ipairs(units_around(c.target, 6, { enemy_of = c.caster, exclude = c.target })) do
      if u:in_skill_area("MWX_RESONANCE", c.caster) then
        c:attack("CG_ARROWVULCAN", c.skill_lv, u, { power = 40 })
      end
    end
  end,
})
