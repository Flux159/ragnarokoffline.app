# Companion Living Style v1.4.0

Companion Living Style v1.4.0 — by DaggerHashimoto

Give your companions and town AI more personality with varied costume headgear, wings, backpacks, colours and supported alternate outfits, plus town-themed looks in 34 major towns.

New in v1.4.0: town life. AI characters now sit down for a short rest when no monster is around, and townsfolk near you show the odd emote — a smile, a heart, an idea, a laugh. Both have their own on/off switch and are built to stay light on the server.

Real costume items you equip on recruited companions take priority; other AI get cosmetic overlays. A Costume Guide beside each town's Warpra or Kafra switches that town's theme off or on. The Outfit shuffle number (1–9999) picks another stable set of looks.

Includes optional Cold Bolt use for any recruited class that already knows it.

Made for Ragnarok Offline 1.7.7 or newer (Renewal) alongside Companion Party Overhaul 3.8.2. Enable Population Engine, install the ZIP, enable the add-on, then Apply & restart. The author confirmed v1.4.0 working in game on Windows with app 1.7.7. Detailed Cold Bolt combat verification and cross-platform testing remain outstanding.

Companion Party Overhaul is a separate mod by Always; this add-on is by DaggerHashimoto.

## What changed
- `town_idle_sit` (on by default): a population-engine plan for AI characters (`For: shells`, never companions). After about 90 s with no monster within 14 cells they sit for 30 s; a monster in sight ends it. The engine stands them up before moving or fighting. File: `db/when/town_idle_sit/population_strategy.yml`, loaded only while the setting is on.
- `town_idle_emotes` (on by default): every 5 s, around each real player on a town map, up to 2 ambient AI within 12 cells show a friendly emote. No server-wide scan. File: `npc/town-emotes-v1.4.0.txt`.
- Everything from v1.3.0 is unchanged: town themes and Costume Guides, costume pools, companions, vendors and Cold Bolt.

## Scope and limits
136 candidate definitions: 48 upper, 32 middle, 32 lower and 24 garment looks. Active definitions must have a positive View and the exact single costume slot. No sprite files, costume items, combat stats or real-player looks are changed. A recruited companion's real costume items retain priority in their slot; ambient and vendor AI receive visual overlays over their default gear. Ambient non-vendor AI styling applies to town-flagged maps; companions and AI vendors are eligible wherever present.

The immediate request happens after the client's map:enter event, and new AI detection is periodic, so this is not a guarantee of zero-frame costume appearance. Slow asset loading or missing sprites can still affect visibility. This release needs live-game confirmation after Apply & restart.

The optional Cold Bolt rule is preserved, covers every recruited class that knows the skill and respects the skill picker and server checks. Heals remain higher priority; it cannot interrupt an existing cast. No automatic inference of other equipment skills.

## Installation and testing
Replace the old companion-living-style folder with this version; do not leave both NPC scripts in the installed mod. Keep Companion Party Overhaul enabled. Use the app's Apply & restart once to load the updated server script and client plugin. Existing saved settings survive; style_vendors defaults on.

Test shuffle values 1, 5 and 9999, teleport into multiple towns, wait for newly spawned AI, check AI vendors and actual equipped costumes, confirm the real player's appearance is unchanged, and inspect map logs for DaggerLivingStyleV1 loop-limit errors. Test before publicly describing the fix as verified. Disable the add-on and restart to return to normal.

## Credits
DaggerHashimoto; GPL-3.0-or-later. Companion Party Overhaul remains authored by Always. Outfit metadata was checked against the rAthena revision in official 1.7.0, 8aea17a7c35fb5e5ee7caa89ee5f8a7b1a25d2f5. See LICENSE-v1.4.0.txt.
