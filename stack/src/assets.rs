//! Wire a user-supplied Ragnarok client into the asset server.
//!
//! Small overlays are owned copies. GRFs and music remain on the selected
//! drives and are opened read-only using configuration outside the served root.
//! Rebuilds stage a complete generation and recover an interrupted commit.

use crate::config::Config;
use std::fs;
use std::path::{Path, PathBuf};

/// Where the client's text comes from.
///
/// Off is not simply "skip the overlay". roBrowser decodes every table a
/// client ships using one codepage, chosen by `servers[].langtype`, and the
/// English overlay is ASCII -- so Korean (windows-949) is the right reading
/// while that overlay is in front of everything. Take it away and a Latin
/// American client's own Spanish and Portuguese tables are windows-1252,
/// where every accented byte is a valid CP949 lead byte: `Configuração`
/// pairs its bytes up with their neighbours and arrives as Hangul. So the
/// choice of text and the choice of codepage are one choice, and this is it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GameText {
    /// ROenglishRE over the client's own files.
    English,
    /// The client's own files, read as windows-1252: Latin American,
    /// international, Brazilian and European clients.
    ClientWestern,
    /// The client's own files, read as windows-949: kRO.
    ClientKorean,
}

impl GameText {
    fn translated(self) -> bool {
        self == GameText::English
    }

    /// roBrowser's `servers[].langtype`. 12 is SERVICETYPE_BRAZIL, which is
    /// one of the eight the client maps to windows-1252; 0 is Korea.
    fn langtype(self) -> u32 {
        match self {
            GameText::ClientWestern => 12,
            _ => 0,
        }
    }

    /// Part of the overlay fingerprint, so switching clears the client's own
    /// file cache. Without that the browser keeps serving the tables it
    /// already has and the setting appears to do nothing.
    fn as_str(self) -> &'static str {
        match self {
            GameText::English => "english",
            GameText::ClientWestern => "client_western",
            GameText::ClientKorean => "client_korean",
        }
    }
}

/// Read the setting, defaulting to the English translation.
///
/// A value nobody wrote is refused rather than read as the default: the only
/// way to get one is a hand-edited settings.json, and quietly rebuilding the
/// assets in English would look exactly like the setting being ignored.
pub fn game_text(cfg: &Config) -> Result<GameText, String> {
    const ERROR: &str = "Cannot read the game text setting. Repair settings.json before starting the server; no assets were rebuilt.";
    let settings = crate::registration::settings(&cfg.state).map_err(|_| ERROR)?;
    match settings.get("game_text") {
        None | Some(crate::json::Value::Null) => Ok(GameText::English),
        Some(crate::json::Value::String(value)) => match value.as_str() {
            "english" => Ok(GameText::English),
            "client_western" => Ok(GameText::ClientWestern),
            "client_korean" => Ok(GameText::ClientKorean),
            other => Err(format!(
                "Unknown game text setting {other:?}. Choose one in Settings; no assets were rebuilt."
            )),
        },
        Some(_) => Err(ERROR.into()),
    }
}

/// Small overlays are owned copies. Multi-gigabyte archives and music are
/// read in place through private configuration; no filesystem links are needed.
fn readable_path(path: &Path, directory: bool) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|e| {
        format!(
            "cannot access {}: {e}; reconnect the drive or reselect the client folder",
            path.display()
        )
    })?;
    if directory {
        fs::read_dir(&canonical)
            .map_err(|e| format!("cannot read directory {}: {e}", path.display()))?;
    } else {
        if !canonical.is_file() {
            return Err(format!("not a file: {}", path.display()));
        }
        fs::File::open(&canonical).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    }
    let text = canonical
        .to_str()
        .ok_or_else(|| format!("path is not Unicode: {}", path.display()))?;
    if text.contains(['\r', '\n']) {
        return Err("asset paths cannot contain line breaks".into());
    }
    Ok(canonical)
}

fn entries(src: &Path) -> Result<Vec<fs::DirEntry>, String> {
    let mut found = fs::read_dir(src)
        .map_err(|e| format!("reading {}: {e}", src.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("reading {}: {e}", src.display()))?;
    found.sort_by_key(|e| e.file_name());
    Ok(found)
}

fn copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Only bytes are copied: source read-only permissions must not prevent a
    // later mod layer from replacing this app-owned destination on Windows.
    let mut input = fs::File::open(src).map_err(|e| format!("reading {}: {e}", src.display()))?;
    if fs::symlink_metadata(dst).is_ok() {
        fs::remove_file(dst).map_err(|e| format!("replacing {}: {e}", dst.display()))?;
    }
    let mut output =
        fs::File::create(dst).map_err(|e| format!("creating {}: {e}", dst.display()))?;
    std::io::copy(&mut input, &mut output)
        .map(|_| ())
        .map_err(|e| format!("copying {} to {}: {e}", src.display(), dst.display()))
}

/// The first of `cands` that is a directory.
fn first_dir(cands: &[PathBuf]) -> Option<PathBuf> {
    cands.iter().find(|p| p.is_dir()).cloned()
}

pub fn link(cfg: &Config, args: &[String]) -> Result<(), String> {
    let data = readable_path(
        Path::new(args.first().ok_or("data.grf path required")?),
        false,
    )?;
    let optional = |index: usize| -> Result<Option<PathBuf>, String> {
        args.get(index)
            .filter(|s| !s.is_empty())
            .map(|s| readable_path(Path::new(s), index == 3))
            .transpose()
    };
    let rdata = optional(1)?;
    let official = optional(2)?;
    let client_dir = data.parent().ok_or("client path has no parent")?;
    let bgm = optional(3)?
        .or_else(|| first_dir(&[client_dir.join("BGM"), client_dir.join("dll_exe/BGM")]));
    let bgm = bgm.map(|p| readable_path(&p, true)).transpose()?;
    let ai = first_dir(&[client_dir.join("AI"), client_dir.join("dll_exe/AI")])
        .map(|p| readable_path(&p, true))
        .transpose()?;
    let text = game_text(cfg)?;
    let translation = cfg.root.join("vendor/ROenglishRE/Translation");
    if text.translated() {
        for sub in ["data", "SystemEN"] {
            readable_path(&translation.join("Renewal").join(sub), true)?;
        }
    }

    let tx = crate::asset_transaction::Transaction::begin(cfg)?;
    let server_root = tx.path(0);
    let private = tx.path(1);
    for dir in [
        server_root.join("resources"),
        server_root.join("data"),
        private.clone(),
    ] {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Private absolute entries work across volumes without copying or linking
    // the GRFs. Lower indices preserve official -> rdata -> data precedence.
    let archives: Vec<_> = official
        .iter()
        .chain(rdata.iter())
        .chain(std::iter::once(&data))
        .collect();
    let mut ini = String::from("[Data]\n");
    for (i, path) in archives.iter().enumerate() {
        ini.push_str(&format!("{i}={}\n", path.display()));
    }
    fs::write(private.join("DATA.INI"), ini).map_err(|e| e.to_string())?;
    for (name, path) in [("bgm.path", &bgm), ("ai.path", &ai)] {
        fs::write(
            private.join(name),
            path.as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?;
    }

    // An owned translation snapshot makes both era selection and rollback
    // independent of old symlinks or mutable directories outside this stage.
    //
    // `data/` is staged even when there is nothing to put in it: the asset
    // server names DATA_OVERRIDE_PATH in its startup report, and a directory
    // that is not there reads as a fault rather than as a choice.
    let en = server_root.join(".translation");
    fs::create_dir_all(en.join("data")).map_err(|e| e.to_string())?;
    if text.translated() {
        for sub in ["data", "SystemEN"] {
            copy_over(&translation.join("Renewal").join(sub), &en.join(sub))?;
            if crate::cmds::is_prerenewal(cfg) {
                copy_over(&translation.join("Pre-Renewal").join(sub), &en.join(sub))?;
            }
        }
    }
    let merged = server_root.join("System");
    if text.translated() {
        copy_over(&en.join("SystemEN"), &merged)?;
    }
    if let Some(sys) = first_dir(&[client_dir.join("System"), client_dir.join("dll_exe/System")]) {
        for e in entries(&sys)? {
            let name = e.file_name();
            let n = name.to_string_lossy();
            // The English item and quest tables win while they are in
            // front; without them the client's own are the only copies there
            // are, and skipping them leaves the game with no item names.
            if text.translated()
                && (n.starts_with("itemInfo") || n.starts_with("OngoingQuestInfoList"))
            {
                continue;
            }
            let dst = merged.join(&name);
            if dst.exists() {
                continue;
            }
            if e.path().is_dir() {
                copy_over(&e.path(), &dst)?;
            } else {
                copy_file(&e.path(), &dst)?;
            }
        }
    }
    if text.translated() {
        copy_file(
            &en.join("SystemEN/LuaFiles514/itemInfo.lua"),
            &merged.join("itemInfo.lua"),
        )?;
        copy_file(
            &en.join("SystemEN/OngoingQuests.lub"),
            &merged.join("OngoingQuestInfoList.lub"),
        )?;
        copy_over(&en.join("SystemEN"), &server_root.join("SystemEN"))?;
    }
    copy_data_aliased(
        &cfg.root.join("client-assets/data"),
        &server_root.join("data"),
    )?;
    let (plugins, item_tables) = overlay_mods(cfg, &server_root, &merged)?;
    let mut fingerprint = 0xcbf2_9ce4_8422_2325;
    fnv(&mut fingerprint, b"owned-assets-v2");
    fnv(&mut fingerprint, text.as_str().as_bytes());
    fnv(&mut fingerprint, overlay_fingerprint(cfg).as_bytes());
    hash_tree(&mut fingerprint, &translation, Path::new("translation"));
    hash_tree(
        &mut fingerprint,
        &cfg.root.join("client-assets/data"),
        Path::new("client-data"),
    );
    for source in archives.iter().copied().chain(bgm.iter()).chain(ai.iter()) {
        fnv(&mut fingerprint, source.to_string_lossy().as_bytes());
        let meta = fs::metadata(source).map_err(|e| e.to_string())?;
        fnv(&mut fingerprint, &meta.len().to_le_bytes());
        if let Ok(time) = meta.modified().and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map_err(std::io::Error::other)
        }) {
            fnv(&mut fingerprint, &time.as_nanos().to_le_bytes());
        }
        if source.is_dir() {
            hash_tree(&mut fingerprint, source, Path::new("client-source"));
        }
    }
    for sys in [client_dir.join("System"), client_dir.join("dll_exe/System")] {
        hash_tree(&mut fingerprint, &sys, Path::new("client-system"));
    }
    fs::write(
        server_root.join("overlay.id"),
        format!("{fingerprint:016x}"),
    )
    .map_err(|e| e.to_string())?;
    write_client_config(cfg, &server_root, &plugins, &item_tables, text)?;
    copy_file(
        &cfg.root.join("config/index.html"),
        &server_root.join("index.html"),
    )?;
    tx.commit()?;
    println!(
        "linked: {} GRFs read in place, BGM {}",
        archives.len(),
        if bgm.is_some() { "yes" } else { "missing" }
    );
    Ok(())
}

/// Copy a mod's client files over the assembled asset root.
///
/// Returns the mods that ship a roBrowser plugin, in the order they are loaded.
/// The list comes from `mods::enabled`, in merge order, rather than from a
/// second pass over the folder. It used to be the latter, and the two
/// disagreed: a mod switched off in Settings stopped reaching the server and
/// went on overlaying its sprites and loading its plugin, so half of it stayed
/// on with nothing in the interface to say so.
fn overlay_mods(
    cfg: &Config,
    server_root: &Path,
    merged: &Path,
) -> Result<(Vec<(String, String)>, Vec<String>), String> {
    let mut plugins = Vec::new();
    let mut item_tables = Vec::new();
    // The player's answers to whatever each mod declared in its mod.json.
    let saved = crate::mods::read_settings(&cfg.state)?;
    for m in crate::mods::enabled(cfg) {
        // Served ahead of the GRFs: sprites, .act/.spr, map geometry, Lua.
        // Aliased, so a mod can be written in ASCII rather than in CP949 bytes.
        copy_data_aliased(&m.dir.join("data"), &server_root.join("data"))?;
        // Music. The client asks for `BGM/<file>`, a root outside data/, so
        // this is its own layer rather than part of the one above.
        copy_over(&m.dir.join("BGM"), &server_root.join("BGM"))?;
        // Client tables. itemInfo is merged rather than replaced; see
        // copy_system_layer.
        if let Some(table) = copy_system_layer(&m.dir.join("System"), merged, &m.name)? {
            item_tables.push(table);
        }
        // A roBrowser plugin: styling, UI, anything the client can be told to
        // load. Served from the root, so the path in the config is
        // server-relative -- which is the one thing that will confuse people.
        let client = m.dir.join("client");
        if client.join("index.js").is_file() {
            copy_over(&client, &server_root.join("plugins").join(&m.name))?;
            // Declared defaults with the player's answers over them. The loader
            // hands this to the mod's init(parameters, api), so a mod can stay
            // enabled and still be told to hide part of itself.
            let entries = crate::mods::effective(&m.manifest, saved.get(&m.name));
            let pars = entries
                .iter()
                .map(|(key, value)| format!("{}: {value}", crate::json::quote(key)))
                .collect::<Vec<_>>()
                .join(", ");
            plugins.push((m.name.clone(), pars));
        }
    }
    Ok((plugins, item_tables))
}

/// FNV-1a, the same one `guest_fingerprint` uses, fed a piece at a time.
fn fnv(hash: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *hash ^= *b as u64;
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

/// Hash a tree by name, size and mtime, in a fixed order.
///
/// `read_dir` order is whatever the filesystem hands back, so it is sorted
/// here: an unsorted walk gives a different answer for the same tree on
/// another machine, and the whole value of this number is that it only changes
/// when the tree does.
fn hash_tree(hash: &mut u64, dir: &Path, rel: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let rel = rel.join(e.file_name());
        // Selected music may contain directory links. Resolution confines
        // reads to its selected root; fingerprinting must not recurse cycles.
        if e.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
            continue;
        }
        if path.is_dir() {
            hash_tree(hash, &path, &rel);
            continue;
        }
        fnv(hash, rel.to_string_lossy().as_bytes());
        let Ok(meta) = e.metadata() else { continue };
        fnv(hash, &meta.len().to_le_bytes());
        if let Ok(t) = meta.modified() {
            if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                fnv(hash, &d.as_secs().to_le_bytes());
            }
        }
    }
}

/// A fingerprint of everything the enabled mods put in front of the client.
///
/// The client keeps its own cache of every file it downloads, in the browser's
/// sandboxed filesystem, and looks there before asking the server again. The
/// cache is keyed by *filename*, which is what makes a mod that replaces a
/// stock file invisible: a login background, a loading screen or an itemInfo
/// table the client already has under that name is never re-fetched, so the
/// mod loads on the server, shows as `on` in Settings, and changes nothing on
/// screen. The app clears that cache when this value changes.
///
/// Size and mtime rather than contents. The tree is copied on every link
/// anyway, and hashing the bytes would mean reading a mod's artwork twice on
/// every launch to answer a question that a changed file already answers.
///
/// The era is in here because it is the same bug without any mod involved: the
/// two translation trees carry different text under identical filenames, so a
/// client that cached `itemInfo.lua` as pre-renewal keeps serving it after a
/// switch to renewal.
fn overlay_fingerprint(cfg: &Config) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    fnv(&mut hash, era_tag(cfg).as_bytes());
    for m in crate::mods::enabled(cfg) {
        let roots = client_roots(&m.dir);
        // A mod that reaches only the server has nothing the client could be
        // holding a stale copy of. Skipping its name as well as its files is
        // the difference between toggling a drop-rate mod and re-downloading
        // the client's whole working set to find nothing had changed.
        if roots.is_empty() {
            continue;
        }
        // The name, and in order: two mods overlaying the same path resolve by
        // load order, so the same set in a different order is a different tree.
        fnv(&mut hash, m.name.as_bytes());
        for sub in roots {
            hash_tree(&mut hash, &m.dir.join(sub), Path::new(sub));
        }
    }
    format!("{hash:016x}")
}

/// The roots a mod can reach the *client* through, of those it actually has.
///
/// `db/`, `npc/` and `conf/` are deliberately not here: they are the server's,
/// the client never sees them, and a mod built only from those must not cost
/// the player their cache.
fn client_roots(dir: &Path) -> Vec<&'static str> {
    ["data", "BGM", "System", "client"]
        .into_iter()
        .filter(|sub| dir.join(sub).is_dir())
        .collect()
}

fn era_tag(cfg: &Config) -> &'static str {
    if crate::cmds::is_prerenewal(cfg) {
        "pre-re"
    } else {
        "re"
    }
}

/// ASCII names a mod may use in place of the client's own directory names.
///
/// The client asks for its assets under Korean directory names encoded as
/// CP949 and read by every tool in the chain as Latin-1, so on disk they look
/// like `À¯ÀúÀÎÅÍÆäÀÌ½º`. Those names are hard-coded in the client, so they
/// cannot simply be renamed -- but nothing stops a mod from *writing* ASCII and
/// this translating on the way in.
///
/// It matters more than tidiness: a zip containing those bytes unpacks
/// differently depending on the machine, so a mod that ships them is a mod that
/// arrives corrupted for some people. A mod written entirely in ASCII travels.
///
/// Longest first, because `sprite/human/body` has to match before `sprite/human`.
/// Each right-hand side was taken from a real GRF, not typed.
const PATH_ALIASES: &[(&str, &str)] = &[
    // data/texture
    ("texture/ui",             "texture/\u{c0}\u{af}\u{c0}\u{fa}\u{c0}\u{ce}\u{c5}\u{cd}\u{c6}\u{e4}\u{c0}\u{cc}\u{bd}\u{ba}"), // 유저인터페이스
    ("texture/field-ground",   "texture/\u{c7}\u{ca}\u{b5}\u{e5}\u{b9}\u{d9}\u{b4}\u{da}"),                                     // 필드바닥
    ("texture/town",           "texture/\u{b1}\u{e2}\u{c5}\u{b8}\u{b8}\u{b6}\u{c0}\u{bb}"),                                     // 기타마을
    ("texture/indoor-props",   "texture/\u{b3}\u{bb}\u{ba}\u{ce}\u{bc}\u{d2}\u{c7}\u{b0}"),                                     // 내부소품
    ("texture/outdoor-props",  "texture/\u{bf}\u{dc}\u{ba}\u{ce}\u{bc}\u{d2}\u{c7}\u{b0}"),                                     // 외부소품
    // data/sprite
    ("sprite/human/body",      "sprite/\u{c0}\u{ce}\u{b0}\u{a3}\u{c1}\u{b7}/\u{b8}\u{f6}\u{c5}\u{eb}"),                         // 인간족/몸통
    ("sprite/human",           "sprite/\u{c0}\u{ce}\u{b0}\u{a3}\u{c1}\u{b7}"),                                                  // 인간족
    ("sprite/monster",         "sprite/\u{b8}\u{f3}\u{bd}\u{ba}\u{c5}\u{cd}"),                                                  // 몬스터
    ("sprite/item",            "sprite/\u{be}\u{c6}\u{c0}\u{cc}\u{c5}\u{db}"),                                                  // 아이템
    ("sprite/accessory",       "sprite/\u{be}\u{c7}\u{bc}\u{bc}\u{bb}\u{e7}\u{b8}\u{ae}"),                                      // 악세사리
    ("sprite/robe",            "sprite/\u{b7}\u{ce}\u{ba}\u{ea}"),                                                              // 로브
    ("sprite/shield",          "sprite/\u{b9}\u{e6}\u{c6}\u{d0}"),                                                              // 방패
    ("sprite/effect",          "sprite/\u{c0}\u{cc}\u{c6}\u{d1}\u{c6}\u{ae}"),                                                  // 이팩트
];

/// Rewrite a mod-relative asset path through `PATH_ALIASES`.
///
/// Only the leading segments are translated, and only on an exact segment
/// boundary, so a mod folder that happens to be called `sprite/monsters` is
/// left alone.
fn apply_aliases(rel: &str) -> String {
    for (ascii, native) in PATH_ALIASES {
        if let Some(rest) = rel.strip_prefix(ascii) {
            if rest.is_empty() || rest.starts_with('/') {
                return format!("{native}{rest}");
            }
        }
    }
    rel.to_string()
}

/// Copy a mod's `data/` tree, translating ASCII directory aliases as it goes.
fn copy_data_aliased(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    let mut stack = vec![(src.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        for e in entries(&dir)? {
            if e.file_type().map_err(|e| e.to_string())?.is_symlink() {
                return Err(format!(
                    "overlay source contains a link: {}",
                    e.path().display()
                ));
            }
            let from = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if from.is_dir() {
                stack.push((from, child));
            } else {
                let to = dst.join(apply_aliases(&child));
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                copy_file(&from, &to)?;
            }
        }
    }
    Ok(())
}

/// Copy a mod's `System/` layer, keeping item tables as *additions*.
///
/// Everything in `System/` replaces the client's copy, which is right for a
/// font or a quest table -- but wrong for `itemInfo`, the table that names every
/// item in the game. Replacing it to add one item means shipping the
/// translation's five-megabyte copy inside your mod, which nobody will do.
///
/// roBrowser has the way out: `customItemInfo` is a *list* of tables, loaded
/// with `loadAll`, and `loadItemInfo` assigns `ItemTable[ItemID]` per entry --
/// so several files merge by item id and the last one wins. This copies a mod's
/// item table aside under its own name and returns it, so the caller can name
/// it in that list after the base table.
///
/// Nothing is lost by making this additive: a mod that really wants to replace
/// the whole table can still ship a complete one, and defining every id is
/// indistinguishable from replacing.
fn copy_system_layer(src: &Path, merged: &Path, mod_name: &str) -> Result<Option<String>, String> {
    if !src.exists() {
        return Ok(None);
    }
    let mut added = None;
    for e in entries(src)? {
        if e.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err(format!(
                "overlay source contains a link: {}",
                e.path().display()
            ));
        }
        let from = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let is_item_table =
            lower.starts_with("iteminfo") && (lower.ends_with(".lua") || lower.ends_with(".lub"));
        if from.is_file() && is_item_table {
            // Named for the mod so two mods can each ship one, and so the file
            // cannot collide with the translation's own copy.
            let safe: String = mod_name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        c
                    } else {
                        '-'
                    }
                })
                .collect();
            let dst_name = format!("itemInfo-{safe}.lua");
            let to = merged.join(&dst_name);
            copy_file(&from, &to)?;
            added = Some(dst_name);
        } else if from.is_dir() {
            copy_over(&from, &merged.join(&name))?;
        } else {
            // This destination belongs to the staged generation.
            let to = merged.join(&name);
            copy_file(&from, &to)?;
        }
    }
    Ok(added)
}

/// Copy every file under `src` into `dst`, creating directories as needed.
/// Missing `src` is not an error: most mods use one or two of the layers.
fn copy_over(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in entries(src)? {
        if e.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err(format!(
                "overlay source contains a link: {}",
                e.path().display()
            ));
        }
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_over(&from, &to)?;
        } else {
            // This destination belongs to the staged generation.
            copy_file(&from, &to)?;
        }
    }
    Ok(())
}

/// An owned recursive overlay; a later layer replaces only files it carries.
#[cfg(test)]
fn overlay_tree(src: &Path, dst: &Path) -> Result<(), String> {
    copy_over(src, dst)
}

/// Write the client config, naming any plugins the mods provide.
///
/// Generated rather than copied so the plugin list can be part of it. roBrowser
/// resolves these from the server root, which is where overlay_mods puts them.
/// Insert a property block before the closing brace of Config.local.js.
///
/// The file ends `\n};`, and each block is added just before it. The comma is
/// the fiddly part: two blocks in a row used to produce `],,` -- the first
/// block ended with a comma and the second inserter added another -- which is a
/// syntax error, and a config that does not parse is a game that does not
/// start. So the separator is added only when what comes before needs one.
fn insert_before_close(body: String, block: &str) -> String {
    let Some(i) = body.rfind("\n};") else {
        return body;
    };
    let head = &body[..i];
    let sep = if head.trim_end().ends_with(',') || head.trim_end().ends_with('{') {
        ""
    } else {
        ","
    };
    format!("{head}{sep}\n{block}{}", &body[i + 1..])
}

fn write_client_config(
    cfg: &Config,
    web: &Path,
    plugins: &[(String, String)],
    item_tables: &[String],
    text: GameText,
) -> Result<(), String> {
    let src = cfg.root.join("config/Config.local.js");
    let body = fs::read_to_string(&src).map_err(|e| format!("reading {}: {e}", src.display()))?;
    // The client's own renewal flag has to follow the server's era: it selects
    // renewal formulas and UI on the browser side, and a renewal client against
    // a pre-renewal server disagrees about damage and stat display while both
    // believe they are right.
    let body = if crate::cmds::is_prerenewal(cfg) {
        body.replace("renewal: true,", "renewal: false,")
    } else {
        body
    };
    // The codepage every client table is read with. The template is Korean,
    // which is right whenever the English overlay is in front of it; see
    // GameText for why the two cannot be chosen separately.
    let body = if text.langtype() == 0 {
        body
    } else {
        body.replace("langtype: 0,", &format!("langtype: {},", text.langtype()))
    };
    // `customItemInfo` replaces the client's default list rather than adding to
    // it, so the base table has to be named first or every stock item loses its
    // name. Written only when a mod actually ships a table, so an install with
    // no item mods keeps the untouched default path.
    let body = if item_tables.is_empty() {
        body
    } else {
        let mut names = vec![
            "System/itemInfo.lub".to_string(),
            "System/itemInfo.lua".to_string(),
        ];
        names.extend(item_tables.iter().map(|n| format!("System/{n}")));
        let list = names
            .iter()
            .map(|n| format!("'{n}'"))
            .collect::<Vec<_>>()
            .join(", ");
        insert_before_close(body, &format!("\tcustomItemInfo: [{list}],\n"))
    };
    let out = if plugins.is_empty() {
        body
    } else {
        // The object form, always: the loader accepts a bare path string, but
        // then a mod can never be handed a setting. `pars` reaches the mod as
        // the first argument of its default export.
        let entries: Vec<String> = plugins
            .iter()
            .map(|(n, pars)| {
                format!("\t\t'{n}': {{ path: 'plugins/{n}/index', pars: {{ {pars} }} }}")
            })
            .collect();
        // Inserted before the closing brace of the config object rather than
        // appended: this is the last thing in the file and has to stay inside it.
        let plugin_map = format!("\tplugins: {{\n{}\n\t}},\n", entries.join(",\n"));
        insert_before_close(body, &plugin_map)
    };
    fs::write(web.join("Config.local.js"), out).map_err(|e| format!("writing Config.local.js: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_config(name: &str) -> Config {
        let root = std::env::temp_dir().join(format!("ro-link-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        Config {
            root: root.join("app"),
            state: root.join("state"),
            nebula_home: root.join("nebula"),
            nebula: root.join("unused"),
            docker: root.join("unused"),
            image: String::new(),
            db_image: String::new(),
            app_version: None,
        }
    }

    #[test]
    fn asset_generation_reads_archives_in_place_and_preserves_sources_through_mod_and_era_changes()
    {
        let cfg = fixture_config("generation");
        let client = cfg.state.parent().unwrap().join("client files 한글");
        for (path, text) in [
            ("data.grf", "archive"),
            ("rdata.grf", "renewal"),
            ("official.grf", "official"),
            ("BGM/theme.mp3", "music"),
            ("System/font.ttf", "font"),
            ("AI/AI.lua", "AI"),
        ] {
            write(&client.join(path), text);
        }
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(
            &en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"),
            "English items",
        );
        write(
            &en.join("Renewal/SystemEN/OngoingQuests.lub"),
            "English quests",
        );
        write(&en.join("Pre-Renewal/data/table.txt"), "classic table");
        write(
            &cfg.root.join("config/Config.local.js"),
            "window.ROConfigLocal = {\nrenewal: true,\n};\n",
        );
        write(&cfg.root.join("config/index.html"), "game entry");
        write(&cfg.state.join("mods/music/BGM/theme.mp3"), "mod music");
        write(
            &cfg.state.join("mods/music/System/LuaFiles514/itemInfo.lua"),
            "nested mod",
        );
        crate::mods::set_enabled(&cfg.state, "music", true).unwrap();
        let args: Vec<_> = ["data.grf", "rdata.grf", "official.grf", "BGM"]
            .iter()
            .map(|p| client.join(p).to_str().unwrap().to_string())
            .collect();
        link(&cfg, &args).unwrap();
        let manifest = fs::read_to_string(cfg.state.join("asset-config/DATA.INI")).unwrap();
        assert!(manifest.lines().nth(1).unwrap().ends_with("official.grf"));
        assert!(manifest.lines().nth(2).unwrap().ends_with("rdata.grf"));
        assert!(manifest.lines().nth(3).unwrap().ends_with("data.grf"));
        assert!(!cfg.state.join("assets/resources/data.grf").exists());
        assert!(!cfg.state.join("assets/resources/DATA.INI").exists());
        assert!(!cfg
            .root
            .join("vendor/roBrowserLegacy/dist/Web/Config.local.js")
            .exists());
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/BGM/theme.mp3")).unwrap(),
            "mod music"
        );
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/System/itemInfo.lua")).unwrap(),
            "English items"
        );
        assert_eq!(
            fs::read_to_string(en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua")).unwrap(),
            "English items"
        );
        assert_eq!(
            fs::read_to_string(client.join("BGM/theme.mp3")).unwrap(),
            "music"
        );
        let first_id = fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap();
        link(&cfg, &args).unwrap();
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap(),
            first_id
        );
        crate::mods::set_enabled(&cfg.state, "music", false).unwrap();
        write(&cfg.state.join("prerenewal"), "true");
        link(&cfg, &args).unwrap();
        assert!(!cfg.state.join("assets/BGM/theme.mp3").exists());
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/.translation/data/table.txt")).unwrap(),
            "classic table"
        );
        assert!(fs::read_to_string(cfg.state.join("assets/Config.local.js"))
            .unwrap()
            .contains("renewal: false"));
        assert_ne!(
            fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap(),
            first_id
        );
        let before = fs::read(cfg.state.join("assets/overlay.id")).unwrap();
        fs::remove_file(en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua")).unwrap();
        assert!(
            link(&cfg, &args).is_err(),
            "required copy failure must propagate"
        );
        assert_eq!(
            fs::read(cfg.state.join("assets/overlay.id")).unwrap(),
            before
        );
        let mut missing = args.clone();
        missing[2] = client.join("unplugged.grf").to_str().unwrap().to_string();
        assert!(link(&cfg, &missing).unwrap_err().contains("unplugged.grf"));
        assert_eq!(fs::read(client.join("data.grf")).unwrap(), b"archive");
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// Turning the translation off has to take the whole of it away, not just
    /// the `data/` overlay: with the English tables gone, the client's own
    /// item and quest tables are the only ones left and must stop being
    /// skipped. The codepage moves with them, because a Western client's own
    /// text is unreadable under the Korean one.
    #[test]
    fn the_clients_own_text_replaces_the_translation_and_its_codepage() {
        let cfg = fixture_config("gametext");
        let client = cfg.state.parent().unwrap().join("client");
        for (path, text) in [
            ("data.grf", "archive"),
            ("System/itemInfo.lub", "itens do cliente"),
            ("System/OngoingQuestInfoList_True.lub", "missões"),
            ("System/font.ttf", "font"),
        ] {
            write(&client.join(path), text);
        }
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(
            &en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"),
            "English items",
        );
        write(
            &en.join("Renewal/SystemEN/OngoingQuests.lub"),
            "English quests",
        );
        write(
            &cfg.root.join("config/Config.local.js"),
            "window.ROConfigLocal = {\nrenewal: true,\nlangtype: 0,\n};\n",
        );
        write(&cfg.root.join("config/index.html"), "game entry");
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];

        // Default: the translation is in front and the client's own tables are
        // skipped rather than allowed to overwrite it.
        link(&cfg, &args).unwrap();
        let english_id = fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap();
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/System/itemInfo.lua")).unwrap(),
            "English items"
        );
        assert!(cfg.state.join("assets/.translation/data/table.txt").exists());
        assert!(fs::read_to_string(cfg.state.join("assets/Config.local.js"))
            .unwrap()
            .contains("langtype: 0,"));

        write(&cfg.state.join("settings.json"), "{\"game_text\":\"client_western\"}");
        link(&cfg, &args).unwrap();
        // No English anywhere, and the override directory is still a directory
        // so the asset server does not report it as missing.
        assert!(!cfg.state.join("assets/System/itemInfo.lua").exists());
        assert!(!cfg.state.join("assets/SystemEN").exists());
        assert!(!cfg.state.join("assets/.translation/data/table.txt").exists());
        assert!(cfg.state.join("assets/.translation/data").is_dir());
        // The client's own tables, no longer skipped.
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/System/itemInfo.lub")).unwrap(),
            "itens do cliente"
        );
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/System/OngoingQuestInfoList_True.lub"))
                .unwrap(),
            "missões"
        );
        let config = fs::read_to_string(cfg.state.join("assets/Config.local.js")).unwrap();
        assert!(config.contains("langtype: 12,"), "{config}");
        // The client caches by filename, so the overlay fingerprint has to move
        // or the browser keeps serving the English tables it already has.
        assert_ne!(
            fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap(),
            english_id
        );

        // Same files, Korean reading: only the codepage differs.
        write(&cfg.state.join("settings.json"), "{\"game_text\":\"client_korean\"}");
        link(&cfg, &args).unwrap();
        assert!(fs::read_to_string(cfg.state.join("assets/Config.local.js"))
            .unwrap()
            .contains("langtype: 0,"));
        assert!(!cfg.state.join("assets/System/itemInfo.lua").exists());

        // A value nobody wrote is refused rather than read as the default.
        write(&cfg.state.join("settings.json"), "{\"game_text\":\"portuguese\"}");
        assert!(link(&cfg, &args).unwrap_err().contains("portuguese"));
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    #[test]
    fn owned_copies_of_read_only_sources_remain_replaceable() {
        let cfg = fixture_config("readonly");
        let source = cfg.root.join("table.lua");
        let dest = cfg.state.join("table.lua");
        write(&source, "original");
        let original = fs::metadata(&source).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&source, readonly).unwrap();
        copy_file(&source, &dest).unwrap();
        write(&cfg.root.join("mod.lua"), "override");
        copy_file(&cfg.root.join("mod.lua"), &dest).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert_eq!(fs::read(&dest).unwrap(), b"override");
        fs::set_permissions(&source, original).unwrap();
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// The names in PATH_ALIASES were copied out of a real GRF. If one of them
    /// is ever retyped by hand this catches it, because the bytes are the whole
    /// point -- a directory named in Korean is one the client never looks in.
    #[test]
    fn aliases_expand_to_the_client_s_own_names() {
        // 유저인터페이스, as CP949 read back as Latin-1.
        assert_eq!(
            apply_aliases("texture/ui/login/bg.bmp"),
            "texture/\u{c0}\u{af}\u{c0}\u{fa}\u{c0}\u{ce}\u{c5}\u{cd}\u{c6}\u{e4}\u{c0}\u{cc}\u{bd}\u{ba}/login/bg.bmp"
        );
        // 인간족/몸통 -- and the longer prefix has to win over `sprite/human`.
        assert!(
            apply_aliases("sprite/human/body/x.spr").ends_with("/\u{b8}\u{f6}\u{c5}\u{eb}/x.spr")
        );
    }

    /// The property the cache invalidation rests on: the same tree is the same
    /// number, and any change to it is a different one.
    ///
    /// This is what decides whether the client keeps a cache that may be
    /// serving a file the mod has replaced, so a false "unchanged" is the login
    /// screen that would not update.
    #[test]
    fn a_changed_mod_tree_is_a_changed_fingerprint() {
        let tmp = std::env::temp_dir().join(format!("ro-fp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let art = tmp.join("data/texture/ui/login/bg.bmp");
        write(&art, "first");

        let of = |dir: &Path| {
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            hash_tree(&mut h, &dir.join("data"), Path::new("data"));
            format!("{h:016x}")
        };

        let before = of(&tmp);
        assert_eq!(before, of(&tmp), "the same tree hashed twice must agree");

        // A different size is a different file.
        write(&art, "second, and longer");
        assert_ne!(before, of(&tmp), "an edited file went unnoticed");

        // And so is a new one, even at the same total size.
        let two = of(&tmp);
        write(&tmp.join("data/texture/ui/login/bg2.bmp"), "x");
        assert_ne!(two, of(&tmp), "an added file went unnoticed");

        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod the client never sees must not cost the player their cache.
    #[test]
    fn only_the_roots_the_client_reads_count() {
        let tmp = std::env::temp_dir().join(format!("ro-roots-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);

        // A drop-rate mod: server tables and a script, nothing else.
        write(&tmp.join("server-only/db/mob_db.yml"), "Body:");
        write(&tmp.join("server-only/npc/x.txt"), "");
        write(&tmp.join("server-only/conf/battle.conf"), "");
        assert!(client_roots(&tmp.join("server-only")).is_empty());

        // One that replaces artwork, and one that only ships a plugin.
        write(&tmp.join("art/data/texture/x.bmp"), "");
        assert_eq!(client_roots(&tmp.join("art")), vec!["data"]);
        write(&tmp.join("ui/client/index.js"), "");
        write(&tmp.join("ui/db/item_db.yml"), "Body:");
        assert_eq!(client_roots(&tmp.join("ui")), vec!["client"]);

        let _ = fs::remove_dir_all(&tmp);
    }

    /// An absent root is not an error: most mods ship one or two of the four.
    #[test]
    fn missing_roots_hash_to_nothing_rather_than_panicking() {
        let mut h: u64 = 7;
        hash_tree(&mut h, Path::new("/nonexistent/mod/BGM"), Path::new("BGM"));
        assert_eq!(h, 7);
    }

    /// Only whole segments are translated, so a mod with its own folder called
    /// `sprite/monsters` is left alone.
    #[test]
    fn aliases_match_on_segment_boundaries_only() {
        assert_eq!(
            apply_aliases("sprite/monsters/x.spr"),
            "sprite/monsters/x.spr"
        );
        assert_eq!(apply_aliases("texture/uix/y.bmp"), "texture/uix/y.bmp");
        // Anything unrecognised is passed through untouched, so a mod that
        // writes the real names still works.
        assert_eq!(
            apply_aliases("texture/effect/z.bmp"),
            "texture/effect/z.bmp"
        );
    }

    /// The whole point of the layer: a mod written in ASCII lands where the
    /// client looks.
    #[test]
    fn a_mod_written_in_ascii_lands_on_the_client_s_path() {
        let tmp = std::env::temp_dir().join(format!("ro-alias-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (src, dst) = (tmp.join("mod/data"), tmp.join("assets/data"));
        write(&src.join("texture/ui/login_interface/x.bmp"), "art");
        copy_data_aliased(&src, &dst).unwrap();
        let landed = dst
            .join("texture/\u{c0}\u{af}\u{c0}\u{fa}\u{c0}\u{ce}\u{c5}\u{cd}\u{c6}\u{e4}\u{c0}\u{cc}\u{bd}\u{ba}/login_interface/x.bmp");
        assert!(landed.is_file(), "not at {}", landed.display());
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod that adds one item must not have to ship the whole table.
    #[test]
    fn an_item_table_is_kept_aside_rather_than_replacing_the_base() {
        let tmp = std::env::temp_dir().join(format!("ro-sys-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        // The base table, as link() leaves it.
        write(&merged.join("itemInfo.lua"), "BASE");
        write(&src.join("itemInfo.lua"), "MOD ADDITIONS");
        write(&src.join("OngoingQuests.lub"), "other table");

        let added = copy_system_layer(&src, &merged, "my-mod").unwrap();

        assert_eq!(added.as_deref(), Some("itemInfo-my-mod.lua"));
        // The base is untouched...
        assert_eq!(
            fs::read_to_string(merged.join("itemInfo.lua")).unwrap(),
            "BASE"
        );
        // ...the mod's copy is beside it...
        assert_eq!(
            fs::read_to_string(merged.join("itemInfo-my-mod.lua")).unwrap(),
            "MOD ADDITIONS"
        );
        // ...and everything else in System/ still replaces as before.
        assert_eq!(
            fs::read_to_string(merged.join("OngoingQuests.lub")).unwrap(),
            "other table"
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod name that is not a safe filename must not become one.
    #[test]
    fn the_item_table_filename_is_sanitised() {
        let tmp = std::env::temp_dir().join(format!("ro-sys2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        write(&src.join("itemInfo.lub"), "x");
        assert_eq!(
            copy_system_layer(&src, &merged, "../evil name")
                .unwrap()
                .as_deref(),
            Some("itemInfo----evil-name.lua")
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_client_config_hands_each_plugin_its_own_settings() {
        let cfg = fixture_config("plugin-pars");
        fs::create_dir_all(cfg.root.join("config")).unwrap();
        let web = cfg.state.join("web");
        fs::create_dir_all(&web).unwrap();
        fs::write(
            cfg.root.join("config/Config.local.js"),
            "window.ROConfigLocal = {\n\tskipIntro: true\n};\n",
        )
        .unwrap();
        let plugins = vec![
            ("wasd-movement".to_string(), "\"show_controls_button\": false".to_string()),
            // A mod that declares nothing still gets the object form, so the
            // shape the loader sees never depends on whether options exist.
            ("plain".to_string(), String::new()),
        ];
        write_client_config(&cfg, &web, &plugins, &[], GameText::English).unwrap();
        let body = fs::read_to_string(web.join("Config.local.js")).unwrap();
        assert!(
            body.contains("'wasd-movement': { path: 'plugins/wasd-movement/index', pars: { \"show_controls_button\": false } }"),
            "{body}"
        );
        assert!(body.contains("'plain': { path: 'plugins/plain/index', pars: {  } }"), "{body}");
        assert!(body.trim_end().ends_with("};"), "{body}");
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// Two blocks in a row must not produce `],,` -- a syntax error, and a
    /// config that does not parse is a game that does not start.
    #[test]
    fn two_inserted_blocks_do_not_double_the_comma() {
        let base = "window.ROConfigLocal = {\n\tskipIntro: true\n};\n".to_string();
        let one = insert_before_close(base, "\tcustomItemInfo: ['a'],\n");
        let two = insert_before_close(one, "\tplugins: {\n\t\t'p': 'x'\n\t},\n");
        assert!(!two.contains(",,"), "{two}");
        assert!(two.contains("skipIntro: true,"), "{two}");
        assert!(two.contains("customItemInfo: ['a'],"), "{two}");
        assert!(two.contains("plugins: {"), "{two}");
        assert!(two.trim_end().ends_with("};"), "{two}");
    }

    /// The property the era merge depends on.

    ///
    /// Pre-Renewal is an overlay: it replaces the files it carries and leaves
    /// the rest of Renewal standing. Linking a directory whole would satisfy
    /// neither half -- the base would vanish under the overlay -- so this
    /// pins that a second layer overwrites into subdirectories rather than
    /// over them.
    #[test]
    fn a_later_layer_overwrites_and_leaves_the_rest() {
        let tmp = std::env::temp_dir().join(format!("ro-overlay-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (base, over, dst) = (tmp.join("base"), tmp.join("over"), tmp.join("dst"));

        write(&base.join("shared.txt"), "renewal");
        write(&base.join("only-base.txt"), "kept");
        write(&base.join("sub/deep.txt"), "renewal-deep");
        write(&base.join("sub/only-base-deep.txt"), "kept-deep");
        write(&over.join("shared.txt"), "prerenewal");
        write(&over.join("sub/deep.txt"), "prerenewal-deep");
        write(&over.join("only-over.txt"), "added");

        overlay_tree(&base, &dst).unwrap();
        overlay_tree(&over, &dst).unwrap();

        let read = |r: &str| fs::read_to_string(dst.join(r)).unwrap();
        // The overlay wins, at the top level and inside a subdirectory.
        assert_eq!(read("shared.txt"), "prerenewal");
        assert_eq!(read("sub/deep.txt"), "prerenewal-deep");
        // And everything it does not carry survives -- the 546 files of
        // translation that a straight swap would have dropped.
        assert_eq!(read("only-base.txt"), "kept");
        assert_eq!(read("sub/only-base-deep.txt"), "kept-deep");
        assert_eq!(read("only-over.txt"), "added");

        let _ = fs::remove_dir_all(&tmp);
    }
}
