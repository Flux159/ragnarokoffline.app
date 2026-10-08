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
    /// The clients the mod is for (`"requires": { "client": ["kRO"] }`), by
    /// their service name, compared without regard to case. Empty for any.
    pub requires_client: Vec<String>,
    /// Whether the mod is on before the player has said anything about it.
    ///
    /// Only meaningful for mods that ship with the app: a mod somebody went to
    /// the trouble of installing should be on, so the shell records it as
    /// switched on when it is installed (`switchOnInstalled` in electron/main.js). A *bundled* one that changes how
    /// the game is played -- free warps, instant job changes -- should be
    /// offered rather than applied, so it declares `"default": "off"` and waits
    /// to be ticked.
    pub default_on: bool,
    /// Simple options the player can set in Settings, declared by the mod.
    ///
    /// A mod that wants one switch should not have to ship its own settings
    /// window. These are declared here, rendered by the app, and handed back to
    /// the mod's `init(parameters, api)` when the client loads it -- so a mod
    /// can stay enabled and still hide part of itself.
    pub settings: Vec<Setting>,
    /// Mods this one does not work without. Each must be installed and on, or
    /// this mod is refused and says which one is missing.
    pub requires_mods: Vec<String>,
    /// Mods this one must be applied *after*, when both are on.
    ///
    /// Only about precedence, not need: a name here that nobody has installed
    /// is ignored. This is how a mod says "my copy of that table wins" without
    /// having to be named later in the alphabet than somebody else's folder.
    pub after: Vec<String>,
    /// The mod's own settings page, as a path inside its folder
    /// (`"settingsPage": "settings/index.html"`). Empty when it has none.
    ///
    /// The app opens it in a window of its own that can read and write this
    /// mod's declared settings and nothing else; the settings above are still
    /// what is validated and stored. Checked here for shape and existence so a
    /// typo is a refusal with a reason rather than a button that does nothing.
    pub settings_page: String,
    /// `"skin"` or `"cursor"`, or empty. Mods of one kind replace the same
    /// files -- every UI skin overlays the whole interface folder, every
    /// cursor pack the one cursor sprite -- so a second one switched on would
    /// leave a patchwork of both. At most one of each kind is on at a time:
    /// switching one on switches the others of its kind off.
    pub kind: String,
    /// A folder inside the mod whose layers apply only on renewal servers
    /// (`"renewalFolder": "renewal"`), and its pre-renewal counterpart. Each
    /// is laid out like the mod itself -- `db/`, `npc/`, `data/`, `lua/` -- and
    /// is applied over the mod's own folders when that era is running, so a
    /// file in it replaces the file of the same name. Empty when not declared.
    ///
    /// For a mod whose tables only parse in one era: an item_db entry naming
    /// a renewal-only script command breaks a pre-renewal server outright, and
    /// the alternative was two mods that repeat everything else.
    pub renewal_folder: String,
    pub prerenewal_folder: String,
    /// Folders applied over the mod's own (and its era folder) for one client
    /// (`"clientFolders": { "kRO": "kro", "iRO": "iro" }`): the client's name,
    /// then the folder. For data that only matches one client's GRFs -- an
    /// iteminfo.lua written for kRO's item tables overwrites iRO's.
    pub client_folders: Vec<(String, String)>,
    /// How the client draws and plays a map: the sky behind it, its clouds,
    /// its weather and its music
    /// (`"maps": { "my_isle": { "sky": [r, g, b], "clouds": [r, g, b], "bgm": "my_isle.mp3" } }`).
    ///
    /// Official clients keep the sky table in the executable, and roBrowser in
    /// `DB/Effects/WeatherEffect.js`: a dozen official maps, and black with no
    /// clouds for every other, which meant every custom map. The music is one
    /// table for the whole game, `data/mp3nametable.txt`, so a mod could only
    /// name a map's music by replacing every map's. Our fork reads these from
    /// the `customMaps` config (client_tables).
    pub maps: Vec<MapLook>,
}

/// One map's entry in a manifest's `"maps"`.
#[derive(Clone, PartialEq, Debug)]
pub struct MapLook {
    /// The map's name, lower case, without `.rsw`.
    pub name: String,
    /// RGBA, 0 to 1; given as RGB, the alpha is 1.
    pub sky: Option<[f64; 4]>,
    /// RGB, 0 to 1. Only with a sky: the clouds drift across it.
    pub clouds: Option<[f64; 3]>,
    /// One of [`WEATHERS`].
    pub weather: Option<String>,
    /// A file in `BGM/`: the mod's own, or one the client ships (`"08.mp3"`).
    pub bgm: Option<String>,
}

/// The weather effects roBrowser's ScreenEffectManager starts by name.
pub const WEATHERS: &[&str] = &[
    "snow", "rain", "fireworks", "leaves", "sakura", "cloud", "cloud2", "cloud3", "cloud4", "cloud5",
    "cloud6", "cloud7", "cloud8",
];

/// The values `"kind"` may take. Anything else is refused by name, the way a
/// typo in `requires` is: a skin that silently stops being exclusive is the
/// kind of mistake that looks like it worked.
pub const KINDS: &[&str] = &["skin", "cursor"];

/// One declared option. Deliberately three scalar types: anything richer is a
/// mod's own UI problem, and this has to render without the app knowing what
/// the mod means by it.
#[derive(Clone, PartialEq, Debug)]
pub struct Setting {
    pub key: String,
    pub label: String,
    pub description: String,
    pub value: SettingValue,
    /// Inclusive bounds for a number, and a maximum length for a string.
    pub min: f64,
    pub max: f64,
}

#[derive(Clone, PartialEq, Debug)]
pub enum SettingValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl SettingValue {
    pub fn type_name(&self) -> &'static str {
        match self {
            SettingValue::Bool(_) => "boolean",
            SettingValue::Number(_) => "number",
            SettingValue::Text(_) => "string",
        }
    }
    /// JSON, for both the settings window and the generated client config.
    pub fn to_json(&self) -> String {
        match self {
            SettingValue::Bool(v) => v.to_string(),
            // Whole numbers must not render as 1.0: this lands in JavaScript
            // and in a JSON document the settings window parses.
            SettingValue::Number(v) if v.fract() == 0.0 && v.is_finite() => format!("{}", *v as i64),
            SettingValue::Number(v) => format!("{v}"),
            SettingValue::Text(v) => crate::json::quote(v),
        }
    }
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
            requires_client: Vec::new(),
            default_on: true,
            settings: Vec::new(),
            requires_mods: Vec::new(),
            after: Vec::new(),
            settings_page: String::new(),
            kind: String::new(),
            renewal_folder: String::new(),
            prerenewal_folder: String::new(),
            client_folders: Vec::new(),
            maps: Vec::new(),
        }
    }
}

/// A manifest's `"maps"`, checked for shape. A mistake is a refusal with a
/// reason, as anywhere else in mod.json: a colour that silently fails to
/// apply looks exactly like a feature that does not work.
fn map_looks(v: &json::Value) -> Result<Vec<MapLook>, String> {
    let Some(maps) = v.get("maps") else {
        return Ok(Vec::new());
    };
    let json::Value::Object(maps) = maps else {
        return Err("mod.json: \"maps\" must be an object of map names, like { \"my_isle\": { \"sky\": [0.4, 0.6, 0.8] } }".into());
    };
    if maps.len() > 200 {
        return Err("mod.json: \"maps\" may name at most 200 maps".into());
    }
    let color = |map: &str, key: &str, value: &json::Value, sizes: &[usize]| -> Result<Vec<f64>, String> {
        let wrong = || {
            let shape = if sizes.len() == 2 { "3 or 4" } else { "3" };
            format!("mod.json: \"maps\".{map}.{key} must be a list of {shape} numbers from 0 to 1, like [0.4, 0.6, 0.8]")
        };
        let json::Value::Array(items) = value else { return Err(wrong()) };
        if !sizes.contains(&items.len()) {
            return Err(wrong());
        }
        items
            .iter()
            .map(|item| match item {
                json::Value::Number(n) if n.is_finite() && (0.0..=1.0).contains(n) => Ok(*n),
                _ => Err(wrong()),
            })
            .collect()
    };
    let mut out = Vec::new();
    for (key, entry) in maps {
        let name = key.to_ascii_lowercase();
        let name = name.strip_suffix(".rsw").unwrap_or(&name).to_string();
        // rAthena's limit; the same one the map cache enforces.
        if name.is_empty()
            || name.len() > 11
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'@' || b == b'-')
        {
            return Err(format!(
                "mod.json: {key:?} in \"maps\" is not a map name -- letters, digits, _, @ and -, up to 11"
            ));
        }
        let json::Value::Object(fields) = entry else {
            return Err(format!("mod.json: \"maps\".{name} must be an object, like {{ \"sky\": [0.4, 0.6, 0.8] }}"));
        };
        for k in fields.keys() {
            if !["sky", "clouds", "weather", "bgm"].contains(&k.as_str()) {
                return Err(format!(
                    "mod.json: \"maps\".{name} has no setting called \"{k}\" (this build understands \"sky\", \"clouds\", \"weather\" and \"bgm\")"
                ));
            }
        }
        let sky = match fields.get("sky") {
            None => None,
            Some(value) => {
                let c = color(&name, "sky", value, &[3, 4])?;
                Some([c[0], c[1], c[2], c.get(3).copied().unwrap_or(1.0)])
            }
        };
        let clouds = match fields.get("clouds") {
            None => None,
            Some(_) if sky.is_none() => {
                return Err(format!("mod.json: \"maps\".{name} has clouds but no sky for them to drift across -- add \"sky\""))
            }
            Some(value) => {
                let c = color(&name, "clouds", value, &[3])?;
                Some([c[0], c[1], c[2]])
            }
        };
        let weather = match fields.get("weather") {
            None => None,
            Some(json::Value::String(w)) if WEATHERS.contains(&w.as_str()) => Some(w.clone()),
            Some(_) => {
                return Err(format!(
                    "mod.json: \"maps\".{name}.weather must be one of {}",
                    WEATHERS.iter().map(|w| format!("\"{w}\"")).collect::<Vec<_>>().join(", ")
                ))
            }
        };
        // A file name in BGM/, as the client asks for it. `BGM.play` cuts any
        // name that mentions "bgm" down to its last `\w+.mp3`, so a folder, or
        // a "-" in such a name, would play some other file.
        let playable = |f: &str| {
            let lower = f.to_ascii_lowercase();
            let Some(stem) = lower.strip_suffix(".mp3") else { return false };
            !stem.is_empty()
                && f.len() <= 64
                && stem.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && !(stem.contains("bgm") && stem.contains('-'))
        };
        let bgm = match fields.get("bgm") {
            None => None,
            Some(json::Value::String(f)) if playable(f) => Some(f.clone()),
            Some(_) => {
                return Err(format!(
                    "mod.json: \"maps\".{name}.bgm must be the name of an .mp3 in BGM/ -- letters, digits, _ and -, like \"my_isle.mp3\""
                ))
            }
        };
        if sky.is_none() && weather.is_none() && bgm.is_none() {
            return Err(format!("mod.json: \"maps\".{name} sets nothing -- give it a \"sky\", a \"weather\" or a \"bgm\""));
        }
        out.push(MapLook { name, sky, clouds, weather, bgm });
    }
    Ok(out)
}

/// A list of mod names from the manifest, checked for shape.
///
/// Mod names are folder names, so the same rules apply: something a filesystem
/// and a JSON document can both carry, and nothing that could climb out of the
/// mods directory if it were ever joined to a path.
fn name_list(value: &json::Value, key: &str, prefix: Option<&str>) -> Result<Vec<String>, String> {
    let label = format!("{}{key}", prefix.unwrap_or(""));
    let Some(list) = value.get(key) else {
        return Ok(Vec::new());
    };
    let json::Value::Array(items) = list else {
        return Err(format!("mod.json: \"{label}\" must be an array of mod names"));
    };
    let mut out = Vec::new();
    for item in items {
        let json::Value::String(name) = item else {
            return Err(format!("mod.json: every entry in \"{label}\" must be a mod name"));
        };
        if name.is_empty()
            || name.len() > 64
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(format!(
                "mod.json: {name:?} in \"{label}\" is not a mod name -- letters, digits, - and _, up to 64"
            ));
        }
        if !out.contains(name) {
            out.push(name.clone());
        }
    }
    Ok(out)
}

/// Put the enabled mods in the order their layers should be applied.
///
/// Alphabetical is the floor, because it is stable and a player can predict it.
/// `after` lifts a mod above that: it is applied later than the mods it names,
/// so its copy of a repeated key wins. Names nobody installed are ignored --
/// `after` is about precedence between mods that are both here, and `requires`
/// is the field for actually needing one.
///
/// A cycle cannot be ordered, so the mods in it are returned as an error
/// against their names rather than silently resolved into some order that
/// happens to fall out of the traversal.
fn apply_order(mods: &[(String, Vec<String>)]) -> Result<Vec<String>, Vec<String>> {
    let names: Vec<String> = {
        let mut names: Vec<String> = mods.iter().map(|(name, _)| name.clone()).collect();
        names.sort();
        names
    };
    let mut done: Vec<String> = Vec::new();
    // 0 untouched, 1 in progress, 2 placed.
    let mut state: BTreeMap<&str, u8> = BTreeMap::new();
    let edges: BTreeMap<&str, &Vec<String>> =
        mods.iter().map(|(name, after)| (name.as_str(), after)).collect();

    // Iterative, so a deep chain cannot overflow the stack, and alphabetical
    // at every choice so the result does not depend on directory order.
    for root in &names {
        if state.get(root.as_str()).copied().unwrap_or(0) == 2 {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(root.as_str(), 0)];
        while let Some((name, index)) = stack.pop() {
            if index == 0 {
                match state.get(name).copied().unwrap_or(0) {
                    2 => continue,
                    1 => {
                        let cycle: Vec<String> =
                            stack.iter().map(|(n, _)| (*n).to_string()).collect();
                        return Err(cycle);
                    }
                    _ => {
                        state.insert(name, 1);
                    }
                }
            }
            let before = edges.get(name).copied();
            let mut next = None;
            if let Some(before) = before {
                let mut sorted: Vec<&String> = before.iter().collect();
                sorted.sort();
                if let Some(dep) = sorted.get(index) {
                    next = Some(dep.as_str());
                }
            }
            match next {
                Some(dep) => {
                    stack.push((name, index + 1));
                    // Not installed, or not on: `after` is only a preference.
                    if edges.contains_key(dep) {
                        stack.push((dep, 0));
                    }
                }
                None => {
                    state.insert(name, 2);
                    done.push(name.to_string());
                }
            }
        }
    }
    Ok(done)
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
    m.after = name_list(&v, "after", None)?;
    if let Some(requires) = v.get("requires") {
        m.requires_mods = name_list(requires, "mods", Some("requires."))?;
        if m.requires_mods.iter().any(|n| *n == m.name) {
            return Err("mod.json: a mod cannot require itself".into());
        }
    }
    if let Some(list) = v.get("settings") {
        let crate::json::Value::Array(items) = list else {
            return Err("mod.json: \"settings\" must be an array of option objects".into());
        };
        for item in items {
            if !item.is_object() {
                return Err("mod.json: each entry in \"settings\" must be an object".into());
            }
            let key = item.str("key").unwrap_or_default().to_string();
            // The key becomes a JavaScript property the mod reads and a form
            // field the app renders, so keep it to something both can carry.
            if key.is_empty()
                || key.len() > 40
                || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                || key.as_bytes()[0].is_ascii_digit()
            {
                return Err(format!(
                    "mod.json: setting key {key:?} must be 1-40 letters, digits or underscores and cannot start with a digit"
                ));
            }
            if m.settings.iter().any(|s: &Setting| s.key == key) {
                return Err(format!("mod.json: setting {key:?} is declared twice"));
            }
            let label = item.str("label").unwrap_or(&key).to_string();
            let description = item.str("description").unwrap_or_default().to_string();
            if label.len() > 120 || description.len() > 400 {
                return Err(format!("mod.json: setting {key:?} has an over-long label or description"));
            }
            let declared = item.str("type").unwrap_or("boolean");
            let default = item.get("default");
            let value = match (declared, default) {
                ("boolean", None) => SettingValue::Bool(false),
                ("boolean", Some(crate::json::Value::Bool(v))) => SettingValue::Bool(*v),
                ("number", None) => SettingValue::Number(0.0),
                ("number", Some(crate::json::Value::Number(v))) if v.is_finite() => SettingValue::Number(*v),
                ("string", None) => SettingValue::Text(String::new()),
                ("string", Some(crate::json::Value::String(v))) if v.len() <= 200 => SettingValue::Text(v.clone()),
                ("boolean" | "number" | "string", _) => {
                    return Err(format!(
                        "mod.json: setting {key:?} declares type {declared:?}, so its \"default\" must match that type"
                    ))
                }
                _ => {
                    return Err(format!(
                        "mod.json: setting {key:?} has type {declared:?}; use \"boolean\", \"number\" or \"string\""
                    ))
                }
            };
            let number = |name: &str, fallback: f64| match item.get(name) {
                Some(crate::json::Value::Number(v)) if v.is_finite() => Ok(*v),
                None => Ok(fallback),
                Some(_) => Err(format!("mod.json: setting {key:?} has a non-numeric {name:?}")),
            };
            let (min, max) = match &value {
                SettingValue::Number(_) => (number("min", f64::MIN)?, number("max", f64::MAX)?),
                SettingValue::Text(_) => (0.0, number("max_length", 200.0)?.clamp(1.0, 200.0)),
                SettingValue::Bool(_) => (0.0, 0.0),
            };
            if min > max {
                return Err(format!("mod.json: setting {key:?} has a minimum above its maximum"));
            }
            m.settings.push(Setting { key, label, description, value, min, max });
        }
        if m.settings.len() > 40 {
            return Err("mod.json: a mod may declare at most 40 settings".into());
        }
    }
    if let Some(req) = v.get("requires") {
        if !req.is_object() {
            return Err(format!("mod.json: \"requires\" must be an object, not {req}"));
        }
        m.requires_app = req.str("app").map(str::to_string);
        m.requires_era = req.str("era").map(str::to_string);
        m.requires_client = client_names(req)?;
        // Named rather than ignored: a typo in a key that gates installation
        // is the kind of mistake that looks like it worked.
        if let json::Value::Object(map) = req {
            for k in map.keys() {
                if k != "app" && k != "era" && k != "mods" && k != "client" {
                    return Err(format!(
                        "mod.json: \"requires\" has no setting called \"{k}\" \
                         (this build understands \"app\", \"era\", \"mods\" and \"client\")"
                    ));
                }
            }
        }
    }
    if let Some(kind) = v.get("kind") {
        match v.str("kind") {
            Some(k) if KINDS.contains(&k) => m.kind = k.to_string(),
            Some(k) => {
                return Err(format!(
                    "mod.json: \"kind\" is {k:?}; this build understands \"skin\" and \"cursor\""
                ))
            }
            None => return Err(format!("mod.json: \"kind\" must be \"skin\" or \"cursor\", not {kind}")),
        }
    }
    if v.get("settingsPage").is_some() {
        let Some(page) = v.str("settingsPage") else {
            return Err("mod.json: \"settingsPage\" must be a path like \"settings/index.html\"".into());
        };
        m.settings_page = settings_page(dir, page)?;
    }
    m.renewal_folder = era_folder(dir, &v, "renewalFolder")?;
    m.prerenewal_folder = era_folder(dir, &v, "prerenewalFolder")?;
    m.client_folders = client_folders(dir, &v)?;
    m.maps = map_looks(&v)?;
    Ok(Some(m))
}

/// The top-level folders a mod's layers live in. An era folder named like one
/// of them would be read twice, as a layer and as the era's copy of the mod.
const LAYER_FOLDERS: [&str; 8] = ["data", "db", "npc", "conf", "lua", "System", "BGM", "client"];

/// A client's service name as a mod writes it: `kRO`, `iRO`, `twRO`. Letters
/// and digits, so a typo can't smuggle in a path or a pattern.
fn client_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 12 && name.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `requires.client`: one client name or a list of them. `"any"` (or none)
/// is no requirement.
fn client_names(req: &json::Value) -> Result<Vec<String>, String> {
    let Some(raw) = req.get("client") else { return Ok(Vec::new()) };
    let items: Vec<&json::Value> = match raw {
        json::Value::String(_) => vec![raw],
        json::Value::Array(items) => items.iter().collect(),
        other => return Err(format!("mod.json: \"requires.client\" must be a client like \"kRO\", or a list of them, not {other}")),
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let json::Value::String(name) = item else {
            return Err("mod.json: every entry in \"requires.client\" must be a client like \"kRO\"".into());
        };
        if !client_name(name) {
            return Err(format!("mod.json: {name:?} in \"requires.client\" is not a client name -- like \"kRO\" or \"iRO\""));
        }
        if name.eq_ignore_ascii_case("any") {
            return Ok(Vec::new());
        }
        if !out.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            out.push(name.clone());
        }
    }
    Ok(out)
}

/// `clientFolders`: `{ "<client>": "<folder>" }`, each folder checked as an
/// era folder is.
fn client_folders(dir: &Path, v: &json::Value) -> Result<Vec<(String, String)>, String> {
    let Some(raw) = v.get("clientFolders") else { return Ok(Vec::new()) };
    let json::Value::Object(map) = raw else {
        return Err(format!("mod.json: \"clientFolders\" must be an object like {{ \"kRO\": \"kro\" }}, not {raw}"));
    };
    let mut out = Vec::new();
    for (client, folder) in map {
        if !client_name(client) || client.eq_ignore_ascii_case("any") {
            return Err(format!("mod.json: {client:?} in \"clientFolders\" is not a client name -- like \"kRO\" or \"iRO\""));
        }
        let json::Value::String(path) = folder else {
            return Err(format!("mod.json: \"clientFolders\" for {client} must be a folder name like \"kro\", not {folder}"));
        };
        out.push((client.clone(), folder_in_mod(dir, path, &format!("clientFolders.{client}"))?));
    }
    Ok(out)
}

/// `renewalFolder` / `prerenewalFolder`, checked: a relative path to a folder
/// that is actually in the mod, that does not climb out of it and is not one
/// of the layer folders. Empty when the key is absent.
fn era_folder(dir: &Path, v: &json::Value, key: &str) -> Result<String, String> {
    let Some(raw) = v.get(key) else { return Ok(String::new()) };
    let Some(path) = v.str(key) else {
        return Err(format!("mod.json: \"{key}\" must be a folder name like \"renewal\", not {raw}"));
    };
    folder_in_mod(dir, path, key)
}

/// A folder named in mod.json (`key` says which setting, for the message):
/// relative, inside the mod, not a layer folder, and actually there.
fn folder_in_mod(dir: &Path, path: &str, key: &str) -> Result<String, String> {
    let path = path.trim_end_matches('/');
    let shaped = !path.is_empty()
        && path.len() <= 100
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    if !shaped {
        return Err(format!(
            "mod.json: \"{key}\" must be a folder inside the mod, like \"renewal\" (got {path:?})"
        ));
    }
    let top = path.split('/').next().unwrap_or_default();
    if LAYER_FOLDERS.iter().any(|layer| layer.eq_ignore_ascii_case(top)) {
        return Err(format!(
            "mod.json: \"{key}\" is {path:?}, which is one of the mod's own layer folders -- \
             use a folder of its own, like \"renewal\", with db/, npc/ and the rest inside it"
        ));
    }
    if !dir.join(path).is_dir() {
        return Err(format!("mod.json: \"{key}\" names {path:?}, which is not a folder in the mod"));
    }
    Ok(path.to_string())
}

/// A settings page path, checked: relative, forward slashes, nothing that
/// climbs out of the mod folder, an `.html` file that is actually there.
fn settings_page(dir: &Path, page: &str) -> Result<String, String> {
    let shaped = !page.is_empty()
        && page.len() <= 200
        && !page.starts_with('/')
        && !page.contains(['\\', ':', '\0'])
        && page.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && (page.ends_with(".html") || page.ends_with(".htm"));
    if !shaped {
        return Err(format!(
            "mod.json: \"settingsPage\" must be an .html file inside the mod folder, like \"settings/index.html\" (got {page:?})"
        ));
    }
    if !dir.join(page).is_file() {
        return Err(format!("mod.json: the settings page {page:?} is not in the mod folder"));
    }
    Ok(page.to_string())
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
pub(crate) fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
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

/// Whether the running client (`client`, as detected from its GRFs) is one
/// the mod is for. An undetected client refuses nothing: the mod may well be
/// right for it, and refusing would turn a detection gap into a broken mod.
fn client_requirement_met(wanted: &[String], client: Option<&str>) -> Result<(), String> {
    let (Some(client), false) = (client, wanted.is_empty()) else { return Ok(()) };
    if wanted.iter().any(|w| w.eq_ignore_ascii_case(client)) {
        return Ok(());
    }
    Err(format!("is for {}, and this client is {client}", wanted.join(" or ")))
}

/// The client the app detected from the player's GRFs (`state/client-detected.json`,
/// written by the shell each time it indexes the client): `kRO`, `iRO`, ...
/// None when it couldn't tell, or nothing has been detected yet.
pub fn detected_client(state: &Path) -> Option<String> {
    let text = fs::read_to_string(state.join("client-detected.json")).ok()?;
    let v = json::parse(&text).ok()?;
    let name = v.str("client")?;
    client_name(name).then(|| name.to_string())
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

/// Every enabled mod's copy of one whole conf file, made into the one file the
/// server imports.
///
/// Joined the way `db/` tables are, by `merge_tables`, because rAthena treats a
/// second entry for the same group or command as more of it. `groups.yml` gets
/// one step more first: a command a group already holds -- from rAthena's own
/// file or an earlier mod -- is taken out of the later copy, since rAthena
/// would otherwise discard that copy's whole group entry (see `groups.rs`).
/// `atcommands` is every mod's `atcommands.yml`, for the aliases a grant may
/// be spelled with.
///
/// Returns the file, when any copy was usable, and one sentence for each thing
/// that was left out.
pub fn combine_whole_conf(
    file: &str,
    entries: &[(String, String)],
    atcommands: &[(String, String)],
) -> (Option<String>, Vec<String>) {
    let mut notes = Vec::new();
    let mut grants = crate::groups::Grants::stock();
    for (_, body) in atcommands {
        grants.learn_aliases(body);
    }
    let mut merged: Option<(String, String)> = None;
    for (owner, body) in entries {
        // Checked before the repeats are taken out, so a copy left out whole
        // is not counted as holding the commands it lists.
        if let Some((first, existing)) = &merged {
            if merge_tables(existing, body).is_none() {
                notes.push(format!(
                    "{owner}'s conf/{file} is not the same kind of table as {first}'s \
                     (compare their Header: Type), so it was left out"
                ));
                continue;
            }
        }
        let body = if file == "groups.yml" {
            let (body, dropped) = grants.dedupe(body, owner);
            notes.extend(dropped);
            body
        } else {
            body.clone()
        };
        merged = Some(match merged {
            None => (owner.clone(), body),
            Some((first, existing)) => {
                let joined = merge_tables(&existing, &body).unwrap_or(existing);
                (first, joined)
            }
        });
    }
    (merged.map(|(_, body)| body), notes)
}

/// The fragments under `conf/when/<setting>/` that apply, as (label, file, body).
///
/// A mod's own boolean setting decides whether a fragment is part of it. That
/// is how one mod offers a server-side option -- `player-commands` and `@go` --
/// rather than shipping a second mod that has to repeat everything the first
/// one grants. Only the whole-file conf layers can be switched this way.
fn conditional_conf(dir: &Path, name: &str, settings: &[(String, String)]) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir.join("conf").join("when")) else { return out };
    let mut keys: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    keys.sort();
    for folder in keys {
        let key = folder.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        if conditional_setting(name, "conf", &key, settings) != Some(true) {
            continue;
        }
        let Ok(files) = fs::read_dir(&folder) else { continue };
        let mut files: Vec<PathBuf> = files.flatten().map(|e| e.path()).collect();
        files.sort();
        for path in files {
            let file = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            if !CONF_WHOLE_FILE.contains(&file.as_str()) {
                eprintln!(
                    "mods: {name} has conf/when/{key}/{file}; only {} can be switched by a setting -- ignoring it",
                    CONF_WHOLE_FILE.join(" and ")
                );
                continue;
            }
            if let Ok(body) = fs::read_to_string(&path) {
                out.push((format!("{name} ({key})"), file, body));
            }
        }
    }
    out
}

/// The `<layer>/when/<key>/` folders whose yes/no setting is on, in name
/// order. The folder name is the setting's key; a folder for a setting the
/// mod does not declare, or one that is not a yes/no, is said and skipped.
fn conditional_folders(layer_dir: &Path, name: &str, layer: &str, settings: &[(String, String)]) -> Vec<(String, PathBuf)> {
    let Ok(rd) = fs::read_dir(layer_dir.join("when")) else { return Vec::new() };
    let mut keys: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    keys.sort();
    keys.into_iter()
        .filter_map(|folder| {
            let key = folder.file_name()?.to_string_lossy().to_string();
            (conditional_setting(name, layer, &key, settings) == Some(true)).then_some((key, folder))
        })
        .collect()
}

fn conditional_setting(name: &str, layer: &str, key: &str, settings: &[(String, String)]) -> Option<bool> {
    match settings.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str()) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => {
            eprintln!(
                "mods: {name} has {layer}/when/{key}/, but \"{key}\" is not a yes/no setting -- ignoring it"
            );
            None
        }
        None => {
            eprintln!(
                "mods: {name} has {layer}/when/{key}/, but its mod.json declares no setting \"{key}\" -- ignoring it"
            );
            None
        }
    }
}

fn copy_npc_layer(
    from: &Path,
    dst: &Path,
    name: &str,
    settings: &[(String, String)],
) -> Result<(), String> {
    let Ok(rd) = fs::read_dir(from) else { return Ok(()) };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let file = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        if file == "when" && path.is_dir() {
            continue;
        }
        let target = dst.join(&file);
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else {
            fs::create_dir_all(dst).map_err(|e| format!("creating {}: {e}", dst.display()))?;
            fs::copy(&path, &target).map_err(|e| format!("copying {}: {e}", path.display()))?;
        }
    }

    let when = from.join("when");
    let Ok(rd) = fs::read_dir(&when) else { return Ok(()) };
    let mut keys: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    keys.sort();
    for folder in keys {
        let key = folder.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
        if conditional_setting(name, "npc", &key, settings) != Some(true) {
            continue;
        }
        copy_tree(&folder, &dst.join("when").join(&key))?;
    }
    Ok(())
}

/// Where the player's answers live.
///
/// One file for every mod rather than a file inside each: a bundled mod's
/// folder sits in the runtime tree, which is replaced wholesale on update, and
/// `state/mods` only exists for mods the player installed. Neither is a place
/// a setting can survive.
pub fn settings_path(state: &Path) -> PathBuf {
    state.join("mod-settings.json")
}

/// Saved answers, as `{ "<mod>": { "<key>": value } }`. A damaged file is an
/// error rather than an excuse to silently hand every mod its defaults back.
pub fn read_settings(state: &Path) -> Result<BTreeMap<String, BTreeMap<String, String>>, String> {
    let path = settings_path(state);
    let body = match fs::read_to_string(&path) {
        Ok(body) => body,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(format!("mod settings could not be read: {e}")),
    };
    let value = crate::json::parse(&body).map_err(|e| format!("mod-settings.json is not valid JSON -- {e}"))?;
    let crate::json::Value::Object(mods) = &value else {
        return Err("mod-settings.json must be an object".into());
    };
    let mut out = BTreeMap::new();
    for (name, entries) in mods {
        let crate::json::Value::Object(entries) = entries else {
            return Err(format!("mod-settings.json: {name:?} must be an object"));
        };
        let mut values = BTreeMap::new();
        for (key, value) in entries {
            values.insert(key.clone(), value_json(value));
        }
        out.insert(name.clone(), values);
    }
    Ok(out)
}

fn value_json(value: &crate::json::Value) -> String {
    match value {
        crate::json::Value::Bool(v) => v.to_string(),
        crate::json::Value::Number(v) if v.fract() == 0.0 && v.is_finite() => format!("{}", *v as i64),
        crate::json::Value::Number(v) => format!("{v}"),
        crate::json::Value::String(v) => crate::json::quote(v),
        _ => "null".into(),
    }
}

/// A mod's effective settings: its declared defaults with the player's saved
/// answers applied over them, keeping only keys the mod still declares and only
/// values still matching the declared type. A mod that drops or retypes an
/// option therefore cannot be handed a stale value it no longer understands.
pub fn effective(manifest: &Manifest, saved: Option<&BTreeMap<String, String>>) -> Vec<(String, String)> {
    manifest
        .settings
        .iter()
        .map(|setting| {
            let fallback = setting.value.to_json();
            let chosen = saved
                .and_then(|values| values.get(&setting.key))
                .filter(|raw| matching_type(&setting.value, raw))
                .cloned()
                .unwrap_or(fallback);
            (setting.key.clone(), clamp(setting, chosen))
        })
        .collect()
}

fn matching_type(declared: &SettingValue, raw: &str) -> bool {
    match declared {
        SettingValue::Bool(_) => raw == "true" || raw == "false",
        SettingValue::Number(_) => raw.parse::<f64>().map(f64::is_finite).unwrap_or(false),
        SettingValue::Text(_) => raw.starts_with('"'),
    }
}

/// Bounds are the mod's, so a hand-edited file cannot hand it a number it said
/// it could not take, or a string longer than it asked for.
fn clamp(setting: &Setting, raw: String) -> String {
    match &setting.value {
        SettingValue::Number(_) => match raw.parse::<f64>() {
            Ok(v) if v.is_finite() => SettingValue::Number(v.clamp(setting.min, setting.max)).to_json(),
            _ => setting.value.to_json(),
        },
        SettingValue::Text(_) => {
            let limit = setting.max as usize;
            match crate::json::parse(&raw) {
                Ok(crate::json::Value::String(v)) if v.chars().count() <= limit => raw,
                Ok(crate::json::Value::String(v)) => {
                    crate::json::quote(&v.chars().take(limit).collect::<String>())
                }
                _ => setting.value.to_json(),
            }
        }
        SettingValue::Bool(_) => raw,
    }
}

/// Read a mod's `conf/` layer, keeping only what the allowlist covers.
fn read_conf(
    dir: &Path,
    name: &str,
    settings: &[(String, String)],
    out: &mut BTreeMap<String, Vec<(String, String)>>,
) {
    // After the mod's own copy, so an option adds to the file it belongs to.
    let conditional = conditional_conf(dir, name, settings);
    read_plain_conf(dir, name, out);
    for (label, file, body) in conditional {
        out.entry(format!("file:{file}")).or_default().push((label, body));
    }
}

fn read_plain_conf(dir: &Path, name: &str, out: &mut BTreeMap<String, Vec<(String, String)>>) {
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
#[derive(Clone, Debug, PartialEq)]
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
    /// The folders its layers are read from, in the order they are applied:
    /// the mod's own, then the running era's folder when it declares one, so
    /// the era's copy of a file wins. Every layer -- server and client --
    /// reads these rather than `dir`, which is what keeps the two in step.
    pub roots: Vec<PathBuf>,
}

impl Installed {
    /// The roots of a mod in the given era: its folder, then its era folder.
    fn era_roots(dir: &Path, manifest: &Manifest, prerenewal: bool, client: Option<&str>) -> Vec<PathBuf> {
        let era = if prerenewal { &manifest.prerenewal_folder } else { &manifest.renewal_folder };
        let mut roots = vec![dir.to_path_buf()];
        if !era.is_empty() {
            roots.push(dir.join(era));
        }
        // The client's folder last, so its copy of a file wins over both.
        if let Some(client) = client {
            for (name, folder) in &manifest.client_folders {
                if name.eq_ignore_ascii_case(client) {
                    roots.push(dir.join(folder));
                }
            }
        }
        roots
    }

    /// Every folder the mod could read from, in any era or client: for the
    /// checks drawn for mods that are off, where switching era is one click.
    fn all_roots(&self) -> Vec<PathBuf> {
        let mut roots = vec![self.dir.clone()];
        for era in [&self.manifest.renewal_folder, &self.manifest.prerenewal_folder] {
            if !era.is_empty() {
                roots.push(self.dir.join(era));
            }
        }
        for (_, folder) in &self.manifest.client_folders {
            roots.push(self.dir.join(folder));
        }
        roots
    }

    /// Whether this mod decides what commands players may use.
    ///
    /// `groups.yml` and `atcommands.yml` are the two files a mod may supply
    /// whole, and between them they say which atcommands each player group
    /// gets. That is a bigger grant than the rest of the conf allowlist, and
    /// it is not visible in a description the mod wrote about itself -- so the
    /// Settings window says it, next to the checkbox, rather than the player
    /// finding out by being surprised later.
    ///
    /// Read from the folder rather than from an assembled layer, because the
    /// list is drawn for mods that are switched *off* too, and nothing has
    /// been assembled for those.
    pub fn grants_commands(&self) -> bool {
        let whole = |dir: &Path| CONF_WHOLE_FILE.iter().any(|f| dir.join(f).is_file());
        // A grant behind one of the mod's own options is still a grant, and so
        // is one only the other era (or another client) would apply.
        self.all_roots().iter().any(|root| {
            let conf = root.join("conf");
            whole(&conf)
                || fs::read_dir(conf.join("when"))
                    .map(|rd| rd.flatten().any(|e| whole(&e.path())))
                    .unwrap_or(false)
        })
    }
}

/// The folders whose files reach the game window rather than the server:
/// assets, client Lua tables, music and a roBrowser plugin.
const CLIENT_LAYERS: [&str; 4] = ["data", "System", "BGM", "client"];

impl Installed {
    /// Whether switching this mod or changing its options changes what the
    /// game window loads, so the game has to be reopened after Apply. A mod
    /// that only has server layers (db/, npc/, conf/, lua/) takes effect with
    /// the server restart alone.
    ///
    /// Read from the folder, like `grants_commands`, and from both era
    /// folders: the list is drawn for mods that are off, and switching era is
    /// one click.
    pub fn has_client_layers(&self) -> bool {
        self.all_roots().iter().any(|root| CLIENT_LAYERS.iter().any(|layer| root.join(layer).is_dir()))
    }

    /// Whether the mod has the map server load scripts: its own `npc/`, or
    /// stock ones named in `stock-npc.txt`. Server-side, except that with
    /// navigation-server-npcs on they reach the client's NPC table too.
    pub fn has_npc_layers(&self) -> bool {
        self.roots.iter().any(|root| root.join("npc").is_dir() || root.join("stock-npc.txt").is_file())
    }

    /// Whether the mod changes one `db/` table, directly or behind a setting.
    pub fn has_db_table(&self, table: &str) -> bool {
        self.roots.iter().any(|root| {
            let db = root.join("db");
            db.join(table).is_file()
                || fs::read_dir(db.join("when"))
                    .map(|rd| rd.flatten().any(|e| e.path().join(table).is_file()))
                    .unwrap_or(false)
        })
    }
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
    let client = detected_client(&cfg.state);

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
                if problem.is_none() {
                    if let Err(e) = client_requirement_met(&m.requires_client, client.as_deref()) {
                        problem = Some(e);
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
        let roots = Installed::era_roots(&dir, &manifest, prerenewal, client.as_deref());
        out.push(Installed { name, dir, status, manifest, bundled, roots });
    }

    // One skin, one cursor pack. `enable` keeps the lists that way, but a
    // folder dropped in by hand is on by default, so two of a kind can still
    // both be on here. The one the player chose wins -- named in enabled.txt
    // -- and otherwise the last in name order, the one whose files would have
    // won anyway. The others read as switched off, which is what they are.
    for kind in KINDS {
        let on: Vec<usize> = (0..out.len())
            .filter(|&i| out[i].status == Status::On && out[i].manifest.kind == *kind)
            .collect();
        let keep = on
            .iter()
            .rev()
            .find(|&&i| enabled.contains(&out[i].name))
            .or(on.last())
            .copied();
        for i in on {
            if Some(i) != keep {
                out[i].status = Status::Off;
            }
        }
    }

    // A second pass, because a requirement can name a mod the first pass had
    // not reached yet. Only a mod that is actually on can satisfy one: a
    // dependency switched off is as absent as one never installed, and the
    // difference is worth saying out loud to whoever has to fix it.
    let present: BTreeMap<String, bool> = out
        .iter()
        .map(|m| (m.name.clone(), m.status == Status::On))
        .collect();
    for m in &mut out {
        if m.status != Status::On {
            continue;
        }
        let missing: Vec<String> = m
            .manifest
            .requires_mods
            .iter()
            .filter(|name| present.get(name.as_str()) != Some(&true))
            .map(|name| match present.contains_key(name.as_str()) {
                true => format!("{name} is installed but switched off"),
                false => format!("{name} is not installed"),
            })
            .collect();
        if !missing.is_empty() {
            m.status = Status::Refused(format!("needs {}", missing.join(", ")));
        }
    }
    out
}

/// Whether a folder's `mod.json` is one this build would read, and its
/// version. A folder with no manifest is refused here even though `scan`
/// accepts one: this is asked about a release that was published *as* a mod,
/// and one that lost its manifest is a broken release rather than a bare
/// folder somebody dropped in.
pub fn check_dir(dir: &Path) -> Result<String, String> {
    match read_manifest(dir)? {
        Some(m) => Ok(m.version),
        None => Err("it has no mod.json".into()),
    }
}

/// The mods that are switched on, in scan order.
pub fn enabled(cfg: &Config) -> Vec<Installed> {
    scan(cfg).into_iter().filter(|m| m.status == Status::On).collect()
}

/// The mods `assemble` applies to the server, in the order it applies them:
/// `apply_order`, without any caught in an `after` loop. For anything that
/// has to merge server tables the way the server's import does (navmob.rs).
pub fn applied(cfg: &Config) -> Vec<Installed> {
    let mut live = enabled(cfg);
    sort_applied(&mut live);
    live
}

/// Sort switched-on mods into `apply_order`, dropping the ones in an `after`
/// loop, whose names are returned.
fn sort_applied<M: std::borrow::Borrow<Installed>>(live: &mut Vec<M>) -> Vec<String> {
    let declared: Vec<(String, Vec<String>)> = live
        .iter()
        .map(|m| (m.borrow().name.clone(), m.borrow().manifest.after.clone()))
        .collect();
    match apply_order(&declared) {
        Ok(order) => {
            let rank: BTreeMap<&str, usize> =
                order.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
            live.sort_by_key(|m| rank.get(m.borrow().name.as_str()).copied().unwrap_or(usize::MAX));
            Vec::new()
        }
        Err(cycle) => {
            live.retain(|m| !cycle.contains(&m.borrow().name));
            cycle
        }
    }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    copy_tree_owned(src, dst, "", None, &mut BTreeMap::new(), &mut Vec::new())
}

/// Copy a tree, and optionally record which mod each file came from.
///
/// The recording exists for one reason: two mods that both ship
/// `db/mob_db.yml` resolve last-wins by name order, quietly, and the player has
/// no way to tell that half of what they installed is not in effect. The
/// The line `label` sits on, as (start of that line, start of the next).
///
/// Matched at column zero and on the whole line, because `Body:` also appears
/// indented inside rAthena's own comment blocks and as a value elsewhere.
fn section(text: &str, label: &str) -> Option<(usize, usize)> {
    let mut at = 0usize;
    for line in text.split_inclusive('\n') {
        if line.trim_end_matches(['\n', '\r']) == label {
            return Some((at, at + line.len()));
        }
        at += line.len();
    }
    None
}

/// The `Type:` a table declares in its header, which is what says two files
/// are the same kind of table rather than merely the same filename.
fn header_type(text: &str) -> Option<String> {
    let (_, after) = section(text, "Header:")?;
    for line in text[after..].split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // The header block is indented; the first unindented line ends it.
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Type:") {
            return Some(value.trim().to_string());
        }
    }
    None
}

/// Whether a table's header asks rAthena to empty the database before reading
/// it -- `Header: Clear: true`, which rAthena honours for every YAML database
/// (`YamlDatabase::load`, src/common/database.cpp). It is how a mod says "this
/// table is mine outright" rather than "add these entries to it".
fn header_clears(text: &str) -> bool {
    let Some((_, after)) = section(text, "Header:") else {
        return false;
    };
    for line in text[after..].split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Clear:") {
            return value.trim().eq_ignore_ascii_case("true");
        }
    }
    false
}

/// Put `Clear: true` into a header that does not have it, keeping the
/// indentation the file already uses.
fn add_header_clear(text: &str) -> Option<String> {
    let (_, after) = section(text, "Header:")?;
    let indent = text[after..]
        .split_inclusive('\n')
        .find(|line| !line.trim().is_empty())
        .map(|line| &line[..line.len() - line.trim_start().len()])
        .filter(|indent| !indent.is_empty())
        .unwrap_or("  ")
        .to_string();
    Some(format!("{}{indent}Clear: true\n{}", &text[..after], &text[after..]))
}

/// Combine two mods' copies of the same rAthena table.
///
/// Two mods that both add an item each ship `db/item_db.yml`, and merging them
/// by filename means one of them silently does not exist. rAthena itself has
/// no such problem -- it reads a list of files and applies them in order, so
/// entries accumulate and only a repeated key is a contest. This produces the
/// file it would have read: one header, both bodies, the later mod's entries
/// last so a repeated id resolves the way the load order says.
///
/// `None` when the two are not the same kind of table, or either lacks a
/// `Body:` -- then there is nothing safe to combine and the caller says so
/// rather than guessing.
fn merge_tables(existing: &str, incoming: &str) -> Option<String> {
    if header_type(existing)? != header_type(incoming)? {
        return None;
    }
    // The merged file keeps the first header, so a later mod's `Clear: true`
    // would be dropped and its table would quietly become an addition to the
    // one it meant to replace. Carry it across instead: clearing is the
    // stronger statement, and both mods' entries still survive it.
    let existing = if header_clears(incoming) && !header_clears(existing) {
        add_header_clear(existing)?
    } else {
        existing.to_string()
    };
    let existing = existing.as_str();
    let (_, incoming_body) = section(incoming, "Body:")?;
    // A Footer carries `Imports:`, which names other files rather than holding
    // entries. Keeping the first file's and dropping the rest is right: the
    // paths in it are the server's own, identical in every copy.
    let incoming_end = section(incoming, "Footer:").map_or(incoming.len(), |(start, _)| start);
    let body = incoming[incoming_body..incoming_end].trim_matches(['\n', '\r']);
    if body.trim().is_empty() {
        return Some(existing.to_string());
    }
    section(existing, "Body:")?;
    let insert = section(existing, "Footer:").map_or(existing.len(), |(start, _)| start);

    let mut out = String::with_capacity(existing.len() + body.len() + 2);
    out.push_str(existing[..insert].trim_end_matches(['\n', '\r']));
    out.push('\n');
    out.push_str(body);
    out.push('\n');
    out.push_str(&existing[insert..]);
    Some(out)
}

/// supervisor knows -- it is doing the overwriting -- so it says so.
fn copy_tree_owned(
    src: &Path,
    dst: &Path,
    rel: &str,
    owner: Option<&str>,
    seen: &mut BTreeMap<String, String>,
    clashes: &mut Vec<(String, String)>,
) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let to = dst.join(e.file_name());
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        // `db/when/<key>/` is a part of the mod behind one of its switches,
        // not a folder rAthena reads; assemble copies the chosen ones itself.
        if owner.is_some() && rel.is_empty() && name == "when" && from.is_dir() {
            continue;
        }
        if from.is_dir() {
            copy_tree_owned(&from, &to, &child, owner, seen, clashes)?;
        } else {
            let Some(owner) = owner else {
                let _ = fs::copy(&from, &to);
                continue;
            };
            // Whoever had it before, if it was a mod rather than the stub this
            // tree was seeded with.
            let before = seen.insert(child.clone(), owner.to_string());
            let Some(before) = before.filter(|before| before != owner) else {
                let _ = fs::copy(&from, &to);
                continue;
            };

            // Two mods, one table. rAthena would have read both files and
            // accumulated their entries; merging by filename instead means one
            // of them silently does not exist, which is #98.
            let merged = match (fs::read_to_string(&to), fs::read_to_string(&from)) {
                (Ok(existing), Ok(incoming)) => merge_tables(&existing, &incoming),
                _ => None,
            };
            match merged {
                Some(body) => {
                    fs::write(&to, body)
                        .map_err(|e| format!("merging {child} into {}: {e}", to.display()))?;
                    println!("mods: {child}: {owner}'s entries added after {before}'s");
                }
                // Not two tables of the same kind, or not a shape with entries
                // to combine -- a font, a cache, a mismatched Type. Last name
                // still wins, but nobody has to find that out from a log.
                None => {
                    let _ = fs::copy(&from, &to);
                    let message = format!(
                        "db/{child} is also supplied by {owner}, and the two could not be \
                         combined, so only {owner}'s copy is in effect."
                    );
                    eprintln!("mods: {before}: {message}");
                    clashes.push((before, message));
                }
            }
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
    let mut live: Vec<&Installed> = installed.iter().filter(|m| m.status == Status::On).collect();

    // The order layers are applied in, which is what decides who wins a
    // repeated key. Alphabetical unless a mod asked to come later.
    let cycle = sort_applied(&mut live);
    // A loop cannot be ordered, so none of the mods in it are applied.
    // Naming the ring is the only useful thing to say about it.
    let names = cycle.join(", ");
    for name in &cycle {
        out.refused.push((
            name.clone(),
            format!("\"after\" forms a loop with {names}, so none of them were applied"),
        ));
    }

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
    for (m, data) in live.iter().flat_map(|m| m.roots.iter().map(move |r| (m, r.join("data")))) {
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

    // Lua skill hooks ride the same db/import mount (see write_lua_layer), so
    // a mod with only lua/ still needs it.
    let has = |layer: &str| live.iter().any(|m| m.roots.iter().any(|r| r.join(layer).is_dir()));
    let wants_lua = has("lua");
    let wants_db = !maps.is_empty() || wants_lua || has("db");
    // The player's answers decide which of a mod's conditional fragments
    // are part of it. A damaged answers file is said, and every mod then gets
    // its declared defaults rather than the server refusing to start.
    let saved = read_settings(&cfg.state).unwrap_or_else(|e| {
        eprintln!("mods: {e}");
        BTreeMap::new()
    });

    if wants_db {
        let dst = build.join("db");
        seed_db_import(cfg, &dst)?;
        let mut owners: BTreeMap<String, String> = BTreeMap::new();
        let mut clashes: Vec<(String, String)> = Vec::new();
        for m in &live {
            // The era folder after the mod's own, under the same owner: its
            // copy of a table replaces the mod's rather than merging with it.
            for root in &m.roots {
                let from = root.join("db");
                if from.is_dir() {
                    copy_tree_owned(&from, &dst, "", Some(&m.name), &mut owners, &mut clashes)?;
                }
            }
            // Then the parts behind the mod's own switches. Owned as
            // "<mod>/<key>", so a part's table is added to the mod's own copy
            // of it rather than replacing it.
            let settings = effective(&m.manifest, saved.get(&m.name));
            for root in &m.roots {
                for (key, folder) in conditional_folders(&root.join("db"), &m.name, "db", &settings) {
                    let owner = format!("{}/{key}", m.name);
                    copy_tree_owned(&folder, &dst, "", Some(&owner), &mut owners, &mut clashes)?;
                }
            }
        }
        let named: Vec<(&str, &Path)> = live
            .iter()
            .flat_map(|m| m.roots.iter().map(move |r| (m.name.as_str(), r.as_path())))
            .collect();
        clashes.extend(id_collisions(&named));
        clashes.extend(vendor_ownership(&named));
        write_clashes(&dst, &clashes);
        if !maps.is_empty() {
            write_map_layer(&dst, &maps)?;
            out.maps = maps.iter().map(|m| m.name.clone()).collect();
            out.map_lines = maps.iter().map(|m| format!("map: {}\n", m.name)).collect();
        }
        // Kept beside the merged tree, because after this nothing about a file
        // in it says which mod put it there -- and that is what a complaint
        // from the server has to be attributed to.
        write_owners(&dst, &owners);
        out.db = Some(dst);
    }

    if wants_lua {
        let mods: Vec<(&str, &[PathBuf], &Manifest, Vec<(String, String)>)> = live
            .iter()
            .map(|m| (m.name.as_str(), m.roots.as_slice(), &m.manifest, effective(&m.manifest, saved.get(&m.name))))
            .collect();
        write_lua_layer(&build.join("db"), &mods)?;
    }

    // Stock scripts first, so a mod's own can duplicate or disable them.
    let mut stock: Vec<String> = Vec::new();
    for m in &live {
        for root in &m.roots {
            read_stock_npc(root, &m.name, &mut stock);
        }
    }
    let mut lines: String = stock.iter().map(|p| format!("npc: {p}\n")).collect();
    if !stock.is_empty() {
        println!("stock scripts: {}", stock.len());
    }
    // Then F_ModSetting, so any mod's script can read its settings. Written
    // only when some mod ships scripts, since nothing else could call it. A
    // file directly in npc/, not a folder, so it cannot collide with a mod's.
    if has("npc") {
        let values: Vec<(String, Vec<(String, ScriptValue)>)> = live
            .iter()
            .map(|m| (m.name.clone(), script_values(&m.manifest, &effective(&m.manifest, saved.get(&m.name)))))
            .collect();
        fs::create_dir_all(build.join("npc")).map_err(|e| format!("mods: npc build folder: {e}"))?;
        fs::write(build.join("npc").join(SETTINGS_SCRIPT), settings_script(&values))
            .map_err(|e| format!("mods: {SETTINGS_SCRIPT}: {e}"))?;
        lines.push_str(&format!("npc: npc/mods/{SETTINGS_SCRIPT}\n"));
    }
    for m in &live {
        if !m.roots.iter().any(|r| r.join("npc").is_dir()) {
            continue;
        }
        let dst = build.join("npc").join(&m.name);
        let settings = effective(&m.manifest, saved.get(&m.name));
        // One folder per mod: the era folder's scripts are copied over the
        // mod's own, so a script of the same name replaces it.
        for root in &m.roots {
            copy_npc_layer(&root.join("npc"), &dst, &m.name, &settings)?;
        }
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
        let settings = effective(&m.manifest, saved.get(&m.name));
        for root in &m.roots {
            read_conf(root, &m.name, &settings, &mut out.conf);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Settings, for scripts
// ---------------------------------------------------------------------------

/// The generated script that lets an NPC read its mod's settings:
///
/// ```text
/// .@set$  = callfunc("F_ModSetting", "standart-npc", "buffer_set", "");
/// .@rate  = callfunc("F_ModSetting", "standart-npc", "gramps_rate", 1);
/// ```
///
/// Booleans arrive as 1 or 0 and numbers as whole numbers, because rAthena
/// scripts have no other kind; strings arrive as strings. A mod or key that is
/// not there returns the optional fourth argument, so a script can say what
/// it wants instead of guessing what "nothing" is for its type.
pub const SETTINGS_SCRIPT: &str = "mod-settings.txt";

#[derive(Debug, Clone, PartialEq)]
pub enum ScriptValue {
    Int(i64),
    Text(String),
}

/// The values `effective` settled on, in the types a script can hold.
fn script_values(manifest: &Manifest, values: &[(String, String)]) -> Vec<(String, ScriptValue)> {
    manifest
        .settings
        .iter()
        .zip(values)
        .map(|(setting, (key, raw))| {
            let value = match &setting.value {
                SettingValue::Bool(_) => ScriptValue::Int(i64::from(raw == "true")),
                // Truncated toward zero and kept inside rAthena's 32-bit int,
                // which is what older script engines still use.
                SettingValue::Number(_) => {
                    let n = raw.parse::<f64>().unwrap_or(0.0);
                    let n = if n.is_finite() { n.trunc() } else { 0.0 };
                    ScriptValue::Int(n.clamp(i32::MIN as f64, i32::MAX as f64) as i64)
                }
                SettingValue::Text(_) => ScriptValue::Text(match json::parse(raw) {
                    Ok(json::Value::String(text)) => text,
                    _ => String::new(),
                }),
            };
            (key.clone(), value)
        })
        .collect()
}

/// A string as an rAthena script literal.
///
/// This is the one place a value somebody typed ends up *inside* a script, so
/// it is the one place that must not be able to end the string early: a quote
/// or backslash is escaped, and anything that is not printable -- newlines
/// included, which would end the line the literal is on -- becomes a space.
fn script_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn settings_script(mods: &[(String, Vec<(String, ScriptValue)>)]) -> String {
    let mut out = String::from(
        "//===== Ragnarok Offline ====================================\n\
         //= Mod settings, for scripts. Written on every server start from\n\
         //= the answers in Settings -> Mods; do not edit, it is replaced.\n\
         //=\n\
         //=   callfunc(\"F_ModSetting\", \"<mod>\", \"<key>\" {, <if missing>})\n\
         //============================================================\n\
         function\tscript\tF_ModSetting\t{\n\
         \t.@mod$ = getarg(0);\n\
         \t.@key$ = getarg(1);\n",
    );
    for (name, values) in mods {
        if values.is_empty() {
            continue;
        }
        out.push_str(&format!("\tif (.@mod$ == {}) {{\n", script_string(name)));
        for (key, value) in values {
            let literal = match value {
                ScriptValue::Int(n) => n.to_string(),
                ScriptValue::Text(t) => script_string(t),
            };
            out.push_str(&format!("\t\tif (.@key$ == {}) return {literal};\n", script_string(key)));
        }
        out.push_str("\t}\n");
    }
    out.push_str(
        "\tif (getargcount() > 2) return getarg(2);\n\
         \tdebugmes \"F_ModSetting: \" + .@mod$ + \" has no setting \" + .@key$ + \" (pass a fourth argument to say what to use instead)\";\n\
         \treturn 0;\n\
         }\n",
    );
    out
}

// ---------------------------------------------------------------------------
// Lua skill hooks
// ---------------------------------------------------------------------------

/// The settings file every mod's Lua can read, through `setting()`.
pub const LUA_SETTINGS: &str = "mod-settings.lua";

/// A mod's `lua/` folder, laid out for the map server.
///
/// The server (our rAthena fork, `src/map/skill_lua.cpp`) runs the files that
/// `db/import/lua/load.txt` lists, in its order, so that is written here in
/// mod order -- the same order that decides who wins in `db/` -- with each
/// mod's files alphabetical within it. `mod-settings.lua` goes first, so a
/// file can read its settings while it loads.
///
/// Inside `db/import` rather than a mount of its own: the map server already
/// has that folder, and a server that is not ours simply never looks there.
fn write_lua_layer(db: &Path, mods: &[(&str, &[PathBuf], &Manifest, Vec<(String, String)>)]) -> Result<(), String> {
    let lua = db.join("lua");
    fs::create_dir_all(&lua).map_err(|e| format!("mods: lua build folder: {e}"))?;

    let mut settings = String::from(
        "-- Written by Ragnarok Offline on every server start, from Settings -> Mods.\n\
         -- Do not edit; it is replaced. Read it with setting(\"<mod>\", \"<key>\", <if missing>).\n\
         MOD_SETTINGS = {\n",
    );
    for (name, _, manifest, values) in mods {
        if values.is_empty() {
            continue;
        }
        settings.push_str(&format!("  [{}] = {{\n", lua_string(name)));
        for (setting, (key, raw)) in manifest.settings.iter().zip(values) {
            settings.push_str(&format!("    [{}] = {},\n", lua_string(key), lua_value(&setting.value, raw)));
        }
        settings.push_str("  },\n");
    }
    settings.push_str("}\n");
    fs::write(lua.join(LUA_SETTINGS), settings).map_err(|e| format!("mods: {LUA_SETTINGS}: {e}"))?;

    let mut list = format!(
        "# Written by Ragnarok Offline: <mod><TAB><file under db/import>, run in this order.\n-\tlua/{LUA_SETTINGS}\n"
    );
    for (name, roots, _, values) in mods {
        if !roots.iter().any(|r| r.join("lua").is_dir()) {
            continue;
        }
        // The era folder's lua/ over the mod's own, so its file replaces one
        // of the same name.
        let dst = lua.join(name);
        for root in roots.iter() {
            let from = root.join("lua");
            if from.is_dir() {
                copy_tree(&from, &dst)?;
            }
        }
        collect_lua(&dst, &format!("lua/{name}"), name, true, &mut list);
        // Then the parts behind the mod's switches, each loaded as a mod of
        // its own -- "<mod>/<key>" -- because the engine keeps one hook per
        // mod for a skill: a mod that registers NJ_KAENSIN twice replaces its
        // first registration. Two parts of one mod hooking the same skill
        // have to chain like two mods, or the second silently wins.
        for (key, _) in conditional_folders(&dst, name, "lua", values) {
            let owner = format!("{name}/{key}");
            collect_lua(&dst.join("when").join(&key), &format!("lua/{name}/when/{key}"), &owner, false, &mut list);
        }
    }
    fs::write(lua.join("load.txt"), list).map_err(|e| format!("mods: lua load.txt: {e}"))
}

/// Every `.lua` file under `dir`, in name order, as `load.txt` lines owned by
/// `name`. `skip_when` leaves out the top-level `when/` folder, whose parts
/// are only loaded when their setting is on.
fn collect_lua(dir: &Path, prefix: &str, name: &str, skip_when: bool, out: &mut String) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let Some(file) = p.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        if p.is_dir() {
            if skip_when && file == "when" {
                continue;
            }
            collect_lua(&p, &format!("{prefix}/{file}"), name, false, out);
        } else if p.extension().map(|x| x == "lua").unwrap_or(false) {
            out.push_str(&format!("{name}\t{prefix}/{file}\n"));
        }
    }
}

/// A setting as a Lua value. Unlike the NPC script version, Lua has real
/// booleans and fractions, so a checkbox is `true`/`false` (0 would be truthy
/// in Lua) and 1.5 stays 1.5.
fn lua_value(declared: &SettingValue, raw: &str) -> String {
    match declared {
        SettingValue::Bool(_) => (raw == "true").to_string(),
        SettingValue::Number(_) => {
            let n = raw.parse::<f64>().ok().filter(|n| n.is_finite()).unwrap_or(0.0);
            if n.fract() == 0.0 && n.abs() < 9.0e15 { format!("{}", n as i64) } else { format!("{n}") }
        }
        SettingValue::Text(_) => lua_string(&match json::parse(raw) {
            Ok(json::Value::String(text)) => text,
            _ => String::new(),
        }),
    }
}

/// A Lua string literal. As with `script_string`, this is where text somebody
/// typed lands inside code, so nothing in it can end the literal: quotes and
/// backslashes are escaped and control characters become `\ddd`.
fn lua_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\{:03}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
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

/// The scripts a mod has the map server load, for the navigation table
/// (navnpc.rs): the stock ones its `stock-npc.txt` names, and its own `.txt`
/// files as `assemble` lays them down -- every root, a later root's file
/// replacing an earlier one of the same path, and a `when/<setting>/` folder
/// only while that setting is on.
pub fn npc_sources(cfg: &Config, m: &Installed) -> Result<(Vec<String>, Vec<PathBuf>), String> {
    fn walk(dir: &Path, rel: &str, top: bool, out: &mut BTreeMap<String, PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            if top && name == "when" && path.is_dir() {
                continue;
            }
            let rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if path.is_dir() {
                walk(&path, &rel, false, out);
            } else if name.ends_with(".txt") {
                out.insert(rel, path);
            }
        }
    }
    let saved = read_settings(&cfg.state)?;
    let settings = effective(&m.manifest, saved.get(&m.name));
    let mut stock = Vec::new();
    let mut files = BTreeMap::new();
    for root in &m.roots {
        read_stock_npc(root, &m.name, &mut stock);
        let npc = root.join("npc");
        walk(&npc, "", true, &mut files);
        for (key, folder) in conditional_folders(&npc, &m.name, "npc", &settings) {
            walk(&folder, &format!("when/{key}"), false, &mut files);
        }
    }
    Ok((stock, files.into_values().collect()))
}

/// A mod's copies of one `db/` table, in the order `assemble` merges them:
/// the last root's own copy (an era folder's replaces the mod's, as they share
/// an owner), then every root's `when/<setting>/` copies while that setting is
/// on, which are merged into it. For the navigation monster table (navmob.rs),
/// which reads mob_db.yml the way the server's import does.
pub fn db_sources(cfg: &Config, m: &Installed, table: &str) -> Result<Vec<PathBuf>, String> {
    let saved = read_settings(&cfg.state)?;
    let settings = effective(&m.manifest, saved.get(&m.name));
    let mut out: Vec<PathBuf> =
        m.roots.iter().map(|r| r.join("db").join(table)).filter(|p| p.is_file()).last().into_iter().collect();
    for root in &m.roots {
        for (_, folder) in conditional_folders(&root.join("db"), &m.name, "db", &settings) {
            if folder.join(table).is_file() {
                out.push(folder.join(table));
            }
        }
    }
    Ok(out)
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

/// The options a mod declares, each with the value actually in force, for the
/// settings window to render without knowing anything about the mod.
fn settings_json(manifest: &Manifest, saved: Option<&BTreeMap<String, String>>) -> String {
    if manifest.settings.is_empty() {
        return String::from("[]");
    }
    let values = effective(manifest, saved);
    let entries: Vec<String> = manifest
        .settings
        .iter()
        .zip(values.iter())
        .map(|(setting, (_, value))| {
            let mut fields = vec![
                format!("\"key\":{}", crate::json::quote(&setting.key)),
                format!("\"label\":{}", crate::json::quote(&setting.label)),
                format!("\"description\":{}", crate::json::quote(&setting.description)),
                format!("\"type\":{}", crate::json::quote(setting.value.type_name())),
                format!("\"value\":{value}"),
            ];
            match &setting.value {
                SettingValue::Number(_) => {
                    if setting.min > f64::MIN {
                        fields.push(format!("\"min\":{}", SettingValue::Number(setting.min).to_json()));
                    }
                    if setting.max < f64::MAX {
                        fields.push(format!("\"max\":{}", SettingValue::Number(setting.max).to_json()));
                    }
                }
                SettingValue::Text(_) => {
                    fields.push(format!("\"maxLength\":{}", SettingValue::Number(setting.max).to_json()))
                }
                SettingValue::Bool(_) => {}
            }
            format!("{{{}}}", fields.join(","))
        })
        .collect();
    format!("[{}]", entries.join(","))
}

/// Record the player's answers for one mod, keeping only options it declares
/// and only values of the type it declared. Writing is whole-file and atomic:
/// a partial answer set would silently reset the options it omitted.
pub fn save_settings(cfg: &Config, name: &str, body: &str) -> Result<(), String> {
    let Some(installed) = scan(cfg).into_iter().find(|m| m.name == name) else {
        return Err(format!("no mod named {name:?} is installed"));
    };
    if installed.manifest.settings.is_empty() {
        return Err(format!("{name} declares no settings"));
    }
    let value = crate::json::parse(body).map_err(|e| format!("settings are not valid JSON -- {e}"))?;
    let crate::json::Value::Object(given) = &value else {
        return Err("settings must be a JSON object".into());
    };
    let mut chosen = BTreeMap::new();
    for setting in &installed.manifest.settings {
        let Some(raw) = given.get(&setting.key) else { continue };
        let encoded = value_json(raw);
        if !matching_type(&setting.value, &encoded) {
            return Err(format!(
                "{}: {:?} expects {}",
                name,
                setting.key,
                setting.value.type_name()
            ));
        }
        chosen.insert(setting.key.clone(), clamp(setting, encoded));
    }
    let mut all = read_settings(&cfg.state)?;
    all.insert(name.to_string(), chosen);
    write_settings(&cfg.state, &all)
}

/// The whole of `mod-settings.json`, written to a scratch file and renamed
/// over the old one, so a crash mid-write leaves the previous answers intact.
fn write_settings(state: &Path, all: &BTreeMap<String, BTreeMap<String, String>>) -> Result<(), String> {
    let document = all
        .iter()
        .map(|(mod_name, values)| {
            let inner = values
                .iter()
                .map(|(key, value)| format!("    {}: {value}", crate::json::quote(key)))
                .collect::<Vec<_>>()
                .join(",\n");
            format!("  {}: {{\n{inner}\n  }}", crate::json::quote(mod_name))
        })
        .collect::<Vec<_>>()
        .join(",\n");
    let path = settings_path(state);
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, format!("{{\n{document}\n}}\n"))
        .map_err(|e| format!("writing mod settings: {e}"))?;
    fs::rename(&temporary, &path).map_err(|e| format!("publishing mod settings: {e}"))
}

/// Where the last start's verdict on the mods' tables is kept.
///
/// Beside `mod-settings.json` rather than inside `modbuild`, which is deleted
/// and rebuilt on every start: the report has to outlive the run that produced
/// it, because Settings is usually read with the server stopped.
fn report_path(state: &Path) -> PathBuf {
    state.join("mod-load-report.json")
}

/// Which mod supplied each file under `db/import`, written where the next
/// command can read it.
///
/// `assemble` is the only place that knows this -- afterwards the files are
/// merged into one tree and nothing about them says where they came from.
fn write_owners(dst: &Path, owners: &BTreeMap<String, String>) {
    let mut body = String::new();
    for (file, owner) in owners {
        body.push_str(&format!("{}\t{}\n", one_line(file), one_line(owner)));
    }
    let _ = fs::write(dst.join(OWNERS_FILE), body);
}

fn read_owners(db: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(body) = fs::read_to_string(db.join(OWNERS_FILE)) else {
        return out;
    };
    for line in body.lines() {
        if let Some((file, owner)) = line.split_once('\t') {
            out.insert(file.to_string(), owner.to_string());
        }
    }
    out
}

const OWNERS_FILE: &str = ".owners.tsv";
const CLASHES_FILE: &str = ".clashes.tsv";

/// Collisions that could not be merged, kept until the report is written.
///
/// Known while the tree is being built, said after the server starts, so both
/// kinds of trouble with a mod's tables reach Settings by the same road.
/// The id namespaces two mods can collide in: every item table is one
/// namespace (rAthena reads item_db.yml and the item_db_*.yml files into the
/// same table), and monsters are another.
fn id_namespace(file: &str) -> Option<&'static str> {
    let lower = file.to_lowercase();
    if lower == "mob_db.yml" {
        Some("monster")
    } else if lower.starts_with("item_db") && lower.ends_with(".yml") {
        Some("item")
    } else {
        None
    }
}

/// Ids in a table's Body: the entries at the top level, `  - Id: <n>`.
/// Nested lists (Drops, Requires) do not start with `Id:` at that indent.
fn table_ids(body: &str) -> Vec<u64> {
    body.lines()
        .filter_map(|line| line.strip_prefix("  - Id:"))
        .filter_map(|rest| rest.trim().parse().ok())
        .collect()
}

/// Two enabled mods that define the same monster or item id.
///
/// Their tables are combined (see copy_tree_owned), and rAthena applies the
/// entries in mod order, so the later mod's fields win over the earlier's for
/// that id -- usually two authors who both picked 25001, not a decision anyone
/// made. Reported under the mod whose definition loses, the same way as a
/// table that could not be combined. One mod changing a *stock* id is normal
/// and not reported; two mods changing the same one are, since their fields
/// mix.
fn id_collisions(mods: &[(&str, &Path)]) -> Vec<(String, String)> {
    let mut owner: BTreeMap<(&'static str, u64), String> = BTreeMap::new();
    let mut found: BTreeMap<(String, String, &'static str), Vec<u64>> = BTreeMap::new();
    for (name, dir) in mods {
        let Ok(rd) = fs::read_dir(dir.join("db")) else { continue };
        let mut files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        files.sort();
        let mut mine: BTreeMap<(&'static str, u64), ()> = BTreeMap::new();
        for file in files {
            let Some(ns) = file.file_name().and_then(|f| f.to_str()).and_then(id_namespace) else { continue };
            let Ok(body) = fs::read_to_string(&file) else { continue };
            for id in table_ids(&body) {
                mine.insert((ns, id), ());
            }
        }
        for key in mine.keys() {
            if let Some(before) = owner.insert(*key, name.to_string()) {
                if before != *name {
                    found.entry((before, name.to_string(), key.0)).or_default().push(key.1);
                }
            }
        }
    }
    found
        .into_iter()
        .map(|((earlier, later, ns), ids)| {
            let shown: Vec<String> = ids.iter().take(5).map(u64::to_string).collect();
            let more = if ids.len() > 5 { format!(" and {} more", ids.len() - 5) } else { String::new() };
            let (noun, plural) = if ns == "item" { ("item", "items") } else { ("monster", "monsters") };
            let what = if ids.len() == 1 { format!("{noun} {}", shown[0]) } else { format!("{plural} {}{more}", shown.join(", ")) };
            (
                earlier.clone(),
                format!("{later} also defines {what}, so {later}'s version is the one in effect. If they are different {plural}, one of the two mods needs other ids."),
            )
        })
        .collect()
}

/// The population engine's vendor tables. A mod's vendors there live next to
/// the engine's own and every other mod's, in one table per file.
const VENDOR_TABLES: &[&str] = &["population_vendors.yml", "population_vendor_pop.yml"];

/// One entry of a vendor table: its VendorKey, and whether it uses the
/// mod-vendor features (`Spawns:` in population_vendors.yml, `PlacementBound:
/// true` in population_vendor_pop.yml), which is what makes it a mod's own.
struct VendorEntry {
    key: String,
    mod_owned: bool,
}

/// The entries of a vendor table's Body, block style (`  - VendorKey: x`, or a
/// profile carrying `    VendorKey: x`) or flow style (`  - { VendorKey: x }`).
fn vendor_entries(text: &str) -> Vec<VendorEntry> {
    let Some((_, body)) = section(text, "Body:") else { return Vec::new() };
    let end = section(text, "Footer:").map_or(text.len(), |(start, _)| start);
    let mut chunks: Vec<String> = Vec::new();
    for line in text[body..end].lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        if line.starts_with("  - ") || line.starts_with("- ") {
            chunks.push(String::new());
        }
        if let Some(chunk) = chunks.last_mut() {
            chunk.push_str(line);
            chunk.push('\n');
        }
    }
    chunks
        .iter()
        .filter_map(|chunk| {
            // A vendor (`VendorKey:`) or a market (`Market:`, which is always a
            // mod's own: it exists only to spawn).
            let (at, label) = match chunk.find("VendorKey:") {
                Some(at) => (at, "VendorKey:"),
                None => (chunk.find("Market:")?, "Market:"),
            };
            let value = chunk[at + label.len()..].trim_start();
            let stop = value.find(|c: char| c == ',' || c == '}' || c == '#' || c.is_whitespace()).unwrap_or(value.len());
            let key = value[..stop].trim_matches(|c| c == '"' || c == '\'').to_string();
            if key.is_empty() {
                return None;
            }
            let mod_owned = label == "Market:" || chunk.contains("Spawns:") || chunk.lines().any(|l| {
                let l = l.trim_start().trim_start_matches("- ").trim_start_matches('{').trim();
                l.starts_with("PlacementBound:") && l["PlacementBound:".len()..].trim().starts_with("true")
            }) || chunk.contains("PlacementBound: true");
            Some(VendorEntry { key, mod_owned })
        })
        .collect()
}

/// Mod vendors are a mod's own (see the population engine's README): keys
/// that say which mod they belong to, never another mod's, and never the
/// engine's whole table cleared. Nothing here stops a mod loading; it is said
/// under the mod, the same way as an id two mods share, so the player and the
/// mod's author can see it.
fn vendor_ownership(mods: &[(&str, &Path)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut owner: BTreeMap<(&'static str, String), String> = BTreeMap::new();
    let mut shared: BTreeMap<(String, String, &'static str), Vec<String>> = BTreeMap::new();
    for (name, dir) in mods {
        let prefix = format!("{name}/");
        for table in VENDOR_TABLES {
            let Ok(text) = fs::read_to_string(dir.join("db").join(table)) else { continue };
            if header_clears(&text) {
                out.push((
                    name.to_string(),
                    format!("db/{table} has `Clear: true`, which empties the population engine's whole table: its own vendors and every other mod's go with it. A mod only needs to add its own entries."),
                ));
            }
            let entries = vendor_entries(&text);
            let foreign: Vec<&str> = entries
                .iter()
                .filter(|e| e.mod_owned && !e.key.starts_with(&prefix))
                .map(|e| e.key.as_str())
                .collect();
            if !foreign.is_empty() {
                let shown: Vec<String> = foreign.iter().take(5).map(|k| format!("'{k}'")).collect();
                let more = if foreign.len() > 5 { format!(" and {} more", foreign.len() - 5) } else { String::new() };
                out.push((
                    name.to_string(),
                    format!("db/{table}: mod vendor key {}{more} should start with '{prefix}', so it can't collide with the engine's own or another mod's.", shown.join(", ")),
                ));
            }
            let mut seen_here: BTreeMap<String, ()> = BTreeMap::new();
            for e in entries {
                if seen_here.insert(e.key.clone(), ()).is_some() {
                    continue;
                }
                if let Some(before) = owner.insert((table, e.key.clone()), name.to_string()) {
                    if before != *name {
                        shared.entry((before, name.to_string(), table)).or_default().push(e.key);
                    }
                }
            }
        }
    }
    for ((earlier, later, table), mut keys) in shared {
        keys.sort();
        let shown: Vec<String> = keys.iter().take(5).map(|k| format!("'{k}'")).collect();
        let more = if keys.len() > 5 { format!(" and {} more", keys.len() - 5) } else { String::new() };
        out.push((
            earlier,
            format!("{later} also defines vendor {}{more} in db/{table}, so {later}'s version is the one in effect.", shown.join(", ")),
        ));
    }
    out
}

fn write_clashes(dst: &Path, clashes: &[(String, String)]) {
    let mut body = String::new();
    for (owner, message) in clashes {
        body.push_str(&format!("{}\t{}\n", one_line(owner), one_line(message)));
    }
    let _ = fs::write(dst.join(CLASHES_FILE), body);
}

fn read_clashes(db: &Path) -> Vec<(String, String)> {
    let Ok(body) = fs::read_to_string(db.join(CLASHES_FILE)) else {
        return Vec::new();
    };
    body.lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(owner, message)| (owner.to_string(), message.to_string()))
        .collect()
}

/// One table a mod supplied, and what the server made of it.
#[derive(Debug, PartialEq)]
pub struct TableResult {
    pub file: String,
    pub offered: u32,
    pub accepted: u32,
    /// The server's own complaints, in the order it made them.
    pub errors: Vec<String>,
}

/// Strip the colour codes and carriage returns rAthena writes between fields.
///
/// Its status lines are printed without newlines and overwritten in place, so
/// several of them share one physical line with escape sequences in between.
/// Scanning has to happen on the whole text, not line by line.
fn plain(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '\u{1b}' {
            i += 1;
            if i < bytes.len() && bytes[i] == '[' {
                i += 1;
                while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
                i += 1;
            }
            continue;
        }
        if bytes[i] == '\r' {
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// The text between `after` and the next `'`, starting the search at `from`.
fn quoted_at(text: &str, from: usize) -> Option<(String, usize)> {
    let rest = &text[from..];
    let end = rest.find('\'')?;
    Some((rest[..end].to_string(), from + end + 1))
}

/// Read the map server's account of loading `db/import`.
///
/// This is rAthena's verdict, not a second opinion: it owns the parser, and
/// re-implementing enough of it here to predict the answer is exactly the kind
/// of plausible-and-wrong that the real thing cannot be.
///
/// The shape it prints, once the escape codes are gone:
///
/// ```text
/// Loading 'db/import/skill_db.yml'...Loading '1' entries in 'db/import/skill_db.yml'
/// [Error]: Node "Id" cannot be parsed as t.
/// [Error]: Occurred in file 'db/import/skill_db.yml' on line 5 and column 4.
/// Done reading '0' entries in 'db/import/skill_db.yml'
/// ```
///
/// One entry offered and none kept, with the reason in between. Only files
/// under `db/import` are read, and only the errors between a file's own two
/// markers, so the stub-not-found noise from an unpackaged tree and one
/// table's failure never land on another.
pub fn parse_table_results(log: &str) -> Vec<TableResult> {
    const PREFIX: &str = "db/import/";
    let text = plain(log);
    let mut open: Vec<(String, u32, usize)> = Vec::new();
    let mut out: Vec<TableResult> = Vec::new();
    let mut at = 0usize;

    while at < text.len() {
        let Some(mark) = text[at..].find(" entries in '") else {
            break;
        };
        let mark = at + mark;
        // The count sits in quotes just before it: `Loading '1' entries in`.
        let head = &text[..mark];
        let Some(count_end) = head.rfind('\'') else {
            at = mark + 1;
            continue;
        };
        let Some(count_start) = head[..count_end].rfind('\'') else {
            at = mark + 1;
            continue;
        };
        let count: u32 = match head[count_start + 1..count_end].parse() {
            Ok(count) => count,
            Err(_) => {
                at = mark + 1;
                continue;
            }
        };
        let done = head[..count_start].ends_with("Done reading ");
        let Some((file, next)) = quoted_at(&text, mark + " entries in '".len()) else {
            break;
        };
        at = next;

        if !file.starts_with(PREFIX) {
            continue;
        }
        let file = file[PREFIX.len()..].to_string();

        if !done {
            open.push((file, count, mark));
            continue;
        }
        // A close with no open is a table this build never announced; skip it
        // rather than invent an offered count for it.
        let Some(index) = open.iter().rposition(|(name, _, _)| *name == file) else {
            continue;
        };
        let (_, offered, from) = open.remove(index);
        let mut errors = Vec::new();
        for line in text[from..mark].lines() {
            let line = line.trim();
            for tag in ["[Error]:", "[Warning]:"] {
                if let Some(rest) = line.find(tag) {
                    let message = line[rest + tag.len()..].trim();
                    if !message.is_empty() {
                        errors.push(message.to_string());
                    }
                }
            }
        }
        out.push(TableResult { file, offered, accepted: count, errors });
    }
    out
}

/// Say what rAthena means by the type name in a parse failure.
///
/// `database.cpp` builds that message with `typeid(R).name()`, which on
/// everything but MSVC returns the *mangled* name -- so the one diagnostic
/// that should say what a field expected says `t`, and the modder it is
/// addressed to has no way to know that means a number. Expanded here rather
/// than left as a single letter, because the whole reason this report exists
/// is that nobody could act on what the server said.
fn expand_type_name(message: &str) -> Option<String> {
    const MARKER: &str = "cannot be parsed as ";
    let at = message.find(MARKER)? + MARKER.len();
    let rest = &message[at..];
    let end = rest.find(['.', ' ']).unwrap_or(rest.len());
    let name = match &rest[..end] {
        "b" => "true or false",
        "a" | "c" | "h" | "s" | "t" | "i" | "j" | "l" | "m" | "x" | "y" => "a whole number",
        "f" | "d" => "a number",
        _ => return None,
    };
    Some(format!("{} is {name}", &rest[..end]))
}

/// Turn one table's result into the sentence Settings shows.
fn describe(result: &TableResult) -> String {
    let kept = result.accepted;
    let offered = result.offered;
    let plural = |n: u32| if n == 1 { "entry" } else { "entries" };
    let mut text = format!(
        "db/{}: {offered} {} offered, {kept} kept.",
        result.file,
        plural(offered)
    );
    for error in &result.errors {
        text.push(' ');
        text.push_str(error);
        if let Some(expanded) = expand_type_name(error) {
            text.push_str(&format!(" ({expanded})"));
        }
    }
    one_line(&text)
}

/// Record what the server made of each mod's tables, for Settings to show.
///
/// Called once the map server is up, because that is when it has said so. A
/// mod whose table was thrown away is still switched on and still has its
/// other layers in effect, so this is a warning against the mod rather than a
/// refusal of it.
pub fn record_load_report(cfg: &Config, dk: &crate::docker::Docker) {
    let build = cfg.state.join("modbuild/db");
    let owners = read_owners(&build);
    if owners.is_empty() && read_clashes(&build).is_empty() {
        let _ = fs::remove_file(report_path(&cfg.state));
        return;
    }
    let log = dk.logs("ragnarok-map", "4000");
    let mut problems: BTreeMap<String, Vec<String>> = BTreeMap::new();
    // Collisions the merge could not resolve, recorded when the tree was built.
    for (owner, message) in read_clashes(&build) {
        problems.entry(owner).or_default().push(message);
    }
    for result in parse_table_results(&log) {
        if result.accepted >= result.offered && result.errors.is_empty() {
            continue;
        }
        let Some(owner) = owners.get(&result.file) else {
            continue;
        };
        let text = describe(&result);
        eprintln!("mods: {owner}: {text}");
        problems.entry(owner.clone()).or_default().push(text);
    }

    let mut body = String::from("{");
    for (i, (owner, list)) in problems.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        body.push_str(&crate::json::quote(owner));
        body.push(':');
        body.push('[');
        for (j, text) in list.iter().enumerate() {
            if j > 0 {
                body.push(',');
            }
            body.push_str(&crate::json::quote(text));
        }
        body.push(']');
    }
    body.push('}');
    let _ = fs::write(report_path(&cfg.state), body);
}

/// What the last start said about one mod's tables.
fn load_report(state: &Path) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Ok(body) = fs::read_to_string(report_path(state)) else {
        return out;
    };
    let Ok(value) = crate::json::parse(&body) else {
        return out;
    };
    let crate::json::Value::Object(map) = value else {
        return out;
    };
    for (name, entry) in map {
        if let crate::json::Value::Array(items) = entry {
            let list: Vec<String> = items
                .into_iter()
                .filter_map(|v| match v {
                    crate::json::Value::String(s) => Some(s),
                    _ => None,
                })
                .collect();
            if !list.is_empty() {
                out.insert(name, list);
            }
        }
    }
    out
}

pub fn list(cfg: &Config) -> Vec<[String; 14]> {
    let saved = read_settings(&cfg.state).unwrap_or_default();
    let reported = load_report(&cfg.state);
    let mods = scan(cfg);
    // With navigation-server-npcs on, the client's NPC table is built from
    // every mod's scripts (navnpc.rs), so a change to one needs the game
    // reopened like any client file; so does switching that mod itself.
    let navigation = mods.iter().any(|m| m.name == crate::navnpc::MOD && matches!(m.status, Status::On));
    // And with navigation-server-monsters on, from their spawns and mob_db.
    let monsters = mods.iter().any(|m| m.name == crate::navmob::MOD && matches!(m.status, Status::On));
    // And with navigation-server-warps on, from their warps.
    let warps = mods.iter().any(|m| m.name == crate::navwarp::MOD && matches!(m.status, Status::On));
    mods.into_iter()
        .map(|m| {
            let (state, reason) = match &m.status {
                Status::On => ("on", String::new()),
                Status::Off => ("off", String::new()),
                Status::Refused(r) => ("refused", r.clone()),
            };
            let grants = m.grants_commands();
            [
                state.to_string(),
                one_line(&m.name),
                one_line(&m.manifest.description),
                one_line(&reason),
                if m.bundled { "bundled" } else { "installed" }.to_string(),
                one_line(&m.manifest.version),
                one_line(&m.manifest.author),
                // Last, so an older shell that splits off the first seven
                // fields reads exactly what it did before.
                if grants { "grants-commands" } else { "" }.to_string(),
                // Appended for the same reason: the declared options and the
                // values in force, as one JSON array. json::quote escapes every
                // control character, so this cannot break the tab framing.
                settings_json(&m.manifest, saved.get(&m.name)),
                // What the server said about this mod's tables the last time
                // it started, as a JSON array of sentences. Empty when it said
                // nothing, and when the server has not started since the mod
                // was installed -- Settings says which of the two it is.
                match reported.get(&m.name) {
                    None => String::from("[]"),
                    Some(list) => {
                        let items: Vec<String> =
                            list.iter().map(|t| crate::json::quote(t)).collect();
                        format!("[{}]", items.join(","))
                    }
                },
                // The mod's own settings page, relative to its folder, and the
                // folder itself -- the window that shows the page is confined
                // to that folder. Both empty for a mod with no page.
                one_line(&m.manifest.settings_page),
                if m.manifest.settings_page.is_empty() {
                    String::new()
                } else {
                    one_line(&m.dir.to_string_lossy())
                },
                // `skin`, `cursor` or empty. Last, like every addition, so an
                // older shell reads the columns it knows.
                m.manifest.kind.clone(),
                // `client` when the mod has layers the game window loads, so
                // Settings asks for the game to be reopened only after an
                // Apply that changed one of those.
                if m.has_client_layers()
                    || m.name == crate::navnpc::MOD
                    || m.name == crate::navmob::MOD
                    || m.name == crate::navwarp::MOD
                    || ((navigation || warps) && m.has_npc_layers())
                    || (monsters && (m.has_npc_layers() || m.has_db_table("mob_db.yml")))
                {
                    "client"
                } else {
                    ""
                }
                .to_string(),
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

/// Switch a mod on, and every other mod of its `kind` off.
///
/// Returns the names switched off, so whoever asked can say so. A mod with no
/// kind, or one that is not installed, is simply switched on -- `set_enabled`
/// never needed the folder to exist, and neither does this.
pub fn enable(cfg: &Config, name: &str) -> Result<Vec<String>, String> {
    let all = scan(cfg);
    let kind = all
        .iter()
        .find(|m| m.name == name)
        .map(|m| m.manifest.kind.clone())
        .unwrap_or_default();
    set_enabled(&cfg.state, name, true)?;
    let mut off = Vec::new();
    if kind.is_empty() {
        return Ok(off);
    }
    let chosen = read_list(&cfg.state, "enabled.txt");
    for m in all.iter().filter(|m| m.name != name && m.manifest.kind == kind) {
        // Written for any that is on *or* recorded as chosen: a refused skin
        // that was ticked would otherwise come back on beside this one the
        // moment its problem went away.
        if m.status == Status::On || chosen.contains(&m.name) {
            set_enabled(&cfg.state, &m.name, false)?;
            off.push(m.name.clone());
        }
    }
    Ok(off)
}

/// Forget every choice the player made about a mod: its line in either list
/// and its saved options.
///
/// Called after the mod's folder has been removed. Leaving the choices behind
/// would hand them to whatever is installed under the same name next -- a
/// fresh download of the mod would come back switched off, or with options
/// the player set for an older version. Forgetting a mod nobody chose anything
/// about is not an error.
pub fn forget(state: &Path, name: &str) -> Result<(), String> {
    for (file, header) in [
        ("disabled.txt", "# Mods listed here are installed but switched off."),
        ("enabled.txt", "# Mods listed here are switched on, including any that ship switched off."),
    ] {
        if read_list(state, file).iter().any(|n| n == name) {
            write_list(state, file, name, false, header)?;
        }
    }
    let mut all = read_settings(state)?;
    if all.remove(name).is_some() {
        write_settings(state, &all)?;
    }
    Ok(())
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

    fn order(pairs: &[(&str, &[&str])]) -> Result<Vec<String>, Vec<String>> {
        let owned: Vec<(String, Vec<String>)> = pairs
            .iter()
            .map(|(n, a)| ((*n).to_string(), a.iter().map(|s| (*s).to_string()).collect()))
            .collect();
        apply_order(&owned)
    }

    /// Alphabetical is the floor, so the order is predictable without anyone
    /// declaring anything.
    // Two mods, one population table: one adds its island, the other declares
    // the table its own. The merged file has to keep both bodies *and* the
    // Clear, or the replacing mod silently becomes an addition.
    #[test]
    fn a_replacing_table_keeps_its_clear_through_a_merge_with_an_adding_one() {
        let adds = "Header:\n  Type: POPULATION_SPAWN_DB\n  Version: 1\n\nBody:\n  - Profile: combat_pve_low\n    FieldsAdd:\n      - ro_isle\n";
        let replaces = "Header:\n  Type: POPULATION_SPAWN_DB\n  Version: 1\n  Clear: true\n\nBody:\n  - Profile: novice_default\n    Towns:\n      - new_1-1\n";
        assert!(!header_clears(adds));
        assert!(header_clears(replaces));

        // Whichever order the mod names put them in.
        let merged = merge_tables(adds, replaces).expect("same Type merges");
        assert!(header_clears(&merged), "{merged}");
        assert!(merged.contains("ro_isle"), "{merged}");
        assert!(merged.contains("new_1-1"), "{merged}");
        assert_eq!(merged.matches("Clear: true").count(), 1, "{merged}");

        let merged = merge_tables(replaces, adds).expect("same Type merges");
        assert!(header_clears(&merged), "{merged}");
        assert!(merged.contains("ro_isle"), "{merged}");

        // Two ordinary tables are untouched by any of this.
        let merged = merge_tables(adds, adds).expect("same Type merges");
        assert!(!header_clears(&merged), "{merged}");
    }

    // The spawn table has to keep declaring the import a mod's copy arrives
    // through. Without the Footer the file loads, the mod's copy sits in
    // db/import unread, and nothing reports it.
    #[test]
    fn the_population_spawn_table_still_imports_the_mod_overlay() {
        let table = include_str!(
            "../../third-party/population-engine/files/db/population_spawn.yml"
        );
        assert_eq!(header_type(table).as_deref(), Some("POPULATION_SPAWN_DB"));
        assert!(
            table.contains("- Path: db/import/population_spawn.yml"),
            "the engine would read nothing a mod ships"
        );
        let stub = include_str!(
            "../../third-party/population-engine/files/db/import-tmpl/population_spawn.yml"
        );
        assert_eq!(header_type(stub).as_deref(), Some("POPULATION_SPAWN_DB"));
        // A stub that cleared would empty the shipped table on every start.
        assert!(!header_clears(stub));
    }

    // Companion strategies arrive the same way, and the worked example must stay
    // a table of the same Type or the merge would refuse it.
    #[test]
    fn the_population_strategy_table_still_imports_the_mod_overlay() {
        let table = include_str!(
            "../../third-party/population-engine/files/db/population_strategy.yml"
        );
        assert_eq!(header_type(table).as_deref(), Some("POPULATION_STRATEGY_DB"));
        assert!(
            table.contains("- Path: db/import/population_strategy.yml"),
            "the engine would read nothing a mod ships"
        );
        let stub = include_str!(
            "../../third-party/population-engine/files/db/import-tmpl/population_strategy.yml"
        );
        assert_eq!(header_type(stub).as_deref(), Some("POPULATION_STRATEGY_DB"));
        assert!(!header_clears(stub));
        let roles = include_str!(
            "../../examples/mods/companion-roles/db/population_strategy.yml"
        );
        let tactics = include_str!(
            "../../examples/mods/companion-tactics/db/population_strategy.yml"
        );
        assert_eq!(header_type(roles).as_deref(), Some("POPULATION_STRATEGY_DB"));
        assert_eq!(header_type(tactics).as_deref(), Some("POPULATION_STRATEGY_DB"));
        // The two example mods, which are meant to be on together, combine into one table.
        let merged = merge_tables(roles, tactics).expect("same Type merges");
        assert_eq!(merged.matches("\nBody:").count(), 1, "{merged}");
        assert!(merged.contains("Mob: Boss") && merged.contains("Mob: PHREEONI"), "{merged}");
    }

    #[test]
    fn with_nothing_declared_the_order_is_alphabetical() {
        assert_eq!(
            order(&[("zebra", &[]), ("alpha", &[]), ("middle", &[])]).unwrap(),
            vec!["alpha", "middle", "zebra"]
        );
    }

    /// The whole point: a mod whose folder sorts first can still be applied
    /// last, so its copy of a repeated key wins.
    #[test]
    fn after_lifts_a_mod_past_the_alphabet() {
        let placed = order(&[("alpha", &["zebra"]), ("zebra", &[])]).unwrap();
        assert_eq!(placed, vec!["zebra", "alpha"]);
    }

    /// `after` is precedence, not need. Naming a mod nobody installed is how a
    /// mod says "if that one is here, I come later", and it must not refuse
    /// anything on its own.
    #[test]
    fn after_ignores_a_mod_that_is_not_here() {
        assert_eq!(order(&[("alpha", &["absent"])]).unwrap(), vec!["alpha"]);
    }

    /// A chain, and a mod that has to be placed after two others.
    #[test]
    fn a_chain_and_a_join_both_come_out_in_order() {
        let placed = order(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]).unwrap();
        assert_eq!(placed, vec!["a", "b", "c"]);
        let placed = order(&[("last", &["one", "two"]), ("one", &[]), ("two", &[])]).unwrap();
        assert_eq!(placed.last().unwrap(), "last");
        assert!(placed.contains(&"one".to_string()) && placed.contains(&"two".to_string()));
    }

    /// A loop has no order. Resolving it into whatever falls out of the
    /// traversal would be worse than saying so.
    #[test]
    fn a_loop_is_refused_rather_than_resolved() {
        let cycle = order(&[("a", &["b"]), ("b", &["a"])]).unwrap_err();
        assert!(cycle.contains(&"a".to_string()) || cycle.contains(&"b".to_string()), "{cycle:?}");
        assert!(order(&[("a", &["a"])]).is_err(), "a mod after itself is a loop");
    }

    /// A deep chain must not be ordered by recursion.
    #[test]
    fn a_very_long_chain_does_not_overflow() {
        let names: Vec<String> = (0..5000).map(|i| format!("mod-{i:05}")).collect();
        let pairs: Vec<(String, Vec<String>)> = names
            .iter()
            .enumerate()
            .map(|(i, n)| (n.clone(), if i == 0 { vec![] } else { vec![names[i - 1].clone()] }))
            .collect();
        assert_eq!(apply_order(&pairs).unwrap(), names);
    }

    /// Mod names become folder names and reach a path join, so the manifest
    /// only accepts something a filesystem can carry.
    #[test]
    fn a_dependency_list_only_accepts_mod_names() {
        let good = json::parse("{\"after\":[\"a-mod\",\"b_mod2\"]}").unwrap();
        assert_eq!(name_list(&good, "after", None).unwrap(), vec!["a-mod", "b_mod2"]);
        // Repeats collapse rather than ordering a mod against itself twice.
        let twice = json::parse("{\"after\":[\"a\",\"a\"]}").unwrap();
        assert_eq!(name_list(&twice, "after", None).unwrap(), vec!["a"]);
        for bad in ["{\"after\":\"a\"}", "{\"after\":[1]}", "{\"after\":[\"../escape\"]}",
                    "{\"after\":[\"\"]}", "{\"after\":[\"has space\"]}"] {
            let value = json::parse(bad).unwrap();
            assert!(name_list(&value, "after", None).is_err(), "{bad} must be refused");
        }
        let absent = json::parse("{}").unwrap();
        assert!(name_list(&absent, "after", None).unwrap().is_empty());
    }

    const TABLE_A: &str = "# a comment mentioning Body: in passing\nHeader:\n  Type: ITEM_DB\n  Version: 3\n\nBody:\n  - Id: 30000\n    AegisName: Mod_A_Potion\n";
    const TABLE_B: &str = "Header:\n  Type: ITEM_DB\n  Version: 3\n\nBody:\n  - Id: 30001\n    AegisName: Mod_B_Potion\n";

    /// #98: two mods each add an item, each ships db/item_db.yml, and one of
    /// them silently did not exist. rAthena would have read both files.
    #[test]
    fn two_mods_adding_items_keep_both() {
        let merged = merge_tables(TABLE_A, TABLE_B).expect("two ITEM_DB tables merge");
        assert!(merged.contains("Mod_A_Potion"), "{merged}");
        assert!(merged.contains("Mod_B_Potion"), "{merged}");
        // One header, not two: a second one partway down is not a table.
        assert_eq!(merged.matches("Type: ITEM_DB").count(), 1, "{merged}");
        assert_eq!(merged.matches("\nBody:").count(), 1, "{merged}");
        // Later mod last, so a repeated id resolves the way load order says.
        assert!(merged.find("Mod_A_Potion") < merged.find("Mod_B_Potion"), "{merged}");
    }

    /// A Footer names other files to import rather than holding entries. The
    /// first file's is kept and entries go in front of it, or the server reads
    /// the imports and then finds entries after them.
    #[test]
    fn entries_land_above_a_footer_and_it_is_not_duplicated() {
        let with_footer = format!("{TABLE_A}\nFooter:\n  Imports:\n  - Path: db/re/item_db_etc.yml\n");
        let b_with_footer = format!("{TABLE_B}\nFooter:\n  Imports:\n  - Path: db/re/item_db_etc.yml\n");
        let merged = merge_tables(&with_footer, &b_with_footer).expect("merges");
        assert_eq!(merged.matches("Footer:").count(), 1, "{merged}");
        assert_eq!(merged.matches("item_db_etc.yml").count(), 1, "{merged}");
        assert!(merged.find("Mod_B_Potion") < merged.find("Footer:"), "{merged}");
        assert!(merged.trim_end().ends_with("item_db_etc.yml"), "{merged}");
    }

    /// Same filename, different kind of table. Nothing safe to combine, so the
    /// caller is told rather than handed a file with two headers in it.
    #[test]
    fn two_different_kinds_of_table_do_not_merge() {
        let other = TABLE_B.replace("ITEM_DB", "MOB_DB");
        assert!(merge_tables(TABLE_A, &other).is_none());
    }

    /// Not every file under db/ is a table: a cache, a txt index, a stub with
    /// a header and nothing under it.
    #[test]
    fn a_file_with_no_entries_to_add_is_left_alone() {
        let stub = "Header:\n  Type: ITEM_DB\n  Version: 3\n";
        // Nothing to take from it, so the destination is unchanged.
        assert_eq!(merge_tables(TABLE_A, stub).as_deref(), None);
        // Nowhere to put entries, so the caller decides instead.
        assert!(merge_tables(stub, TABLE_B).is_none());
        assert!(merge_tables("map_index contents", TABLE_B).is_none());
    }

    /// `Body:` appears indented inside rAthena's own comment headers, and the
    /// word turns up in values. Only a bare line at column zero is the section.
    #[test]
    fn only_a_bare_body_line_starts_the_entries() {
        let tricky = "Header:\n  Type: ITEM_DB\n#   Body:                  the entry list\nBody:\n  - Id: 1\n";
        let (_, after) = section(tricky, "Body:").expect("the real one is found");
        assert_eq!(&tricky[after..], "  - Id: 1\n");
        assert_eq!(header_type(tricky).as_deref(), Some("ITEM_DB"));
    }

    /// Windows line endings are what a mod written on Windows ships.
    #[test]
    fn crlf_tables_merge_too() {
        let a = TABLE_A.replace('\n', "\r\n");
        let b = TABLE_B.replace('\n', "\r\n");
        let merged = merge_tables(&a, &b).expect("merges");
        assert!(merged.contains("Mod_A_Potion") && merged.contains("Mod_B_Potion"), "{merged}");
        assert_eq!(merged.matches("Type: ITEM_DB").count(), 1, "{merged}");
    }

    /// The collision that could not be merged has to reach the report, and be
    /// attributed to the mod whose copy is not in effect.
    #[test]
    fn an_unmergeable_collision_is_recorded_against_the_loser() {
        let dir = std::env::temp_dir().join(format!("ro-clash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let clashes = vec![("mod-a".to_string(), "db/item_db.yml is also supplied by mod-b".to_string())];
        write_clashes(&dir, &clashes);
        assert_eq!(read_clashes(&dir), clashes);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The real thing, escape codes and all: rAthena prints its status lines
    /// without newlines and overwrites them in place, so several share one
    /// physical line. Taken from a map server that had loaded the mod this was
    /// written for.
    const REAL_LOG: &str = "\x1b[1;32m[Status]\x1b[0m:\x1b[K Loading '\x1b[1;37mdb/import/skill_db.yml\x1b[0m'...\x1b[K\x1b[1;32m[Status]\x1b[0m:\x1b[K Loading '\x1b[1;37m1\x1b[0m' entries in '\x1b[1;37mdb/import/skill_db.yml\x1b[0m'\n\x1b[K\x1b[1;31m[Error]\x1b[0m:\x1b[K Node \"Id\" cannot be parsed as t.\n\x1b[1;31m[Error]\x1b[0m:\x1b[K Occurred in file '\x1b[1;37mdb/import/skill_db.yml\x1b[0m' on line 5 and column 4.\n\x1b[1;32m[Status]\x1b[0m:\x1b[K Done reading '\x1b[1;37m0\x1b[0m' entries in '\x1b[1;37mdb/import/skill_db.yml\x1b[0m'\x1b[K\n";

    #[test]
    fn a_rejected_table_is_read_out_of_the_server_log() {
        let results = parse_table_results(REAL_LOG);
        assert_eq!(results.len(), 1);
        let only = &results[0];
        assert_eq!(only.file, "skill_db.yml");
        assert_eq!(only.offered, 1);
        assert_eq!(only.accepted, 0);
        assert_eq!(
            only.errors,
            vec![
                "Node \"Id\" cannot be parsed as t.".to_string(),
                "Occurred in file 'db/import/skill_db.yml' on line 5 and column 4.".to_string(),
            ]
        );
        // "t" is what rAthena prints for a 16-bit number, because it formats
        // the type with typeid().name(). Expanded, or the sentence ends in a
        // letter the reader cannot act on.
        assert_eq!(
            describe(only),
            "db/skill_db.yml: 1 entry offered, 0 kept. Node \"Id\" cannot be parsed as t. \
             (t is a whole number) Occurred in file 'db/import/skill_db.yml' on line 5 and column 4."
        );
    }

    #[test]
    fn a_mangled_type_name_is_expanded_and_anything_else_left_alone() {
        assert_eq!(
            expand_type_name("Node \"Id\" cannot be parsed as t."),
            Some("t is a whole number".to_string())
        );
        assert_eq!(
            expand_type_name("Node \"Flag\" cannot be parsed as b."),
            Some("b is true or false".to_string())
        );
        // MSVC prints the real name, and a name nobody recognises is left as
        // it came rather than guessed at.
        assert_eq!(expand_type_name("cannot be parsed as unsigned short."), None);
        assert_eq!(expand_type_name("Some other complaint entirely."), None);
    }

    /// A table that loaded is not a problem and must not be reported as one,
    /// or every start would accuse every mod.
    #[test]
    fn a_table_that_loaded_says_nothing() {
        let log = "[Status]: Loading '3' entries in 'db/import/mob_db.yml'\n\
                   [Status]: Done reading '3' entries in 'db/import/mob_db.yml'\n";
        let results = parse_table_results(log);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].accepted, 3);
        assert!(results[0].errors.is_empty());
    }

    /// Two mods, two tables, one broken. The errors belong to the table they
    /// sit between and must not spread to the one that loaded.
    #[test]
    fn one_bad_table_does_not_implicate_the_next() {
        let log = "[Status]: Loading '2' entries in 'db/import/item_db.yml'\n\
                   [Error]: Node \"Id\" cannot be parsed as t.\n\
                   [Status]: Done reading '1' entries in 'db/import/item_db.yml'\n\
                   [Status]: Loading '5' entries in 'db/import/mob_db.yml'\n\
                   [Status]: Done reading '5' entries in 'db/import/mob_db.yml'\n";
        let results = parse_table_results(log);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].file, "item_db.yml");
        assert_eq!(results[0].errors.len(), 1);
        assert_eq!(results[1].file, "mob_db.yml");
        assert!(results[1].errors.is_empty());
    }

    /// A development tree with no staged import stubs produces sixty of these.
    /// None of them is a mod's fault, and none names a file a mod supplied, so
    /// nothing here may pick them up.
    #[test]
    fn missing_import_stubs_are_not_a_mods_problem() {
        let log = "[Status]: Loading 'db/import/instance_db.yml'...\
                   [Error]: Failed to open INSTANCE_DB database file from 'db/import/instance_db.yml'.\n";
        assert!(parse_table_results(log).is_empty());
    }

    /// Only `db/import` is ours. The stock tables load in the same log and
    /// their counts are none of a mod's business.
    #[test]
    fn the_servers_own_tables_are_ignored() {
        let log = "[Status]: Loading '1635' entries in 'db/re/skill_db.yml'\n\
                   [Status]: Done reading '1635' entries in 'db/re/skill_db.yml'\n";
        assert!(parse_table_results(log).is_empty());
    }

    /// The report survives the run that wrote it, because Settings is usually
    /// read with the server stopped, and it comes back keyed by mod.
    #[test]
    fn the_report_round_trips_to_the_settings_window() {
        let dir = std::env::temp_dir().join(format!("ro-modreport-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            report_path(&dir),
            "{\"no-seed-cost\":[\"db/skill_db.yml: 1 entry offered, 0 kept.\"]}",
        )
        .unwrap();
        let back = load_report(&dir);
        assert_eq!(
            back.get("no-seed-cost").map(|v| v.as_slice()),
            Some(["db/skill_db.yml: 1 entry offered, 0 kept.".to_string()].as_slice())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The merged tree is one directory; without this nothing in it says which
    /// mod a complaint belongs to.
    #[test]
    fn ownership_survives_the_merge() {
        let dir = std::env::temp_dir().join(format!("ro-modowners-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut owners = BTreeMap::new();
        owners.insert("skill_db.yml".to_string(), "no-seed-cost".to_string());
        owners.insert("mob_db.yml".to_string(), "harder-porings".to_string());
        write_owners(&dir, &owners);
        assert_eq!(read_owners(&dir), owners);
        let _ = fs::remove_dir_all(&dir);
    }
    use super::*;

    // A setting's value is the only thing a player types that lands inside a
    // script, so it must not be able to end its string and add code.
    #[test]
    fn a_script_string_cannot_be_broken_out_of() {
        assert_eq!(script_string("plain"), "\"plain\"");
        assert_eq!(script_string("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(script_string("a\\b"), "\"a\\\\b\"");
        assert_eq!(script_string("line\nnext\r\tend"), "\"line next  end\"");
        let hostile = "\"; atcommand \"@item 501 100\"; //\n}";
        let literal = script_string(hostile);
        assert_eq!(literal, "\"\\\"; atcommand \\\"@item 501 100\\\"; // }\"");
        // Every quote inside the literal is escaped, so the only ones that
        // count are the two around it.
        let unescaped = literal.char_indices().filter(|&(i, c)| c == '"' && (i == 0 || &literal[i - 1..i] != "\\")).count();
        assert_eq!(unescaped, 2);
        assert!(!literal.contains('\n'));
    }

    #[test]
    fn settings_reach_scripts_in_the_types_scripts_have() {
        let manifest = Manifest {
            settings: vec![
                setting("on", SettingValue::Bool(true), 0.0, 0.0),
                setting("rate", SettingValue::Number(1.0), -1e12, 1e12),
                setting("set", SettingValue::Text(String::new()), 0.0, 200.0),
            ],
            ..Manifest::default()
        };
        let raw = vec![
            ("on".to_string(), "false".to_string()),
            ("rate".to_string(), "2.7".to_string()),
            ("set".to_string(), "\"blessing,agi \\\"x\\\"\"".to_string()),
        ];
        assert_eq!(
            script_values(&manifest, &raw),
            vec![
                ("on".to_string(), ScriptValue::Int(0)),
                ("rate".to_string(), ScriptValue::Int(2)),
                ("set".to_string(), ScriptValue::Text("blessing,agi \"x\"".to_string())),
            ]
        );
        let huge = vec![
            ("on".to_string(), "true".to_string()),
            ("rate".to_string(), "-900000000000".to_string()),
            ("set".to_string(), "\"\"".to_string()),
        ];
        let values = script_values(&manifest, &huge);
        assert_eq!(values[0].1, ScriptValue::Int(1));
        assert_eq!(values[1].1, ScriptValue::Int(i32::MIN as i64));
    }

    #[test]
    fn the_generated_function_answers_each_mod_and_falls_back() {
        let script = settings_script(&[
            (
                "standart-npc".to_string(),
                vec![
                    ("buffer_set".to_string(), ScriptValue::Text("blessing,agi".to_string())),
                    ("enable_gramps".to_string(), ScriptValue::Int(1)),
                ],
            ),
            ("no-settings".to_string(), vec![]),
        ]);
        assert!(script.contains("function\tscript\tF_ModSetting\t{\n"));
        assert!(script.contains("\tif (.@mod$ == \"standart-npc\") {\n"));
        assert!(script.contains("\t\tif (.@key$ == \"buffer_set\") return \"blessing,agi\";\n"));
        assert!(script.contains("\t\tif (.@key$ == \"enable_gramps\") return 1;\n"));
        assert!(!script.contains("no-settings"));
        assert!(script.contains("\tif (getargcount() > 2) return getarg(2);\n"));
        assert!(script.trim_end().ends_with('}'));
        // Braces balance, so rAthena reads it as one function.
        assert_eq!(script.matches('{').count(), script.matches('}').count());
    }

    #[test]
    fn lua_files_load_in_mod_order_after_the_settings_they_can_read() {
        let root = tmp("lua-layer");
        let a = root.join("a-mod");
        fs::create_dir_all(a.join("lua/sub")).unwrap();
        fs::write(a.join("lua/z.lua"), "-- z").unwrap();
        fs::write(a.join("lua/sub/a.lua"), "").unwrap();
        fs::write(a.join("lua/notes.txt"), "not code").unwrap();
        let b = root.join("b-mod");
        fs::create_dir_all(b.join("lua")).unwrap();
        fs::write(b.join("lua/b.lua"), "").unwrap();
        let c = root.join("c-mod");
        fs::create_dir_all(&c).unwrap();

        let plain = Manifest::default();
        let tuned = Manifest {
            settings: vec![
                setting("on", SettingValue::Bool(true), 0.0, 0.0),
                setting("rate", SettingValue::Number(1.0), 0.0, 10.0),
                setting("whole", SettingValue::Number(1.0), 0.0, 10.0),
                setting("label", SettingValue::Text(String::new()), 0.0, 200.0),
            ],
            ..Manifest::default()
        };
        let values = vec![
            ("on".to_string(), "false".to_string()),
            ("rate".to_string(), "1.5".to_string()),
            ("whole".to_string(), "3".to_string()),
            ("label".to_string(), "\"say \\\"hi\\\"\\n\\\\\"".to_string()),
        ];
        let db = root.join("db");
        write_lua_layer(
            &db,
            &[
                ("a-mod", std::slice::from_ref(&a), &plain, vec![]),
                ("b-mod", std::slice::from_ref(&b), &tuned, values),
                ("c-mod", std::slice::from_ref(&c), &plain, vec![]),
            ],
        )
        .unwrap();

        let list = fs::read_to_string(db.join("lua/load.txt")).unwrap();
        let lines: Vec<&str> = list.lines().filter(|l| !l.starts_with('#')).collect();
        assert_eq!(
            lines,
            vec![
                "-\tlua/mod-settings.lua",
                "a-mod\tlua/a-mod/sub/a.lua",
                "a-mod\tlua/a-mod/z.lua",
                "b-mod\tlua/b-mod/b.lua",
            ]
        );
        assert!(db.join("lua/a-mod/z.lua").is_file());

        let settings = fs::read_to_string(db.join("lua").join(LUA_SETTINGS)).unwrap();
        assert!(settings.contains("MOD_SETTINGS = {\n"), "{settings}");
        assert!(settings.contains("  [\"b-mod\"] = {\n"), "{settings}");
        // Real booleans: in Lua, 0 is true.
        assert!(settings.contains("    [\"on\"] = false,\n"), "{settings}");
        assert!(settings.contains("    [\"rate\"] = 1.5,\n"), "{settings}");
        assert!(settings.contains("    [\"whole\"] = 3,\n"), "{settings}");
        // What someone typed cannot end the string: quote, newline, backslash.
        assert!(settings.contains("    [\"label\"] = \"say \\\"hi\\\"\\010\\\\\",\n"), "{settings}");
        assert!(!settings.contains("a-mod"), "a mod with no settings has no entry");
    }

    #[test]
    fn two_mods_defining_the_same_id_are_reported_under_the_one_that_loses() {
        let root = tmp("id-collisions");
        let a = root.join("a");
        let b = root.join("b");
        let c = root.join("c");
        fs::create_dir_all(a.join("db")).unwrap();
        fs::create_dir_all(b.join("db")).unwrap();
        fs::create_dir_all(c.join("db")).unwrap();
        let mob = |ids: &[u64]| {
            let mut s = String::from("Header:\n  Type: MOB_DB\n  Version: 5\n\nBody:\n");
            for id in ids {
                s.push_str(&format!("  - Id: {id}\n    AegisName: M{id}\n    Drops:\n      - Item: Jellopy\n        Rate: 10\n"));
            }
            s
        };
        fs::write(a.join("db/mob_db.yml"), mob(&[25001, 25002, 1002])).unwrap();
        fs::write(b.join("db/mob_db.yml"), mob(&[25001, 1002])).unwrap();
        // Items are one namespace across item_db.yml and item_db_*.yml.
        fs::write(a.join("db/item_db.yml"), "Body:\n  - Id: 50001\n").unwrap();
        fs::write(c.join("db/item_db_etc.yml"), "Body:\n  - Id: 50001\n  - Id: 50002\n").unwrap();

        let found = id_collisions(&[("a", a.as_path()), ("b", b.as_path()), ("c", c.as_path())]);
        assert_eq!(
            found,
            vec![
                (
                    "a".to_string(),
                    "b also defines monsters 1002, 25001, so b's version is the one in effect. If they are different monsters, one of the two mods needs other ids.".to_string()
                ),
                (
                    "a".to_string(),
                    "c also defines item 50001, so c's version is the one in effect. If they are different items, one of the two mods needs other ids.".to_string()
                ),
            ]
        );
        assert!(id_collisions(&[("a", a.as_path())]).is_empty());
    }

    #[test]
    fn vendor_keys_are_checked_for_their_mods_prefix_sharing_and_clear() {
        let root = tmp("vendor-ownership");
        let a = root.join("shop-a");
        let b = root.join("shop-b");
        fs::create_dir_all(a.join("db")).unwrap();
        fs::create_dir_all(b.join("db")).unwrap();
        let head = "Header:\n  Type: POPULATION_VENDORS_DB\n  Version: 1\n\nBody:\n";
        // shop-a: one properly named mod vendor, one unprefixed mod vendor, and
        // an override of an engine vendor (no Spawns), which is fine as is.
        fs::write(
            a.join("db/population_vendors.yml"),
            format!(
                "{head}  - VendorKey: shop-a/potions\n    Spawns:\n      - Map: prontera\n        Count: 1\n        Areas:\n          - {{ X1: 1, Y1: 1, X2: 2, Y2: 2 }}\n\
                 # - VendorKey: commented/out\n\
                 \x20 - VendorKey: \"cards\"\n    Spawns:\n      - Map: prontera\n        Positions:\n          - [150, 150]\n\
                 \x20 - VendorKey: dungeon_drops\n    Type: Dynamic\n"
            ),
        )
        .unwrap();
        // shop-b: clears the table, and also defines shop-a's key and the
        // engine key shop-a overrides.
        fs::write(
            b.join("db/population_vendors.yml"),
            "Header:\n  Type: POPULATION_VENDORS_DB\n  Version: 1\n  Clear: true\n\nBody:\n  - { VendorKey: shop-a/potions, Type: Pool }\n  - VendorKey: dungeon_drops\n",
        )
        .unwrap();
        fs::write(
            b.join("db/population_vendor_pop.yml"),
            "Header:\n  Type: POPULATION_ENGINE_DB\n  Version: 2\n\nBody:\n  - Profile: x\n    PlacementBound: true\n    VendorKey: other/x\n",
        )
        .unwrap();

        let found = vendor_ownership(&[("shop-a", a.as_path()), ("shop-b", b.as_path())]);
        assert_eq!(
            found,
            vec![
                (
                    "shop-a".to_string(),
                    "db/population_vendors.yml: mod vendor key 'cards' should start with 'shop-a/', so it can't collide with the engine's own or another mod's.".to_string()
                ),
                (
                    "shop-b".to_string(),
                    "db/population_vendors.yml has `Clear: true`, which empties the population engine's whole table: its own vendors and every other mod's go with it. A mod only needs to add its own entries.".to_string()
                ),
                (
                    "shop-b".to_string(),
                    "db/population_vendor_pop.yml: mod vendor key 'other/x' should start with 'shop-b/', so it can't collide with the engine's own or another mod's.".to_string()
                ),
                (
                    "shop-a".to_string(),
                    "shop-b also defines vendor 'dungeon_drops', 'shop-a/potions' in db/population_vendors.yml, so shop-b's version is the one in effect.".to_string()
                ),
            ]
        );
        assert!(vendor_ownership(&[("shop-a", a.as_path())]).len() == 1, "alone, only its own unprefixed key");

        // A market is a mod's own too, and needs the prefix.
        let c = root.join("shop-c");
        fs::create_dir_all(c.join("db")).unwrap();
        fs::write(
            c.join("db/population_vendors.yml"),
            "Header:\n  Type: POPULATION_VENDORS_DB\n  Version: 1\n\nBody:\n  - Market: street\n    Themes:\n      - { Theme: shop-c/a }\n  - Market: shop-c/street\n",
        )
        .unwrap();
        let found = vendor_ownership(&[("shop-c", c.as_path())]);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].1.contains("'street' should start with 'shop-c/'"), "{found:?}");
    }

    fn setting(key: &str, value: SettingValue, min: f64, max: f64) -> Setting {
        Setting { key: key.into(), label: key.into(), description: String::new(), value, min, max }
    }

    #[test]
    fn declared_settings_survive_absent_saved_hand_edited_and_retyped_values() {
        let manifest = Manifest {
            settings: vec![
                setting("launcher", SettingValue::Bool(true), 0.0, 0.0),
                setting("scale", SettingValue::Number(3.0), 1.0, 5.0),
                setting("label", SettingValue::Text("hi".into()), 0.0, 4.0),
            ],
            ..Manifest::default()
        };
        // Nothing saved: every mod starts on its own declared defaults.
        assert_eq!(
            effective(&manifest, None),
            vec![
                ("launcher".to_string(), "true".to_string()),
                ("scale".to_string(), "3".to_string()),
                ("label".to_string(), "\"hi\"".to_string()),
            ]
        );
        let saved: BTreeMap<String, String> = [
            ("launcher".to_string(), "false".to_string()),
            // Out of the range the mod said it could take.
            ("scale".to_string(), "99".to_string()),
            // Longer than the mod asked for.
            ("label".to_string(), "\"abcdefgh\"".to_string()),
            // No longer declared; must not reach the mod.
            ("removed".to_string(), "true".to_string()),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            effective(&manifest, Some(&saved)),
            vec![
                ("launcher".to_string(), "false".to_string()),
                ("scale".to_string(), "5".to_string()),
                ("label".to_string(), "\"abcd\"".to_string()),
            ]
        );
        // A value of the wrong type falls back to the default rather than
        // reaching the mod as something it never said it could parse.
        let wrong: BTreeMap<String, String> =
            [("launcher".to_string(), "\"yes\"".to_string())].into_iter().collect();
        assert_eq!(effective(&manifest, Some(&wrong))[0].1, "true");
    }

    #[test]
    fn a_mod_declaring_no_settings_reports_an_empty_list() {
        assert_eq!(settings_json(&Manifest::default(), None), "[]");
    }

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

    // Removing a mod must not leave its choices behind for the next mod
    // installed under that name, and must not touch anybody else's.
    #[test]
    fn forgetting_a_mod_drops_its_list_lines_and_options_only() {
        let state = tmp("mod-forget");
        set_enabled(&state, "gone", false).unwrap();
        set_enabled(&state, "kept", true).unwrap();
        fs::write(
            settings_path(&state),
            "{\n  \"gone\": { \"a\": true },\n  \"kept\": { \"b\": 3 }\n}\n",
        )
        .unwrap();

        forget(&state, "gone").unwrap();

        assert!(!read_list(&state, "disabled.txt").contains(&"gone".to_string()));
        assert_eq!(read_list(&state, "enabled.txt"), vec!["kept".to_string()]);
        let saved = read_settings(&state).unwrap();
        assert!(!saved.contains_key("gone"));
        assert_eq!(saved["kept"]["b"], "3");

        // Nothing recorded at all is not an error.
        forget(&state, "never-installed").unwrap();
    }

    // What the app asks before an update replaces a working copy.
    #[test]
    fn a_staged_folder_is_checked_by_the_same_manifest_reader() {
        let dir = tmp("mod-check");
        assert_eq!(check_dir(&dir).unwrap_err(), "it has no mod.json");
        fs::write(dir.join("mod.json"), "{\"version\": \"4.8.0\"}").unwrap();
        assert_eq!(check_dir(&dir).unwrap(), "4.8.0");
        fs::write(dir.join("mod.json"), "{\"requires\": {\"appp\": \">=1.0\"}}").unwrap();
        assert!(check_dir(&dir).unwrap_err().contains("\"appp\""));
        fs::write(dir.join("mod.json"), "not json").unwrap();
        assert!(check_dir(&dir).unwrap_err().contains("not valid JSON"));
    }

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ro-mods-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    // The settings page is part of the manifest's contract: a path that
    // leaves the mod folder, or a file that is not there, refuses the mod
    // with the reason rather than offering a button that opens nothing.
    #[test]
    fn a_settings_page_must_be_an_html_file_inside_the_mod() {
        let dir = tmp("settings-page");
        fs::create_dir_all(dir.join("settings")).unwrap();
        fs::write(dir.join("settings/index.html"), "<p>hi</p>").unwrap();
        let with = |page: &str| {
            fs::write(dir.join("mod.json"), format!("{{\"settingsPage\": {}}}", crate::json::quote(page))).unwrap();
            read_manifest(&dir)
        };
        assert_eq!(with("settings/index.html").unwrap().unwrap().settings_page, "settings/index.html");
        for bad in ["", "../x.html", "settings/../../x.html", "/abs.html", "C:/x.html", "settings\\index.html", "settings/index.js", "./settings/index.html"] {
            assert!(with(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(with("settings/missing.html").unwrap_err().contains("not in the mod folder"));
        fs::write(dir.join("mod.json"), "{\"settingsPage\": 3}").unwrap();
        assert!(read_manifest(&dir).is_err());
        fs::write(dir.join("mod.json"), "{}").unwrap();
        assert_eq!(read_manifest(&dir).unwrap().unwrap().settings_page, "");

        // The example the docs point at reads back as documented.
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/mods/settings-window");
        let manifest = read_manifest(&example).unwrap().unwrap();
        assert_eq!(manifest.settings_page, "settings/index.html");
        assert_eq!(manifest.settings.len(), 2);
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

    #[test]
    fn a_map_s_sky_clouds_and_weather_are_read_from_maps() {
        let d = tmp("maps");
        fs::write(
            d.join("mod.json"),
            r#"{"maps": {"My_Isle.rsw": {"sky": [0.4, 0.6, 0.8], "clouds": [1, 1, 1], "bgm": "my_isle.mp3"}, "my_cave": {"sky": [0, 0, 0.1, 1], "weather": "snow"}}}"#,
        )
        .unwrap();
        let m = read_manifest(&d).unwrap().unwrap();
        assert_eq!(
            m.maps,
            vec![
                MapLook { name: "my_isle".into(), sky: Some([0.4, 0.6, 0.8, 1.0]), clouds: Some([1.0, 1.0, 1.0]), weather: None, bgm: Some("my_isle.mp3".into()) },
                MapLook { name: "my_cave".into(), sky: Some([0.0, 0.0, 0.1, 1.0]), clouds: None, weather: Some("snow".into()), bgm: None },
            ]
        );
    }

    /// Each says what is wrong, by the map and the key, rather than drawing
    /// black behind a map that was meant to have a sky.
    #[test]
    fn a_mistake_in_maps_is_refused_by_name() {
        let d = tmp("bad-maps");
        for (maps, says) in [
            (r#"{"my_isle": {"sky": [0.4, 0.6]}}"#, "my_isle.sky"),
            (r#"{"my_isle": {"sky": [0.4, 0.6, 1.5]}}"#, "from 0 to 1"),
            (r#"{"my_isle": {"clouds": [1, 1, 1]}}"#, "no sky"),
            (r#"{"my_isle": {"weather": "hail"}}"#, "\"snow\""),
            (r#"{"my_isle": {"skys": [0.4, 0.6, 0.8]}}"#, "skys"),
            (r#"{"my_isle": {}}"#, "sets nothing"),
            (r#"{"my_isle": {"bgm": "music/my_isle.mp3"}}"#, "my_isle.bgm"),
            (r#"{"my_isle": {"bgm": "my_isle.ogg"}}"#, "my_isle.bgm"),
            (r#"{"my_isle": {"bgm": "my-bgm.mp3"}}"#, "my_isle.bgm"),
            (r#"{"a_name_too_long": {"sky": [0, 0, 0]}}"#, "up to 11"),
            (r#"["my_isle"]"#, "must be an object"),
        ] {
            fs::write(d.join("mod.json"), format!(r#"{{"maps": {maps}}}"#)).unwrap();
            let e = read_manifest(&d).unwrap_err();
            assert!(e.contains(says), "{maps}: {e}");
        }
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
        read_conf(&d, "x", &[], &mut out);
        let got = out.get("char_conf.txt").unwrap();
        assert_eq!(got, &vec![("start_point".into(), "my_town,50,50".into())]);
    }

    /// groups.yml is copied whole rather than filtered through the key
    /// allowlist. Worth pinning: read line by line it would be discarded
    /// entirely -- "Header:" and "Body:" are not `key: value` settings the
    /// allowlist knows -- and the mod would look installed and do nothing.
    #[test]
    fn groups_yml_is_taken_whole_rather_than_key_by_key() {
        let d = tmp("whole");
        fs::create_dir_all(d.join("conf")).unwrap();
        let body = "Header:\n  Type: PLAYER_GROUP_DB\n  Version: 1\n\nBody:\n  - Id: 0\n    Commands:\n      autoloot: true\n";
        fs::write(d.join("conf/groups.yml"), body).unwrap();
        // An ordinary conf file alongside it still goes through the allowlist.
        fs::write(d.join("conf/char_conf.txt"), "start_point: my_town,50,50\n").unwrap();

        let mut out = BTreeMap::new();
        read_conf(&d, "x", &[], &mut out);

        let whole = out.get("file:groups.yml").expect("groups.yml is recorded as a whole file");
        assert_eq!(whole, &vec![("x".to_string(), body.to_string())]);
        assert!(out.get("groups.yml").is_none(), "it must not also be parsed as settings");
        assert_eq!(
            out.get("char_conf.txt").unwrap(),
            &vec![("start_point".to_string(), "my_town,50,50".to_string())]
        );
    }

    /// A whole-file conf layer is a permission grant, and the Settings window
    /// only labels it because `list` reports it. Pinned in both directions:
    /// missing the label on a mod that writes groups.yml hides the grant, and
    /// showing it on an ordinary mod teaches players to ignore it.
    #[test]
    fn a_mod_that_writes_groups_yml_is_reported_as_granting_commands() {
        let plain = tmp("grants-plain");
        fs::create_dir_all(plain.join("conf")).unwrap();
        fs::write(plain.join("conf/battle_conf.txt"), "base_exp_rate: 200\n").unwrap();
        let m = Installed {
            name: "plain".into(),
            dir: plain,
            status: Status::Off,
            manifest: Manifest::default(),
            bundled: true,
            roots: Vec::new(),
        };
        assert!(!m.grants_commands(), "an ordinary conf layer is not a command grant");

        let granting = tmp("grants-groups");
        fs::create_dir_all(granting.join("conf")).unwrap();
        fs::write(granting.join("conf/groups.yml"), "Header:\n  Type: PLAYER_GROUP_DB\n").unwrap();
        let m = Installed {
            name: "granting".into(),
            dir: granting,
            status: Status::Off,
            manifest: Manifest::default(),
            bundled: true,
            roots: Vec::new(),
        };
        assert!(m.grants_commands(), "groups.yml decides what commands players get");
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

    /// `requires.mods` was parsed and then refused by the check for unknown
    /// `requires` keys, so no mod could ever depend on another.
    #[test]
    fn a_mod_can_require_another_mod() {
        let d = tmp("req-mods");
        fs::write(d.join("mod.json"), r#"{"requires": {"app": ">=1.0.0", "mods": ["base-mod"]}}"#).unwrap();
        let m = read_manifest(&d).unwrap().unwrap();
        assert_eq!(m.requires_mods, vec!["base-mod".to_string()]);
    }

    const GROUP_HEADER: &str = "Header:\n  Type: PLAYER_GROUP_DB\n  Version: 1\n\nBody:\n";

    /// A fragment under conf/when/<setting>/ is part of the mod exactly while
    /// that yes/no setting is on, and comes after the mod's own copy.
    #[test]
    fn a_conditional_conf_fragment_follows_its_setting() {
        let d = tmp("when");
        fs::create_dir_all(d.join("conf/when/allow_go")).unwrap();
        fs::create_dir_all(d.join("conf/when/undeclared")).unwrap();
        fs::write(d.join("conf/groups.yml"), format!("{GROUP_HEADER}  - Id: 0\n    Commands:\n      autoloot: true\n")).unwrap();
        fs::write(d.join("conf/when/allow_go/groups.yml"), format!("{GROUP_HEADER}  - Id: 0\n    Commands:\n      go: true\n")).unwrap();
        fs::write(d.join("conf/when/undeclared/groups.yml"), "ignored").unwrap();

        let mut on = BTreeMap::new();
        read_conf(&d, "pc", &[("allow_go".into(), "true".into())], &mut on);
        let labels: Vec<&str> = on["file:groups.yml"].iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(labels, vec!["pc", "pc (allow_go)"]);

        let mut off = BTreeMap::new();
        read_conf(&d, "pc", &[("allow_go".into(), "false".into())], &mut off);
        assert_eq!(off["file:groups.yml"].len(), 1);

        // And a mod whose only grant is behind an option still says it grants.
        fs::remove_file(d.join("conf/groups.yml")).unwrap();
        let m = Installed { name: "pc".into(), dir: d, status: Status::Off, manifest: Manifest::default(), bundled: true, roots: Vec::new() };
        assert!(m.grants_commands());
    }

    #[test]
    fn conditional_npc_scripts_follow_only_boolean_settings() {
        let d = tmp("npc-when");
        fs::create_dir_all(d.join("npc/when/enabled")).unwrap();
        fs::create_dir_all(d.join("npc/when/disabled")).unwrap();
        fs::create_dir_all(d.join("npc/when/number")).unwrap();
        fs::create_dir_all(d.join("npc/when/undeclared")).unwrap();
        fs::write(d.join("npc/plain.txt"), "plain").unwrap();
        fs::write(d.join("npc/when/enabled/on.txt"), "on").unwrap();
        fs::write(d.join("npc/when/disabled/off.txt"), "off").unwrap();
        fs::write(d.join("npc/when/number/no.txt"), "number").unwrap();
        fs::write(d.join("npc/when/undeclared/no.txt"), "unknown").unwrap();

        let dst = d.join("build");
        copy_npc_layer(
            &d.join("npc"),
            &dst,
            "npc-test",
            &[
                ("enabled".into(), "true".into()),
                ("disabled".into(), "false".into()),
                ("number".into(), "1".into()),
            ],
        )
        .unwrap();
        let mut lines = String::new();
        collect_scripts(&dst, "npc/mods/npc-test", &mut lines);

        assert!(dst.join("plain.txt").is_file());
        assert!(dst.join("when/enabled/on.txt").is_file());
        assert!(!dst.join("when/disabled/off.txt").exists());
        assert!(!dst.join("when/number/no.txt").exists());
        assert!(!dst.join("when/undeclared/no.txt").exists());
        assert!(lines.contains("npc: npc/mods/npc-test/plain.txt\n"));
        assert!(lines.contains("npc: npc/mods/npc-test/when/enabled/on.txt\n"));
        assert!(!lines.contains("off.txt"));
    }

    /// Two mods' groups.yml used to resolve last-wins, discarding the first.
    /// Now both are in effect, and the repeat between them is left out once.
    #[test]
    fn two_mods_command_grants_are_combined_and_the_repeat_is_left_out() {
        let entries = vec![
            ("a".to_string(), format!("{GROUP_HEADER}  - Id: 0\n    Commands:\n      autoloot: true\n      showexp: true\n")),
            ("b".to_string(), format!("{GROUP_HEADER}  - Id: 0\n    Commands:\n      autoloot: true\n      go: true\n")),
            ("c".to_string(), "Header:\n  Type: ATCOMMAND_DB\n  Version: 1\nBody:\n  - Command: go\n".to_string()),
        ];
        let (body, notes) = combine_whole_conf("groups.yml", &entries, &[]);
        let body = body.unwrap();
        assert_eq!(body.matches("autoloot: true").count(), 1, "{body}");
        assert!(body.contains("showexp: true") && body.contains("go: true"), "{body}");
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(notes[0].contains("b gives group 0 @autoloot, which a already gives it"), "{}", notes[0]);
        assert!(notes[1].contains("c's conf/groups.yml is not the same kind of table"), "{}", notes[1]);
    }

    /// One mod on its own is written exactly as it shipped, so nothing about a
    /// mod that worked before changes.
    #[test]
    fn a_single_conf_file_is_written_as_it_shipped() {
        let body = format!("# mine\n{GROUP_HEADER}  - Id: 0\n    Commands:\n      autoloot: true\n");
        let (out, notes) = combine_whole_conf("groups.yml", &[("a".into(), body.clone())], &[]);
        assert_eq!(out.unwrap(), body);
        assert!(notes.is_empty());
    }

    /// The bundled player-commands grants must not repeat anything rAthena
    /// already gives group 0, with or without its @go and @warp options -- a
    /// repeat would cost it every other command in the group.
    #[test]
    fn the_bundled_player_commands_grant_repeats_nothing() {
        let own = include_str!("../../mods/player-commands/conf/groups.yml");
        let go = include_str!("../../mods/player-commands/conf/when/allow_go/groups.yml");
        let warp = include_str!("../../mods/player-commands/conf/when/allow_warp/groups.yml");
        let entries = vec![
            ("player-commands".to_string(), own.to_string()),
            ("player-commands (allow_go)".to_string(), go.to_string()),
            ("player-commands (allow_warp)".to_string(), warp.to_string()),
        ];
        let (body, notes) = combine_whole_conf("groups.yml", &entries, &[]);
        assert!(notes.is_empty(), "{notes:?}");
        let body = body.unwrap();
        assert!(body.contains("      autoloot: true") && body.contains("      go: true"), "{body}");
        assert!(body.contains("      mapmove: true"), "{body}");
        // Spelled with its alias, @warp is the same grant as mapmove.
        let aliased = format!("{GROUP_HEADER}  - Id: 0\n    Commands:\n      warp: true\n");
        let mut entries = entries;
        entries.push(("other".to_string(), aliased));
        let (_, notes) = combine_whole_conf("groups.yml", &entries, &[]);
        assert_eq!(notes.len(), 1, "{notes:?}");
        assert!(notes[0].contains("@mapmove (as \"warp\")"), "{}", notes[0]);
    }

    #[test]
    fn an_era_folder_must_be_a_folder_of_its_own_in_the_mod() {
        let d = tmp("era-folder");
        fs::create_dir_all(d.join("renewal")).unwrap();
        fs::create_dir_all(d.join("db")).unwrap();
        for (body, want) in [
            (r#"{"renewalFolder": "renewal"}"#, Ok("renewal")),
            (r#"{"renewalFolder": "renewal/"}"#, Ok("renewal")),
            (r#"{"prerenewalFolder": "pre"}"#, Err("not a folder in the mod")),
            (r#"{"renewalFolder": "db"}"#, Err("layer folders")),
            (r#"{"renewalFolder": "../renewal"}"#, Err("inside the mod")),
            (r#"{"renewalFolder": "/renewal"}"#, Err("inside the mod")),
            (r#"{"renewalFolder": 3}"#, Err("folder name")),
        ] {
            fs::write(d.join("mod.json"), body).unwrap();
            match (read_manifest(&d), want) {
                (Ok(Some(m)), Ok(folder)) => {
                    assert_eq!(m.renewal_folder, folder, "{body}");
                    assert_eq!(m.prerenewal_folder, "", "{body}");
                }
                (Err(e), Err(part)) => assert!(e.contains(part), "{body}: {e}"),
                (got, _) => panic!("{body}: {:?}", got.map(|m| m.map(|m| m.renewal_folder))),
            }
        }
    }

    /// `requires.client` takes one client or a list, and `"any"` is none.
    #[test]
    fn requires_client_names_the_clients_a_mod_is_for() {
        let read = |body: &str| client_names(&json::parse(body).unwrap());
        assert_eq!(read(r#"{"client": "kRO"}"#).unwrap(), vec!["kRO"]);
        assert_eq!(read(r#"{"client": ["kRO", "jRO", "kro"]}"#).unwrap(), vec!["kRO", "jRO"]);
        assert!(read(r#"{"client": "any"}"#).unwrap().is_empty());
        assert!(read(r#"{}"#).unwrap().is_empty());
        assert!(read(r#"{"client": "k/RO"}"#).is_err());
        assert!(read(r#"{"client": 3}"#).is_err());
        assert!(read(r#"{"client": [""]}"#).is_err());

        assert!(client_requirement_met(&["kRO".into()], Some("kRO")).is_ok());
        assert!(client_requirement_met(&["kRO".into()], Some("KRO")).is_ok(), "names compare without case");
        assert_eq!(
            client_requirement_met(&["kRO".into(), "jRO".into()], Some("iRO")).unwrap_err(),
            "is for kRO or jRO, and this client is iRO"
        );
        assert!(client_requirement_met(&["kRO".into()], None).is_ok(), "an undetected client refuses nothing");
        assert!(client_requirement_met(&[], Some("iRO")).is_ok());
    }

    /// A mod for another client is refused, with the reason Settings shows;
    /// the client comes from state/client-detected.json, which the shell writes.
    #[test]
    fn a_mod_for_another_client_is_refused_by_name() {
        let cfg = kind_config("client-refused");
        install(&cfg, "kro-items", r#"{"requires": {"client": "kRO"}}"#);
        let status = |cfg: &Config| scan(cfg).into_iter().find(|m| m.name == "kro-items").unwrap().status;
        assert_eq!(status(&cfg), Status::On, "no client detected yet: nothing refused");
        fs::write(cfg.state.join("client-detected.json"), r#"{"client": "iRO", "code": "us"}"#).unwrap();
        assert_eq!(status(&cfg), Status::Refused("is for kRO, and this client is iRO".into()));
        fs::write(cfg.state.join("client-detected.json"), r#"{"client": "kRO", "code": "kr"}"#).unwrap();
        assert_eq!(status(&cfg), Status::On);
        // An older manifest key list still names the new key in its message.
        install(&cfg, "typo", r#"{"requires": {"clients": "kRO"}}"#);
        let typo = scan(&cfg).into_iter().find(|m| m.name == "typo").unwrap().status;
        assert!(matches!(&typo, Status::Refused(r) if r.contains("\"client\"")), "{typo:?}");
    }

    /// The running client's folder goes over the mod's own and over its era
    /// folder; another client's folder is not read.
    #[test]
    fn the_running_clients_folder_takes_precedence() {
        let cfg = kind_config("client-assemble");
        fs::create_dir_all(cfg.root.join("db-import")).unwrap();
        install(&cfg, "both-clients", r#"{"renewalFolder": "re", "clientFolders": {"kRO": "kro", "iRO": "iro"}}"#);
        let dir = cfg.state.join("mods/both-clients");
        for sub in ["db", "re/db", "kro/db", "iro/npc"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        fs::write(dir.join("db/item_db.yml"), "# shared\n").unwrap();
        fs::write(dir.join("re/db/item_db.yml"), "# renewal\n").unwrap();
        fs::write(dir.join("kro/db/item_db.yml"), "# kRO\n").unwrap();
        fs::write(dir.join("iro/npc/iro.txt"), "iro").unwrap();
        let build = cfg.state.join("modbuild");

        let out = assemble(&cfg).unwrap();
        assert_eq!(fs::read_to_string(build.join("db/item_db.yml")).unwrap(), "# renewal\n", "no client known: era folder only");
        assert!(!out.npc_lines.contains("iro.txt"));

        fs::write(cfg.state.join("client-detected.json"), r#"{"client": "kRO"}"#).unwrap();
        let out = assemble(&cfg).unwrap();
        assert_eq!(fs::read_to_string(build.join("db/item_db.yml")).unwrap(), "# kRO\n");
        assert!(!out.npc_lines.contains("iro.txt"), "{}", out.npc_lines);

        fs::write(cfg.state.join("client-detected.json"), r#"{"client": "iRO"}"#).unwrap();
        let out = assemble(&cfg).unwrap();
        assert_eq!(fs::read_to_string(build.join("db/item_db.yml")).unwrap(), "# renewal\n");
        assert!(out.npc_lines.contains("npc: npc/mods/both-clients/iro.txt\n"), "{}", out.npc_lines);
    }

    /// A mod may declare up to 40 settings; one more is refused by name.
    #[test]
    fn a_mod_may_declare_forty_settings_and_no_more() {
        let cfg = kind_config("settings-limit");
        let dir = cfg.state.join("mods/m");
        fs::create_dir_all(&dir).unwrap();
        let settings = |n: usize| {
            let list: Vec<String> = (0..n).map(|i| format!(r#"{{"key": "s{i}", "type": "boolean", "default": true}}"#)).collect();
            format!(r#"{{"settings": [{}]}}"#, list.join(", "))
        };
        fs::write(dir.join("mod.json"), settings(40)).unwrap();
        assert_eq!(read_manifest(&dir).unwrap().unwrap().settings.len(), 40);
        fs::write(dir.join("mod.json"), settings(41)).unwrap();
        assert!(read_manifest(&dir).unwrap_err().contains("at most 40 settings"));
    }

    #[test]
    fn client_folders_are_checked_like_era_folders() {
        let cfg = kind_config("client-folders");
        let dir = cfg.state.join("mods/m");
        fs::create_dir_all(dir.join("kro")).unwrap();
        for (body, want) in [
            (r#"{"clientFolders": {"kRO": "kro"}}"#, Ok(())),
            (r#"{"clientFolders": {"kRO": "missing"}}"#, Err("not a folder in the mod")),
            (r#"{"clientFolders": {"kRO": "db"}}"#, Err("layer folders")),
            (r#"{"clientFolders": {"kRO": "../kro"}}"#, Err("inside the mod")),
            (r#"{"clientFolders": {"k/RO": "kro"}}"#, Err("not a client name")),
            (r#"{"clientFolders": ["kro"]}"#, Err("must be an object")),
        ] {
            fs::write(dir.join("mod.json"), body).unwrap();
            match (read_manifest(&dir), want) {
                (Ok(Some(m)), Ok(())) => assert_eq!(m.client_folders, vec![("kRO".to_string(), "kro".to_string())]),
                (Err(e), Err(w)) => assert!(e.contains(w), "{body}: {e}"),
                (got, _) => panic!("{body}: {:?}", got.map(|m| m.map(|m| m.client_folders))),
            }
        }
    }

    /// The running era's folder is laid over the mod's own: its table replaces
    /// the mod's, its scripts join them, and the other era's folder is not
    /// read at all. Switching era switches which copy is in effect.
    #[test]
    fn the_running_eras_folder_takes_precedence_and_the_other_is_ignored() {
        let cfg = kind_config("era-assemble");
        fs::create_dir_all(cfg.root.join("db-import")).unwrap();
        install(&cfg, "both-eras", r#"{"renewalFolder": "re", "prerenewalFolder": "pre-re"}"#);
        let dir = cfg.state.join("mods/both-eras");
        for sub in ["db", "npc", "re/db", "re/npc", "pre-re/db", "pre-re/lua"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        fs::write(dir.join("db/item_db.yml"), "# shared\n").unwrap();
        fs::write(dir.join("db/mob_db.yml"), "# shared mobs\n").unwrap();
        fs::write(dir.join("re/db/item_db.yml"), "# renewal\n").unwrap();
        fs::write(dir.join("pre-re/db/item_db.yml"), "# pre-renewal\n").unwrap();
        fs::write(dir.join("npc/common.txt"), "common").unwrap();
        fs::write(dir.join("re/npc/renewal.txt"), "renewal").unwrap();
        fs::write(dir.join("pre-re/lua/old.lua"), "-- pre").unwrap();

        let out = assemble(&cfg).unwrap();
        let build = cfg.state.join("modbuild");
        assert_eq!(fs::read_to_string(build.join("db/item_db.yml")).unwrap(), "# renewal\n");
        assert_eq!(fs::read_to_string(build.join("db/mob_db.yml")).unwrap(), "# shared mobs\n");
        assert!(out.npc_lines.contains("npc: npc/mods/both-eras/common.txt\n"), "{}", out.npc_lines);
        assert!(out.npc_lines.contains("npc: npc/mods/both-eras/renewal.txt\n"), "{}", out.npc_lines);
        assert!(!build.join("db/lua").exists(), "the pre-renewal lua/ is not read on renewal");

        fs::write(cfg.state.join("prerenewal"), "").unwrap();
        let out = assemble(&cfg).unwrap();
        assert_eq!(fs::read_to_string(build.join("db/item_db.yml")).unwrap(), "# pre-renewal\n");
        assert!(!out.npc_lines.contains("renewal.txt"), "{}", out.npc_lines);
        let list = fs::read_to_string(build.join("db/lua/load.txt")).unwrap();
        assert!(list.contains("both-eras\tlua/both-eras/old.lua\n"), "{list}");
        // Nothing about the era folders reaches rAthena as a folder of its own.
        assert!(!build.join("db/re").exists() && !build.join("db/pre-re").exists());
    }

    /// One mod, several independent Lua parts, each behind a checkbox. A part
    /// loads under its own name, "<mod>/<key>", because the engine keeps one
    /// hook per mod for a skill: two parts of one mod hooking NJ_KAENSIN must
    /// chain like two mods, not replace each other.
    #[test]
    fn lua_and_db_parts_behind_a_switch_load_only_when_it_is_on() {
        let cfg = kind_config("when-lua-db");
        fs::create_dir_all(cfg.root.join("db-import")).unwrap();
        install(
            &cfg,
            "parts",
            r#"{"settings": [
                {"key": "drain", "type": "boolean", "default": true},
                {"key": "polymorph", "type": "boolean", "default": false},
                {"key": "pin", "type": "boolean", "default": true}
            ]}"#,
        );
        let dir = cfg.state.join("mods/parts");
        for sub in ["lua/when/drain", "lua/when/polymorph", "db/when/pin"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        fs::write(dir.join("lua/common.lua"), "").unwrap();
        fs::write(dir.join("lua/when/drain/drain.lua"), "").unwrap();
        fs::write(dir.join("lua/when/polymorph/polymorph.lua"), "").unwrap();
        let header = "Header:\n  Type: EXTENSION_DB\n  Version: 1\n\nBody:\n";
        fs::write(dir.join("db/extension_db.yml"), format!("{header}  - Id: base_flag\n    Enabled: true\n")).unwrap();
        fs::write(dir.join("db/when/pin/extension_db.yml"), format!("{header}  - Id: pin_flag\n    Enabled: true\n"))
            .unwrap();

        assemble(&cfg).unwrap();
        let build = cfg.state.join("modbuild/db");
        let list = fs::read_to_string(build.join("lua/load.txt")).unwrap();
        let lines: Vec<&str> = list.lines().filter(|l| !l.starts_with('#')).collect();
        assert_eq!(
            lines,
            vec![
                "-\tlua/mod-settings.lua",
                "parts\tlua/parts/common.lua",
                "parts/drain\tlua/parts/when/drain/drain.lua",
            ]
        );
        // The part's table is added to the mod's own rather than replacing it.
        let ext = fs::read_to_string(build.join("extension_db.yml")).unwrap();
        assert!(ext.contains("Id: base_flag") && ext.contains("Id: pin_flag"), "{ext}");
        assert!(!build.join("when").exists(), "db/when/ is not a folder rAthena reads");

        // Switch them the other way round.
        save_settings(&cfg, "parts", r#"{"drain": false, "polymorph": true, "pin": false}"#).unwrap();
        assemble(&cfg).unwrap();
        let list = fs::read_to_string(build.join("lua/load.txt")).unwrap();
        assert!(list.contains("parts/polymorph\tlua/parts/when/polymorph/polymorph.lua\n"), "{list}");
        assert!(!list.contains("drain.lua"), "{list}");
        let ext = fs::read_to_string(build.join("extension_db.yml")).unwrap();
        assert!(ext.contains("Id: base_flag") && !ext.contains("Id: pin_flag"), "{ext}");
    }

    fn kind_config(tag: &str) -> Config {
        let root = tmp(tag);
        Config {
            root: root.join("app"),
            state: root.join("state"),
            nebula_home: root.join("nebula"),
            nebula: root.join("unused"),
            docker: root.join("unused"),
            image: String::new(),
            db_image: String::new(),
            ports: crate::ports::Ports::DEFAULT,
            app_version: None,
        }
    }

    fn install(cfg: &Config, name: &str, manifest: &str) {
        let dir = cfg.state.join("mods").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("mod.json"), manifest).unwrap();
    }

    fn on(cfg: &Config) -> Vec<String> {
        enabled(cfg).into_iter().map(|m| m.name).collect()
    }

    #[test]
    fn kind_is_skin_or_cursor_and_anything_else_is_named() {
        let d = tmp("kind");
        for (body, want) in [
            (r#"{"kind": "skin"}"#, Ok("skin")),
            (r#"{"kind": "cursor"}"#, Ok("cursor")),
            (r#"{}"#, Ok("")),
            (r#"{"kind": "skn"}"#, Err("\"skn\"")),
            (r#"{"kind": 3}"#, Err("a number")),
        ] {
            fs::write(d.join("mod.json"), body).unwrap();
            match (read_manifest(&d), want) {
                (Ok(Some(m)), Ok(kind)) => assert_eq!(m.kind, kind, "{body}"),
                (Err(e), Err(said)) => assert!(e.contains(said), "{body}: {e}"),
                (got, _) => panic!("{body}: {got:?}"),
            }
        }
    }

    // The navigation monster table merges mods' mob_db.yml the way the server
    // does (navmob.rs): mods in apply order, and within a mod the era folder's
    // copy replacing the mod's own, with its switched-on parts added after.
    #[test]
    fn server_tables_are_read_in_the_order_and_shape_assemble_writes_them() {
        let cfg = kind_config("applied");
        install(&cfg, "a-late", r#"{"after": ["b-early"]}"#);
        install(&cfg, "b-early", "{}");
        assert_eq!(on(&cfg), ["a-late", "b-early"]);
        let applied: Vec<String> = applied(&cfg).into_iter().map(|m| m.name).collect();
        assert_eq!(applied, ["b-early", "a-late"]);

        let dir = cfg.state.join("mods/eras");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("mod.json"),
            r#"{"renewalFolder": "re", "settings": [{"key": "x", "type": "boolean", "default": true}]}"#,
        )
        .unwrap();
        for f in ["db/mob_db.yml", "re/db/mob_db.yml", "db/when/x/mob_db.yml", "re/db/when/x/mob_db.yml"] {
            fs::create_dir_all(dir.join(f).parent().unwrap()).unwrap();
            fs::write(dir.join(f), "Body:\n").unwrap();
        }
        let m = enabled(&cfg).into_iter().find(|m| m.name == "eras").unwrap();
        let got: Vec<String> = db_sources(&cfg, &m, "mob_db.yml")
            .unwrap()
            .iter()
            .map(|p| p.strip_prefix(&dir).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(got, ["re/db/mob_db.yml", "db/when/x/mob_db.yml", "re/db/when/x/mob_db.yml"]);
        // Without the era copy, the mod's own.
        fs::remove_file(dir.join("re/db/mob_db.yml")).unwrap();
        assert_eq!(db_sources(&cfg, &m, "mob_db.yml").unwrap()[0], dir.join("db/mob_db.yml"));
    }

    // A skin overlays the whole interface folder, so two at once is a
    // patchwork. Switching one on switches the other off; mods without a kind,
    // and mods of the other kind, are left alone.
    #[test]
    fn switching_a_skin_on_switches_the_other_skin_off() {
        let cfg = kind_config("skins");
        install(&cfg, "skin-a", r#"{"kind": "skin"}"#);
        install(&cfg, "skin-b", r#"{"kind": "skin"}"#);
        install(&cfg, "cursor-red", r#"{"kind": "cursor"}"#);
        install(&cfg, "plain", "{}");

        // Dropped in by hand, nobody has chosen: the later name, whose files
        // would have won anyway, is the one on.
        assert_eq!(on(&cfg), ["cursor-red", "plain", "skin-b"]);

        assert_eq!(enable(&cfg, "skin-a").unwrap(), ["skin-b"]);
        assert_eq!(on(&cfg), ["cursor-red", "plain", "skin-a"]);

        assert_eq!(enable(&cfg, "skin-b").unwrap(), ["skin-a"]);
        assert_eq!(on(&cfg), ["cursor-red", "plain", "skin-b"]);

        // Off is off: no skin at all is a choice too.
        set_enabled(&cfg.state, "skin-b", false).unwrap();
        assert_eq!(on(&cfg), ["cursor-red", "plain"]);

        // A mod with no kind switches nothing else off.
        assert!(enable(&cfg, "plain").unwrap().is_empty());
        let rows = list(&cfg);
        let kind = |name: &str| rows.iter().find(|r| r[1] == name).unwrap()[12].clone();
        assert_eq!(kind("skin-a"), "skin");
        assert_eq!(kind("cursor-red"), "cursor");
        assert_eq!(kind("plain"), "");
    }

    /// Settings asks for the game to be reopened only when an applied change
    /// touched a mod with client layers, so a server-only mod must not claim
    /// one and a client one must not be missed -- including one whose client
    /// files are only in an era folder.
    #[test]
    fn client_layers_are_reported_for_the_game_window_only() {
        let mk = |name: &str, folders: &[&str], manifest: Manifest| {
            let d = tmp(name);
            for f in folders {
                fs::create_dir_all(d.join(f)).unwrap();
            }
            Installed { name: name.into(), dir: d, status: Status::Off, manifest, bundled: false, roots: Vec::new() }
        };
        assert!(!mk("client-server-only", &["db", "npc", "conf", "lua"], Manifest::default()).has_client_layers());
        for layer in CLIENT_LAYERS {
            assert!(mk(&format!("client-{layer}"), &[layer], Manifest::default()).has_client_layers(), "{layer}");
        }
        let era = Manifest { prerenewal_folder: "pre-renewal".into(), ..Manifest::default() };
        assert!(mk("client-era", &["npc", "pre-renewal/data"], era).has_client_layers());
    }

    /// With navigation-server-npcs on, a mod's scripts reach the client's NPC
    /// table, so changing one needs the game reopened; switching the
    /// navigation mod itself always does. Other server-only mods still don't.
    #[test]
    fn scripts_count_as_client_side_while_server_npcs_feed_navigation() {
        let cfg = kind_config("client-navnpc");
        install(&cfg, crate::navnpc::MOD, r#"{"default": "off"}"#);
        install(&cfg, "town", "{}");
        install(&cfg, "healers", "{}");
        install(&cfg, "rates", "{}");
        let mods = cfg.state.join("mods");
        fs::create_dir_all(mods.join("town/npc")).unwrap();
        fs::write(mods.join("healers/stock-npc.txt"), "npc/custom/healer.txt\n").unwrap();
        fs::create_dir_all(mods.join("rates/db")).unwrap();
        let client = |cfg: &Config| -> Vec<String> {
            list(cfg).into_iter().filter(|r| r[13] == "client").map(|r| r[1].clone()).collect()
        };
        assert_eq!(client(&cfg), [crate::navnpc::MOD]);
        enable(&cfg, crate::navnpc::MOD).unwrap();
        let mut on = client(&cfg);
        on.sort();
        assert_eq!(on, ["healers", crate::navnpc::MOD, "town"]);

        // The monster table also reads mob_db: a mod changing it, even behind
        // a setting, needs the game reopened while that mod is on.
        set_enabled(&cfg.state, crate::navnpc::MOD, false).unwrap();
        install(&cfg, crate::navmob::MOD, r#"{"default": "off"}"#);
        install(&cfg, "tougher", "{}");
        fs::create_dir_all(mods.join("tougher/db/when/hard")).unwrap();
        fs::write(mods.join("tougher/db/when/hard/mob_db.yml"), "Body:\n").unwrap();
        let mut off = client(&cfg);
        off.sort();
        assert_eq!(off, [crate::navmob::MOD, crate::navnpc::MOD]);
        enable(&cfg, crate::navmob::MOD).unwrap();
        let mut on = client(&cfg);
        on.sort();
        assert_eq!(on, ["healers", crate::navmob::MOD, crate::navnpc::MOD, "tougher", "town"]);

        // With only navigation-server-warps on, scripts count (they may hold
        // portals) and a mob_db does not.
        set_enabled(&cfg.state, crate::navmob::MOD, false).unwrap();
        install(&cfg, crate::navwarp::MOD, r#"{"default": "off"}"#);
        enable(&cfg, crate::navwarp::MOD).unwrap();
        let mut on = client(&cfg);
        on.sort();
        assert_eq!(on, ["healers", crate::navmob::MOD, crate::navnpc::MOD, crate::navwarp::MOD, "town"]);
    }
}
