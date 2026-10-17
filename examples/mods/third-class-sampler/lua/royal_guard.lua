-- Royal Guard, from the Third Class Redesign: three of its actives, on the
-- Royal Guard IDs the tab reuses.
--
--   LG_PRESTIGE      Prestige: you and your Devotion targets take less damage,
--                    and Devotion reaches farther, for a while
--   LG_INSPIRATION   Inspiration: Sacrifice hits harder the more HP you miss,
--                    its kills give back its HP cost; nobody else heals you
--   LG_RAYOFGENESIS  Ray of Genesis: Grand Cross costs no HP and leaves a holy
--                    field behind
--
-- Shows: unit:devotees(); changing a server status's value while it runs
-- (c:status_val), and putting it back in on_end; a status's damage_dealt,
-- damage_taken, on_kill, cost and bonus hooks; c:place_unit with a ground
-- skill of the mod's own (db/skill_db.yml).

-- Prestige: 3% less damage a level, for 10 seconds a level, on you and on
-- everyone your Devotion protects; Devotion reaches 2 cells farther (its val3
-- is the range) until it ends. The long cooldown is in db/skill_db.yml.
local PRESTIGE_REACH = 2

status("RGX_PRESTIGE", {
  icon = "EFST_PRESTIGE",
  duration = 10000,

  damage_taken = function(c, damage)
    local lv = c.source and c.source:skill_lv("LG_PRESTIGE") or 0
    return damage * (100 - 3 * lv) // 100
  end,

  on_end = function(c)
    local devotion = c.unit:status_info("SC_DEVOTION")
    if devotion and c.unit.id ~= (c.source and c.source.id) then
      c:status_val("SC_DEVOTION", 3, devotion.val3 - PRESTIGE_REACH, c.unit)
    end
  end,
})

skill("LG_PRESTIGE", {
  replace = true,

  on_cast = function(c)
    local ms = 10000 * c.skill_lv

    c:apply_status("RGX_PRESTIGE", { duration = ms }, "caster")
    for _, d in ipairs(c.caster:devotees()) do
      local devotion = d:status_info("SC_DEVOTION")
      c:apply_status("RGX_PRESTIGE", { duration = ms }, d)
      if devotion then
        c:status_val("SC_DEVOTION", 3, devotion.val3 + PRESTIGE_REACH, d)
      end
    end
  end,
})

-- Inspiration: for 10 seconds a level, Sacrifice's hits deal 1% more for each
-- 1% of HP you are missing, and a Sacrifice hit that kills gives back the 9%
-- of max HP it cost. Heal skills from others are refused in heals.lua;
-- potions thrown at you by the bonus below.
status("RGX_INSPIRATION", {
  icon = "EFST_INSPIRATION",
  duration = 10000,

  damage_dealt = function(c, damage)
    if c.attack_skill == "PA_SACRIFICE" then
      local missing = (c.caster.maxhp - c.caster.hp) * 100 // c.caster.maxhp
      return damage * (100 + missing) // 100
    end
  end,

  on_kill = function(c)
    if c.attack_skill == "PA_SACRIFICE" then
      c:heal(c.caster.maxhp * 9 // 100, 0, "caster")
    end
  end,

  -- A thrown potion heals 100%, plus 10% a level of Increase HP Recovery,
  -- plus bSkillHeal2: take all of that away. (bHealPower2 from elsewhere
  -- adds to it too, and still lets a little through.)
  bonus = function(c)
    local none = -(100 + 10 * c.unit:skill_lv("SM_RECOVERY"))
    c:bonus2("bSkillHeal2", "AM_POTIONPITCHER", none)
    c:bonus2("bSkillHeal2", "CR_SLIMPITCHER", none)
  end,
})

skill("LG_INSPIRATION", {
  replace = true,

  on_cast = function(c)
    c:apply_status("RGX_INSPIRATION", { duration = 10000 * c.skill_lv }, "caster")
  end,
})

-- Ray of Genesis: for 30 seconds, Grand Cross costs no HP and does not hurt
-- you, and leaves a holy field in its cross for 4 seconds: RGX_HOLY_FIELD, a
-- one-cell ground skill of the mod's own placed on each cell.
status("RGX_GENESIS", {
  icon = "EFST_ATKER_ASPD",
  duration = 30000,

  cost = function(c, cost)
    if c.used_skill == "CR_GRANDCROSS" then
      cost.hp = 0
    end
  end,

  damage_taken = function(c, damage)
    if c.attack_skill == "CR_GRANDCROSS" and c.caster and c.caster.id == c.unit.id then
      return 0
    end
  end,
})

skill("LG_RAYOFGENESIS", {
  replace = true,

  on_cast = function(c)
    c:apply_status("RGX_GENESIS", {}, "caster")
  end,
})

local CROSS = { { 0, 0 }, { 1, 0 }, { 2, 0 }, { -1, 0 }, { -2, 0 }, { 0, 1 }, { 0, 2 }, { 0, -1 }, { 0, -2 } }

skill("CR_GRANDCROSS", {
  on_cast = function(c)
    if not c.caster:has_status("RGX_GENESIS") then
      return
    end
    local lv = c.caster:skill_lv("LG_RAYOFGENESIS")
    for _, d in ipairs(CROSS) do
      c:place_unit("RGX_HOLY_FIELD", lv, c.x + d[1], c.y + d[2], { duration = 4000 })
    end
  end,
})

-- The field: 50% + 20% a level holy magic a second to enemies on it, less in
-- the War of Emperium.
skill("RGX_HOLY_FIELD", {
  custom = true,
  ratio = function(c, stock)
    local value = 50 + 20 * c.skill_lv
    if c.gvg then
      value = value // 2
    end
    return value
  end,
})
