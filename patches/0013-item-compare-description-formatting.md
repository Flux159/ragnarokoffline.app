# Item comparison description formatting

The inventory item comparison window displayed equipment descriptions
differently from the regular item window. Ragnarok color markers such as
`^0000CC` and `^000000` appeared as visible text instead of changing the text
color. Once those markers were rendered as HTML, the browser also collapsed
the description's line breaks, putting fields such as type, defense, weight,
and armor level on the same line.

`ItemInfo` already implements the intended behavior. This patch gives
`ItemCompare` the same rendering path: escape the source description, pass it
through `DB.formatMsgToHtml`, and preserve whitespace with `pre-wrap`.

The escaping step remains in place before assigning `innerHTML`, so item data
cannot introduce arbitrary markup.

## Verification

The packaged Windows client was manually tested with weapons and armor. After
right-clicking comparable equipment in the inventory, color markers were no
longer visible and the description fields retained their original line breaks.
The fix was reapplied and retested after a clean installation of Ragnarok
Offline 1.1.4.
