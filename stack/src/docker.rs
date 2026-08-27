//! A thin wrapper over the docker client.
//!
//! It shells out to `docker-slim` rather than speaking the Engine API
//! directly. The client already handles the one thing that differs per
//! platform — on Windows there is no AF_UNIX, so it falls back to the loopback
//! TCP port nebula's WHP proxy publishes — and reimplementing an API client
//! here would mean owning that difference ourselves for no gain.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

pub struct Docker {
    bin: PathBuf,
    nebula_home: PathBuf,
}

/// Storage attached to a container.
///
/// Windows has no virtiofs under nebula, so a host directory cannot be bind
/// mounted. `Bind` is therefore not a mount instruction but a statement of
/// intent — "the container needs these files at this path" — which is honoured
/// with a real mount where one is possible and with a copy where it is not.
pub enum Mount {
    Bind { host: PathBuf, container: String, ro: bool },
    Volume { name: String, container: String },
}

impl Docker {
    pub fn new(bin: PathBuf, nebula_home: PathBuf) -> Docker {
        Docker { bin, nebula_home }
    }

    fn base(&self) -> Command {
        let mut c = Command::new(&self.bin);
        let sock = self.nebula_home.join("run/docker.sock");
        if cfg!(windows) {
            // Windows has no AF_UNIX here, so run/docker.sock is a *file*
            // holding the loopback port nebulad's proxy listens on. The client
            // does not read it -- given only NEBULA_HOME it falls back to
            // Docker's default 2375 and fails with "connection refused",
            // which reads as the engine being down when it is running fine.
            // So the port is read here and passed explicitly.
            if let Ok(port) = fs::read_to_string(&sock) {
                let port = port.trim();
                if !port.is_empty() {
                    c.env("DOCKER_HOST", format!("tcp://127.0.0.1:{port}"));
                }
            }
        } else {
            c.env("DOCKER_HOST", format!("unix://{}", sock.display()));
        }
        c.env("NEBULA_HOME", &self.nebula_home);
        c
    }

    /// Run and capture stdout. Err carries stderr, for callers that report it.
    pub fn output<I, S>(&self, args: I) -> Result<String, String>
    where I: IntoIterator<Item = S>, S: AsRef<OsStr> {
        let out = self.base().args(args).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// Run for effect, discarding both streams. Used where the shell version
    /// wrote `|| true`: a failure that is genuinely not interesting.
    pub fn quiet<I, S>(&self, args: I) -> bool
    where I: IntoIterator<Item = S>, S: AsRef<OsStr> {
        self.base()
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    pub fn container_ids(&self, name: &str) -> Vec<String> {
        self.output(["ps", "-aq", "--filter", &format!("name={name}")])
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect()
    }

    pub fn state(&self, name: &str) -> Option<String> {
        self.output(["inspect", "-f", "{{.State.Status}}", name])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    pub fn is_running(&self, name: &str) -> bool {
        self.state(name).as_deref() == Some("running")
    }

    /// Remove every container answering to a name, then wait for the name to be
    /// released.
    ///
    /// By id, not by name: a container that exited without being cleaned up
    /// keeps its name, and `rm -f <name>` then fails with "multiple containers
    /// match" — so the one call that could clear the mess refuses to run.
    /// Removal is also asynchronous, and creating the replacement before the
    /// name is free is the "already in use" error.
    pub fn remove_container(&self, name: &str) {
        for id in self.container_ids(name) {
            self.quiet(["rm", "-f", &id]);
        }
        for _ in 0..30 {
            if self.container_ids(name).is_empty() {
                return;
            }
            sleep(Duration::from_millis(500));
        }
    }

    pub fn image_exists(&self, image: &str) -> bool {
        self.quiet(["image", "inspect", image])
    }

    pub fn logs(&self, name: &str, tail: &str) -> String {
        // Merged, because rAthena writes progress to both streams and the
        // readiness marker we look for can land on either.
        let out = self.base().args(["logs", "--tail", tail, name]).output();
        match out {
            Ok(o) => {
                let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
                s.push_str(&String::from_utf8_lossy(&o.stderr));
                s
            }
            Err(_) => String::new(),
        }
    }

    pub fn exec_sql(&self, sql: &str) -> Result<String, String> {
        self.output([
            "exec", "ragnarok-db", "mariadb", "-uragnarok", "-pragnarok", "ragnarok", "-e", sql,
        ])
    }

    /// Create, populate and start a container, honouring `Mount` in whatever
    /// way the platform allows.
    ///
    /// On Unix this is one `run` with `-v` flags, exactly as before. On Windows
    /// binds become `create` → `cp` → `start`, because nebula has no virtiofs
    /// there and the container would otherwise start with no config, no schema
    /// and no NPC scripts.
    pub fn run_container(
        &self,
        name: &str,
        image: &str,
        args: &[String],
        mounts: &[Mount],
        opts: &[String],
    ) -> Result<(), String> {
        let mut argv: Vec<String> = vec!["run".into(), "-d".into()];
        let mut deferred: Vec<(&PathBuf, &String)> = Vec::new();

        for m in mounts {
            match m {
                Mount::Volume { name: v, container } => {
                    argv.push("-v".into());
                    argv.push(format!("{v}:{container}"));
                }
                Mount::Bind { host, container, ro } => {
                    if cfg!(windows) {
                        deferred.push((host, container));
                    } else {
                        argv.push("-v".into());
                        argv.push(format!(
                            "{}:{}{}",
                            host.display(),
                            container,
                            if *ro { ":ro" } else { "" }
                        ));
                    }
                }
            }
        }
        argv.extend(opts.iter().cloned());
        argv.push("--name".into());
        argv.push(name.into());
        argv.push(image.into());
        argv.extend(args.iter().cloned());

        if deferred.is_empty() {
            self.output(argv).map(|_| ())
        } else {
            // Same argv with `create` in place of `run -d`, so the container
            // exists but is not yet running when the files land.
            argv[0] = "create".into();
            argv.remove(1); // drop -d
            self.output(&argv)?;
            for (host, container) in deferred {
                self.copy_into(name, host, container)?;
            }
            self.output(["start", name]).map(|_| ())
        }
    }

    /// Copy a host directory's *contents* into a container path.
    ///
    /// `docker cp src dst` nests when the destination already exists, so the
    /// trailing `/.` is what makes this "the files inside", not "the directory
    /// itself" — the same distinction the shell version handled by copying into
    /// the parent.
    pub fn copy_into(&self, container: &str, host: &Path, dest: &str) -> Result<(), String> {
        if !host.exists() {
            return Ok(());
        }
        // Staged through a directory named after the destination.
        //
        // slim's `cp` does not implement docker's `SRC/.` convention. It names
        // the tar entries after the source directory and unpacks them into the
        // destination's *parent*, so `cp conf container:/rathena/conf/import`
        // puts the files in /rathena/conf/conf and leaves conf/import as the
        // image shipped it. rAthena then read its own defaults and dialled
        // 127.0.0.1 for a database that lives on another host -- a silent
        // wrong answer rather than an error.
        //
        // Copying into a staging directory called `import` first makes the
        // names line up: entries are `import/...`, unpacked at /rathena/conf,
        // which is exactly where they belong.
        let dest_name = dest.rsplit('/').find(|p| !p.is_empty())
            .ok_or_else(|| format!("destination {dest} has no name"))?;
        let stage = std::env::temp_dir().join(format!("ro-cp-{}-{}", std::process::id(), dest_name));
        let _ = fs::remove_dir_all(&stage);
        let staged = stage.join(dest_name);
        copy_dir_all(host, &staged)?;

        let parent = dest.rsplit_once('/').map(|(p, _)| p).filter(|p| !p.is_empty()).unwrap_or("/");
        self.quiet(["exec", container, "mkdir", "-p", parent]);

        let mut c = self.base();
        c.current_dir(&stage);
        // Relative, so no Windows drive letter reaches the argument -- `cp`
        // splits local from container paths on a colon and `C:` looks like a
        // container to it.
        c.args(["cp", dest_name, &format!("{container}:{dest}")]);
        let out = c.output().map_err(|e| e.to_string());
        let _ = fs::remove_dir_all(&stage);
        let out = out?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "could not copy {} into {container}:{dest}: {}",
                host.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    pub fn copy_out(&self, container: &str, src: &str, host: &Path) -> Result<(), String> {
        // Same drive-letter problem in the other direction.
        let parent = host.parent().ok_or_else(|| format!("{} has no parent", host.display()))?;
        let name = host.file_name().ok_or_else(|| format!("{} has no name", host.display()))?;
        let mut c = self.base();
        c.current_dir(parent);
        c.args(["cp", &format!("{container}:{src}"), &name.to_string_lossy().to_string()]);
        let out = c.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "could not copy {container}:{src} out: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

/// True when `path` was modified more than `secs` ago, or its age is unknown.
pub fn older_than(path: &Path, secs: u64) -> bool {
    match path.metadata().and_then(|m| m.modified()) {
        Ok(t) => SystemTime::now()
            .duration_since(t)
            .map(|d| d.as_secs() > secs)
            .unwrap_or(false),
        Err(_) => true,
    }
}

/// Recursive directory copy. std has no equivalent, and the alternative is a
/// dependency for twelve lines.
fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("creating {}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| format!("reading {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let dst = to.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst)?;
        } else {
            // Symlinks are followed rather than recreated: the container needs
            // the bytes, and a link to a host path means nothing inside it.
            fs::copy(entry.path(), &dst)
                .map_err(|e| format!("copying {}: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}
