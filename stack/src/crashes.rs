//! Private, bounded evidence for an exited game process, before its container
//! disappears. Native traces are retained when the server emitted them.
use crate::{
    config::Config,
    docker::Docker,
    json::{self, Value},
    private_fs,
};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
const SERVERS: [&str; 3] = ["ragnarok-map", "ragnarok-char", "ragnarok-login"];
const PREFIX: &str = "incident-";
const LOG_LIMIT: usize = 128 * 1024;
const MAX_REPORT: u64 = 1024 * 1024;

fn number(value: Option<&Value>) -> Option<i32> {
    match value {
        Some(Value::Number(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 255.0 => {
            Some(*n as i32)
        }
        _ => None,
    }
}
// Container logs survive `docker start`. Classify only this process's records,
// or a later clean stop can be mistaken for an earlier captured crash.
fn current_log(log: &str, started: Option<&str>) -> String {
    let Some(started) = started.filter(|s| s.len() >= 20 && s.ends_with('Z')) else {
        return log.to_string();
    };
    let mut current = true;
    let mut output = String::new();
    for line in log.lines() {
        if let Some((stamp, _)) = line.split_once(' ') {
            if stamp.len() >= 20 && stamp.ends_with('Z') && stamp.as_bytes().get(10) == Some(&b'T')
            {
                // Compare seconds first, then fractional digits normalized to
                // nanoseconds (engine timestamps may omit the fraction).
                let key = |value: &str| {
                    let mut value = value.trim_end_matches('Z').to_string();
                    if value.len() == 19 {
                        value.push('.');
                    }
                    while value.len() < 29 {
                        value.push('0');
                    }
                    value
                };
                current = key(stamp) >= key(started);
            }
        }
        if current {
            output.push_str(line);
            output.push('\n');
        }
    }
    output
}

fn reason(state: &Value, log: &str) -> Option<&'static str> {
    if !matches!(state.str("Status"), Some("exited" | "dead")) {
        return None;
    }
    if state.get("OOMKilled") == Some(&Value::Bool(true)) {
        return Some("oom-killed");
    }
    if log.contains("Received a crash signal") || log.contains("Received another crash signal") {
        return Some("rathena-crash-signal");
    }
    match number(state.get("ExitCode")) {
        Some(0) if state.str("Status") == Some("exited") => None,
        Some(1..=255) => Some("nonzero-exit"),
        _ => Some("unknown-termination"),
    }
}
fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| {
        (h ^ *b as u64).wrapping_mul(0x100000001b3)
    })
}
fn clean(body: &str) -> String {
    // Remove CSI/OSC terminal escapes without interpreting them in the report.
    let mut out = String::new();
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' || (c == '\x1b' && chars.next() == Some('\\')) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if !c.is_control() || c == '\n' || c == '\t' {
            out.push(c);
        }
    }
    out
}
fn redact(cfg: &Config, mut body: String) -> Result<String, String> {
    for era in ["renewal", "prerenewal"] {
        let file = cfg
            .state
            .join("private/service-credentials")
            .join(era)
            .join("credentials.json");
        if !file.exists() {
            continue;
        }
        let data = private_fs::read(&file, 65536)?;
        let value = json::parse(&data)
            .map_err(|_| "Cannot redact managed credentials from crash evidence")?;
        for field in ["root", "database", "interserver"] {
            let secret = value
                .str(field)
                .filter(|v| !v.is_empty())
                .ok_or("Cannot redact managed credentials from crash evidence")?;
            body = body.replace(secret, "[redacted]");
        }
    }
    Ok(body)
}
fn prune(dir: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|_| "Cannot read crash evidence directory")? {
        let entry = entry.map_err(|_| "Cannot read crash evidence entry")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = fs::symlink_metadata(entry.path())
            .map_err(|_| "Cannot inspect crash evidence entry")?;
        if name.starts_with(PREFIX)
            && name.ends_with(".log")
            && meta.is_file()
            && !meta.file_type().is_symlink()
        {
            entries.push((name, entry.path(), meta.len()));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut bytes: u64 = entries.iter().map(|x| x.2).sum();
    let mut count = entries.len();
    for (_, path, size) in entries {
        if count <= 10 && bytes <= 10 * MAX_REPORT {
            break;
        }
        fs::remove_file(path).map_err(|_| "Cannot enforce crash evidence retention")?;
        bytes = bytes.saturating_sub(size);
        count -= 1;
    }
    Ok(())
}

pub fn capture(cfg: &Config, dk: &Docker, name: &str) -> Result<Option<String>, String> {
    if !SERVERS.contains(&name) {
        return Err("Unsupported crash evidence service".into());
    }
    let inspect = match dk.diagnostic_output(&["inspect", name], 64 * 1024) {
        Ok(value) => value,
        Err(_) => return Ok(None), // Engine stopped or container absent; never start it here.
    };
    let Value::Array(entries) =
        json::parse(&inspect).map_err(|_| "Cannot parse crash termination metadata")?
    else {
        return Err("Invalid crash termination metadata".into());
    };
    if entries.len() != 1 {
        return Err("Ambiguous crash container identity".into());
    }
    let container = &entries[0];
    let state = container
        .get("State")
        .ok_or("Missing crash termination metadata")?;
    if !matches!(state.str("Status"), Some("exited" | "dead")) {
        return Ok(None);
    }
    let id = container
        .str("Id")
        .filter(|id| !id.is_empty() && id.len() <= 128 && id.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("Invalid crash container identity")?;
    let log = dk
        .diagnostic_output(&["logs", "-t", "--tail", "400", id], LOG_LIMIT)
        .unwrap_or_else(|_| "[Log unavailable: diagnostic command failed or timed out]".into());
    let log = current_log(&log, state.str("StartedAt"));
    let Some(reason) = reason(state, &log) else {
        return Ok(None);
    };
    let key = hash(
        format!(
            "{id}:{}:{}",
            state.str("StartedAt").unwrap_or("unknown"),
            state.str("FinishedAt").unwrap_or("unknown")
        )
        .as_bytes(),
    );
    let dir = cfg.state.join("crashes");
    private_fs::directory(&dir)?;
    // Put new reports in their own directory; never prune old user artifacts.
    let dir = dir.join("reports");
    private_fs::directory(&dir)?;
    let suffix = format!("-{key:016x}.log");
    if fs::read_dir(&dir)
        .map_err(|_| "Cannot read crash evidence directory")?
        .flatten()
        .any(|e| {
            e.file_name().to_string_lossy().starts_with(PREFIX)
                && e.file_name().to_string_lossy().ends_with(&suffix)
        })
    {
        return Ok(None);
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("{PREFIX}{stamp:020}-{name}{suffix}"));
    let quote = json::quote;
    let exit = number(state.get("ExitCode"))
        .map(|n| n.to_string())
        .unwrap_or("null".into());
    let oom = match state.get("OOMKilled") {
        Some(Value::Bool(value)) => value.to_string(),
        _ => "null".into(),
    };
    let era = match fs::read_to_string(cfg.state.join(".db-volume"))
        .unwrap_or_default()
        .trim()
    {
        "ragnarokmac-db" => "renewal",
        "ragnarokmac-db-prere" => "prerenewal",
        _ => "unknown",
    };
    let trace_present = log
        .lines()
        .any(|line| line.contains("RAGNAROK_CRASH_TRACE v1 signal="))
        && log
            .lines()
            .any(|line| line.contains("RAGNAROK_CRASH_FRAME index=0x0 "));
    let trace_note = if trace_present {
        "A native original-context trace is included below; it may be partial. Use matching image debug symbols."
    } else {
        "No native fault stack was captured."
    };
    let mut report = format!("{{\"schema\":1,\"service\":{},\"container\":{},\"reason\":{},\"exitCode\":{exit},\"oomKilled\":{oom},\"era\":{},\"image\":{},\"startedAt\":{},\"finishedAt\":{},\"backtraceAvailable\":{trace_present}}}\n\nPrivate diagnostic report. Review before sharing; logs may identify players.\n{trace_note} Exit codes alone do not prove a particular signal.\n\n--- {name} ---\n{log}\n", quote(name), quote(id), quote(reason), quote(era), quote(container.str("Image").unwrap_or("unknown")), quote(state.str("StartedAt").unwrap_or("unknown")), quote(state.str("FinishedAt").unwrap_or("unknown")));
    let pin = include_str!("../../config/VENDOR_PINS")
        .lines()
        .find_map(|line| {
            let mut words = line.split_whitespace();
            (words.next() == Some("rathena"))
                .then(|| words.nth(1))
                .flatten()
        })
        .unwrap_or("unknown");
    report.push_str(&format!("\nSupervisor version: {}\nApp version: {}\nCompiled source rAthena pin: {}\nHost architecture: {}\n",
        env!("CARGO_PKG_VERSION"), cfg.app_version.as_deref().unwrap_or("unknown"), pin, std::env::consts::ARCH));
    for other in SERVERS {
        if other != name {
            report.push_str(&format!("\n--- {other} (capture-time tail) ---\n"));
            report.push_str(
                &dk.diagnostic_output(&["logs", "-t", "--tail", "100", other], LOG_LIMIT)
                    .unwrap_or_else(|_| "[Log unavailable]".into()),
            );
        }
    }
    // Whitelist operational context; never dump settings or client selections,
    // which may acquire private fields as hosting features evolve.
    if let Ok(settings) = crate::registration::settings(&cfg.state) {
        report.push_str("\nCapture-time settings (not necessarily fault-time settings):\n");
        for key in [
            "population_enable",
            "population_max",
            "population_density",
            "prerenewal",
            "instant_character_deletion",
        ] {
            match settings.get(key) {
                Some(Value::Bool(v)) => report.push_str(&format!("{key}: {v}\n")),
                Some(Value::Number(v)) if v.is_finite() => {
                    report.push_str(&format!("{key}: {v}\n"))
                }
                _ => {}
            }
        }
    }
    let packet = include_str!("../../scripts/bootstrap.sh")
        .lines()
        .find_map(|line| line.strip_prefix("PACKETVER="))
        .filter(|value| value.bytes().all(|c| c.is_ascii_digit()))
        .unwrap_or("unknown");
    report.push_str(&format!("Compiled packet version: {packet}\n"));
    if let Ok(overlay) = fs::read_to_string(cfg.state.join("assets/overlay.id")) {
        if overlay.len() <= 128 && overlay.trim().bytes().all(|c| c.is_ascii_hexdigit()) {
            report.push_str(&format!("Capture-time asset overlay: {}\n", overlay.trim()));
        }
    }
    report = redact(cfg, clean(&report))?;
    if report.len() as u64 > MAX_REPORT {
        return Err("Crash evidence exceeds its size limit".into());
    }
    private_fs::create(&path, report.as_bytes())?;
    prune(&dir)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub fn capture_all(cfg: &Config, dk: &Docker) {
    for service in SERVERS {
        match capture(cfg, dk, service) {
            Ok(Some(path)) => eprintln!("{service} stopped unexpectedly; private evidence saved at {path}"),
            Err(_) => eprintln!("Could not preserve {service} crash evidence; check private directory permissions and free space"),
            Ok(None) => {},
        }
    }
}

pub fn command(cfg: &Config, dk: &Docker) -> Result<(), String> {
    for service in SERVERS {
        if let Some(path) = capture(cfg, dk, service)? {
            println!("{service} stopped unexpectedly; private evidence saved at {path}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_exit_metadata_without_inventing_a_signal() {
        let state = |status, code, oom| {
            json::parse(&format!(
                "{{\"Status\":\"{status}\",\"ExitCode\":{code},\"OOMKilled\":{oom}}}"
            ))
            .unwrap()
        };
        assert_eq!(
            reason(&state("running", 139, false), "Received a crash signal"),
            None
        );
        assert_eq!(reason(&state("exited", 0, false), "Finished"), None);
        assert_eq!(
            reason(&state("exited", 0, false), "Received a crash signal"),
            Some("rathena-crash-signal")
        );
        assert_eq!(
            reason(&state("exited", 139, false), ""),
            Some("nonzero-exit")
        );
        assert_eq!(reason(&state("exited", 137, true), ""), Some("oom-killed"));
        assert_eq!(
            reason(&state("dead", 0, false), ""),
            Some("unknown-termination")
        );
        assert_eq!(
            reason(&json::parse("{\"Status\":\"exited\"}").unwrap(), ""),
            Some("unknown-termination")
        );
    }
    #[test]
    fn retained_faults_do_not_reclassify_a_later_clean_stop() {
        let log = "2026-09-07T01:00:00.000000001Z Received a crash signal\nold frame\n2026-09-07T02:00:00Z Finished\n";
        let current = current_log(log, Some("2026-09-07T02:00:00.000000000Z"));
        assert!(!current.contains("crash signal"));
        assert!(!current.contains("old frame"));
        assert!(current.contains("Finished"));
        let state = json::parse("{\"Status\":\"exited\",\"ExitCode\":0}").unwrap();
        assert_eq!(reason(&state, &current), None);
        assert!(current_log(log, None).contains("crash signal"));
    }
    #[test]
    fn strips_terminal_control_sequences() {
        assert_eq!(
            clean("\x1b[31mFatal\x1b[0m\n\x1b]0;title\x07next\r\0"),
            "Fatal\nnext"
        );
    }
    #[test]
    fn retention_preserves_unrelated_files_and_keeps_ten_reports() {
        let root = std::env::temp_dir().join(format!(
            "ro-crash-test-{}",
            private_fs::random_hex(8).unwrap()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("user-notes.log"), "keep").unwrap();
        for n in 0..12 {
            fs::write(root.join(format!("incident-{n:020}.log")), "report").unwrap();
        }
        prune(&root).unwrap();
        assert!(root.join("user-notes.log").exists());
        assert!(!root.join("incident-00000000000000000001.log").exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 11);
        fs::remove_dir_all(root).unwrap();
    }
}
