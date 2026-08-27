//! A thin wrapper over the docker client.
//!
//! It shells out to `docker-slim` rather than speaking the Engine API
//! directly. The client already handles the one thing that differs per
//! platform — on Windows there is no AF_UNIX, so it falls back to the loopback
//! TCP port nebula's WHP proxy publishes — and reimplementing an API client
//! here would mean owning that difference ourselves for no gain.

use std::ffi::OsStr;
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
        // On unix the socket lives in the instance directory. On Windows the
        // client resolves the loopback port itself from the same directory, so
        // pointing DOCKER_HOST at a unix path there would actively break it.
        if !cfg!(windows) {
            c.env(
                "DOCKER_HOST",
                format!("unix://{}", self.nebula_home.join("run/docker.sock").display()),
            );
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
        self.quiet(["exec", container, "mkdir", "-p", dest]);
        let src = format!("{}{}.", host.display(), std::path::MAIN_SEPARATOR);
        self.output(["cp", &src, &format!("{container}:{dest}")])
            .map(|_| ())
            .map_err(|e| format!("could not copy {} into {container}:{dest}: {e}", host.display()))
    }

    pub fn copy_out(&self, container: &str, src: &str, host: &Path) -> Result<(), String> {
        self.output(["cp", &format!("{container}:{src}"), &host.display().to_string()])
            .map(|_| ())
            .map_err(|e| format!("could not copy {container}:{src} out: {e}"))
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
