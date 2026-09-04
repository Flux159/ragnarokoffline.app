//! Mods: a folder per mod, assembled into the trees the map server can be given.
//!
//! A mod is a directory under `state/mods/` holding any of:
//!
//!   mod.json  name, version, author, description, and what the mod requires
//!   db/       rAthena override tables -- mob stats, item stats, drops, skills
//!   npc/      scripts: NPCs, warps, spawns, whole custom maps
//!   conf/     a few server settings, from a narrow allowlist (see `conf`)
//!   data/     client assets served ahead of the GRFs (handled in assets.rs)
//!   System/   client Lua tables (handled in assets.rs)
//!   client/   a roBrowser plugin (handled in assets.rs)
//!
//! Nothing here needs a rebuild, which is the whole point: rAthena already
//! reads `db/import` over its own tables, and the map server takes `npc:` lines
//! from the conf directory the app already mounts. This module only has to put
//! the right files in the right place and name them in the config.
//!
//! Mods are merged in name order, so two mods touching one file resolve
//! last-wins, and the order is at least predictable rather than filesystem
//! order.
//!
//! # Refusing a mod
//!
//! A mod can declare what it needs, and one that needs something this build
//! does not have is *refused*: left out of every layer, named, and given a
//! reason the player can read in Settings. Half-applying it instead -- tables
//! loaded, geometry missing -- produces a server that runs and is quietly
//! wrong, which is the failure this is here to prevent.

use crate::config::Config;
use crate::json;
use crate::mapcache;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Assembled {
    /// Host directory to bind at `/rathena/db/import`, if any mod ships tables.
    pub db: Option<PathBuf>,
    /// Host directory to bind at `/rathena/npc/mods`, if any mod ships scripts.
    pub npc: Option<PathBuf>,
    /// `npc:` lines for map_conf.txt, naming each script inside that mount.
    pub npc_lines: String,
    /// `map:` lines for map_conf.txt, one per custom map.
    ///
    /// Separate from the cache and the index, and required in addition to
    /// both. The map server builds its list of maps from `map:` directives in
    /// the config -- `maps_athena.conf` is nothing but twelve hundred of them
    /// -- and only then looks each one up in a cache. A map that is cached and
    /// indexed but never named here is simply not in the list, and the server
    /// says nothing at all about it.
    pub map_lines: String,
    /// Settings a mod asked for, keyed by the conf file they belong in.
    /// Already filtered against the allowlist; the caller appends them.
    pub conf: BTreeMap<String, Vec<(String, String)>>,
    /// Custom maps that reached the map cache, for the startup line.
    pub maps: Vec<String>,
    pub names: Vec<String>,
    /// Mods that were installed and not applied, with the reason.
    pub refused: Vec<(String, String)>,
}

impl Assembled {
    fn empty() -> Assembled {
        Assembled {
            db: None,
            npc: None,
            npc_lines: String::new(),
            map_lines: String::new(),
            conf: BTreeMap::new(),
            maps: Vec::new(),
            names: Vec::new(),
            refused: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/// What `mod.json` says. Every field is optional except in the sense that a
/// mod without a description is a folder name in a settings list.
#[derive(Debug, Clone)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    /// A rule like `">=1.0.6"` over the app's version.
    pub requires_app: Option<String>,
    /// `"renewal"`, `"pre-renewal"`, or `"any"`.
    pub requires_era: Option<String>,
    /// Whether the mod is on before the player has said anything about it.
    ///
    /// Only meaningful for mods that ship with the app: a mod somebody went to
    /// the trouble of installing should be on. A *bundled* one that changes how
    /// the game is played -- free warps, instant job changes -- should be
    /// offered rather than applied, so it declares `"default": "off"` and waits
    /// to be ticked.
    pub default_on: bool,
}

impl Default for Manifest {
    fn default() -> Manifest {
        Manifest {
            name: String::new(),
            version: String::new(),
            author: String::new(),
            description: String::new(),
            requires_app: None,
            requires_era: None,
            default_on: true,
        }
    }
}

/// Read and check one mod's manifest.
///
/// `Ok(None)` means there is no `mod.json`, which is allowed: the smallest
/// useful mod is a folder with one file in it, and demanding a manifest before
/// anything works would put a JSON syntax error between a player and their
/// first success. A manifest that *exists* and cannot be read is a different
/// matter -- somebody meant something by it -- and is refused.
fn read_manifest(dir: &Path) -> Result<Option<Manifest>, String> {
    let path = dir.join("mod.json");
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("mod.json could not be read: {e}")),
    };
    let v = json::parse(&body).map_err(|e| format!("mod.json is not valid JSON -- {e}"))?;
    if !v.is_object() {
        return Err("mod.json must be an object, starting with '{'".into());
    }
    let mut m = Manifest {
        name: v.str("name").unwrap_or_default().to_string(),
        version: v.str("version").unwrap_or_default().to_string(),
        author: v.str("author").unwrap_or_default().to_string(),
        description: v.str("description").unwrap_or_default().to_string(),
        default_on: match v.str("default") {
            None => true,
            Some("on") => true,
            Some("off") => false,
            Some(other) => {
                return Err(format!(
                    "mod.json: \"default\" is \"on\" or \"off\", not \"{other}\""
                ))
            }
        },
        ..Manifest::default()
    };
    if let Some(req) = v.get("requires") {
        if !req.is_object() {
            return Err(format!("mod.json: \"requires\" must be an object, not {req}"));
        }
        m.requires_app = req.str("app").map(str::to_string);
        m.requires_era = req.str("era").map(str::to_string);
        // Named rather than ignored: a typo in a key that gates installation
        // is the kind of mistake that looks like it worked.
        if let json::Value::Object(map) = req {
            for k in map.keys() {
                if k != "app" && k != "era" {
                    return Err(format!(
                        "mod.json: \"requires\" has no setting called \"{k}\" \
                         (this build understands \"app\" and \"era\")"
                    ));
                }
            }
        }
    }
    Ok(Some(m))
}

/// Compare a version rule against what this build is.
///
/// Rules are `">=1.0.6"`, `">1.0.6"`, `"=1.0.6"`, or a bare `"1.0.6"` read as
/// `">="` -- which is what people mean when they write it. Anything else is
/// refused rather than guessed at.
fn app_requirement_met(rule: &str, have: Option<&str>) -> Result<(), String> {
    let rule = rule.trim();
    let (op, want) = if let Some(r) = rule.strip_prefix(">=") {
        (">=", r)
    } else if let Some(r) = rule.strip_prefix("==") {
        ("=", r)
    } else if let Some(r) = rule.strip_prefix('>') {
        (">", r)
    } else if let Some(r) = rule.strip_prefix('=') {
        ("=", r)
    } else {
        (">=", rule)
    };
    let want = want.trim();
    if want.is_empty() || !want.starts_with(|c: char| c.is_ascii_digit()) {
        return Err(format!(
            "mod.json: \"{rule}\" is not a version rule -- write it like \">=1.0.6\""
        ));
    }
    // Not knowing our own version is our problem, not the mod's: warn once
    // where the operator can see it and let the mod load. Refusing everything
    // because a build marker is missing would be a worse failure than the one
    // this is guarding against.
    let Some(have) = have else {
        eprintln!("mods: this build does not know its own version, so \"{rule}\" is not checked");
        return Ok(());
    };
    let cmp = compare_versions(have, want);
    let ok = match op {
        ">=" => cmp >= std::cmp::Ordering::Equal,
        ">" => cmp == std::cmp::Ordering::Greater,
        _ => cmp == std::cmp::Ordering::Equal,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("needs app {op}{want}, and this is {have}"))
    }
}

/// Dotted numbers, compared piece by piece, missing pieces read as zero.
///
/// Anything after the numbers -- `-beta.1`, `+build` -- is dropped. This is
/// not semver: a mod that needs to distinguish `1.0.6-beta` from `1.0.6` is
/// asking a question this mechanism should not answer.
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(s: &str) -> Vec<u64> {
        s.split(|c: char| c == '-' || c == '+')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

fn era_requirement_met(rule: &str, prerenewal: bool) -> Result<(), String> {
    let want = rule.trim().to_lowercase().replace('_', "-");
    let now = if prerenewal { "pre-renewal" } else { "renewal" };
    match want.as_str() {
        "any" | "" => Ok(()),
        "renewal" if !prerenewal => Ok(()),
        "pre-renewal" | "prerenewal" | "pre-re" if prerenewal => Ok(()),
        "renewal" | "pre-renewal" | "prerenewal" | "pre-re" => {
            Err(format!("is for {want}, and this server is {now}"))
        }
        other => Err(format!(
            "mod.json: \"{other}\" is not an era -- use \"renewal\", \"pre-renewal\" or \"any\""
        )),
    }
}

// ---------------------------------------------------------------------------
// The conf layer
// ---------------------------------------------------------------------------

/// Server settings a mod is allowed to set, and the file each belongs in.
///
/// An allowlist rather than a passthrough, and deliberately short. `conf/` is
/// where `login_ip`, `char_ip` and `map_ip` live: a mod that could write those
/// could point a player's client at someone else's server, and it would look
/// exactly like a mod that works. Nothing outside this table is written, and
/// anything a mod asks for that is not here is reported by name rather than
/// dropped in silence.
///
/// Adding to it is a deliberate act. The bar is: could a mod use this to reach
/// outside the machine, or to overwrite something the player set in Settings?
const CONF_ALLOWED: &[(&str, &str)] = &[
    // Where a new character wakes up. The reason this layer exists at all:
    // "your own starting town" is most of what "your own MMO" means, and the
    // supervisor rewrites char_conf.txt on every start, so a hand edit cannot
    // survive and a mod had no way in.
    ("char_conf.txt", "start_point"),
    ("char_conf.txt", "start_point_pre"),
    ("char_conf.txt", "start_zeny"),
    ("char_conf.txt", "start_items"),
    ("char_conf.txt", "start_status_points"),
    // A custom starting town usually comes with a custom name policy: a mod
    // that spells its town in something other than ASCII wants the same
    // freedom for characters standing in it.
    ("char_conf.txt", "char_name_letters"),
    ("char_conf.txt", "char_name_option"),
];

/// Conf files a mod may supply **whole**, rather than key by key.
///
/// Some server config is not a list of settings but a document -- `groups.yml`
/// says which atcommands each player group may use, `atcommands.yml` defines
/// aliases -- and there is no sensible way to express those as `key: value`
/// lines. Both are already imported by the server (`conf/groups.yml` carries a
/// `Footer: Imports: conf/import/groups.yml`), so the file only has to be put
/// in place.
///
/// This is a bigger grant than the key allowlist and it is deliberately two
/// files long. `groups.yml` in particular is a permission boundary: a mod that
/// writes it decides what every player can do. The mods list says so, rather
/// than the grant being silent -- see `Installed::grants_commands`.
const CONF_WHOLE_FILE: &[&str] = &["groups.yml", "atcommands.yml"];

/// Read a mod's `conf/` layer, keeping only what the allowlist covers.
fn read_conf(dir: &Path, name: &str, out: &mut BTreeMap<String, Vec<(String, String)>>) {
    let conf = dir.join("conf");
    let Ok(rd) = fs::read_dir(&conf) else { return };
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    files.sort();
    for path in files {
        let file = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(body) = fs::read_to_string(&path) else { continue };
        // A whole document, copied as-is. Recorded under a key the caller
        // recognises so it is written rather than appended line by line.
        if CONF_WHOLE_FILE.contains(&file.as_str()) {
            out.entry(format!("file:{file}")).or_default().push((name.to_string(), body));
            continue;
        }
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
                continue;
            }
            let Some((k, v)) = line.split_once(':') else { continue };
            let (k, v) = (k.trim(), v.trim());
            if CONF_ALLOWED.contains(&(file.as_str(), k)) {
                out.entry(file.clone()).or_default().push((k.to_string(), v.to_string()));
            } else {
                // Loud, because the mod will otherwise appear to work and
                // simply not do the thing its README says it does.
                eprintln!(
                    "mods: {name} asked to set \"{k}\" in conf/{file}, which mods may not set -- ignoring"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Whether a mod is applied, and why not when it is not.
#[derive(Clone, PartialEq)]
pub enum Status {
    On,
    /// Switched off in `disabled.txt`.
    Off,
    /// Installed, wanted something this build cannot give it.
    Refused(String),
}

pub struct Installed {
    pub name: String,
    /// Where the folder actually is: under `state/mods` for one the player
    /// installed, under `<runtime>/mods` for one the app ships.
    pub dir: PathBuf,
    pub status: Status,
    pub manifest: Manifest,
    /// Shipped with the app rather than installed by the player. Shown
    /// differently, and it cannot be deleted from the mods folder -- but it
    /// can be switched off, and it can be replaced by installing a mod of the
    /// same name.
    pub bundled: bool,
}

/// Every mod folder, in merge order, with its manifest checked.
///
/// The single place that decides what is applied. `assemble`, `list` and the
/// client-asset overlay all read this, so the server, the Settings window and
/// the asset tree cannot disagree about which mods are live -- which they did,
/// before: a disabled mod stopped being assembled and went on overlaying its
/// sprites.
///
/// Two roots, and a name in both resolves to the player's copy. That is what
/// makes a shipped mod a starting point rather than a wall: copy
/// `mobile-ui` out of the app into the mods folder, change it, and the
/// changed one is the one that loads.
pub fn scan(cfg: &Config) -> Vec<Installed> {
    let user = cfg.state.join("mods");
    let disabled = read_list(&cfg.state, "disabled.txt");
    let enabled = read_list(&cfg.state, "enabled.txt");
    let prerenewal = crate::cmds::is_prerenewal(cfg);
    let app = cfg.app_version.as_deref();

    let mut found: BTreeMap<String, (PathBuf, bool)> = BTreeMap::new();
    for (root, bundled) in [(cfg.root.join("mods"), true), (user, false)] {
        let Ok(rd) = fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.path().is_dir() {
                continue;
            }
            found.insert(name, (e.path(), bundled));
        }
    }

    let mut out = Vec::new();
    for (name, (dir, bundled)) in found {
        let (manifest, problem) = match read_manifest(&dir) {
            Ok(Some(m)) => {
                let mut problem = None;
                if let Some(rule) = &m.requires_app {
                    if let Err(e) = app_requirement_met(rule, app) {
                        problem = Some(e);
                    }
                }
                if problem.is_none() {
                    if let Some(rule) = &m.requires_era {
                        if let Err(e) = era_requirement_met(rule, prerenewal) {
                            problem = Some(e);
                        }
                    }
                }
                (m, problem)
            }
            Ok(None) => (Manifest::default(), None),
            Err(e) => (Manifest::default(), Some(e)),
        };
        let status = match problem {
            // Refusal outranks being switched off, so a player who turns a
            // broken mod off and back on is told the same thing both times.
            Some(reason) => Status::Refused(reason),
            // An explicit choice always wins, in either direction. Only when
            // the player has said nothing does the manifest's default apply --
            // which is how a bundled mod can ship switched off and still be
            // switchable on.
            None if disabled.contains(&name) => Status::Off,
            None if enabled.contains(&name) => Status::On,
            None if !manifest.default_on => Status::Off,
            None => Status::On,
        };
        // The folder name is the identity -- it is what disabled.txt lists,
        // what the npc mount is called and what decides merge order -- so a
        // manifest that calls the mod something else is a mod somebody renamed
        // by dragging it. Not fatal, but it will make every instruction in its
        // README point at the wrong name.
        if !manifest.name.is_empty() && manifest.name != name {
            eprintln!(
                "mods: the folder is called \"{name}\" but its mod.json says \"{}\" -- \
                 the folder name is the one that counts",
                manifest.name
            );
        }
        out.push(Installed { name, dir, status, manifest, bundled });
    }
    out
}

/// The mods that are actually being applied, in merge order.
pub fn enabled(cfg: &Config) -> Vec<Installed> {
    scan(cfg).into_iter().filter(|m| m.status == Status::On).collect()
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    copy_tree_owned(src, dst, "", None, &mut BTreeMap::new())
}

/// Copy a tree, and optionally record which mod each file came from.
///
/// The recording exists for one reason: two mods that both ship
/// `db/mob_db.yml` resolve last-wins by name order, quietly, and the player has
/// no way to tell that half of what they installed is not in effect. The
/// supervisor knows -- it is doing the overwriting -- so it says so.
fn copy_tree_owned(
    src: &Path,
    dst: &Path,
    rel: &str,
    owner: Option<&str>,
    seen: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let to = dst.join(e.file_name());
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if from.is_dir() {
            copy_tree_owned(&from, &to, &child, owner, seen)?;
        } else {
            if let Some(owner) = owner {
                if let Some(before) = seen.insert(child.clone(), owner.to_string()) {
                    if before != owner {
                        eprintln!(
                            "mods: {owner} overwrites {child} from {before} -- \
                             later name wins, so {before}'s copy is not in effect"
                        );
                    }
                }
            }
            let _ = fs::copy(&from, &to);
        }
    }
    Ok(())
}

/// rAthena ships ~60 stub files in `db/import`, and it warns for every one it
/// cannot open. Binding a directory over that path hides them, so the stubs
/// have to be laid down first and every mod layered on top.
///
/// They come from the payload rather than out of the image: `docker cp` from a
/// created-but-not-running container reports success and copies nothing under
/// the bundled slim client, which is a silent failure of exactly the kind that
/// is worst here -- the server starts, warns sixty times, and the mod appears
/// not to work. package.sh stages them instead.
fn seed_db_import(cfg: &Config, dst: &Path) -> Result<(), String> {
    let stubs = cfg.root.join("db-import");
    if !stubs.is_dir() {
        // Not fatal: a mod's own tables still load, rAthena just complains
        // about the stubs it can no longer see.
        eprintln!("mods: no db-import stubs at {} -- expect import warnings", stubs.display());
        let _ = fs::create_dir_all(dst);
        return Ok(());
    }
    copy_tree(&stubs, dst)
}

/// Build the mount trees for whatever is in `state/mods`.
pub fn assemble(cfg: &Config) -> Result<Assembled, String> {
    let _ = fs::create_dir_all(cfg.state.join("mods"));

    let installed = scan(cfg);
    let mut out = Assembled::empty();
    for m in &installed {
        if let Status::Refused(reason) = &m.status {
            out.refused.push((m.name.clone(), reason.clone()));
        }
    }
    let live: Vec<&Installed> = installed.iter().filter(|m| m.status == Status::On).collect();

    // Rebuilt from scratch every start: a mod removed from state/mods must stop
    // affecting the server, and a stale merge is indistinguishable from a mod
    // that is still installed. Cleared even when nothing is enabled, so that
    // turning the last mod off actually removes its tables.
    let build = cfg.state.join("modbuild");
    let _ = fs::remove_dir_all(&build);

    out.names = live.iter().map(|m| m.name.clone()).collect();
    if live.is_empty() {
        return Ok(out);
    }

    // Custom maps first, because whether any exist decides whether `db/` is
    // needed at all: a mod can ship geometry and no tables and still need the
    // import mount, for the cache and the index this writes into it.
    let mut maps: Vec<mapcache::Map> = Vec::new();
    for m in &live {
        let data = m.dir.join("data");
        if !data.is_dir() {
            continue;
        }
        for name in mapcache::map_names(&data) {
            if name.len() >= 12 {
                eprintln!(
                    "mods: {} has a map called \"{name}\", which is too long -- \
                     rAthena map names are at most 11 characters",
                    m.name
                );
                continue;
            }
            match mapcache::read_map_from_dir(&data, &name) {
                // Later mods win here too, so a mod that ships new geometry for
                // an earlier mod's map replaces it rather than duplicating it.
                Ok(map) => {
                    maps.retain(|e| e.name != map.name);
                    maps.push(map);
                }
                Err(e) => eprintln!("mods: {}: {e}", m.name),
            }
        }
    }

    let wants_db = !maps.is_empty() || live.iter().any(|m| m.dir.join("db").is_dir());
    if wants_db {
        let dst = build.join("db");
        seed_db_import(cfg, &dst)?;
        let mut owners: BTreeMap<String, String> = BTreeMap::new();
        for m in &live {
            let from = m.dir.join("db");
            if from.is_dir() {
                copy_tree_owned(&from, &dst, "", Some(&m.name), &mut owners)?;
            }
        }
        if !maps.is_empty() {
            write_map_layer(&dst, &maps)?;
            out.maps = maps.iter().map(|m| m.name.clone()).collect();
            out.map_lines = maps.iter().map(|m| format!("map: {}\n", m.name)).collect();
        }
        out.db = Some(dst);
    }

    // Stock scripts first, so a mod's own can duplicate or disable them.
    let mut stock: Vec<String> = Vec::new();
    for m in &live {
        read_stock_npc(&m.dir, &m.name, &mut stock);
    }
    let mut lines: String = stock.iter().map(|p| format!("npc: {p}\n")).collect();
    if !stock.is_empty() {
        println!("stock scripts: {}", stock.len());
    }
    for m in &live {
        let from = m.dir.join("npc");
        if !from.is_dir() {
            continue;
        }
        let dst = build.join("npc").join(&m.name);
        copy_tree(&from, &dst)?;
        // One `npc:` line per script. Paths are container-side, under the mount
        // point rather than the host path, and forward-slashed because rAthena
        // parses them itself rather than handing them to the OS.
        collect_scripts(&dst, &format!("npc/mods/{}", m.name), &mut lines);
    }
    if !lines.is_empty() {
        // The mount is only needed when a mod ships its own scripts; stock
        // lines name paths that are already in the image.
        if build.join("npc").is_dir() {
            out.npc = Some(build.join("npc"));
        }
        out.npc_lines = lines;
    }

    for m in &live {
        read_conf(&m.dir, &m.name, &mut out.conf);
    }
    Ok(out)
}

/// Write the cache and the index a custom map needs, into the `db/import`
/// tree that is about to be mounted.
///
/// Two files, and both are required: the index gives the map a number the
/// servers pass around, and the cache gives it walkable ground. A map in one
/// and not the other fails in two different, equally silent ways -- missing
/// from the index it is "not found in index list" and quietly dropped;
/// missing from the cache it is removed at load with only a count of "maps
/// removed" to say so.
fn write_map_layer(db: &Path, maps: &[mapcache::Map]) -> Result<(), String> {
    let cache = db.join("map_cache.dat");
    fs::write(&cache, mapcache::write_cache(maps))
        .map_err(|e| format!("writing {}: {e}", cache.display()))?;

    // A mod that ships its own map_index.txt has said what indices it wants;
    // do not second-guess it. Otherwise generate one, listing each map with no
    // index so rAthena assigns the next free one after the stock table.
    let index = db.join("map_index.txt");
    let existing = fs::read_to_string(&index).unwrap_or_default();
    let named: Vec<&str> = existing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("//"))
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    let missing: Vec<&mapcache::Map> =
        maps.iter().filter(|m| !named.contains(&m.name.as_str())).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut body = existing;
    if !body.ends_with('\n') && !body.is_empty() {
        body.push('\n');
    }
    body.push_str(
        "\n// Added by the mod system, from the .gat files the mods ship.\n\
         // No index given, so rAthena continues numbering after db/map_index.txt.\n",
    );
    for m in missing {
        body.push_str(&m.name);
        body.push('\n');
    }
    fs::write(&index, body).map_err(|e| format!("writing {}: {e}", index.display()))
}

/// Scripts rAthena already ships that a mod asks to switch on.
///
/// rAthena carries a job changer, a warper, a healer and a stylist in
/// `npc/custom/`, fully written and placed in every town -- and loads none of
/// them, because `scripts_custom.conf` has every line commented out. They are
/// already inside the image, so switching one on is one `npc:` line and no
/// files at all.
///
/// A mod names them in `stock-npc.txt` at its root, one path per line. The path
/// is checked rather than trusted: it has to be under `npc/`, and it cannot
/// climb out with `..`. The blast radius is small either way -- the worst a mod
/// can do is load a script rAthena wrote -- but a path this ends up in a config
/// file is not a place to skip validation.
fn read_stock_npc(dir: &Path, name: &str, out: &mut Vec<String>) {
    let path = dir.join("stock-npc.txt");
    let Ok(body) = fs::read_to_string(&path) else { return };
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") || line.starts_with('#') {
            continue;
        }
        let bad = !line.starts_with("npc/")
            || line.contains("..")
            || line.contains('\\')
            || !line.ends_with(".txt");
        if bad {
            eprintln!(
                "mods: {name} asked to load \"{line}\", which is not a script path under npc/ -- ignoring"
            );
            continue;
        }
        if !out.iter().any(|l| l == line) {
            out.push(line.to_string());
        }
    }
}

fn collect_scripts(dir: &Path, prefix: &str, out: &mut String) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        if p.is_dir() {
            collect_scripts(&p, &format!("{prefix}/{name}"), out);
        } else if p.extension().map(|x| x == "txt").unwrap_or(false) {
            out.push_str(&format!("npc: {prefix}/{name}\n"));
        }
    }
}

/// One of the two lists of explicit choices under `state/mods`.
///
/// `disabled.txt` and `enabled.txt` between them record what the player has
/// actually decided. A mod in neither has not been decided about, and takes
/// whatever its manifest says.
fn read_list(state: &Path, file: &str) -> Vec<String> {
    fs::read_to_string(state.join("mods").join(file))
        .map(|b| {
            b.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .collect()
        })
        .unwrap_or_default()
}

/// What is installed, and whether each one is on. Used by the Settings window.
///
/// Tab-separated: state, name, description, the reason a refused mod was
/// refused, where it came from, its version and its author.
///
/// A refusal the player cannot see is the same bug as no refusal at all, and
/// a version and author nothing displays are three lines of a manifest nobody
/// has a reason to fill in.
/// Flatten a field so it cannot break the tab-separated line it is written on.
///
/// The description comes out of a manifest a stranger wrote, and a tab in it
/// would silently shift every field after it by one when the app splits the
/// line back apart.
fn one_line(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ")
}

pub fn list(cfg: &Config) -> Vec<[String; 7]> {
    scan(cfg)
        .into_iter()
        .map(|m| {
            let (state, reason) = match &m.status {
                Status::On => ("on", String::new()),
                Status::Off => ("off", String::new()),
                Status::Refused(r) => ("refused", r.clone()),
            };
            [
                state.to_string(),
                one_line(&m.name),
                one_line(&m.manifest.description),
                one_line(&reason),
                if m.bundled { "bundled" } else { "installed" }.to_string(),
                one_line(&m.manifest.version),
                one_line(&m.manifest.author),
            ]
        })
        .collect()
}

/// Turn one mod on or off, leaving the rest alone.
///
/// Written to both lists rather than one, because "off" and "not yet decided"
/// are different states now: a bundled mod that ships switched off has to be
/// able to record that the player switched it *on*.
pub fn set_enabled(state: &Path, name: &str, on: bool) -> Result<(), String> {
    write_list(state, "disabled.txt", name, !on,
        "# Mods listed here are installed but switched off.")?;
    write_list(state, "enabled.txt", name, on,
        "# Mods listed here are switched on, including any that ship switched off.")
}

fn write_list(state: &Path, file: &str, name: &str, present: bool, header: &str) -> Result<(), String> {
    let mut names = read_list(state, file);
    names.retain(|n| n != name);
    if present {
        names.push(name.to_string());
    }
    names.sort();
    let _ = fs::create_dir_all(state.join("mods"));
    let path = state.join("mods").join(file);
    let body = format!("{header}\n# Managed from Settings; one name per line.\n{}\n", names.join("\n"));
    fs::write(&path, body).map_err(|e| format!("writing {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_rules() {
        assert!(app_requirement_met(">=1.0.6", Some("1.0.6")).is_ok());
        assert!(app_requirement_met(">=1.0.6", Some("1.1.0")).is_ok());
        assert!(app_requirement_met("1.0.6", Some("1.0.5")).is_err());
        assert!(app_requirement_met(">1.0.6", Some("1.0.6")).is_err());
        assert!(app_requirement_met("=1.0.6", Some("1.0.6")).is_ok());
        assert!(app_requirement_met("=1.0.6", Some("1.0.7")).is_err());
        // Fewer parts on either side read as zero, so 1.1 is 1.1.0.
        assert!(app_requirement_met(">=1.1", Some("1.1.0")).is_ok());
        assert!(app_requirement_met(">=1.10", Some("1.9.9")).is_err());
        // A pre-release suffix is dropped rather than ordered.
        assert!(app_requirement_met(">=1.0.6", Some("1.0.6-beta.2")).is_ok());
        // Not a rule at all.
        assert!(app_requirement_met("latest", Some("1.0.6")).is_err());
        // Unknown app version: allowed, because that is our fault, not the mod's.
        assert!(app_requirement_met(">=99.0.0", None).is_ok());
    }

    /// The message a player reads. It has to name both numbers, or "refused"
    /// is just a different way of not working.
    #[test]
    fn a_refusal_says_what_it_wanted_and_what_it_got() {
        let e = app_requirement_met(">=1.0.6", Some("1.0.5")).unwrap_err();
        assert!(e.contains("1.0.6") && e.contains("1.0.5"), "{e}");
    }

    #[test]
    fn era_rules() {
        assert!(era_requirement_met("any", true).is_ok());
        assert!(era_requirement_met("renewal", false).is_ok());
        assert!(era_requirement_met("renewal", true).is_err());
        assert!(era_requirement_met("pre-renewal", true).is_ok());
        assert!(era_requirement_met("Pre_Renewal", true).is_ok());
        assert!(era_requirement_met("classic", true).is_err());
    }

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ro-mods-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_manifest_with_a_quote_in_the_description_reads_back_whole() {
        let d = tmp("desc");
        fs::write(d.join("mod.json"), r#"{"description": "adds a \"boss\" to prontera"}"#).unwrap();
        let m = read_manifest(&d).unwrap().unwrap();
        assert_eq!(m.description, r#"adds a "boss" to prontera"#);
    }

    #[test]
    fn no_manifest_is_fine_and_a_broken_one_is_not() {
        let d = tmp("none");
        assert!(read_manifest(&d).unwrap().is_none());
        fs::write(d.join("mod.json"), "{ oops }").unwrap();
        assert!(read_manifest(&d).is_err());
    }

    /// A misspelled requirement is the failure this whole mechanism exists to
    /// prevent, so it cannot be the one thing that passes silently.
    #[test]
    fn an_unknown_requires_key_is_refused() {
        let d = tmp("req");
        fs::write(d.join("mod.json"), r#"{"requires": {"apps": ">=1.0.0"}}"#).unwrap();
        let e = read_manifest(&d).unwrap_err();
        assert!(e.contains("apps"), "{e}");
    }

    /// The allowlist is the security boundary, so it gets a test that fails
    /// loudly if someone widens it by accident.
    #[test]
    fn a_mod_cannot_set_the_addresses_the_client_is_sent_to() {
        let d = tmp("conf");
        fs::create_dir_all(d.join("conf")).unwrap();
        fs::write(
            d.join("conf/char_conf.txt"),
            "// mine\nstart_point: my_town,50,50\nchar_ip: 10.0.0.1\nlogin_ip: 10.0.0.1\n",
        )
        .unwrap();
        let mut out = BTreeMap::new();
        read_conf(&d, "x", &mut out);
        let got = out.get("char_conf.txt").unwrap();
        assert_eq!(got, &vec![("start_point".into(), "my_town,50,50".into())]);
    }

    #[test]
    fn a_generated_map_index_keeps_what_the_mod_already_named() {
        let d = tmp("index");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("map_index.txt"), "// mine\nmy_town\t1250\n").unwrap();
        let maps = vec![
            mapcache::Map { name: "my_town".into(), xs: 1, ys: 1, cells: vec![0] },
            mapcache::Map { name: "my_cave".into(), xs: 1, ys: 1, cells: vec![0] },
        ];
        write_map_layer(&d, &maps).unwrap();
        let body = fs::read_to_string(d.join("map_index.txt")).unwrap();
        assert!(body.contains("my_town\t1250"), "{body}");
        assert_eq!(body.matches("my_town").count(), 1, "{body}");
        assert!(body.contains("\nmy_cave\n"), "{body}");
        assert!(d.join("map_cache.dat").is_file());
    }
}
