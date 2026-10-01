# steal-cards

The Thief's `Steal` skill can return cards.

**1,260 monsters** — every non-MVP monster in rAthena's `mob_db.yml` that has
a card drop — gain a stealable card slot. Killing them still rolls the card
drop at its stock rate; Steal now rolls it too.

MVPs are excluded, so Baphomet's card stays untouchable — and so do
Doppelganger, Dracula, Phreeoni, Eddga, Orc Hero, Moonlight Flower and the
other 190-odd. Mini-bosses like Angeling, Deviling, Ghostring and Vagabond
Wolf are `Class: Boss` but not real MVPs (they have no `MvpDrops:` and no
`Modes.Mvp: true`), so their cards *are* stealable, which is usually the whole
reason a Thief learns Steal in the first place.

## Why the skill ignores cards to begin with

`Steal` (`TF_STEAL`) is `pc_steal_item` in `vendor/rathena/src/map/pc.cpp`. It
walks the target monster's `Drops[]` table in slot order, skips every entry
marked `steal_protected`, and gives the first one whose own roll succeeds. rAthena's stock
`db/re/mob_db.yml` and `db/pre-re/mob_db.yml` both mark **every card drop as
`StealProtected: true`**, so the eligible list is always Jellopy and Sticky
Mucus and never the card. The C code does the right thing; the data locks the
door.

That means the fix belongs in `db/`, not on the fork.

## What this mod does

`db/mob_db.yml` here is 1,260 entries of exactly this shape:

```yaml
- Id: 1002 # Poring (PORING) -- Poring_Card
  Drops:
    - Index: 7
      StealProtected: false
```

`db/import` layers over rAthena's own table — see
[docs/MODDING.md](../../../docs/MODDING.md) — and only the fields spelled here
are touched. Poring's Jellopy, Knife, Sticky Mucus and the rest of its stock
drops are exactly where they were, at the rates they were. All this file
changes is the one flag on Slot 7.

**The `Index:` matches the card's real slot in the stock table** — 7 for
Poring, 6 for Ghostring, 8 for many second-job monsters. The generator reads
the pinned `vendor/rathena/db/re/mob_db.yml` and copies the index verbatim, so the
override lands on the same drop the on-kill roll uses. Nothing is duplicated
and nothing else moves.

`Item:` and `Rate:` are deliberately **not** restated. rAthena's
`MobDatabase::parseDropNode` treats them as optional on an override that
targets an existing `Index:`, so the card name and its stock drop rate are
whatever rAthena ships them as. That matters when the vendor pin moves and
rAthena bumps a rate: the on-kill roll and the Steal roll track the new
value automatically. Spell `Rate:` on an override only when you want to
pin a specific card's drop weight — note it affects both the on-kill roll
and Steal, since both pull from the same `Drops[]` entry.

**What the odds really are.** After the skill's own success check (DEX and
skill level), `pc_steal_item` rolls each stealable drop in slot order and
stops at the first success, and a monster can be stolen from only once. The
card is usually the last slot, so it is only rolled when every drop before it
has failed: on a Poring at 1x rates that is 30% (Jellopy misses) × the other
five misses × 0.2%, about **0.05% per successful steal, one Poring in ~2,000**.
The rates are the server's adjusted ones, so raising the common-item drop rate
makes cards *harder* to steal, and a monster with any earlier drop at 100%
(Jellopy at 1.5x and above) never yields its card to Steal at all. The card
drops rate in the server settings raises the card's own roll.

### Why the override is this small

Until rAthena [Flux159/rathena#4](https://github.com/Flux159/rathena/pull/4),
`MobDatabase::parseDropNode` required `Item` and `Rate` on every drop entry
and rewrote every field on the target slot. An override wanting to touch only
`StealProtected` had to restate the stock `Item` and `Rate`, and would silently
drift the moment rAthena bumped the on-kill rate underneath it. With that fix
in place, an override spells only the fields it changes, and the rest of the
drop is left alone.

## Confirming it works

Install the folder, restart the server (Settings → Restart server, since only
`db/` changed — no app restart needed), and:

1. Look at the map server log for `Loading '1260' entries in
   'db/import/mob_db.yml'`. Fewer entries means part of the file didn't parse.
2. Roll a Thief, learn Steal, find a Poring. `@whodrops 4001` (Poring Card)
   lists Poring at its rate.
3. Cast Steal on Porings until one gives up the card -- at 1x rates, on the
   order of two thousand Porings (see the odds above). To check the mod
   rather than your patience, raise **Card drops** in the server
   settings, or try a monster whose earlier drops are rare.

If Steal still only returns Jellopy and Apple, check the log for a YAML parse
error and check that the target monster's Id is in `db/mob_db.yml`.

## Renewal only

rAthena ships two mob tables, `db/re/mob_db.yml` and `db/pre-re/mob_db.yml`,
and they do **not** agree on where the card sits: of the 451 monsters with a
card in both, 97 have it in a different slot (Hornet's is 7 in renewal and 6
in pre-renewal). The override names a slot, not an item, so on a pre-renewal
server it would unprotect whatever drop happens to be in that slot and leave
the card protected. A mod cannot ship a table per era, so `mod.json` asks for
`"era": "renewal"` and the app refuses it on a pre-renewal world, saying so.

## Regenerating the table

`db/mob_db.yml` is generated, and committed: the mod works as it is, and
nothing a player installs runs Python. The generator lives outside the mod
folder, at
[`registry/tools/steal-cards/generate.py`](../../tools/steal-cards/generate.py),
and needs only the Python standard library. Run it from the repository root
when `config/VENDOR_PINS` moves rAthena, or to change the criteria:

```sh
scripts/vendor-fetch.sh rathena vendor/rathena    # the pinned commit
python3 registry/tools/steal-cards/generate.py    # rewrites db/mob_db.yml
python3 registry/tools/steal-cards/generate.py --check   # or: is it current?
```

It reads `vendor/rathena/db/re/mob_db.yml` (`--source` for another copy),
writes the rAthena commit it read into the output's header, and warns when
that is not the commit `config/VENDOR_PINS` pins. Then regenerate the index
(`python3 scripts/mod-index.py`) and raise `version` in `mod.json`.

### What the generator excludes

`is_mvp()` in `generate.py`. Two rules:

1. `MvpDrops:` field present — Baphomet, Turtle General, Ktullanux, the whole
   real-MVP list.
2. `Modes.Mvp: true` — a handful of MVPs (Bone Detale, EP18_MD_SCHULANG) that
   set the mode without an explicit MvpDrops block.

**`Class: Boss` is not enough.** 539 monsters carry `Class: Boss` without
being MVPs: mini-bosses, boss-class field monsters, event bosses. Their cards
stay in the mod. If you want a stricter version — no bosses at all, however
minor — add `or mob["class"] == "Boss"` to `is_mvp()` and rerun.

## What this mod is not

- **It does not change what `Steal` costs, how far it reaches, or its
  formula.** That is `db/skill_db.yml` and `TF_STEAL` in `src/map/skill.cpp`,
  and both are left alone. The rate `pc_steal_item` weights by is the mob's
  own stock drop rate (unchanged by this mod) — the skill's base success rate
  applies on top.
- **It does not make MVP cards stealable.** They are excluded by design. If
  you want them in too, make `is_mvp()` in `generate.py` return `False` and
  rerun.
- **It does not touch drops that are not cards.** Card equipment drops
  (Poring Hat, etc.) stay steal-protected if they were, and stealable if they
  were. Only slots whose item name ends in `_Card` are rewritten.
- **It does not remove the client's own "cards cannot be stolen" cooldown
  string.** rAthena stopped sending that message the moment the eligible list
  contained a card, so it never appears with this mod installed. The client
  literal in `msgstringtable.txt` is left alone.

## Applying it

`db/` is read when the server starts. Settings → Restart server is enough.
