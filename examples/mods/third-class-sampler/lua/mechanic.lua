-- Mechanic, from the Third Class Redesign.
--
--   BS_REPAIRWEAPON  Masterwork (on Repair Weapon's ID, as the tab says):
--                    an Oridecon or an Elunium for a few refine levels' worth
--                    of ATK or DEF, on yourself or an ally, for 10 minutes
--   NC_TRAININGAXE   Axe Training (reused ID): axe attacks may also hit
--                    every enemy next to you
--
-- Shows: replace = true on a stock skill; c:take_item; a status whose stacks
-- hold its strength, put on afresh so it never stacks with itself;
-- units_around and c:attack from a passive.

-- Masterwork: the bonus of 4 refine levels, without refining. An Oridecon
-- (the Economy tab's cost) works on the weapon: the ATK 4 refines give at
-- its weapon level. Without one, an Elunium works on the armor: 4 DEF.
local REFINES = 4
local ATK_PER_REFINE = { 2, 3, 5, 7 }   -- weapon levels 1 to 4

status("MCX_MASTERWORK_ATK", {
  icon = "EFST_ENCHANTBLADE",
  duration = 600000,
  max_stacks = 1000,
  bonus = function(c) c:bonus("bBaseAtk", c.stacks) end,
})

status("MCX_MASTERWORK_DEF", {
  icon = "EFST_SHIELDSPELL_DEF",
  duration = 600000,
  max_stacks = 1000,
  bonus = function(c) c:bonus("bDef", c.stacks) end,
})

skill("BS_REPAIRWEAPON", {
  replace = true,

  can_cast = function(c)
    if c.caster:count_item("ORIDECON") == 0 and c.caster:count_item("ELUNIUM") == 0 then
      return false, "Masterwork needs an Oridecon or an Elunium."
    end
  end,

  on_cast = function(c)
    local who = c.target or c.caster
    if who.kind ~= "pc" then
      return
    end
    local weapon = who:equipment("weapon")

    if weapon and c.caster:count_item("ORIDECON") > 0 then
      local atk = REFINES * (ATK_PER_REFINE[weapon.weapon_level] or 2)
      c:take_item("ORIDECON", 1)
      c:remove_status("MCX_MASTERWORK_ATK", who)        -- never with itself
      c:apply_status("MCX_MASTERWORK_ATK", { stacks = atk }, who)
    elseif c.caster:count_item("ELUNIUM") > 0 then
      c:take_item("ELUNIUM", 1)
      c:remove_status("MCX_MASTERWORK_DEF", who)
      c:apply_status("MCX_MASTERWORK_DEF", { stacks = REFINES }, who)
    end
  end,
})

-- Axe Training: a normal attack with an axe that lands has a 3% a level
-- chance to strike every other enemy next to you as well, with a hit of the
-- passive itself (db/skill_db.yml gives it a weapon type, so it deals the
-- normal attack's damage).
local AXES = { [const("W_1HAXE")] = true, [const("W_2HAXE")] = true }

skill("NC_TRAININGAXE", {
  on_attack = function(c)
    if c.attack_skill_id ~= 0 or not c.connected or not AXES[c.caster.weapon_type] then
      return
    end
    if not c:chance(300 * c.skill_lv) then
      return
    end
    for _, u in ipairs(units_around(c.caster, 1, { enemy_of = c.caster, exclude = c.target })) do
      c:attack("NC_TRAININGAXE", c.skill_lv, u)
    end
  end,
})
