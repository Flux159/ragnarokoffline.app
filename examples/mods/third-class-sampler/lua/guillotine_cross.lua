-- Guillotine Cross, from the Third Class Redesign.
--
--   GC_HALLUCINATIONWALK   Perfect Dodge passive (the tab's own choice of ID)
--   GC_DARKILLUSION        Auto-attack mastery (an ID the sampler borrows)
--   GC_RESEARCHNEWPOISON   Research New Poison, and the stacks of Toxin
--
-- Shows: a passive's stats hook with a cap; attack speed that turns into ATK
-- at the server's limit (s.amotion_min); a crafting chance under the shared
-- cap; remembering something between hooks in a local table; an item's
-- on_use hook. db/skill_db.yml turns the first two into passives.

-- Perfect Dodge passive: +2 Perfect Dodge a level, never past 30 in all.
-- flee2 is in tenths. The cap only stops the passive: Perfect Dodge from gear
-- above it is left alone.
local PD_PER_LEVEL, PD_CAP = 20, 300

skill("GC_HALLUCINATIONWALK", {
  stats = function(c, s)
    local raised = math.min(s.flee2 + PD_PER_LEVEL * c.skill_lv, PD_CAP)
    if raised > s.flee2 then
      s.flee2 = raised
    end
  end,

  -- Each perfect dodge is a Flurry stack (below). In on_hit_taken the player
  -- is c.target.
  on_hit_taken = function(c)
    if c.perfect_dodge then
      c:apply_status("GCX_FLURRY", { stacks = 1 }, "target")
    end
  end,
})

-- Auto-attack mastery: a stack of Flurry for each normal attack (an attack,
-- not a hit: a Double Attack is one).
skill("GC_DARKILLUSION", {
  on_attack = function(c)
    if c.attack_skill_id == 0 then
      c:apply_status("GCX_FLURRY", { stacks = 1 }, "caster")
    end
  end,
})

-- Flurry: each stack takes 1 ms a level off the attack motion (0.1 ASPD) and
-- adds 1 ATK a level. What the server's attack speed limit leaves over turns
-- into ATK, 2 for each ms that did not fit. A physical hit knocks 2 stacks
-- off; out of combat they go in 4 seconds.
status("GCX_FLURRY", {
  icon = "EFST_ATTHASTE_POTION2",
  duration = 4000,
  max_stacks = 10,

  stats = function(c, s)
    local lv = c.source and c.source:skill_lv("GC_DARKILLUSION") or 0
    local faster = c.stacks * lv
    local room = math.max(0, s.amotion - s.amotion_min)

    if faster <= room then
      s.amotion = s.amotion - faster
    else
      s.amotion = s.amotion_min
      s.batk = s.batk + 2 * (faster - room)
    end
    s.batk = s.batk + c.stacks * lv
  end,

  on_hit_taken = function(c)
    if c.connected and c.weapon_type == "weapon" then
      c:remove_status("GCX_FLURRY", "target", 2)
    end
  end,
})

-- Research New Poison: +2% Create Deadly Poison success a level, inside the
-- shared cap of +15 points for every crafting bonus (c.base is the server's
-- own chance; each craft hook sees the one before's result).
--
-- At level 10 a failed Create Deadly Poison costs no HP. The server takes
-- 25% of max HP before any hook can act, so craft notes the attempt, on_craft
-- (a success) forgets it, and tick gives the HP back within the second;
-- on_death keeps the player alive if that 25% would have killed.
local cdp_attempt = {}   -- char_id -> HP a failure would take

skill("GC_RESEARCHNEWPOISON", {
  craft = function(c, rate)
    if c.craft_skill ~= "ASC_CDP" then
      return nil
    end
    if c.skill_lv >= 10 then
      cdp_attempt[c.caster.char_id] = c.caster.maxhp * 25 // 100
    end
    return math.min(rate + 200 * c.skill_lv, c.base + 1500)
  end,

  on_craft = function(c, item)
    cdp_attempt[c.caster.char_id] = nil
  end,

  tick = function(c)
    local lost = cdp_attempt[c.caster.char_id]
    if lost then
      cdp_attempt[c.caster.char_id] = nil
      c:heal(lost, 0, "caster")
    end
  end,

  on_death = function(c)
    if cdp_attempt[c.target.char_id] then
      c:survive()
    end
  end,

  -- Toxin's stacks: Envenom, Throw Venom Knife and every hit under EDP.
  on_attack = function(c)
    if not c.connected then
      return
    end
    if c.attack_skill == "TF_POISON" or c.attack_skill == "AS_VENOMKNIFE" or c.caster:has_status("SC_EDP") then
      c:apply_status("GCX_TOXIN", { stacks = 1 }, "target")
    end
  end,
})

-- Toxin: whoever poisoned the unit hits it 3% harder a stack. Fewer stacks
-- on a boss and on a player.
status("GCX_TOXIN", {
  icon = "EFST_TOXIN",
  duration = 10000,
  max_stacks = 10,
  max_stacks_boss = 3,
  max_stacks_player = 5,
  per_source = true,
  decay = { every = 5000, stacks = 1 },

  damage_taken = function(c, damage)
    if c.source and c.caster and c.caster.id == c.source.id then
      return damage * (100 + 3 * c.stacks) // 100
    end
  end,
})

-- Green Potion and Detoxify take Toxin off. on_use runs right before the
-- potion's own script; the action happens right after it.
item("GREEN_POTION", {
  on_use = function(c)
    c:remove_status("GCX_TOXIN", "caster")
  end,
})

skill("TF_DETOXIFY", {
  on_cast = function(c)
    c:remove_status("GCX_TOXIN", "target")
  end,
})
