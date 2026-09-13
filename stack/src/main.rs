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
mod accounts;
mod asset_transaction;
mod cmds;
mod crashes;
mod host;
mod config;
mod docker;
mod json;
mod mapcache;
mod mods;
mod process_identity;
mod registration;
mod hosting;
mod private_fs;
mod service_credentials;
mod operation_lock;

use config::Config;
use docker::Docker;
use std::env;
use std::path::PathBuf;
use std::process::exit;

const USAGE: &str = "usage: ragnarok-stack host-check|capture-crashes|hosting-check [--lan]|secure-services [--lan] [--ram MiB]|mods|mod-enable NAME|mod-disable NAME|up [--lan] [--ram MiB]|down|repair [--lan] [--ram MiB]|status|logs [service] [tail]\n\
                     \x20      backup <file>|restore <file>\n\
                     \x20      sql [--write] [--file <path>] [<statement>]\n\
                     \x20      accounts (private JSON request on stdin)\n\
                     \x20      link-assets <data.grf> [rdata.grf] [official_data.grf] [bgm-dir]";

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

    if verb == "process-identity" {
        let result = args.get(1).and_then(|s| s.parse::<u32>().ok())
            .ok_or_else(|| "process-identity needs a numeric PID".to_string())
            .and_then(process_identity::query);
        match result {
            Ok(identity) => println!("{identity}"),
            Err(error) => { eprintln!("{error}"); exit(1); }
        }
        return;
    }

    let loaded = if verb == "link-assets" {
        Config::load_for_assets(project_root())
    } else {
        Config::load(project_root())
    };
    let cfg = match loaded {
        Ok(c) => c,
        Err(e) => fail(verb, &e),
    };
    let dk = Docker::new(cfg.docker.clone(), cfg.nebula_home.clone(), cfg.state.clone());
    // A read is just a query and can run beside anything. `sql --write` stops
    // and starts game services, which is a lifecycle operation and has to
    // queue behind the others.
    let writes_sql = verb == "sql" && args.iter().any(|a| a == "--write");
    let _operation = if writes_sql || matches!(verb, "up" | "down" | "repair" | "backup" | "restore" | "accounts" | "secure-services" | "hosting-check" | "sharing-check" | "capture-crashes") {
        match operation_lock::acquire(&cfg.state) {
            Ok(lock) => Some(lock),
            Err(error) => fail(verb, &error),
        }
    } else { None };

    // LAN hosting is opt-in per invocation rather than sticky state: the app
    // passes it from a setting the player can see, and a plain `up` from a
    // terminal stays loopback-only.
    let lan = args.iter().any(|a| a == "--lan");

    // The VM's memory ceiling, passed the same way and for the same reason:
    // the app owns the value, a plain `up` from a terminal keeps whatever
    // config.toml already says.
    let ram_mib = args
        .iter()
        .position(|a| a == "--ram")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<u32>().ok());

    let result = match verb {
        // A pure read of the machine, for the diagnostics bundle. No lock: it
        // changes nothing and it is most wanted exactly when a start has
        // failed and something else holds the lock.
        "host-check" => {
            println!("{}", host::report(&cfg.nebula));
            Ok(())
        }
        "capture-crashes" => crashes::command(&cfg, &dk),
        "sharing-check" => hosting::sharing_check(&cfg, &dk).map(|report| println!("{report}")),
        "hosting-check" => hosting::check(&cfg, &dk, lan).map(|report| println!("{report}")),
        "accounts" => {
            if let Err(error) = accounts::run(&cfg, &dk) {
                fail(verb, &error);
            }
            Ok(())
        },
        "secure-services" => cmds::secure_services(&cfg, &dk, lan, ram_mib),
        "up" => cmds::up(&cfg, &dk, lan, ram_mib),
        "down" => cmds::down(&cfg, &dk),
        "repair" => cmds::repair(&cfg, &dk, lan, ram_mib),
        "status" => {
            cmds::status(&dk);
            Ok(())
        }
        "logs" => {
            cmds::logs(&dk, args.get(1).map(String::as_str).unwrap_or("map"),
                       args.get(2).map(String::as_str).unwrap_or("40"));
            Ok(())
        }
        "sql" => cmds::sql(&cfg, &dk, &args[1..]),
        "backup" => match args.get(1) {
            Some(p) => cmds::backup(&cfg, &dk, p),
            None => Err("destination file required".into()),
        },
        "link-assets" => assets::link(&cfg, &args[1..]),
        // Listing and toggling are separate from `up` so the Settings window
        // can show what is installed without starting a server.
        "mods" => {
            for row in mods::list(&cfg) {
                println!("{}", row.join("\t"));
            }
            Ok(())
        }
        // The values arrive as one JSON object in argv. spawn passes an
        // argument vector rather than a command line, so no quoting is at play,
        // and a mod's settings are bounded to twenty short scalars.
        "mod-settings" => match (args.get(1), args.get(2)) {
            (Some(name), Some(body)) => mods::save_settings(&cfg, name, body),
            _ => Err("mod name and a JSON object of settings required".into()),
        },
        "mod-enable" | "mod-disable" => match args.get(1) {
            Some(n) => mods::set_enabled(&cfg.state, n, verb == "mod-enable"),
            None => Err("mod name required".into()),
        },
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

fn fail(verb: &str, error: &str) -> ! {
    if verb == "accounts" {
        println!("{{\"error\":{}}}", json::quote(error));
    } else {
        eprintln!("{error}");
    }
    exit(1);
}
