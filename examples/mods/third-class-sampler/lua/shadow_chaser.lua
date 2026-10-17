-- Shadow Chaser, from the Third Class Redesign: three of its actives, on the
-- Shadow Chaser IDs the tab reuses.
--
--   SC_REPRODUCE     Reproduce: copy a monster's skill into a second slot
--   SC_FEINTBOMB     Feint Bomb: a decoy monsters turn on, and a moment hidden
--   SC_TRIANGLESHOT  Triangle Shot: Double Strafe hits two more nearby
--
-- Shows: replace = true; a monster's skills and what Plagiarism may copy;
-- c:copy_skill; before_cast, whose actions are done before the effect and
-- which can stop it; c:summon and c:set_target; c:attack for extra hits.
-- db/skill_db.yml gives two of them their new targets.

-- Reproduce: used on a monster, copies one of its skills that Plagiarism
-- could copy into the Reproduce slot, at the monster's level or this skill's,
-- whichever is lower. Nothing has to hit you first.
skill("SC_REPRODUCE", {
  replace = true,

  on_cast = function(c)
    if c.target == nil or c.target.kind ~= "mob" then
      return
    end

    local choices = {}

    for _, s in ipairs(c.target:mob_skills()) do
      if skill_info(s.skill).copyable then
        choices[#choices + 1] = s
      end
    end
    if #choices == 0 then
      return
    end

    local pick = choices[math.random(#choices)]

    c:copy_skill(pick.skill, math.min(pick.level, c.skill_lv), "caster", "reproduce")
  end,
})

-- Feint Bomb: a decoy at your feet for 3 seconds a level (to 10), and two
-- seconds of Hiding. before_cast does both, then returns false: the stock
-- effect (a bomb on the ground) does not happen, and the use is still paid
-- for. The decoy is there by the time on_cast, which runs all the same, turns
-- the monsters around on it. Players ignore a decoy: set_target only turns
-- monsters.
local DECOY, DECOY_ID = "SCX_DECOY", 25300   -- db/mob_db.yml

skill("SC_FEINTBOMB", {
  before_cast = function(c)
    c:summon(DECOY, { duration = math.min(10000, 3000 * c.skill_lv), x = c.caster.x, y = c.caster.y })
    c:status("SC_HIDING", 10000, 2000, 1, "caster")
    return false
  end,

  on_cast = function(c)
    local decoy = nil

    for _, u in ipairs(units_around(c.caster, 1, { kind = "mob" })) do
      if u.master_id == c.caster.id and u.mob_id == DECOY_ID then
        decoy = u
      end
    end
    if decoy == nil then
      return
    end
    for _, m in ipairs(units_around(c.caster, 9, { enemy_of = c.caster, kind = "mob" })) do
      c:set_target(m, decoy)
    end
  end,
})

-- Triangle Shot: a buff, 10 seconds a level, during which each Double Strafe
-- also hits up to two other enemies within 2 cells of its target. c:attack
-- pays nothing (no arrow) and runs no hook that can act, so the extra hits
-- cannot set off more.
status("SCX_TRIANGLE", { icon = "EFST_ATKER_ASPD", duration = 10000 })

skill("SC_TRIANGLESHOT", {
  replace = true,

  on_cast = function(c)
    c:apply_status("SCX_TRIANGLE", { duration = 10000 * c.skill_lv }, "caster")
  end,
})

skill("AC_DOUBLE", {
  on_hit = function(c)
    if not c.connected or not c.caster:has_status("SCX_TRIANGLE") then
      return
    end
    local near = units_around(c.target, 2, { enemy_of = c.caster, exclude = c.target, limit = 2 })

    for _, u in ipairs(near) do
      c:attack("AC_DOUBLE", c.skill_lv, u)
    end
  end,
})
