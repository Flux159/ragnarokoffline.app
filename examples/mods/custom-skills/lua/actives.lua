-- The new skills a player uses. `custom = true` gives each the server's
-- generic behaviour for what its skill_db.yml entry says: Venom Burst is an
-- Attack, so it hits its target; Shadow Dance is Self with a SplashArea, so
-- it hits around the caster; Toxic Cloud is Ground with a Unit, so it places
-- the cloud. What it does beyond that is its hooks.

skill("GCR_VENOM_BURST", {
  custom = true,

  -- Its damage %: 100 (stock), +60 a level, +15 a level for each Toxin
  -- stack this Guillotine Cross has on the target. status_stacks with a
  -- unit counts only the stacks that unit applied.
  ratio = function(c, stock)
    local stacks = c.target:status_stacks("GCR_TOXIN", c.caster)
    return stock + 60 * c.skill_lv + 15 * c.skill_lv * stacks
  end,

  -- After the blow, the caster's Toxin on the target is used up. on_cast
  -- runs once per use, after the skill's effect.
  on_cast = function(c)
    c:remove_status("GCR_TOXIN", "target", nil, c.caster)
  end,
})

skill("GCR_TOXIC_CLOUD", {
  custom = true,

  -- Each second's hit: 50% + 30% a level, Poison (its Element).
  ratio = function(c, stock)
    return 50 + 30 * c.skill_lv
  end,

  -- Every hit that lands adds a stack of the caster's Toxin.
  on_hit = function(c)
    if c.connected then
      c:apply_status("GCR_TOXIN", { stacks = 1 }, "target")
    end
  end,
})

skill("GCR_SHADOW_DANCE", {
  custom = true,

  -- Each enemy it hits: 100% (stock) + 40% a level.
  ratio = function(c, stock)
    return stock + 40 * c.skill_lv
  end,

  -- And each one that is hit gives the dancer a stack of Momentum
  -- (lua/statuses.lua), the buff Shadow Instinct's dodges build too.
  on_hit = function(c)
    if c.connected then
      c:apply_status("GCR_MOMENTUM", { stacks = 1 }, "caster")
    end
  end,
})
