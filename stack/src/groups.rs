//! Several mods' command grants, made into one `groups.yml` rAthena will read.
//!
//! Combining the files is the easy half -- `mods::merge_tables` already does it
//! for `db/`. The hard half is that rAthena's `groups.yml` is the one table
//! where a repeated entry is not "the later one wins" but an error, and an
//! error that costs far more than the repeat:
//!
//! ```text
//! PlayerGroupDatabase::parseCommands (src/map/pc_groups.cpp)
//!   allowed && the group already has it  -> "Group already has command", return false
//!   !allowed && the group does not have it -> "Group does not have command", return false
//! ```
//!
//! and `parseBodyNode` returns 0 on that `false`, which throws away *the whole
//! node* -- every other command, permission and inheritance it listed. Two mods
//! that each give group 0 `@autoloot` would leave the second mod's grants not
//! in effect at all, with one warning in a log nobody reads. So before the
//! bodies are joined, each mod's copy has its repeats taken out, and each one
//! taken out is said.
//!
//! "Already has" counts what rAthena's own `conf/groups.yml` lists, because that
//! file is read before the import this becomes. It is inside the server image
//! rather than on the host, so the part that matters -- the commands each stock
//! group lists directly -- is carried here, generated from the pinned checkout
//! (`STOCK_GRANTS` below; `stock_tables_match_the_pinned_server` checks it).
//! Inheritance does not count: rAthena applies it after every file is read and
//! skips a command the child already has.

use std::collections::{BTreeMap, BTreeSet};

/// Who holds each command, per group, as the files are read in order.
pub struct Grants {
    /// `(group id, is CharCommands)` -> command -> where the grant came from.
    held: BTreeMap<(u32, bool), BTreeMap<String, String>>,
    /// Groups that exist so far. A node for a group that does not exist yet
    /// has to carry `Name` and `Level`, or rAthena refuses it -- and a refused
    /// node grants nothing, so its commands must not be counted as held.
    known: BTreeSet<u32>,
    /// Alias -> command. rAthena resolves an alias before it checks for a
    /// repeat, so `autolootitem` and `alootid` are the same grant.
    aliases: BTreeMap<String, String>,
}

impl Grants {
    /// What the server holds before any mod's file is read.
    pub fn stock() -> Grants {
        let mut held: BTreeMap<(u32, bool), BTreeMap<String, String>> = BTreeMap::new();
        let mut known = BTreeSet::new();
        for (id, char_commands, name) in STOCK_GRANTS {
            known.insert(*id);
            held.entry((*id, *char_commands))
                .or_default()
                .insert(name.to_string(), "rAthena's own groups.yml".to_string());
        }
        known.extend(STOCK_GROUPS.iter().copied());
        let aliases = STOCK_ALIASES.iter().map(|(a, c)| (a.to_string(), c.to_string())).collect();
        Grants { held, known, aliases }
    }

    /// Learn the aliases a mod's `atcommands.yml` defines, so a grant spelled
    /// with one of them is recognised as the command it names.
    pub fn learn_aliases(&mut self, atcommands: &str) {
        let mut command: Option<String> = None;
        let mut aliases_at: Option<usize> = None;
        for line in atcommands.lines() {
            let content = strip_comment(line.trim());
            if content.is_empty() {
                continue;
            }
            let indent = indent_of(line);
            if let Some(at) = aliases_at {
                if indent > at && content.starts_with('-') {
                    if let Some(cmd) = &command {
                        let alias = unquote(content[1..].trim()).to_ascii_lowercase();
                        if !alias.is_empty() {
                            self.aliases.insert(alias, cmd.clone());
                        }
                    }
                    continue;
                }
                aliases_at = None;
            }
            let item = content.strip_prefix('-').map(str::trim).unwrap_or(content);
            if let Some(value) = item.strip_prefix("Command:") {
                command = Some(unquote(value.trim()).to_ascii_lowercase());
            } else if item == "Aliases:" {
                aliases_at = Some(indent);
            }
        }
    }

    fn resolve(&self, name: &str) -> String {
        let lower = name.to_ascii_lowercase();
        self.aliases.get(&lower).cloned().unwrap_or(lower)
    }

    /// One file's `groups.yml` with every entry rAthena would reject as a
    /// repeat removed, and a sentence for each.
    ///
    /// Works on the text rather than a parsed tree, because the result is
    /// handed to rAthena as YAML and everything this does not understand --
    /// comments, flow style, a `Permissions` block -- has to come out exactly
    /// as it went in. A node whose `Id` cannot be read is left alone: rAthena
    /// will say what is wrong with it better than a guess here could.
    pub fn dedupe(&mut self, text: &str, owner: &str) -> (String, Vec<String>) {
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        let mut notes = Vec::new();
        let Some(body_at) = lines.iter().position(|l| bare(l) == "Body:") else {
            return (text.to_string(), notes);
        };
        // The body runs to the next key at column zero -- `Footer:`, usually.
        // A sequence may legally sit at column zero under its key, so a dash
        // there is still body.
        let body_end = lines[body_at + 1..]
            .iter()
            .position(|l| {
                let b = bare(l);
                !b.is_empty() && indent_of(b) == 0 && !b.starts_with('-') && !b.starts_with('#')
            })
            .map_or(lines.len(), |p| body_at + 1 + p);

        // Split the body into its sequence items.
        let item_indent = lines[body_at + 1..body_end]
            .iter()
            .find(|l| is_item_start(l))
            .map(|l| indent_of(l));
        let Some(item_indent) = item_indent else {
            return (text.to_string(), notes);
        };
        let mut starts: Vec<usize> = (body_at + 1..body_end)
            .filter(|&i| is_item_start(lines[i]) && indent_of(lines[i]) == item_indent)
            .collect();
        starts.push(body_end);

        let mut keep = vec![true; lines.len()];
        for pair in starts.windows(2) {
            self.dedupe_node(&lines, pair[0], pair[1], owner, &mut keep, &mut notes);
        }
        let out = lines.iter().zip(&keep).filter(|(_, k)| **k).map(|(l, _)| *l).collect();
        (out, notes)
    }

    fn dedupe_node(
        &mut self,
        lines: &[&str],
        start: usize,
        end: usize,
        owner: &str,
        keep: &mut [bool],
        notes: &mut Vec<String>,
    ) {
        // Where the item's keys sit: just past "- " on the dash line, or on the
        // next line when the dash stands alone.
        let first = lines[start];
        let after_dash = bare(&first[indent_of(first) + 1..]);
        let key_col = if after_dash.trim().is_empty() {
            match (start + 1..end).map(|i| lines[i]).find(|l| !strip_comment(l.trim()).is_empty()) {
                Some(line) => indent_of(line),
                None => return,
            }
        } else {
            indent_of(first) + 1 + (after_dash.len() - after_dash.trim_start().len())
        };

        // The keys of this node, with the line each one is on.
        let keys: Vec<(usize, &str, &str)> = (start..end)
            .filter_map(|i| {
                let content = if i == start {
                    strip_comment(first[indent_of(first) + 1..].trim())
                } else if indent_of(lines[i]) == key_col {
                    strip_comment(lines[i].trim())
                } else {
                    return None;
                };
                let (k, v) = content.split_once(':')?;
                Some((i, k.trim(), v.trim()))
            })
            .collect();
        let Some(id) = keys
            .iter()
            .find(|(_, k, _)| *k == "Id")
            .and_then(|(_, _, v)| unquote(v).parse::<u32>().ok())
        else {
            return;
        };
        if !self.known.contains(&id) {
            let has = |name: &str| keys.iter().any(|(_, k, _)| *k == name);
            if !(has("Name") && has("Level")) {
                return;
            }
            self.known.insert(id);
        }

        for (at, key, value) in &keys {
            let char_commands = match *key {
                "Commands" => false,
                "CharCommands" => true,
                _ => continue,
            };
            // `Commands: { autoloot: true }` is valid, and rare enough to leave
            // to rAthena rather than parse.
            if !value.is_empty() {
                continue;
            }
            let block_end = keys.iter().map(|(i, _, _)| *i).find(|i| i > at).unwrap_or(end);
            let mut listed = 0;
            let mut dropped = 0;
            for i in at + 1..block_end {
                let content = strip_comment(lines[i].trim());
                if content.is_empty() || indent_of(lines[i]) <= key_col {
                    continue;
                }
                let Some((name, allowed)) = content.split_once(':') else { continue };
                listed += 1;
                let written = unquote(name.trim());
                let command = self.resolve(written);
                let allowed = match allowed.trim().to_ascii_lowercase().as_str() {
                    "true" => true,
                    "false" => false,
                    // Not a boolean: rAthena names that error itself.
                    _ => continue,
                };
                let sigil = if char_commands { "#" } else { "@" };
                let spelled = if written.eq_ignore_ascii_case(&command) {
                    String::new()
                } else {
                    format!(" (as \"{written}\")")
                };
                let group = self.held.entry((id, char_commands)).or_default();
                match (allowed, group.get(&command)) {
                    (true, Some(holder)) => {
                        notes.push(format!(
                            "{owner} gives group {id} {sigil}{command}{spelled}, which {holder} already gives it -- \
                             left out, because rAthena throws away the rest of a group entry that repeats a command"
                        ));
                        keep[i] = false;
                        dropped += 1;
                    }
                    (true, None) => {
                        group.insert(command, owner.to_string());
                    }
                    (false, Some(_)) => {
                        group.remove(&command);
                    }
                    (false, None) => {
                        notes.push(format!(
                            "{owner} takes {sigil}{command}{spelled} away from group {id}, which does not have it -- \
                             left out, because rAthena throws away the rest of a group entry that does that"
                        ));
                        keep[i] = false;
                        dropped += 1;
                    }
                }
            }
            // A `Commands:` with nothing under it is a null, not an empty map;
            // take the key away too rather than hand rAthena that.
            if listed > 0 && dropped == listed {
                keep[*at] = false;
            }
        }
    }
}

fn bare(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r'])
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

fn is_item_start(line: &str) -> bool {
    let t = bare(line).trim_start();
    t == "-" || t.starts_with("- ")
}

/// A trailing `# comment`, which YAML only recognises after whitespace.
fn strip_comment(content: &str) -> &str {
    if content.starts_with('#') {
        return "";
    }
    match content.find(" #") {
        Some(at) => content[..at].trim_end(),
        None => content,
    }
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    for q in ['"', '\''] {
        if s.len() >= 2 && s.starts_with(q) && s.ends_with(q) {
            return &s[1..s.len() - 1];
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "Header:\n  Type: PLAYER_GROUP_DB\n  Version: 1\n\nBody:\n";

    #[test]
    fn a_command_rathena_already_gives_the_group_is_left_out_and_said() {
        let mut g = Grants::stock();
        let text = format!("{HEADER}  - Id: 0\n    Commands:\n      resurrect: true\n      autoloot: true\n");
        let (out, notes) = g.dedupe(&text, "my-mod");
        assert!(!out.contains("resurrect"), "{out}");
        assert!(out.contains("      autoloot: true\n"), "{out}");
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("my-mod gives group 0 @resurrect"), "{}", notes[0]);
        assert!(notes[0].contains("rAthena's own groups.yml"), "{}", notes[0]);
    }

    #[test]
    fn the_second_mod_to_grant_a_command_loses_only_that_line() {
        let mut g = Grants::stock();
        let first = format!("{HEADER}  - Id: 0\n    Commands:\n      autoloot: true\n");
        let second = format!("{HEADER}  - Id: 0\n    Commands:\n      autoloot: true\n      go: true\n");
        let (a, _) = g.dedupe(&first, "a");
        assert_eq!(a, first);
        let (b, notes) = g.dedupe(&second, "b");
        assert!(!b.contains("autoloot"), "{b}");
        assert!(b.contains("go: true"), "{b}");
        assert!(notes[0].contains("which a already gives it"), "{notes:?}");
    }

    /// rAthena resolves an alias before its repeat check, so this must too.
    #[test]
    fn an_alias_is_the_command_it_names() {
        let mut g = Grants::stock();
        // `accountinfo` is rAthena's own alias for `accinfo`.
        let (_, _) = g.dedupe(&format!("{HEADER}  - Id: 0\n    Commands:\n      accinfo: true\n"), "a");
        let (out, notes) = g.dedupe(&format!("{HEADER}  - Id: 0\n    Commands:\n      AccountInfo: true\n"), "b");
        assert!(!out.contains("AccountInfo"), "{out}");
        assert!(notes[0].contains("@accinfo (as \"AccountInfo\")"), "{notes:?}");
    }

    #[test]
    fn a_mod_s_own_alias_is_learned() {
        let mut g = Grants::stock();
        g.learn_aliases("Header:\n  Type: ATCOMMAND_DB\nBody:\n  - Command: go\n    Aliases:\n      - town\n");
        g.dedupe(&format!("{HEADER}  - Id: 0\n    Commands:\n      go: true\n"), "a");
        let (out, _) = g.dedupe(&format!("{HEADER}  - Id: 0\n    Commands:\n      town: true\n"), "b");
        assert!(!out.contains("town"), "{out}");
    }

    #[test]
    fn removing_a_command_the_group_lacks_is_left_out_and_removing_one_it_has_is_kept() {
        let mut g = Grants::stock();
        let text = format!("{HEADER}  - Id: 0\n    Commands:\n      changedress: false\n      go: false\n");
        let (out, notes) = g.dedupe(&text, "m");
        assert!(out.contains("changedress: false"), "{out}");
        assert!(!out.contains("go: false"), "{out}");
        assert_eq!(notes.len(), 1);
        // And once removed, granting it again is not a repeat.
        let (again, notes) = g.dedupe(&format!("{HEADER}  - Id: 0\n    Commands:\n      changedress: true\n"), "n");
        assert!(again.contains("changedress: true") && notes.is_empty(), "{again} {notes:?}");
    }

    /// An emptied `Commands:` would be a YAML null; the key goes with its last
    /// entry, and everything else in the node stays exactly as written.
    #[test]
    fn an_emptied_commands_block_loses_its_key_and_nothing_else() {
        let mut g = Grants::stock();
        let text = format!(
            "{HEADER}  - Id: 0\n    # keep me\n    Commands:\n      resurrect: true\n    Permissions:\n      can_trade: true\nFooter:\n  Imports:\n  - Path: x\n"
        );
        let (out, _) = g.dedupe(&text, "m");
        assert!(!out.contains("Commands:"), "{out}");
        assert!(out.contains("# keep me\n    Permissions:\n      can_trade: true\nFooter:\n  Imports:\n  - Path: x\n"), "{out}");
    }

    #[test]
    fn char_commands_are_tracked_apart_from_commands() {
        let mut g = Grants::stock();
        let text = format!("{HEADER}  - Id: 4\n    Commands:\n      item: true\n    CharCommands:\n      go: true\n");
        let (out, notes) = g.dedupe(&text, "m");
        assert!(!out.contains("      item: true"), "{out}");
        assert!(out.contains("CharCommands:\n      go: true"), "{out}");
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    /// A new group without Name and Level is refused by rAthena and grants
    /// nothing, so a later real grant of the same command is not a repeat.
    #[test]
    fn a_node_rathena_would_refuse_does_not_count_as_holding_anything() {
        let mut g = Grants::stock();
        g.dedupe(&format!("{HEADER}  - Id: 42\n    Commands:\n      go: true\n"), "a");
        let (out, notes) = g.dedupe(
            &format!("{HEADER}  - Id: 42\n    Name: Mine\n    Level: 1\n    Commands:\n      go: true\n"),
            "b",
        );
        assert!(out.contains("go: true") && notes.is_empty(), "{out} {notes:?}");
    }

    #[test]
    fn other_indentation_styles_and_quoting_are_read() {
        let mut g = Grants::stock();
        let text = "Header:\n    Type: PLAYER_GROUP_DB\nBody:\n-   Id: \"0\"\n    Commands:\n        \"resurrect\": true   # dup\n        go: true\n";
        let (out, notes) = g.dedupe(text, "m");
        assert!(!out.contains("resurrect") && out.contains("go: true"), "{out}");
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn a_file_with_no_body_or_no_ids_is_returned_untouched() {
        let mut g = Grants::stock();
        for text in ["Header:\n  Type: PLAYER_GROUP_DB\n", "Header:\n  Type: PLAYER_GROUP_DB\nBody:\n  - Id: x\n    Commands:\n      resurrect: true\n"] {
            let (out, notes) = g.dedupe(text, "m");
            assert_eq!(out, text);
            assert!(notes.is_empty());
        }
    }

    /// The tables above are generated from the pinned rAthena. When that
    /// checkout is present, prove they still describe it; CI's supervisor job
    /// does not fetch it, so there this has nothing to compare against.
    #[test]
    fn stock_tables_match_the_pinned_server() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/rathena/conf");
        let (Ok(groups), Ok(atcommands)) = (
            std::fs::read_to_string(root.join("groups.yml")),
            std::fs::read_to_string(root.join("atcommands.yml")),
        ) else {
            eprintln!("vendor/rathena not checked out; skipping");
            return;
        };
        // Every stock grant, read back through the same dedupe: an exact
        // restatement of the stock file must be entirely repeats.
        let mut g = Grants::stock();
        // Fewer notes than table rows means the table lists a grant the file
        // does not; a grant missing from the table is no repeat, so it shows
        // up as the same shortfall from the other side.
        let (_, notes) = g.dedupe(&groups, "stock");
        assert!(notes.iter().all(|n| n.contains("rAthena's own groups.yml")), "{notes:?}");
        assert_eq!(notes.len(), STOCK_GRANTS.len(), "STOCK_GRANTS no longer matches the pinned groups.yml");
        let mut fresh = Grants { held: BTreeMap::new(), known: STOCK_GROUPS.iter().copied().collect(), aliases: BTreeMap::new() };
        let (_, none) = fresh.dedupe(&groups, "stock");
        assert!(none.is_empty(), "the pinned groups.yml repeats itself: {none:?}");
        let held: usize = fresh.held.values().map(BTreeMap::len).sum();
        assert_eq!(held, STOCK_GRANTS.len(), "STOCK_GRANTS no longer matches the pinned groups.yml");
        let mut learned = Grants { held: BTreeMap::new(), known: BTreeSet::new(), aliases: BTreeMap::new() };
        learned.learn_aliases(&atcommands);
        let stock: BTreeMap<String, String> =
            STOCK_ALIASES.iter().map(|(a, c)| (a.to_string(), c.to_string())).collect();
        assert_eq!(learned.aliases, stock, "STOCK_ALIASES differs from the pinned atcommands.yml");
    }
}

// ---------------------------------------------------------------------------
// Generated from the pinned vendor/rathena conf/groups.yml and
// conf/atcommands.yml. Regenerate when the rAthena pin moves.
// ---------------------------------------------------------------------------

/// Every group the stock file defines, including ones that list no commands.
const STOCK_GROUPS: &[u32] = &[0, 1, 2, 3, 4, 5, 10, 99];

const STOCK_GRANTS: &[(u32, bool, &str)] = &[
    (0, false, "changedress"),
    (0, false, "resurrect"),
    (1, false, "commands"),
    (1, false, "charcommands"),
    (1, false, "help"),
    (1, false, "rates"),
    (1, false, "uptime"),
    (1, false, "showdelay"),
    (1, false, "exp"),
    (1, false, "mobinfo"),
    (1, false, "iteminfo"),
    (1, false, "whodrops"),
    (1, false, "servertime"),
    (1, false, "jailtime"),
    (1, false, "hominfo"),
    (1, false, "homstats"),
    (1, false, "showexp"),
    (1, false, "showzeny"),
    (1, false, "whereis"),
    (1, false, "refresh"),
    (1, false, "noask"),
    (1, false, "noks"),
    (1, false, "autoloot"),
    (1, false, "alootid"),
    (1, false, "autoloottype"),
    (1, false, "autotrade"),
    (1, false, "request"),
    (1, false, "go"),
    (1, false, "breakguild"),
    (1, false, "channel"),
    (1, false, "langtype"),
    (2, false, "version"),
    (2, false, "where"),
    (2, false, "jumpto"),
    (2, false, "who"),
    (2, false, "who2"),
    (2, false, "who3"),
    (2, false, "whomap"),
    (2, false, "whomap2"),
    (2, false, "whomap3"),
    (2, false, "users"),
    (2, false, "broadcast"),
    (2, false, "localbroadcast"),
    (3, false, "tonpc"),
    (3, false, "hidenpc"),
    (3, false, "shownpc"),
    (3, false, "loadnpc"),
    (3, false, "unloadnpc"),
    (3, false, "npcmove"),
    (3, false, "addwarp"),
    (4, false, "monster"),
    (4, false, "monstersmall"),
    (4, false, "monsterbig"),
    (4, false, "killmonster2"),
    (4, false, "cleanarea"),
    (4, false, "cleanmap"),
    (4, false, "item"),
    (4, false, "zeny"),
    (4, false, "disguise"),
    (4, false, "undisguise"),
    (4, false, "size"),
    (4, false, "raise"),
    (4, false, "raisemap"),
    (4, false, "day"),
    (4, false, "night"),
    (4, false, "skillon"),
    (4, false, "skilloff"),
    (4, false, "pvpon"),
    (4, false, "pvpoff"),
    (4, false, "gvgon"),
    (4, false, "gvgoff"),
    (4, false, "allowks"),
    (4, false, "me"),
    (4, false, "marry"),
    (4, false, "divorce"),
    (4, false, "refreshall"),
    (4, true, "item"),
    (4, true, "zeny"),
    (4, true, "disguise"),
    (4, true, "undisguise"),
    (4, true, "size"),
    (5, false, "rates"),
    (5, false, "who"),
    (10, false, "hide"),
    (10, false, "follow"),
    (10, false, "kick"),
    (10, false, "disguise"),
    (10, false, "fakename"),
    (10, false, "option"),
    (10, false, "speed"),
    (10, false, "mapmove"),
    (10, false, "kill"),
    (10, false, "recall"),
    (10, false, "ban"),
    (10, false, "block"),
    (10, false, "jail"),
    (10, false, "jailfor"),
    (10, false, "mute"),
    (10, false, "storagelist"),
    (10, false, "cartlist"),
    (10, false, "itemlist"),
    (10, false, "stats"),
];

const STOCK_ALIASES: &[(&str, &str)] = &[
    ("accountinfo", "accinfo"),
    ("famepoint", "addfame"),
    ("famepoints", "addfame"),
    ("allskills", "allskill"),
    ("skillall", "allskill"),
    ("skillsall", "allskill"),
    ("alootid", "autolootitem"),
    ("aloottype", "autoloottype"),
    ("at", "autotrade"),
    ("banish", "ban"),
    ("baselevel", "baselevelup"),
    ("baselvl", "baselevelup"),
    ("baselvup", "baselevelup"),
    ("baselvlup", "baselevelup"),
    ("blevel", "baselevelup"),
    ("blvl", "baselevelup"),
    ("lvup", "baselevelup"),
    ("viewpointvalue", "camerainfo"),
    ("setcamera", "camerainfo"),
    ("nocosplay", "changedress"),
    ("main", "channel"),
    ("charban", "char_ban"),
    ("block", "char_block"),
    ("charunban", "char_unban"),
    ("unblock", "char_unblock"),
    ("cleararea", "cleanarea"),
    ("clearmap", "cleanmap"),
    ("eqclone", "cloneequip"),
    ("stclone", "clonestat"),
    ("ccolor", "dye"),
    ("glevel", "guildlevelup"),
    ("glvl", "guildlevelup"),
    ("guildlevel", "guildlevelup"),
    ("guildlvl", "guildlevelup"),
    ("guildlvlup", "guildlevelup"),
    ("guildlvup", "guildlevelup"),
    ("gstorage", "guildstorage"),
    ("gpvpoff", "gvgoff"),
    ("gpvpon", "gvgon"),
    ("haircolor", "hair_color"),
    ("hcolor", "hair_color"),
    ("hairstyle", "hair_style"),
    ("hstyle", "hair_style"),
    ("h", "help"),
    ("homevolve", "homevolution"),
    ("hlvl", "homlevel"),
    ("hlevel", "homlevel"),
    ("homlvl", "homlevel"),
    ("homlvup", "homlevel"),
    ("ii", "iteminfo"),
    ("inventorylist", "itemlist"),
    ("clearinventory", "itemreset"),
    ("job", "jobchange"),
    ("jlevel", "joblevelup"),
    ("jlvl", "joblevelup"),
    ("joblevel", "joblevelup"),
    ("joblvl", "joblevelup"),
    ("joblvlup", "joblevelup"),
    ("joblvup", "joblevelup"),
    ("goto", "jumpto"),
    ("warpto", "jumpto"),
    ("die", "kill"),
    ("noks", "ksprotection"),
    ("return", "load"),
    ("rura", "mapmove"),
    ("warp", "mapmove"),
    ("monsterinfo", "mobinfo"),
    ("mi", "mobinfo"),
    ("spawn", "monster"),
    ("battleignore", "monsterignore"),
    ("mount", "mount_peco"),
    ("mountpeco", "mount_peco"),
    ("stfu", "mutearea"),
    ("npctalkc", "npctalk"),
    ("revive", "raise"),
    ("reloadcashshop", "reloadcashdb"),
    ("reloadnpc", "reloadnpcfile"),
    ("resetcooldown", "resetcooltime"),
    ("skreset", "resetskill"),
    ("streset", "resetstat"),
    ("date", "servertime"),
    ("serverdate", "servertime"),
    ("time", "servertime"),
    ("skpoint", "skillpoint"),
    ("allstat", "stat_all"),
    ("allstats", "stat_all"),
    ("statall", "stat_all"),
    ("statsall", "stat_all"),
    ("stpoint", "statuspoint"),
    ("alltrait", "trait_all"),
    ("alltraits", "trait_all"),
    ("traitall", "trait_all"),
    ("traitsall", "trait_all"),
    ("trpoint", "traitpoint"),
    ("unbanish", "unban"),
    ("discharge", "unjail"),
    ("whois", "who"),
];
