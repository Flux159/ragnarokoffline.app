-- What the *client* calls item 30001, and what it draws for it.
--
-- This is an addition, not a replacement. The app puts it in the client's
-- `customItemInfo` list ahead of the base table, and the client takes each item
-- from the first table that defines it -- so a table holding only your items is
-- all it takes. No footer is needed: the client registers every entry in `tbl`
-- itself (and in `tbl_custom` and `tbl_override`, the names the translation's
-- own itemInfo_C.lua template uses).
--
-- Saved as UTF-8, like any text file. The resource name is the item art to use,
-- written in Korean as the client names it: 빨간포션 is the Red Potion's icon
-- and sprite, so this item needs no art of its own.
tbl = {
	[30001] = {
		unidentifiedDisplayName = "Bottle",
		unidentifiedResourceName = "빨간포션",
		unidentifiedDescriptionName = { "A cloudy bottle of something." },
		identifiedDisplayName = "Islander Brew",
		identifiedResourceName = "빨간포션",
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
