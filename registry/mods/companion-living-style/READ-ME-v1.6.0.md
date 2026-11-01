# Companion Living Style v1.6.0

Companion Living Style v1.6.0 — by DaggerHashimoto

Give your companions and the AI world more personality with varied costume headgear, wings, backpacks, colours and supported alternate outfits, town-themed looks in 34 major towns, and townsfolk who sit to rest and show the odd emote.

New in v1.6.0: costumes everywhere. Ambient AI in fields and dungeons now wear costumes too, not only in towns. They use the everyday pool; town themes and emotes stay in towns. Turn Costumes everywhere off to go back to towns only.

Works on Renewal and pre-renewal. Real costume items you equip on recruited companions take priority; other AI get cosmetic overlays. A Costume Guide beside each town's Warpra or Kafra switches that town's theme off or on. The Outfit shuffle number (1–9999) picks another stable set of looks.

Includes optional Cold Bolt use for any recruited class that already knows it.

Made for Ragnarok Offline 1.7.7 or newer (Renewal or pre-renewal) alongside Companion Party Overhaul 3.8.2. Enable Population Engine, install the ZIP, enable the add-on, then Apply & restart. The author confirmed town themes, sitting and emotes (v1.4.0) working in game on Renewal, Windows, app 1.7.7. Pre-renewal support (v1.5.0) and costumes in fields and dungeons (v1.6.0) pass the package checks but have not yet been confirmed in a live game. Detailed Cold Bolt combat verification and cross-platform testing remain outstanding.

Companion Party Overhaul is a separate mod by Always; this add-on is by DaggerHashimoto.

## What changed
- New `style_whole_world` setting (on by default): ambient AI are styled on every map, not only town-flagged ones. Fields and dungeons use the everyday pool; town themes stay on their town maps, and emotes stay in towns.
- Cheaper world-wide: an unchanged AI is re-applied every 5 s only on maps a real player is on (tracked from logins and map refresh requests). Elsewhere it is styled once per change of map, job or costume. Arriving on a map still forces a fresh pass.
- "Style ambient townspeople" is now "Style ambient AI"; its key (`style_townspeople`) and saved value are unchanged.
- Everything from v1.5.0 is kept: both eras, town themes, Costume Guides, sitting, emotes, companions, vendors and Cold Bolt.

## Scope and limits
136 candidate definitions: 48 upper, 32 middle, 32 lower and 24 garment looks. Active definitions must have a positive View and the exact single costume slot. No sprite files, costume items, combat stats or real-player looks are changed. A recruited companion's real costume items retain priority in their slot; ambient and vendor AI receive visual overlays over their default gear. Ambient non-vendor AI styling applies to town-flagged maps; companions and AI vendors are eligible wherever present.

The immediate request happens after the client's map:enter event, and new AI detection is periodic, so this is not a guarantee of zero-frame costume appearance. Slow asset loading or missing sprites can still affect visibility. This release needs live-game confirmation after Apply & restart.

The optional Cold Bolt rule is preserved, covers every recruited class that knows the skill and respects the skill picker and server checks. Heals remain higher priority; it cannot interrupt an existing cast. No automatic inference of other equipment skills.

## Installation and testing
Replace the old companion-living-style folder with this version; do not leave both NPC scripts in the installed mod. Keep Companion Party Overhaul enabled. Use the app's Apply & restart once to load the updated server script and client plugin. Existing saved settings survive; style_vendors defaults on.

Test shuffle values 1, 5 and 9999, teleport into multiple towns, wait for newly spawned AI, check AI vendors and actual equipped costumes, confirm the real player's appearance is unchanged, and inspect map logs for DaggerLivingStyleV1 loop-limit errors. Test before publicly describing the fix as verified. Disable the add-on and restart to return to normal.

## Credits
DaggerHashimoto; GPL-3.0-or-later. Companion Party Overhaul remains authored by Always. Outfit metadata was checked against the rAthena revision in official 1.7.0, 8aea17a7c35fb5e5ee7caa89ee5f8a7b1a25d2f5. See LICENSE-v1.6.0.txt.
