-- What the *client* calls item 30001.
--
-- This is an addition, not a replacement. The app names it in the client's
-- `customItemInfo` list after the base table, and roBrowser merges the tables by
-- item id -- so ten lines here is all it takes. Shipping the translation's
-- five-megabyte itemInfo.lua to add one item is not required and never was.
tbl = {
	[30001] = {
		unidentifiedDisplayName = "Bottle",
		unidentifiedResourceName = "»¡°£Æ÷¼Ç",
		unidentifiedDescriptionName = { "A cloudy bottle of something." },
		identifiedDisplayName = "Islander Brew",
		identifiedResourceName = "»¡°£Æ÷¼Ç",
		identifiedDescriptionName = {
			"Brewed on the island, from the island's own herbs.",
			"Restores a fair amount of ^0000FFHP^000000.",
			"^ffffff_^000000",
			"Weight: ^777777 7 ^000000"
		},
		slotCount = 0,
		ClassNum = 0
	}
}

-- itemInfo tables are read by roBrowser's own Lua interpreter, which calls
-- AddItem for each entry. This is the standard footer every itemInfo file ends
-- with; without it nothing is registered.
for ItemID, DESC in pairs(tbl) do
	result, msg = AddItem(ItemID, DESC.unidentifiedDisplayName, DESC.unidentifiedResourceName,
		DESC.identifiedDisplayName, DESC.identifiedResourceName, DESC.slotCount, DESC.ClassNum)
	if not result then
		return false, msg
	end
	result, msg = AddItemUnidentifiedDesc(ItemID, DESC.unidentifiedDescriptionName)
	if not result then
		return false, msg
	end
	result, msg = AddItemIdentifiedDesc(ItemID, DESC.identifiedDescriptionName)
	if not result then
		return false, msg
	end
end
return true, "Item Info Add Complete."
