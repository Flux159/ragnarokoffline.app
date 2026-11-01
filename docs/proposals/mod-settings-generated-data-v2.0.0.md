# Proposal: generated server data from mod settings

Status: design proposal for discussion, version 2.0.0. No new API or runtime
behavior is implemented by this document.

## Player need

Item Repair Hub lets a player add existing server items by name, ID or Divine
Pride link, change equipment-family and transfer restrictions, and optionally
assign equipment-bound manual skills or attack-triggered autocasts. Saving
should persist the choices; the app's normal Apply & restart should apply them.

The full prototype works with a private modification of app 1.7.0. The current
settings bridge only exposes get, set and apply, so installing the mod on an
official app does not provide its editor backend. Fixed, bundled repairs work
without that backend but cannot support future player-selected items.

Related discussion and the earlier prototype source:
[#697](https://github.com/Flux159/ragnarokoffline.app/issues/697).
The author closed that issue; no maintainer decision is implied.

## Requested decision

Would a scoped public-table, mod-document and generated-layer capability fit
the mod system? If not, what supported approach should this editor use?
This proposal asks for agreement on the boundary before a production
implementation or registry submission.

## Keep gameplay logic in the mod

The prototype currently keeps item parsing, family rules, skill classification,
the skill catalog and YAML/Lua generation in Electron. That is too specific to
one mod to adopt unchanged.

Those parts should live in the mod, alongside search, pagination, original-script
preservation, temporary skill-grant generation and collection migration. The
platform should only supply the constrained storage and assembly mechanisms
that other mods could also use.

No proposed interface should execute mod JavaScript with Electron privileges,
provide a filesystem handle, or accept shell commands, credentials or raw SQL.

## Proposed capabilities

These names illustrate the boundary; they are not existing APIs.

### Public table snapshots

A mod declares permitted logical table identifiers in its manifest. The app
resolves a fixed allowlist and returns bounded read-only snapshots, including
era, revision and import-order information. Requests contain logical IDs, not
file paths or commands.

Item Repair Hub needs the regional item tables, base usable/equip/etc tables,
iRO additions, applicable imported item records, and skill definitions. A base
table export must not be presented as the effective live database. The editor's
own generated output must be excluded when capturing an original baseline;
otherwise editing an item can gradually bake previous overrides into it.

The exact snapshot contract and how competing mods affect baselines need
agreement. Repeated records must retain rAthena's sequential override semantics.

### A mod-owned document

A settings page reads its own structured document and commits a replacement
using an expected revision. Identity comes from the owning window or authorized
headless frame, never a supplied mod name.

Store this document outside the installed release files so an update retains
the collection. Bound its size and reject stale writes. Specify backup,
migration, reset and uninstall behavior before exposing the feature.

### Declared generated server layers

A mod declares output slots in its manifest. Each slot maps to a reviewed,
restricted server-layer destination. The mod compiles the YAML/Lua and commits
a bounded output bundle together with its document and expected revision.

For example, a request might name slots `itemOverrides` and `itemHooks`.
It must not supply arbitrary destination paths. No generated client JavaScript,
app configuration, other-mod files or arbitrary host paths are in scope.

The installer must disclose that the mod can generate server scripts. Path
validation limits filesystem access; it does not prove that a generated script
is safe gameplay code. This is a new capability requiring explicit review.

## Save and Apply lifecycle

- Save commits one durable revision containing both the document and output
  bundle, without restarting the game.
- Apply/start consumes one complete revision during mod assembly.
- A failed commit or materialization must not leave mixed revisions or silently
  report success. Define crash recovery and serialize conflicting writes.
- Disabling/removing a mod removes its generated effects on reassembly.
- Updating a mod preserves its document while handling changed output slots
  explicitly; obsolete generated files must not survive unnoticed.
- Generated output should remain distinguishable from the registry's
  hash-verified release files.

The storage and assembly location is an open design decision. This document
does not prescribe writing generated files over an installed mod's source.

## Authorization and limits

Keep the current settings sandbox, CSP and network restrictions. Bind every
operation to the installed mod, recheck enabled/refused/removed state, and
provide equivalent authorization for desktop settings and headless frames.

Agree bounds for document size, table snapshots, generated bytes, concurrent
requests and time. Test path traversal, symlinks, Windows junctions and hard
links where applicable. Capability declarations must be validated before use.

Advertise the supported capability version. The mod's requires.app must name
the first official release that includes support, rather than a private patch
that happens to display the same app version.

## Item Repair Hub acceptance cases

1. Add and remove items such as 550169 and 520062 through the settings page.
2. Preserve unrelated job families, item requirements and existing bonus
   scripts while changing selected permissions.
3. Preserve earlier fields when an assembled table repeats an item ID.
4. Save/reload a collection and retain it through a mod update.
5. Grant supported manual-use skills temporarily, display them in the ETC tab,
   and allow hotbar dragging. Unequipping must remove the temporary grant
   without erasing legitimately learned skills.
6. Apply optional autocasts with their selected level, chance and target.
   Passive, NPC, companion, guild and internal skills remain non-selectable
   where they cannot work as player casts.
7. Save without restarting; use the app's ordinary Apply & restart once.
8. Test disabled mods, stale/concurrent edits, offline lookup, failed writes,
   removal and migration from the private prototype.
9. Verify on an unmodified official build, including the supported desktop and
   headless paths, before advertising plug-and-play installation.

Adding an item does not automatically reconstruct missing intended bonuses
from Divine Pride descriptions. Such fixes still need explicit item logic.

## Alternatives

Fixed prebuilt repairs fit today's mod API but cannot satisfy arbitrary future
additions. An external generator requires manual file handling. A narrower
server extension or another existing interface may be preferable to the broader
generated-layer capability; that is the decision requested here.

## Delivery order

Agree the boundary, implement and test the accepted approach against current
main, then release the app support. Test the full mod on that official release
before submitting the registry entry. The prototype's old Electron files must
not replace newer upstream files wholesale.
