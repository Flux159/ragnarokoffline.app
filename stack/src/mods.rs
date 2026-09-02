//! Mods: a folder per mod, assembled into the trees the map server can be given.
//!
//! A mod is a directory under `state/mods/` holding any of:
//!
//!   db/     rAthena override tables -- mob stats, item stats, drops, skills
//!   npc/    scripts: NPCs, warps, spawns, whole custom maps
//!   data/   client assets served ahead of the GRFs (handled in assets.rs)
//!   System/ client Lua tables (handled in assets.rs)
//!
//! Nothing here needs a rebuild, which is the whole point: rAthena already
//! reads `db/import` over its own tables, and the map server takes `npc:` lines
//! from the conf directory the app already mounts. This module only has to put
//! the right files in the right place and name them in the config.
//!
//! Mods are merged in name order, so two mods touching one file resolve
//! last-wins, and the order is at least predictable rather than filesystem
//! order.

use crate::config::Config;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Assembled {
    /// Host directory to bind at `/rathena/db/import`, if any mod ships tables.
    pub db: Option<PathBuf>,
    /// Host directory to bind at `/rathena/npc/mods`, if any mod ships scripts.
    pub npc: Option<PathBuf>,
    /// `npc:` lines for map_conf.txt, naming each script inside that mount.
    pub npc_lines: String,
    pub names: Vec<String>,
}

impl Assembled {
    fn empty() -> Assembled {
        Assembled { db: None, npc: None, npc_lines: String::new(), names: Vec::new() }
    }
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
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
    let root = cfg.state.join("mods");
    let _ = fs::create_dir_all(&root);

    let mut names: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(&root) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.path().is_dir() {
                continue;
            }
            names.push(name);
        }
    }
    names.sort();
    if names.is_empty() {
        return Ok(Assembled::empty());
    }

    // Rebuilt from scratch every start: a mod removed from state/mods must stop
    // affecting the server, and a stale merge is indistinguishable from a mod
    // that is still installed.
    let build = cfg.state.join("modbuild");
    let _ = fs::remove_dir_all(&build);

    let wants_db = names.iter().any(|n| root.join(n).join("db").is_dir());
    let mut out = Assembled::empty();
    out.names = names.clone();

    if wants_db {
        let dst = build.join("db");
        seed_db_import(cfg, &dst)?;
        for n in &names {
            let from = root.join(n).join("db");
            if from.is_dir() {
                copy_tree(&from, &dst)?;
            }
        }
        out.db = Some(dst);
    }

    let mut lines = String::new();
    for n in &names {
        let from = root.join(n).join("npc");
        if !from.is_dir() {
            continue;
        }
        let dst = build.join("npc").join(n);
        copy_tree(&from, &dst)?;
        // One `npc:` line per script. Paths are container-side, under the mount
        // point rather than the host path, and forward-slashed because rAthena
        // parses them itself rather than handing them to the OS.
        collect_scripts(&dst, &format!("npc/mods/{n}"), &mut lines);
    }
    if !lines.is_empty() {
        out.npc = Some(build.join("npc"));
        out.npc_lines = lines;
    }
    Ok(out)
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
