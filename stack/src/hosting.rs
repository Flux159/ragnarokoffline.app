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
        return Err("Internet hosting requires this era's managed service credentials. Start in Local mode, change or disable the default GM password, and use Settings → Accounts → Secure internal server credentials first.".into());
    }
    Ok(())
}

fn unsafe_admin_count(dk: &Docker) -> Result<u32, String> {
    // Count every enabled privileged account, including renamed GMs. Also
    // cover the shipped login if its group was changed. No passwords leave SQL.
    let result = dk.private_sql("SELECT COUNT(*) FROM login WHERE sex<>'S' AND state=0 AND (group_id>0 OR LOWER(userid)='ragnarok') AND (OCTET_LENGTH(user_pass) NOT BETWEEN 12 AND 23 OR BINARY user_pass REGEXP '[^ -~]' OR TRIM(user_pass)='' OR LOWER(user_pass)=LOWER(userid));")?;
    result
        .trim()
        .parse()
        .map_err(|_| "Cannot verify enabled admin passwords".into())
}

pub fn require_admin_passwords(dk: &Docker) -> Result<(), String> {
    let count = unsafe_admin_count(dk)?;
    if count != 0 {
        return Err(format!("{count} enabled GM/admin account(s) need a new password or must be disabled before internet hosting. Use Settings → Accounts for this era. Game services remain stopped; player accounts and characters were not reset."));
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
        .ok_or("Secure this era's internal server credentials in Settings → Accounts")?;
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
    if registration::enabled(&cfg.state)? {
        return Err("Choose owner-only account creation and restart before sharing".into());
    }
    let config = std::fs::read_to_string(cfg.state.join("conf/login_conf.txt"))
        .map_err(|_| "Cannot read generated login configuration")?;
    if !["no", "off", "false", "0"].contains(&flag(&config, "new_account")?.as_str()) {
        return Err("The generated signup policy is still open; restart before sharing".into());
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

#[cfg(test)]
mod tests {
    use super::*;
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
