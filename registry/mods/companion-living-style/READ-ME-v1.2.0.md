# Companion Living Style v1.2.0

Companion Living Style v1.2.0 — by DaggerHashimoto

Give your companions and town AI more personality with varied upper, middle and lower costume headgear, wings, backpacks, colours and supported alternate outfits. AI vendors can join in too, with their own on/off setting.

Four costume slots have separate switches. Real costume items you equip on recruited companions take priority; ambient and vendor AI get cosmetic overlays over their default looks. Cosmetic changes preserve combat equipment and stats. The Outfit shuffle number ranges from 1 to 9999 and chooses another stable set of looks — it is not a speed setting.

This version fixes the earlier scan hitting the server's script loop limit. It refreshes on map arrival, retries while AI populate the map, and checks for new AI in small batches. Appearance still depends on available client sprites and normal network/rendering time; zero-delay rendering is not guaranteed.

Includes optional Cold Bolt use for any recruited class that already knows it (for example, from a working Cocytus Armor definition). Other equipment skills are not automatically covered.

Made for Ragnarok Offline Renewal 1.7.0 alongside Companion Party Overhaul 3.8.2. Enable Population Engine, install the ZIP, enable the add-on, then Apply & restart. Save-only settings are in Companion Living Style. The author confirmed the costume behaviour working in game on Windows. Detailed Cold Bolt combat verification and cross-platform testing remain outstanding.

Companion Party Overhaul is a separate mod by Always; this add-on is by DaggerHashimoto.


## What changed
- Finite costume scans now yield every four candidates/units, including pool setup and filtered units, instead of exhausting the server script budget.
- Map-arrival client requests style the requesting player's current map. Retries at 150, 500 and 1200 ms handle delayed population spawns. Requests are rate-limited and never accept a client-specified AI or map ID.
- A 250 ms discovery timer finds new AI, and a five-second recovery refresh handles later appearance resets. The timer waits for a batch to finish, avoiding overlapping scans. A busy map request is retried by the client.
- AI vendors have a default-on style_vendors switch. Regular NPC shopkeepers are outside the population engine and remain unchanged.
- Shuffle range 1–9999 is visible in the setting label and page. Every value uses identical timing. Saved shuffle choices remain compatible.

## Scope and limits
136 candidate definitions: 48 upper, 32 middle, 32 lower and 24 garment looks. Active definitions must have a positive View and the exact single costume slot. No sprite files, costume items, combat stats or real-player looks are changed. A recruited companion's real costume items retain priority in their slot; ambient and vendor AI receive visual overlays over their default gear. Ambient non-vendor AI styling applies to town-flagged maps; companions and AI vendors are eligible wherever present.

The immediate request happens after the client's map:enter event, and new AI detection is periodic, so this is not a guarantee of zero-frame costume appearance. Slow asset loading or missing sprites can still affect visibility. The author confirmed this version working after Apply & restart on 26 October 2026. Sprite availability still depends on the player's client assets.

The optional Cold Bolt rule is preserved, covers every recruited class that knows the skill and respects the skill picker and server checks. Heals remain higher priority; it cannot interrupt an existing cast. No automatic inference of other equipment skills.

## Installation and testing
Replace the old companion-living-style folder with this version; do not leave both NPC scripts in the installed mod. Keep Companion Party Overhaul enabled. Use the app's Apply & restart once to load the updated server script and client plugin. Existing saved settings survive; style_vendors defaults on.

Test shuffle values 1, 5 and 9999, teleport into multiple towns, wait for newly spawned AI, check AI vendors and actual equipped costumes, confirm the real player's appearance is unchanged, and inspect map logs for DaggerLivingStyleV1 loop-limit errors. These are useful regression checks after app updates. Disable the add-on and restart to return to normal.

## Credits
DaggerHashimoto; GPL-3.0-or-later. Companion Party Overhaul remains authored by Always. Outfit metadata was checked against the rAthena revision in official 1.7.0, 8aea17a7c35fb5e5ee7caa89ee5f8a7b1a25d2f5. See LICENSE-v1.2.0.txt.
