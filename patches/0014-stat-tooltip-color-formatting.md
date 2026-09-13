# Status tooltip color formatting

The V2 status window provides explanatory tooltips when hovering primary,
secondary, and trait stats. Their localized messages contain Ragnarok color
markers such as `^66cc33` and `^ffffff`, but the generic `data-text` renderer
inserts every message as plain text. Consequently, those markers appeared
literally in descriptions such as Strength and Power.

This patch keeps the generic renderer unchanged and limits HTML formatting to
WinStats description tooltips (`.desc .hover[data-text]`). Each localized
message is escaped through a temporary DOM element before
`DB.formatMsgToHtml` converts its color markers to spans. Regular translated
labels and other components remain unaffected.

## Verification

The packaged Windows client was manually tested with both sections of the V2
status window. Hovering the six primary stats and the expanded trait stats
displayed their descriptions with colored stat names and no visible Ragnarok
color markers. The resulting client bundle was also checked for the `DB`
declaration, WinStats database initialization, both formatter methods, and
JavaScript syntax.
