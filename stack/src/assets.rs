//! Wire a user-supplied Ragnarok client into the asset server.
//!
//! Small overlays are owned copies. GRFs and music remain on the selected
//! drives and are opened read-only using configuration outside the served root.
//! Rebuilds stage a complete generation and recover an interrupted commit.

use crate::config::Config;
use std::fs;
use std::path::{Path, PathBuf};

mod client_tables;
use client_tables::{copy_data_layer, copy_system_layer, stage_client_item_table, warn_misplaced, ModTables};

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
    /// The client's own files, read as big5: the Taiwanese client, whose
    /// tables are Traditional Chinese.
    ClientTaiwan,
}

impl GameText {
    fn translated(self) -> bool {
        self == GameText::English
    }

    /// roBrowser's `servers[].langtype`. 12 is SERVICETYPE_BRAZIL, which is
    /// one of the eight the client maps to windows-1252; 4 is SERVICETYPE_TAIWAN,
    /// which the client reads as big5; 0 is Korea.
    fn langtype(self) -> u32 {
        match self {
            GameText::ClientWestern => 12,
            GameText::ClientTaiwan => 4,
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
            GameText::ClientTaiwan => "client_taiwan",
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
            "client_taiwan" => Ok(GameText::ClientTaiwan),
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

/// config/TRANSLATION_EXTRAS: single files from ROenglishRE's Compatibility
/// layers, as (source under Translation/, destination under the staged
/// translation). That file says why these and not the whole stack.
fn translation_extras(cfg: &Config) -> Vec<(PathBuf, PathBuf)> {
    let list = fs::read_to_string(cfg.root.join("config/TRANSLATION_EXTRAS")).unwrap_or_default();
    list.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut cols = l.split('\t').map(str::trim).filter(|c| !c.is_empty());
            Some((PathBuf::from(cols.next()?), PathBuf::from(cols.next()?)))
        })
        // Both sides stay inside their trees.
        .filter(|(a, b)| {
            [a, b].iter().all(|p| {
                p.components()
                    .all(|c| matches!(c, std::path::Component::Normal(_)))
            })
        })
        .collect()
}

/// config/TRANSLATION_LAYERS: the path prefixes taken from each Compatibility
/// layer, and the exceptions to them. That file says why these.
fn translation_layer_rules(cfg: &Config) -> (Vec<String>, Vec<String>) {
    let list = fs::read_to_string(cfg.root.join("config/TRANSLATION_LAYERS")).unwrap_or_default();
    let (mut take, mut skip) = (Vec::new(), Vec::new());
    for line in list.lines().map(str::trim) {
        let mut cols = line.split('\t').map(str::trim).filter(|c| !c.is_empty());
        match (cols.next(), cols.next()) {
            (Some("take"), Some(prefix)) => take.push(prefix.to_string()),
            (Some("skip"), Some(prefix)) => skip.push(prefix.to_string()),
            _ => {}
        }
    }
    (take, skip)
}

/// The Compatibility layers for this packet version, oldest first: every
/// `Compatibility/YYYY-MM-DD` dated on or before it, as ClientGenerator stacks
/// them up to a client's date. A layer split by era gives its era's folder.
fn translation_layers(translation: &Path, packetver: &str, era: &str) -> Result<Vec<PathBuf>, String> {
    let root = translation.join("Compatibility");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut layers = Vec::new();
    for e in entries(&root)? {
        let name = e.file_name().to_string_lossy().into_owned();
        let date: String = name.chars().filter(|c| *c != '-').collect();
        let dated = name.len() == 10 && date.len() == 8 && date.chars().all(|c| c.is_ascii_digit());
        if !dated || !e.path().is_dir() || date.as_str() > packetver {
            continue;
        }
        let split = ["Renewal", "Pre-Renewal"].iter().any(|d| e.path().join(d).is_dir());
        if !split {
            layers.push(e.path());
        } else if e.path().join(era).is_dir() {
            layers.push(e.path().join(era));
        }
    }
    Ok(layers)
}

/// Copy what the rules take from one layer into the staged translation.
fn copy_layer_files(
    src: &Path,
    dst: &Path,
    rel: &str,
    take: &[String],
    skip: &[String],
) -> Result<(), String> {
    for e in entries(src)? {
        if e.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err(format!("translation layer contains a link: {}", e.path().display()));
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        if e.path().is_dir() {
            // Only into folders a take could still match.
            let dir = format!("{path}/");
            if take.iter().any(|t| t.starts_with(&dir) || dir.starts_with(t.as_str())) {
                copy_layer_files(&e.path(), dst, &path, take, skip)?;
            }
        } else if take.iter().any(|t| path.starts_with(t.as_str()))
            && !skip.iter().any(|s| path.starts_with(s.as_str()))
        {
            copy_file(&e.path(), &dst.join(&path))?;
        }
    }
    Ok(())
}

/// The client asks for `SignBoardList.lub`, and the asset server matches the
/// translation folder by exact case on Linux. The pre-renewal layer ships it
/// as `signboardlist.lub`, so the request missed it and fell through to the
/// GRF's renewal signboards. Renamed in the staged copy, never the source.
fn restore_signboard_name(dir: &Path) -> Result<(), String> {
    const NAME: &str = "SignBoardList.lub";
    if !dir.is_dir() {
        return Ok(());
    }
    for e in entries(dir)? {
        let name = e.file_name();
        let n = name.to_string_lossy();
        if n != NAME && n.eq_ignore_ascii_case(NAME) {
            fs::rename(e.path(), dir.join(NAME)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
    // Another client's GRF, read only for what the player's own client lacks.
    let fallback = optional(4)?;
    let ai = first_dir(&[client_dir.join("AI"), client_dir.join("dll_exe/AI")])
        .map(|p| readable_path(&p, true))
        .transpose()?;
    let text = game_text(cfg)?;
    let packetver = crate::packetver::chosen(cfg)?;
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
    // the GRFs. Lower indices preserve official -> rdata -> data precedence;
    // the fallback GRF is last, so it fills only names the client has none of.
    let archives: Vec<_> = official
        .iter()
        .chain(rdata.iter())
        .chain(std::iter::once(&data))
        .chain(fallback.iter())
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
        restore_signboard_name(&en.join("data/luafiles514/lua files"))?;
        let era = if crate::cmds::is_prerenewal(cfg) { "Pre-Renewal" } else { "Renewal" };
        let (take, skip) = translation_layer_rules(cfg);
        for layer in translation_layers(&translation, packetver, era)? {
            copy_layer_files(&layer, &en, "", &take, &skip)?;
        }
        for (src, dst) in translation_extras(cfg) {
            // A pin without one of them is an older translation, not a fault.
            if translation.join(&src).is_file() {
                copy_file(&translation.join(&src), &en.join(&dst))?;
            }
        }
    }
    let merged = server_root.join("System");
    if text.translated() {
        copy_over(&en.join("SystemEN"), &merged)?;
    }
    // ROenglishRE names the achievement table achievements.lub; the client
    // asks for achievement_list.lub, and got the Korean one (#164).
    let has_achievements = text.translated() && en.join("SystemEN/achievements.lub").is_file();
    if let Some(sys) = first_dir(&[client_dir.join("System"), client_dir.join("dll_exe/System")]) {
        // Behind the English item table rather than gone: it still names
        // what the translation does not (client_tables).
        if text.translated() {
            stage_client_item_table(&sys, &merged)?;
        }
        for e in entries(&sys)? {
            let name = e.file_name();
            let n = name.to_string_lossy().to_ascii_lowercase();
            // The English item and quest tables win while they are in
            // front; without them the client's own are the only copies there
            // are, and skipping them leaves the game with no item names.
            // Matched in any case: iRO ships `iteminfo.lub`, and the client's
            // first try, `System/itemInfo.lub`, finds it on a case-insensitive
            // disk and never gets to the English table.
            if text.translated()
                && (n.starts_with("iteminfo")
                    || n.starts_with("ongoingquestinfolist")
                    || (n.starts_with("achievement_list") && has_achievements))
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
        if has_achievements {
            copy_file(
                &en.join("SystemEN/achievements.lub"),
                &merged.join("achievement_list.lub"),
            )?;
        }
        copy_over(&en.join("SystemEN"), &server_root.join("SystemEN"))?;
    }
    copy_data_aliased(
        &cfg.root.join("client-assets/data"),
        &server_root.join("data"),
    )?;
    let (plugins, tables) = overlay_mods(cfg, &server_root, &merged)?;
    // After the mods' own client files, so its table is the one served.
    let navigation_npcs = crate::navnpc::stage(cfg, &server_root)?;
    let navigation_mobs = crate::navmob::stage(cfg, &server_root)?;
    let navigation_warps = crate::navwarp::stage(cfg, &server_root)?;
    let mut fingerprint = 0xcbf2_9ce4_8422_2325;
    // Bumped when how the tree is staged changes without its inputs changing
    // (v3: the signboard table's name; v4: the client's item table staged
    // behind the English one; v5: the Compatibility layers stacked by packet
    // version), so a client holding the old staging in its cache drops it.
    fnv(&mut fingerprint, b"owned-assets-v5");
    fnv(&mut fingerprint, text.as_str().as_bytes());
    // Config.local.js carries it, and that file is an ordinary HTTP request
    // the shell only re-fetches when this fingerprint moves. Left out at the
    // default so an existing install keeps the fingerprint it already has.
    if !crate::packetver::suffix(packetver).is_empty() {
        fnv(&mut fingerprint, packetver.as_bytes());
    }
    fnv(&mut fingerprint, overlay_fingerprint(cfg).as_bytes());
    // Built partly from mods' server scripts, which overlay_fingerprint leaves
    // out because the client never sees them -- except through this table.
    for (name, table) in [
        (crate::navnpc::MOD, &navigation_npcs),
        (crate::navmob::MOD, &navigation_mobs),
        (crate::navwarp::MOD, &navigation_warps),
    ] {
        if let Some(table) = table {
            fnv(&mut fingerprint, name.as_bytes());
            fnv(&mut fingerprint, table);
        }
    }
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
    write_client_config(cfg, &server_root, &plugins, &tables, text, packetver)?;
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
) -> Result<(Vec<(String, String)>, ModTables), String> {
    let mut plugins = Vec::new();
    let mut tables = ModTables::default();
    // The player's answers to whatever each mod declared in its mod.json.
    let saved = crate::mods::read_settings(&cfg.state)?;
    for m in crate::mods::enabled(cfg) {
        // The mod's own folder, then the running era's folder over it.
        for root in &m.roots {
            // Served ahead of the GRFs: sprites, .act/.spr, map geometry, Lua.
            // Aliased, so a mod can be written in ASCII rather than in CP949 bytes.
            // A table the client merges, such as the signboard list, is copied
            // aside instead of over the stock one; see client_tables.
            tables.extend(copy_data_layer(&root.join("data"), server_root, &m.name)?);
            // Music. The client asks for `BGM/<file>`, a root outside data/, so
            // this is its own layer rather than part of the one above.
            copy_over(&root.join("BGM"), &server_root.join("BGM"))?;
            // Client tables. The whole-game ones are added to rather than
            // replaced; see client_tables.
            tables.extend(copy_system_layer(&root.join("System"), merged, &m.name)?);
            // A table where the client never reads it is copied like any file
            // and does nothing, so the mod says why.
            warn_misplaced(root, &m.name);
        }
        // The sky, clouds and weather it gives its maps (mod.json "maps").
        tables.add_maps(&m.manifest.maps);
        // A roBrowser plugin: styling, UI, anything the client can be told to
        // load. Served from the root, so the path in the config is
        // server-relative -- which is the one thing that will confuse people.
        if m.roots.iter().any(|r| r.join("client").join("index.js").is_file()) {
            for root in &m.roots {
                copy_over(&root.join("client"), &server_root.join("plugins").join(&m.name))?;
            }
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
    Ok((plugins, tables))
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
        // Each root's layers, named relative to the mod folder, so a mod with
        // no era folder hashes exactly as it did before there were any.
        let layers: Vec<(PathBuf, PathBuf)> = m
            .roots
            .iter()
            .flat_map(|root| {
                let rel = root.strip_prefix(&m.dir).unwrap_or(Path::new("")).to_path_buf();
                client_roots(root).into_iter().map(move |sub| (root.join(sub), rel.join(sub)))
            })
            .collect();
        // A mod that reaches only the server has nothing the client could be
        // holding a stale copy of. Skipping its name as well as its files is
        // the difference between toggling a drop-rate mod and re-downloading
        // the client's whole working set to find nothing had changed.
        if layers.is_empty() {
            continue;
        }
        // The name, and in order: two mods overlaying the same path resolve by
        // load order, so the same set in a different order is a different tree.
        fnv(&mut hash, m.name.as_bytes());
        for (dir, rel) in layers {
            hash_tree(&mut hash, &dir, &rel);
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
    // data/palette. Doram hair first: it is longer than, and not under, hair.
    ("palette/doram/hair",     "palette/\u{b5}\u{b5}\u{b6}\u{f7}\u{c1}\u{b7}/\u{b8}\u{d3}\u{b8}\u{ae}"),                         // 도람족/머리
    ("palette/body",           "palette/\u{b8}\u{f6}"),                                                                         // 몸
    ("palette/hair",           "palette/\u{b8}\u{d3}\u{b8}\u{ae}"),                                                             // 머리
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

/// The path a mod's `data/` file is served at: ASCII aliases expanded, then any
/// Korean written in the path -- folder or file name, anywhere in it -- put in
/// the client's CP949 spelling, so `palette/body/로그_여_4.pal` is the file
/// the client asks for as `palette/¸ö/·Î±×_¿©_4.pal`.
fn client_path(rel: &str) -> String {
    crate::cp949::client_spelling(&apply_aliases(rel))
}

/// Copy a mod's `data/` tree, translating ASCII directory aliases as it goes.
fn copy_data_aliased(src: &Path, dst: &Path) -> Result<(), String> {
    copy_data_tree(src, dst, |_| None::<()>).map(|_| ())
}

/// `copy_data_aliased`, except that a file `aside` answers for -- by its path
/// under `data/`, as the mod wrote it -- is not copied but handed back with the
/// answer, for the caller to put somewhere of its own.
fn copy_data_tree<T>(src: &Path, dst: &Path, aside: impl Fn(&str) -> Option<T>) -> Result<Vec<(T, PathBuf)>, String> {
    let mut kept = Vec::new();
    if !src.exists() {
        return Ok(kept);
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
            } else if let Some(answer) = aside(&child) {
                kept.push((answer, from));
            } else {
                let to = dst.join(client_path(&child));
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                copy_file(&from, &to)?;
            }
        }
    }
    // The walk is a stack, so it is not in name order; the caller numbers
    // what it gets, and that has to come out the same on every machine.
    kept.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(kept)
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

/// Replace the number in the template's server entry, `port: <digits>,`.
/// Anchored on the tab-indented line start so it cannot match a key that
/// merely ends in "port" -- `socketProxy` and the like.
fn set_login_port(body: &str, port: u16) -> String {
    const KEY: &str = "\tport: ";
    let Some(start) = body.find(KEY).map(|i| i + KEY.len()) else {
        return body.to_string();
    };
    let end = start + body[start..].bytes().take_while(u8::is_ascii_digit).count();
    format!("{}{port}{}", &body[..start], &body[end..])
}

/// Replace the number in the template's `packetver: <digits>,` line.
fn set_packetver(body: &str, packetver: &str) -> String {
    const KEY: &str = "packetver: ";
    let Some(start) = body.find(KEY).map(|i| i + KEY.len()) else {
        return body.to_string();
    };
    let end = start + body[start..].bytes().take_while(u8::is_ascii_digit).count();
    format!("{}{packetver}{}", &body[..start], &body[end..])
}

fn write_client_config(
    cfg: &Config,
    web: &Path,
    plugins: &[(String, String)],
    tables: &ModTables,
    text: GameText,
    packetver: &str,
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
    // The client has to speak the packet version the server was built for.
    // Replaced by pattern rather than by the template's literal, so the
    // template's own number can move without this following it.
    let body = set_packetver(&body, packetver);
    // The login server's port: the one TCP destination the client dials by
    // number. Char and map it is told by the servers themselves, and the asset
    // server it reaches through `location.host`, so this is the only port the
    // client config carries (ports.rs).
    let body = set_login_port(&body, cfg.ports.login);
    // The codepage every client table is read with. The template is Korean,
    // which is right whenever the English overlay is in front of it; see
    // GameText for why the two cannot be chosen separately.
    let body = if text.langtype() == 0 {
        body
    } else {
        body.replace("langtype: 0,", &format!("langtype: {},", text.langtype()))
    };
    // The tables mods add to the client's own, each a list the client loads
    // beside its base; client_tables says in which order, and why.
    let mut body = body;
    for entry in tables.config_entries(web) {
        body = insert_before_close(body, &entry);
    }
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
            ports: crate::ports::Ports::DEFAULT,
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
            ("fallback.grf", "other client"),
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
        let args: Vec<_> = ["data.grf", "rdata.grf", "official.grf", "BGM", "fallback.grf"]
            .iter()
            .map(|p| client.join(p).to_str().unwrap().to_string())
            .collect();
        link(&cfg, &args).unwrap();
        let manifest = fs::read_to_string(cfg.state.join("asset-config/DATA.INI")).unwrap();
        assert!(manifest.lines().nth(1).unwrap().ends_with("official.grf"));
        assert!(manifest.lines().nth(2).unwrap().ends_with("rdata.grf"));
        assert!(manifest.lines().nth(3).unwrap().ends_with("data.grf"));
        assert!(manifest.lines().nth(4).unwrap().ends_with("fallback.grf"));
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

    /// The client asks for `SignBoardList.lub` in that case, and the asset
    /// server reads the translation folder case-sensitively on Linux. The
    /// pre-renewal layer ships the table as `signboardlist.lub`, so unless it
    /// is staged under the name the client asks for, the request falls through
    /// to the GRF and the renewal signboards stay over NPCs that have moved.
    #[test]
    fn the_pre_renewal_signboard_table_is_staged_under_the_name_the_client_asks_for() {
        let cfg = fixture_config("signboard-case");
        let client = cfg.state.parent().unwrap().join("client files");
        write(&client.join("data.grf"), "archive");
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
        let table = "data/luafiles514/lua files/signboardlist.lub";
        write(&en.join("Pre-Renewal").join(table), "classic signs");
        write(
            &cfg.root.join("config/Config.local.js"),
            "window.ROConfigLocal = {\nrenewal: true,\n};\n",
        );
        write(&cfg.root.join("config/index.html"), "game entry");
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];
        let staged = cfg
            .state
            .join("assets/.translation/data/luafiles514/lua files");
        // Names as the directory lists them: an exact-case lookup is what the
        // asset server does, and a case-insensitive filesystem would answer
        // `exists()` for either spelling.
        let names = |dir: &Path| -> Vec<String> {
            fs::read_dir(dir)
                .map(|d| {
                    d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default()
        };

        link(&cfg, &args).unwrap();
        assert!(
            !names(&staged).iter().any(|n| n.eq_ignore_ascii_case("SignBoardList.lub")),
            "renewal has no signboard table of its own; the client's stays in front"
        );

        write(&cfg.state.join("prerenewal"), "true");
        link(&cfg, &args).unwrap();
        assert!(
            names(&staged).iter().any(|n| n == "SignBoardList.lub"),
            "staged under {:?}, which the client's request does not match",
            names(&staged)
        );
        assert_eq!(
            fs::read_to_string(staged.join("SignBoardList.lub")).unwrap(),
            "classic signs"
        );
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// A kRO client's own Korean copies must not win over the English ones
    /// the translation carries under other names or in its Compatibility
    /// layers (#164), and the extras list cannot reach outside its trees.
    #[test]
    fn the_translation_covers_achievements_map_names_and_the_message_csv() {
        let cfg = fixture_config("extras");
        let client = cfg.state.parent().unwrap().join("client");
        for (path, text) in [
            ("data.grf", "archive"),
            ("System/achievement_list.lub", "Korean achievements"),
            ("System/mapInfo.lub", "Korean map names"),
        ] {
            write(&client.join(path), text);
        }
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(&en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"), "English items");
        write(&en.join("Renewal/SystemEN/OngoingQuests.lub"), "English quests");
        write(&en.join("Renewal/SystemEN/achievements.lub"), "English achievements");
        write(&en.join("Compatibility/2019-06-05/SystemEN/mapInfo.lub"), "English map names");
        write(&en.join("Compatibility/2023-08-02/data/msgstringtable.csv"), "English messages");
        write(&en.join("Compatibility/secret.txt"), "outside");
        write(
            &cfg.root.join("config/TRANSLATION_EXTRAS"),
            "# comment\n\
             Compatibility/2019-06-05/SystemEN/mapInfo.lub\tSystemEN/mapInfo.lub\n\
             Compatibility/2023-08-02/data/msgstringtable.csv\tdata/msgstringtable.csv\n\
             Compatibility/2099-01-01/data/absent.txt\tdata/absent.txt\n\
             Compatibility/secret.txt\t../../escaped.txt\n",
        );
        write(
            &cfg.root.join("config/Config.local.js"),
            "window.ROConfigLocal = {\nrenewal: true,\n};\n",
        );
        write(&cfg.root.join("config/index.html"), "game entry");
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];
        link(&cfg, &args).unwrap();
        let read = |p: &str| fs::read_to_string(cfg.state.join("assets").join(p)).unwrap();
        assert_eq!(read("System/achievement_list.lub"), "English achievements");
        assert_eq!(read("System/mapInfo.lub"), "English map names");
        assert_eq!(read(".translation/data/msgstringtable.csv"), "English messages");
        assert!(!cfg.state.join("assets/.translation/data/absent.txt").exists());
        assert!(!cfg.state.join("escaped.txt").exists());
        assert!(!cfg.state.join("assets/escaped.txt").exists());
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// The Compatibility layers stack up to the chosen packet version, oldest
    /// first and in the running era's folder, taking only what
    /// TRANSLATION_LAYERS names; TRANSLATION_EXTRAS still has the last word.
    #[test]
    fn compatibility_layers_follow_the_packet_version_and_era() {
        let cfg = fixture_config("layers");
        let client = cfg.state.parent().unwrap().join("client");
        write(&client.join("data.grf"), "archive");
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(&en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"), "English items");
        write(&en.join("Renewal/SystemEN/OngoingQuests.lub"), "English quests");
        let c = en.join("Compatibility");
        write(&c.join("2017-06-14/data/texture/ui/button.bmp"), "2017 button");
        write(&c.join("2017-06-14/data/texture/ui/narrow_tab.bmp"), "wrong size");
        write(&c.join("2017-12-13/Renewal/data/texture/ui/era.bmp"), "renewal art");
        write(&c.join("2017-12-13/Pre-Renewal/data/texture/ui/era.bmp"), "pre-renewal art");
        write(&c.join("2018-06-20/Renewal/data/luafiles514/lua files/skillinfoz/skilltreeview.lub"), "older layout");
        write(&c.join("2022-04-06/data/contentdata/repute/reputegroupdata.bson"), "English factions");
        write(&c.join("2023-08-02/data/simplemsg/msg_emotion.csv"), "English emotions");
        write(&c.join("2023-08-02/data/texture/ui/button.bmp"), "2023 button");
        write(&c.join("2023-08-02/data/texture/ui/extra.bmp"), "2023 only");
        write(&c.join("2025-12-17/data/texture/ui/future.bmp"), "too new for either");
        write(&c.join("notes/data/texture/ui/undated.bmp"), "not a layer");
        write(&cfg.root.join("config/TRANSLATION_LAYERS"),
            "# comment\ntake\tdata/texture/\ntake\tdata/contentdata/repute/\n\
             take\tdata/simplemsg/msg_emotion.csv\nskip\tdata/texture/ui/narrow_\n");
        write(&cfg.root.join("config/TRANSLATION_EXTRAS"),
            "Compatibility/2017-06-14/data/texture/ui/narrow_tab.bmp\tdata/texture/ui/forced.bmp\n");
        write(&cfg.root.join("config/Config.local.js"),
            "window.ROConfigLocal = {\npacketver: 20221005,\nrenewal: true,\n};\n");
        write(&cfg.root.join("config/index.html"), "game entry");
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];
        let staged = cfg.state.join("assets/.translation");
        let read = |p: &str| fs::read_to_string(staged.join(p)).ok();

        // 20221005: up to the 2022-09-28 layer.
        link(&cfg, &args).unwrap();
        assert_eq!(read("data/texture/ui/button.bmp").as_deref(), Some("2017 button"));
        assert_eq!(read("data/texture/ui/era.bmp").as_deref(), Some("renewal art"));
        assert_eq!(read("data/contentdata/repute/reputegroupdata.bson").as_deref(), Some("English factions"));
        assert_eq!(read("data/texture/ui/narrow_tab.bmp"), None, "skipped");
        assert_eq!(read("data/texture/ui/forced.bmp").as_deref(), Some("wrong size"), "extras apply after");
        assert_eq!(read("data/luafiles514/lua files/skillinfoz/skilltreeview.lub"), None, "not taken");
        assert_eq!(read("data/simplemsg/msg_emotion.csv"), None, "2023 is after 20221005");
        assert_eq!(read("data/texture/ui/extra.bmp"), None);
        assert_eq!(read("data/texture/ui/future.bmp"), None);
        assert_eq!(read("data/texture/ui/undated.bmp"), None);

        // 20250402: the later layers too, a newer copy over an older one.
        if let Some(other) = crate::packetver::all().get(1) {
            write(&cfg.state.join("settings.json"), &format!("{{\"packetver\":\"{other}\"}}"));
            link(&cfg, &args).unwrap();
            assert_eq!(read("data/texture/ui/button.bmp").as_deref(), Some("2023 button"));
            assert_eq!(read("data/texture/ui/extra.bmp").as_deref(), Some("2023 only"));
            assert_eq!(read("data/simplemsg/msg_emotion.csv").as_deref(), Some("English emotions"));
            assert_eq!(read("data/texture/ui/future.bmp"), None);
        }

        // Pre-renewal takes the other half of a split layer.
        write(&en.join("Pre-Renewal/data/table.txt"), "pre-renewal table");
        write(&cfg.state.join("prerenewal"), "true");
        link(&cfg, &args).unwrap();
        assert_eq!(read("data/texture/ui/era.bmp").as_deref(), Some("pre-renewal art"));
        assert_eq!(read("data/texture/ui/button.bmp").as_deref().map(|b| b.ends_with("button")), Some(true));
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

        // Same files, Taiwanese reading: langtype 4, which roBrowser decodes
        // as big5, and again no English overlay.
        write(&cfg.state.join("settings.json"), "{\"game_text\":\"client_taiwan\"}");
        link(&cfg, &args).unwrap();
        assert!(fs::read_to_string(cfg.state.join("assets/Config.local.js"))
            .unwrap()
            .contains("langtype: 4,"));
        assert!(!cfg.state.join("assets/System/itemInfo.lua").exists());
        assert!(!cfg.state.join("assets/SystemEN").exists());

        // A value nobody wrote is refused rather than read as the default.
        write(&cfg.state.join("settings.json"), "{\"game_text\":\"portuguese\"}");
        assert!(link(&cfg, &args).unwrap_err().contains("portuguese"));
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// iRO's client names its tables in lower case. They are skipped all the
    /// same while the translation is in front: the client asks for
    /// `System/itemInfo.lub` before `itemInfo.lua`, and on Windows and macOS
    /// that request finds `iteminfo.lub`, so the English table, and every item
    /// only it names, was never read (standart-npc#55). The item table is
    /// kept, though, under a name the client never tries on its own, and
    /// listed after the English one: iRO names items the translation does not.
    #[test]
    fn the_clients_own_tables_are_skipped_in_any_case() {
        let cfg = fixture_config("gametext-case");
        let client = cfg.state.parent().unwrap().join("client");
        for (path, text) in [
            ("data.grf", "archive"),
            ("System/iteminfo.lub", "iRO items"),
            ("System/iteminfo_sak.lub", "iRO test items"),
            ("System/ongoingquestinfolist_true.lub", "iRO quests"),
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

        link(&cfg, &args).unwrap();
        let names: Vec<String> = fs::read_dir(cfg.state.join("assets/System"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        for gone in ["iteminfo.lub", "iteminfo_sak.lub", "ongoingquestinfolist_true.lub"] {
            assert!(!names.iter().any(|n| n == gone), "{gone} in {names:?}");
        }
        assert!(names.iter().any(|n| n == "font.ttf"), "{names:?}");
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/System/itemInfo.lua")).unwrap(),
            "English items"
        );
        // The client's item table, behind the English one; not its test
        // server's.
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/System/itemInfo_client.lub")).unwrap(),
            "iRO items"
        );
        let config = fs::read_to_string(cfg.state.join("assets/Config.local.js")).unwrap();
        assert!(
            config.contains("\tcustomItemInfo: ['System/itemInfo.lua', 'System/itemInfo_client.lub'],\n"),
            "{config}"
        );

        // Without the translation they are the only tables there are, under
        // their own names and in the client's own default order.
        write(&cfg.state.join("settings.json"), "{\"game_text\":\"client_western\"}");
        link(&cfg, &args).unwrap();
        assert_eq!(
            fs::read_to_string(cfg.state.join("assets/System/iteminfo.lub")).unwrap(),
            "iRO items"
        );
        assert!(!cfg.state.join("assets/System/itemInfo_client.lub").exists());
        let config = fs::read_to_string(cfg.state.join("assets/Config.local.js")).unwrap();
        assert!(!config.contains("customItemInfo"), "{config}");
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// The client's packetver follows the server's, whatever number the
    /// template happens to carry, and a version the image was not built for
    /// stops the rebuild instead of producing a client nothing can talk to.
    #[test]
    fn the_client_speaks_the_chosen_packet_version() {
        let body = "servers: [{\n\t\t\tpacketver: 20221005,\n\t\t\trenewal: true,\n}]";
        assert_eq!(set_packetver(body, "20200401"),
            "servers: [{\n\t\t\tpacketver: 20200401,\n\t\t\trenewal: true,\n}]");
        assert_eq!(set_packetver(body, "20221005"), body);
        assert_eq!(set_packetver("no such key", "20200401"), "no such key");
        // The shipped template has the line, and at the default.
        let template = include_str!("../../config/Config.local.js");
        assert!(template.contains(&format!("packetver: {},", crate::packetver::default())),
            "config/Config.local.js should carry the first line of config/PACKETVERS");

        let cfg = fixture_config("packetver");
        let client = cfg.state.parent().unwrap().join("client");
        write(&client.join("data.grf"), "archive");
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(&en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"), "English items");
        write(&en.join("Renewal/SystemEN/OngoingQuests.lub"), "English quests");
        write(&cfg.root.join("config/Config.local.js"),
            "window.ROConfigLocal = {\npacketver: 20221005,\nrenewal: true,\nlangtype: 0,\n};\n");
        write(&cfg.root.join("config/index.html"), "game entry");
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];
        let served = || fs::read_to_string(cfg.state.join("assets/Config.local.js")).unwrap();

        link(&cfg, &args).unwrap();
        assert!(served().contains(&format!("packetver: {},", crate::packetver::default())));
        let default_id = fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap();
        if let Some(other) = crate::packetver::all().get(1) {
            write(&cfg.state.join("settings.json"), &format!("{{\"packetver\":\"{other}\"}}"));
            link(&cfg, &args).unwrap();
            assert!(served().contains(&format!("packetver: {other},")), "{}", served());
            // And the shell is told to drop the cached Config.local.js.
            assert_ne!(fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap(), default_id);
        }
        write(&cfg.state.join("settings.json"), "{\"packetver\":\"20110101\"}");
        assert!(link(&cfg, &args).unwrap_err().contains("20110101"));
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

    /// A mod's item and quest tables travel from its System/ folder into the
    /// client config: the whole path, with the base item table named after it.
    #[test]
    fn a_mod_s_tables_reach_the_client_config() {
        let cfg = fixture_config("mod-tables");
        fs::create_dir_all(cfg.root.join("config")).unwrap();
        let web = cfg.state.join("web");
        write(&web.join("System/itemInfo.lua"), "base");
        let src = cfg.state.join("mods/story/System");
        write(&src.join("itemInfo.lua"), "MOD ITEMS");
        write(&src.join("OngoingQuestInfoList.lub"), "MOD QUESTS");
        fs::write(cfg.root.join("config/Config.local.js"), "window.ROConfigLocal = {\n\tskipIntro: true\n};\n").unwrap();
        let tables = copy_system_layer(&src, &web.join("System"), "story").unwrap();
        write_client_config(&cfg, &web, &[], &tables, GameText::English, crate::packetver::default()).unwrap();
        let body = fs::read_to_string(web.join("Config.local.js")).unwrap();
        assert!(body.contains("\tcustomItemInfo: ['System/itemInfo-story.lua', 'System/itemInfo.lua'],\n"), "{body}");
        assert!(body.contains("\tcustomQuestInfo: ['System/OngoingQuestInfoList-story.lub'],\n"), "{body}");
        assert!(body.trim_end().ends_with("};"), "{body}");
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// Palettes, and Korean written as Korean: both land on the name the
    /// client asks for, file names included.
    #[test]
    fn palettes_and_korean_names_land_on_the_client_s_path() {
        assert_eq!(client_path("palette/body/rogue.pal"), "palette/\u{b8}\u{f6}/rogue.pal");
        assert_eq!(
            client_path("palette/body/로그_여_4.pal"),
            "palette/\u{b8}\u{f6}/\u{b7}\u{ce}\u{b1}\u{d7}_\u{bf}\u{a9}_4.pal"
        );
        assert_eq!(
            client_path("palette/hair/머리1_여_9.pal"),
            "palette/\u{b8}\u{d3}\u{b8}\u{ae}/\u{b8}\u{d3}\u{b8}\u{ae}1_\u{bf}\u{a9}_9.pal"
        );
        assert_eq!(
            client_path("palette/doram/hair/x.pal"),
            "palette/\u{b5}\u{b5}\u{b6}\u{f7}\u{c1}\u{b7}/\u{b8}\u{d3}\u{b8}\u{ae}/x.pal"
        );
        // The Korean folder itself works as well as its alias.
        assert_eq!(client_path("palette/몸/x.pal"), client_path("palette/body/x.pal"));
        // A name already in the client's spelling is left exactly as it was.
        assert_eq!(client_path("palette/\u{b8}\u{f6}/x.pal"), "palette/\u{b8}\u{f6}/x.pal");
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
        write_client_config(&cfg, &web, &plugins, &ModTables::default(), GameText::English, crate::packetver::default()).unwrap();
        let body = fs::read_to_string(web.join("Config.local.js")).unwrap();
        assert!(
            body.contains("'wasd-movement': { path: 'plugins/wasd-movement/index', pars: { \"show_controls_button\": false } }"),
            "{body}"
        );
        assert!(body.contains("'plain': { path: 'plugins/plain/index', pars: {  } }"), "{body}");
        assert!(body.trim_end().ends_with("};"), "{body}");
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// The shipped template, with a test world's ports: the client dials the
    /// moved login server, and nothing else in the file changes. With no
    /// override, the file is exactly what it always was.
    #[test]
    fn the_client_dials_the_configured_login_port() {
        let template = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/Config.local.js")).unwrap();
        assert!(template.contains("\t\t\tport: 6900,"), "the template moved its port line");

        let mut cfg = fixture_config("login-port");
        cfg.ports = crate::ports::Ports { asset: 13338, login: 16900, char: 16121, map: 15121, web: 18888, agent: 17490 };
        fs::create_dir_all(cfg.root.join("config")).unwrap();
        fs::write(cfg.root.join("config/Config.local.js"), &template).unwrap();
        let web = cfg.state.join("web");
        fs::create_dir_all(&web).unwrap();
        write_client_config(&cfg, &web, &[], &ModTables::default(), GameText::English, crate::packetver::default()).unwrap();
        let moved = fs::read_to_string(web.join("Config.local.js")).unwrap();
        assert!(moved.contains("\t\t\tport: 16900,"), "{moved}");
        assert!(!moved.contains("port: 6900,"), "{moved}");
        // The socket proxy still follows the page's own origin, which is how
        // the moved asset port reaches the client.
        assert!(moved.contains("location.host + '/ws/'"), "{moved}");

        cfg.ports = crate::ports::Ports::DEFAULT;
        write_client_config(&cfg, &web, &[], &ModTables::default(), GameText::English, crate::packetver::default()).unwrap();
        let default = fs::read_to_string(web.join("Config.local.js")).unwrap();
        assert_eq!(default, set_packetver(&template, crate::packetver::default()));
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

    /// With navigation-server-npcs on, the client's NPC table is replaced by
    /// one built from the scripts the server loads: the era's stock scripts,
    /// the stock ones a mod switches on, and a mod's own, behind its switches.
    #[test]
    fn server_npcs_replace_the_navigation_table_while_the_mod_is_on() {
        let cfg = fixture_config("server-npcs");
        let client = cfg.state.parent().unwrap().join("client");
        write(&client.join("data.grf"), "archive");
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(&en.join("Pre-Renewal/data/table.txt"), "pre-renewal table");
        write(&en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"), "English items");
        write(&en.join("Renewal/SystemEN/OngoingQuests.lub"), "English quests");
        write(&cfg.root.join("config/Config.local.js"), "window.ROConfigLocal = {\nrenewal: true,\n};\n");
        write(&cfg.root.join("config/index.html"), "game entry");
        let nav = cfg.state.join("mods").join(crate::navnpc::MOD);
        write(&nav.join("mod.json"), r#"{"default": "off"}"#);
        write(
            &nav.join(crate::navnpc::INDEX),
            "# stock\nsprite\t4_M_KAFRA\t112\nload\trenewal\tnpc/re.txt\nload\tprerenewal\tnpc/pre.txt\n\
             file\tnpc/re.txt\nnpc\tprontera\t1\t2\t0\t112\tRenewal Kafra\n\
             file\tnpc/pre.txt\nnpc\tprontera\t3\t4\t0\t112\tClassic Kafra\n\
             file\tnpc/custom/healer.txt\nnpc\tizlude\t5\t6\t0\t112\tHealer\n",
        );
        let town = cfg.state.join("mods/town");
        write(&town.join("mod.json"), r#"{"settings": [{"key": "night", "type": "boolean", "default": false}]}"#);
        write(&town.join("stock-npc.txt"), "npc/custom/healer.txt\n");
        write(&town.join("npc/guide.txt"), "izlude,7,8,0\tscript\tGuide\t4_M_KAFRA,{\n}\n");
        write(&town.join("npc/when/night/owl.txt"), "izlude,9,9,0\tshop\tNight Owl\t4_M_KAFRA,501:-1\n");
        crate::mods::enable(&cfg, "town").unwrap();
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];
        let table = || fs::read_to_string(cfg.state.join("assets").join(crate::navnpc::TABLE)).ok();
        let id = || fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap();

        link(&cfg, &args).unwrap();
        assert_eq!(table(), None, "off: the client keeps its own table");
        let off = id();

        crate::mods::enable(&cfg, crate::navnpc::MOD).unwrap();
        link(&cfg, &args).unwrap();
        let on = table().unwrap();
        for name in ["Renewal Kafra", "Healer", "Guide"] {
            assert!(on.contains(&format!("\"{name}\"")), "{name} missing: {on}");
        }
        assert!(!on.contains("Classic Kafra") && !on.contains("Night Owl"), "{on}");
        assert_ne!(id(), off, "switching the mod on must clear the cached table");
        let first = id();

        crate::mods::save_settings(&cfg, "town", r#"{"night": true}"#).unwrap();
        link(&cfg, &args).unwrap();
        assert!(table().unwrap().contains("\"izlude\", 4, 102, 112, \"Night Owl\""), "{:?}", table());
        assert_ne!(id(), first, "a mod's script reaching the table must clear the cache");

        write(&cfg.state.join("prerenewal"), "true");
        link(&cfg, &args).unwrap();
        let classic = table().unwrap();
        assert!(classic.contains("Classic Kafra") && !classic.contains("Renewal Kafra"), "{classic}");

        crate::mods::set_enabled(&cfg.state, crate::navnpc::MOD, false).unwrap();
        link(&cfg, &args).unwrap();
        assert_eq!(table(), None);
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// With navigation-server-monsters on, the monster table counts the
    /// era's stock spawns and every mod's, and describes each monster as the
    /// merged mob_db does: a mod's new monster, and a mod's change to a stock one.
    #[test]
    fn server_monsters_replace_the_navigation_table_while_the_mod_is_on() {
        let cfg = fixture_config("server-mobs");
        let client = cfg.state.parent().unwrap().join("client");
        write(&client.join("data.grf"), "archive");
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(&en.join("Pre-Renewal/data/table.txt"), "pre-renewal table");
        write(&en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"), "English items");
        write(&en.join("Renewal/SystemEN/OngoingQuests.lub"), "English quests");
        write(&cfg.root.join("config/Config.local.js"), "window.ROConfigLocal = {\nrenewal: true,\n};\n");
        write(&cfg.root.join("config/index.html"), "game entry");
        let nav = cfg.state.join("mods").join(crate::navmob::MOD);
        write(&nav.join("mod.json"), r#"{"default": "off"}"#);
        write(
            &nav.join(crate::navmob::INDEX),
            "load\trenewal\tnpc/re.txt\nload\tprerenewal\tnpc/pre.txt\n\
             mob\trenewal\t1002\tPORING\t1\tPlant\tMedium\tWater\t1\t0\tPoring\n\
             mob\tprerenewal\t1002\tPORING\t1\tPlant\tMedium\tWater\t1\t0\tClassic Poring\n\
             file\tnpc/re.txt\nspawn\tprt_fild08\t1002\t20\t0\t\n\
             file\tnpc/pre.txt\nspawn\tprt_fild08\t1002\t70\t0\t\n",
        );
        let isle = cfg.state.join("mods/isle");
        write(&isle.join("mod.json"), r#"{"settings": [{"key": "angry", "type": "boolean", "default": false}]}"#);
        write(&isle.join("npc/spawns.txt"), "my_isle,0,0\tmonster\t--en--\t30000,4\nprt_fild08,0,0\tmonster\tPoring\t1002,5\n");
        write(&isle.join("db/mob_db.yml"), "Body:\n  - Id: 30000\n    AegisName: MY_MOB\n    Name: Isle Crab\n    Level: 12\n    Size: Small\n    Race: Fish\n    Element: Water\n    ElementLevel: 2\n");
        write(&isle.join("db/when/angry/mob_db.yml"), "Body:\n  - Id: 1002\n    Name: Angry Poring\n    Level: 50\n");
        crate::mods::enable(&cfg, "isle").unwrap();
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];
        let table = || fs::read_to_string(cfg.state.join("assets").join(crate::navmob::TABLE)).ok();
        let id = || fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap();

        link(&cfg, &args).unwrap();
        assert_eq!(table(), None, "off: the client keeps its own table");
        let off = id();

        crate::mods::enable(&cfg, crate::navmob::MOD).unwrap();
        link(&cfg, &args).unwrap();
        let on = table().unwrap();
        // 25 Porings, the stock 20 and the mod's 5.
        assert!(on.contains(&format!("\"prt_fild08\", 1, 300, {}, \"Poring\", \"PORING\", 1, ", 25 << 16 | 1002)), "{on}");
        assert!(on.contains(&format!("\"my_isle\", 2, 300, {}, \"Isle Crab\", \"MY_MOB\", 12, {} }}", 4 << 16 | 30000, 22 << 16 | 5)), "{on}");
        assert_ne!(id(), off, "switching the mod on must clear the cached table");
        let first = id();

        crate::mods::save_settings(&cfg, "isle", r#"{"angry": true}"#).unwrap();
        link(&cfg, &args).unwrap();
        // The stock spawns show mob_db's new name; the mod's, which name
        // their monster, keep that name at the new level.
        let angry = table().unwrap();
        assert!(angry.contains(&format!("{}, \"Angry Poring\", \"PORING\", 50, ", 20 << 16 | 1002)), "{angry}");
        assert!(angry.contains(&format!("{}, \"Poring\", \"PORING\", 50, ", 5 << 16 | 1002)), "{angry}");
        assert_ne!(id(), first, "a mod's mob_db reaching the table must clear the cache");

        write(&cfg.state.join("prerenewal"), "true");
        crate::mods::save_settings(&cfg, "isle", r#"{"angry": false}"#).unwrap();
        link(&cfg, &args).unwrap();
        assert!(table().unwrap().contains(&format!("{}, \"Classic Poring\"", 70 << 16 | 1002)), "{:?}", table());

        crate::mods::set_enabled(&cfg.state, crate::navmob::MOD, false).unwrap();
        link(&cfg, &args).unwrap();
        assert_eq!(table(), None);
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// With navigation-server-warps on, the client's navigation patch gets the
    /// era's stock portals and every mod's, less those a mod switches off.
    #[test]
    fn server_warps_are_staged_while_the_mod_is_on() {
        let cfg = fixture_config("server-warps");
        let client = cfg.state.parent().unwrap().join("client");
        write(&client.join("data.grf"), "archive");
        let en = cfg.root.join("vendor/ROenglishRE/Translation");
        write(&en.join("Renewal/data/table.txt"), "renewal table");
        write(&en.join("Pre-Renewal/data/table.txt"), "pre-renewal table");
        write(&en.join("Renewal/SystemEN/LuaFiles514/itemInfo.lua"), "English items");
        write(&en.join("Renewal/SystemEN/OngoingQuests.lub"), "English quests");
        write(&cfg.root.join("config/Config.local.js"), "window.ROConfigLocal = {\nrenewal: true,\n};\n");
        write(&cfg.root.join("config/index.html"), "game entry");
        let nav = cfg.state.join("mods").join(crate::navwarp::MOD);
        write(&nav.join("mod.json"), r#"{"default": "off"}"#);
        write(
            &nav.join(crate::navwarp::INDEX),
            "load\trenewal\tnpc/re.txt\nload\tprerenewal\tnpc/pre.txt\n\
             file\tnpc/re.txt\nwarp\tprontera\t156\t22\tprt001\tprt_fild08\t170\t375\n\
             warp\tprontera\t107\t215\tprt01\tprt_in\t240\t139\n\
             file\tnpc/pre.txt\nwarp\tprontera\t156\t18\tprt001\tprt_fild08\t170\t370\n",
        );
        let isle = cfg.state.join("mods/isle");
        write(&isle.join("mod.json"), "{}");
        write(
            &isle.join("npc/gate.txt"),
            "-\tscript\tisle_gate\t-1,{\n\tend;\nOnInit:\n\tdisablenpc \"prt001\";\n\tend;\n}\n\
             prontera,156,22,0\twarp\tisle_gate_warp\t3,2,my_isle,40,40\n",
        );
        crate::mods::enable(&cfg, "isle").unwrap();
        let args = vec![client.join("data.grf").to_str().unwrap().to_string()];
        let table = || fs::read_to_string(cfg.state.join("assets").join(crate::navwarp::TABLE)).ok();
        let id = || fs::read_to_string(cfg.state.join("assets/overlay.id")).unwrap();

        link(&cfg, &args).unwrap();
        // Off: an empty table, so the client keeps its own routes and its
        // request for the file is not a miss in missing-files.log.
        assert_eq!(table().as_deref(), Some("Navi_Link_Server = {}\n"));
        let off = id();

        crate::mods::enable(&cfg, crate::navwarp::MOD).unwrap();
        link(&cfg, &args).unwrap();
        let on = table().unwrap();
        assert!(on.contains("\"prt01\", \"\", 107, 215, \"prt_in\", 240, 139"), "{on}");
        assert!(on.contains("\"isle_gate_warp\", \"\", 156, 22, \"my_isle\", 40, 40"), "{on}");
        assert!(!on.contains("prt001"), "the gate the mod switched off: {on}");
        assert_ne!(id(), off, "switching the mod on must clear the cached routes");

        crate::mods::set_enabled(&cfg.state, "isle", false).unwrap();
        write(&cfg.state.join("prerenewal"), "true");
        link(&cfg, &args).unwrap();
        let classic = table().unwrap();
        assert!(classic.contains("\"prt001\", \"\", 156, 18, \"prt_fild08\", 170, 370"), "{classic}");
        assert!(!classic.contains("prt01\"") && !classic.contains("my_isle"), "{classic}");

        crate::mods::set_enabled(&cfg.state, crate::navwarp::MOD, false).unwrap();
        link(&cfg, &args).unwrap();
        assert_eq!(table().as_deref(), Some("Navi_Link_Server = {}\n"));
        fs::remove_dir_all(cfg.state.parent().unwrap()).unwrap();
    }

    /// The client caches by filename, and every skin replaces the same
    /// filenames -- so two skins with identically sized pictures, written in
    /// the same second, must still read as different overlays, or switching
    /// between them would show the old one from the cache. The mod's name is
    /// in the fingerprint for exactly that.
    #[test]
    fn switching_skins_moves_the_overlay_fingerprint() {
        let cfg = fixture_config("skin-switch");
        let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        for (name, colour) in [("skin-blue", "blue"), ("skin-pink", "pink")] {
            let dir = cfg.state.join("mods").join(name);
            write(&dir.join("mod.json"), r#"{"kind": "skin"}"#);
            let art = dir.join("data/texture/ui/basic_interface/titlebar_mid.bmp");
            write(&art, colour);
            fs::File::options().write(true).open(&art).unwrap().set_modified(stamp).unwrap();
        }

        crate::mods::enable(&cfg, "skin-blue").unwrap();
        let blue = overlay_fingerprint(&cfg);
        crate::mods::enable(&cfg, "skin-pink").unwrap();
        let pink = overlay_fingerprint(&cfg);
        assert_ne!(blue, pink, "a skin switch would be served from the client's cache");

        crate::mods::enable(&cfg, "skin-blue").unwrap();
        assert_eq!(overlay_fingerprint(&cfg), blue, "switching back must not cost a second clear");

        crate::mods::set_enabled(&cfg.state, "skin-blue", false).unwrap();
        assert_ne!(overlay_fingerprint(&cfg), blue, "switching the skin off must clear it too");

        let _ = fs::remove_dir_all(cfg.state.parent().unwrap());
    }

    /// A mod's era folder reaches the client too, and only for its own era:
    /// an edit there must clear the cache, and an edit in the other era's
    /// folder, which the client never sees, must not.
    #[test]
    fn the_running_eras_client_files_count_and_the_other_eras_do_not() {
        let cfg = fixture_config("era-fingerprint");
        let dir = cfg.state.join("mods").join("era-art");
        write(&dir.join("mod.json"), r#"{"renewalFolder": "re", "prerenewalFolder": "pre-re"}"#);
        write(&dir.join("data/texture/shared.bmp"), "shared");
        write(&dir.join("re/data/texture/login.bmp"), "renewal");
        write(&dir.join("pre-re/data/texture/login.bmp"), "classic");

        let renewal = overlay_fingerprint(&cfg);
        write(&dir.join("pre-re/data/texture/login.bmp"), "classic, redrawn");
        assert_eq!(overlay_fingerprint(&cfg), renewal, "the other era's folder is not served");
        write(&dir.join("re/data/texture/login.bmp"), "renewal, redrawn");
        assert_ne!(overlay_fingerprint(&cfg), renewal, "an edit in the era folder went unnoticed");

        let _ = fs::remove_dir_all(cfg.state.parent().unwrap());
    }
}
