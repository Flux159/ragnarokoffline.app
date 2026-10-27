//! Client tables a mod adds to instead of replacing.
//!
//! Most of a mod's client files replace the client's own, which is right for a
//! sprite or a font and wrong for a table that covers the whole game: shipping
//! `itemInfo` to name one item means shipping every item, and a mod that does
//! so takes every other item's name with it. roBrowser (our fork) loads a
//! *list* of such tables instead, after or before its own, so each table here
//! is copied aside under the mod's name and the list is written into
//! Config.local.js.
//!
//! There are two shapes:
//!
//! - **List tables** ([`ListTable`]): one file per mod, a config key holding the
//!   list. Items, quests, achievements, signboards, the four skill tables and
//!   the three status icon tables.
//!   A new one is a `ListTable` and an entry in [`LISTS`]; nothing else here
//!   or in `link` changes.
//! - **View tables** ([`ViewTables`]): the sprite tables behind a look, which
//!   the client loads as id/name *pairs*, so they are collected and paired.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use super::{copy_data_tree, copy_file, copy_over, entries};

/// How a list table's files are listed in the client config.
enum Order {
    /// After the base and each other, in mod order: the client takes the last
    /// definition, so a later mod wins over an earlier one, as in db/.
    ModOrder,
    /// The client takes the *first* table that defines an entry, so the list
    /// runs last mod first, and the base tables `base` finds come last. The
    /// base has to be named: the key replaces the client's default list rather
    /// than adding to it. After the base comes `fallback`, when there is one:
    /// a table for whatever the base does not define, which puts the key in
    /// the config even when no mod added to it.
    LastModFirst { base: fn(&Path) -> Vec<String>, fallback: fn(&Path) -> Option<String> },
    /// Written by the caller, not by `config_entries`, because the entry
    /// depends on more than the mods: see [`ModTables::package_supplements`].
    ByCaller,
}

/// Which of a mod's folders a table is found in.
#[derive(PartialEq)]
enum Layer {
    /// Directly in `System/`, matched by file name.
    System,
    /// Anywhere under `data/`, matched by the path below `data/` as the mod
    /// wrote it.
    Data,
}

/// A client table that mods add to as a list of further files.
pub struct ListTable {
    layer: Layer,
    /// Whether a file -- by its name in `System/`, or its path under `data/`,
    /// as `layer` says -- is one of the client's names for this table.
    matches: fn(&str) -> bool,
    /// A mod's copy is `<stem>-<mod>.<ext>`; a second in the same layer is
    /// `<stem>-<mod>.2.<ext>`. A dot cannot appear in a sanitised mod name, so
    /// that can never be another mod's file.
    stem: &'static str,
    ext: &'static str,
    /// Where the copies are, relative to the served root -- and so how the
    /// config names them.
    dir: &'static str,
    config_key: &'static str,
    order: Order,
}

/// `customItemInfo`: the tables that name every item (`itemInfo*`).
///
/// roBrowser registers each item from the first table that defines it
/// (`_processedItems` in DBManager.js), which is what lets a mod rename a stock
/// item.
pub const ITEMS: ListTable = ListTable {
    layer: Layer::System,
    matches: is_item_table,
    stem: "itemInfo",
    ext: "lua",
    dir: "System",
    config_key: "customItemInfo",
    order: Order::LastModFirst { base: base_item_tables, fallback: client_item_fallback },
};

/// `customQuestInfo`: quest titles, summaries and descriptions
/// (`OngoingQuestInfoList*`, #163). Loaded after the base, a quest at a time by
/// id.
pub const QUESTS: ListTable = ListTable {
    layer: Layer::System,
    matches: is_quest_table,
    stem: "OngoingQuestInfoList",
    ext: "lub",
    dir: "System",
    config_key: "customQuestInfo",
    order: Order::ModOrder,
};

/// `customAchievementInfo`: what the achievement window says about each
/// achievement -- its tab, title, goals and the reward it shows
/// (`achievement_list*`, #594). Loaded after the base, an achievement at a time
/// by id. Without it a mod's achievements counted on the server and never
/// appeared, and a mod shipping the table took every stock achievement's text.
pub const ACHIEVEMENTS: ListTable = ListTable {
    layer: Layer::System,
    matches: is_achievement_table,
    stem: "achievement_list",
    ext: "lub",
    dir: "System",
    config_key: "customAchievementInfo",
    order: Order::ModOrder,
};

/// `customSignBoardList`: the icons and signs drawn over NPCs
/// (`data/luafiles514/lua files/SignBoardList.lub`). One table for the whole
/// game, so a mod shipping its own to put an icon over its NPC used to take
/// away every Kafra's, tool dealer's and guide's. The client merges each over
/// the stock table by map and cell: a sign on a cell that already has one
/// replaces it, and every other is kept.
pub const SIGNBOARDS: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_signboard_table,
    stem: "SignBoardList",
    ext: "lub",
    dir: "data/luafiles514/lua files",
    config_key: "customSignBoardList",
    order: Order::ModOrder,
};

/// Where the client reads its skill tables from.
const SKILL_DIR: &str = "data/luafiles514/lua files/skillinfoz";

/// `customSkillId`: the names of a mod's new skills (`skillid.lub`), which
/// the other three skill tables use.
///
/// The four skill tables -- with [`SKILL_INFO`], [`SKILL_DESCRIPTIONS`] and
/// [`SKILL_TREE_VIEWS`] -- are each one table for every skill in the game, so
/// a mod shipping its own to add a skill used to take every stock skill's row
/// with it. The client reads every mod's names first and then the other
/// three, each in mod order and over its own by skill id: a later mod wins,
/// as in db/.
pub const SKILL_IDS: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_skill_id_table,
    stem: "skillid",
    ext: "lub",
    dir: SKILL_DIR,
    config_key: "customSkillId",
    order: Order::ModOrder,
};

/// `customSkillInfoList`: what the skill window knows of a skill
/// (`skillinfolist.lub`): its icon, name, levels, SP, range and what it needs.
pub const SKILL_INFO: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_skill_info_table,
    stem: "skillinfolist",
    ext: "lub",
    dir: SKILL_DIR,
    config_key: "customSkillInfoList",
    order: Order::ModOrder,
};

/// `customSkillDescript`: a skill's description (`skilldescript.lub`).
pub const SKILL_DESCRIPTIONS: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_skill_description_table,
    stem: "skilldescript",
    ext: "lub",
    dir: SKILL_DIR,
    config_key: "customSkillDescript",
    order: Order::ModOrder,
};

/// `customSkillTreeView`: where a job's skill window puts a skill
/// (`skilltreeview.lub`), and which skills it leaves out.
pub const SKILL_TREE_VIEWS: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_skill_tree_view_table,
    stem: "skilltreeview",
    ext: "lub",
    dir: SKILL_DIR,
    config_key: "customSkillTreeView",
    order: Order::ModOrder,
};

/// Where the client reads its status icon tables from.
const STATE_ICON_DIR: &str = "data/luafiles514/lua files/stateicon";

/// `customEfstIds`: the names of a mod's status icons (`efstids.lub`), which
/// the other two status icon tables use.
///
/// The three status icon tables -- with [`STATE_ICON_IMAGES`] and
/// [`STATE_ICON_INFO`] -- are each one table for every icon, like the skill
/// tables. A mod ships only its rows: names for its own icons, in the range
/// servers keep for mods (20000-22999 in our rAthena fork), their pictures
/// and tooltips, or a new picture or tooltip for a stock icon. The client
/// reads every mod's names, then its own pictures and tooltips, then the
/// mods', each in mod order: a later mod wins.
pub const STATE_ICON_IDS: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_state_icon_id_table,
    stem: "efstids",
    ext: "lub",
    dir: STATE_ICON_DIR,
    config_key: "customEfstIds",
    order: Order::ModOrder,
};

/// `customStateIconImgInfo`: the picture of a status icon
/// (`stateiconimginfo.lub`), a file the client finds in `data/texture/effect/`.
pub const STATE_ICON_IMAGES: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_state_icon_image_table,
    stem: "stateiconimginfo",
    ext: "lub",
    dir: STATE_ICON_DIR,
    config_key: "customStateIconImgInfo",
    order: Order::ModOrder,
};

/// `customStateIconInfo`: a status icon's tooltip (`stateiconinfo.lub`).
pub const STATE_ICON_INFO: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_state_icon_info_table,
    stem: "stateiconinfo",
    ext: "lub",
    dir: STATE_ICON_DIR,
    config_key: "customStateIconInfo",
    order: Order::ModOrder,
};

/// `itemPackageSupplement`: what a selection box offers
/// (`selectpackage/selectpackageitem.lub`), for boxes the client's own table
/// does not define. The box's choices on the server are the mod's
/// `db/item_packages.yml`; this is the window the client draws for it. Laid
/// over the stock path it would replace the client's own table whole, so it is
/// kept aside, and the client reads it as a supplement: one that never
/// replaces or extends a box the client already defines.
pub const PACKAGES: ListTable = ListTable {
    layer: Layer::Data,
    matches: is_package_table,
    stem: "selectpackageitem",
    ext: "lua",
    dir: PACKAGE_DIR,
    config_key: "itemPackageSupplement",
    order: Order::ByCaller,
};

/// Where the client reads its selection package table from.
const PACKAGE_DIR: &str = "data/luafiles514/lua files/selectpackage";

/// Every list table, in the order their config entries are written.
const LISTS: &[&ListTable] = &[
    &ITEMS,
    &QUESTS,
    &ACHIEVEMENTS,
    &SIGNBOARDS,
    &SKILL_IDS,
    &SKILL_INFO,
    &SKILL_DESCRIPTIONS,
    &SKILL_TREE_VIEWS,
    &STATE_ICON_IDS,
    &STATE_ICON_IMAGES,
    &STATE_ICON_INFO,
    &PACKAGES,
];

/// The list table a file under a mod's `data/` is, by its path there.
fn data_table(rel: &str) -> Option<&'static ListTable> {
    LISTS.iter().copied().find(|t| t.layer == Layer::Data && (t.matches)(rel))
}

/// The tables a mod -- or, once extended, every mod -- adds to the client's.
#[derive(Debug, Default, PartialEq)]
pub struct ModTables {
    /// File names, relative to their table's `dir`, by config key, in mod order.
    lists: BTreeMap<&'static str, Vec<String>>,
    pub views: ViewTables,
    /// `customMaps`: each map's sky, clouds, weather and music from the mods'
    /// mod.json (`Manifest::maps`), as the JavaScript object the fork's
    /// `DB/Map/CustomMaps.js` reads, by `<map>.rsw`. A later mod's entry for a
    /// map replaces an earlier one's, as in db/.
    custom_maps: BTreeMap<String, String>,
}

impl ModTables {
    /// The files a mod added to `table`, in mod order.
    pub fn list(&self, table: &ListTable) -> &[String] {
        self.lists.get(table.config_key).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn extend(&mut self, other: ModTables) {
        for (key, files) in other.lists {
            let list = self.lists.entry(key).or_default();
            // A mod's era or client folder replaces its own folder's copy of a
            // table under the same name: list that file once.
            for file in files {
                if !list.contains(&file) {
                    list.push(file);
                }
            }
        }
        self.views.extend(other.views);
        self.custom_maps.extend(other.custom_maps);
    }

    /// A mod's `"maps"`, after those of the mods before it.
    pub fn add_maps(&mut self, maps: &[crate::mods::MapLook]) {
        // Numbers as JavaScript reads them: 1 rather than 1.0 is the same
        // value, and `{}` never prints an exponent for a value from 0 to 1.
        let list = |c: &[f64]| c.iter().map(|n| format!("{n}")).collect::<Vec<_>>().join(", ");
        for look in maps {
            let mut fields = Vec::new();
            if let Some(sky) = &look.sky {
                fields.push(format!("skyColor: [{}]", list(sky)));
            }
            if let Some(clouds) = &look.clouds {
                fields.push(format!("cloudColor: [{}]", list(clouds)));
            }
            if let Some(weather) = &look.weather {
                fields.push(format!("weather: {}", crate::json::quote(weather)));
            }
            if let Some(bgm) = &look.bgm {
                fields.push(format!("bgm: {}", crate::json::quote(bgm)));
            }
            self.custom_maps.insert(format!("{}.rsw", look.name), format!("{{ {} }}", fields.join(", ")));
        }
    }

    /// Copy `from` into `dir` as this mod's next table of its kind, numbered
    /// among the ones already in `self`.
    fn keep_aside(&mut self, table: &ListTable, from: &Path, dir: &Path, safe: &str) -> Result<(), String> {
        let name = match self.list(table).len() {
            0 => format!("{}-{safe}.{}", table.stem, table.ext),
            n => format!("{}-{safe}.{}.{}", table.stem, n + 1, table.ext),
        };
        copy_file(from, &dir.join(&name))?;
        self.lists.entry(table.config_key).or_default().push(name);
        Ok(())
    }

    /// The mods' selection package tables, by their path from the served
    /// root, last mod first: the client lets the first supplement that defines
    /// a box own it, so a later mod wins, as in db/.
    pub fn package_supplements(&self) -> Vec<String> {
        self.list(&PACKAGES).iter().rev().map(|f| format!("{}/{f}", PACKAGES.dir)).collect()
    }

    /// The Config.local.js entries, one per kind a mod added to. `web` is the
    /// served root, where `LastModFirst` finds the base tables.
    pub fn config_entries(&self, web: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for table in LISTS {
            let files = self.list(table);
            let path = |f: &String| format!("{}/{f}", table.dir);
            let names: Vec<String> = match table.order {
                Order::ByCaller => continue,
                Order::ModOrder if files.is_empty() => continue,
                Order::ModOrder => files.iter().map(path).collect(),
                Order::LastModFirst { base, fallback } => {
                    let fallback = fallback(web);
                    if files.is_empty() && fallback.is_none() {
                        continue;
                    }
                    files.iter().rev().map(path).chain(base(web)).chain(fallback).collect()
                }
            };
            let list = names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ");
            out.push(format!("\t{}: [{list}],\n", table.config_key));
        }
        if !self.views.is_empty() {
            out.push(self.views.config_entry());
        }
        if !self.custom_maps.is_empty() {
            let maps: Vec<String> = self
                .custom_maps
                .iter()
                .map(|(map, look)| format!("\t\t{}: {look}", crate::json::quote(map)))
                .collect();
            out.push(format!("\tcustomMaps: {{\n{}\n\t}},\n", maps.join(",\n")));
        }
        out
    }
}

/// Say what in a mod folder (`root`: the mod's own, or its era's) is a table
/// in a place the client never reads it from.
pub(super) fn warn_misplaced(root: &Path, mod_name: &str) {
    for message in misplaced(root, mod_name) {
        eprintln!("{message}");
    }
}

/// `warn_misplaced`'s messages. Item tables directly in `System/` are added;
/// one in a folder under it, or anywhere under `data/`, is never read.
fn misplaced(root: &Path, mod_name: &str) -> Vec<String> {
    let nested = item_tables_under(&root.join("System"), "System")
        .into_iter()
        .filter(|found| found["System/".len()..].contains('/'))
        .map(|found| {
            format!(
                "mods: {mod_name} has {found}, but the client only adds item tables that sit \
                 directly in System/ -- move it there"
            )
        });
    let under_data = item_tables_under(&root.join("data"), "data").into_iter().map(|found| {
        format!(
            "mods: {mod_name} has {found}, but the client reads item tables only from System/ -- \
             move it to System/"
        )
    });
    let mut out: Vec<String> = nested.chain(under_data).collect();
    // A signboard table anywhere but the one path under data/: in System/,
    // or a folder off under data/. Either is copied like any file, and the
    // client goes on drawing only the stock signs.
    let signs = files_under(&root.join("System"), "System", is_signboard_name)
        .into_iter()
        .chain(
            files_under(&root.join("data"), "data", is_signboard_name)
                .into_iter()
                .filter(|found| !is_signboard_table(&found["data/".len()..])),
        );
    for found in signs {
        out.push(format!(
            "mods: {mod_name} has {found}, but the client reads signboard tables only from {}/ -- move it there",
            SIGNBOARDS.dir
        ));
    }
    // The same for the skill tables, which are read only from skillinfoz/.
    let skills = files_under(&root.join("System"), "System", is_skill_table_name).into_iter().chain(
        files_under(&root.join("data"), "data", is_skill_table_name)
            .into_iter()
            .filter(|found| data_table(&found["data/".len()..]).is_none()),
    );
    for found in skills {
        out.push(format!(
            "mods: {mod_name} has {found}, but the client reads skill tables only from {SKILL_DIR}/ -- move it there"
        ));
    }
    // And the status icon tables, read only from stateicon/.
    let icons = files_under(&root.join("System"), "System", is_state_icon_table_name).into_iter().chain(
        files_under(&root.join("data"), "data", is_state_icon_table_name)
            .into_iter()
            .filter(|found| data_table(&found["data/".len()..]).is_none()),
    );
    for found in icons {
        out.push(format!(
            "mods: {mod_name} has {found}, but the client reads status icon tables only from {STATE_ICON_DIR}/ -- move it there"
        ));
    }
    out
}

/// Copy a mod's `data/` layer over the served root `web`'s, keeping a table
/// the client merges -- the signboard list -- aside instead of over the stock
/// one, which it would replace whole.
pub fn copy_data_layer(src: &Path, web: &Path, mod_name: &str) -> Result<ModTables, String> {
    let mut tables = ModTables::default();
    let safe = safe_name(mod_name);
    for (table, from) in copy_data_tree(src, &web.join("data"), data_table)? {
        tables.keep_aside(table, &from, &web.join(table.dir), &safe)?;
    }
    Ok(tables)
}

/// Copy a mod's `System/` layer, keeping the client's whole-game tables as
/// *additions*.
///
/// Everything else in `System/` replaces the client's copy, as before. Nothing
/// is lost by making the tables additive: a mod that really wants to replace
/// one can still ship a complete one, and defining every id is
/// indistinguishable from replacing.
pub fn copy_system_layer(src: &Path, merged: &Path, mod_name: &str) -> Result<ModTables, String> {
    let mut tables = ModTables::default();
    let mut views = ViewFiles::default();
    if !src.exists() {
        return Ok(tables);
    }
    // Named for the mod so two mods can each ship one, and so the file cannot
    // collide with the translation's own copy.
    let safe = safe_name(mod_name);
    'files: for e in entries(src)? {
        if e.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err(format!(
                "overlay source contains a link: {}",
                e.path().display()
            ));
        }
        let from = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if from.is_file() {
            for table in LISTS.iter().filter(|t| t.layer == Layer::System) {
                if (table.matches)(&name) {
                    tables.keep_aside(table, &from, merged, &safe)?;
                    continue 'files;
                }
            }
        }
        if let (true, Some((kind, role))) = (from.is_file(), view_table(&name)) {
            // The sprite tables behind a new monster's or item's look. Copied
            // aside like item tables, and paired below.
            let ext = if name.to_lowercase().ends_with(".lua") { "lua" } else { "lub" };
            let stem = name[..name.rfind('.').unwrap_or(name.len())].to_string();
            let dst_name = format!("{stem}-{safe}.{ext}");
            if views.has(kind, role) {
                eprintln!("mods: {mod_name} has more than one {kind} {role} table in System/; only the first is used");
                continue;
            }
            copy_file(&from, &merged.join(&dst_name))?;
            views.set(kind, role, dst_name);
        } else if from.is_dir() {
            copy_over(&from, &merged.join(&name))?;
        } else {
            // This destination belongs to the staged generation.
            let to = merged.join(&name);
            copy_file(&from, &to)?;
        }
    }
    tables.views = views.pair(merged, mod_name)?;
    Ok(tables)
}

/// The client's sprite tables that a mod adds rows to (`customLuaTables` in
/// the roBrowser fork's DBManager.js). Each is an id file and a name file in
/// the official format, except weapons, which are one file:
///
///   accessory  accessoryid + accname          what a headgear looks like on you
///   robe       spriterobeid + spriterobename  what a garment looks like
///   monster    npcidentity + jobname          which sprite a monster/NPC id uses
///   weapon     weapontable                    what a weapon looks like
///
/// Loaded after the base, in mod order, and merged over it by id: the last
/// mod to define an id wins, as in db/.
#[derive(Debug, Default, PartialEq)]
pub struct ViewTables {
    pub accessory: Vec<(String, String)>,
    pub robe: Vec<(String, String)>,
    pub monster: Vec<(String, String)>,
    pub weapon: Vec<String>,
}

impl ViewTables {
    fn extend(&mut self, other: ViewTables) {
        self.accessory.extend(other.accessory);
        self.robe.extend(other.robe);
        self.monster.extend(other.monster);
        self.weapon.extend(other.weapon);
    }

    fn is_empty(&self) -> bool {
        self.accessory.is_empty() && self.robe.is_empty() && self.monster.is_empty() && self.weapon.is_empty()
    }

    /// The `customLuaTables` entry for Config.local.js.
    fn config_entry(&self) -> String {
        let pairs = |list: &[(String, String)]| {
            list.iter()
                .map(|(id, name)| format!("['System/{id}', 'System/{name}']"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut parts = Vec::new();
        for (key, list) in [("accessory", &self.accessory), ("robe", &self.robe), ("monster", &self.monster)] {
            if !list.is_empty() {
                parts.push(format!("{key}: [{}]", pairs(list)));
            }
        }
        if !self.weapon.is_empty() {
            let files = self.weapon.iter().map(|f| format!("'System/{f}'")).collect::<Vec<_>>().join(", ");
            parts.push(format!("weapon: [{files}]"));
        }
        format!("\tcustomLuaTables: {{ {} }},\n", parts.join(", "))
    }
}

/// One mod's view-table files, before they are paired up.
#[derive(Default)]
struct ViewFiles {
    files: BTreeMap<(&'static str, &'static str), String>,
}

impl ViewFiles {
    fn has(&self, kind: &'static str, role: &'static str) -> bool {
        self.files.contains_key(&(kind, role))
    }

    fn set(&mut self, kind: &'static str, role: &'static str, file: String) {
        self.files.insert((kind, role), file);
    }

    /// Pair each id file with its name file. A name table whose keys are plain
    /// numbers needs no id file, but the client always loads one first, so it
    /// gets an empty stand-in. An id file with no names is only a warning.
    fn pair(self, merged: &Path, mod_name: &str) -> Result<ViewTables, String> {
        let mut out = ViewTables::default();
        for kind in ["accessory", "robe", "monster"] {
            let id = self.files.get(&(kind, "id")).cloned();
            let Some(name) = self.files.get(&(kind, "name")).cloned() else {
                if id.is_some() {
                    eprintln!("mods: {mod_name} has a {kind} id table in System/ but no name table beside it, so it does nothing");
                }
                continue;
            };
            let id = match id {
                Some(id) => id,
                None => {
                    // One stand-in per mod and table, never shared: the client
                    // mounts each id file under its own name while it loads, and
                    // two loads of one name at once unmount it from under each
                    // other, which leaves its Lua state unusable (every table
                    // after that fails with "memory access out of bounds").
                    let stub = format!("ids-none-{kind}-{}.lua", safe_name(mod_name));
                    fs::write(merged.join(&stub), "-- An id table for a name table that needs none.\n")
                        .map_err(|e| format!("writing {stub}: {e}"))?;
                    stub
                }
            };
            let entry = (id, name);
            match kind {
                "accessory" => out.accessory.push(entry),
                "robe" => out.robe.push(entry),
                _ => out.monster.push(entry),
            }
        }
        if let Some(weapon) = self.files.get(&("weapon", "table")) {
            out.weapon.push(weapon.clone());
        }
        Ok(out)
    }
}

/// A mod name as part of a file name: anything but ASCII letters, digits, `-`
/// and `_` becomes `-`.
fn safe_name(mod_name: &str) -> String {
    mod_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Which view table a file in `System/` is, by the client's own file names:
/// `accname.lub`, `jobname.lua`, `accessoryid_custom.lub`, ...
fn view_table(name: &str) -> Option<(&'static str, &'static str)> {
    let lower = name.to_lowercase();
    if !(lower.ends_with(".lua") || lower.ends_with(".lub")) {
        return None;
    }
    // Longer prefixes first: spriterobeid and spriterobename share a start.
    const TABLES: [(&str, &str, &str); 7] = [
        ("accessoryid", "accessory", "id"),
        ("accname", "accessory", "name"),
        ("spriterobeid", "robe", "id"),
        ("spriterobename", "robe", "name"),
        ("npcidentity", "monster", "id"),
        ("jobname", "monster", "name"),
        ("weapontable", "weapon", "table"),
    ];
    TABLES
        .iter()
        .find(|(prefix, _, _)| lower.starts_with(prefix))
        .map(|(_, kind, role)| (*kind, *role))
}

/// `OngoingQuestInfoList.lub`, `OngoingQuestInfoList_True.lub` -- the quest
/// table under any name the client's own goes by.
fn is_quest_table(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with("ongoingquestinfolist") && (lower.ends_with(".lua") || lower.ends_with(".lub"))
}

/// `achievement_list.lub`, `Achievement_List.lua` -- the achievement table under
/// any name that starts like the client's own, in any case.
fn is_achievement_table(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with("achievement_list") && (lower.ends_with(".lua") || lower.ends_with(".lub"))
}

/// `luafiles514/lua files/SignBoardList.lub` under `data/`, in any case, or as
/// `.lua`. The translation's `signboardlist_f.lub` is a different file.
fn is_signboard_table(rel: &str) -> bool {
    let read_from = SIGNBOARDS.dir.strip_prefix("data/").unwrap_or(SIGNBOARDS.dir);
    rel.rsplit_once('/').is_some_and(|(dir, name)| dir.to_lowercase() == read_from && is_signboard_name(name))
}

/// A file named like the signboard table, wherever it is.
fn is_signboard_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "signboardlist.lub" || lower == "signboardlist.lua"
}

/// `luafiles514/lua files/selectpackage/selectpackageitem.lub` under `data/`,
/// in any case, or as `.lua`.
fn is_package_table(rel: &str) -> bool {
    is_table_in(PACKAGE_DIR, rel, "selectpackageitem")
}

/// The client's names for its four skill tables, without the extension.
const SKILL_STEMS: [&str; 4] = ["skillid", "skillinfolist", "skilldescript", "skilltreeview"];

/// `<dir>/<stem>.lub` under `data/` (`dir` as the client reads it, from
/// `data/`), in any case, or as `.lua`.
fn is_table_in(dir: &str, rel: &str, stem: &str) -> bool {
    let read_from = dir.strip_prefix("data/").unwrap_or(dir);
    rel.rsplit_once('/').is_some_and(|(dir, name)| {
        let name = name.to_lowercase();
        dir.to_lowercase() == read_from && name.strip_prefix(stem).is_some_and(|ext| ext == ".lub" || ext == ".lua")
    })
}

/// `luafiles514/lua files/skillinfoz/<stem>.lub` under `data/`, in any case,
/// or as `.lua`.
fn is_skill_table(rel: &str, stem: &str) -> bool {
    is_table_in(SKILL_DIR, rel, stem)
}

fn is_skill_id_table(rel: &str) -> bool {
    is_skill_table(rel, "skillid")
}

fn is_skill_info_table(rel: &str) -> bool {
    is_skill_table(rel, "skillinfolist")
}

fn is_skill_description_table(rel: &str) -> bool {
    is_skill_table(rel, "skilldescript")
}

fn is_skill_tree_view_table(rel: &str) -> bool {
    is_skill_table(rel, "skilltreeview")
}

/// A file named like one of the skill tables, wherever it is.
fn is_skill_table_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    SKILL_STEMS
        .iter()
        .any(|stem| lower.strip_prefix(stem).is_some_and(|ext| ext == ".lub" || ext == ".lua"))
}

/// The client's names for its three status icon tables, without the extension.
const STATE_ICON_STEMS: [&str; 3] = ["efstids", "stateiconimginfo", "stateiconinfo"];

fn is_state_icon_id_table(rel: &str) -> bool {
    is_table_in(STATE_ICON_DIR, rel, "efstids")
}

fn is_state_icon_image_table(rel: &str) -> bool {
    is_table_in(STATE_ICON_DIR, rel, "stateiconimginfo")
}

fn is_state_icon_info_table(rel: &str) -> bool {
    is_table_in(STATE_ICON_DIR, rel, "stateiconinfo")
}

/// A file named like one of the status icon tables, wherever it is.
fn is_state_icon_table_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    STATE_ICON_STEMS
        .iter()
        .any(|stem| lower.strip_prefix(stem).is_some_and(|ext| ext == ".lub" || ext == ".lua"))
}

/// `itemInfo.lua`, `itemInfo_C.lua`, `iteminfo.lub` -- any name the client's
/// own item tables go by.
fn is_item_table(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with("iteminfo") && (lower.ends_with(".lua") || lower.ends_with(".lub"))
}

/// Item tables anywhere under `dir`, as paths starting with `label`.
///
/// For the places a mod author reasonably puts one and the client never reads
/// it from -- `System/LuaFiles514/`, `data/luafiles514/` -- so the mod says why
/// its items are nameless instead of just being nameless.
fn item_tables_under(dir: &Path, label: &str) -> Vec<String> {
    files_under(dir, label, is_item_table)
}

/// Files anywhere under `dir` whose name `is` picks, as paths starting with
/// `label`, in name order.
fn files_under(dir: &Path, label: &str, is: fn(&str) -> bool) -> Vec<String> {
    let mut found = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return found };
    let mut children: Vec<_> = rd.flatten().collect();
    children.sort_by_key(|e| e.file_name());
    for e in children {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if path.is_dir() {
            found.extend(files_under(&path, &format!("{label}/{name}"), is));
        } else if is(&name) {
            found.push(format!("{label}/{name}"));
        }
    }
    found
}

/// The base item tables to name in `customItemInfo`: those the staged `System/`
/// actually holds, in the order the client itself tries them
/// (`getSystemAliases` in DBManager.js). A client whose table is
/// `itemInfo_true.lub` used to lose every stock item's name the moment a mod
/// added one, because only `itemInfo.lub` and `itemInfo.lua` were named.
fn base_item_tables(web: &Path) -> Vec<String> {
    let mut names = Vec::new();
    for suffix in ["", "_true", "_sak", "_Sakray"] {
        for ext in [".lub", ".lua"] {
            let file = format!("itemInfo{suffix}{ext}");
            if web.join("System").join(&file).is_file() {
                names.push(format!("System/{file}"));
            }
        }
    }
    if names.is_empty() {
        names = vec!["System/itemInfo.lub".to_string(), "System/itemInfo.lua".to_string()];
    }
    names
}

/// What the client's own item table is called once staged behind the English
/// one. An underscore, so no mod's copy (`itemInfo-<mod>.lua`) is ever this
/// file, and no suffix the client tries on its own (`base_item_tables`).
const CLIENT_ITEM_STEM: &str = "itemInfo_client";

/// Stage the client's own item table in `merged` (the served `System/`) as
/// [`CLIENT_ITEM_STEM`], to be read after the English one: an item the
/// translation does not name -- iRO's own costumes and shards, 664 of the
/// renewal item db's against iRO's data in October 2026 -- then has the
/// client's name and art instead of none. Its main table, in the order the
/// client tries them, in any case (iRO's is `iteminfo.lub`); a test server's
/// (`_sak`) is not one. Returns whether one was staged.
pub(super) fn stage_client_item_table(sys: &Path, merged: &Path) -> Result<bool, String> {
    let files: Vec<_> = entries(sys)?.into_iter().filter(|e| e.path().is_file()).collect();
    for wanted in ["iteminfo.lub", "iteminfo.lua", "iteminfo_true.lub", "iteminfo_true.lua"] {
        let Some(e) = files.iter().find(|e| e.file_name().to_string_lossy().to_lowercase() == wanted) else {
            continue;
        };
        let ext = &wanted[wanted.len() - 3..];
        copy_file(&e.path(), &merged.join(format!("{CLIENT_ITEM_STEM}.{ext}")))?;
        return Ok(true);
    }
    Ok(false)
}

/// The staged client item table, as `customItemInfo` names it, if there is one.
fn client_item_fallback(web: &Path) -> Option<String> {
    ["lub", "lua"]
        .into_iter()
        .map(|ext| format!("{CLIENT_ITEM_STEM}.{ext}"))
        .find(|file| web.join("System").join(file).is_file())
        .map(|file| format!("System/{file}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ro-tables-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// A mod that adds one item must not have to ship the whole table.
    #[test]
    fn custom_maps_are_written_for_the_fork_with_a_later_mod_winning() {
        use crate::mods::MapLook;
        let look = |name: &str, sky: [f64; 4], weather: Option<&str>| MapLook {
            name: name.into(),
            sky: Some(sky),
            clouds: Some([1.0, 1.0, 1.0]),
            weather: weather.map(str::to_string),
            bgm: None,
        };
        let mut tables = ModTables::default();
        assert!(tables.config_entries(Path::new("/nowhere")).is_empty(), "no mod, no entry");
        tables.add_maps(&[look("ro_isle", [0.4, 0.6, 0.8, 1.0], None), look("my_cave", [0.0, 0.0, 0.1, 1.0], Some("snow"))]);
        let mut later = ModTables::default();
        let mut music = look("ro_isle", [1.0, 0.5, 0.2, 1.0], None);
        music.bgm = Some("ro_isle.mp3".into());
        later.add_maps(&[music]);
        tables.extend(later);
        assert_eq!(
            tables.config_entries(Path::new("/nowhere")),
            vec![
                "\tcustomMaps: {\n\
                 \t\t\"my_cave.rsw\": { skyColor: [0, 0, 0.1, 1], cloudColor: [1, 1, 1], weather: \"snow\" },\n\
                 \t\t\"ro_isle.rsw\": { skyColor: [1, 0.5, 0.2, 1], cloudColor: [1, 1, 1], bgm: \"ro_isle.mp3\" }\n\
                 \t},\n"
                    .to_string()
            ]
        );
    }

    #[test]
    fn an_item_table_is_kept_aside_rather_than_replacing_the_base() {
        let tmp = tmp("item");
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        // The base table, as link() leaves it.
        write(&merged.join("itemInfo.lua"), "BASE");
        write(&src.join("itemInfo.lua"), "MOD ADDITIONS");
        write(&src.join("OngoingQuests.lub"), "other table");

        let tables = copy_system_layer(&src, &merged, "my-mod").unwrap();

        assert_eq!(tables.list(&ITEMS), ["itemInfo-my-mod.lua"]);
        // The base is untouched...
        assert_eq!(fs::read_to_string(merged.join("itemInfo.lua")).unwrap(), "BASE");
        // ...the mod's copy is beside it...
        assert_eq!(fs::read_to_string(merged.join("itemInfo-my-mod.lua")).unwrap(), "MOD ADDITIONS");
        // ...and everything else in System/ still replaces as before.
        assert_eq!(fs::read_to_string(merged.join("OngoingQuests.lub")).unwrap(), "other table");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// The client's own item table comes after the English base, and after
    /// every mod's: it only names what nothing before it does. Its main table
    /// is the one staged, in any case; a test server's is not.
    #[test]
    fn the_client_s_item_table_comes_last() {
        let tmp = tmp("client-items");
        let (client, src, web) = (tmp.join("client/System"), tmp.join("mod/System"), tmp.join("web"));
        let merged = web.join("System");
        write(&merged.join("itemInfo.lua"), "ENGLISH");
        write(&client.join("iteminfo_sak.lub"), "TEST SERVER");
        write(&client.join("iteminfo.lub"), "CLIENT");
        write(&src.join("itemInfo.lua"), "MOD");
        assert!(stage_client_item_table(&client, &merged).unwrap());
        assert_eq!(fs::read_to_string(merged.join("itemInfo_client.lub")).unwrap(), "CLIENT");

        // No mod adds an item: the key is written for the client's table alone.
        assert_eq!(
            ModTables::default().config_entries(&web),
            ["\tcustomItemInfo: ['System/itemInfo.lua', 'System/itemInfo_client.lub'],\n"]
        );
        let tables = copy_system_layer(&src, &merged, "story").unwrap();
        assert_eq!(
            tables.config_entries(&web),
            ["\tcustomItemInfo: ['System/itemInfo-story.lua', 'System/itemInfo.lua', 'System/itemInfo_client.lub'],\n"]
        );

        // A client with no item table of its own: nothing staged, no key.
        let none = tmp.join("bare/System");
        write(&none.join("font.ttf"), "font");
        let bare = tmp.join("bare-web");
        write(&bare.join("System/itemInfo.lua"), "ENGLISH");
        assert!(!stage_client_item_table(&none, &bare.join("System")).unwrap());
        assert!(ModTables::default().config_entries(&bare).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod's quest table sits beside the base instead of replacing it, so
    /// adding one quest keeps every other quest's title (#163).
    #[test]
    fn a_quest_table_is_kept_aside_rather_than_replacing_the_base() {
        let tmp = tmp("quest");
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        write(&merged.join("OngoingQuestInfoList.lub"), "BASE");
        write(&src.join("OngoingQuestInfoList.lub"), "MOD QUESTS");
        write(&src.join("OngoingQuestInfoList_True.lub"), "MORE QUESTS");
        let tables = copy_system_layer(&src, &merged, "story").unwrap();
        assert!(tables.list(&ITEMS).is_empty());
        assert_eq!(tables.list(&QUESTS), ["OngoingQuestInfoList-story.lub", "OngoingQuestInfoList-story.2.lub"]);
        assert_eq!(fs::read_to_string(merged.join("OngoingQuestInfoList.lub")).unwrap(), "BASE");
        assert_eq!(fs::read_to_string(merged.join("OngoingQuestInfoList-story.lub")).unwrap(), "MOD QUESTS");
        assert_eq!(fs::read_to_string(merged.join("OngoingQuestInfoList-story.2.lub")).unwrap(), "MORE QUESTS");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod's achievement table sits beside the base instead of replacing
    /// it, so adding one achievement keeps every stock one's text (#594). A
    /// `.lua` source is listed as `.lub`, which the client runs all the same.
    #[test]
    fn an_achievement_table_is_kept_aside_rather_than_replacing_the_base() {
        let tmp = tmp("achievement");
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        write(&merged.join("achievement_list.lub"), "BASE");
        write(&src.join("achievement_list.lub"), "MOD ACHIEVEMENTS");
        write(&src.join("achievement_list_more.lua"), "MORE ACHIEVEMENTS");
        assert!(is_achievement_table("Achievement_List.LUB"));
        let tables = copy_system_layer(&src, &merged, "deeds").unwrap();
        assert!(tables.list(&ITEMS).is_empty() && tables.list(&QUESTS).is_empty());
        assert_eq!(tables.list(&ACHIEVEMENTS), ["achievement_list-deeds.lub", "achievement_list-deeds.2.lub"]);
        assert_eq!(fs::read_to_string(merged.join("achievement_list.lub")).unwrap(), "BASE");
        assert_eq!(fs::read_to_string(merged.join("achievement_list-deeds.lub")).unwrap(), "MOD ACHIEVEMENTS");
        assert_eq!(fs::read_to_string(merged.join("achievement_list-deeds.2.lub")).unwrap(), "MORE ACHIEVEMENTS");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Achievement tables load after the base and the last definition of an
    /// achievement wins, so they are listed in mod order -- and a table only
    /// named like one elsewhere in the tree is not added.
    #[test]
    fn achievement_tables_are_listed_in_mod_order() {
        let tmp = tmp("achievement-order");
        let mut all = ModTables::default();
        for m in ["a", "b"] {
            let src = tmp.join(m).join("System");
            write(&src.join("achievement_list.lub"), m);
            all.extend(copy_system_layer(&src, &tmp.join("merged"), m).unwrap());
        }
        assert_eq!(
            all.config_entries(&tmp.join("web")),
            vec!["\tcustomAchievementInfo: ['System/achievement_list-a.lub', 'System/achievement_list-b.lub'],\n".to_string()]
        );
        assert!(!is_achievement_table("achievements.lub"), "the translation's name for it, not the client's");
        assert!(!is_achievement_table("achievement_list.txt"));
        assert!(data_table("luafiles514/lua files/achievement_list.lub").is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Two pairs that need a stand-in id table each get their own: the client
    /// mounts id files by name, and a shared one broke every table after it.
    #[test]
    fn stand_in_id_tables_are_never_shared() {
        let tmp = tmp("stubs");
        let merged = tmp.join("merged");
        fs::create_dir_all(&merged).unwrap();
        let a = tmp.join("a/System");
        write(&a.join("accname.lub"), "AccNameTable = { [5001] = \"_x\" }");
        write(&a.join("jobname.lub"), "JobNameTable = { [25001] = \"PORING\" }");
        let views = copy_system_layer(&a, &merged, "a").unwrap().views;
        let mut stubs = vec![views.accessory[0].0.clone(), views.monster[0].0.clone()];
        stubs.sort();
        stubs.dedup();
        assert_eq!(stubs.len(), 2, "{stubs:?}");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A new monster's sprite and a new headgear's look are rows added to the
    /// client's tables, not replacements of them: each file is kept aside under
    /// the mod's name and paired, and the base is untouched.
    #[test]
    fn view_tables_are_kept_aside_paired_and_listed_in_mod_order() {
        let tmp = tmp("views");
        let merged = tmp.join("merged");
        fs::create_dir_all(&merged).unwrap();
        write(&merged.join("accname.lub"), "BASE");
        let a = tmp.join("a/System");
        write(&a.join("npcidentity.lub"), "jobtbl.JT_MY_MOB = 31001");
        write(&a.join("jobname.lub"), "JobNameTable = { [jobtbl.JT_MY_MOB] = \"MY_MOB\" }");
        write(&a.join("accname.lua"), "AccNameTable = { [2001] = \"_my_hat\" }");
        write(&a.join("weapontable.lub"), "WeaponNameTable = {}");
        write(&a.join("spriterobeid.lub"), "an id table with no names");
        let b = tmp.join("b/System");
        write(&b.join("accessoryid.lub"), "ACCESSORY_IDs = { ACCESSORY_B = 2002 }");
        write(&b.join("accname.lub"), "AccNameTable = { [ACCESSORY_IDs.ACCESSORY_B] = \"_b_hat\" }");

        let first = copy_system_layer(&a, &merged, "a").unwrap();
        assert!(first.list(&ITEMS).is_empty() && first.list(&QUESTS).is_empty());
        let second = copy_system_layer(&b, &merged, "b").unwrap();
        assert_eq!(first.views.monster, vec![("npcidentity-a.lub".to_string(), "jobname-a.lub".to_string())]);
        // A name table keyed by plain numbers gets an empty id table to load.
        assert_eq!(first.views.accessory, vec![("ids-none-accessory-a.lua".to_string(), "accname-a.lua".to_string())]);
        assert!(merged.join("ids-none-accessory-a.lua").is_file());
        assert_eq!(first.views.weapon, vec!["weapontable-a.lub".to_string()]);
        // An id table with nothing to name is dropped, not half-loaded.
        assert!(first.views.robe.is_empty());
        assert_eq!(fs::read_to_string(merged.join("accname.lub")).unwrap(), "BASE");

        let mut all = ModTables::default();
        all.extend(first);
        all.extend(second);
        assert_eq!(
            all.config_entries(&tmp),
            vec!["\tcustomLuaTables: { accessory: [['System/ids-none-accessory-a.lua', 'System/accname-a.lua'], \
                  ['System/accessoryid-b.lub', 'System/accname-b.lub']], \
                  monster: [['System/npcidentity-a.lub', 'System/jobname-a.lub']], \
                  weapon: ['System/weapontable-a.lub'] },\n"
                .to_string()]
        );
        assert!(ViewTables::default().is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod name that is not a safe filename must not become one.
    #[test]
    fn the_item_table_filename_is_sanitised() {
        let tmp = tmp("sanitise");
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        write(&src.join("itemInfo.lub"), "x");
        assert_eq!(copy_system_layer(&src, &merged, "../evil name").unwrap().list(&ITEMS), ["itemInfo----evil-name.lua"]);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Two item tables in one mod used to land on the same name, and the one
    /// sorted second silently replaced the first.
    #[test]
    fn every_item_table_in_a_mod_is_kept() {
        let tmp = tmp("every");
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        write(&src.join("itemInfo.lua"), "FIRST");
        write(&src.join("itemInfo_C.lua"), "SECOND");
        write(&src.join("LuaFiles514/itemInfo.lua"), "NESTED");
        let tables = copy_system_layer(&src, &merged, "m").unwrap();
        let added = tables.list(&ITEMS);
        assert_eq!(added, ["itemInfo-m.lua", "itemInfo-m.2.lua"]);
        assert_eq!(fs::read_to_string(merged.join("itemInfo-m.lua")).unwrap(), "FIRST");
        assert_eq!(fs::read_to_string(merged.join("itemInfo-m.2.lua")).unwrap(), "SECOND");
        // A nested one is still copied, as before, but it is not added -- and
        // it is what the warning names.
        assert!(!added.iter().any(|n| n.contains("LuaFiles514")));
        assert!(merged.join("LuaFiles514/itemInfo.lua").is_file());
        assert_eq!(
            item_tables_under(&src.join("LuaFiles514"), "System/LuaFiles514"),
            vec!["System/LuaFiles514/itemInfo.lua".to_string()]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    /// The client keeps the first definition of an item it reads, so the list
    /// runs last mod first and base last -- and names only base tables that are
    /// there, in the client's own order. Quests load after the base and the
    /// last definition wins: mod order.
    #[test]
    fn item_tables_are_listed_later_mod_first_and_base_last() {
        let tmp = tmp("order");
        let web = tmp.join("web");
        write(&web.join("System/itemInfo_true.lub"), "base");
        write(&web.join("System/itemInfo.lua"), "base");
        let mut all = ModTables::default();
        for m in ["a", "b"] {
            let src = tmp.join(m).join("System");
            write(&src.join("itemInfo.lua"), m);
            write(&src.join("OngoingQuestInfoList.lub"), m);
            all.extend(copy_system_layer(&src, &tmp.join("merged"), m).unwrap());
        }
        assert_eq!(
            all.config_entries(&web),
            vec![
                "\tcustomItemInfo: ['System/itemInfo-b.lua', 'System/itemInfo-a.lua', 'System/itemInfo.lua', 'System/itemInfo_true.lub'],\n"
                    .to_string(),
                "\tcustomQuestInfo: ['System/OngoingQuestInfoList-a.lub', 'System/OngoingQuestInfoList-b.lub'],\n".to_string(),
            ]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn a_signboard_table_is_recognised_in_any_case_and_only_where_the_client_reads_it() {
        assert!(data_table("luafiles514/lua files/SignBoardList.lub").is_some());
        assert!(data_table("LuaFiles514/Lua Files/signboardlist.lua").is_some());
        assert!(data_table("luafiles514/lua files/signboardlist_f.lub").is_none());
        assert!(data_table("lua files/SignBoardList.lub").is_none());
        // A data/ table is not one when it sits in System/.
        let tmp = tmp("sign-in-system");
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        write(&src.join("SignBoardList.lub"), "x");
        assert!(copy_system_layer(&src, &merged, "m").unwrap().list(&SIGNBOARDS).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod's signboard table is kept aside under its own name rather than
    /// laid over the stock one, which it would replace whole -- and everything
    /// else in data/ still lands, aliases and all.
    #[test]
    fn a_signboard_table_is_kept_aside_rather_than_replacing_the_stock_one() {
        let tmp = tmp("data-layer");
        let (src, web) = (tmp.join("mod/data"), tmp.join("web"));
        write(&web.join("data/luafiles514/lua files/SignBoardList.lub"), "STOCK");
        write(&src.join("luafiles514/lua files/SignBoardList.lub"), "MOD SIGNS");
        write(&src.join("luafiles514/lua files/signboardlist_f.lub"), "NOT A TABLE OF SIGNS");
        write(&src.join("texture/ui/x.bmp"), "art");
        let tables = copy_data_layer(&src, &web, "my mod").unwrap();
        assert_eq!(tables.list(&SIGNBOARDS), ["SignBoardList-my-mod.lub"]);
        let signs = web.join("data/luafiles514/lua files");
        assert_eq!(fs::read_to_string(signs.join("SignBoardList-my-mod.lub")).unwrap(), "MOD SIGNS");
        assert_eq!(fs::read_to_string(signs.join("SignBoardList.lub")).unwrap(), "STOCK");
        assert!(signs.join("signboardlist_f.lub").is_file());
        assert!(web.join("data").join(super::super::client_path("texture/ui/x.bmp")).is_file());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Signboards load after the stock table, in mod order, under their path
    /// from the served root.
    #[test]
    fn signboard_tables_are_listed_in_mod_order() {
        let tmp = tmp("signs");
        let dir = tmp.join("web/data/luafiles514/lua files");
        let mut all = ModTables::default();
        for m in ["a", "b"] {
            write(&tmp.join(m).join("SignBoardList.lub"), m);
            let mut one = ModTables::default();
            one.keep_aside(&SIGNBOARDS, &tmp.join(m).join("SignBoardList.lub"), &dir, m).unwrap();
            all.extend(one);
        }
        assert_eq!(fs::read_to_string(dir.join("SignBoardList-b.lub")).unwrap(), "b");
        assert_eq!(
            all.config_entries(&tmp.join("web")),
            vec!["\tcustomSignBoardList: ['data/luafiles514/lua files/SignBoardList-a.lub', \
                  'data/luafiles514/lua files/SignBoardList-b.lub'],\n"
                .to_string()]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod's selection package table is kept aside rather than replacing
    /// the client's own, and is listed by the caller, last mod first.
    #[test]
    fn package_tables_are_kept_aside_and_listed_last_mod_first() {
        assert!(data_table("LuaFiles514/Lua Files/SelectPackage/selectpackageitem.lub").is_some());
        assert!(data_table("luafiles514/lua files/selectpackage/selectpackageitem_cln.lub").is_none());
        let tmp = tmp("packages");
        let web = tmp.join("web");
        let mut all = ModTables::default();
        for m in ["a", "b"] {
            let src = tmp.join(m).join("data");
            write(&src.join("luafiles514/lua files/selectpackage/selectpackageitem.lua"), m);
            all.extend(copy_data_layer(&src, &web, m).unwrap());
        }
        let dir = web.join("data/luafiles514/lua files/selectpackage");
        assert!(!dir.join("selectpackageitem.lua").exists());
        assert_eq!(fs::read_to_string(dir.join("selectpackageitem-b.lua")).unwrap(), "b");
        assert_eq!(
            all.package_supplements(),
            [
                "data/luafiles514/lua files/selectpackage/selectpackageitem-b.lua",
                "data/luafiles514/lua files/selectpackage/selectpackageitem-a.lua",
            ]
        );
        assert!(all.config_entries(&web).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// An item table in a folder under System/, or under data/, is never
    /// read, and the warning says so -- in the words it has always used.
    #[test]
    fn an_item_table_under_data_is_reported() {
        let tmp = tmp("misplaced");
        write(&tmp.join("data/luafiles514/lua files/itemInfo.lua"), "x");
        write(&tmp.join("System/itemInfo.lua"), "x");
        write(&tmp.join("System/LuaFiles514/itemInfo.lua"), "x");
        assert_eq!(
            misplaced(&tmp, "m"),
            [
                "mods: m has System/LuaFiles514/itemInfo.lua, but the client only adds item tables that sit \
                 directly in System/ -- move it there",
                "mods: m has data/luafiles514/lua files/itemInfo.lua, but the client reads item tables only \
                 from System/ -- move it to System/",
            ]
        );
        assert!(misplaced(&tmp.join("absent"), "m").is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A signboard table the client never reads -- in System/, or in the wrong
    /// folder under data/ -- is reported; the one in the right place is not.
    #[test]
    fn a_misplaced_signboard_table_is_reported() {
        let tmp = tmp("misplaced-signs");
        write(&tmp.join("System/SignBoardList.lub"), "x");
        write(&tmp.join("data/lua files/signboardlist.lua"), "x");
        write(&tmp.join("data/LuaFiles514/Lua Files/SignBoardList.lub"), "x");
        write(&tmp.join("data/luafiles514/lua files/signboardlist_f.lub"), "x");
        assert_eq!(
            misplaced(&tmp, "m"),
            [
                "mods: m has System/SignBoardList.lub, but the client reads signboard tables only from \
                 data/luafiles514/lua files/ -- move it there",
                "mods: m has data/lua files/signboardlist.lua, but the client reads signboard tables only from \
                 data/luafiles514/lua files/ -- move it there",
            ]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod that ships no tables writes nothing into the config, so an install
    /// with no table mods keeps the client's untouched defaults.
    #[test]
    fn no_tables_means_no_config_entries() {
        assert!(ModTables::default().config_entries(Path::new("/nonexistent")).is_empty());
    }

    /// Each of the four skill tables is recognised by its own name, in any
    /// case, and only in skillinfoz/, where the client reads it.
    #[test]
    fn a_skill_table_is_recognised_only_where_the_client_reads_it() {
        let key = |rel: &str| data_table(rel).map(|t| t.config_key);
        assert_eq!(key("luafiles514/lua files/skillinfoz/skillid.lub"), Some("customSkillId"));
        assert_eq!(key("LuaFiles514/Lua Files/SkillInfoz/SkillInfoList.lua"), Some("customSkillInfoList"));
        assert_eq!(key("luafiles514/lua files/skillinfoz/skilldescript.lub"), Some("customSkillDescript"));
        assert_eq!(key("luafiles514/lua files/skillinfoz/skilltreeview.lub"), Some("customSkillTreeView"));
        assert_eq!(key("luafiles514/lua files/skillinfoz/skillid_f.lub"), None);
        assert_eq!(key("luafiles514/lua files/skillinfoz/jobinheritlist.lub"), None);
        assert_eq!(key("luafiles514/lua files/skillid.lub"), None);
    }

    /// A mod's skill tables are kept aside rather than laid over the client's,
    /// which they would replace whole, and are listed per table in mod order.
    #[test]
    fn skill_tables_are_kept_aside_and_listed_in_mod_order() {
        let tmp = tmp("skills");
        let web = tmp.join("web");
        let skills = web.join("data/luafiles514/lua files/skillinfoz");
        write(&skills.join("skillid.lub"), "STOCK");
        let mut all = ModTables::default();
        for m in ["a", "b"] {
            let src = tmp.join(m).join("data/luafiles514/lua files/skillinfoz");
            for stem in SKILL_STEMS {
                write(&src.join(format!("{stem}.lub")), &format!("{m} {stem}"));
            }
            all.extend(copy_data_layer(&tmp.join(m).join("data"), &web, m).unwrap());
        }
        assert_eq!(fs::read_to_string(skills.join("skillid.lub")).unwrap(), "STOCK");
        assert_eq!(fs::read_to_string(skills.join("skilltreeview-b.lub")).unwrap(), "b skilltreeview");
        assert!(!skills.join("skillinfolist.lub").exists());
        let entry = |key: &str, stem: &str| {
            format!(
                "\t{key}: ['data/luafiles514/lua files/skillinfoz/{stem}-a.lub', \
                 'data/luafiles514/lua files/skillinfoz/{stem}-b.lub'],\n"
            )
        };
        assert_eq!(
            all.config_entries(&web),
            vec![
                entry("customSkillId", "skillid"),
                entry("customSkillInfoList", "skillinfolist"),
                entry("customSkillDescript", "skilldescript"),
                entry("customSkillTreeView", "skilltreeview"),
            ]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod's era folder replaces the table its own folder has: the client
    /// reads the era's copy, once.
    #[test]
    fn an_era_folder_table_replaces_the_mod_s_own_and_is_listed_once() {
        let tmp = tmp("skills-era");
        let web = tmp.join("web");
        let mut all = ModTables::default();
        for root in ["mod", "mod/renewal"] {
            write(&tmp.join(root).join("data/luafiles514/lua files/skillinfoz/skillid.lub"), root);
            all.extend(copy_data_layer(&tmp.join(root).join("data"), &web, "m").unwrap());
        }
        let skills = web.join("data/luafiles514/lua files/skillinfoz");
        assert_eq!(fs::read_to_string(skills.join("skillid-m.lub")).unwrap(), "mod/renewal");
        assert_eq!(all.list(&SKILL_IDS), ["skillid-m.lub"]);
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A skill table the client never reads -- in System/, or anywhere under
    /// data/ but skillinfoz/ -- is reported; the ones in the right place are not.
    #[test]
    fn a_misplaced_skill_table_is_reported() {
        let tmp = tmp("misplaced-skills");
        write(&tmp.join("System/skillinfolist.lub"), "x");
        write(&tmp.join("data/luafiles514/lua files/SkillId.lub"), "x");
        write(&tmp.join("data/luafiles514/lua files/skillinfoz/skillid.lub"), "x");
        write(&tmp.join("data/luafiles514/lua files/skillinfoz/skilltreeview.lua"), "x");
        assert_eq!(
            misplaced(&tmp, "m"),
            [
                "mods: m has System/skillinfolist.lub, but the client reads skill tables only from \
                 data/luafiles514/lua files/skillinfoz/ -- move it there",
                "mods: m has data/luafiles514/lua files/SkillId.lub, but the client reads skill tables only from \
                 data/luafiles514/lua files/skillinfoz/ -- move it there",
            ]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Each of the three status icon tables is recognised by its own name, in
    /// any case, and only in stateicon/, where the client reads it.
    #[test]
    fn a_status_icon_table_is_recognised_only_where_the_client_reads_it() {
        let key = |rel: &str| data_table(rel).map(|t| t.config_key);
        assert_eq!(key("luafiles514/lua files/stateicon/efstids.lub"), Some("customEfstIds"));
        assert_eq!(key("LuaFiles514/Lua Files/StateIcon/StateIconImgInfo.lua"), Some("customStateIconImgInfo"));
        assert_eq!(key("luafiles514/lua files/stateicon/stateiconinfo.lub"), Some("customStateIconInfo"));
        assert_eq!(key("luafiles514/lua files/stateicon/stateiconinfo_f.lub"), None);
        assert_eq!(key("luafiles514/lua files/efstids.lub"), None);
    }

    /// A mod's status icon tables are kept aside rather than laid over the
    /// client's, and are listed per table in mod order.
    #[test]
    fn status_icon_tables_are_kept_aside_and_listed_in_mod_order() {
        let tmp = tmp("state-icons");
        let web = tmp.join("web");
        let icons = web.join("data/luafiles514/lua files/stateicon");
        write(&icons.join("stateiconinfo.lub"), "STOCK");
        let mut all = ModTables::default();
        for m in ["a", "b"] {
            let src = tmp.join(m).join("data/luafiles514/lua files/stateicon");
            for stem in STATE_ICON_STEMS {
                write(&src.join(format!("{stem}.lub")), &format!("{m} {stem}"));
            }
            all.extend(copy_data_layer(&tmp.join(m).join("data"), &web, m).unwrap());
        }
        assert_eq!(fs::read_to_string(icons.join("stateiconinfo.lub")).unwrap(), "STOCK");
        assert_eq!(fs::read_to_string(icons.join("efstids-b.lub")).unwrap(), "b efstids");
        assert!(!icons.join("stateiconimginfo.lub").exists());
        let entry = |key: &str, stem: &str| {
            format!(
                "\t{key}: ['data/luafiles514/lua files/stateicon/{stem}-a.lub', \
                 'data/luafiles514/lua files/stateicon/{stem}-b.lub'],\n"
            )
        };
        assert_eq!(
            all.config_entries(&web),
            vec![
                entry("customEfstIds", "efstids"),
                entry("customStateIconImgInfo", "stateiconimginfo"),
                entry("customStateIconInfo", "stateiconinfo"),
            ]
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A status icon table the client never reads is reported.
    #[test]
    fn a_misplaced_status_icon_table_is_reported() {
        let tmp = tmp("misplaced-icons");
        write(&tmp.join("System/efstids.lub"), "x");
        write(&tmp.join("data/luafiles514/lua files/stateicon/stateiconinfo.lub"), "x");
        assert_eq!(
            misplaced(&tmp, "m"),
            ["mods: m has System/efstids.lub, but the client reads status icon tables only from \
              data/luafiles514/lua files/stateicon/ -- move it there"]
        );
        let _ = fs::remove_dir_all(&tmp);
    }
}
