//! Recoverable replacement of app-owned assets and their generated config.
//! The caller stops RemoteClient before beginning. No source client files are
//! moved or written; all staging and backups are under the app's state root.

use crate::config::Config;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Transaction {
    pub stage: PathBuf,
    destinations: Vec<PathBuf>,
    _lock: fs::File,
}

fn acquire(state: &Path) -> Result<fs::File, String> {
    fs::create_dir_all(state).map_err(|e| e.to_string())?;
    let lock = fs::File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(state.join(".asset-link.lock"))
        .map_err(|e| e.to_string())?;
    // Wait a moment before declaring the lock held. A rebuild that begins while
    // the previous one is closing its lock would otherwise be refused outright,
    // and the release of an OS lock is not always visible to the next open the
    // instant the holder's descriptor closes. A rebuild is a slow, deliberate
    // operation, so a second of patience costs nothing and removes a class of
    // spurious "another rebuild is in progress" refusals.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(fs::TryLockError::WouldBlock) => {
                return Err(
                    "another asset rebuild is in progress; wait for it to finish and retry".into(),
                )
            }
            Err(fs::TryLockError::Error(e)) => return Err(format!("cannot lock asset state: {e}")),
        }
    }
}

fn remove(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("inspecting {}: {e}", path.display())),
    }
    .map_err(|e| format!("removing app-owned {}: {e}", path.display()))
}

fn durable_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

impl Transaction {
    pub fn begin(cfg: &Config) -> Result<Self, String> {
        let lock = acquire(&cfg.state)?;
        let tx = Self {
            stage: cfg.state.join(".asset-update"),
            destinations: vec![cfg.state.join("assets"), cfg.state.join("asset-config")],
            _lock: lock,
        };
        tx.recover()?;
        fs::create_dir_all(tx.stage.join("new")).map_err(|e| e.to_string())?;
        fs::create_dir_all(tx.stage.join("old")).map_err(|e| e.to_string())?;
        Ok(tx)
    }

    pub fn path(&self, index: usize) -> PathBuf {
        self.stage.join("new").join(index.to_string())
    }

    fn recover(&self) -> Result<(), String> {
        let journal = self.stage.join("journal");
        if journal.exists() && !self.stage.join("committed").exists() {
            let body = fs::read_to_string(&journal).map_err(|e| e.to_string())?;
            let entries: Vec<_> = body.lines().collect();
            if entries.len() != self.destinations.len()
                || entries
                    .iter()
                    .any(|v| !["skip", "old", "absent"].contains(v))
            {
                return Err(format!(
                    "invalid asset recovery journal at {}; previous assets retained",
                    journal.display()
                ));
            }
            for (i, state) in entries.iter().enumerate().rev() {
                let dest = &self.destinations[i];
                let backup = self.stage.join("old").join(i.to_string());
                if *state == "old" && fs::symlink_metadata(&backup).is_ok() {
                    remove(dest)?;
                    fs::rename(&backup, dest)
                        .map_err(|e| format!("restoring {}: {e}", dest.display()))?;
                } else if *state == "absent" {
                    remove(dest)?;
                }
            }
        }
        remove(&self.stage)
    }

    pub fn commit(self) -> Result<(), String> {
        let entries: Vec<_> = self
            .destinations
            .iter()
            .enumerate()
            .map(|(i, dest)| {
                if !self.path(i).exists() {
                    "skip"
                } else if fs::symlink_metadata(dest).is_ok() {
                    "old"
                } else {
                    "absent"
                }
            })
            .collect();
        // A partial journal is never consulted: publish only after sync.
        durable_write(
            &self.stage.join("journal.tmp"),
            entries.join("\n").as_bytes(),
        )?;
        fs::rename(self.stage.join("journal.tmp"), self.stage.join("journal"))
            .map_err(|e| e.to_string())?;
        let result = (|| {
            for (i, state) in entries.iter().enumerate() {
                if *state == "skip" {
                    continue;
                }
                let dest = &self.destinations[i];
                if *state == "old" {
                    fs::rename(dest, self.stage.join("old").join(i.to_string()))
                        .map_err(|e| format!("backing up {}: {e}", dest.display()))?;
                }
                fs::rename(self.path(i), dest)
                    .map_err(|e| format!("installing {}: {e}", dest.display()))?;
            }
            durable_write(&self.stage.join("committed.tmp"), b"complete")?;
            fs::rename(
                self.stage.join("committed.tmp"),
                self.stage.join("committed"),
            )
            .map_err(|e| e.to_string())
        })();
        if let Err(error) = result {
            return match self.recover() {
                Ok(()) => Err(format!(
                    "asset update failed; previous assets restored: {error}"
                )),
                Err(recovery) => Err(format!(
                    "asset update failed: {error}; recovery required: {recovery}"
                )),
            };
        }
        // A committed journal is safe to clean on the next launch if Windows
        // antivirus temporarily holds an old file open.
        if let Err(error) = self.recover() {
            eprintln!("asset backup cleanup deferred: {error}");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Transaction {
        let root =
            std::env::temp_dir().join(format!("ro-transaction-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let tx = Transaction {
            stage: root.join(".asset-update"),
            destinations: vec![root.join("assets"), root.join("asset-config")],
            _lock: acquire(&root).unwrap(),
        };
        for dir in [tx.path(0), tx.path(1), tx.stage.join("old")] {
            fs::create_dir_all(dir).unwrap();
        }
        for dest in &tx.destinations {
            fs::create_dir_all(dest).unwrap();
            fs::write(dest.join("value"), b"previous").unwrap();
        }
        for i in 0..2 {
            fs::write(tx.path(i).join("value"), b"replacement").unwrap();
        }
        tx
    }

    #[test]
    fn interrupted_commit_restores_both_generations_and_is_repeatable() {
        // Simulate each completed rename, including interruption after all
        // replacements but before publishing the committed marker.
        for step in 0..=4 {
            let tx = fixture(&format!("interrupt-{step}"));
            durable_write(&tx.stage.join("journal"), b"old\nold").unwrap();
            for n in 0..step {
                let i = n / 2;
                if n % 2 == 0 {
                    fs::rename(
                        &tx.destinations[i],
                        tx.stage.join("old").join(i.to_string()),
                    )
                    .unwrap();
                } else {
                    fs::rename(tx.path(i), &tx.destinations[i]).unwrap();
                }
            }
            tx.recover().unwrap();
            tx.recover().unwrap();
            for dest in &tx.destinations {
                assert_eq!(fs::read(dest.join("value")).unwrap(), b"previous");
            }
            let root = tx.stage.parent().unwrap().to_path_buf();
            drop(tx);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn failed_second_install_rolls_back_the_first() {
        let mut tx = fixture("failure");
        // A missing destination parent forces an actual rename error after
        // the first complete replacement, on every supported OS.
        tx.destinations[1] = tx.stage.parent().unwrap().join("missing-parent/private");
        let root = tx.stage.parent().unwrap().to_path_buf();
        assert!(tx
            .commit()
            .unwrap_err()
            .contains("previous assets restored"));
        assert_eq!(fs::read(root.join("assets/value")).unwrap(), b"previous");
        assert!(!root.join("missing-parent/private").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_update_keeps_new_assets_and_cleans_backups() {
        let tx = fixture("success");
        let root = tx.stage.parent().unwrap().to_path_buf();
        tx.commit().unwrap();
        assert_eq!(fs::read(root.join("assets/value")).unwrap(), b"replacement");
        assert_eq!(
            fs::read(root.join("asset-config/value")).unwrap(),
            b"replacement"
        );
        assert!(!root.join(".asset-update").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn another_rebuild_cannot_enter_until_the_owner_releases_its_lock() {
        let tx = fixture("exclusive");
        let root = tx.stage.parent().unwrap().to_path_buf();
        assert!(acquire(&root).is_err());
        drop(tx);
        let next = acquire(&root).unwrap();
        drop(next);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lock_holder_child() {
        use std::io::Read;
        let Some(root) = std::env::var_os("RAGNAROK_ASSET_LOCK_TEST") else {
            return;
        };
        let _held = acquire(Path::new(&root)).unwrap();
        println!("ASSET_LOCKED");
        std::io::stdout().flush().unwrap();
        // Parent death/pipe closure also bounds a failed parent test.
        std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
    }

    #[test]
    fn process_crash_releases_the_asset_lock_without_removing_the_lock_file() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let root = std::env::temp_dir().join(format!("ro-lock-crash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "asset_transaction::tests::lock_holder_child",
                "--nocapture",
            ])
            .env("RAGNAROK_ASSET_LOCK_TEST", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let ready = std::io::BufReader::new(child.stdout.take().unwrap())
            .lines()
            .any(|line| line.unwrap().contains("ASSET_LOCKED"));
        assert!(ready);
        assert!(acquire(&root).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(root.join(".asset-link.lock").exists());
        drop(acquire(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
}
