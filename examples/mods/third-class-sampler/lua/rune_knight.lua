-- Rune Knight, from the Third Class Redesign.
--
--   RK_REFRESH        Refresh (rune): cleanse your debuffs, then shrug off new
--                     ones while it lasts
--   RK_STONEHARDSKIN  Stone Hard Skin (rune): a shield worth part of your max
--                     HP; when it breaks it knocks the enemies around back
--   RK_PHANTOMTHRUST  Phantom Thrust: also pulls the enemies around the
--                     target to the cell in front of you
--   RK_WINDCUTTER     Wind Cutter: refreshes Two-Hand Quicken, and is the one
--                     skill usable in Berserk
--
-- Shows: unit:statuses and c:end_status; status("*", { chance }) for every
-- server status; a shield made of stacks, with damage_taken (which may not
-- act) and on_hit_taken (which may) sharing a local table; on_end's reason;
-- c:knockback; before_cast and on_cast on one skill, around the stock effect;
-- c:slide and a unit's facing; a status's can_cast for every skill its holder
-- uses; what db/status.yml can change (Berserk's NoCast).

-- Refresh: ends every debuff on you, then for 30 seconds no debuff starts.
status("RKX_REFRESH", { icon = "EFST_REFRESH", duration = 30000 })

skill("RK_REFRESH", {
  replace = true,

  on_cast = function(c)
    for _, s in ipairs(c.caster:statuses({ debuff = true })) do
      c:end_status(s.name, "caster")
    end
    c:apply_status("RKX_REFRESH", {}, "caster")
  end,
})

status("*", {
  chance = function(c, rate)
    if c.debuff and c.unit:has_status("RKX_REFRESH") then
      return 0
    end
  end,
})

-- Stone Hard Skin: a shield of 20% of max HP for 30 seconds. Each stack is a
-- point of damage it can still take. damage_taken works out what it absorbs
-- but may not act; on_hit_taken, which runs after it, takes those stacks off.
-- Used up, it ends with the reason "removed" and pushes everyone within 2
-- cells 3 cells away.
local absorbed = {}   -- unit id -> what the last blow put on the shield

status("RKX_STONESKIN", {
  icon = "EFST_STONEHARDSKIN",
  duration = 30000,
  max_stacks = 1000000,

  damage_taken = function(c, damage)
    local take = math.min(damage, c.stacks)
    absorbed[c.unit.id] = take
    return damage - take
  end,

  on_hit_taken = function(c)
    local take = absorbed[c.unit.id]
    absorbed[c.unit.id] = nil
    if take and take > 0 then
      c:remove_status("RKX_STONESKIN", "target", take)
    end
  end,

  on_end = function(c)
    if c.reason ~= "removed" then
      return
    end
    for _, u in ipairs(units_around(c.unit, 2, { enemy_of = c.unit })) do
      c:knockback(u, 3, c.unit)
    end
  end,
})

skill("RK_STONEHARDSKIN", {
  replace = true,

  on_cast = function(c)
    c:remove_status("RKX_STONESKIN", "caster")
    c:apply_status("RKX_STONESKIN", { stacks = c.caster.maxhp // 5 }, "caster")
  end,
})

-- Phantom Thrust: after its own hit and pull, the other enemies that stood
-- within 2 cells of the target are pulled to the cell in front of the Rune
-- Knight. before_cast, which runs before the stock effect, notes where the
-- target stood; on_cast, after it, finds the target already moved. Against
-- players, only the target moves, as the tab says.
local DX = { [0] = 0, -1, -1, -1, 0, 1, 1, 1 }   -- by facing: 0 north, 2 west, 4 south, 6 east
local DY = { [0] = 1, 1, 0, -1, -1, -1, 0, 1 }
local thrust_from = {}   -- caster id -> the cell the target stood on

skill("RK_PHANTOMTHRUST", {
  before_cast = function(c)
    if c.target ~= nil and c.target.kind ~= "pc" then
      thrust_from[c.caster.id] = { map = c.target.map, x = c.target.x, y = c.target.y }
    end
  end,

  on_cast = function(c)
    local from = thrust_from[c.caster.id]
    thrust_from[c.caster.id] = nil
    if from == nil then
      return
    end
    local fx, fy = c.caster.x + DX[c.caster.dir], c.caster.y + DY[c.caster.dir]
    for _, u in ipairs(units_around(from, 2, { enemy_of = c.caster, kind = "mob", exclude = c.target })) do
      c:slide(u, fx, fy)
    end
  end,
})

-- Wind Cutter: two-handed swords only, and each use starts Two-Hand Quicken
-- again at the level learned.
--
-- It is also the one skill a Rune Knight can use in Berserk. db/status.yml
-- takes NoCast off Berserk, so every skill could be used; while Berserk lasts
-- the passive's tick keeps RKX_FRENZY on, whose can_cast refuses the rest.
status("RKX_FRENZY", {
  duration = 2000,
  can_cast = function(c)
    if c.used_skill ~= "RK_WINDCUTTER" then
      return false, "Only Wind Cutter in Berserk."
    end
  end,
})

status("SC_BERSERK", {
  on_end = function(c)
    c:remove_status("RKX_FRENZY", c.unit)
  end,
})

skill("RK_WINDCUTTER", {
  can_cast = function(c)
    if c.caster.weapon_type ~= const("W_2HSWORD") then
      return false, "Wind Cutter needs a two-handed sword."
    end
  end,

  on_cast = function(c)
    local lv = c.caster:skill_lv("KN_TWOHANDQUICKEN")
    if lv > 0 then
      c:status("SC_TWOHANDQUICKEN", 10000, skill_info("KN_TWOHANDQUICKEN", lv).duration, lv, "caster")
    end
  end,

  tick = function(c)
    if c.caster:has_status("SC_BERSERK") then
      c:apply_status("RKX_FRENZY", {}, "caster")
    end
  end,
})
