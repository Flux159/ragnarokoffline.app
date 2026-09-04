//! Just enough of rAthena's YAML to move whole entries around.
//!
//! This is **not** a YAML parser and must not be mistaken for one. It is a
//! reader for one specific shape: the files rAthena generates and ships, which
//! are rigidly regular --
//!
//! ```text
//! Header:
//!   Type: MOB_DB
//!   Version: 5
//!
//! Body:
//!   - Id: 1002
//!     AegisName: PORING
//!     Level: 1
//!     Drops:
//!       - Item: Jellopy
//!         Rate: 7000
//!   - Id: 1003
//!     ...
//! ```
//!
//! Two spaces, a dash and a space starts an entry; four spaces is a field of
//! it; anything deeper belongs to whatever field came last. That is all this
//! needs to know, because of the trick the randomizer is built on: **it never
//! interprets a stat.** It lifts an entry's body wholesale, changes the two
//! lines that identify it, and writes it back. Levels, elements, sizes, AI,
//! skills, drops -- all of it moves as one opaque block.
//!
//! That is why a hand-rolled reader is defensible here where it would not be
//! for `mod.json`. The failure mode of misreading a stat is a subtly wrong
//! monster; the failure mode of this is a line that does not start with two
//! spaces, which is caught below and reported.

use std::fmt;

/// One `- Id: …` block, kept as the lines it was written on.
#[derive(Clone)]
pub struct Entry {
    /// Every line of the entry, including the leading `  - ` line, verbatim.
    pub lines: Vec<String>,
}

impl Entry {
    /// The value of a top-level field of this entry, if it has one.
    ///
    /// Top-level means indented four spaces (or on the `  - ` line itself), so
    /// a `Rate:` inside a `Drops:` list is not mistaken for the entry's own.
    pub fn field(&self, name: &str) -> Option<&str> {
        for (i, line) in self.lines.iter().enumerate() {
            // `continue`, never `?`: an entry may carry blank lines and
            // comments, and returning None on the first of them would abandon
            // the search before reaching the field.
            let Some(body) = (if i == 0 {
                line.strip_prefix("  - ")
            } else {
                line.strip_prefix("    ")
            }) else {
                continue;
            };
            // A deeper line still passes the four-space strip; require that
            // what is left does not itself start with a space or a dash.
            if body.starts_with([' ', '-']) {
                continue;
            }
            // The colon has to be matched too, or `Level` finds `LevelUp`.
            if let Some(rest) = body.strip_prefix(name) {
                if let Some(v) = rest.strip_prefix(':') {
                    return Some(v.trim());
                }
            }
        }
        None
    }

    /// Replace a top-level field's value, or add it if it is absent.
    pub fn set_field(&mut self, name: &str, value: &str) {
        for (i, line) in self.lines.iter_mut().enumerate() {
            let (indent, body) = if i == 0 {
                ("  - ", line.strip_prefix("  - "))
            } else {
                ("    ", line.strip_prefix("    "))
            };
            let Some(body) = body else { continue };
            if body.starts_with([' ', '-']) {
                continue;
            }
            if body.starts_with(name) && body[name.len()..].starts_with(':') {
                *line = format!("{indent}{name}: {value}");
                return;
            }
        }
        // Absent: add it as the second line, which keeps `- Id:` first.
        let at = if self.lines.len() > 1 { 1 } else { self.lines.len() };
        self.lines.insert(at, format!("    {name}: {value}"));
    }

    /// Drop every top-level field called `name`, and the block under it.
    pub fn remove_field(&mut self, name: &str) {
        let mut out: Vec<String> = Vec::with_capacity(self.lines.len());
        let mut skipping = false;
        for (i, line) in self.lines.iter().enumerate() {
            let top = if i == 0 { line.strip_prefix("  - ") } else { line.strip_prefix("    ") };
            let is_top = match top {
                Some(b) => !b.starts_with([' ', '-']),
                None => false,
            };
            if is_top {
                let b = top.unwrap();
                skipping = b.starts_with(name) && b[name.len()..].starts_with(':');
                // Never drop the first line: it carries the `- ` that starts
                // the entry. If the field to remove is on it, blank the value
                // instead of losing the marker.
                if skipping && i == 0 {
                    skipping = false;
                }
            }
            if !skipping {
                out.push(line.clone());
            }
        }
        self.lines = out;
    }
}

/// A whole rAthena database file, split into what comes before `Body:` and the
/// entries under it.
pub struct Document {
    /// Everything up to and including the `Body:` line, verbatim.
    pub preamble: Vec<String>,
    pub entries: Vec<Entry>,
}

#[derive(Debug)]
pub struct ShapeError(String);

impl fmt::Display for ShapeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Document {
    pub fn parse(text: &str, expect_type: &str) -> Result<Document, ShapeError> {
        let mut preamble = Vec::new();
        let mut entries: Vec<Entry> = Vec::new();
        let mut in_body = false;
        let mut saw_type = false;

        for (n, raw) in text.lines().enumerate() {
            let line = raw.trim_end_matches('\r');
            if !in_body {
                if line.trim_start().starts_with("Type:") {
                    let got = line.split(':').nth(1).unwrap_or("").trim();
                    if got != expect_type {
                        return Err(ShapeError(format!(
                            "this is a {got} file, not a {expect_type} one"
                        )));
                    }
                    saw_type = true;
                }
                preamble.push(line.to_string());
                if line == "Body:" {
                    in_body = true;
                }
                continue;
            }

            if line.starts_with("  - ") {
                entries.push(Entry { lines: vec![line.to_string()] });
                continue;
            }
            // Blank lines and comments between entries belong to the entry
            // above; carrying them along keeps a block self-contained.
            if line.trim().is_empty() || line.starts_with("    ") || line.trim_start().starts_with('#') {
                match entries.last_mut() {
                    Some(e) => e.lines.push(line.to_string()),
                    None => preamble.push(line.to_string()),
                }
                continue;
            }
            // Anything else at column 0 after Body: is a Footer or something
            // this reader was not built for. Stop rather than guess.
            return Err(ShapeError(format!(
                "line {}: unexpected {:?} after Body -- this reader only \
                 understands the shape rAthena generates",
                n + 1,
                line.chars().take(40).collect::<String>()
            )));
        }

        if !saw_type {
            return Err(ShapeError(format!("no `Type: {expect_type}` header")));
        }
        if !in_body {
            return Err(ShapeError("no `Body:` section".into()));
        }
        // Trailing blank lines belong to the file, not the last entry.
        if let Some(last) = entries.last_mut() {
            while last.lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
                last.lines.pop();
            }
        }
        Ok(Document { preamble, entries })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# a comment
Header:
  Type: MOB_DB
  Version: 5

Body:
  - Id: 1002
    AegisName: PORING
    Name: Poring
    Level: 1
    Drops:
      - Item: Jellopy
        Rate: 7000
      - Item: Knife_
        Rate: 100
  - Id: 1003
    AegisName: FABRE
    Name: Fabre
    Level: 2
";

    fn doc() -> Document {
        Document::parse(SAMPLE, "MOB_DB").unwrap()
    }

    #[test]
    fn splits_into_entries_without_losing_a_line() {
        let d = doc();
        assert_eq!(d.entries.len(), 2);
        let rebuilt: Vec<String> = d
            .preamble
            .iter()
            .cloned()
            .chain(d.entries.iter().flat_map(|e| e.lines.iter().cloned()))
            .collect();
        assert_eq!(rebuilt.join("\n") + "\n", SAMPLE);
    }

    #[test]
    fn reads_top_level_fields_only() {
        let d = doc();
        let poring = &d.entries[0];
        assert_eq!(poring.field("Id"), Some("1002"));
        assert_eq!(poring.field("AegisName"), Some("PORING"));
        assert_eq!(poring.field("Level"), Some("1"));
        // `Rate` exists in the file, nested under Drops. It is not a field of
        // the monster, and reading it as one would be the bug this guards.
        assert_eq!(poring.field("Rate"), None);
        assert_eq!(poring.field("Item"), None);
    }

    /// A prefix must not match a longer field name.
    #[test]
    fn field_names_match_whole() {
        let e = Entry {
            lines: vec!["  - Id: 5".into(), "    LevelUp: 3".into()],
        };
        assert_eq!(e.field("Level"), None);
        assert_eq!(e.field("LevelUp"), Some("3"));
    }

    #[test]
    fn set_field_replaces_or_adds() {
        let mut d = doc();
        let e = &mut d.entries[0];
        e.set_field("Level", "42");
        assert_eq!(e.field("Level"), Some("42"));
        e.set_field("Defense", "9");
        assert_eq!(e.field("Defense"), Some("9"));
        // The `- ` marker has to survive, or the entry stops being an entry.
        assert!(e.lines[0].starts_with("  - Id:"));
    }

    #[test]
    fn remove_field_takes_the_block_with_it() {
        let mut d = doc();
        let e = &mut d.entries[0];
        e.remove_field("Drops");
        let text = e.lines.join("\n");
        assert!(!text.contains("Jellopy"), "{text}");
        assert!(!text.contains("Drops"), "{text}");
        assert!(text.contains("Level: 1"), "{text}");
    }

    /// The reader refuses what it does not understand rather than guessing.
    #[test]
    fn a_different_shape_is_refused() {
        assert!(Document::parse(SAMPLE, "ITEM_DB").is_err());
        assert!(Document::parse("Header:\n  Type: MOB_DB\n", "MOB_DB").is_err());
        let footered = format!("{SAMPLE}Footer:\n  Imports:\n");
        assert!(Document::parse(&footered, "MOB_DB").is_err());
    }
}
