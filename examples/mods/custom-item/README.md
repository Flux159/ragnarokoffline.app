# custom-item

An item that exists in no client: server stats, a client name, a description,
an icon, and an NPC who hands you three. Talk to the **Island Brewer** at
`prontera 148 193`.

This is the `System/` example, and it exists because a custom item is the one
change that needs three layers at once — `db/` for what it *does*, `System/` for
what it is *called* and *looks like*, and `npc/` for how you get it.

## What to look at first

**`System/itemInfo.lua` is one entry, not twenty megabytes.**

The client's item table names every item in the game, and the translation's copy
is 22 MB. A mod that had to *replace* it in order to add one item would be a
22 MB mod, and nobody would write one.

It does not. roBrowser takes a **list** of item tables (`customItemInfo`) and
takes each item from the first table in it that defines that item — so the app
lists each mod's table ahead of the base:

```js
customItemInfo: ['System/itemInfo-custom-item.lua', 'System/itemInfo.lua'],
```

That list is generated for you. Ship a `System/itemInfo.lua` containing only
your items and the app copies it aside as `itemInfo-<your-mod>.lua` and adds it
to the list. The stock names are untouched — unless your table defines a stock
item's id, in which case yours wins, which is how a mod renames an item.

Everything else in `System/` still *replaces* the client's copy, as before —
only item tables are additive, because they are the only ones where "add one
row" is the normal thing to want.

## No art required

```lua
identifiedResourceName = "빨간포션",
```

The resource name is the art: the inventory icon is
`data/texture/유저인터페이스/item/<name>.bmp`, the picture in the item window
`.../collection/<name>.bmp`, and the sprite on the ground
`data/sprite/아이템/<name>.spr`. `빨간포션` is the Red Potion's, which every
client has, so this item borrows it.

Write it in Korean and save the file as UTF-8 — what any editor does. The client
turns it into the name its files really have. To draw your own, put the three
files under `data/texture/ui/item/`, `data/texture/ui/collection/` and
`data/sprite/item/` with a plain ASCII name, and use that name here.

(`View` in `item_db.yml` does not do this. It is the look the server sends for
equipment worn on a character, not the item's icon.)

## What the client needs from an entry

`identifiedDisplayName` at the least; an entry with no name and no description
is skipped. Everything else is optional. `tbl`, `tbl_custom` and `tbl_override`
all work, so the translation's `itemInfo_C.lua` template can be copied as it is.

## Choosing an id

30001. rAthena's own items stop well below 30000, so there is room up there that
a client update will not collide with. Pick a block and stay in it.

## Checking it worked

Server side, in the map server log:

```
Loading '1' entries in 'db/import/item_db.yml'
```

Client side, the only proof that counts: get one and hover it in your inventory.
It should say **Islander Brew** with a red potion beside it. If it says
`Unknown Item` with an apple, the client did not read your table — check that
`customItemInfo` in `Config.local.js` names it, and that the entry has an
`identifiedDisplayName`. If the name is right and the icon is an apple, the
resource name does not match a file: `state/assets/logs/missing-files.log`
names the one it asked for.

## Applying it

Both halves. `db/` and `npc/` need the **server** restarted; `System/` is linked
when the **app** starts.
