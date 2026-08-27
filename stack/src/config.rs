//! Where things live, and what they are called, on each platform.

use std::env;
use std::path::{Path, PathBuf};

pub const NET: &str = "ragnarokmac";
pub const DB_CONTAINER: &str = "ragnarok-db";
pub const SERVERS: [&str; 3] = ["ragnarok-login", "ragnarok-char", "ragnarok-map"];

/// `.exe` on Windows, nothing elsewhere. The embed kit ships `nebula.exe` and
/// `docker-slim.exe` there, and a lookup without the suffix simply misses.
pub const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

pub fn home() -> PathBuf {
    // std::env::home_dir is deprecated for good reasons on Windows; read the
    // variables directly rather than depend on a crate for two lookups.
    if cfg!(windows) {
        env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default()
    } else {
        env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
    }
}

/// The app's data root.
///
/// macOS keeps `~/Library/Application Support/Ragnarok Offline` exactly as it
/// has always been: shipped installs have their database and generated config
/// there, and moving it would lose both. Linux and Windows get their own
/// conventional locations rather than inheriting the macOS one, which is what
/// the shell version did — it wrote a literal `~/Library/Application Support`
/// directory on Linux.
pub fn data_root() -> PathBuf {
    if let Some(p) = env::var_os("RAGNAROK_OFFLINE_HOME") {
        return PathBuf::from(p);
    }
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Ragnarok Offline")
    } else if cfg!(windows) {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData/Roaming"))
            .join("Ragnarok Offline")
    } else {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".local/share"))
            .join("Ragnarok Offline")
    }
}

pub struct Config {
    /// The runtime tree: bin/, scripts/, config/, sql/, guest/, vendor/.
    pub root: PathBuf,
    /// Generated conf, seeded schema, backups. Outside `root` on purpose: a new
    /// app version replaces the runtime wholesale and this must survive it.
    pub state: PathBuf,
    pub nebula_home: PathBuf,
    pub nebula: PathBuf,
    pub docker: PathBuf,
    pub image: String,
    pub db_image: String,
}

impl Config {
    pub fn load(root: PathBuf) -> Result<Config, String> {
        let state = env::var_os("RAGNAROKMAC_STATE")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join(".ragnarokmac"));

        // A fixed path, not one derived from state: `nebula up` registers a
        // service label derived from this, and it must be stable across runs.
        // Separate from a standalone nebula install so neither side's `down`
        // stops the other's engine.
        let nebula_home = env::var_os("NEBULA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_root().join("nebula"));

        // Fall back when NEBULA_BIN names something that is not there, rather
        // than taking it on faith. An embedder that hands us a path without
        // the platform's executable suffix -- which our own app did on Windows
        // -- otherwise gets "nebula engine not found" naming a file it never
        // meant to ask for, while the real binary sits beside it.
        let nebula = env::var_os("NEBULA_BIN")
            .map(PathBuf::from)
            .filter(|p| p.exists())
            .unwrap_or_else(|| root.join(format!("bin/nebula{EXE}")));

        let docker = resolve_docker(&root)
            .ok_or_else(|| "no docker client found (bundled or installed)".to_string())?;

        Ok(Config {
            root,
            state,
            nebula_home,
            nebula,
            docker,
            image: env::var("RAGNAROKMAC_IMAGE")
                .unwrap_or_else(|_| "ragnarokmac/rathena:20221005".into()),
            // Pinned deliberately: MariaDB cannot open a data directory written
            // by a newer major version, so a floating tag can silently upgrade
            // the server and leave existing characters unreadable on rollback.
            db_image: env::var("RAGNAROKMAC_DB_IMAGE")
                .unwrap_or_else(|_| "ragnarokmac/mariadb:11.4".into()),
        })
    }

    pub fn lock_dir(&self) -> PathBuf {
        self.state.join(".stack.lock")
    }
}

/// Find a docker client without trusting PATH. A GUI app launched from Finder
/// inherits launchd's minimal PATH and sees nothing installed by Homebrew or
/// Rancher Desktop, so the bundled docker-slim is the default and an installed
/// client is only a fallback.
fn resolve_docker(root: &Path) -> Option<PathBuf> {
    if let Some(p) = env::var_os("RAGNAROKMAC_DOCKER") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let mut candidates = vec![root.join(format!("bin/docker-slim{EXE}"))];
    if cfg!(windows) {
        candidates.push(home().join("AppData/Local/Programs/Docker/Docker/resources/bin/docker.exe"));
        candidates.push(PathBuf::from(r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"));
    } else {
        candidates.push(home().join("Projects/nebula/slim/target/release/docker-slim"));
        candidates.push(home().join(".rd/bin/docker"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/docker"));
        candidates.push(PathBuf::from("/usr/local/bin/docker"));
        candidates.push(PathBuf::from("/usr/bin/docker"));
    }
    candidates.into_iter().find(|c| c.exists())
}

/// Widen PATH for a GUI-launched process. Only meaningful on Unix, where
/// launchd hands the app a four-entry PATH; on Windows the inherited
/// environment is already whatever the user has.
pub fn widen_path() {
    if cfg!(windows) {
        return;
    }
    let extra = [
        home().join(".rd/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/podman/bin"),
    ];
    let current = env::var_os("PATH").unwrap_or_default();
    let mut parts: Vec<PathBuf> = extra.to_vec();
    parts.extend(env::split_paths(&current));
    if let Ok(joined) = env::join_paths(parts) {
        env::set_var("PATH", joined);
    }
}

/// The address other machines on the network can reach this host at.
///
/// Found by asking the routing table which source address it would use to
/// reach the internet: a connected UDP socket sends nothing, but the kernel
/// still binds it, and the local address it picks is the one a peer would see.
/// That is more reliable than enumerating interfaces and guessing which is
/// "the" LAN one on a machine with VPNs, bridges and virtual adapters.
pub fn lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // A public address that needs no name lookup and is never contacted.
    sock.connect("1.1.1.1:80").ok()?;
    let addr = sock.local_addr().ok()?.ip();
    if addr.is_loopback() || addr.is_unspecified() {
        None
    } else {
        Some(addr)
    }
}
