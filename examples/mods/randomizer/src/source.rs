//! Getting rAthena's own tables, without shipping a copy of them.
//!
//! The randomizer has to read `mob_db.yml` before it can shuffle it, and that
//! file is 800 KB pre-renewal and 2.3 MB renewal. Three ways to get it were
//! possible and only one is honest:
//!
//! - **Ship a copy in the payload.** Adds megabytes to every download for one
//!   optional tool, and goes stale the moment the rAthena image is rebuilt.
//! - **Ship a compact extract.** Same staleness, plus a second format to keep
//!   in step with upstream's schema.
//! - **Read it out of the server that is already running.** Costs nothing,
//!   cannot go stale, and is automatically the right era.
//!
//! So: `docker cp` from the `ragnarok-map` container. That works because the
//! container is running -- copying out of a *created but not started* one
//! silently succeeds and copies nothing under the bundled slim client, which
//! is why the app stages its `db/import` stubs at package time instead.
//!
//! A source checkout can skip all of it with `--rathena vendor/rathena`.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Source {
    /// A checkout to read from directly, if one was given.
    pub rathena: Option<PathBuf>,
    pub docker: PathBuf,
    pub nebula_home: PathBuf,
    pub container: String,
    /// Where files copied out of the container are put.
    pub scratch: PathBuf,
}

impl Source {
    /// Read one file from `db/<era>/` or `db/`, wherever it lives.
    pub fn db_file(&self, era: &str, name: &str) -> Result<String, String> {
        // The era directory first: mob_db.yml's Body is there, and the file at
        // db/mob_db.yml is only a header and a list of imports.
        for dir in [format!("db/{era}"), "db".to_string()] {
            match self.read(&format!("{dir}/{name}")) {
                Ok(text) if text.contains("\nBody:") => return Ok(text),
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
        Err(format!(
            "could not read db/{era}/{name} from {}",
            match &self.rathena {
                Some(p) => p.display().to_string(),
                None => format!("the {} container", self.container),
            }
        ))
    }

    fn read(&self, rel: &str) -> Result<String, String> {
        if let Some(root) = &self.rathena {
            let p = root.join(rel);
            return std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()));
        }
        let dest = self.scratch.join(rel.replace('/', "_"));
        let _ = std::fs::create_dir_all(&self.scratch);
        let _ = std::fs::remove_file(&dest);
        self.cp(rel, &dest)?;
        let text = std::fs::read_to_string(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        let _ = std::fs::remove_file(&dest);
        Ok(text)
    }

    fn cp(&self, rel: &str, dest: &Path) -> Result<(), String> {
        // Run from the destination's directory and pass a bare filename: the
        // client parses `a:b` as container:path, and an absolute Windows path
        // has a colon in it.
        let parent = dest.parent().ok_or("destination has no parent")?;
        let name = dest.file_name().ok_or("destination has no name")?;
        let mut c = Command::new(&self.docker);
        c.current_dir(parent);
        let sock = self.nebula_home.join("run/docker.sock");
        if cfg!(windows) {
            // On Windows that path is a file holding the loopback port the
            // engine's proxy listens on, not a socket.
            if let Ok(port) = std::fs::read_to_string(&sock) {
                let port = port.trim();
                if !port.is_empty() {
                    c.env("DOCKER_HOST", format!("tcp://127.0.0.1:{port}"));
                }
            }
        } else {
            c.env("DOCKER_HOST", format!("unix://{}", sock.display()));
        }
        c.env("NEBULA_HOME", &self.nebula_home);
        c.args(["cp", &format!("{}:/rathena/{rel}", self.container)]);
        c.arg(name);
        let out = c.output().map_err(|e| {
            format!("could not run {}: {e}", self.docker.display())
        })?;
        if !out.status.success() {
            return Err(format!(
                "docker cp {}:/rathena/{rel} failed: {}",
                self.container,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(())
    }
}

/// The app's data directory, matching `data_root()` in `stack/src/config.rs`.
///
/// Kept in step with the supervisor by hand, because this tool deliberately
/// does not depend on it -- it is an example that a modder can lift out and
/// build on its own.
pub fn data_root() -> PathBuf {
    if let Some(p) = std::env::var_os("RAGNAROK_OFFLINE_HOME") {
        return PathBuf::from(p);
    }
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        std::env::var_os("HOME")
    }
    .map(PathBuf::from)
    .unwrap_or_default();

    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Ragnarok Offline")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Ragnarok Offline")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("Ragnarok Offline")
    }
}

/// Which era the app is set to, read the way the supervisor reads it.
pub fn era_of(state: &Path) -> &'static str {
    if state.join("prerenewal").exists() {
        "pre-re"
    } else {
        "re"
    }
}

/// The bundled docker client, looked for beside this binary first.
///
/// This ships at `<runtime>/bin/ro-randomizer`, next to the `docker-slim` the
/// app uses, so the executable's own directory is the reliable answer -- PATH
/// is not, and an installed Docker Desktop would be talking to the wrong
/// engine anyway.
pub fn find_docker() -> Option<PathBuf> {
    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(format!("docker-slim{exe_suffix}"));
            if p.exists() {
                return Some(p);
            }
        }
    }
    let p = data_root().join(format!("runtime/bin/docker-slim{exe_suffix}"));
    if p.exists() {
        return Some(p);
    }
    None
}
