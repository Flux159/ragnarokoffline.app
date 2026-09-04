# custom-item

An item that exists in no client: server stats, a client name, a description,
and an NPC who hands you three. Talk to the **Island Brewer** at
`prontera 148 193`.

This is the `System/` example, and it exists because a custom item is the one
change that needs three layers at once — `db/` for what it *does*, `System/` for
what it is *called*, and `npc/` for how you get it.

## What to look at first

**`System/itemInfo.lua` is ten lines, not five megabytes.**

The client's item table names every item in the game, and the translation's copy
is 22 MB. A mod that had to *replace* it in order to add one item would be a
22 MB mod, and nobody would write one.

It does not. roBrowser takes a **list** of item tables (`customItemInfo`) and
merges them by item id, later wins — so the app names the base table first and
each mod's additions after it:

```js
customItemInfo: ['System/itemInfo.lub', 'System/itemInfo.lua',
                 'System/itemInfo-custom-item.lua'],
```

That list is generated for you. Ship a `System/itemInfo.lua` containing only
your items and the app copies it aside as `itemInfo-<your-mod>.lua` and adds it
to the list. The stock names are untouched.

Everything else in `System/` still *replaces* the client's copy, as before —
only item tables are additive, because they are the only ones where "add one
row" is the normal thing to want.

## No art required

```yaml
  - Id: 30001
    AegisName: Islander_Brew
    View: 501
```

`View` points the *sprite* at an item that already exists — 501 is the Red
Potion — so the client draws something sensible while the server treats this as
an entirely separate item with its own stats, name and description. That is what
makes this example shippable with no `.spr`/`.act` in it.

To draw your own, put it in `data/sprite/item/` and drop the `View` line.

## Choosing an id

30001. rAthena's own items stop well below 30000, so there is room up there that
a client update will not collide with. Pick a block and stay in it.

## Checking it worked

Server side, in the map server log:

```
Loading '1' entries in 'db/import/item_db.yml'
```

Client side, the only proof that counts: get one and hover it in your inventory.
It should say **Islander Brew**. If it says `Unknown Item` or shows a number,
the client did not read your table — check that `customItemInfo` in
`Config.local.js` names it, and that your file ends with the `AddItem` loop that
every itemInfo table needs.

## Applying it

Both halves. `db/` and `npc/` need the **server** restarted; `System/` is linked
when the **app** starts.
