//! Shuffling the monsters.
//!
//! # The trick
//!
//! A monster in rAthena is an ID with a block of numbers attached. Every stock
//! spawn line in the server — 3,000 of them across the world — names an ID.
//! So there is no need to move a single spawn to change what lives where:
//! **move the blocks between the IDs and the whole world reshuffles.**
//!
//! That matters, because a mod *cannot* remove a stock spawn. Adding is the
//! whole vocabulary. Identity shuffling sidesteps the limit entirely.
//!
//! # What moves and what stays
//!
//! Each ID keeps its `Id` and `AegisName` — those are how the rest of the
//! server and every existing script refer to it, and moving them would break
//! `getmonsterinfo`, spawn scripts and card drops. Everything else — level,
//! HP, attack, element, race, size, AI, skills, drops — is lifted from another
//! monster and written back wholesale, without this tool ever interpreting a
//! single stat. See `yaml.rs` for why that is the safe way to do it.
//!
//! `Name` (the label you see over its head) moves with the stats by default,
//! so the world is *readable*: a thing calling itself Baphomet hits like
//! Baphomet. `--disguise` keeps the original name instead, so a Poring can be
//! anything at all and there is nothing to warn you.
//!
//! # Drops, and the trap under them
//!
//! `db/import` layers over rAthena's table rather than replacing it, and
//! `Drops:` is the one field where that is *additive*: an entry without an
//! `Index:` is appended to whatever the monster already dropped. Shuffling
//! naively therefore gives every monster its own drops plus its new ones, up
//! to a cap of ten, at which point the server says
//!
//! ```text
//! [Error]: Maximum of 10 monster Drops met, skipping.
//! ```
//!
//! So every drop this writes carries an explicit `Index:`, which overwrites
//! that slot (`MobDatabase::parseDropNode`, `src/map/mob.cpp`), and the slots
//! left over are filled with a worthless item at the lowest rate the server
//! will accept.
//!
//! That last part is a compromise, arrived at the hard way. There is no way to
//! *delete* a drop slot from an import — the table only ever layers — so the
//! obvious move is `Rate: 0`, meaning "never". rAthena refuses it:
//!
//! ```text
//! [Error]: Node "Rate" needs to be at least 1.
//! ```
//!
//! and `asUInt16Rate` rejecting the value makes `parseBodyNode` return early,
//! so a single zero does not blank one drop — it throws away **the whole
//! monster**, silently leaving it as it was. The minimum the parser accepts is
//! 1, which is 0.01%: one filler in ten thousand kills. Not nothing, and said
//! plainly in the generated README rather than glossed.

use crate::rng::Rng;
use crate::yaml::{Document, Entry};

/// rAthena's `MAX_MOB_DROP`, and `MAX_MVP_DROP`.
const MAX_DROP: usize = 10;
const MAX_MVP_DROP: usize = 3;

/// The item used to neutralise a drop slot that the replacement monster does
/// not fill. It has to be a real item -- the parser skips an entry naming one
/// it cannot find, and the slot would keep its original contents.
const FILLER_ITEM: &str = "Jellopy";

/// The lowest drop rate rAthena accepts: 1 in 10,000. Zero is rejected, and
/// the rejection discards the entire monster. See the module comment.
const FILLER_RATE: u16 = 1;

pub struct Options {
    /// Keep each monster's original name, so nothing warns you.
    pub disguise: bool,
    /// Shuffle the unkillable props along with everything else.
    pub include_props: bool,
    /// Ignore level bands and shuffle the whole table together.
    pub chaos: bool,
    /// Width of a level band. Monsters only swap with others in the same one.
    pub band: u32,
}

pub struct Outcome {
    pub mob_db: String,
    /// Entries deliberately left where they were. See `is_prop`.
    pub kept: usize,
    pub mob_avail: String,
    /// How many IDs ended up holding a different monster's block. Always less
    /// than the total: a shuffle leaves some things where they were, and
    /// pretending otherwise would be a lie in the summary line.
    pub swapped: usize,
    pub total: usize,
    pub bands: usize,
}

/// One entry, with the two things this module needs to reason about.
struct Slot {
    id: String,
    aegis: String,
    name: String,
    level: u32,
    entry: Entry,
}

pub fn randomize(source: &str, rng: &mut Rng, opts: &Options) -> Result<Outcome, String> {
    let doc = Document::parse(source, "MOB_DB").map_err(|e| format!("mob_db.yml: {e}"))?;

    let mut slots: Vec<Slot> = Vec::new();
    for entry in doc.entries {
        // An entry without these is not a monster this can move. That includes
        // the commented-out reservations at the end of the stock file.
        let (Some(id), Some(aegis)) = (entry.field("Id"), entry.field("AegisName")) else {
            continue;
        };
        let name = entry.field("Name").unwrap_or(aegis).to_string();
        let level = entry.field("Level").and_then(|l| l.parse().ok()).unwrap_or(1);
        slots.push(Slot {
            id: id.to_string(),
            aegis: aegis.to_string(),
            name,
            level,
            entry,
        });
    }
    if slots.len() < 2 {
        return Err(format!("only {} monsters found -- is this a mob_db?", slots.len()));
    }

    // Props stay exactly where they are, and nothing is moved onto them.
    // Everything else shuffles around them.
    let movable: Vec<usize> = (0..slots.len())
        .filter(|i| opts.include_props || !is_prop(&slots[*i].entry))
        .collect();
    let kept = slots.len() - movable.len();

    // Which slot's block each slot receives. Built as a permutation over
    // indices so nothing is duplicated or lost.
    let groups = if opts.chaos {
        vec![movable.clone()]
    } else {
        band_by_level(&slots, &movable, opts.band)
    };

    let mut from: Vec<usize> = (0..slots.len()).collect();
    for group in &groups {
        // Shuffle the group's members among themselves. A monster can still
        // land on itself, which is correct: forbidding it would make the
        // shuffle non-uniform, and one Poring staying a Poring is not a bug.
        let mut picks: Vec<usize> = group.clone();
        rng.shuffle(&mut picks);
        for (slot, pick) in group.iter().zip(picks) {
            from[*slot] = pick;
        }
    }

    let mut body = String::new();
    let mut avail = String::new();
    let mut swapped = 0;
    for (i, slot) in slots.iter().enumerate() {
        let src = &slots[from[i]];
        if from[i] != i {
            swapped += 1;
        }

        // The source's whole block, re-labelled with this slot's identity.
        let mut e = src.entry.clone();
        e.set_field("Id", &slot.id);
        e.set_field("AegisName", &slot.aegis);
        if opts.disguise {
            e.set_field("Name", &slot.name);
        }
        rewrite_drops(&mut e, "Drops", MAX_DROP);
        rewrite_drops(&mut e, "MvpDrops", MAX_MVP_DROP);

        for line in &e.lines {
            body.push_str(line);
            body.push('\n');
        }

        // Make it look like what it now is. Skipped when the monster did not
        // move -- an identity mapping is noise in the file and one more thing
        // for the server to load.
        if !opts.disguise && from[i] != i {
            avail.push_str(&format!("  - Mob: {}\n    Sprite: {}\n", slot.aegis, src.aegis));
        }
    }

    Ok(Outcome {
        kept,
        mob_db: format!(
            "{}\n{body}",
            header("MOB_DB", version_of(&doc.preamble).unwrap_or("5"))
        ),
        mob_avail: if avail.is_empty() {
            String::new()
        } else {
            format!("{}\n{avail}", header("MOB_AVAIL_DB", "1"))
        },
        swapped,
        total: slots.len(),
        bands: groups.len(),
    })
}

/// Group slot indices so a monster only swaps with others near its level.
///
/// Without this, seed after seed puts a level 99 MVP in the first field
/// outside Prontera and the run is over before it starts. Banding keeps the
/// difficulty curve roughly where the map designers left it while changing
/// everything about what you are actually fighting.
fn band_by_level(slots: &[Slot], movable: &[usize], band: u32) -> Vec<Vec<usize>> {
    let band = band.max(1);
    let mut by_band: std::collections::BTreeMap<u32, Vec<usize>> = std::collections::BTreeMap::new();
    for i in movable {
        by_band.entry(slots[*i].level / band).or_default().push(*i);
    }
    by_band.into_values().collect()
}

/// Is this a thing the world places but nobody fights?
///
/// The table is not all monsters. It also holds the emperium, WoE barricades,
/// guild flags and the four elemental crystals -- entries whose `Modes:` block
/// turns off whole damage types, so that ordinary attacks simply do not land.
///
/// Shuffling those in is not "chaotic", it is broken: give Poring the water
/// crystal's block and every Poring in the game becomes unkillable, which for
/// a new character standing outside Prontera means the run is over before it
/// starts. They keep their own slots, and the rest of the table shuffles
/// around them.
///
/// Matched on the raw lines rather than a parsed mode set, because the point
/// is "this entry says Ignore-something", and that reads the same whichever
/// flag it is.
fn is_prop(entry: &Entry) -> bool {
    entry.lines.iter().any(|l| {
        let t = l.trim();
        t.starts_with("Ignore") && t.ends_with(": true")
    })
}

/// Give every drop an explicit index and blank the slots that are left.
///
/// See the module comment: without this, drops accumulate rather than replace.
fn rewrite_drops(e: &mut Entry, field: &str, max: usize) {
    let existing = collect_drops(e, field);
    e.remove_field(field);
    if existing.is_empty() && field == "MvpDrops" {
        // Nothing to clear: a monster with no MVP drops in the base table has
        // no slots to blank, and writing three fillers into every monster in
        // the file would add a megabyte for nothing.
        return;
    }
    let mut block = format!("    {field}:\n");
    for (i, (item, rest)) in existing.iter().take(max).enumerate() {
        block.push_str(&format!("      - Index: {i}\n        Item: {item}\n"));
        for line in rest {
            block.push_str(line);
            block.push('\n');
        }
    }
    // Blank the rest, so the monster this block came from does not leave its
    // old drops behind on the monster it replaced.
    for i in existing.len().min(max)..max {
        block.push_str(&format!(
            "      - Index: {i}\n        Item: {FILLER_ITEM}\n        Rate: {FILLER_RATE}\n"
        ));
    }
    // Trailing newline is already there; push the block as extra lines.
    for line in block.trim_end_matches('\n').split('\n') {
        e.lines.push(line.to_string());
    }
}

/// Pull the drops out of an entry: the item name, and the other lines of the
/// entry (Rate, StealProtected, RandomOptionGroup) kept verbatim.
fn collect_drops(e: &Entry, field: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut inside = false;
    for (i, line) in e.lines.iter().enumerate() {
        let top = if i == 0 { line.strip_prefix("  - ") } else { line.strip_prefix("    ") };
        if let Some(body) = top {
            if !body.starts_with([' ', '-']) {
                inside = body.starts_with(field) && body[field.len()..].starts_with(':');
                continue;
            }
        }
        if !inside {
            continue;
        }
        if let Some(rest) = line.strip_prefix("      - ") {
            // The first line of a drop. `Index:` is dropped if the source
            // already had one -- this rewrites them all from zero.
            if let Some(item) = rest.strip_prefix("Item:") {
                out.push((item.trim().to_string(), Vec::new()));
            } else if rest.starts_with("Index:") {
                out.push((String::new(), Vec::new()));
            }
        } else if line.starts_with("        ") {
            let keep = !line.trim_start().starts_with("Index:");
            if let Some(last) = out.last_mut() {
                if let Some(item) = line.trim_start().strip_prefix("Item:") {
                    last.0 = item.trim().to_string();
                } else if keep {
                    last.1.push(line.clone());
                }
            }
        }
    }
    out.retain(|(item, _)| !item.is_empty());
    out
}

fn header(kind: &str, version: &str) -> String {
    format!(
        "# Generated by ro-randomizer. Do not edit by hand -- regenerate with the\n\
         # same seed instead, which produces exactly this file again.\n\n\
         Header:\n  Type: {kind}\n  Version: {version}\n\nBody:"
    )
}

/// The version out of the source file's header, so the generated table matches
/// the build it came from rather than a number hardcoded here.
fn version_of(preamble: &[String]) -> Option<&str> {
    preamble
        .iter()
        .find_map(|l| l.trim().strip_prefix("Version:"))
        .map(str::trim)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "\
Header:
  Type: MOB_DB
  Version: 5

Body:
  - Id: 1002
    AegisName: PORING
    Name: Poring
    Level: 1
    Hp: 50
    Drops:
      - Item: Jellopy
        Rate: 7000
      - Item: Knife_
        Rate: 100
        StealProtected: true
  - Id: 1039
    AegisName: BAPHOMET
    Name: Baphomet
    Level: 81
    Hp: 668000
    MvpDrops:
      - Item: Old_Violet_Box
        Rate: 5000
    Drops:
      - Item: Emperium
        Rate: 1000
";

    /// Just the one entry. `split("- Id: 1002").nth(1)` looks right and is
    /// not: it returns the rest of the file, so an assertion about what an
    /// entry does *not* contain would read the next entry instead.
    fn entry_of<'a>(db: &'a str, id: &str) -> &'a str {
        let start = db.find(&format!("  - Id: {id}\n")).expect("no such entry");
        let rest = &db[start + 4..];
        match rest.find("\n  - Id: ") {
            Some(end) => &rest[..end],
            None => rest,
        }
    }

    fn opts() -> Options {
        Options { disguise: false, include_props: false, chaos: true, band: 10 }
    }

    #[test]
    fn identity_stays_with_the_slot_and_stats_move() {
        // Seed chosen below so the two entries actually swap.
        let mut swapped_once = false;
        for seed in 0..40u64 {
            let out = randomize(SRC, &mut Rng::new(seed), &opts()).unwrap();
            if out.swapped == 0 {
                continue;
            }
            swapped_once = true;
            // Both IDs still exist exactly once, with their own AegisName.
            assert_eq!(out.mob_db.matches("- Id: 1002").count(), 1);
            assert_eq!(out.mob_db.matches("- Id: 1039").count(), 1);
            assert!(out.mob_db.contains("AegisName: PORING"));
            assert!(out.mob_db.contains("AegisName: BAPHOMET"));
            // And the stats moved: the Poring slot now has Baphomet's HP.
            let poring = entry_of(&out.mob_db, "1002");
            assert!(poring.contains("Hp: 668000"), "{poring}");
            // The sprite follows.
            assert!(out.mob_avail.contains("Mob: PORING"), "{}", out.mob_avail);
            assert!(out.mob_avail.contains("Sprite: BAPHOMET"), "{}", out.mob_avail);
            break;
        }
        assert!(swapped_once, "no seed in 0..40 swapped a two-entry table");
    }

    /// The bug this whole module is shaped around.
    #[test]
    fn every_drop_is_indexed_and_the_rest_are_blanked() {
        let out = randomize(SRC, &mut Rng::new(1), &opts()).unwrap();
        for block in out.mob_db.split("- Id: ").skip(1) {
            let drops: Vec<&str> = block.lines().filter(|l| l.contains("Item:")).collect();
            // Every monster gets a full ten Drops slots, all indexed.
            let indices: Vec<&str> = block.lines().filter(|l| l.contains("Index:")).collect();
            assert!(indices.len() >= MAX_DROP, "only {} indices in {block}", indices.len());
            assert!(!drops.is_empty());
        }
        assert!(
            out.mob_db.contains(&format!("Rate: {FILLER_RATE}")),
            "no filler was written for the unused drop slots"
        );
        // Zero is what you would reach for and it is rejected by the server,
        // taking the whole monster with it. Nothing may emit it.
        assert!(!out.mob_db.contains("Rate: 0\n"), "Rate: 0 would discard the monster");
        // Nothing is left unindexed, which is what would append.
        for line in out.mob_db.lines() {
            if let Some(rest) = line.strip_prefix("      - ") {
                assert!(rest.starts_with("Index:"), "unindexed drop line: {line}");
            }
        }
    }

    #[test]
    fn steal_protected_and_other_drop_fields_survive() {
        let out = randomize(SRC, &mut Rng::new(1), &opts()).unwrap();
        assert!(out.mob_db.contains("StealProtected: true"), "{}", out.mob_db);
        assert!(out.mob_db.contains("Rate: 7000"));
    }

    #[test]
    fn mvp_drops_are_indexed_too_and_only_where_they_existed() {
        let out = randomize(SRC, &mut Rng::new(1), &opts()).unwrap();
        assert!(out.mob_db.contains("MvpDrops:"));
        let mvp_blocks = out.mob_db.matches("MvpDrops:").count();
        assert_eq!(mvp_blocks, 1, "MvpDrops was written for a monster that had none");
    }

    #[test]
    fn disguise_keeps_the_name_and_writes_no_sprite_map() {
        let mut o = opts();
        o.disguise = true;
        let out = randomize(SRC, &mut Rng::new(3), &o).unwrap();
        let poring = entry_of(&out.mob_db, "1002");
        assert!(poring.contains("Name: Poring"), "{poring}");
        assert!(out.mob_avail.is_empty());
    }

    /// Banding is what keeps the first field outside town survivable.
    #[test]
    fn bands_keep_a_level_1_slot_at_level_1() {
        let mut o = opts();
        o.chaos = false;
        o.band = 10;
        let out = randomize(SRC, &mut Rng::new(5), &o).unwrap();
        assert_eq!(out.swapped, 0, "level 1 and level 81 must not be in one band");
        assert_eq!(out.bands, 2);
    }

    /// The correctness fix, not a taste one: an unkillable block landing on
    /// Poring ends a new character's game.
    #[test]
    fn unkillable_props_keep_their_own_slots() {
        const WITH_CRYSTAL: &str = "\
Header:
  Type: MOB_DB
  Version: 5

Body:
  - Id: 1002
    AegisName: PORING
    Name: Poring
    Level: 1
    Hp: 50
  - Id: 1914
    AegisName: WATER_CRYSTAL
    Name: Water Crystal
    Level: 1
    Hp: 15
    Modes:
      IgnoreMelee: true
      IgnoreMagic: true
";
        // Every seed, not one lucky one: the crystal must never move.
        for seed in 0..30u64 {
            let out = randomize(WITH_CRYSTAL, &mut Rng::new(seed), &opts()).unwrap();
            assert_eq!(out.kept, 1);
            assert_eq!(out.swapped, 0, "seed {seed} moved a prop");
            let poring = entry_of(&out.mob_db, "1002");
            assert!(poring.contains("Hp: 50"), "seed {seed}: {poring}");
            assert!(!poring.contains("IgnoreMelee"), "seed {seed}: Poring became unkillable");
        }
        // And with --include-props it is allowed to move again.
        let mut o = opts();
        o.include_props = true;
        let mut moved = false;
        for seed in 0..30u64 {
            let out = randomize(WITH_CRYSTAL, &mut Rng::new(seed), &o).unwrap();
            assert_eq!(out.kept, 0);
            moved |= out.swapped > 0;
        }
        assert!(moved, "--include-props never moved anything");
    }

    #[test]
    fn the_header_version_comes_from_the_source() {
        let out = randomize(SRC, &mut Rng::new(1), &opts()).unwrap();
        assert!(out.mob_db.contains("Type: MOB_DB"));
        assert!(out.mob_db.contains("Version: 5"));
    }

    #[test]
    fn the_same_seed_produces_the_same_file() {
        let a = randomize(SRC, &mut Rng::new(77), &opts()).unwrap();
        let b = randomize(SRC, &mut Rng::new(77), &opts()).unwrap();
        assert_eq!(a.mob_db, b.mob_db);
    }
}
