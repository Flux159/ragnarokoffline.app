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
