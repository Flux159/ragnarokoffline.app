//! Persisted account policy, read on every startup/repair/era switch: who may
//! create a login, and how long a character survives after it is queued for
//! deletion. Missing legacy settings retain local/LAN behavior; malformed
//! settings never silently reopen registration or drop a safeguard.
//! Internet-mode enforcement builds on this policy.
use crate::json::{self, Value};
use std::fs::File;
use std::io::Read;
use std::path::Path;

const LIMIT: u64 = 1024 * 1024;
const ERROR: &str = "Cannot read account creation policy. Repair settings.json before starting the server; registration was not enabled.";

#[cfg(test)]
fn parse(body: &str) -> Result<bool, String> {
    let settings = json::parse(body).map_err(|_| ERROR)?;
    if !settings.is_object() {
        return Err(ERROR.into());
    }
    let requested = match settings.get("open_registration") {
        None => true,
        Some(Value::Bool(value)) => *value,
        _ => return Err(ERROR.into()),
    };
    // Honour the choice at any scope. Sharing links reach the login server
    // only through an invitation-gated tunnel -- the gateway rejects a
    // WebSocket upgrade to 6900 without a current invitation cookie -- so
    // _M/_F signup here is reachable by invited friends, not the internet.
    // Hosting something larger is the case for turning it off, and that is
    // a decision the owner makes in Settings.
    Ok(requested)
}

pub fn settings(state: &Path) -> Result<Value, String> {
    let file = match File::open(state.join("settings.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Value::Object(Default::default()))
        }
        Err(_) => return Err(ERROR.into()),
    };
    let mut body = String::new();
    file.take(LIMIT + 1)
        .read_to_string(&mut body)
        .map_err(|_| ERROR)?;
    if body.len() as u64 > LIMIT {
        return Err(ERROR.into());
    }
    let value = json::parse(&body).map_err(|_| ERROR)?;
    if !value.is_object() {
        return Err(ERROR.into());
    }
    Ok(value)
}

pub fn enabled(state: &Path) -> Result<bool, String> {
    let settings = settings(state)?;
    let requested = match settings.get("open_registration") {
        None => true,
        Some(Value::Bool(value)) => *value,
        _ => return Err(ERROR.into()),
    };
    // Honour the choice at any scope. Sharing links reach the login server
    // only through an invitation-gated tunnel -- the gateway rejects a
    // WebSocket upgrade to 6900 without a current invitation cookie -- so
    // _M/_F signup here is reachable by invited friends, not the internet.
    // Hosting something larger is the case for turning it off, and that is
    // a decision the owner makes in Settings.
    Ok(requested)
}

/// rAthena's own delay before a queued character is actually removed, in
/// seconds. Named here rather than left to the shipped config, because
/// char_conf.txt is regenerated on every start and the key has to be written
/// in both directions to mean anything.
const DELETE_DELAY: u32 = 86400;

const DELETE_ERROR: &str = "Cannot read the character deletion setting. Repair settings.json before starting the server; the deletion delay was left in place.";

fn instant_deletion(settings: &Value) -> Result<bool, String> {
    match settings.get("instant_character_deletion") {
        // Absent is rAthena's own behaviour, which is also what every install
        // predating this setting has been running.
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(DELETE_ERROR.into()),
    }
}

/// Whether a character goes the moment its birthday is accepted, or a day
/// after it was queued.
///
/// The wait is worth having wherever someone else can reach the game: it is
/// the countdown on the character slot, and the chance to cancel, that turn a
/// malicious or mistaken deletion into something the player can still undo. On
/// a loopback server with one player there is nobody to undo it against, and
/// the day is only a day.
///
/// A damaged value keeps the wait rather than removing a safeguard nobody
/// asked to remove.
pub fn instant_character_deletion(state: &Path) -> Result<bool, String> {
    instant_deletion(&settings(state)?)
}

/// The character-server line for that choice. Written either way, because a
/// key left out of the regenerated config falls back to the shipped 86400 and
/// the setting would appear to do nothing in one direction only.
pub fn character_config(instant: bool) -> String {
    format!(
        "char_del_delay: {}\n",
        if instant { 0 } else { DELETE_DELAY }
    )
}

pub fn login_config(enabled: bool) -> String {
    format!(
        "new_account: {}\nacc_name_min_length: 4\npassword_min_length: 4\n",
        if enabled { "yes" } else { "no" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_owner_policy_is_preserved_alongside_other_settings() {
        assert!(!parse(r#"{"open_registration":false,"prerenewal":true}"#).unwrap());
        assert!(parse(r#"{"open_registration":true}"#).unwrap());
        assert!(parse(r#"{"prerenewal":false}"#).unwrap());
        assert!(login_config(false).starts_with("new_account: no\n"));
    }

    #[test]
    fn deletion_stays_delayed_unless_the_owner_asked_for_otherwise() {
        let read = |body: &str| instant_deletion(&json::parse(body).unwrap());
        assert!(read(r#"{"instant_character_deletion":true}"#).unwrap());
        assert!(!read(r#"{"instant_character_deletion":false}"#).unwrap());
        // Every install predating the setting, and every one that has never
        // opened it, keeps rAthena's day-long wait.
        assert!(!read(r#"{"open_registration":false}"#).unwrap());
        assert!(!read("{}").unwrap());
        // A hand-edited value is refused rather than read as "no wait".
        for value in ["\"true\"", "1", "null", "{}"] {
            assert!(read(&format!("{{\"instant_character_deletion\":{value}}}")).is_err());
        }
        // Both directions are stated, so regenerating the config cannot leave
        // the server on the shipped default while Settings says otherwise.
        assert_eq!(character_config(true), "char_del_delay: 0\n");
        assert_eq!(character_config(false), "char_del_delay: 86400\n");
    }

    #[test]
    fn corrupt_policy_never_becomes_open_registration() {
        for value in [
            "",
            "{",
            "null",
            "[]",
            r#"{"open_registration":"false"}"#,
            r#"{"open_registration":null}"#,
            r#"{"open_registration":0}"#,
        ] {
            assert!(parse(value).is_err());
        }
    }

    #[test]
    fn the_saved_preference_decides_signup_at_every_scope() {
        // Sharing a link is mostly sending it to a few friends, and the tunnel
        // already gates the login port behind an invitation, so an internet
        // scope no longer overrides the owner's choice in either direction.
        for scope in ["local", "lan", "friends", "public"] {
            assert!(parse(&format!(
                "{{\"hosting_scope\":\"{scope}\",\"open_registration\":true}}"
            ))
            .unwrap());
            assert!(!parse(&format!(
                "{{\"hosting_scope\":\"{scope}\",\"open_registration\":false}}"
            ))
            .unwrap());
            // Absent means open: a fresh install lets an invited friend sign up
            // with _M/_F without the owner having to find a setting first.
            assert!(parse(&format!("{{\"hosting_scope\":\"{scope}\"}}")).unwrap());
        }
    }
}
