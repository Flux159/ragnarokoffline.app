-- The new passives. A passive is a skill with no TargetType in skill_db.yml:
-- it is learned and never used. Its hooks run for every player who has
-- learned it, whatever they are doing, and c.skill_lv is the level learned.
--
--   bonus        when the player's stats are calculated: item bonuses by name
--   on_attack    the player attacked (normal or skill, hit or miss)
--   on_hit_taken the player was attacked
--   damage_dealt the final damage of the player's blow; return a new one
--   damage_taken the final damage of a blow at the player
--   on_kill      the player killed c.target
--   on_death     the player is dying; c:survive() keeps them at 1 HP
--   on_skill     the player used a skill (c.used_skill)
--   tick         every second, while the player is online and alive
--
-- In the hooks about an attack, c.attack_skill_id is the attack's skill (0
-- for a normal attack); c.caster attacked and c.target was attacked.

skill("GCR_CONTACT_POISON", {
  -- 10% a level that a normal attack which lands poisons the target.
  on_attack = function(c)
    if c.attack_skill_id ~= 0 or not c.connected then
      return
    end
    if c:chance(1000 * c.skill_lv) then
      c:apply_status("GCR_TOXIN", { stacks = 1 }, "target")
    end
  end,
})

skill("GCR_EXECUTIONER", {
  -- 5% more damage a level to a target under 35% of its HP.
  damage_dealt = function(c, damage)
    if c.target.hp * 100 < c.target.maxhp * 35 then
      return damage * (100 + 5 * c.skill_lv) // 100
    end
  end,

  -- A kill gives back 1% of max SP a level, and 0.3 s a level of the
  -- after-cast delay.
  on_kill = function(c)
    c:heal(0, c.caster.maxsp * c.skill_lv // 100, "caster")
    c:cut_delay(300 * c.skill_lv)
  end,
})

skill("GCR_SHADOW_INSTINCT", {
  -- +1 Perfect Dodge a level: doc/item_bonus.txt's bFlee2.
  bonus = function(c)
    c:bonus("bFlee2", c.skill_lv)
  end,

  -- Each perfect dodge builds Momentum (lua/statuses.lua). In on_hit_taken
  -- the player is c.target.
  on_hit_taken = function(c)
    if c.perfect_dodge then
      c:apply_status("GCR_MOMENTUM", { stacks = 1 }, "target")
    end
  end,
})

skill("GCR_SHADOW_PACT", {
  -- Every second, Pact for the player and each party member within 5 cells.
  -- It lasts 2 seconds, so it ends soon after someone walks away.
  tick = function(c)
    c:apply_status("GCR_PACT", { duration = 2000 }, "caster")
    for _, member in ipairs(c.caster:party(5)) do
      c:apply_status("GCR_PACT", { duration = 2000 }, member)
    end
  end,
})
