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
fn link_file(src: &Path, dst: &Path) -> Result<(), String> {
    let _ = fs::remove_file(dst);
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        if fs::hard_link(src, dst).is_ok() {
            return Ok(());
        }
        if std::os::windows::fs::symlink_file(src, dst).is_ok() {
            return Ok(());
        }
        Err(format!(
            "could not link {} into the asset root. On Windows this needs the \
             client and the app data directory on the same drive, or Developer \
             Mode enabled for symlinks.",
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
    let rdata = args.get(1).ok_or("rdata.grf path required")?;
    let official = args.get(2).filter(|s| !s.is_empty());
    let bgm = args.get(3).filter(|s| !s.is_empty());

    for f in [data, rdata] {
        if !Path::new(f).is_file() {
            return Err(format!("not a file: {f}"));
        }
    }

    let server_root = cfg.state.join("assets");
    let en = cfg.root.join("vendor/ROenglishRE/Translation/Renewal");
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
    link_file(Path::new(rdata), &res.join("rdata.grf"))?;
    ini.push_str(&format!("{i}=rdata.grf\n"));
    i += 1;
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
    link_dir(&merged, &server_root.join("System"))?;
    // Several loaders fall back to a SystemEN/ path when the System/ one is absent.
    link_dir(&en.join("SystemEN"), &server_root.join("SystemEN"))?;

    // roBrowser reads this over its baked-in defaults.
    let web = cfg.root.join("vendor/roBrowserLegacy/dist/Web");
    if web.is_dir() {
        let _ = fs::copy(cfg.root.join("config/Config.local.js"), web.join("Config.local.js"));
    }

    let grfs = ini.lines().filter(|l| l.starts_with(char::is_numeric)).count();
    println!(
        "linked: {grfs} GRFs, BGM {}",
        if bgm_src.is_some() { "yes" } else { "missing" }
    );
    Ok(())
}
