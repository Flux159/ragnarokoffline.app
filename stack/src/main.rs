//! Bring the Ragnarok Offline server stack up or down inside nebula's microVM.
//!
//!   ragnarok-stack up|down|status|repair|logs [service] [tail]
//!   ragnarok-stack backup <file> | restore <file>
//!
//! This replaces scripts/stack.sh. It is a binary rather than a script because
//! the app ships to Windows, which has no POSIX shell — and a second,
//! PowerShell implementation of the same logic would be two things that must
//! agree forever and eventually would not. The app and a terminal run the same
//! code path, as they always have.

mod assets;
mod cmds;
mod config;
mod docker;

use config::Config;
use docker::Docker;
use std::env;
use std::path::PathBuf;
use std::process::exit;

const USAGE: &str = "usage: ragnarok-stack up|down|repair|status|logs [service] [tail]\n\
                     \x20      backup <file>|restore <file>\n\
                     \x20      link-assets <data.grf> <rdata.grf> [official_data.grf] [bgm-dir]";

/// The runtime tree, which is the directory containing bin/ and scripts/.
///
/// Derived from the executable's own location so the app and a terminal agree,
/// and overridable for a source checkout where the binary lives under target/.
fn project_root() -> PathBuf {
    if let Some(p) = env::var_os("RAGNAROK_OFFLINE_ROOT") {
        return PathBuf::from(p);
    }
    // The binary ships at <root>/bin/ragnarok-stack.
    if let Ok(exe) = env::current_exe() {
        if let Some(bin) = exe.parent() {
            if bin.file_name().map(|n| n == "bin").unwrap_or(false) {
                if let Some(root) = bin.parent() {
                    return root.to_path_buf();
                }
            }
        }
    }
    env::current_dir().unwrap_or_default()
}

fn main() {
    config::widen_path();
    let args: Vec<String> = env::args().skip(1).collect();
    let verb = args.first().map(String::as_str).unwrap_or("status");

    let cfg = match Config::load(project_root()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            exit(1);
        }
    };
    let dk = Docker::new(cfg.docker.clone(), cfg.nebula_home.clone());

    let result = match verb {
        "up" => cmds::up(&cfg, &dk),
        "down" => cmds::down(&cfg, &dk),
        "repair" => cmds::repair(&cfg, &dk),
        "status" => {
            cmds::status(&dk);
            Ok(())
        }
        "logs" => {
            cmds::logs(&dk, args.get(1).map(String::as_str).unwrap_or("map"),
                       args.get(2).map(String::as_str).unwrap_or("40"));
            Ok(())
        }
        "backup" => match args.get(1) {
            Some(p) => cmds::backup(&cfg, &dk, p),
            None => Err("destination file required".into()),
        },
        "link-assets" => assets::link(&cfg, &args[1..]),
        "restore" => match args.get(1) {
            Some(p) => cmds::restore(&cfg, &dk, p),
            None => Err("source file required".into()),
        },
        _ => {
            eprintln!("{USAGE}");
            exit(2);
        }
    };

    if let Err(e) = result {
        eprintln!("{e}");
        exit(1);
    }
}
