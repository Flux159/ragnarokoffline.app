-- Sura, from the Third Class Redesign: two passives, on the Sura IDs the tab
-- reuses (db/skill_db.yml makes both passives).
--
--   SR_GENTLETOUCH_ENERGYGAIN  Energy Gain: attacks may summon a spirit
--                              sphere, or give SP when they are full
--   SR_KNUCKLEARROW            Knuckle Arrow: Snap hits the enemies it
--                              passes through
--
-- Shows: c:spheres and a unit's spheres; a server status's values
-- (Raising Dragon raises the sphere limit by its val1); before_cast, which
-- still sees the caster where it cast from; units_in_line and c:attack.

-- The most spheres the server lets the Sura hold: 5, and Raising Dragon's
-- val1 more.
local function sphere_limit(u)
  local rd = u:status_info("SC_RAISINGDRAGON")
  return 5 + (rd and rd.val1 or 0)
end

local COMBO = {
  MO_TRIPLEATTACK = true, MO_CHAINCOMBO = true, MO_COMBOFINISH = true,
  CH_TIGERFIST = true, CH_CHAINCRUSH = true,
}

-- Energy Gain: a normal attack or a combo skill that lands has a 4% a level
-- chance of a sphere, or 3 SP a level at the limit.
skill("SR_GENTLETOUCH_ENERGYGAIN", {
  on_attack = function(c)
    if not c.connected or (c.attack_skill_id ~= 0 and not COMBO[c.attack_skill]) then
      return
    end
    if not c:chance(400 * c.skill_lv) then
      return
    end
    if c.caster.spheres < sphere_limit(c.caster) then
      c:spheres(1, "caster")
    else
      c:heal(0, 3 * c.skill_lv, "caster")
    end
  end,
})

-- Knuckle Arrow: Snap (MO_BODYRELOCATION, a ground skill) deals Knuckle
-- Arrow's damage, at the level learned, to every enemy within a cell of the
-- line from where the Sura stood to where it lands. before_cast runs before
-- the move, so the caster is still at the start of the line.
skill("MO_BODYRELOCATION", {
  before_cast = function(c)
    local lv = c.caster:skill_lv("SR_KNUCKLEARROW")
    if lv == 0 then
      return
    end
    local landing = { map = c.caster.map, x = c.x, y = c.y }
    for _, u in ipairs(units_in_line(c.caster, landing, 1, { enemy_of = c.caster })) do
      c:attack("SR_KNUCKLEARROW", lv, u)
    end
  end,
})
