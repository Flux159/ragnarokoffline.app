-- Thorns Plate: an attacker who lands a physical hit starts to bleed.
--
-- The filter is one line: `if c.weapon_type ~= "weapon" then return end`.
-- Any magical or misc attack falls out of the hook before anything else
-- happens, so mages and misc-damage traps hit through the armor at full
-- power -- which is the thing about this armor you want to be true.
--
-- Physical skills (Bash, Double Strafe, Mammonite, ...) count as weapon
-- attacks too, so the thorns fire for both normal attacks and physical
-- skill hits.

item("Thorns_Plate", {
  priority = 5,

  on_hit_taken = function(c)
    -- Only physical attacks. The server tags each hit as
    -- "weapon" (BF_WEAPON), "magic" (BF_MAGIC) or "misc" (BF_MISC).
    if c.weapon_type ~= "weapon" then
      return
    end

    -- Only on hits that connected and did non-trivial damage. A grazing
    -- attack for 1 damage is not worth answering.
    if not c.connected or c.damage < 10 then
      return
    end

    -- Hooks cannot deal damage directly, so the thorns are a status:
    -- SC_BLEEDING on the attacker drains their HP over time. Short (3s),
    -- always lands (10000 out of 10000), and routed to the caster (the
    -- attacker), not us.
    c:status("SC_BLEEDING", 10000, 3000, 1, "caster")
    log("Thorns Plate: bled", c.caster.name,
        "(" .. c.damage .. " dmg,", c.weapon_type .. ")")
  end,
})
