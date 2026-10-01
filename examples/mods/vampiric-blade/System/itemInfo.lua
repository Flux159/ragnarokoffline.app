-- Vampiric Blade -- what the client calls the item and draws for it. The
-- resource names reuse an existing weapon's art so the mod does not need
-- to ship new sprites. Save this file as UTF-8.
tbl = {
	[30101] = {
		unidentifiedDisplayName = "Sword",
		unidentifiedResourceName = "·ÕÀº½Î¹Þ",
		identifiedDisplayName = "Vampiric Blade",
		identifiedResourceName = "·ÕÀº½Î¹Þ",
		identifiedDescriptionName = {
			"A dark blade that feeds on its wielder's victims.",
			"",
			"^0000FFOn attack^000000: Honours HP/SP drain bonuses on every hit",
			"and lifesteals ^FF000010%%^000000 of damage dealt (^FF000025%%^000000 on a critical).",
			"",
			"^0000FFOn hit taken^000000: An attacker who critically hits you is",
			"stunned for ^FF00002 seconds^000000.",
			"",
			"Element: ^800080Dark^000000",
			"Class: ^777777One-handed Sword^000000",
			"Attack: 110",
			"Weight: 120",
			"Weapon Level: 3",
			"Required Level: 40",
			"Jobs: All",
		},
		slotCount = 0,
		ClassNum = 2,
	},
}
