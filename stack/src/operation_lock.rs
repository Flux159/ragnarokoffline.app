//! Serialize account writes with lifecycle and restore operations across
//! supervisor processes. Kernel locks release on crash; Repair cannot bypass it.
use std::fs::{self, File};
use std::path::Path;

pub fn acquire(state: &Path) -> Result<File, String> {
    fs::create_dir_all(state).map_err(|e| e.to_string())?;
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(state.join(".server-operation.lock"))
        .map_err(|e| e.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(fs::TryLockError::WouldBlock) => Err(
            "Another server or account operation is in progress. Wait for it to finish and retry."
                .into(),
        ),
        Err(fs::TryLockError::Error(e)) => Err(format!("Cannot lock server state: {e}")),
    }
}

#[test]
fn overlapping_operation_is_rejected_and_lock_releases_on_drop() {
    let state = std::env::temp_dir().join(format!("ro-operation-lock-{}", std::process::id()));
    let first = acquire(&state).unwrap();
    assert!(acquire(&state).is_err());
    drop(first);
    // Released -- but not always at once under `cargo test`. Another test thread that spawns a
    // process forks while `first` is open, and until that child execs, its copy of the
    // descriptor (close-on-exec only closes it at exec) still holds the flock, which belongs to
    // the shared open file. That made this fail now and then on macOS CI. Allow it a moment.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match acquire(&state) {
            Ok(again) => {
                drop(again);
                break;
            }
            Err(e) if std::time::Instant::now() >= deadline => panic!("the lock was never released: {e}"),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    std::fs::remove_dir_all(state).unwrap();
}
