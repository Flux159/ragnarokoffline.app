-- Moon Ribbon: when you are hit below 30% HP, a 20% chance to cast Heal Lv 5
-- on yourself.
--
-- An item script can say "3% chance to cast Heal when hit"
-- (bonus3 bAutoSpellWhenHit), but not "only when it's needed". A Lua item
-- hook can: on_hit_taken runs for whoever has the item equipped, each time
-- something attacks them. There c.target is the wearer and c.caster the
-- attacker, and c:cast() casts the way the autospell bonuses do.
item("Moon_Ribbon", {
  on_hit_taken = function(c)
    if not c.connected then
      return  -- a miss: nothing to heal from
    end
    local low = c.target.hp * 100 < c.target.maxhp * 30
    if low and c:chance(2000) then
      c:cast("AL_HEAL", 5, "target")
    end
  end,
})
