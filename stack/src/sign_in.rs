//! Sign in with Google or Apple, for a world shared with friends
//! (docs/FRIENDS_SHARING.md, "Sign in with Google or Apple").
//!
//! The web sign-in itself runs in the shell's friend gateway
//! (electron/sharing/oidc.js). What reaches this module is only its result: a
//! provider, the provider's stable subject id for the person, and an email the
//! provider has verified. Two tables hold the rest:
//!
//! - `app_sign_in_identities` is ours. It maps (provider, subject) and the
//!   verified email to a game account. The login server never reads it.
//! - `login_tokens` belongs to the login server (Flux159/rathena, branch
//!   `login-tokens`, src/login/login_token.cpp). After a sign-in the gateway
//!   issues a one-time token, keeps only its SHA-256 here, and the game client
//!   sends the token in place of a password. The login server accepts it once,
//!   within 60 seconds, for that account only. Its definition here must match
//!   the fork's sql-files/main.sql.
//!
//! No token ever reaches this process: it is given the hash.
use crate::{
    accounts::{field, hex, unhex, username, DEFAULT_BIRTHDATE},
    config::Config,
    docker::Docker,
    json::{self, Value},
};

/// How long an issued login token stays valid, in seconds. The client submits
/// it as soon as it is issued, so this only has to cover one login round trip.
pub const TOKEN_LIFETIME_SECONDS: u32 = 60;

/// Both tables, created if missing. Idempotent, and nothing in it is one-way:
/// it adds tables and never alters or drops one, so no backup is taken first.
/// `login_tokens` is the fork's own definition (sql-files/main.sql and
/// upgrade_20261002.sql), repeated here so a world made before the fork
/// change has it without an upgrade step.
pub const TABLES_SQL: &str = "CREATE TABLE IF NOT EXISTS `login_tokens` (
  `id` int(11) unsigned NOT NULL auto_increment,
  `account_id` int(11) unsigned NOT NULL,
  `token_hash` char(64) NOT NULL,
  `expires` datetime NOT NULL,
  `used` tinyint(1) unsigned NOT NULL default '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `token_hash` (`token_hash`),
  KEY `account_id` (`account_id`)
) ENGINE=MyISAM;
CREATE TABLE IF NOT EXISTS `app_sign_in_identities` (
  `provider` varchar(16) NOT NULL,
  `subject` varchar(255) COLLATE ascii_bin NOT NULL,
  `email` varchar(254) NOT NULL,
  `account_id` int(11) unsigned NOT NULL,
  `created` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`provider`,`subject`),
  KEY `email` (`email`),
  KEY `account_id` (`account_id`)
) ENGINE=InnoDB DEFAULT CHARSET=ascii COLLATE=ascii_general_ci;";

/// Run after `wait_for_db` and before the game servers start, like every other
/// table the app needs. One round trip; an error stops the start, because a
/// login server without its token table refuses every signed-in player.
pub fn ensure_sign_in_tables(dk: &Docker) -> Result<(), String> {
    dk.private_sql(TABLES_SQL)
        .map(|_| ())
        .map_err(|e| format!("preparing the sign-in tables: {e}"))
}

/// The account actions this module answers, all sent by the gateway through
/// `ragnarok-stack accounts` on stdin.
pub const ACTIONS: [&str; 4] = ["identity-find", "identity-create", "identity-link", "login-token"];

/// The provider's half of an identity, checked. The gateway has verified the
/// ID token; this only refuses what cannot be stored or would not be ours.
struct Identity<'a> {
    provider: &'a str,
    subject: &'a str,
    email: String,
}

fn identity(request: &Value) -> Result<Identity<'_>, String> {
    let provider = field(request, "provider")?;
    if !["google", "apple"].contains(&provider) {
        return Err("Unknown sign-in provider".into());
    }
    let subject = field(request, "subject")?;
    if subject.is_empty() || subject.len() > 255 || !subject.bytes().all(|b| (33..=126).contains(&b)) {
        return Err("Invalid sign-in subject".into());
    }
    let email = field(request, "email")?.to_ascii_lowercase();
    let at = email.find('@').unwrap_or(0);
    if email.len() > 254 || at == 0 || at + 1 >= email.len() || !email.bytes().all(|b| (33..=126).contains(&b)) {
        return Err("This sign-in has no usable email address".into());
    }
    Ok(Identity { provider, subject, email })
}

fn account_id(request: &Value) -> Result<u32, String> {
    field(request, "id")?
        .parse::<u32>()
        .ok()
        .filter(|id| *id >= 2000000)
        .ok_or_else(|| "Invalid account ID".into())
}

fn token_hash(request: &Value) -> Result<&str, String> {
    let value = field(request, "tokenHash")?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("Invalid login token".into());
    }
    Ok(value)
}

/// The SQL for one action. Every value is hex-encoded, parsed as a number, or
/// checked to be lowercase hex, so none can change the statement's structure.
/// `password` is the unusable random password a new account is given: it is
/// generated here, never shown and never sent anywhere, so the account can
/// only be entered by signing in.
pub(crate) fn statement(action: &str, request: &Value, password: &str) -> Result<String, String> {
    Ok(match action {
        // The identity's own row first; failing that, any account this email
        // is already linked to (the same person through the other provider),
        // which links this identity to it as well. Only emails a provider has
        // verified ever reach this table, so the second match cannot be a
        // stranger claiming somebody's address. `login.email`, which anyone
        // can type, is never consulted.
        "identity-find" => {
            let i = identity(request)?;
            let (p, s, e) = (hex(i.provider), hex(i.subject), hex(&i.email));
            format!(
                "INSERT IGNORE INTO app_sign_in_identities (provider,subject,email,account_id) \
                 SELECT {p},{s},{e},linked.account_id FROM app_sign_in_identities AS linked JOIN login ON login.account_id=linked.account_id AND login.sex<>'S' \
                 WHERE linked.email={e} ORDER BY linked.created LIMIT 1; \
                 SELECT login.account_id,HEX(login.userid) FROM app_sign_in_identities AS mine JOIN login ON login.account_id=mine.account_id AND login.sex<>'S' \
                 WHERE BINARY mine.provider={p} AND BINARY mine.subject={s};"
            )
        }
        // A new account for a new identity, in one locked step: the name must
        // be free, and neither the identity nor its email may be linked yet
        // (otherwise this would be a second account for the same person).
        "identity-create" => {
            let i = identity(request)?;
            let name = field(request, "username")?;
            username(name)?;
            let (p, s, e, u) = (hex(i.provider), hex(i.subject), hex(&i.email), hex(name));
            format!(
                "LOCK TABLES login WRITE, login AS existing READ, app_sign_in_identities WRITE, app_sign_in_identities AS linked READ; \
                 INSERT INTO login (userid,user_pass,sex,email,group_id,birthdate) SELECT {u},{},'M','a@a.com',0,'{DEFAULT_BIRTHDATE}' FROM DUAL \
                 WHERE NOT EXISTS (SELECT 1 FROM login AS existing WHERE existing.userid={u}) \
                 AND NOT EXISTS (SELECT 1 FROM app_sign_in_identities AS linked WHERE (BINARY linked.provider={p} AND BINARY linked.subject={s}) OR linked.email={e}); \
                 SET @made=ROW_COUNT(), @account=LAST_INSERT_ID(); \
                 INSERT INTO app_sign_in_identities (provider,subject,email,account_id) SELECT {p},{s},{e},@account FROM DUAL WHERE @made=1; \
                 SELECT @made; UNLOCK TABLES;",
                hex(password)
            )
        }
        // Link an identity to an account whose password the gateway has just
        // checked with the login server itself. Never a server account, and
        // never an email that already belongs to a different account.
        "identity-link" => {
            let i = identity(request)?;
            let name = field(request, "username")?;
            let (p, s, e, u) = (hex(i.provider), hex(i.subject), hex(&i.email), hex(name));
            format!(
                "LOCK TABLES login READ, app_sign_in_identities WRITE, app_sign_in_identities AS linked READ; \
                 INSERT INTO app_sign_in_identities (provider,subject,email,account_id) SELECT {p},{s},{e},login.account_id FROM login \
                 WHERE BINARY login.userid={u} AND login.sex<>'S' AND login.account_id>=2000000 \
                 AND NOT EXISTS (SELECT 1 FROM app_sign_in_identities AS linked WHERE (BINARY linked.provider={p} AND BINARY linked.subject={s}) OR (linked.email={e} AND linked.account_id<>login.account_id)); \
                 SELECT ROW_COUNT(); UNLOCK TABLES;"
            )
        }
        // The hash of a token the gateway has just made. Expired rows go at
        // the same time, so the table never grows. The expiry is the
        // database's own clock, which is the one the login server compares it
        // with: the host's and the VM's clocks need not agree.
        "login-token" => {
            let id = account_id(request)?;
            let hash = token_hash(request)?;
            format!(
                "DELETE FROM login_tokens WHERE expires < NOW(); \
                 INSERT INTO login_tokens (account_id,token_hash,expires) SELECT account_id,'{hash}',NOW() + INTERVAL {TOKEN_LIFETIME_SECONDS} SECOND FROM login WHERE account_id={id} AND sex<>'S'; \
                 SELECT ROW_COUNT();"
            )
        }
        _ => return Err("Unknown account action".into()),
    })
}

/// Answer one sign-in action, as JSON on stdout. Only in friends mode: these
/// exist for the gateway, and the gateway only runs while sharing. None of
/// them stops the game: each inserts into a table the servers do not cache,
/// or a brand-new login row, exactly as an invited account does.
pub fn run(cfg: &Config, dk: &Docker, action: &str, request: &Value) -> Result<String, String> {
    if crate::hosting::Scope::load(cfg, false)? != crate::hosting::Scope::Friends {
        return Err("Signing in with Google or Apple requires internet friends mode".into());
    }
    if action == "identity-create" {
        crate::hosting::require_game_policy(cfg, dk)?;
    }
    let password = if action == "identity-create" { crate::private_fs::random_token(23)? } else { String::new() };
    let sql = statement(action, request, &password)?;
    let output = dk.private_sql(&sql)?;
    let era = json::quote(field(request, "era")?);
    match action {
        "identity-find" => {
            let row = output.lines().find(|line| !line.trim().is_empty());
            let Some(row) = row else {
                return Ok(format!("{{\"era\":{era},\"found\":false}}"));
            };
            let values: Vec<_> = row.split('\t').collect();
            if values.len() != 2 || values[0].parse::<u32>().is_err() {
                return Err("Invalid account response".into());
            }
            Ok(format!(
                "{{\"era\":{era},\"found\":true,\"id\":{},\"username\":{}}}",
                json::quote(values[0]),
                json::quote(&unhex(values[1])?)
            ))
        }
        _ => {
            if output.trim() != "1" {
                return Err(match action {
                    "identity-create" => "That account name is taken, or this sign-in already has an account. Choose another name, or sign in again.",
                    "identity-link" => "That account could not be linked. It may already belong to another sign-in.",
                    _ => "That account cannot sign in.",
                }
                .into());
            }
            Ok(format!("{{\"era\":{era},\"updated\":true}}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(extra: &str) -> Value {
        json::parse(&format!(
            "{{\"era\":\"renewal\",\"provider\":\"google\",\"subject\":\"1234567890\",\"email\":\"Friend@Example.com\"{extra}}}"
        ))
        .unwrap()
    }

    #[test]
    fn the_migration_is_idempotent_and_never_one_way() {
        // Run on every start, against worlds old and new: it may only add.
        assert_eq!(TABLES_SQL.matches("CREATE TABLE IF NOT EXISTS").count(), 2);
        for word in ["DROP", "ALTER", "DELETE", "TRUNCATE", "UPDATE", "RENAME"] {
            assert!(!TABLES_SQL.to_ascii_uppercase().contains(word), "{word}");
        }
    }

    #[test]
    fn the_token_table_matches_what_the_login_server_reads() {
        // src/login/login_token.cpp in the fork selects these columns by name,
        // and only a hash ever goes in: a 64-character column, unique.
        for column in ["`account_id` int(11) unsigned NOT NULL", "`token_hash` char(64) NOT NULL", "`expires` datetime NOT NULL", "`used` tinyint(1) unsigned NOT NULL default '0'", "UNIQUE KEY `token_hash`"] {
            assert!(TABLES_SQL.contains(column), "{column}");
        }
    }

    #[test]
    fn a_token_row_holds_only_a_hash_and_expires_by_the_database_clock() {
        let hash = "a".repeat(64);
        let sql = statement("login-token", &json::parse(&format!("{{\"id\":\"2000001\",\"tokenHash\":\"{hash}\"}}")).unwrap(), "x").unwrap();
        assert!(sql.contains(&hash));
        assert!(sql.contains("NOW() + INTERVAL 60 SECOND"));
        assert!(sql.contains("DELETE FROM login_tokens WHERE expires < NOW()"));
        // Not a hash: refused rather than stored.
        for bad in ["A".repeat(64), "a".repeat(63), format!("{}'", "a".repeat(63)), "~abcdefghijklmnopqrstuv".into()] {
            let request = json::parse(&format!("{{\"id\":\"2000001\",\"tokenHash\":{}}}", json::quote(&bad))).unwrap();
            assert!(statement("login-token", &request, "x").is_err(), "{bad}");
        }
        // Server accounts (below 2000000) never get one.
        let request = json::parse(&format!("{{\"id\":\"1\",\"tokenHash\":\"{hash}\"}}")).unwrap();
        assert!(statement("login-token", &request, "x").is_err());
    }

    #[test]
    fn identities_are_stored_lowercased_and_hex_encoded() {
        let sql = statement("identity-find", &request(""), "x").unwrap();
        assert!(sql.contains(&hex("friend@example.com")));
        assert!(!sql.contains("Friend@Example.com"));
        assert!(!sql.contains("1234567890"));
        // Never by the free-text login.email column.
        assert!(!sql.contains("login.email"));
    }

    #[test]
    fn identities_that_cannot_be_trusted_or_stored_are_refused() {
        for (provider, subject, email) in [("github", "1", "a@b.c"), ("google", "", "a@b.c"), ("google", "has space", "a@b.c"), ("apple", "1", "no-at-sign"), ("apple", "1", "@example.com"), ("apple", "1", "a@"), ("apple", "1", "\u{e9}@example.com")] {
            let body = format!("{{\"provider\":{},\"subject\":{},\"email\":{}}}", json::quote(provider), json::quote(subject), json::quote(email));
            assert!(statement("identity-find", &json::parse(&body).unwrap(), "x").is_err(), "{provider} {subject} {email}");
        }
    }

    #[test]
    fn a_new_account_is_created_only_for_an_unlinked_identity_and_a_free_name() {
        let sql = statement("identity-create", &request(",\"username\":\"friend_1\""), "unusable-secret").unwrap();
        assert!(sql.contains("NOT EXISTS (SELECT 1 FROM login AS existing"));
        assert!(sql.contains("OR linked.email="));
        assert!(sql.contains(&format!("'{DEFAULT_BIRTHDATE}'")));
        assert!(sql.contains(&hex("unusable-secret")));
        assert!(!sql.contains("unusable-secret"));
        assert!(statement("identity-create", &request(",\"username\":\"ragnarok\""), "x").is_err());
        assert!(statement("identity-create", &request(",\"username\":\"new_M\""), "x").is_err());
    }

    #[test]
    fn linking_never_takes_a_server_account_or_another_accounts_email() {
        let sql = statement("identity-link", &request(",\"username\":\"friend_1\""), "x").unwrap();
        assert!(sql.contains("login.sex<>'S'"));
        assert!(sql.contains("login.account_id>=2000000"));
        assert!(sql.contains("linked.account_id<>login.account_id"));
    }
}
