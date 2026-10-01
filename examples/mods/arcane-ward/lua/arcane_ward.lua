-- Arcane Ward: when the wearer is hit by a spell, the caster is
-- silenced and the wearer absorbs part of the spell as SP.
--
-- Two guards at the top of the hook:
--   - c.weapon_type == "magic"  -- physical and misc attacks exit here
--   - c.connected               -- only react when the spell actually
--                                  did damage; a Pneuma-blocked bolt
--                                  or a resisted spell does nothing

item("Arcane_Ward", {
  priority = 5,

  on_hit_taken = function(c)
    if c.weapon_type ~= "magic" then
      return
    end
    if not c.connected or c.damage <= 0 then
      return
    end

    -- Silence the attacker for 3 seconds. The ward reacts to the
    -- *spell*, not the hit, so this is the whole point of the item.
    c:status("SC_SILENCE", 10000, 3000, 1, "caster")

    -- Absorb a quarter of the damage dealt back as SP for the wearer.
    -- c:heal defaults to "caster" (the attacker), which is the right
    -- default for a skill()'s on_hit (the attacker heals from their
    -- hit). In an on_hit_taken on an armor we want the WEARER instead,
    -- which is c.target -- so we pass "target" explicitly.
    local gained_sp = c.damage // 4
    if gained_sp > 0 then
      c:heal(0, gained_sp, "target")
    end

    log("Arcane Ward: absorbed", c.damage,
        "spell damage from", c.caster.name,
        "(+" .. gained_sp .. " SP, silenced)")
  end,
})
