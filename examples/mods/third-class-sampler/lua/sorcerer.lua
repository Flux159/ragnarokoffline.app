-- Sorcerer, from the Third Class Redesign: Spell Fist, on its own ID.
--
--   SO_SPELLFIST  charge the bolt your Auto Spell holds into your weapon: your
--                 next melee hits each release it, guaranteed
--
-- Shows: stock_checks = false, for a reused skill whose server-side check no
-- longer fits; reading a server status's values with unit:status_info (Auto
-- Spell keeps its bolt in val2 and that bolt's level in val3); a status whose
-- on_attack casts with c:cast and spends a stack.

local charged = {}   -- char_id -> { skill, level }: what the last Spell Fist holds

status("SOX_SPELLFIST", {
  icon = "EFST_SPELLFIST",
  duration = 20000,
  max_stacks = 10,

  on_attack = function(c)
    local bolt = charged[c.caster.char_id]
    if c.attack_skill_id ~= 0 or c.ranged or not c.connected or bolt == nil then
      return
    end
    c:cast(bolt.skill, bolt.level, "target")
    c:remove_status("SOX_SPELLFIST", "caster", 1)
  end,
})

skill("SO_SPELLFIST", {
  replace = true,
  stock_checks = false,   -- the server only allows Spell Fist while casting a bolt

  can_cast = function(c)
    if c.caster:status_info("SC_AUTOSPELL") == nil then
      return false, "Spell Fist charges your Auto Spell's bolt: cast Auto Spell first."
    end
  end,

  -- 2 hits, and one more for every 2 levels.
  on_cast = function(c)
    local auto = c.caster:status_info("SC_AUTOSPELL")
    if auto == nil then
      return
    end
    charged[c.caster.char_id] = { skill = auto.val2, level = auto.val3 }
    c:remove_status("SOX_SPELLFIST", "caster")
    c:apply_status("SOX_SPELLFIST", { stacks = 2 + c.skill_lv // 2 }, "caster")
  end,
})
