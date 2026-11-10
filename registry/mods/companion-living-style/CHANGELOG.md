## 1.7.1
- Fix: AI no longer flip between their own headgear and their costume. An AI coming into view is restyled straight away instead of at the next five-second refresh.
- Everything from 1.7.0 is kept: complete observed outfits, the login shuffle, town themes, town life and Cold Bolt.
- Confirmed working in game by the author on a pre-renewal server (Windows, app 1.8.3).
- Updating by hand? Replace the whole companion-living-style folder. Leftover older NPC files run a second styling script and make outfits flip.

## 1.7.0
- Add 431 complete observed ROPD outfit combinations, bundled for offline use.
- Automatically reshuffle costumes when the first player enters an empty world; preserve outfits during map changes and while friends join.
- Keep town themes by choosing a themed look or a complete observed outfit, rather than mixing their slots.
- Preserve equipped companion costumes, slot toggles, manual shuffle, town life and Cold Bolt behavior.
- Validate entire outfits at startup and retain the original costume pools as fallback.
- Require app 1.8.3, the client-table validation baseline.
- Automated checks pass; live v1.7.0 rendering and relogin testing are pending.

## 1.6.0
- Costumes everywhere: ambient AI in fields and dungeons are styled too (style_whole_world, on by default).
- Unchanged AI are only re-applied every 5 s on maps a real player is on; elsewhere once per change.
- Kept all v1.5.0 features, including Renewal and pre-renewal support.

## 1.5.0
- Works on both Renewal and pre-renewal servers.
- Pre-renewal: costume looks come from built-in Renewal View IDs when the item database lacks the item.
- Renewal unchanged; all v1.4.0 features kept.

## 1.4.0
- Added Townsfolk sit and rest (engine-native shell plan, town_idle_sit).
- Added Townsfolk emotes around real players on town maps (town_idle_emotes).
- Kept v1.3.0 town themes, Costume Guides, costume pools and Cold Bolt rules unchanged.

## 1.3.0
- Added town-themed looks for ambient townsfolk: 12 themes across 34 towns, blended about 60% per slot.
- Added a Costume Guide in each themed town to switch that town's theme off or on, with no GM commands.
- Added the style_town_themes setting (on by default).
- Kept companions, vendors, real costume priority, refresh timing and Cold Bolt rules from v1.2.0.

## 1.2.0
- Fixed script-budget exhaustion by yielding finite batches.
- Added map-arrival refresh and bounded client retries.
- Added new-AI discovery and cached recovery refresh.
- Added optional styling for population-engine vendors.
- Clarified shuffle number range 1–9999 and its independence from timing.
- Preserved four-slot costume selection, real costume priority and Cold Bolt rules.
