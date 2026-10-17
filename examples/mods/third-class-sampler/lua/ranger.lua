-- Ranger, from the Third Class Redesign: three actives, on the Ranger IDs the
-- tab reuses.
--
--   RA_FEARBREEZE  Fear Breeze: a buff during which each Double Strafe fires
--                  extra arrows, each one using an arrow (the Economy tab)
--   RA_CAMOUFLAGE  Camouflage: the first Sharp Shooting out of it always crits
--   RA_DETONATOR   Detonator: sets off all your damage traps at once, harder
--                  than a monster stepping on them would
--
-- Shows: a skill's hits hook; a status's cost hook on another skill (arrows),
-- with c:take_item using them up; a skill's critical hook; unit:ground_units,
-- units_around a trap's cell, c:attack and c:end_unit.

-- Fear Breeze: for 10 seconds a level, Double Strafe fires 1 more arrow at
-- levels 1-2, 2 at 3-4 and 3 at 5, and each one uses an arrow. The cost hook
-- asks for them when Double Strafe is used; Double Strafe's on_cast takes
-- them, since the server itself only ever uses the skill's own arrow.
local function extra_arrows(unit)
  if not unit:has_status("RAX_FEAR_BREEZE") then
    return 0
  end
  return (unit:skill_lv("RA_FEARBREEZE") + 1) // 2
end

status("RAX_FEAR_BREEZE", {
  icon = "EFST_FEARBREEZE",
  duration = 10000,

  cost = function(c, cost)
    if c.used_skill == "AC_DOUBLE" then
      cost.ammo_qty = cost.ammo_qty + extra_arrows(c.unit)
    end
  end,
})

skill("RA_FEARBREEZE", {
  replace = true,

  on_cast = function(c)
    c:apply_status("RAX_FEAR_BREEZE", { duration = 10000 * c.skill_lv }, "caster")
  end,
})

skill("AC_DOUBLE", {
  hits = function(c, stock)
    local extra = extra_arrows(c.caster)
    if extra > 0 then
      return stock + extra
    end
  end,

  on_cast = function(c)
    local extra = extra_arrows(c.caster)
    if extra > 0 and c.caster.ammo_id ~= 0 then
      c:take_item(c.caster.ammo_id, extra)
    end
  end,
})

-- Camouflage: the server ends Camouflage only once the skill used out of it
-- has had its effect, so Sharp Shooting still sees it. Not against players.
skill("SN_SHARPSHOOTING", {
  critical = function(c, stock)
    if c.caster:has_status("SC_CAMOUFLAGE") and c.target.kind ~= "pc" then
      return true
    end
  end,
})

-- Detonator: every damage trap of yours goes off where it lies, at 150% of
-- its damage, on the enemies around it, and is gone. Used on yourself: it
-- reaches traps anywhere (db/skill_db.yml makes it a Self skill).
local TRAPS = {
  HT_LANDMINE = 1, HT_BLASTMINE = 1, HT_CLAYMORETRAP = 2,
  RA_CLUSTERBOMB = 2, RA_FIRINGTRAP = 1, RA_ICEBOUNDTRAP = 1,
}

skill("RA_DETONATOR", {
  replace = true,

  on_cast = function(c)
    for _, trap in ipairs(c.caster:ground_units()) do
      local radius = TRAPS[trap.skill]
      if radius then
        local cell = { map = trap.map, x = trap.x, y = trap.y }
        for _, u in ipairs(units_around(cell, radius, { enemy_of = c.caster })) do
          c:attack(trap.skill, trap.level, u, { power = 150 })
        end
        c:end_unit(trap.group)
      end
    end
  end,
})
