//! Trusted owner account operations. No account secrets leave stdin/the DB.
//! RO's configured CA.LOGIN has 24-byte password fields: reserve the final NUL.
use crate::{
    config::Config,
    docker::Docker,
    json::{self, Value},
};
use std::io::{self, Read};

fn field<'a>(request: &'a Value, key: &str) -> Result<&'a str, String> {
    request
        .str(key)
        .ok_or_else(|| format!("Missing account field: {key}"))
}

fn hex(value: &str) -> String {
    let mut out = String::from("0x");
    for byte in value.bytes() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn unhex(value: &str) -> Result<String, String> {
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    if !remainder.is_empty() {
        return Err("Invalid account response".into());
    }
    let bytes: Result<Vec<_>, _> = pairs
        .iter()
        .map(|pair| {
            let pair = std::str::from_utf8(pair).map_err(|_| ())?;
            u8::from_str_radix(pair, 16).map_err(|_| ())
        })
        .collect();
    String::from_utf8(bytes.map_err(|_| "Invalid account response")?)
        .map_err(|_| "The account name is not valid UTF-8".into())
}

fn password(request: &Value) -> Result<&str, String> {
    let value = field(request, "password")?;
    // Printable ASCII avoids the client's character-count/UTF-8 byte-count
    // mismatch. Spaces, quotes and backslashes are supported without escaping.
    if !(8..=23).contains(&value.len()) || !value.bytes().all(|b| (32..=126).contains(&b)) {
        return Err("Use 8–23 printable ASCII characters for the game password. The pinned game login packet has a 24-byte field including its terminator.".into());
    }
    if value != field(request, "confirmation")? {
        return Err("The passwords do not match".into());
    }
    if value.bytes().all(|b| b == b' ') {
        return Err("The password cannot contain only spaces".into());
    }
    // The internet-hosting gate also rejects a password equal to the account
    // name. Enforce it here too: accepting one and then refusing to host on it
    // leaves the player changing a password that already "worked", with the
    // same refusal each time and nothing naming the real rule.
    if let Ok(name) = field(request, "username") {
        if value.eq_ignore_ascii_case(name) {
            return Err("The password cannot be the same as the account name.".into());
        }
    }
    Ok(value)
}

fn username(value: &str) -> Result<(), String> {
    if !(4..=23).contains(&value.len())
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || value.ends_with("_M")
        || value.ends_with("_F")
    {
        return Err("Use 4–23 letters, numbers, underscores or hyphens for the account name, without a registration suffix.".into());
    }
    if value.eq_ignore_ascii_case("ragnarok") || value.eq_ignore_ascii_case("s1") {
        return Err("That account name is reserved. Change an existing admin password using its account entry.".into());
    }
    Ok(())
}

fn verify_password_format(cfg: &Config) -> Result<(), String> {
    // Supported mods cannot change login configuration. Refuse hand-edited
    // imports/hash modes rather than writing plaintext into an MD5 deployment.
    let config = std::fs::read_to_string(cfg.state.join("conf/login_conf.txt"))
        .map_err(|_| "Start the server to generate its login configuration first")?;
    for line in config.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        if let Some((key, value)) = line.split_once(':') {
            let value = value.trim().to_ascii_lowercase();
            if key.trim().eq_ignore_ascii_case("import")
                || (key.trim().eq_ignore_ascii_case("use_MD5_passwords")
                    && !["no", "off", "false", "0"].contains(&value.as_str()))
            {
                return Err("Account password settings support the app's default plaintext game-password format. Custom login imports or MD5 mode require an explicit account migration.".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn verify_era(cfg: &Config, dk: &Docker, era: &str) -> Result<(), String> {
    let volume = match era {
        "renewal" => "ragnarokmac-db",
        "prerenewal" => "ragnarokmac-db-prere",
        _ => return Err("Choose a valid game era".into()),
    };
    if cfg.state.join("prerenewal").exists() != (era == "prerenewal") {
        return Err("The selected era changed. Refresh Accounts before continuing.".into());
    }
    // The settings marker alone cannot prove which DB is running after a failed
    // era switch. Inspect the actual volume, under the lifecycle operation lock.
    let inspected = dk
        .output(["inspect", "ragnarok-db"])
        .map_err(|_| "Start this era's server before managing accounts")?;
    let parsed = json::parse(&inspected).map_err(|_| "Cannot verify the running database")?;
    let Value::Array(containers) = parsed else {
        return Err("Cannot verify the running database".into());
    };
    if containers.len() != 1 {
        return Err("Cannot verify the running database".into());
    }
    let db = &containers[0];
    let running = db.get("State").and_then(|v| v.str("Status")) == Some("running");
    let mounts = match db.get("Mounts") {
        Some(Value::Array(m)) => m,
        _ => return Err("Cannot verify the running database volume".into()),
    };
    let data: Vec<_> = mounts
        .iter()
        .filter(|m| m.str("Destination") == Some("/var/lib/mysql"))
        .collect();
    if !running
        || data.len() != 1
        || data[0].str("Type") != Some("volume")
        || data[0].str("Name") != Some(volume)
    {
        return Err("The running database does not match the selected era. Start that era and refresh Accounts.".into());
    }
    Ok(())
}

fn list(dk: &Docker, era: &str) -> Result<String, String> {
    let output = dk.private_sql("SELECT account_id,HEX(userid),group_id,state,(BINARY user_pass=0x7261676e61726f6b) FROM login WHERE sex<>'S' ORDER BY account_id LIMIT 251;")?;
    let mut rows = Vec::new();
    for line in output.lines().filter(|l| !l.is_empty()) {
        let values: Vec<_> = line.split('\t').collect();
        if values.len() != 5 {
            return Err("Invalid account response".into());
        }
        for index in [0, 2, 3, 4] {
            values[index]
                .parse::<u32>()
                .map_err(|_| "Invalid account response")?;
        }
        let name = unhex(values[1])?;
        rows.push(format!(
            "{{\"id\":{},\"username\":{},\"group\":{},\"state\":{},\"defaultPassword\":{}}}",
            json::quote(values[0]),
            json::quote(&name),
            values[2],
            values[3],
            values[4] == "1"
        ));
    }
    if rows.len() > 250 {
        return Err("This panel currently supports up to 250 accounts.".into());
    }
    Ok(format!(
        "{{\"era\":{},\"accounts\":[{}]}}",
        json::quote(era),
        rows.join(",")
    ))
}

/// Stop all game sessions before writing: rAthena can save an in-memory login
/// record and overwrite a concurrent password change. Restart only the services
/// that were running. The database and all account/character IDs stay intact.
pub(crate) fn with_servers_stopped<T>(
    cfg: &Config,
    dk: &Docker,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    crate::crashes::capture_all(cfg, dk);
    let previous_start = dk.started_at("ragnarok-char");
    let mut stopped = Vec::new();
    let mut result = Ok(());
    for service in ["ragnarok-map", "ragnarok-char", "ragnarok-login"] {
        if dk.is_running(service) {
            if dk.output(["stop", service]).is_err() || dk.is_running(service) {
                result =
                    Err("Could not stop game sessions; no account update was attempted".into());
                break;
            }
            stopped.push(service);
        }
    }
    let updated = result.and_then(|_| operation());
    if crate::hosting::Scope::load(cfg, false)?.internet() {
        if let Err(error) = crate::hosting::require_game_policy(cfg, dk) {
            let outcome = match &updated { Ok(_) => "The operation completed".to_string(), Err(error) => error.clone() };
            return Err(format!("{outcome}, but game services were not restarted because internet account safeguards failed: {error}"));
        }
    }
    let mut restarted = true;
    for service in stopped.iter().rev() {
        if dk.output(["start", service]).is_err() {
            restarted = false;
        }
    }
    if restarted && stopped.len() == 3 {
        restarted = wait_for_restarted_maps(dk, previous_start.as_deref());
    }
    match updated {
        Ok(value) if restarted => Ok(value),
        Ok(_) => Err("The account was updated, but game services are not ready. Start the server to reconnect.".into()),
        Err(error) => Err(error),
    }
}

// The pinned engine uses normalized RFC3339Nano UTC for both StartedAt and log
// records. Validate before comparing; unknown timestamp formats fail closed.
fn timestamp(value: &str) -> Option<&str> {
    let stamp = value.get(..30)?;
    for (index, byte) in stamp.bytes().enumerate() {
        let expected = match index {
            4 | 7 => Some(b'-'),
            10 => Some(b'T'),
            13 | 16 => Some(b':'),
            19 => Some(b'.'),
            29 => Some(b'Z'),
            _ => None,
        };
        if expected
            .map(|e| byte != e)
            .unwrap_or(!byte.is_ascii_digit())
        {
            return None;
        }
    }
    Some(stamp)
}

fn current_ready_log(log: &str, started: &str) -> bool {
    let Some(started) = timestamp(started) else {
        return false;
    };
    let mut record_time = None;
    for line in log.lines() {
        // One JSON log record can contain several output lines; its timestamp
        // prefixes the first, and applies to subsequent lines in that record.
        if let Some(time) = timestamp(line) {
            record_time = Some(time);
        }
        if line.contains("loading complete")
            && record_time.map(|time| time >= started).unwrap_or(false)
        {
            return true;
        }
    }
    false
}

fn wait_for_restarted_maps(dk: &Docker, previous: Option<&str>) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while std::time::Instant::now() < deadline {
        if let Some(started) = dk.started_at("ragnarok-char") {
            if Some(started.as_str()) != previous
                && dk
                    .timestamped_logs("ragnarok-char")
                    .iter()
                    .any(|log| current_ready_log(log, &started))
            {
                return true;
            }
        }
        if ["ragnarok-login", "ragnarok-char", "ragnarok-map"]
            .iter()
            .any(|service| matches!(dk.state(service).as_deref(), Some("exited" | "dead")))
        {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    false
}

pub fn run(cfg: &Config, dk: &Docker) -> Result<(), String> {
    let mut input = String::new();
    io::stdin()
        .take(4097)
        .read_to_string(&mut input)
        .map_err(|_| "Cannot read account request")?;
    if input.len() > 4096 {
        return Err("Account request is too large".into());
    }
    // Parser errors can echo source characters; never surface one for secrets.
    let request = json::parse(&input).map_err(|_| "Invalid account request")?;
    let era = field(&request, "era")?;
    let action = field(&request, "action")?;
    verify_era(cfg, dk, era)?;
    dk.require_private_sql()?;
    if action == "list" {
        println!("{}", list(dk, era)?);
        return Ok(());
    }
    if action == "password" || action == "create" || action == "invite-create" {
        verify_password_format(cfg)?;
    }
    let sql = match action {
        "create" | "invite-create" => {
            let name = field(&request, "username")?;
            username(name)?;
            let pass = password(&request)?;
            format!("LOCK TABLES login WRITE, login AS existing READ; INSERT INTO login (userid,user_pass,sex,email,group_id) SELECT {},{},'M','a@a.com',0 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM login AS existing WHERE userid={}); SELECT ROW_COUNT(); UNLOCK TABLES;", hex(name), hex(pass), hex(name))
        }
        "password" | "disable" | "enable" => {
            let id = field(&request, "id")?
                .parse::<u32>()
                .map_err(|_| "Invalid account ID")?;
            let name = field(&request, "username")?;
            if id < 2000000 {
                return Err("Service accounts cannot be edited here".into());
            }
            let assignment = match action {
                "password" => format!("user_pass={}", hex(password(&request)?)),
                "disable" => "state=5".into(),
                _ => "state=0".into(),
            };
            format!("UPDATE login SET {assignment} WHERE account_id={id} AND BINARY userid={} AND sex<>'S'; SELECT ROW_COUNT();", hex(name))
        }
        _ => return Err("Unknown account action".into()),
    };
    let update = || {
        // Recheck immediately before touching any records.
        verify_era(cfg, dk, era)?;
        let output = dk.private_sql(&sql)?;
        if output.trim() != "1" {
            return Err(match action {
                "password" => "The password was not changed: the account already uses this password. Choose a different one.",
                "create" | "invite-create" => "That account name is already taken. Choose another.",
                _ => "No account changed. The account may already be in that state, or it changed elsewhere. Refresh Accounts.",
            }
            .into());
        }
        Ok(())
    };
    if action == "invite-create" {
        // The invited-player path only INSERTs a new group-0 row. It cannot
        // change a loaded account, so friends joining need not disconnect the
        // host or other players. Owner mutations retain their stop/save guard.
        if crate::hosting::Scope::load(cfg, false)? != crate::hosting::Scope::Friends {
            return Err("Invited accounts require internet friends mode".into());
        }
        crate::hosting::require_game_policy(cfg, dk)?;
        update()?;
    } else {
        with_servers_stopped(cfg, dk, update)?;
    }
    println!("{{\"era\":{},\"updated\":true}}", json::quote(era));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_readiness_rejects_retained_logs_from_previous_process() {
        let started = "2026-09-07T11:18:09.738166241Z";
        let old = "2026-09-07T11:13:18.804860894Z status\nMap-server 0 loading complete.\n";
        assert!(!current_ready_log(old, started));
        assert!(!current_ready_log(
            "Map-server 0 loading complete.\n",
            started
        ));
        let current =
            format!("{old}2026-09-07T11:18:15.142207452Z status\nMap-server 0 loading complete.\n");
        assert!(current_ready_log(&current, started));
        assert!(!current_ready_log(&current, "unknown"));
    }
    fn request(value: &str) -> Value {
        json::parse(&format!(
            "{{\"password\":{},\"confirmation\":{}}}",
            json::quote(value),
            json::quote(value)
        ))
        .unwrap()
    }
    #[test]
    fn passwords_fit_the_actual_login_packet_without_truncation() {
        for value in [
            "x".repeat(7),
            "x".repeat(24),
            "é".repeat(12),
            "\n".repeat(12),
            " ".repeat(12),
        ] {
            assert!(password(&request(&value)).is_err());
        }
        // Both ends of the accepted range, so a future bound change has to
        // move a test rather than silently widen or narrow what logs in.
        for value in ["x".repeat(8), "x".repeat(23), "quote'\\ space".into()] {
            assert_eq!(password(&request(&value)).unwrap(), value);
        }
    }
    #[test]
    fn sql_literals_cannot_change_sql_structure() {
        let attack = "'; DROP TABLE login; --\\";
        assert_eq!(unhex(&hex(attack)[2..]).unwrap(), attack);
        assert!(hex(attack)[2..].bytes().all(|b| b.is_ascii_hexdigit()));
    }
    #[test]
    fn ordinary_accounts_cannot_occupy_reserved_or_registration_names() {
        for value in ["s1", "Ragnarok", "friend_M", "friend_F", "a';--", "abc"] {
            assert!(username(value).is_err());
        }
        assert!(username("friend-123").is_ok());
    }
}
