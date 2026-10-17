-- The heal skills' heal hook, shared by two classes. A mod has one hook per
-- skill and hook: a second skill("AL_HEAL", { heal = ... }) in another of its
-- files would replace the first. So Arch Bishop's Grace and Royal Guard's
-- Inspiration meet here.
--
-- A heal hook runs when Heal, Highness Heal or Coluceo Heal restores HP. It
-- sees the amount as `stock`, returns a new one (nil keeps it), and may act.

local function heal(c, stock)
  -- Royal Guard, Inspiration (royal_guard.lua): while it lasts, nobody else
  -- can heal you.
  if c.target and c.target:has_status("RGX_INSPIRATION") and c.caster and c.caster.id ~= c.target.id then
    return 0
  end

  -- Arch Bishop, Adoramus (arch_bishop.lua): a stack of Grace for every 500
  -- HP healed, at least one a heal.
  if stock > 0 and c.caster and c.caster:skill_lv("AB_ADORAMUS") > 0 then
    c:apply_status("ABX_GRACE", { stacks = math.max(1, stock // 500) }, "caster")
  end
end

skill("AL_HEAL", { heal = heal })
skill("AB_HIGHNESSHEAL", { heal = heal })
skill("AB_CHEAL", { heal = heal })
