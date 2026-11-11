# Companion Living Style v1.7.2

By DaggerHashimoto. Requires Ragnarok Offline 1.8.3 or newer and Population Engine. Supports Renewal and pre-renewal.

## New in v1.7.2

A tidy-up with no visible change: the in-view restyle only remembers what each player saw on the last pass and forgets it at logout, so it no longer leaves server variables behind.

## v1.7.1: no more costume flipping

The game only shows a costume as a one-off look update. Before, an AI walking into your view was drawn in its own headgear until the next five-second refresh, so outfits seemed to flip back and forth. Now each AI is restyled the moment it comes into a real player's view. Outfit choices are unchanged.

## Complete observed outfits

The default general pool now contains **431 complete ROPD appearance combinations**, bundled offline. Upper, middle, lower and garment looks come from the same observed outfit. Empty slots remain empty. No player names, character/account IDs, Discord details, credentials, screenshots or remote services are included in the installed catalog.

The November 10, 2026 collection sampled 20 pages, 1,994 player appearances and 1,487 unique nonempty combinations. Of these, 908 match every occupied slot in the retained Renewal costume reference; 431 also match the app 1.8.3 bundled HatTable/RobeTable identifiers. The other 1,056 are excluded as complete outfits, not repaired by mixing pieces. Some excluded looks may work through game-data Lua tables, but have not been validated here. View-table presence is not proof of sprite bytes or live rendering.

ROPD records visible appearance IDs, not inventory ownership. A matching costume definition is used to validate each appearance; this does not assert that the source player wore that particular item. No items, stats or jobs are copied.

## Automatic sessions

**Fresh outfits each login** is on by default. The first real player entering an empty world chooses a new random session seed. Map changes and refresh retries keep that seed. On a shared server, additional players joining do not reshuffle the active session. Logging out and back in while nobody else remains starts a fresh selection. Random choices can repeat.

The old shuffle number is retained for saved-settings compatibility, manual mode, and the existing colour/body variation. Turn automatic sessions off to use a fixed seed. No imported hair, palette, body or job data is used.

## Town themes and equipped costumes

About 60% of ambient townsfolk in themed towns use the town's themed look; the rest use a complete ROPD outfit. ROPD pieces are not combined with theme pieces. The Costume Guide and each town's saved toggle remain.

Real costumes equipped on recruited companions take priority per slot. Disabling a costume slot also overrides that part of a combination. Ambient AI and vendors receive appearance overlays; real players and ordinary NPCs are excluded.

Turn **Complete ROPD outfits** off to restore the original mixed pools. If the active database rejects every bundled outfit, those pools remain the fallback. On Renewal, all four occupied slots must match the selected costume item location and reference View or the whole outfit is skipped. Pre-renewal retains the existing missing-definition fallback to shipped Renewal Views.

Town sitting, emotes, same-family alternate bodies, colour options, world-wide styling and optional Cold Bolt rules are retained. Companion Party Overhaul is a separate mod by Always.

## Install and test

Install the ZIP or updated registry folder, keep your saved options, then use the app's **Apply & restart**. Do not keep old and new Living Style NPC files together.

This update passes the automated catalog/settings/client-refresh checks and the app 1.8.3 manifest check. The author confirmed v1.7.0 and v1.7.1 working in game on a pre-renewal server (Windows, app 1.8.3). v1.7.2 passes the same checks and is awaiting live testing. Renewal play with v1.7.x and individual relogin and multiplayer cases have not been tested one by one.

Check: populated town, field and dungeon; logout/login; map revisit within one session; equipped companion costumes; disabled slots; town theme toggle; automatic and manual modes. Inspect fresh map-server logs for parse and loop-limit errors.

## Updating the catalog

Maintainer inputs, generator and checks live in `registry/tools/companion-living-style/`, outside the installable mod. Run its generator after validating additional views, raise the mod version, regenerate the registry index and open an update PR. No scheduled scraping runs in players' games.

Appearance source: https://www.iromarket.net/ropd/
Costume reference: rAthena Renewal equipment definitions retained from app 1.7.0; GPL-3.0-or-later. Bundled view mappings checked against app 1.8.3.
