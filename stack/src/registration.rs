//! Persisted login registration policy, read on every startup/repair/era switch.
//! Missing legacy settings retain local/LAN behavior; malformed settings never
//! silently reopen registration. Internet-mode enforcement builds on this policy.
use crate::json::{self, Value};
use std::fs::File;
use std::io::Read;
use std::path::Path;

const LIMIT: u64 = 1024 * 1024;
const ERROR: &str = "Cannot read account creation policy. Repair settings.json before starting the server; registration was not enabled.";

fn parse(body: &str) -> Result<bool, String> {
    let settings = json::parse(body).map_err(|_| ERROR)?;
    if !settings.is_object() {
        return Err(ERROR.into());
    }
    match settings.get("open_registration") {
        None => Ok(true),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(ERROR.into()),
    }
}

pub fn enabled(state: &Path) -> Result<bool, String> {
    let file = match File::open(state.join("settings.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(_) => return Err(ERROR.into()),
    };
    let mut body = String::new();
    file.take(LIMIT + 1)
        .read_to_string(&mut body)
        .map_err(|_| ERROR)?;
    if body.len() as u64 > LIMIT {
        return Err(ERROR.into());
    }
    parse(&body)
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
}
