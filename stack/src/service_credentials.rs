//! Durable, era-specific service credentials. Never contains player passwords.
//! The immutable journal is published before any DB mutation. A separate ready
//! marker is written only after both new SQL logins and the interserver database row verify.
use crate::{
    config::Config,
    json::{self, Value},
    private_fs,
};
use std::fs;
use std::path::{Path, PathBuf};

const ERROR: &str = "Managed service credentials are missing or damaged. Preserve the credential directory and database backup; restore them together before starting.";
pub const CONTAINER_DIR: &str = "/run/ragnarok-private";

pub struct Credentials {
    pub directory: PathBuf,
    pub root: String,
    pub database: String,
    pub interserver: String,
    pub ready: bool,
}

pub fn era(cfg: &Config) -> &'static str {
    if cfg.state.join("prerenewal").exists() {
        "prerenewal"
    } else {
        "renewal"
    }
}

pub fn directory(state: &Path, era: &str) -> PathBuf {
    state.join("private").join("service-credentials").join(era)
}

fn hex(value: Option<&str>, length: usize) -> Result<String, String> {
    let value = value.ok_or(ERROR)?;
    if value.len() != length
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(ERROR.into());
    }
    Ok(value.into())
}

fn token(value: Option<&str>) -> Result<String, String> {
    let value = value.ok_or(ERROR)?;
    // 23 base64url characters provide 138 random bits within the game field.
    if value.len() != 23
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(ERROR.into());
    }
    Ok(value.into())
}

pub fn load(state: &Path, era: &str) -> Result<Option<Credentials>, String> {
    let dir = directory(state, era);
    if !dir.exists() {
        return Ok(None);
    }
    private_fs::directory(&dir)?;
    let body = private_fs::read(&dir.join("credentials.json"), 4096).map_err(|_| ERROR)?;
    let value = json::parse(&body).map_err(|_| ERROR)?;
    if value.get("version") != Some(&Value::Number(1.0)) || value.str("era") != Some(era) {
        return Err(ERROR.into());
    }
    let ready_path = dir.join("ready");
    let ready = if ready_path.exists() {
        if private_fs::read(&ready_path, 16)? != "v1\n" {
            return Err(ERROR.into());
        }
        true
    } else {
        false
    };
    Ok(Some(Credentials {
        directory: dir,
        root: hex(value.str("root"), 64)?,
        database: hex(value.str("database"), 64)?,
        interserver: token(value.str("interserver"))?,
        ready,
    }))
}

pub fn prepare(cfg: &Config) -> Result<Credentials, String> {
    private_fs::directory(&cfg.state)?;
    for path in [
        cfg.state.join("private"),
        cfg.state.join("private/service-credentials"),
    ] {
        private_fs::directory(&path)?;
    }
    let selected = era(cfg);
    if let Some(credentials) = load(&cfg.state, selected)? {
        credentials.write_files()?;
        return Ok(credentials);
    }
    let dir = directory(&cfg.state, selected);
    let staging = cfg
        .state
        .join("private/service-credentials")
        .join(format!(".prepare-{}", private_fs::random_hex(12)?));
    private_fs::directory(&staging)?;
    let root = private_fs::random_hex(32)?;
    let database = private_fs::random_hex(32)?;
    let interserver = private_fs::random_token(23)?;
    let body = format!(
        "{{\"version\":1,\"era\":{},\"root\":{},\"database\":{},\"interserver\":{}}}\n",
        json::quote(selected),
        json::quote(&root),
        json::quote(&database),
        json::quote(&interserver)
    );
    private_fs::create(&staging.join("credentials.json"), body.as_bytes())?;
    let mut credentials = Credentials {
        directory: staging.clone(),
        root,
        database,
        interserver,
        ready: false,
    };
    credentials.write_files()?;
    fs::rename(&staging, &dir).map_err(|_| {
        "Could not publish the credential journal; no database password was changed"
    })?;
    #[cfg(unix)]
    fs::File::open(dir.parent().unwrap())
        .and_then(|file| file.sync_all())
        .map_err(|_| ERROR)?;
    credentials.directory = dir;
    Ok(credentials)
}

impl Credentials {
    /// Files are deterministic derivatives of the immutable journal. A mismatch
    /// is an error, not a reason to silently overwrite a supplied credential.
    fn file(&self, name: &str, value: &str) -> Result<(), String> {
        let path = self.directory.join(name);
        if fs::symlink_metadata(&path).is_ok() {
            if private_fs::read(&path, 4096)? != value {
                return Err(ERROR.into());
            }
            Ok(())
        } else {
            private_fs::create(&path, value.as_bytes())
        }
    }

    pub fn write_files(&self) -> Result<(), String> {
        self.file("root.secret", &self.root)?;
        self.file("database.secret", &self.database)?;
        self.file(
            "root.cnf",
            &format!("[client]\nuser=root\npassword={}\n", self.root),
        )?;
        self.file(
            "database.cnf",
            &format!("[client]\nuser=ragnarok\npassword={}\n", self.database),
        )?;
        Ok(())
    }

    pub fn mark_ready(&self) -> Result<(), String> {
        self.file("ready", "v1\n")
    }

    pub fn inter_config(&self) -> String {
        [
            "login_server",
            "ipban_db",
            "char_server",
            "map_server",
            "web_server",
            "log_db",
        ]
        .iter()
        .map(|prefix| format!("{prefix}_pw: {}\n", self.database))
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journals_are_era_bound_and_corruption_never_falls_back_to_defaults() {
        let state = std::env::temp_dir().join(format!(
            "ro-services-{}",
            private_fs::random_hex(12).unwrap()
        ));
        private_fs::directory(&state).unwrap();
        private_fs::directory(&state.join("private")).unwrap();
        private_fs::directory(&state.join("private/service-credentials")).unwrap();
        let dir = directory(&state, "renewal");
        private_fs::directory(&dir).unwrap();
        assert!(load(&state, "renewal").is_err());
        assert!(load(&state, "prerenewal").unwrap().is_none());
        let body = format!("{{\"version\":1,\"era\":\"renewal\",\"root\":\"{}\",\"database\":\"{}\",\"interserver\":\"{}\"}}", "a".repeat(64), "b".repeat(64), "c".repeat(23));
        private_fs::create(&dir.join("credentials.json"), body.as_bytes()).unwrap();
        let credentials = load(&state, "renewal").unwrap().unwrap();
        assert!(!credentials.ready);
        credentials.write_files().unwrap();
        credentials.mark_ready().unwrap();
        assert!(load(&state, "renewal").unwrap().unwrap().ready);
        assert_eq!(credentials.inter_config().lines().count(), 6);
        fs::write(dir.join("root.cnf"), "damaged").unwrap();
        assert!(credentials.write_files().is_err());
        fs::remove_dir_all(state).unwrap();
    }
}
