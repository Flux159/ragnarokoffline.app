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
    drop(acquire(&state).unwrap());
    std::fs::remove_dir_all(state).unwrap();
}
