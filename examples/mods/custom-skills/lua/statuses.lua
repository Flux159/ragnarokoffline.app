-- The mod's own statuses: buffs, debuffs and a combo window, with stacks.
--
-- A status here is a name, how long it lasts, how many stacks it can hold,
-- and hooks. It is put on a unit by c:apply_status() and taken off by
-- c:remove_status(), from any hook that can act (on_hit, on_attack,
-- on_hit_taken, on_cast, on_kill, tick, ...). It lives in the server's
-- memory: it ends with a restart, a logout or the unit's death.
--
-- `icon` is one the client already draws, by its EFST_ name. Its tooltip is
-- still the stock status's.

-- Toxin: what Contact Poison, Venom Burst and Toxic Cloud are about.
status("GCR_TOXIN", {
  icon = "EFST_TOXIN",
  duration = 8000,          -- each new stack starts the 8 seconds again
  max_stacks = 10,
  max_stacks_boss = 3,      -- a boss holds at most 3
  max_stacks_player = 5,    -- and so does a player, in PvP
  per_source = true,        -- each Guillotine Cross keeps a count of their own
  decay = { every = 4000, stacks = 1 },  -- and loses one every 4 seconds

  -- The one who poisoned the unit hits it 2% harder per stack. c.unit has
  -- the status; c.caster is whoever is attacking it; c.source applied it.
  damage_taken = function(c, damage)
    if c.source == nil or c.caster == nil or c.caster.id ~= c.source.id then
      return nil
    end
    return damage * (100 + 2 * c.stacks) // 100
  end,

  -- And it hurts: every second, 4 HP a stack, dealt by the poisoner (who
  -- gets the kill). c:hurt ignores defence, like a poison does.
  tick = function(c)
    if c.source ~= nil then
      c:hurt(4 * c.stacks)
    end
  end,
})

-- Momentum: built by Shadow Instinct's perfect dodges and Shadow Dance's
-- hits. A bonus hook is a player's item bonus while the status lasts,
-- scaled by its stacks.
status("GCR_MOMENTUM", {
  icon = "EFST_CRITICALPERCENT",
  duration = 6000,
  max_stacks = 5,
  bonus = function(c)
    c:bonus("bCritical", 3 * c.stacks)
  end,
})

-- The window after a Sonic Blow in which Cross Impact can be used
-- (lua/reworks.lua). A status with no hooks is a marker other hooks ask
-- about: unit:has_status("GCR_SONIC_WINDOW").
status("GCR_SONIC_WINDOW", {
  icon = "EFST_COMBOATTACK",
  duration = 3000,
})

-- Shadow Pact's buff. A stats hook changes any unit's numbers -- a monster's
-- as well as a player's -- and only those being recalculated are kept.
-- c.source is the Guillotine Cross who holds the pact: its level sets the
-- strength.
status("GCR_PACT", {
  icon = "EFST_HALLUCINATIONWALK",  -- free: this mod takes Hallucination Walk away
  duration = 2000,
  stats = function(c, s)
    local lv = c.source and c.source:skill_lv("GCR_SHADOW_PACT") or 1
    s.hit = s.hit + 5 * lv
    s.flee = s.flee + 3 * lv
  end,
})

-- The server's own Cloaking Exceed, hooked: it lasts 10% longer for every
-- level of Shadow Instinct its user has learned. A hook on a server status
-- takes on_start and on_end only; on_start may return a new duration, or
-- false (or 0) to refuse the status. -1 is a status without an end.
status("SC_CLOAKINGEXCEED", {
  on_start = function(c)
    local lv = c.caster and c.caster:skill_lv("GCR_SHADOW_INSTINCT") or 0
    if lv == 0 or c.duration <= 0 then
      return nil
    end
    return c.duration * (100 + 10 * lv) // 100
  end,
})
