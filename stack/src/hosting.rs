//! Mandatory game-side internet policy. A passing account check is only one
//! publication prerequisite; this module never starts or authorizes a tunnel.
use crate::{
    accounts,
    config::Config,
    docker::Docker,
    json::{self, Value},
    registration, service_credentials,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scope {
    Local,
    Lan,
    Friends,
    Public,
}

impl Scope {
    pub fn from_settings(settings: &Value, legacy_lan: bool) -> Result<Self, String> {
        let scope = match settings.get("hosting_scope") {
            None => {
                if legacy_lan {
                    Self::Lan
                } else {
                    Self::Local
                }
            }
            Some(Value::String(value)) => match value.as_str() {
                "local" => Self::Local,
                "lan" => Self::Lan,
                "friends" => Self::Friends,
                "public" => Self::Public,
                _ => return Err(
                    "Invalid hosting scope. Choose local, lan, friends or public before starting."
                        .into(),
                ),
            },
            _ => {
                return Err(
                    "Invalid hosting scope. Choose local, lan, friends or public before starting."
                        .into(),
                )
            }
        };
        if legacy_lan && settings.get("hosting_scope").is_some() && scope != Self::Lan {
            return Err("The --lan flag conflicts with the saved hosting scope. Internet modes require loopback game ports.".into());
        }
        Ok(scope)
    }
    pub fn load(cfg: &Config, legacy_lan: bool) -> Result<Self, String> {
        Self::from_settings(&registration::settings(&cfg.state)?, legacy_lan)
    }
    pub fn internet(self) -> bool {
        matches!(self, Self::Friends | Self::Public)
    }
    pub fn lan(self) -> bool {
        self == Self::Lan
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Lan => "lan",
            Self::Friends => "friends",
            Self::Public => "public",
        }
    }
}

pub fn before_start(cfg: &Config, scope: Scope) -> Result<(), String> {
    if scope.internet()
        && service_credentials::load(&cfg.state, service_credentials::era(cfg))?.is_none()
    {
        return Err("Internet hosting requires this era's managed service credentials. Start in Local mode, give each GM/admin account an 8–23 character password in Settings → Accounts, then use \"Prepare server for friends\" in Settings → Multiplayer.".into());
    }
    Ok(())
}

/// The scope a start can actually honour, and what to tell the player when it
/// is not the one they saved.
///
/// `hosting_scope` is one setting for the whole install, but the credentials
/// internet hosting needs are generated per era. So preparing renewal for
/// friends and then switching to pre-renewal left the saved scope pointing at
/// an era that was never prepared, and `before_start` refused every start --
/// including Repair, which exists to be the way out. The instructions in that
/// error go through Settings -> Accounts, which needs a running server, so
/// there was no way out at all: the server would not start until the accounts
/// were fixed, and the accounts could not be reached until the server started.
///
/// A start narrows the scope to Local for the unprepared era instead, and says
/// so. It only ever narrows -- nothing here can turn internet hosting on -- and
/// the saved setting is left alone, so going back to the prepared era goes back
/// to hosting as well.
pub fn effective_for_start(
    cfg: &Config,
    legacy_lan: bool,
) -> Result<(Scope, Option<String>), String> {
    let scope = Scope::load(cfg, legacy_lan)?;
    if !scope.internet() {
        return Ok((scope, None));
    }
    let era = service_credentials::era(cfg);
    if service_credentials::load(&cfg.state, era)?.is_some() {
        return Ok((scope, None));
    }
    Ok((
        Scope::Local,
        Some(format!(
            "{era} has not been prepared for internet hosting, so the server started in Local mode. \"{}\" is still saved and still applies to the era that was prepared. To host {era} as well, use \"Prepare server for friends\" in Settings -> Multiplayer once it is running.",
            scope.name()
        )),
    ))
}

fn unsafe_admin_count(dk: &Docker) -> Result<u32, String> {
    // Count every enabled privileged account, including renamed GMs. Also
    // cover the shipped login if its group was changed. No passwords leave SQL.
    let result = dk.private_sql("SELECT COUNT(*) FROM login WHERE sex<>'S' AND state=0 AND (group_id>0 OR LOWER(userid)='ragnarok') AND (OCTET_LENGTH(user_pass) NOT BETWEEN 8 AND 23 OR BINARY user_pass REGEXP '[^ -~]' OR TRIM(user_pass)='' OR LOWER(user_pass)=LOWER(userid));")?;
    result
        .trim()
        .parse()
        .map_err(|_| "Cannot verify enabled admin passwords".into())
}

pub fn require_admin_passwords(dk: &Docker) -> Result<(), String> {
    let count = unsafe_admin_count(dk)?;
    if count != 0 {
        return Err(format!("{count} enabled GM/admin account(s) still use a weak or default password. In Settings → Accounts, pick the account for this era and set a password of 8–23 printable ASCII characters that is not the account name; disabling the account also clears this, but you do not have to give up GM access to host. Game services remain stopped; player accounts and characters were not reset."));
    }
    Ok(())
}

fn flag(config: &str, wanted: &str) -> Result<String, String> {
    let mut found = None;
    for line in config.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let (key, value) = line
            .split_once(':')
            .ok_or("Cannot verify generated login configuration")?;
        if key.trim().eq_ignore_ascii_case("import") {
            return Err("Custom login imports need an explicit hosting audit".into());
        }
        if key.trim().eq_ignore_ascii_case(wanted) {
            found = Some(value.trim().to_ascii_lowercase());
        }
    }
    found.ok_or_else(|| {
        "The generated login policy is missing; restart the server before sharing".into()
    })
}

fn service_check(cfg: &Config, dk: &Docker) -> Result<(), String> {
    let credentials = service_credentials::load(&cfg.state, service_credentials::era(cfg))?
        .ok_or("This era's internal server credentials are not secured yet. In Settings → Multiplayer, use \"Prepare server for friends\" once; it backs up the database and rotates the internal service passwords, and it is required before any internet hosting.")?;
    if !credentials.ready {
        return Err(
            "Service credential migration is incomplete; finish startup before sharing".into(),
        );
    }
    for (name, expected) in [
        ("root.secret", credentials.root.clone()),
        ("database.secret", credentials.database.clone()),
        (
            "root.cnf",
            format!("[client]\nuser=root\npassword={}\n", credentials.root),
        ),
        (
            "database.cnf",
            format!(
                "[client]\nuser=ragnarok\npassword={}\n",
                credentials.database
            ),
        ),
    ] {
        if crate::private_fs::read(&credentials.directory.join(name), 4096)? != expected {
            return Err("Private service files do not match this era's credential journal; preserve them and recover before sharing".into());
        }
    }
    if dk.root_sql("SELECT 1;", false)?.trim() != "1" || dk.private_sql("SELECT 1;")?.trim() != "1"
    {
        return Err("Managed database credentials did not verify".into());
    }
    if dk.root_sql("SELECT 1;", true).is_ok() {
        return Err("The shared SQL root password is still accepted".into());
    }
    let matches = dk.private_sql(&format!("SELECT COUNT(*) FROM login WHERE account_id=1 AND BINARY userid='s1' AND sex='S' AND state=0 AND BINARY user_pass='{}';", credentials.interserver))?;
    if matches.trim() != "1" {
        return Err("Managed interserver credentials do not match this era's database".into());
    }
    Ok(())
}

fn require_registration(cfg: &Config) -> Result<(), String> {
    // Either answer is allowed; what matters is that the running server agrees
    // with the setting. Refusing to share whenever signup was open used to make
    // _M/_F unreachable over a link, even though the tunnel already gates the
    // login port behind an invitation.
    let wanted = registration::enabled(&cfg.state)?;
    let config = std::fs::read_to_string(cfg.state.join("conf/login_conf.txt"))
        .map_err(|_| "Cannot read generated login configuration")?;
    let running = !["no", "off", "false", "0"].contains(&flag(&config, "new_account")?.as_str());
    if running != wanted {
        return Err(format!(
            "The running server still has account creation {}, but the setting is {}. Restart the server to apply it before sharing.",
            if running { "open" } else { "owner-only" },
            if wanted { "open" } else { "owner-only" }
        ));
    }
    Ok(())
}

pub fn require_game_policy(cfg: &Config, dk: &Docker) -> Result<(), String> {
    require_registration(cfg)?;
    require_admin_passwords(dk)?;
    service_check(cfg, dk)
}

pub fn check(cfg: &Config, dk: &Docker, legacy_lan: bool) -> Result<String, String> {
    let scope = Scope::load(cfg, legacy_lan)?;
    let era = service_credentials::era(cfg);
    accounts::verify_era(cfg, dk, era)?;
    let mut rows = Vec::new();
    let mut passed = true;
    let mut add = |id: &str, result: Result<(), String>, success: &str| {
        let (ok, detail) = match result {
            Ok(()) => (true, success.to_string()),
            Err(error) => (false, error),
        };
        passed &= ok;
        rows.push(format!(
            "{{\"id\":{},\"passed\":{ok},\"detail\":{}}}",
            json::quote(id),
            json::quote(&detail)
        ));
    };
    add(
        "registration",
        require_registration(cfg),
        "Owner-only signup policy is generated",
    );
    add(
        "admin-passwords",
        require_admin_passwords(dk),
        "Enabled GM/admin passwords meet the game password requirements",
    );
    add(
        "service-credentials",
        service_check(cfg, dk),
        "This era's managed service credentials verified; shared SQL root password rejected",
    );
    // Publication stays false until the access gateway, actual listener/engine
    // bindings, privilege configuration and provider checks are integrated.
    Ok(format!("{{\"era\":{},\"scope\":{},\"accountPolicyReady\":{passed},\"publicationReady\":false,\"checks\":[{}],\"remaining\":\"Internet access protection, effective privilege and listener checks, and a validated connector are still required. No public link is enabled.\"}}", json::quote(era), json::quote(scope.name()), rows.join(",")))
}

// Verify the running containers, not just the saved LAN toggle. The gateway
// is the only origin a connector is allowed to publish.
fn bindings_safe(container: &Value, port: Option<&str>) -> bool {
    if container.get("State").and_then(|v| v.str("Status")) != Some("running") { return false; }
    let bindings = container.get("HostConfig").and_then(|v| v.get("PortBindings"));
    match (port, bindings) {
        (None, Some(Value::Null)) => true,
        (None, Some(Value::Object(values))) => values.is_empty(),
        (Some(port), Some(Value::Object(values))) if values.len() == 1 => {
            match values.get(&format!("{port}/tcp")) {
                Some(Value::Array(entries)) if entries.len() == 1 => entries[0].str("HostIp") == Some("127.0.0.1") && entries[0].str("HostPort") == Some(port),
                _ => false,
            }
        },
        _ => false,
    }
}

pub fn sharing_check(cfg: &Config, dk: &Docker) -> Result<String, String> {
    if Scope::load(cfg, false)? != Scope::Friends { return Err("Choose friends hosting before sharing".into()); }
    let era = service_credentials::era(cfg);
    accounts::verify_era(cfg, dk, era)?;
    require_game_policy(cfg, dk)?;
    let running_login = dk.output(["exec", "ragnarok-login", "cat", "/rathena/conf/import/login_conf.txt"])?;
    if flag(&running_login, "ipban_dynamic_pass_failure_ban")? != "no" {
        return Err("Restart in friends mode to apply browser login attempt protection".into());
    }
    for (name, port) in [("ragnarok-db", None), ("ragnarok-login", Some("6900")), ("ragnarok-char", Some("6121")), ("ragnarok-map", Some("5121"))] {
        let inspected = dk.output(["inspect", name])?;
        let Value::Array(values) = json::parse(&inspected).map_err(|_| "Cannot verify game listeners")? else { return Err("Cannot verify game listeners".into()); };
        if values.len() != 1 || !bindings_safe(&values[0], port) { return Err("Game listeners are not private. Restart in friends mode before sharing.".into()); }
    }
    // A mod that changes command permissions is not a reason to refuse to
    // share. The owner installed it deliberately, the app ships one of them,
    // and turning it off to hand a friend a link -- then back on afterwards --
    // is not a trade anyone asked for. Sharing says what those mods do instead;
    // see the Multiplayer section. What still holds is that only invited
    // friends reach the server at all.
    let engine = std::fs::read_to_string(cfg.nebula_home.join("config.toml")).map_err(|_| "Cannot verify engine publication settings")?;
    let public: Vec<_> = engine.lines().map(|line| line.split('#').next().unwrap_or("").trim()).filter_map(|line| line.split_once('=')).filter(|(key, _)| key.trim() == "allow_public_publish").collect();
    if public.len() != 1 || public[0].1.trim() != "false" { return Err("The engine still allows public port publication. Restart in friends mode before sharing.".into()); }
    Ok(format!("{{\"era\":{},\"backendReady\":true}}", json::quote(era)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sharing_rejects_wildcard_extra_or_stopped_bindings() {
        fn parse(text: &str) -> Value { json::parse(text).unwrap() }
        let private = r#"{"State":{"Status":"running"},"HostConfig":{"PortBindings":{"6900/tcp":[{"HostIp":"127.0.0.1","HostPort":"6900"}]}}}"#;
        assert!(bindings_safe(&parse(private), Some("6900")));
        assert!(!bindings_safe(&parse(&private.replace("127.0.0.1", "0.0.0.0")), Some("6900")));
        assert!(!bindings_safe(&parse(&private.replace("running", "exited")), Some("6900")));
        assert!(!bindings_safe(&parse(private), Some("6121")));
        assert!(!bindings_safe(&parse(private), None));
        assert!(bindings_safe(&parse(r#"{"State":{"Status":"running"},"HostConfig":{"PortBindings":{}}}"#), None));
        assert!(!bindings_safe(&parse(r#"{"State":{"Status":"running"}}"#), None));
    }

    #[test]
    fn scope_migration_never_enables_internet_implicitly() {
        let old = json::parse("{}").unwrap();
        assert_eq!(Scope::from_settings(&old, false).unwrap(), Scope::Local);
        assert_eq!(Scope::from_settings(&old, true).unwrap(), Scope::Lan);
        for name in ["local", "lan", "friends", "public"] {
            let settings =
                json::parse(&format!("{{\"hosting_scope\":{}}}", json::quote(name))).unwrap();
            let scope = Scope::from_settings(&settings, false).unwrap();
            assert_eq!(scope.name(), name);
            assert_eq!(scope.internet(), ["friends", "public"].contains(&name));
            assert_eq!(Scope::from_settings(&settings, true).is_ok(), name == "lan");
        }
    }
    fn fixture_config(name: &str) -> Config {
        let root = std::env::temp_dir().join(format!("ro-host-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("state")).unwrap();
        Config {
            root: root.join("app"),
            state: root.join("state"),
            nebula_home: root.join("nebula"),
            nebula: root.join("unused"),
            docker: root.join("unused"),
            image: String::new(),
            db_image: String::new(),
            app_version: None,
        }
    }

    // Reported by a player: prepare renewal for friends, switch to
    // pre-renewal, and the server will not start. The error told them to fix
    // it in Settings -> Accounts, which needs a running server, so there was no
    // way out -- Repair included.
    #[test]
    fn an_era_that_was_never_prepared_starts_local_instead_of_not_at_all() {
        let cfg = fixture_config("era-switch");
        std::fs::write(
            cfg.state.join("settings.json"),
            "{\"hosting_scope\":\"friends\"}",
        )
        .unwrap();
        service_credentials::prepare(&cfg).unwrap();

        // The era that was prepared is unaffected: friends hosting, no notice.
        let (scope, notice) = effective_for_start(&cfg, false).unwrap();
        assert_eq!(scope, Scope::Friends);
        assert!(notice.is_none());
        assert!(before_start(&cfg, scope).is_ok());

        // Switching era leaves the same saved scope pointing at credentials
        // that do not exist.
        std::fs::write(cfg.state.join("prerenewal"), "").unwrap();
        assert!(before_start(&cfg, Scope::Friends).is_err());

        let (scope, notice) = effective_for_start(&cfg, false).unwrap();
        assert_eq!(scope, Scope::Local);
        assert!(before_start(&cfg, scope).is_ok());
        let notice = notice.expect("a narrowed scope has to say so");
        assert!(notice.contains("prerenewal"), "{notice}");
        assert!(notice.contains("Local mode"), "{notice}");

        // Narrowing only. The setting is the player's, and going back to the
        // era they prepared goes back to hosting.
        assert!(std::fs::read_to_string(cfg.state.join("settings.json"))
            .unwrap()
            .contains("friends"));
        std::fs::remove_file(cfg.state.join("prerenewal")).unwrap();
        assert_eq!(effective_for_start(&cfg, false).unwrap().0, Scope::Friends);
    }

    #[test]
    fn narrowing_never_turns_hosting_on_and_never_hides_a_bad_setting() {
        let cfg = fixture_config("narrow-only");
        // Local stays local even with credentials sitting there.
        service_credentials::prepare(&cfg).unwrap();
        for saved in ["local", "lan"] {
            std::fs::write(
                cfg.state.join("settings.json"),
                format!("{{\"hosting_scope\":\"{saved}\"}}"),
            )
            .unwrap();
            let (scope, notice) = effective_for_start(&cfg, false).unwrap();
            assert_eq!(scope.name(), saved);
            assert!(notice.is_none());
        }
        // An unreadable scope is still a hard failure, not a quiet Local.
        std::fs::write(cfg.state.join("settings.json"), "{\"hosting_scope\":23}").unwrap();
        assert!(effective_for_start(&cfg, false).is_err());
    }

    #[test]
    fn invalid_scope_and_login_imports_fail_closed() {
        for value in ["null", "false", "23", "\"Friends\"", "\"\""] {
            let settings = json::parse(&format!("{{\"hosting_scope\":{value}}}")).unwrap();
            assert!(Scope::from_settings(&settings, false).is_err());
        }
        assert_eq!(
            flag(
                "new_account: yes\nnew_account: no // final\n",
                "new_account"
            )
            .unwrap(),
            "no"
        );
        assert!(flag("new_account: no\nimport: other.conf", "new_account").is_err());
        assert!(flag("", "new_account").is_err());
    }
}
