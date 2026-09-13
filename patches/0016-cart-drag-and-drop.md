# Drag and drop into the cart did nothing

Dragging an item from the inventory or the storage onto the cart window was
silently ignored. The drag started, the item lifted, and the drop went nowhere.
Alt + right-clicking the item moved it, which is what made this look like a
quirk of the cart rather than a bug.

Same cause as [0010](0012-equipment-attachment-controls.md)'s neighbour, the
equipment window, one component along. `CartItems.js` registers a drop handler
and then a `dragover` handler that only stops propagation:

```js
this._host.addEventListener('drop', onDrop);
this._host.addEventListener('dragover', e => e.stopImmediatePropagation());
```

Under the HTML5 drag-and-drop model an element becomes a drop target only if its
`dragover` handler *cancels* the event. Without `preventDefault` the browser
never fires `drop`, so `onDrop` below it — which accepts Storage and Inventory
sources, asks for a quantity on a stack, and calls `reqMoveItemToCart` — had
never once run.

The cart is the only item window in the tree that does this. `Storage` and
`Trade` both call `stopImmediatePropagation` and `preventDefault` on their host,
and the inventory does the same behind its `hostDropPreventDefault` flag, which
V2 and V3 set. That asymmetry is why cart → inventory already worked while
inventory → cart did not, which is how it was reported.

## Verification

In a real game: a Merchant with `@cart 1`, an emptied cart, and twenty Red
Potions. `@cartlist` is the assertion, so the result is the server's own answer
rather than what the window happens to be drawing. The drag is Playwright's
`dragTo`, which drives Chromium's own drag-and-drop model — a synthetic `drop`
event dispatched from script would fire whether or not `dragover` cancelled,
which is the whole bug.

| | quantity prompt | `@cartlist` afterwards |
|---|---|---|
| before | never appears | `No item found in this player's cart` |
| after | appears | `20 <Red Potion> (Red_Potion, id: 501)`, `1 cart slots` |

The two runs are the same build, the same world and the same script, with only
that one handler differing in the served bundle. Instrumenting the page
separately confirms the mechanism: with the fix, `dragstart`, `dragenter`,
`dragover` and `drop` all arrive, the last of them on the cart.

`patch-client.sh` is idempotent across two runs, and the rebuilt bundle loads,
logs in and enters the map.
