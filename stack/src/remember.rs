//! Remembered logins: "keep me signed in" for the game, for the autologin mod
//! (mods/autologin).
//!
//! A remembered login is a random credential that stands in for the account
//! until it is revoked. It is never a password and never becomes one: at each
//! launch it is exchanged for a fresh one-time login token (sign_in.rs,
//! `login_tokens`, the fork's src/login/login_token.cpp), which the client
//! sends in place of a password, once, within 60 seconds.
//!
//! What this process sees is only hashes. The shell makes the credential and
//! the token (electron/remember-login.js), keeps the credential where the page
//! cannot read it -- a file of the app's own for the host's window, an
//! HttpOnly cookie for a friend through the gateway -- and sends the SHA-256 of
//! each here.
//!
//! - **Issuing** needs proof that the page asking is logged in to that account
//!   right now, without a password. That is rAthena's own web auth token: the
//!   login server writes a fresh random one to `login.web_auth_token` on every
//!   login, enables it while the account is online, and hands it to the client
//!   in the login answer (packet versions from 2017-03-15, which is every one
//!   this app offers). rAthena's web server accepts the same pair as proof of
//!   an account (src/web/auth.cpp), so this accepts nothing it does not.
//! - **Exchanging** finds the credential's account and writes a login token
//!   for it, only while the account is not disabled. Each exchange moves the
//!   credential's expiry: it lapses after `IDLE_DAYS` unused.
//! - **Revoking** deletes the row. The mod revokes on "Exit" to the login
//!   screen; changing an account's password or disabling it in Settings ->
//!   Accounts revokes every remembered login it has (accounts.rs).
use crate::{
    accounts::{field, hex, unhex},
    docker::Docker,
    json::{self, Value},
};

/// Days a remembered login lasts without being used.
pub const IDLE_DAYS: u32 = 30;

/// Created if missing on every start, like the sign-in tables. Only adds.
pub const TABLE_SQL: &str = "CREATE TABLE IF NOT EXISTS `app_remembered_logins` (
  `credential_hash` char(64) NOT NULL,
  `account_id` int(11) unsigned NOT NULL,
  `created` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`credential_hash`),
  KEY `account_id` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_bin;";

/// After `ensure_sign_in_tables`, which makes `login_tokens`, and before the
/// game servers start.
pub fn ensure_remember_table(dk: &Docker) -> Result<(), String> {
    dk.private_sql(TABLE_SQL)
        .map(|_| ())
        .map_err(|e| format!("preparing the remembered-login table: {e}"))
}

/// What revokes every remembered login of one account: a password change or
/// disabling it. `id` has already been parsed as a number.
pub fn revoke_account_sql(id: u32) -> String {
    format!("DELETE FROM app_remembered_logins WHERE account_id={id};")
}

pub const ACTIONS: [&str; 3] = ["remember-issue", "remember-resume", "remember-forget"];

fn sha256_hex<'a>(request: &'a Value, key: &str) -> Result<&'a str, String> {
    let value = field(request, key)?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("Invalid remembered login".into());
    }
    Ok(value)
}

/// rAthena makes it from SHA2/MD5 hex (account.cpp), 16 characters; accept
/// what its column can hold and nothing that is not letters and digits.
fn web_token(request: &Value) -> Result<&str, String> {
    let value = field(request, "webToken")?;
    if !(8..=16).contains(&value.len()) || !value.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("This login cannot be remembered: the game server did not give the client a session token".into());
    }
    Ok(value)
}

fn account_id(request: &Value) -> Result<u32, String> {
    field(request, "id")?
        .parse::<u32>()
        .ok()
        .filter(|id| *id >= 2000000)
        .ok_or_else(|| "Invalid account ID".into())
}

/// The SQL for one action. Every value is a parsed number, checked lowercase
/// hex, or hex-encoded, so none can change the statement's structure. Each
/// ends in a SELECT whose rows are the answer: the account name, hex-encoded,
/// or nothing.
pub(crate) fn statement(action: &str, request: &Value) -> Result<String, String> {
    let expired = format!("DELETE FROM app_remembered_logins WHERE last_used < NOW() - INTERVAL {IDLE_DAYS} DAY;");
    Ok(match action {
        // Only for the account the page is logged in to now. `replaces` is the
        // credential this one supersedes in the same store, revoked once the
        // new one exists -- and only then, so a refused request leaves the
        // old one working -- so remembering again never leaves one behind.
        "remember-issue" => {
            let id = account_id(request)?;
            let token = hex(web_token(request)?);
            let hash = sha256_hex(request, "credentialHash")?;
            let replaces = match request.str("replacesHash") {
                Some(_) => format!("DELETE FROM app_remembered_logins WHERE credential_hash='{}' AND @made=1;", sha256_hex(request, "replacesHash")?),
                None => String::new(),
            };
            format!(
                "{expired} \
                 INSERT INTO app_remembered_logins (credential_hash,account_id) SELECT '{hash}',account_id FROM login \
                 WHERE account_id={id} AND sex<>'S' AND state=0 AND web_auth_token_enabled='1' AND BINARY web_auth_token={token}; \
                 SET @made=ROW_COUNT(); {replaces} \
                 SELECT HEX(login.userid) FROM app_remembered_logins AS r JOIN login ON login.account_id=r.account_id WHERE r.credential_hash='{hash}';"
            )
        }
        // A one-time login token for the credential's account, by the
        // database's clock (the one the login server compares with).
        "remember-resume" => {
            let hash = sha256_hex(request, "credentialHash")?;
            let token = sha256_hex(request, "tokenHash")?;
            let lifetime = crate::sign_in::TOKEN_LIFETIME_SECONDS;
            format!(
                "{expired} DELETE FROM login_tokens WHERE expires < NOW(); \
                 INSERT INTO login_tokens (account_id,token_hash,expires) SELECT login.account_id,'{token}',NOW() + INTERVAL {lifetime} SECOND \
                 FROM app_remembered_logins AS r JOIN login ON login.account_id=r.account_id AND login.sex<>'S' AND login.state=0 \
                 WHERE r.credential_hash='{hash}'; \
                 UPDATE app_remembered_logins SET last_used=NOW() WHERE credential_hash='{hash}'; \
                 SELECT HEX(login.userid) FROM login_tokens AS t JOIN login ON login.account_id=t.account_id WHERE t.token_hash='{token}';"
            )
        }
        "remember-forget" => {
            let hash = sha256_hex(request, "credentialHash")?;
            format!("{expired} DELETE FROM app_remembered_logins WHERE credential_hash='{hash}'; SELECT 1;")
        }
        _ => return Err("Unknown account action".into()),
    })
}

/// Answer one action as JSON. Any mode: the host's own window uses these
/// without friends sharing. None stops the game -- the servers do not cache
/// either table.
pub fn run(dk: &Docker, action: &str, request: &Value) -> Result<String, String> {
    let sql = statement(action, request)?;
    let output = dk.private_sql(&sql)?;
    let era = json::quote(field(request, "era")?);
    if action == "remember-forget" {
        return Ok(format!("{{\"era\":{era},\"forgotten\":true}}"));
    }
    let name = output.lines().map(str::trim).find(|line| !line.is_empty());
    match name {
        Some(name) => Ok(format!("{{\"era\":{era},\"username\":{}}}", json::quote(&unhex(name)?))),
        None if action == "remember-issue" => Err("This login could not be remembered: the game server no longer has this session. Log in again.".into()),
        // The words the mod shows. Revoked, lapsed, the account disabled or
        // deleted: to the player all of these mean the same thing.
        None => Err("The remembered login is no longer valid. Log in again.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(body: &str) -> Value {
        json::parse(body).unwrap()
    }
    const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn the_migration_only_adds() {
        assert_eq!(TABLE_SQL.matches("CREATE TABLE IF NOT EXISTS").count(), 1);
        for word in ["DROP", "ALTER", "DELETE", "TRUNCATE", "UPDATE", "RENAME"] {
            assert!(!TABLE_SQL.to_ascii_uppercase().contains(word), "{word}");
        }
        // Only a hash is ever stored, and it is the key.
        assert!(TABLE_SQL.contains("`credential_hash` char(64) NOT NULL"));
        assert!(TABLE_SQL.contains("PRIMARY KEY (`credential_hash`)"));
    }

    #[test]
    fn issuing_needs_the_live_web_session_of_that_very_account() {
        let sql = statement("remember-issue", &request(&format!("{{\"id\":\"2000001\",\"webToken\":\"a1b2c3d4e5f60718\",\"credentialHash\":\"{H}\"}}"))).unwrap();
        assert!(sql.contains("account_id=2000001"));
        assert!(sql.contains("web_auth_token_enabled='1'"));
        assert!(sql.contains(&format!("BINARY web_auth_token={}", hex("a1b2c3d4e5f60718"))));
        assert!(sql.contains("state=0") && sql.contains("sex<>'S'"));
        // The web token goes in hex-encoded, never as text.
        assert!(!sql.contains("'a1b2c3d4e5f60718'"));
        // No replaced credential, nothing else deleted but the lapsed ones.
        assert_eq!(sql.matches("DELETE").count(), 1);
    }

    #[test]
    fn remembering_again_revokes_the_one_it_replaces() {
        let other = "f".repeat(64);
        let sql = statement("remember-issue", &request(&format!("{{\"id\":\"2000001\",\"webToken\":\"a1b2c3d4e5f60718\",\"credentialHash\":\"{H}\",\"replacesHash\":\"{other}\"}}"))).unwrap();
        assert!(sql.contains(&format!("DELETE FROM app_remembered_logins WHERE credential_hash='{other}' AND @made=1;")));
        // Only after the new one is in.
        assert!(sql.find("SET @made=ROW_COUNT()").unwrap() < sql.find(&other).unwrap());
        let bad = statement("remember-issue", &request(&format!("{{\"id\":\"2000001\",\"webToken\":\"a1b2c3d4e5f60718\",\"credentialHash\":\"{H}\",\"replacesHash\":\"x' OR 1=1 -- \"}}")));
        assert!(bad.is_err());
    }

    #[test]
    fn nothing_that_is_not_a_hash_a_number_or_a_token_gets_in() {
        for (id, web, hash) in [
            ("1", "a1b2c3d4e5f60718", H.to_string()),            // a server account
            ("2000001x", "a1b2c3d4e5f60718", H.to_string()),
            ("2000001", "", H.to_string()),                       // no web token (old packet version)
            ("2000001", "a1b2c3d4'--", H.to_string()),
            ("2000001", "a1b2c3d4e5f60718", H.to_uppercase()),
            ("2000001", "a1b2c3d4e5f60718", "~abcdefghijklmnopqrstuv".into()),
        ] {
            let body = format!("{{\"id\":{},\"webToken\":{},\"credentialHash\":{}}}", json::quote(id), json::quote(web), json::quote(&hash));
            assert!(statement("remember-issue", &request(&body)).is_err(), "{id} {web} {hash}");
        }
        assert!(statement("remember-resume", &request(&format!("{{\"credentialHash\":\"{H}\",\"tokenHash\":\"nope\"}}"))).is_err());
        assert!(statement("remember-forget", &request("{\"credentialHash\":\"' OR 1=1\"}")).is_err());
        assert!(statement("remember-everything", &request("{}")).is_err());
    }

    #[test]
    fn a_resume_writes_a_sixty_second_token_only_for_a_usable_account() {
        let token = "b".repeat(64);
        let sql = statement("remember-resume", &request(&format!("{{\"credentialHash\":\"{H}\",\"tokenHash\":\"{token}\"}}"))).unwrap();
        assert!(sql.contains("INSERT INTO login_tokens"));
        assert!(sql.contains("NOW() + INTERVAL 60 SECOND"));
        assert!(sql.contains("login.state=0"));
        assert!(sql.contains(&format!("WHERE r.credential_hash='{H}'")));
        // Lapsed credentials and expired tokens go first; use moves the expiry.
        assert!(sql.find("INTERVAL 30 DAY").unwrap() < sql.find("INSERT").unwrap());
        assert!(sql.contains("SET last_used=NOW()"));
        // The answer is the account name of the token just written, or nothing.
        assert!(sql.trim_end().ends_with(&format!("WHERE t.token_hash='{token}';")));
    }

    #[test]
    fn revoking_an_account_reaches_every_credential_it_has() {
        assert_eq!(revoke_account_sql(2000001), "DELETE FROM app_remembered_logins WHERE account_id=2000001;");
    }
}
