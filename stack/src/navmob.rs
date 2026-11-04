//! Navigation monsters from the server's own spawns: the
//! `navigation-server-monsters` mod.
//!
//! The navigation search lists monsters from the player's GRF
//! (`navi_mob_krpri.lub`): kRO's spawns, with kRO's levels and elements. This
//! server spawns what rAthena's scripts say, with the stats in its mob_db, and
//! mods add monsters, move them and change what they are. With the mod on, the
//! table is built from those instead -- the same scripts navnpc.rs reads for
//! NPCs, their `monster` and `boss_monster` lines, and the mob_db the server
//! loads, mods' `db/mob_db.yml` merged over it field by field as rAthena's
//! import does.
//!
//! As with NPCs, the stock scripts and tables are in the server image, so they
//! are indexed when the rAthena pin moves (`mob-index.tsv`, written by
//! `ragnarok-stack navigation-mob-index <rathena>`); mods are read at link time.

use crate::config::Config;
use crate::navnpc::{collect_txt, escape, instance_map, load_order, script_lines, unescape};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

/// The mod this builds the table for.
pub const MOD: &str = "navigation-server-monsters";
/// Its stock index, in the mod's folder.
pub const INDEX: &str = "mob-index.tsv";
/// Where the client reads the table.
pub const TABLE: &str = "data/luafiles514/lua files/navigation/navi_mob_krpri.lub";

/// One monster as mob_db describes it, as far as the navigation window shows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Mob {
    pub aegis: String,
    pub name: Vec<u8>,
    pub level: u32,
    pub race: String,
    pub size: String,
    pub element: String,
    pub element_level: u32,
    pub mvp: bool,
}

/// One spawn line: so many of a monster, somewhere on a map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spawn {
    pub map: String,
    /// The monster as the line names it: an id, or rarely an AegisName.
    pub mob: String,
    pub amount: u32,
    /// The name it shows, which the map server takes from the line
    /// (`override_mob_names: 0`): `Aged Hydra` is a Hydra by this name.
    /// Empty for `--en--` and `--ja--`, which mean mob_db's.
    pub name: Vec<u8>,
    /// A level the line gives it (`name,level`), over mob_db's.
    pub level: Option<u32>,
}

/// The name field as rAthena reads it: up to 23 bytes before a comma, then
/// an optional level (`sscanf("%23[^,],%11d")`).
fn spawn_name(field: &[u8]) -> (Vec<u8>, Option<u32>) {
    let (name, level) = match field.iter().position(|b| *b == b',') {
        Some(i) => (&field[..i], std::str::from_utf8(&field[i + 1..]).ok().and_then(|l| l.trim().parse().ok())),
        None => (field, None),
    };
    let name = &name[..name.len().min(23)];
    let name = if name == b"--en--" || name == b"--ja--" { Vec::new() } else { name.to_vec() };
    (name, level.filter(|l| *l > 0))
}

/// The spawn lines in a script:
/// `map,x,y[,xs,ys]<TAB>monster|boss_monster<TAB>name<TAB>id,amount,...`.
/// Instance maps are left out, as for NPCs.
pub fn parse_spawns(text: &[u8]) -> Vec<Spawn> {
    script_lines(text)
        .into_iter()
        .filter_map(|line| {
            let mut fields = line.split(|b| *b == b'\t');
            let place = std::str::from_utf8(fields.next()?).ok()?;
            let kind = std::str::from_utf8(fields.next()?).ok()?;
            let (name, level) = spawn_name(fields.next()?);
            let rest = std::str::from_utf8(fields.next()?).ok()?;
            if kind != "monster" && kind != "boss_monster" {
                return None;
            }
            let map = place.split(',').next()?.trim();
            let valid = !map.is_empty() && map.bytes().all(|b| b.is_ascii_alphanumeric() || b"_@-.".contains(&b));
            if !valid || map == "-" || instance_map(map) {
                return None;
            }
            let mut spec = rest.split(',');
            let mob = spec.next()?.trim().to_string();
            let amount: u32 = spec.next()?.trim().parse().ok()?;
            if mob.is_empty() || amount == 0 {
                return None;
            }
            Some(Spawn { map: map.to_string(), mob, amount, name, level })
        })
        .collect()
}

/// Read a mob_db.yml into `into`, by id, a field at a time: an entry already
/// there keeps whatever this file does not set, as rAthena's imports do, and
/// a new id starts from nothing.
pub fn merge_mob_db(text: &[u8], into: &mut BTreeMap<u32, Mob>) {
    let mut current: Option<u32> = None;
    let mut field_indent = 0usize;
    let mut in_modes = false;
    for line in text.split(|b| *b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let trimmed = line.trim_ascii_start();
        if trimmed.is_empty() || trimmed.starts_with(b"#") {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if let Some(id) = trimmed.strip_prefix(b"- Id:") {
            current = std::str::from_utf8(id).ok().and_then(|s| s.trim().parse().ok());
            if let Some(id) = current {
                into.entry(id).or_default();
            }
            field_indent = indent + 2;
            in_modes = false;
            continue;
        }
        let Some(id) = current else { continue };
        if indent < field_indent {
            current = None;
            continue;
        }
        let Some(colon) = trimmed.iter().position(|b| *b == b':') else { continue };
        let key = &trimmed[..colon];
        let value = trimmed[colon + 1..].trim_ascii();
        let value = value
            .strip_prefix(b"\"")
            .and_then(|v| v.strip_suffix(b"\""))
            .unwrap_or(value);
        let text = || String::from_utf8_lossy(value).trim().to_string();
        let mob = into.get_mut(&id).expect("entry made at its Id line");
        if indent == field_indent {
            in_modes = key == b"Modes";
            match key {
                b"AegisName" => mob.aegis = text(),
                b"Name" => mob.name = value.to_vec(),
                b"Level" => mob.level = text().parse().unwrap_or(mob.level),
                b"Race" => mob.race = text(),
                b"Size" => mob.size = text(),
                b"Element" => mob.element = text(),
                b"ElementLevel" => mob.element_level = text().parse().unwrap_or(mob.element_level),
                _ => {}
            }
        } else if in_modes && key == b"Mvp" {
            mob.mvp = text().eq_ignore_ascii_case("true");
        }
    }
}

/// The files `db/mob_db.yml` imports for one era (`Renewal` or `Prerenewal`),
/// in its order, leaving out `db/import/`: the server merges them that way, so
/// a later file wins. An import with no `Mode` is in both eras.
pub fn mob_db_imports(root: &[u8], mode: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut entry: Option<(String, Option<String>)> = None;
    let push = |e: Option<(String, Option<String>)>, out: &mut Vec<String>| {
        if let Some((path, m)) = e {
            if !path.starts_with("db/import/") && m.as_deref().is_none_or(|m| m == mode) {
                out.push(path);
            }
        }
    };
    let mut in_footer = false;
    for line in String::from_utf8_lossy(root).lines() {
        let trimmed = line.trim();
        if !line.starts_with(' ') && !trimmed.is_empty() && !trimmed.starts_with('#') {
            in_footer = trimmed == "Footer:";
            continue;
        }
        if !in_footer {
            continue;
        }
        if let Some(path) = trimmed.strip_prefix("- Path:") {
            push(entry.take(), &mut out);
            entry = Some((path.trim().to_string(), None));
        } else if let (Some(m), Some(e)) = (trimmed.strip_prefix("Mode:"), entry.as_mut()) {
            e.1 = Some(m.trim().to_string());
        }
    }
    push(entry, &mut out);
    out
}

/// The stock index: each era's load order and mob_db, and the spawn lines in
/// every script under `npc/`.
#[derive(Default)]
pub struct Index {
    pub renewal: Vec<String>,
    pub prerenewal: Vec<String>,
    pub mobs_renewal: BTreeMap<u32, Mob>,
    pub mobs_prerenewal: BTreeMap<u32, Mob>,
    pub files: BTreeMap<String, Vec<Spawn>>,
}

/// Build it from a rAthena checkout with the app's server mods applied.
pub fn build_index(rathena: &Path) -> Result<Index, String> {
    let mut index = Index {
        renewal: load_order(rathena, "npc/re/scripts_main.conf"),
        prerenewal: load_order(rathena, "npc/pre-re/scripts_main.conf"),
        ..Index::default()
    };
    let root = fs::read(rathena.join("db/mob_db.yml")).map_err(|e| format!("reading db/mob_db.yml: {e}"))?;
    for (mode, into) in [("Renewal", &mut index.mobs_renewal), ("Prerenewal", &mut index.mobs_prerenewal)] {
        for path in mob_db_imports(&root, mode) {
            let text = fs::read(rathena.join(&path)).map_err(|e| format!("reading {path}: {e}"))?;
            merge_mob_db(&text, into);
        }
        if into.is_empty() {
            return Err(format!("no {mode} monsters in db/mob_db.yml's imports"));
        }
    }
    let mut scripts = Vec::new();
    collect_txt(&rathena.join("npc"), "npc", &mut scripts);
    for rel in scripts {
        let text = fs::read(rathena.join(&rel)).map_err(|e| format!("reading {rel}: {e}"))?;
        let spawns = parse_spawns(&text);
        if !spawns.is_empty() {
            index.files.insert(rel, spawns);
        }
    }
    Ok(index)
}

impl Index {
    pub fn to_text(&self) -> String {
        let mut s = String::from(
            "# The monsters the pinned rAthena spawns, for the navigation-server-monsters\n\
             # mod. Generated: ragnarok-stack navigation-mob-index <rathena with server mods\n\
             # applied>. Regenerate when the rAthena pin moves.\n\
             #\n\
             #   load   <era> <script>        the era's default load order\n\
             #   mob    <era> <id> <aegis> <level> <race> <size> <element> <element level> <mvp 0|1> <name>\n\
             #   file   <script>\n\
             #   spawn  <map> <id or aegis> <amount> <level, 0 for mob_db's> <name, empty for mob_db's>\n",
        );
        for (era, list) in [("renewal", &self.renewal), ("prerenewal", &self.prerenewal)] {
            for p in list {
                s.push_str(&format!("load\t{era}\t{p}\n"));
            }
        }
        for (era, mobs) in [("renewal", &self.mobs_renewal), ("prerenewal", &self.mobs_prerenewal)] {
            for (id, m) in mobs {
                s.push_str(&format!(
                    "mob\t{era}\t{id}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                    m.aegis, m.level, m.race, m.size, m.element, m.element_level, u8::from(m.mvp), escape(&m.name)
                ));
            }
        }
        for (file, spawns) in &self.files {
            s.push_str(&format!("file\t{file}\n"));
            for sp in spawns {
                s.push_str(&format!(
                    "spawn\t{}\t{}\t{}\t{}\t{}\n",
                    sp.map, sp.mob, sp.amount, sp.level.unwrap_or(0), escape(&sp.name)
                ));
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
                ["mob", era, id, aegis, level, race, size, element, element_level, mvp, name] => {
                    let Ok(id) = id.parse() else { continue };
                    let mob = Mob {
                        aegis: aegis.to_string(),
                        name: unescape(name),
                        level: level.parse().unwrap_or(0),
                        race: race.to_string(),
                        size: size.to_string(),
                        element: element.to_string(),
                        element_level: element_level.parse().unwrap_or(0),
                        mvp: *mvp == "1",
                    };
                    match *era {
                        "renewal" => index.mobs_renewal.insert(id, mob),
                        "prerenewal" => index.mobs_prerenewal.insert(id, mob),
                        _ => None,
                    };
                }
                ["file", p] => file = Some(p.to_string()),
                ["spawn", map, mob, amount, level, name] => {
                    let (Some(f), Ok(amount)) = (&file, amount.parse()) else { continue };
                    let level = level.parse().ok().filter(|l| *l > 0);
                    index.files.entry(f.clone()).or_default().push(Spawn {
                        map: map.to_string(),
                        mob: mob.to_string(),
                        amount,
                        name: unescape(name),
                        level,
                    });
                }
                _ => {}
            }
        }
        index
    }
}

/// The codes the client unpacks (DB.searchNavigation): race and size by
/// index, element as kind * 20 + level. rAthena's spellings.
fn race_code(race: &str) -> u32 {
    ["Formless", "Undead", "Brute", "Plant", "Insect", "Fish", "Demon", "Demihuman", "Angel", "Dragon"]
        .iter()
        .position(|r| r.eq_ignore_ascii_case(race))
        .unwrap_or(0) as u32
}

fn size_code(size: &str) -> u32 {
    ["Small", "Medium", "Large"].iter().position(|s| s.eq_ignore_ascii_case(size)).unwrap_or(0) as u32
}

fn element_code(element: &str, level: u32) -> u32 {
    let kind = ["Neutral", "Water", "Earth", "Fire", "Wind", "Poison", "Holy", "Dark", "Ghost", "Undead"]
        .iter()
        .position(|e| e.eq_ignore_ascii_case(element))
        .unwrap_or(0) as u32;
    kind * 20 + level.min(19)
}

/// One row per monster per map and name it shows, in the order the scripts
/// first spawn it:
/// `{ map, id, 300|301, count << 16 | mob id, name, aegis, level,
/// element << 16 | size << 8 | race }` -- 301 for an MVP -- as kRO packs them.
/// A spawn of a monster mob_db does not have is left out: the server cannot
/// spawn it either.
pub fn table_lua(spawns: &[Spawn], mobs: &BTreeMap<u32, Mob>) -> Vec<u8> {
    let by_aegis: HashMap<&str, u32> = mobs.iter().map(|(id, m)| (m.aegis.as_str(), *id)).collect();
    // A row is what a player sees: a monster by the name over its head, at
    // its level, on one map.
    type Row = (String, u32, Vec<u8>, u32);
    let mut order: Vec<Row> = Vec::new();
    let mut counts: HashMap<Row, u32> = HashMap::new();
    for sp in spawns {
        let Some(id) = sp.mob.parse::<u32>().ok().or_else(|| by_aegis.get(sp.mob.as_str()).copied()) else { continue };
        let Some(m) = mobs.get(&id) else { continue };
        if id > 0xffff {
            continue;
        }
        let name = if sp.name.is_empty() { m.name.clone() } else { sp.name.clone() };
        let key = (sp.map.clone(), id, name, sp.level.unwrap_or(m.level));
        let count = counts.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            0
        });
        *count = count.saturating_add(sp.amount);
    }
    let mut out = b"-- Built by Ragnarok Offline from the server's own spawns (navigation-server-monsters).\nNavi_Mob = {\n".to_vec();
    for (i, key) in order.iter().enumerate() {
        let (map, id, name, level) = key;
        let m = &mobs[id];
        let count = counts[key].min(0xffff);
        let info = element_code(&m.element, m.element_level) << 16 | size_code(&m.size) << 8 | race_code(&m.race);
        out.extend_from_slice(
            format!("\t{{ \"{map}\", {}, {}, {}, \"", i + 1, if m.mvp { 301 } else { 300 }, count << 16 | id).as_bytes(),
        );
        for &b in name {
            match b {
                b'"' | b'\\' => out.extend_from_slice(&[b'\\', b]),
                0..=0x1f => out.extend_from_slice(format!("\\{b:03}").as_bytes()),
                _ => out.push(b),
            }
        }
        out.extend_from_slice(format!("\", \"{}\", {level}, {info} }},\n", m.aegis.replace(['"', '\\'], "")).as_bytes());
    }
    out.extend_from_slice(b"}\n");
    out
}

/// Write the table into the staged assets when the mod is on: spawns from the
/// era's stock scripts, the stock scripts mods switch on and the scripts mods
/// ship; stats from the era's mob_db with every mod's mob_db.yml merged over
/// it. Returns the table written, for the cache fingerprint.
pub fn stage(cfg: &Config, server_root: &Path) -> Result<Option<Vec<u8>>, String> {
    // In the order the server applies them, so a monster two mods change ends
    // up as the server has it.
    let enabled = crate::mods::applied(cfg);
    let Some(this) = enabled.iter().find(|m| m.name == MOD) else { return Ok(None) };
    let Some(text) = this.roots.iter().find_map(|r| fs::read_to_string(r.join(INDEX)).ok()) else {
        eprintln!("{MOD}: no {INDEX}; the client keeps its own monster table");
        return Ok(None);
    };
    let index = Index::from_text(&text);
    let prerenewal = crate::cmds::is_prerenewal(cfg);
    let mut stock = if prerenewal { index.prerenewal.clone() } else { index.renewal.clone() };
    let mut mobs = if prerenewal { index.mobs_prerenewal.clone() } else { index.mobs_renewal.clone() };
    let mut mod_scripts = Vec::new();
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
            mod_scripts.push(fs::read(&f).map_err(|e| format!("reading {}: {e}", f.display()))?);
        }
        for f in crate::mods::db_sources(cfg, m, "mob_db.yml")? {
            merge_mob_db(&fs::read(&f).map_err(|e| format!("reading {}: {e}", f.display()))?, &mut mobs);
        }
    }
    // A script one mod removes is gone whichever mod loaded it.
    stock.retain(|p| !removed.contains(p));
    let mut spawns: Vec<Spawn> = stock.iter().flat_map(|f| index.files.get(f).cloned().unwrap_or_default()).collect();
    for text in &mod_scripts {
        spawns.extend(parse_spawns(text));
    }
    let table = table_lua(&spawns, &mobs);
    let path = server_root.join(TABLE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, &table).map_err(|e| format!("writing {}: {e}", path.display()))?;
    println!("{MOD}: {} spawn lines", spawns.len());
    Ok(Some(table))
}

#[cfg(test)]
mod tests {
    use super::*;

    // One line per string: a `\` line continuation would eat the indentation
    // the YAML depends on.
    const DB: &[u8] = concat!(
        "Header:\n",
        "  Type: MOB_DB\n",
        "  Version: 5\n",
        "\n",
        "Body:\n",
        "  - Id: 1002\n",
        "    AegisName: PORING\n",
        "    Name: Poring\n",
        "    Level: 1\n",
        "    Size: Medium\n",
        "    Race: Plant\n",
        "    Element: Water\n",
        "    ElementLevel: 1\n",
        "    Drops:\n",
        "      - Item: Jellopy\n",
        "        Rate: 7000\n",
        "  - Id: 1039\n",
        "    AegisName: BAPHOMET\n",
        "    Name: \"Baphomet\"\n",
        "    Level: 81\n",
        "    Size: Large\n",
        "    Race: Demon\n",
        "    Element: Dark\n",
        "    ElementLevel: 3\n",
        "    Modes:\n",
        "      Mvp: true\n",
        "Footer:\n",
        "  Imports:\n",
        "  - Path: db/import/mob_db.yml\n",
        "    Level: 99\n",
    ).as_bytes();

    fn db() -> BTreeMap<u32, Mob> {
        let mut mobs = BTreeMap::new();
        merge_mob_db(DB, &mut mobs);
        mobs
    }

    #[test]
    fn mob_db_reads_what_the_window_shows_and_imports_merge_field_by_field() {
        let mut mobs = db();
        assert_eq!(mobs.len(), 2);
        assert_eq!(mobs[&1002], Mob { aegis: "PORING".into(), name: b"Poring".to_vec(), level: 1, race: "Plant".into(), size: "Medium".into(), element: "Water".into(), element_level: 1, mvp: false });
        assert!(mobs[&1039].mvp && mobs[&1039].name == b"Baphomet" && mobs[&1039].level == 81, "the footer's Level is not Baphomet's");
        // A mod's import: Poring gets tougher and keeps the rest; a new id stands alone.
        merge_mob_db(b"Body:\n  - Id: 1002\n    Level: 50\n    Name: Angry Poring\n  - Id: 30000\n    AegisName: MY_MOB\n    Name: Mine\n    Level: 7\n", &mut mobs);
        assert_eq!(mobs[&1002].level, 50);
        assert_eq!(mobs[&1002].name, b"Angry Poring");
        assert_eq!(mobs[&1002].element, "Water");
        assert_eq!(mobs[&30000].aegis, "MY_MOB");
    }

    #[test]
    fn each_era_reads_what_mob_db_yml_imports_in_its_order() {
        let root = b"Header:\n  Type: MOB_DB\nFooter:\n  Imports:\n  - Path: db/pre-re/mob_db.yml\n    Mode: Prerenewal\n  - Path: db/re/mob_db_world.yml\n    Mode: Renewal\n  - Path: db/re/mob_db.yml\n    Mode: Renewal\n  - Path: db/both.yml\n  - Path: db/import/mob_db.yml\n";
        assert_eq!(mob_db_imports(root, "Renewal"), ["db/re/mob_db_world.yml", "db/re/mob_db.yml", "db/both.yml"]);
        assert_eq!(mob_db_imports(root, "Prerenewal"), ["db/pre-re/mob_db.yml", "db/both.yml"]);
    }

    #[test]
    fn spawn_lines_in_every_placement_and_nothing_else() {
        let script = b"prt_fild08,0,0\tmonster\tPoring\t1002,20,5000\n\
            prt_fild08,305,233,10,10\tmonster\tPoring\t1002,2,15000\n\
            prt_maze03\tboss_monster\tBaphomet\t1039,1,7200000,600000,1\n\
            pay_dun04,0,0,0,0\tmonster\t--ja--\t BAPHOMET ,1\n\
            iz_dun00,0,0,0,0\tmonster\tAged Hydra,40\t1068,50,5000,0,BountyBoard::OnHuntKill\n\
            gef_fild00,0,0\tmonster\tSwift Baroness of Retribution\t1002,1\n\
            1@tower,0,0\tmonster\tInstance\t1002,5\n\
            prt_fild08,0,0\tmonster\tNone\t1002,0\n\
            prontera,1,1,1\tscript\tNPC\t112,{\n\
            /* prt_fild08,0,0\tmonster\tCommented\t1002,99 */\n";
        let spawns = parse_spawns(script);
        let got: Vec<_> = spawns
            .iter()
            .map(|s| (s.map.as_str(), s.mob.as_str(), s.amount, String::from_utf8_lossy(&s.name).into_owned(), s.level))
            .collect();
        let row = |map: &'static str, mob: &'static str, amount, name: &str, level| (map, mob, amount, name.to_string(), level);
        assert_eq!(got, [
            row("prt_fild08", "1002", 20, "Poring", None),
            row("prt_fild08", "1002", 2, "Poring", None),
            row("prt_maze03", "1039", 1, "Baphomet", None),
            row("pay_dun04", "BAPHOMET", 1, "", None),
            row("iz_dun00", "1068", 50, "Aged Hydra", Some(40)),
            // 23 bytes, as the server reads it.
            row("gef_fild00", "1002", 1, "Swift Baroness of Retri", None),
        ]);
    }

    /// The server shows a spawn line's own name (override_mob_names: 0), so a
    /// renamed spawn is its own row, findable by that name.
    #[test]
    fn a_renamed_spawn_is_its_own_row_under_the_name_it_shows() {
        let spawns = parse_spawns(b"prt_fild08,0,0\tmonster\tPoring\t1002,20\n\
            prt_fild08,0,0\tmonster\tAged Poring,30\t1002,5\n\
            prt_fild08,0,0\tmonster\t--en--\t1002,1\n");
        let lua = String::from_utf8(table_lua(&spawns, &db())).unwrap();
        assert!(lua.contains(&format!("\"prt_fild08\", 1, 300, {}, \"Poring\", \"PORING\", 1, ", 21 << 16 | 1002)), "{lua}");
        assert!(lua.contains(&format!("\"prt_fild08\", 2, 300, {}, \"Aged Poring\", \"PORING\", 30, ", 5 << 16 | 1002)), "{lua}");
    }

    #[test]
    fn rows_count_a_monster_per_map_and_pack_as_kro_does() {
        let spawns = parse_spawns(b"prt_fild08,0,0\tmonster\tPoring\t1002,20\nprt_fild08,1,1,5,5\tmonster\tPoring\t1002,2\n\
            prt_maze03,0,0\tboss_monster\tBaphomet\tBAPHOMET,1\nprt_fild08,0,0\tmonster\tGone\t9999,5\n");
        let lua = String::from_utf8(table_lua(&spawns, &db())).unwrap();
        // 22 Porings: 22 << 16 | 1002. Water 1, Medium, Plant: 21 << 16 | 1 << 8 | 3 -- kRO's own value.
        assert!(lua.contains("\t{ \"prt_fild08\", 1, 300, 1442794, \"Poring\", \"PORING\", 1, 1376515 },\n"), "{lua}");
        // An MVP is 301; Dark 3 is 7 * 20 + 3; Large, Demon.
        assert!(lua.contains("\t{ \"prt_maze03\", 2, 301, 66575, \"Baphomet\", \"BAPHOMET\", 81, 9372166 },\n"), "{lua}");
        assert!(!lua.contains("9999"), "a monster the server does not have cannot spawn");
    }

    #[test]
    fn the_index_reads_back_what_it_wrote() {
        let mut index = Index { renewal: vec!["npc/a.txt".into()], prerenewal: vec!["npc/b.txt".into()], mobs_renewal: db(), ..Index::default() };
        index.mobs_prerenewal.insert(1, Mob { name: b"Tab\there".to_vec(), ..Mob::default() });
        index.files.insert("npc/a.txt".into(), vec![
            Spawn { map: "prt_fild08".into(), mob: "1002".into(), amount: 3, name: Vec::new(), level: None },
            Spawn { map: "iz_dun00".into(), mob: "1068".into(), amount: 50, name: b"Aged\tHydra".to_vec(), level: Some(40) },
        ]);
        let back = Index::from_text(&index.to_text());
        assert_eq!(back.renewal, index.renewal);
        assert_eq!(back.prerenewal, index.prerenewal);
        assert_eq!(back.mobs_renewal, index.mobs_renewal);
        assert_eq!(back.mobs_prerenewal, index.mobs_prerenewal);
        assert_eq!(back.files, index.files);
    }

    /// As for NPCs: when a server-modded rAthena at the pin is at
    /// vendor/rathena, the shipped index must still describe it.
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
