-- Stock skills, changed: Cross Impact becomes the finisher of a Sonic Blow.
--
-- on_cast, can_cast and cost work on any skill, the server's own as well as
-- a mod's.

skill("AS_SONICBLOW", {
  -- A Sonic Blow opens a 3-second window for Cross Impact.
  on_cast = function(c)
    c:apply_status("GCR_SONIC_WINDOW", {}, "caster")
  end,
})

skill("GC_CROSSIMPACT", {
  -- Only inside that window. Returning false refuses the use, and the
  -- message is shown to the player.
  can_cast = function(c)
    if not c.caster:has_status("GCR_SONIC_WINDOW") then
      return false, "Cross Impact follows a Sonic Blow."
    end
  end,

  -- At half the SP. cost sees what the skill needs (sp, hp, zeny, items,
  -- ...) and changes it in place. The server asks for it several times for
  -- one use, so it must only compute -- no actions here.
  cost = function(c, cost)
    cost.sp = cost.sp // 2
  end,

  -- And it closes the window.
  on_cast = function(c)
    c:remove_status("GCR_SONIC_WINDOW", "caster")
  end,
})
