-- Vampiric Blade: a dark-element one-hander that drains and strikes back.
--
-- item("Vampiric_Blade", ...) fires both hooks for every attack by or
-- against the wearer, whether the attack is a normal swing or a skill, and
-- whether it connects or not. We branch on c.connected and c.critical to
-- decide what each case does.

item("Vampiric_Blade", {
  priority = 5,

  on_attack = function(c)
    -- Only react on hits that actually dealt damage.
    if not c.connected or c.damage <= 0 then
      return
    end

    -- Apply the wearer's drain item bonuses (bHPDrainValue, bSPDrainValue
    -- and friends) to this hit. Stock rAthena only does this for weapon
    -- attacks, so this makes the sword also drain on skill hits that come
    -- through this path.
    c:drain()

    -- Lifesteal flat 10% of damage dealt. On a critical, 25% instead.
    local heal_hp = c.damage // 10
    if c.critical then
      heal_hp = c.damage // 4
    end
    if heal_hp > 0 then
      c:heal(heal_hp, 0)
    end
  end,

  on_hit_taken = function(c)
    -- Punish any attacker who criticals us: stun them for 2 seconds. Rate
    -- is 10000 out of 10000 (always), since we are already gating on
    -- `critical` and the sword is meant to be scary that way.
    if c.critical then
      c:status("SC_STUN", 10000, 2000, 1, "caster")
      log("Vampiric Blade: critical from", c.caster.name, "turned back on them")
    end
  end,
})
