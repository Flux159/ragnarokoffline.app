//! Navigation NPCs from the server's own scripts: the `navigation-server-npcs`
//! mod.
//!
//! The navigation search reads `navi_npc_krpri.lub` from the player's GRF,
//! which lists kRO's NPCs at kRO's positions under kRO's names. This server is
//! rAthena: some of those NPCs are not on it, some stand elsewhere, and none of
//! the ones mods add are listed. With the mod on, the table is built instead
//! from the scripts the map server loads, so a search finds what is actually
//! there, under the name it shows overhead.
//!
//! The stock scripts live in the server image, not on the player's machine, so
//! they are read once, when the rAthena pin moves, into `npc-index.tsv` in the
//! mod's folder (`ragnarok-stack navigation-npc-index <rathena>`). The scripts
//! mods add are read at link time, from the mods themselves.
//!
//! Read the way rAthena reads them, but only the header lines: an NPC a script
//! hides or moves while it runs (`disablenpc`, `movenpc`) is still listed where
//! its header put it.

use crate::config::Config;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

/// The mod this builds the table for.
pub const MOD: &str = "navigation-server-npcs";
/// Its stock index, in the mod's folder.
pub const INDEX: &str = "npc-index.tsv";
/// Where the client reads the table.
pub const TABLE: &str = "data/luafiles514/lua files/navigation/navi_npc_krpri.lub";

/// One NPC as the navigation table lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Npc {
    pub map: String,
    pub x: u32,
    pub y: u32,
    /// Sells something: kRO's table marks these 102 rather than 101.
    pub shop: bool,
    pub sprite: i32,
    /// The name over its head, as the script's bytes.
    pub name: Vec<u8>,
}

/// Sprites that draw nothing, so there is nothing to walk up to: rAthena's
/// FAKE_NPC, HIDDEN_NPC, HIDDEN_WARP_NPC, WARPNPC, CLEAR_NPC and INVISIBLE.
fn invisible(sprite: i32, sprites: &HashMap<String, i32>) -> bool {
    sprite == -1
        || ["HIDDEN_NPC", "HIDDEN_WARP_NPC", "WARPNPC", "CLEAR_NPC", "INVISIBLE"]
            .iter()
            .any(|n| sprites.get(*n) == Some(&sprite))
}

const SHOPS: &[&str] = &["shop", "cashshop", "itemshop", "pointshop", "marketshop"];

/// The NPCs a script's header lines place on a map.
///
/// A header is `map,x,y,facing<TAB>type<TAB>name<TAB>sprite...` at the start
/// of a line. Left out: floating NPCs (`-`), instance maps (`1@...`), a sprite
/// that draws nothing, and a name that shows nothing (`#hidden`). A sprite
/// constant the server does not know is left out too: rAthena draws those as
/// INVISIBLE.
pub fn parse_script(text: &[u8], sprites: &HashMap<String, i32>) -> Vec<Npc> {
    script_lines(text).into_iter().filter_map(|line| parse_header(line, sprites)).collect()
}

/// A script's lines, less those a block comment starts in or covers: a
/// header the map server would never see is not a header.
pub(crate) fn script_lines(text: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut in_comment = false;
    for raw in text.split(|b| *b == b'\n') {
        let line = raw.strip_suffix(b"\r").unwrap_or(raw);
        let starts_in_comment = in_comment;
        let mut i = 0;
        while i + 1 < line.len() {
            if in_comment && &line[i..i + 2] == b"*/" {
                in_comment = false;
                i += 2;
            } else if !in_comment && &line[i..i + 2] == b"/*" {
                in_comment = true;
                i += 2;
            } else if !in_comment && &line[i..i + 2] == b"//" {
                break;
            } else {
                i += 1;
            }
        }
        if !starts_in_comment {
            out.push(line);
        }
    }
    out
}

/// An instance map (`1@tower`): a copy made per party, not a place to walk to.
pub(crate) fn instance_map(map: &str) -> bool {
    let mut chars = map.chars();
    chars.next().is_some_and(|c| c.is_ascii_digit()) && chars.next() == Some('@')
}

fn parse_header(line: &[u8], sprites: &HashMap<String, i32>) -> Option<Npc> {
    let mut fields = line.split(|b| *b == b'\t');
    let place = std::str::from_utf8(fields.next()?).ok()?;
    let kind = std::str::from_utf8(fields.next()?).ok()?;
    let name = fields.next()?;
    let rest = fields.next()?;

    let mut at = place.split(',');
    let map = at.next()?.trim();
    let x: u32 = at.next()?.trim().parse().ok()?;
    let y: u32 = at.next()?.trim().parse().ok()?;
    at.next()?.trim().parse::<i32>().ok()?;
    let valid_map = !map.is_empty()
        && map.bytes().all(|b| b.is_ascii_alphanumeric() || b"_@-.".contains(&b));
    if !valid_map || map == "-" || at.next().is_some() {
        return None;
    }
    if instance_map(map) {
        return None;
    }

    let shop = SHOPS.contains(&kind);
    let duplicate = kind.starts_with("duplicate(") && kind.ends_with(')');
    if !(kind == "script" || shop || duplicate) {
        return None;
    }

    // `Shown name#unique::label`: only the part before `#` is drawn.
    let shown = name.split(|b| *b == b'#').next().unwrap_or(b"");
    let shown = shown
        .windows(2)
        .position(|w| w == b"::")
        .map_or(shown, |p| &shown[..p]);
    let shown = shown.trim_ascii();
    if shown.is_empty() {
        return None;
    }

    let token = rest
        .split(|b| *b == b',' || *b == b'{')
        .next()
        .unwrap_or(b"");
    let token = std::str::from_utf8(token).ok()?.trim();
    let sprite = match token.parse::<i32>() {
        Ok(n) => n,
        Err(_) => *sprites.get(token)?,
    };
    if invisible(sprite, sprites) {
        return None;
    }
    Some(Npc { map: map.to_string(), x, y, shop, sprite, name: shown.to_vec() })
}

/// rAthena's sprite constants, from `enum e_job_types` in `src/map/npc.hpp`,
/// named as scripts spell them (`JT_4_M_KAFRA` is `4_M_KAFRA`).
pub fn read_sprites(npc_hpp: &str) -> HashMap<String, i32> {
    let mut out = HashMap::new();
    let Some(start) = npc_hpp.find("enum e_job_types") else { return out };
    let body = &npc_hpp[start..];
    let Some(open) = body.find('{') else { return out };
    let Some(close) = body.find("};") else { return out };
    let mut next = 0i32;
    for item in body[open + 1..close].lines() {
        let item = item.split("//").next().unwrap_or("").trim().trim_end_matches(',').trim();
        if item.is_empty() {
            continue;
        }
        let (name, value) = match item.split_once('=') {
            Some((n, v)) => (n.trim(), v.trim().parse::<i32>().ok()),
            None => (item, None),
        };
        let value = value.unwrap_or(next);
        next = value + 1;
        if let Some(short) = name.strip_prefix("JT_") {
            out.insert(short.to_string(), value);
        }
    }
    out
}

/// The scripts a `scripts_main.conf` loads, in order: `npc:` adds, `delnpc:`
/// removes, `import:` reads another conf in place. Paths are relative to the
/// rAthena root, as the map server takes them.
pub fn load_order(rathena: &Path, conf: &str) -> Vec<String> {
    fn walk(rathena: &Path, conf: &str, out: &mut Vec<String>, depth: u32) {
        let Ok(body) = fs::read(rathena.join(conf)) else { return };
        if depth > 16 {
            return;
        }
        for line in String::from_utf8_lossy(&body).lines() {
            let line = line.split("//").next().unwrap_or("").trim();
            let Some((key, value)) = line.split_once(':') else { continue };
            let value = value.trim().to_string();
            match key.trim() {
                "npc" if !out.contains(&value) => out.push(value),
                "delnpc" => out.retain(|p| *p != value),
                "import" => walk(rathena, &value, out, depth + 1),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(rathena, conf, &mut out, 0);
    out
}

/// The stock index: every NPC each script under `npc/` places, which scripts
/// each era loads, and the sprite constants mods' scripts are read against.
#[derive(Default)]
pub struct Index {
    pub sprites: HashMap<String, i32>,
    pub renewal: Vec<String>,
    pub prerenewal: Vec<String>,
    pub files: BTreeMap<String, Vec<Npc>>,
}

/// Names are written byte for byte, with tab, newline, backslash and anything
/// outside printable ASCII escaped as `\xNN`, so the index stays one line per
/// NPC and plain text whatever a script's encoding.
pub(crate) fn escape(bytes: &[u8]) -> String {
    let mut s = String::new();
    for &b in bytes {
        if (0x20..0x7f).contains(&b) && b != b'\\' {
            s.push(b as char);
        } else {
            s.push_str(&format!("\\x{b:02x}"));
        }
    }
    s
}

pub(crate) fn unescape(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() && bytes[i + 1] == b'x' {
            if let Ok(b) = u8::from_str_radix(&s[i + 2..i + 4], 16) {
                out.push(b);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// Build the index from a rAthena checkout with the app's server mods applied
/// (scripts/apply-server-mods.sh), the tree the server image is built from.
pub fn build_index(rathena: &Path) -> Result<Index, String> {
    let hpp = fs::read_to_string(rathena.join("src/map/npc.hpp"))
        .map_err(|e| format!("reading src/map/npc.hpp: {e}"))?;
    let sprites = read_sprites(&hpp);
    if sprites.is_empty() {
        return Err("no sprite constants in src/map/npc.hpp".into());
    }
    let mut index = Index {
        renewal: load_order(rathena, "npc/re/scripts_main.conf"),
        prerenewal: load_order(rathena, "npc/pre-re/scripts_main.conf"),
        ..Index::default()
    };
    let mut scripts = Vec::new();
    collect_txt(&rathena.join("npc"), "npc", &mut scripts);
    for rel in scripts {
        let text = fs::read(rathena.join(&rel)).map_err(|e| format!("reading {rel}: {e}"))?;
        let npcs = parse_script(&text, &sprites);
        if !npcs.is_empty() {
            index.files.insert(rel, npcs);
        }
    }
    index.sprites = sprites;
    Ok(index)
}

pub(crate) fn collect_txt(dir: &Path, rel: &str, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = format!("{rel}/{name}");
        if e.path().is_dir() {
            collect_txt(&e.path(), &path, out);
        } else if name.ends_with(".txt") {
            out.push(path);
        }
    }
}

impl Index {
    pub fn to_text(&self) -> String {
        let mut s = String::from(
            "# The NPCs the pinned rAthena's scripts place, for the navigation-server-npcs\n\
             # mod. Generated: ragnarok-stack navigation-npc-index <rathena with server mods\n\
             # applied>. Regenerate when the rAthena pin moves.\n\
             #\n\
             #   sprite  <constant>  <id>\n\
             #   load    <era>       <script>           the era's default load order\n\
             #   file    <script>\n\
             #   npc     <map> <x> <y> <shop 0|1> <sprite id> <name>\n",
        );
        let mut sprites: Vec<_> = self.sprites.iter().collect();
        sprites.sort();
        for (name, id) in sprites {
            s.push_str(&format!("sprite\t{name}\t{id}\n"));
        }
        for (era, list) in [("renewal", &self.renewal), ("prerenewal", &self.prerenewal)] {
            for p in list {
                s.push_str(&format!("load\t{era}\t{p}\n"));
            }
        }
        for (file, npcs) in &self.files {
            s.push_str(&format!("file\t{file}\n"));
            for n in npcs {
                s.push_str(&format!(
                    "npc\t{}\t{}\t{}\t{}\t{}\t{}\n",
                    n.map, n.x, n.y, u8::from(n.shop), n.sprite, escape(&n.name)
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
                ["sprite", name, id] => {
                    if let Ok(id) = id.parse() {
                        index.sprites.insert(name.to_string(), id);
                    }
                }
                ["load", "renewal", p] => index.renewal.push(p.to_string()),
                ["load", "prerenewal", p] => index.prerenewal.push(p.to_string()),
                ["file", p] => file = Some(p.to_string()),
                ["npc", map, x, y, shop, sprite, name] => {
                    let (Some(f), Ok(x), Ok(y), Ok(sprite)) = (&file, x.parse(), y.parse(), sprite.parse()) else {
                        continue;
                    };
                    index.files.entry(f.clone()).or_default().push(Npc {
                        map: map.to_string(),
                        x,
                        y,
                        shop: *shop == "1",
                        sprite,
                        name: unescape(name),
                    });
                }
                _ => {}
            }
        }
        index
    }
}

/// The table as the client's Lua reads it:
/// `{ map, id, 101|102, sprite, name, "", x, y }`, ids numbered in order.
pub fn table_lua(npcs: &[Npc]) -> Vec<u8> {
    let mut out = b"-- Built by Ragnarok Offline from the server's own scripts (navigation-server-npcs).\nNavi_Npc = {\n".to_vec();
    for (i, n) in npcs.iter().enumerate() {
        out.extend_from_slice(format!("\t{{ \"{}\", {}, {}, {}, \"", n.map, i + 1, if n.shop { 102 } else { 101 }, n.sprite).as_bytes());
        for &b in &n.name {
            match b {
                b'"' | b'\\' => out.extend_from_slice(&[b'\\', b]),
                0..=0x1f => out.extend_from_slice(format!("\\{b:03}").as_bytes()),
                _ => out.push(b),
            }
        }
        out.extend_from_slice(format!("\", \"\", {}, {} }},\n", n.x, n.y).as_bytes());
    }
    out.extend_from_slice(b"}\n");
    out
}

/// The NPCs a server running these scripts shows, in load order, each place
/// listed once.
pub fn collect(index: &Index, stock: &[String], mod_scripts: &[Vec<u8>]) -> Vec<Npc> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |n: &Npc, out: &mut Vec<Npc>| {
        if seen.insert((n.map.clone(), n.x, n.y, n.name.clone())) {
            out.push(n.clone());
        }
    };
    for file in stock {
        for n in index.files.get(file).into_iter().flatten() {
            push(n, &mut out);
        }
    }
    for text in mod_scripts {
        for n in parse_script(text, &index.sprites) {
            push(&n, &mut out);
        }
    }
    out
}

/// Write the table into the staged assets when the mod is on: the era's stock
/// scripts, the stock scripts mods switch on, and the scripts mods ship.
/// Applied after the mods' own client files, so it is what the client reads.
/// Returns the table written, for the cache fingerprint.
pub fn stage(cfg: &Config, server_root: &Path) -> Result<Option<Vec<u8>>, String> {
    let enabled = crate::mods::enabled(cfg);
    let Some(this) = enabled.iter().find(|m| m.name == MOD) else { return Ok(None) };
    let Some(text) = this.roots.iter().find_map(|r| fs::read_to_string(r.join(INDEX)).ok()) else {
        eprintln!("{MOD}: no {INDEX}; the client keeps its own NPC table");
        return Ok(None);
    };
    let index = Index::from_text(&text);
    let mut stock = if crate::cmds::is_prerenewal(cfg) { index.prerenewal.clone() } else { index.renewal.clone() };
    let mut scripts = Vec::new();
    let mut removed = Vec::new();
    for m in &enabled {
        let sources = crate::mods::npc_sources(cfg, m)?;
        removed.extend(sources.removed);
        for p in sources.stock {
            if !index.files.contains_key(&p) && !stock.contains(&p) {
                eprintln!("{MOD}: {} loads {p}, which the index does not list", m.name);
            }
            if !stock.contains(&p) {
                stock.push(p);
            }
        }
        for f in sources.files {
            scripts.push(fs::read(&f).map_err(|e| format!("reading {}: {e}", f.display()))?);
        }
    }
    // A script one mod removes is gone whichever mod loaded it.
    stock.retain(|p| !removed.contains(p));
    let npcs = collect(&index, &stock, &scripts);
    let path = server_root.join(TABLE);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let table = table_lua(&npcs);
    fs::write(&path, &table).map_err(|e| format!("writing {}: {e}", path.display()))?;
    println!("{MOD}: {} NPCs", npcs.len());
    Ok(Some(table))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sprites() -> HashMap<String, i32> {
        read_sprites(
            "enum e_job_types\n{\n\tNPC_RANGE1_START = 44,\n\tJT_WARPNPC,\n\tJT_1_ETC_01,\n\
             \tJT_4_M_KAFRA = 112, // a comment\n\tJT_HIDDEN_NPC = 111,\n\tJT_HIDDEN_WARP_NPC = 139,\n\
             \tJT_CLEAR_NPC = 844,\n\tJT_INVISIBLE = 32767,\n\tJT_FAKENPC = -1\n};\n",
        )
    }

    #[test]
    fn sprite_constants_count_on_from_the_last_value() {
        let s = sprites();
        assert_eq!(s.get("WARPNPC"), Some(&45));
        assert_eq!(s.get("1_ETC_01"), Some(&46));
        assert_eq!(s.get("4_M_KAFRA"), Some(&112));
        assert_eq!(s.get("FAKENPC"), Some(&-1));
        assert!(!s.contains_key("NPC_RANGE1_START"));
    }

    #[test]
    fn headers_become_npcs_and_what_cannot_be_walked_to_does_not() {
        let script = b"// A town\r\n\
            prontera,152,326,3\tscript\tKafra Employee::kaf_prontera\t4_M_KAFRA,{\r\n\
            \tmes \"prontera,1,1,1\tscript\tNot a header\t112,{\";\r\n\
            }\r\n\
            prontera,150,180,4\tshop\tTool Dealer#prt\t112,501:-1\n\
            prontera,151,181,4\tduplicate(Kafra Employee::kaf_prontera)\tKafra Copy\t46\n\
            prontera,152,182,4\tscript\tTouch Me\t46,2,2,{\n\
            prontera,1,2,3\tscript\t#hidden\t112,{\n\
            prontera,1,2,3\tscript\tHidden Warp\tHIDDEN_WARP_NPC,{\n\
            prontera,1,2,3\tscript\tFake\t-1,{\n\
            prontera,1,2,3\tscript\tTypo\t4_M_KAFFRA,{\n\
            1@tower,1,2,3\tscript\tInstance\t112,{\n\
            -\tscript\tFloating\t112,{\n\
            prontera,1,2,3\twarp\tprt01\t1,1,izlude,1,1\n\
            prontera,1,2,3\tmonster\tPoring\t1002,1\n\
            /* prontera,9,9,9\tscript\tCommented\t112,{\n\
            prontera,8,8,8\tscript\tStill Commented\t112,{ */\n\
            prontera,7,7,7\tscript\tAfter */ the comment\t112,{\n\
            prontera,6,6,6\tscript\tCaf\xe9\t112,{\n";
        let npcs = parse_script(script, &sprites());
        let names: Vec<_> = npcs.iter().map(|n| String::from_utf8_lossy(&n.name).into_owned()).collect();
        assert_eq!(
            names,
            ["Kafra Employee", "Tool Dealer", "Kafra Copy", "Touch Me", "After */ the comment", "Caf\u{fffd}"]
        );
        assert_eq!(npcs[0], Npc { map: "prontera".into(), x: 152, y: 326, shop: false, sprite: 112, name: b"Kafra Employee".to_vec() });
        assert!(npcs[1].shop && npcs[1].sprite == 112);
        assert_eq!(npcs[3].sprite, 46);
        assert_eq!(npcs[5].name, b"Caf\xe9");
    }

    #[test]
    fn load_order_follows_imports_and_delnpc() {
        let root = std::env::temp_dir().join(format!("ro-navnpc-conf-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("npc/re")).unwrap();
        fs::write(root.join("npc/re/scripts_main.conf"),
            "// header\nimport: npc/scripts_common.conf\nnpc: npc/re/b.txt\ndelnpc: npc/a.txt\nnpc: npc/c.txt // trailing\n").unwrap();
        fs::write(root.join("npc/scripts_common.conf"), "npc: npc/a.txt\n//npc: npc/off.txt\nnpc: npc/c.txt\n").unwrap();
        assert_eq!(load_order(&root, "npc/re/scripts_main.conf"), ["npc/c.txt", "npc/re/b.txt"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_index_reads_back_what_it_wrote() {
        let mut index = Index { sprites: sprites(), renewal: vec!["npc/a.txt".into()], prerenewal: vec!["npc/b.txt".into()], ..Index::default() };
        index.files.insert("npc/a.txt".into(), vec![
            Npc { map: "prontera".into(), x: 1, y: 2, shop: true, sprite: 112, name: b"Tab\there \\ and \xe9".to_vec() },
        ]);
        let back = Index::from_text(&index.to_text());
        assert_eq!(back.sprites, index.sprites);
        assert_eq!(back.renewal, index.renewal);
        assert_eq!(back.prerenewal, index.prerenewal);
        assert_eq!(back.files, index.files);
        assert!(index.to_text().lines().all(|l| !l.starts_with("npc") || l.split('\t').count() == 7));
    }

    #[test]
    fn the_table_is_one_row_per_place_in_load_order() {
        let mut index = Index { sprites: sprites(), ..Index::default() };
        let kafra = Npc { map: "prontera".into(), x: 1, y: 2, shop: false, sprite: 112, name: b"Kafra".to_vec() };
        index.files.insert("npc/a.txt".into(), vec![kafra.clone()]);
        index.files.insert("npc/b.txt".into(), vec![kafra.clone()]);
        let mods = vec![b"izlude,5,6,0\tshop\tSay \"hi\"\t112,501:-1\n".to_vec()];
        let npcs = collect(&index, &["npc/a.txt".into(), "npc/b.txt".into(), "npc/missing.txt".into()], &mods);
        assert_eq!(npcs.len(), 2);
        let lua = String::from_utf8(table_lua(&npcs)).unwrap();
        assert!(lua.contains("\t{ \"prontera\", 1, 101, 112, \"Kafra\", \"\", 1, 2 },\n"), "{lua}");
        assert!(lua.contains("\t{ \"izlude\", 2, 102, 112, \"Say \\\"hi\\\"\", \"\", 5, 6 },\n"), "{lua}");
        assert!(lua.starts_with("--") && lua.contains("Navi_Npc = {\n") && lua.ends_with("}\n"));
    }

    /// The shipped index is generated from the pinned rAthena with the app's
    /// server mods applied. When such a checkout is at vendor/rathena, prove
    /// it still describes it; elsewhere there is nothing to compare against.
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
