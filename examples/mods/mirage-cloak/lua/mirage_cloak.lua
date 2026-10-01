-- Mirage Cloak: when the wearer evades an attack, one of five random
-- debuffs lands on whoever swung at them.
--
-- `on_hit_taken` fires for every incoming attack against the wearer,
-- hit or miss. We only care about the miss case: c.connected == false
-- means the server already decided the attack did not land (a flee
-- dodge, a lucky dodge, or a miss). c:status(..., "caster") routes the
-- status onto the attacker rather than the wearer, which is the whole
-- point of the cloak.

-- Each entry: { status name, duration ms, note for the log }
local CURSES = {
  { "SC_BLIND",      8000, "blinded" },
  { "SC_SILENCE",    6000, "silenced" },
  { "SC_CONFUSION",  5000, "confused" },
  { "SC_POISON",    15000, "poisoned" },
  { "SC_FREEZE",     3000, "frozen" },
}

item("Mirage_Cloak", {
  priority = 5,

  on_hit_taken = function(c)
    -- We only react to misses. A connected hit is business as usual.
    if c.connected then
      return
    end

    -- Do not fire on self-inflicted damage, or on an attacker we cannot
    -- apply a status to (an NPC, say). c.caster.kind is cheap to read.
    if c.caster.id == c.target.id then
      return
    end
    if c.caster.kind ~= "pc" and c.caster.kind ~= "mob" and c.caster.kind ~= "homun" then
      return
    end

    -- Pick one of the five. math.random is Lua's own generator, which is
    -- fine for picking from a list; for a chance out of 10000, c:chance(n)
    -- uses the server's random numbers like any other proc.
    local curse = CURSES[math.random(#CURSES)]
    c:status(curse[1], 10000, curse[2], 1, "caster")
    log("Mirage Cloak:", c.caster.name, curse[3], "for missing")
  end,
})
