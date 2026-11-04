//! Navigation routes over the server's own warp portals: the
//! `navigation-server-warps` mod.
//!
//! The navigation window routes between maps over the link table in the
//! player's GRF (`navi_link_krpri.lub`). Its portals (type 200) are kRO's: a
//! pre-renewal town's are where kRO's renewal town has them, and a mod's map
//! has none. With the mod on, the server's portals -- the `warp` and `warp2`
//! lines of the scripts the map server loads -- are written to
//! `navi_link_server.lub`, and the client's navigation patch puts them in
//! place of the GRF's portals. The GRF's other links are kept: sailors,
//! signposts and airship steps are scripts that warp when spoken to, which
//! cannot be read the way a portal can.
//!
//! As for NPCs and monsters, the stock scripts are indexed when the rAthena
//! pin moves (`warp-index.tsv`, by `ragnarok-stack navigation-warp-index`),
//! and mods are read at link time. A portal switched off when the server
//! starts -- `disablenpc "prt001"` under `OnInit`, the way MODDING.md reroutes
//! a gate -- is taken out too, unless some script switches it back on: one
//! that does is a gate opened by an event or a quest, so it is left routed.

use crate::config::Config;
use crate::navnpc::{collect_txt, instance_map, load_order, script_lines};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

/// The mod this builds the table for.
pub const MOD: &str = "navigation-server-warps";
/// Its stock index, in the mod's folder.
pub const INDEX: &str = "warp-index.tsv";
/// Where the client's navigation patch looks for it.
pub const TABLE: &str = "data/luafiles514/lua files/navigation/navi_link_server.lub";
/// Ids for the server's portals, clear of kRO's (which are five digits), so
/// one can never be taken for a link the GRF's distance table describes.
const FIRST_ID: usize = 1_000_000;

/// One portal: step on it at `map,x,y` and arrive at `dest,dx,dy`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Warp {
    pub map: String,
    pub x: u32,
    pub y: u32,
    /// The name `disablenpc` finds it by.
    pub name: String,
    pub dest: String,
    pub dx: u32,
    pub dy: u32,
}

fn valid_map(map: &str) -> bool {
    !map.is_empty()
        && map != "-"
        && map.bytes().all(|b| b.is_ascii_alphanumeric() || b"_@-.".contains(&b))
        && !instance_map(map)
}

/// A number as `sscanf`'s `%hd` reads one: leading whitespace skipped, and
/// whatever follows the digits (a trailing comment) ignored.
fn number(field: &str) -> Option<u32> {
    let field = field.trim_start();
    field[..field.find(|c: char| !c.is_ascii_digit()).unwrap_or(field.len())].parse().ok()
}

/// The portals in a script:
/// `map,x,y,facing<TAB>warp|warp2<TAB>name<TAB>spanx,spany,dest,dx,dy`.
/// Instance maps, at either end, are left out.
pub fn parse_warps(text: &[u8]) -> Vec<Warp> {
    script_lines(text)
        .into_iter()
        .filter_map(|line| {
            let line = std::str::from_utf8(line).ok()?;
            // The fourth field runs to the end of the line, tabs and all, as
            // npc_parsesrcfile cuts it: a stock portal has an extra tab there.
            let mut fields = line.splitn(4, '\t');
            let place = fields.next()?;
            let kind = fields.next()?;
            let name = fields.next()?;
            let rest = fields.next()?;
            if kind != "warp" && kind != "warp2" {
                return None;
            }
            let mut at = place.split(',');
            let map = at.next()?.trim();
            let x = at.next()?.trim().parse().ok()?;
            let y = at.next()?.trim().parse().ok()?;
            let mut to = rest.split(',');
            to.next()?;
            to.next()?;
            let dest = to.next()?.trim();
            let dx = number(to.next()?)?;
            let dy = number(to.next()?)?;
            if !valid_map(map) || !valid_map(dest) {
                return None;
            }
            // `shown#unique::label`: disablenpc takes the label when there is one.
            let name = name.rsplit("::").next().unwrap_or(name).trim().to_string();
            Some(Warp { map: map.to_string(), x, y, name, dest: dest.to_string(), dx, dy })
        })
        .collect()
}

/// What a script does to NPCs by name, as far as routing cares: `off`, the
/// names it switches off under `OnInit` (so they start closed), and `on`, the
/// names it switches on anywhere. Only literal names count, and comments are
/// skipped.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Gates {
    pub off: Vec<String>,
    pub on: Vec<String>,
}

impl Gates {
    pub fn is_empty(&self) -> bool {
        self.off.is_empty() && self.on.is_empty()
    }
}

/// The script with its comments blanked out, strings kept.
fn without_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let (mut in_string, mut in_block) = (false, false);
    while let Some(c) = chars.next() {
        if in_block {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block = false;
            } else if c == '\n' {
                out.push(c);
            }
        } else if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' || c == '\n' {
                in_string = false;
            }
        } else if c == '/' && chars.peek() == Some(&'/') {
            while chars.peek().is_some_and(|n| *n != '\n') {
                chars.next();
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            in_block = true;
        } else {
            in_string = c == '"';
            out.push(c);
        }
    }
    out
}

/// The literal name after a command, `cmd "name"` or `cmd("name")`.
fn quoted_name(after: &str) -> Option<String> {
    let after = after.trim_start_matches([' ', '\t', '(']);
    let quoted = after.strip_prefix('"')?;
    Some(quoted[..quoted.find('"')?].to_string())
}

/// A label on a line of its own, `OnInit:`.
fn label(line: &str) -> Option<&str> {
    let l = line.trim().strip_suffix(':')?;
    (!l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')).then_some(l)
}

pub fn gates(text: &[u8]) -> Gates {
    let text = without_comments(&String::from_utf8_lossy(text));
    let mut gates = Gates::default();
    let mut at_init = false;
    for line in text.lines() {
        if let Some(l) = label(line) {
            at_init = l == "OnInit";
            continue;
        }
        // A new object, or the end of one, ends the label.
        let header = !line.starts_with([' ', '\t']) && line.split('\t').count() >= 3;
        if header || line.trim_start().starts_with('}') {
            at_init = false;
        }
        for (cmd, list, counts) in [("disablenpc", &mut gates.off, at_init), ("enablenpc", &mut gates.on, true)] {
            let mut rest = line;
            while let Some(at) = rest.find(cmd) {
                let before = rest[..at].chars().next_back();
                rest = &rest[at + cmd.len()..];
                if counts && !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                    if let Some(name) = quoted_name(rest) {
                        list.push(name);
                    }
                }
            }
        }
    }
    for list in [&mut gates.off, &mut gates.on] {
        list.sort();
        list.dedup();
    }
    gates
}

/// The names that start closed and nothing opens: switched off under some
/// script's `OnInit`, and switched on by none.
pub fn closed(all: &[&Gates]) -> HashSet<String> {
    let on: HashSet<&String> = all.iter().flat_map(|g| &g.on).collect();
    all.iter().flat_map(|g| &g.off).filter(|n| !on.contains(n)).cloned().collect()
}

/// The stock index: each era's load order, and the portals in every script.
#[derive(Default)]
pub struct Index {
    pub renewal: Vec<String>,
    pub prerenewal: Vec<String>,
    pub files: BTreeMap<String, Vec<Warp>>,
    /// What each script switches off and on, for the scripts that do.
    pub gates: BTreeMap<String, Gates>,
}

/// Build it from a rAthena checkout with the app's server mods applied.
pub fn build_index(rathena: &Path) -> Result<Index, String> {
    let mut index = Index {
        renewal: load_order(rathena, "npc/re/scripts_main.conf"),
        prerenewal: load_order(rathena, "npc/pre-re/scripts_main.conf"),
        ..Index::default()
    };
    if index.renewal.is_empty() {
        return Err("no scripts in npc/re/scripts_main.conf".into());
    }
    let mut scripts = Vec::new();
    collect_txt(&rathena.join("npc"), "npc", &mut scripts);
    for rel in scripts {
        let text = fs::read(rathena.join(&rel)).map_err(|e| format!("reading {rel}: {e}"))?;
        let warps = parse_warps(&text);
        let script_gates = gates(&text);
        if !script_gates.is_empty() {
            index.gates.insert(rel.clone(), script_gates);
        }
        if !warps.is_empty() {
            index.files.insert(rel, warps);
        }
    }
    Ok(index)
}

impl Index {
    pub fn to_text(&self) -> String {
        let mut s = String::from(
            "# The warp portals the pinned rAthena's scripts place, for the\n\
             # navigation-server-warps mod. Generated by scripts/navigation-index.sh;\n\
             # regenerate when the rAthena pin moves.\n\
             #\n\
             #   load  <era> <script>        the era's default load order\n\
             #   file  <script>\n\
             #   warp  <map> <x> <y> <name> <dest> <dx> <dy>\n\
             #   off   <name>                switched off under OnInit\n\
             #   on    <name>                switched on\n",
        );
        for (era, list) in [("renewal", &self.renewal), ("prerenewal", &self.prerenewal)] {
            for p in list {
                s.push_str(&format!("load\t{era}\t{p}\n"));
            }
        }
        let none = Gates::default();
        let files: std::collections::BTreeSet<&String> = self.files.keys().chain(self.gates.keys()).collect();
        for file in files {
            s.push_str(&format!("file\t{file}\n"));
            for w in self.files.get(file).map(Vec::as_slice).unwrap_or_default() {
                s.push_str(&format!("warp\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n", w.map, w.x, w.y, w.name, w.dest, w.dx, w.dy));
            }
            let g = self.gates.get(file).unwrap_or(&none);
            for (kind, names) in [("off", &g.off), ("on", &g.on)] {
                for n in names {
                    s.push_str(&format!("{kind}\t{n}\n"));
                }
            }
        }
        s
    }

    pub fn from_text(text: &str) -> Index {
        let mut index = Index::default();
        let mut file: Option<String> = None;
        for line in text.lines() {
            let cols: Vec<&str> = line.split('\t').collect();
            match cols.as_slice() {
                ["load", "renewal", p] => index.renewal.push(p.to_string()),
                ["load", "prerenewal", p] => index.prerenewal.push(p.to_string()),
                ["file", p] => file = Some(p.to_string()),
                [kind @ ("off" | "on"), name] => {
                    let Some(f) = &file else { continue };
                    let g = index.gates.entry(f.clone()).or_default();
                    if *kind == "off" { &mut g.off } else { &mut g.on }.push(name.to_string());
                }
                ["warp", map, x, y, name, dest, dx, dy] => {
                    let (Some(f), Ok(x), Ok(y), Ok(dx), Ok(dy)) = (&file, x.parse(), y.parse(), dx.parse(), dy.parse()) else {
                        continue;
                    };
                    index.files.entry(f.clone()).or_default().push(Warp {
                        map: map.to_string(),
                        x,
                        y,
                        name: name.to_string(),
                        dest: dest.to_string(),
                        dx,
                        dy,
                    });
                }
                _ => {}
            }
        }
        index
    }
}

/// The table as kRO's link rows are laid out, every row a portal (type 200):
/// `{ map, id, 200, 99999, name, "", x, y, dest, dx, dy }`. A portal that
/// starts closed is left out, and one listed twice is listed once.
pub fn table_lua(warps: &[Warp], disabled: &HashSet<String>) -> Vec<u8> {
    let mut seen = HashSet::new();
    let mut out = b"-- Built by Ragnarok Offline from the server's own warps (navigation-server-warps).\nNavi_Link_Server = {\n".to_vec();
    let mut n = 0;
    for w in warps {
        if disabled.contains(&w.name) || !seen.insert((w.map.clone(), w.x, w.y, w.dest.clone(), w.dx, w.dy)) {
            continue;
        }
        let name: String = w.name.chars().filter(|c| *c != '"' && *c != '\\' && !c.is_control()).collect();
        out.extend_from_slice(
            format!(
                "\t{{ \"{}\", {}, 200, 99999, \"{name}\", \"\", {}, {}, \"{}\", {}, {} }},\n",
                w.map, FIRST_ID + n, w.x, w.y, w.dest, w.dx, w.dy
            )
            .as_bytes(),
        );
        n += 1;
    }
    out.extend_from_slice(b"}\n");
    out
}

/// What is staged while the mod is off. The client asks for the table on
/// every load, and an empty one changes nothing; a missing one would be a 404
/// in missing-files.log each time, the log people read to find a real miss.
const EMPTY: &[u8] = b"Navi_Link_Server = {}\n";

fn write_table(server_root: &Path, table: &[u8]) -> Result<(), String> {
    let path = server_root.join(TABLE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, table).map_err(|e| format!("writing {}: {e}", path.display()))
}

/// Write the table into the staged assets when the mod is on: the era's stock
/// scripts, the stock scripts mods switch on and the scripts mods ship.
/// Returns the table written, for the cache fingerprint; with the mod off, an
/// empty table is staged and nothing is returned.
pub fn stage(cfg: &Config, server_root: &Path) -> Result<Option<Vec<u8>>, String> {
    let enabled = crate::mods::enabled(cfg);
    let Some(this) = enabled.iter().find(|m| m.name == MOD) else {
        write_table(server_root, EMPTY)?;
        return Ok(None);
    };
    let Some(text) = this.roots.iter().find_map(|r| fs::read_to_string(r.join(INDEX)).ok()) else {
        eprintln!("{MOD}: no {INDEX}; the client keeps its own routes");
        write_table(server_root, EMPTY)?;
        return Ok(None);
    };
    let index = Index::from_text(&text);
    let mut stock = if crate::cmds::is_prerenewal(cfg) { index.prerenewal.clone() } else { index.renewal.clone() };
    let mut warps = Vec::new();
    let mut mod_gates = Vec::new();
    let mut mod_warps = Vec::new();
    let mut removed = Vec::new();
    for m in &enabled {
        let sources = crate::mods::npc_sources(cfg, m)?;
        removed.extend(sources.removed);
        for p in sources.stock {
            if !stock.contains(&p) {
                stock.push(p);
            }
        }
        for f in sources.files {
            let text = fs::read(&f).map_err(|e| format!("reading {}: {e}", f.display()))?;
            mod_gates.push(gates(&text));
            mod_warps.extend(parse_warps(&text));
        }
    }
    // A script one mod removes is gone whichever mod loaded it.
    stock.retain(|p| !removed.contains(p));
    for f in &stock {
        warps.extend(index.files.get(f).cloned().unwrap_or_default());
    }
    warps.extend(mod_warps);
    let mut all: Vec<&Gates> = stock.iter().filter_map(|f| index.gates.get(f)).collect();
    all.extend(&mod_gates);
    let disabled = closed(&all);
    let table = table_lua(&warps, &disabled);
    write_table(server_root, &table)?;
    println!("{MOD}: {} warps", warps.len());
    Ok(Some(table))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portals_are_read_as_the_map_server_places_them() {
        let script = b"prontera,107,215,0\twarp\tprt01\t2,2,prt_in,240,139\n\
            ra_san01,139,139,0\twarp2\tsanctuary15\t1,1,ra_temin,27,314\n\
            prontera,1,1,0\twarp\tShown#x::prt_gate\t1,1,prt_fild08,5,6\n\
            1@tower,1,1,0\twarp\tinside\t1,1,1@tower,2,2\n\
            prontera,1,1,0\twarp\tto instance\t1,1,1@tower,2,2\n\
            lhz_in03,12,162,0\twarp\t#to_lhz\t\t1,1,lighthalzen,321,322\n\
            izlude,1,1,0\twarp\tcommented_end\t1,1,prontera,7,8 // the arena\n\
            prontera,1,1,0\tscript\tNot a warp\t112,{\n\
            /* prontera,9,9,0\twarp\tcommented\t1,1,izlude,1,1 */\n";
        let warps = parse_warps(script);
        let got: Vec<_> = warps.iter().map(|w| (w.map.as_str(), w.x, w.y, w.name.as_str(), w.dest.as_str(), w.dx, w.dy)).collect();
        assert_eq!(got, [
            ("prontera", 107, 215, "prt01", "prt_in", 240, 139),
            ("ra_san01", 139, 139, "sanctuary15", "ra_temin", 27, 314),
            ("prontera", 1, 1, "prt_gate", "prt_fild08", 5, 6),
            ("lhz_in03", 12, 162, "#to_lhz", "lighthalzen", 321, 322),
            ("izlude", 1, 1, "commented_end", "prontera", 7, 8),
        ]);
    }

    /// MODDING.md's way of rerouting a gate: switch the stock one off by name
    /// and put another in its place. Only the new one may be routed over.
    #[test]
    fn a_portal_a_mod_switches_off_is_not_routed_over() {
        let modded = b"-\tscript\tmy_retheme\t-1,{\n\tend;\nOnInit:\n\tdisablenpc \"prt001\";\n\tdisablenpc(\"prt002\");\n\tend;\n}\n\
            prontera,156,22,0\twarp\tmy_gate\t3,2,my_isle,40,40\n";
        let g = gates(modded);
        assert_eq!(g.off, ["prt001", "prt002"]);
        let mut warps = vec![
            Warp { map: "prontera".into(), x: 156, y: 22, name: "prt001".into(), dest: "prt_fild08".into(), dx: 1, dy: 1 },
            Warp { map: "prontera".into(), x: 156, y: 22, name: "prt001".into(), dest: "prt_fild08".into(), dx: 1, dy: 1 },
            Warp { map: "prontera".into(), x: 10, y: 10, name: "prt003".into(), dest: "izlude".into(), dx: 2, dy: 2 },
        ];
        warps.extend(parse_warps(modded));
        let disabled = closed(&[&g]);
        let lua = String::from_utf8(table_lua(&warps, &disabled)).unwrap();
        assert!(!lua.contains("prt001"), "{lua}");
        assert!(lua.contains("\t{ \"prontera\", 1000000, 200, 99999, \"prt003\", \"\", 10, 10, \"izlude\", 2, 2 },\n"), "{lua}");
        assert!(lua.contains("\t{ \"prontera\", 1000001, 200, 99999, \"my_gate\", \"\", 156, 22, \"my_isle\", 40, 40 },\n"), "{lua}");
        assert!(lua.starts_with("--") && lua.contains("Navi_Link_Server = {\n"));
    }

    /// Only a portal closed from the start stays closed: one switched off in a
    /// comment, under another label or by an event that switches it back on is
    /// open some of the time, so it is routed over.
    #[test]
    fn only_a_portal_closed_from_the_start_is_left_out() {
        let event = b"-\tscript\tgates\t-1,{\n\
            \tdisablenpc \"clicked\";\n\
            \tend;\n\
            OnInit:\n\
            \t// disablenpc \"commented\";\n\
            \t/* disablenpc \"blocked\"; */\n\
            \tmes \"// not a comment\"; disablenpc \"shut\";\n\
            \tdisablenpc \"event\";\n\
            \tend;\n\
            OnClock0000:\n\
            \tdisablenpc \"timed\";\n\
            \tenablenpc \"event\";\n\
            \tend;\n\
            }\n\
            -\tscript\tafter\t-1,{\n\
            \tdisablenpc \"next_object\";\n\
            }\n";
        let g = gates(event);
        assert_eq!(g.off, ["event", "shut"]);
        assert_eq!(g.on, ["event"]);
        assert_eq!(closed(&[&g]), HashSet::from(["shut".to_string()]));
        // A mod that opens a stock gate opens it.
        let stock = Gates { off: vec!["prt001".into()], on: vec![] };
        let opener = Gates { off: vec![], on: vec!["prt001".into()] };
        assert!(closed(&[&stock]).contains("prt001"));
        assert!(closed(&[&stock, &opener]).is_empty());
    }

    #[test]
    fn the_index_reads_back_what_it_wrote() {
        let mut index = Index { renewal: vec!["npc/a.txt".into()], prerenewal: vec!["npc/b.txt".into()], ..Index::default() };
        index.files.insert("npc/a.txt".into(), vec![
            Warp { map: "prontera".into(), x: 1, y: 2, name: "prt01".into(), dest: "prt_in".into(), dx: 3, dy: 4 },
        ]);
        index.gates.insert("npc/a.txt".into(), Gates { off: vec!["prt01".into()], on: vec![] });
        index.gates.insert("npc/c.txt".into(), Gates { off: vec![], on: vec!["prt01".into()] });
        let back = Index::from_text(&index.to_text());
        assert_eq!(back.renewal, index.renewal);
        assert_eq!(back.prerenewal, index.prerenewal);
        assert_eq!(back.files, index.files);
        assert_eq!(back.gates, index.gates);
    }

    /// As for NPCs and monsters: against a server-modded rAthena at the pin.
    #[test]
    fn the_shipped_index_matches_the_pinned_server() {
        let app = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let rathena = app.join("vendor/rathena");
        let pins = fs::read_to_string(app.join("config/VENDOR_PINS")).unwrap_or_default();
        let pin = pins.lines().find_map(|l| {
            let cols: Vec<_> = l.split_whitespace().collect();
            (cols.first() == Some(&"rathena")).then(|| cols.get(2).map(|s| s.to_string())).flatten()
        });
        let head = std::process::Command::new("git").arg("-C").arg(&rathena).args(["rev-parse", "HEAD"]).output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        if !rathena.join(".ragnarokmac-server-mods").exists() || pin.is_none() || head != pin {
            // CI's server-language job sets this, having made that checkout.
            assert!(std::env::var_os("REQUIRE_PINNED_RATHENA").is_none(), "vendor/rathena is not the pin with server mods applied");
            eprintln!("no server-modded rAthena at the pin in vendor/rathena; skipping");
            return;
        }
        let shipped = fs::read_to_string(app.join("mods").join(MOD).join(INDEX)).unwrap();
        let fresh = build_index(&rathena).unwrap().to_text();
        assert!(shipped == fresh, "mods/{MOD}/{INDEX} is stale: run scripts/navigation-index.sh");
    }
}
