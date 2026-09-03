//! Wire a user-supplied Ragnarok client into the asset server.
//!
//! Builds a server root under state: `resources/` with the GRFs and a
//! generated DATA.INI, plus the loose directories the client reads. Nothing is
//! copied — the GRFs stay where the user keeps them, so a 3.5 GB client is not
//! duplicated. That constraint is what makes linking, rather than copying, the
//! whole design.

use crate::config::Config;
use std::fs;
use std::path::{Path, PathBuf};

/// Link a directory, by whatever mechanism the platform offers unprivileged.
///
/// Unix has symlinks. Windows reserves symlink creation for Developer Mode or
/// an elevated process, which we cannot assume of a player double-clicking an
/// installer — but directory *junctions* need no privilege at all and behave
/// the same for reading. `mklink` is a cmd builtin, so it cannot be spawned
/// directly.
fn link_dir(src: &Path, dst: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(dst);
    let _ = fs::remove_file(dst);
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(src, dst).is_ok() {
            return Ok(());
        }
        let st = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(dst)
            .arg(src)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(format!("could not junction {}", dst.display())) }
    }
}

/// Link a file. On Windows a hard link needs no privilege but requires the same
/// volume; falling back to a copy would duplicate gigabytes, so a failure here
/// is reported rather than papered over.
/// The drive a path lives on, on Windows. `None` anywhere else, and for a UNC
/// path, where "same drive" is not the question being asked.
#[cfg(windows)]
fn drive_of(p: &Path) -> Option<String> {
    use std::path::{Component, Prefix};
    match p.components().next() {
        Some(Component::Prefix(pre)) => match pre.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                Some((d as char).to_ascii_uppercase().to_string())
            }
            _ => None,
        },
        _ => None,
    }
}

fn link_file(src: &Path, dst: &Path) -> Result<(), String> {
    let _ = fs::remove_file(dst);
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        // A hard link cannot cross volumes and a symlink needs Developer Mode,
        // so a client folder on a second drive can have neither.
        if fs::hard_link(src, dst).is_ok() {
            return Ok(());
        }
        if std::os::windows::fs::symlink_file(src, dst).is_ok() {
            return Ok(());
        }

        // Not a copy. The GRFs are gigabytes, and quietly duplicating them onto
        // a drive the player did not choose is a worse surprise than an error
        // -- it can fill the disk, and it doubles what they are storing without
        // asking. Say which drive is which and let them decide.
        let (from, to) = (drive_of(src), drive_of(dst));
        if let (Some(from), Some(to)) = (&from, &to) {
            if from != to {
                return Err(format!(
                    "Your game client is on the {from}: drive and this app keeps its \
                     data on {to}:, and Windows cannot link files between drives.\n\n\
                     Move or copy the client folder to the {to}: drive, then choose it \
                     again:\n\n\x20   {}\n\n\
                     Alternatively, turn on Developer Mode (Settings, System, For \
                     developers) and choose the folder again -- that lets Windows \
                     link across drives without moving anything.",
                    src.display()
                ));
            }
        }

        Err(format!(
            "could not link {} into the asset root. Turn on Developer Mode \
             (Settings, System, For developers) and choose the client folder \
             again, or move it beside the app's data directory.",
            src.display()
        ))
    }
}

/// The first of `cands` that is a directory.
fn first_dir(cands: &[PathBuf]) -> Option<PathBuf> {
    cands.iter().find(|p| p.is_dir()).cloned()
}

pub fn link(cfg: &Config, args: &[String]) -> Result<(), String> {
    let data = args.first().ok_or("data.grf path required")?;
    // Optional, like official_data.grf.
    //
    // rdata.grf was a renewal overlay on an older base client, and clients have
    // not been packaged that way for years: recent ones ship a single data.grf
    // with everything merged in. Players downloading a 2026 client from the
    // rAthena forums -- renewal, fourth jobs and all -- have no rdata.grf to
    // give us, and requiring one turned them away from a client that would
    // have worked.
    //
    // What it uniquely carried, measured against a client that has both, is
    // 3,540 files: 2,751 garment sprites, 713 textures, 56 job sprites and six
    // maps. Everything else it holds is already in data.grf. So its absence
    // costs garments on a client old enough to have needed it, and costs
    // nothing at all on one new enough not to.
    let rdata = args.get(1).filter(|s| !s.is_empty());
    let official = args.get(2).filter(|s| !s.is_empty());
    let bgm = args.get(3).filter(|s| !s.is_empty());

    if !Path::new(data).is_file() {
        return Err(format!("not a file: {data}"));
    }
    if let Some(r) = rdata {
        if !Path::new(r).is_file() {
            return Err(format!("not a file: {r}"));
        }
    }

    let server_root = cfg.state.join("assets");
    let en = translation_root(cfg);
    let _ = fs::remove_dir_all(&server_root);
    fs::create_dir_all(server_root.join("resources")).map_err(|e| e.to_string())?;
    fs::create_dir_all(server_root.join("data")).map_err(|e| e.to_string())?;

    // Lower index wins, so overlays sit above the base client.
    let res = server_root.join("resources");
    let mut ini = String::from("[Data]\n");
    let mut i = 0;
    if let Some(o) = official {
        if Path::new(o).is_file() {
            link_file(Path::new(o), &res.join("official_data.grf"))?;
            ini.push_str(&format!("{i}=official_data.grf\n"));
            i += 1;
        }
    }
    if let Some(r) = rdata {
        link_file(Path::new(r), &res.join("rdata.grf"))?;
        ini.push_str(&format!("{i}=rdata.grf\n"));
        i += 1;
    }
    link_file(Path::new(data), &res.join("data.grf"))?;
    ini.push_str(&format!("{i}=data.grf\n"));
    fs::write(res.join("DATA.INI"), &ini).map_err(|e| e.to_string())?;

    // Loose client files usually sit beside the GRFs. BGM can be given
    // explicitly, because it is the one whose absence is noticed — the game is
    // simply silent.
    let client_dir = Path::new(data).parent().map(Path::to_path_buf).unwrap_or_default();
    let bgm_src = bgm
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| first_dir(&[client_dir.join("BGM"), client_dir.join("dll_exe/BGM")]));
    if let Some(b) = &bgm_src {
        link_dir(b, &server_root.join("BGM"))?;
    }
    if let Some(a) = first_dir(&[client_dir.join("AI"), client_dir.join("dll_exe/AI")]) {
        link_dir(&a, &server_root.join("AI"))?;
    }

    // System/ is a merge: the English tables win, the client backfills fonts
    // and quest data. Two names are excluded from the backfill because
    // roBrowser reaches for them first and would otherwise get the Korean copy:
    //   itemInfo*              — .lub resolves before .lua
    //   OngoingQuestInfoList*  — the translation calls the same table
    //                            OngoingQuests
    let merged = cfg.state.join("System");
    let _ = fs::remove_dir_all(&merged);
    fs::create_dir_all(&merged).map_err(|e| e.to_string())?;
    if let Ok(rd) = fs::read_dir(en.join("SystemEN")) {
        for e in rd.flatten() {
            let dst = merged.join(e.file_name());
            let _ = if e.path().is_dir() { link_dir(&e.path(), &dst) } else { link_file(&e.path(), &dst) };
        }
    }
    if let Some(sys) = first_dir(&[client_dir.join("System"), client_dir.join("dll_exe/System")]) {
        if let Ok(rd) = fs::read_dir(&sys) {
            for e in rd.flatten() {
                let name = e.file_name();
                let n = name.to_string_lossy();
                if n.starts_with("itemInfo") || n.starts_with("OngoingQuestInfoList") {
                    continue;
                }
                let dst = merged.join(&name);
                if dst.exists() {
                    continue;
                }
                let _ = if e.path().is_dir() { link_dir(&e.path(), &dst) } else { link_file(&e.path(), &dst) };
            }
        }
    }
    // The translation's itemInfo.lua is a require()/dofile() stub; point at the
    // table itself, which defines the global roBrowser's loader iterates.
    let _ = link_file(&en.join("SystemEN/LuaFiles514/itemInfo.lua"), &merged.join("itemInfo.lua"));
    let _ = link_file(&en.join("SystemEN/OngoingQuests.lub"), &merged.join("OngoingQuestInfoList.lub"));
    // Mods, laid over everything the client ships with.
    //
    // Order is the point. The asset server resolves loose files under its root
    // before DATA_OVERRIDE_PATH and before the archives, so a sprite or a Lua
    // table a mod puts here beats both the English translation and the client's
    // own GRFs -- without repacking a 2.4 GB file. System/ is overlaid after
    // the translation's links are in place, for the same reason: last writer
    // wins, and a mod should be able to replace itemInfo.lua if it is adding
    // items.
    //
    // Mods live in state/mods, not in the asset root, so rebuilding this tree
    // on every link cannot destroy them.
    let plugins = overlay_mods(cfg, &server_root, &merged);

    link_dir(&merged, &server_root.join("System"))?;
    // Several loaders fall back to a SystemEN/ path when the System/ one is absent.
    link_dir(&en.join("SystemEN"), &server_root.join("SystemEN"))?;

    // roBrowser reads this over its baked-in defaults.
    let web = cfg.root.join("vendor/roBrowserLegacy/dist/Web");
    if web.is_dir() {
        write_client_config(cfg, &web, &plugins)?;
        // And the root of the server becomes the game rather than roBrowser's
        // developer launcher, so the address a host copies out of Settings is a
        // link that works pasted into a browser as well as into the app.
        let _ = fs::copy(cfg.root.join("config/index.html"), web.join("index.html"));
    }

    let grfs = ini.lines().filter(|l| l.starts_with(char::is_numeric)).count();
    println!(
        "linked: {grfs} GRFs, BGM {}",
        if bgm_src.is_some() { "yes" } else { "missing" }
    );
    Ok(())
}

/// Copy a mod's client files over the assembled asset root.
///
/// Returns the mods that ship a roBrowser plugin, in the order they are loaded.
fn overlay_mods(cfg: &Config, server_root: &Path, merged: &Path) -> Vec<String> {
    let root = cfg.state.join("mods");
    let mut names: Vec<String> = match fs::read_dir(&root) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.'))
            .collect(),
        Err(_) => return Vec::new(),
    };
    // Name order, so two mods touching one file resolve predictably rather than
    // by whatever order the filesystem happens to hand back.
    names.sort();

    let mut plugins = Vec::new();
    for n in &names {
        let m = root.join(n);
        // Served ahead of the GRFs: sprites, .act/.spr, map geometry, Lua.
        let _ = copy_over(&m.join("data"), &server_root.join("data"));
        // Client tables -- itemInfo.lua and friends.
        let _ = copy_over(&m.join("System"), merged);
        // A roBrowser plugin: styling, UI, anything the client can be told to
        // load. Served from the root, so the path in the config is
        // server-relative -- which is the one thing that will confuse people.
        let client = m.join("client");
        if client.join("index.js").is_file() {
            let _ = copy_over(&client, &server_root.join("plugins").join(n));
            plugins.push(n.clone());
        }
    }
    plugins
}

/// Copy every file under `src` into `dst`, creating directories as needed.
/// Missing `src` is not an error: most mods use one or two of the layers.
fn copy_over(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_over(&from, &to)?;
        } else {
            // Remove first: the destination is often a symlink into the
            // translation or the client, and writing through one would edit
            // the file it points at rather than replacing the link.
            let _ = fs::remove_file(&to);
            let _ = fs::copy(&from, &to);
        }
    }
    Ok(())
}

/// Link every file under `src` into `dst`, recursing into subdirectories.
///
/// Directories are recursed rather than linked whole, because the point is to
/// let a second call land on top of a first: linking a directory would make
/// the whole subtree a single entry and the later layer could only replace it,
/// not overlay into it.
fn overlay_tree(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let rd = match fs::read_dir(src) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    for e in rd.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            overlay_tree(&from, &to)?;
        } else {
            let _ = fs::remove_file(&to);
            let _ = link_file(&from, &to);
        }
    }
    Ok(())
}

/// The English translation tree for the era we are starting.
///
/// Pre-Renewal is an *overlay* on Renewal, not a replacement. Upstream says so
/// -- "supports pre-renewal by overwriting the content of the Renewal folder
/// with the Pre-Renewal one" -- and the trees bear it out: Renewal carries 613
/// files of item, quest and interface text, Pre-Renewal 67. Serving
/// Pre-Renewal alone would drop the other 546 and leave the player with
/// untranslated text.
///
/// What it does carry is era-specific geometry: prontera, izlude, morocc,
/// alberta, prt_in, prt_church and prt_fild05/08 as .gat/.gnd/.rsw, plus the
/// worldmap textures. Those are the towns Renewal redrew, which is why they
/// are the ones shipped.
///
/// So for pre-renewal the two are merged into the state directory, Renewal
/// first and Pre-Renewal over the top. Renewal alone needs no merge and is
/// used from the payload directly. Falls back to Renewal if a payload predates
/// both eras being packaged.
fn translation_root(cfg: &Config) -> PathBuf {
    let base = cfg.root.join("vendor/ROenglishRE/Translation");
    let renewal = base.join("Renewal");
    if !crate::cmds::is_prerenewal(cfg) {
        return renewal;
    }
    let pre = base.join("Pre-Renewal");
    if !pre.is_dir() {
        return renewal;
    }
    let merged = cfg.state.join("translation");
    let _ = fs::remove_dir_all(&merged);
    for sub in ["data", "SystemEN"] {
        let _ = overlay_tree(&renewal.join(sub), &merged.join(sub));
        let _ = overlay_tree(&pre.join(sub), &merged.join(sub));
    }
    merged
}

/// Write the client config, naming any plugins the mods provide.
///
/// Generated rather than copied so the plugin list can be part of it. roBrowser
/// resolves these from the server root, which is where overlay_mods puts them.
fn write_client_config(cfg: &Config, web: &Path, plugins: &[String]) -> Result<(), String> {
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
    let out = if plugins.is_empty() {
        body
    } else {
        let entries: Vec<String> = plugins
            .iter()
            .map(|n| format!("\t\t'{n}': 'plugins/{n}/index'"))
            .collect();
        // Inserted before the closing brace of the config object rather than
        // appended: this is the last thing in the file and has to stay inside it.
        let plugin_map = format!("\tplugins: {{\n{}\n\t}},\n", entries.join(",\n"));
        match body.rfind("\n};") {
            Some(i) => format!("{},\n{}{}", &body[..i], plugin_map, &body[i + 1..]),
            None => body,
        }
    };
    fs::write(web.join("Config.local.js"), out)
        .map_err(|e| format!("writing Config.local.js: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
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
