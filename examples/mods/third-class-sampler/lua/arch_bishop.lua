-- Arch Bishop, from the Third Class Redesign.
--
--   AB_ADORAMUS   Adoramus: healing builds Grace, Adoramus spends it
--   AB_SECRAMENT  Sacrament (reused as a passive): casting while standing
--                 still makes the next cast faster
--
-- Shows: a heal hook that acts (heals.lua); a skill that needs and spends stacks
-- (can_cast, ratio, on_cast); a passive's on_skill and tick with a local
-- table; a status's bonus hook scaled by its stacks.

-- Grace: one stack for every 500 HP the Arch Bishop heals (at least one a
-- heal), up to 20. It fades a stack every 10 seconds.
status("ABX_GRACE", {
  icon = "EFST_ADORAMUS",
  duration = 60000,
  max_stacks = 20,
  decay = { every = 10000, stacks = 1 },
})

-- The Grace comes from the heal skills' heal hook, in heals.lua: Royal
-- Guard's Inspiration needs the same hook, and a mod has one hook per skill.

-- Adoramus spends all Grace: +40% damage a stack, and half again against
-- undead and demons. Its table entry still says Holy, magic, one target;
-- replace = true takes away its stock blind and slow.
skill("AB_ADORAMUS", {
  replace = true,

  can_cast = function(c)
    if c.caster:status_stacks("ABX_GRACE") == 0 then
      return false, "Adoramus needs Grace: heal someone first."
    end
  end,

  ratio = function(c, stock)
    local grace = c.caster:status_stacks("ABX_GRACE")
    local value = stock + 40 * grace

    if c.target.race == const("RC_UNDEAD") or c.target.race == const("RC_DEMON") or c.target.element == const("ELE_UNDEAD") then
      value = value * 3 // 2
    end
    return value
  end,

  on_cast = function(c)
    c:remove_status("ABX_GRACE", "caster")
  end,
})

-- Sacrament: each skill used from the cell the last one was used from adds a
-- stack of Focus, -4% variable cast time a level each, up to 5 stacks.
-- Moving takes it off: tick checks the cell every second.
local last_cell = {}   -- char_id -> "map x y" of the last skill used

local function cell_of(u)
  return u.map .. " " .. u.x .. " " .. u.y
end

status("ABX_FOCUS", {
  icon = "EFST_POSTDELAY",
  duration = 0,          -- until it is taken off
  max_stacks = 5,
  bonus = function(c)
    local lv = c.source and c.source:skill_lv("AB_SECRAMENT") or 0
    c:bonus("bVariableCastrate", -4 * lv * c.stacks)
  end,
})

skill("AB_SECRAMENT", {
  on_skill = function(c)
    local here = cell_of(c.caster)

    if last_cell[c.caster.char_id] == here then
      c:apply_status("ABX_FOCUS", { stacks = 1 }, "caster")
    end
    last_cell[c.caster.char_id] = here
  end,

  tick = function(c)
    local before = last_cell[c.caster.char_id]

    if before ~= nil and before ~= cell_of(c.caster) then
      last_cell[c.caster.char_id] = nil
      c:remove_status("ABX_FOCUS", "caster")
    end
  end,
})
