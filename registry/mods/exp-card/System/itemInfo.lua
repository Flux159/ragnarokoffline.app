-- What the client calls items 50051..50070 and the art it draws. Added to
-- the client's customItemInfo ahead of the base table (see docs/MODDING.md,
-- System/), so a table holding these twenty entries is all it needs -- the
-- client registers every entry in `tbl` itself. Saved as UTF-8.
--
-- The two card families share their shape (weight, resource, description
-- layout), so this is a small loop over levels 1..10 instead of twenty
-- copy-pasted blocks. EXP_BY_LEVEL must stay in sync with the getexp
-- values in db/item_db.yml -- twenty scripts there, ten entries here.
--
-- identifiedResourceName is the ART, written in Korean the way the client
-- names it. 스페어카드 ("spare card") is item 779's resource -- the
-- blank-backed card used by the "Blank Nibble Leon Card" item, and the
-- closest thing the shipped GRF has to a generic back-of-a-card look.
-- Verified present: the Magnifier (돋보기) and the Poring Card art
-- (포링카드) are NOT both in the GRF -- Poring Card's bitmaps are
-- absent in this distribution and the client logs "Can't get file" for
-- data/texture/.../item/Æ÷¸µÄ«µå.bmp. If you retarget, swap for another
-- item's resource name that is actually in the archive, or ship your own
-- bitmap + sprite; a name that matches no file shows an apple icon and
-- is logged in state/assets/logs/missing-files.log.
tbl = {}

-- Roughly geometric growth (~2x per level), anchored at Lv 10 = 60,000
-- and rounded to clean numbers. See db/item_db.yml for the rationale.
local EXP_BY_LEVEL = { 100, 250, 500, 1000, 2000, 4000, 7500, 15000, 30000, 60000 }
local RESOURCE = "스페어카드"

-- Group thousands with commas so "60,000" reads more comfortably than
-- "60000" in the tooltip. Lua's string.format has no %'d, so build it by
-- hand. (Only touches non-negative integers; nothing else uses this.)
local function commas(n)
	local s = tostring(n)
	local out = ""
	local count = 0
	for i = #s, 1, -1 do
		out = s:sub(i, i) .. out
		count = count + 1
		if count % 3 == 0 and i > 1 then
			out = "," .. out
		end
	end
	return out
end

for level = 1, 10 do
	local exp = EXP_BY_LEVEL[level]
	local expText = commas(exp)
	-- Player-level gate for this card, matching EquipLevelMin in
	-- db/item_db.yml: (level - 1) * 10 + 1.
	local requiredLevel = (level - 1) * 10 + 1
	local baseName = "Base Exp Card Lv" .. level
	local jobName  = "Job Exp Card Lv"  .. level
	local baseDesc = {
		"^0000FF+" .. expText .. "^000000 base experience.",
		"^ffffff_^000000",
		"Requires base level ^0000FF" .. requiredLevel .. "^000000 to use.",
		"Drops on a small chance from any monster you kill.",
		"Higher-level monsters drop higher-level cards.",
		"^ffffff_^000000",
		"Weight: ^777777 1 ^000000"
	}
	local jobDesc = {
		"^0000FF+" .. expText .. "^000000 job experience.",
		"^ffffff_^000000",
		"Requires base level ^0000FF" .. requiredLevel .. "^000000 to use.",
		"Drops on a small chance from any monster you kill.",
		"Higher-level monsters drop higher-level cards.",
		"^ffffff_^000000",
		"Weight: ^777777 1 ^000000"
	}
	tbl[50050 + level] = {
		unidentifiedDisplayName = baseName,
		unidentifiedResourceName = RESOURCE,
		unidentifiedDescriptionName = baseDesc,
		identifiedDisplayName = baseName,
		identifiedResourceName = RESOURCE,
		identifiedDescriptionName = baseDesc,
		slotCount = 0,
		ClassNum = 0
	}
	tbl[50060 + level] = {
		unidentifiedDisplayName = jobName,
		unidentifiedResourceName = RESOURCE,
		unidentifiedDescriptionName = jobDesc,
		identifiedDisplayName = jobName,
		identifiedResourceName = RESOURCE,
		identifiedDescriptionName = jobDesc,
		slotCount = 0,
		ClassNum = 0
	}
end
