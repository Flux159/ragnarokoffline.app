-- Warlock, from the Third Class Redesign: its one active, Release, on
-- Reading Spellbook's and Release's IDs.
--
--   WL_READING_SB  the first use: the next spell you cast is stored, not
--                  cast. It takes its full cast time and SP.
--   WL_RELEASE     the second use: the stored spell goes off at your target
--                  at once. One stored spell; two with Release at level 2.
--
-- Shows: before_cast returning false, which stops a skill's effect once it
-- is paid for; c:cast at a cell, with power; stock_checks = false; a local
-- table holding what was stored. Released spells deal less in the War of
-- Emperium.

local SPELLS = {
  "MG_FIREBOLT", "MG_COLDBOLT", "MG_LIGHTNINGBOLT", "MG_SOULSTRIKE", "MG_FIREBALL",
  "MG_THUNDERSTORM", "WZ_STORMGUST", "WZ_METEOR", "WZ_VERMILION", "WZ_JUPITEL",
  "WZ_EARTHSPIKE", "WZ_HEAVENDRIVE", "WZ_WATERBALL", "WZ_FROSTNOVA",
}

local stored = {}   -- char_id -> list of { skill, level }

status("WLX_STORING", { icon = "EFST_POSTDELAY", duration = 15000 })

skill("WL_READING_SB", {
  replace = true,

  can_cast = function(c)
    local slots = c.caster:skill_lv("WL_RELEASE") >= 2 and 2 or 1
    if #(stored[c.caster.char_id] or {}) >= slots then
      return false, "Nothing more can be stored: release it first."
    end
  end,

  on_cast = function(c)
    c:apply_status("WLX_STORING", {}, "caster")
  end,
})

-- While WLX_STORING lasts, the next of these spells is stored instead of
-- cast: it has been paid for, and before_cast returning false keeps its
-- effect back.
for _, name in ipairs(SPELLS) do
  skill(name, {
    before_cast = function(c)
      if not c.caster:has_status("WLX_STORING") then
        return
      end
      local list = stored[c.caster.char_id] or {}
      list[#list + 1] = { skill = c.skill, level = c.skill_lv }
      stored[c.caster.char_id] = list
      c:remove_status("WLX_STORING", "caster")
      return false
    end,
  })
end

skill("WL_RELEASE", {
  replace = true,
  stock_checks = false,   -- the server's Release at level 2 needs a summoned sphere

  can_cast = function(c)
    if #(stored[c.caster.char_id] or {}) == 0 then
      return false, "No spell is stored."
    end
  end,

  on_cast = function(c)
    local list = stored[c.caster.char_id]
    if list == nil or #list == 0 or c.target == nil then
      return
    end
    local spell = table.remove(list, 1)

    c:cast(spell.skill, spell.level, "target", {
      x = c.target.x, y = c.target.y,     -- where a ground spell goes
      power = c.gvg and 70 or 100,
    })
  end,
})
