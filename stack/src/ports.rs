//! The host ports a world listens on, and the one place they can be changed.
//!
//! Every install uses the same five: 3338 for the asset server, 6900/6121/5121
//! for rAthena's login, char and map servers, and 7490 for the AI agent's API.
//! That is what the app has always done, and with no override set nothing here
//! changes it.
//!
//! A second world -- the agent test world in docs/AGENT_TESTING.md -- can run
//! beside the player's app only if it listens somewhere else, so each port can
//! be moved with an environment variable:
//!
//! | Variable                         | Default | What listens there            |
//! |----------------------------------|---------|-------------------------------|
//! | `RAGNAROK_OFFLINE_ASSET_PORT`    | 3338    | the asset server (RemoteClient) |
//! | `RAGNAROK_OFFLINE_LOGIN_PORT`    | 6900    | rAthena login                 |
//! | `RAGNAROK_OFFLINE_CHAR_PORT`     | 6121    | rAthena char                  |
//! | `RAGNAROK_OFFLINE_MAP_PORT`      | 5121    | rAthena map                   |
//! | `RAGNAROK_OFFLINE_AGENT_PORT`    | 7490    | the shell's AI agent API      |
//!
//! The supervisor is the only thing that parses them. The shell and the test
//! scripts ask it (`ragnarok-stack ports`) rather than read the variables a
//! second time, so there is one set of rules for what is valid.
//!
//! The rAthena ports are not a `-p host:container` remap. Login tells the
//! client which port the char server is on, and char tells it the map
//! server's, and in both cases the number is the one that server was
//! configured to *listen* on. A remap would publish 16121 and still send the
//! client to 6121 -- the other app's char server. So the servers listen on the
//! configured port inside their containers and it is published one to one.

pub const VARS: [(&str, &str); 5] = [
    ("asset", "RAGNAROK_OFFLINE_ASSET_PORT"),
    ("login", "RAGNAROK_OFFLINE_LOGIN_PORT"),
    ("char", "RAGNAROK_OFFLINE_CHAR_PORT"),
    ("map", "RAGNAROK_OFFLINE_MAP_PORT"),
    ("agent", "RAGNAROK_OFFLINE_AGENT_PORT"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ports {
    pub asset: u16,
    pub login: u16,
    pub char: u16,
    pub map: u16,
    pub agent: u16,
}

impl Ports {
    pub const DEFAULT: Ports = Ports { asset: 3338, login: 6900, char: 6121, map: 5121, agent: 7490 };

    /// From the process environment.
    pub fn from_env() -> Result<Ports, String> {
        Self::parse(|name| std::env::var(name).ok())
    }

    /// From any lookup, so the rules can be tested without touching the
    /// process environment (which tests running in parallel share).
    ///
    /// An unset or empty variable keeps the default. Anything else must be a
    /// whole number from 1024 to 65535 -- below that is a privileged port on
    /// macOS and Linux, and the servers do not run as root -- and the five
    /// must all differ, since two listeners cannot share one.
    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Ports, String> {
        let mut p = Ports::DEFAULT;
        for (key, var) in VARS {
            let Some(raw) = get(var) else { continue };
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }
            let value = raw
                .parse::<u32>()
                .ok()
                .filter(|n| (1024..=65535).contains(n))
                .ok_or_else(|| format!("{var}={raw} is not a port: use a number from 1024 to 65535"))?
                as u16;
            *p.slot(key) = value;
        }
        let all = p.named();
        for (i, (a, pa)) in all.iter().enumerate() {
            for (b, pb) in &all[i + 1..] {
                if pa == pb {
                    return Err(format!(
                        "the {a} and {b} ports are both {pa}; set {} and {} to different ports",
                        var_for(a),
                        var_for(b)
                    ));
                }
            }
        }
        Ok(p)
    }

    fn slot(&mut self, key: &str) -> &mut u16 {
        match key {
            "asset" => &mut self.asset,
            "login" => &mut self.login,
            "char" => &mut self.char,
            "map" => &mut self.map,
            _ => &mut self.agent,
        }
    }

    fn named(&self) -> [(&'static str, u16); 5] {
        [("asset", self.asset), ("login", self.login), ("char", self.char), ("map", self.map), ("agent", self.agent)]
    }

    /// `{"asset":3338,"login":6900,"char":6121,"map":5121,"agent":7490}`
    pub fn to_json(&self) -> String {
        let body: Vec<String> = self.named().iter().map(|(k, v)| format!("\"{k}\":{v}")).collect();
        format!("{{{}}}", body.join(","))
    }

    /// The lines that make rAthena listen on these ports and find its peers
    /// on them, one block per generated import file. Each server reads its
    /// own port and the port of the server it connects to:
    /// login_athena.conf `login_port`; char_athena.conf `login_port` (to
    /// reach login) and `char_port`; map_athena.conf `char_port` (to reach
    /// char) and `map_port`. The imports are read after the stock values, and
    /// rAthena keeps the last assignment.
    pub fn login_conf(&self) -> String {
        format!("login_port: {}\n", self.login)
    }
    pub fn char_conf(&self) -> String {
        format!("login_port: {}\nchar_port: {}\n", self.login, self.char)
    }
    pub fn map_conf(&self) -> String {
        format!("char_port: {}\nmap_port: {}\n", self.char, self.map)
    }
}

fn var_for(key: &str) -> &'static str {
    VARS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let owned: Vec<(String, String)> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| owned.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    /// The whole promise to every existing install: no variable, no change.
    #[test]
    fn nothing_set_is_exactly_the_ports_the_app_has_always_used() {
        let p = Ports::parse(env(&[])).unwrap();
        assert_eq!(p, Ports::DEFAULT);
        assert_eq!((p.asset, p.login, p.char, p.map, p.agent), (3338, 6900, 6121, 5121, 7490));
        assert_eq!(p.to_json(), r#"{"asset":3338,"login":6900,"char":6121,"map":5121,"agent":7490}"#);
        // Empty is unset, so `VAR= command` does not become an error.
        assert_eq!(Ports::parse(env(&[("RAGNAROK_OFFLINE_MAP_PORT", "  ")])).unwrap(), Ports::DEFAULT);
    }

    #[test]
    fn each_variable_moves_its_own_port_and_no_other() {
        let p = Ports::parse(env(&[
            ("RAGNAROK_OFFLINE_ASSET_PORT", "13338"),
            ("RAGNAROK_OFFLINE_LOGIN_PORT", "16900"),
            ("RAGNAROK_OFFLINE_CHAR_PORT", " 16121 "),
            ("RAGNAROK_OFFLINE_MAP_PORT", "15121"),
        ]))
        .unwrap();
        assert_eq!(p, Ports { asset: 13338, login: 16900, char: 16121, map: 15121, agent: 7490 });
        let only_map = Ports::parse(env(&[("RAGNAROK_OFFLINE_MAP_PORT", "15121")])).unwrap();
        assert_eq!(only_map, Ports { map: 15121, ..Ports::DEFAULT });
    }

    #[test]
    fn a_port_that_is_not_one_is_refused_by_name() {
        for bad in ["0", "80", "1023", "65536", "-1", "6900x", "abc", "1e4"] {
            let err = Ports::parse(env(&[("RAGNAROK_OFFLINE_LOGIN_PORT", bad)])).unwrap_err();
            assert!(err.contains("RAGNAROK_OFFLINE_LOGIN_PORT"), "{bad}: {err}");
        }
        assert!(Ports::parse(env(&[("RAGNAROK_OFFLINE_LOGIN_PORT", "1024")])).is_ok());
        assert!(Ports::parse(env(&[("RAGNAROK_OFFLINE_LOGIN_PORT", "65535")])).is_ok());
    }

    /// Including against a default that was left alone: moving only the char
    /// server onto 6900 collides with the login server that did not move.
    #[test]
    fn two_listeners_on_one_port_are_refused() {
        let err = Ports::parse(env(&[("RAGNAROK_OFFLINE_CHAR_PORT", "6900")])).unwrap_err();
        assert!(err.contains("RAGNAROK_OFFLINE_LOGIN_PORT") && err.contains("RAGNAROK_OFFLINE_CHAR_PORT"), "{err}");
        let err = Ports::parse(env(&[
            ("RAGNAROK_OFFLINE_ASSET_PORT", "20000"),
            ("RAGNAROK_OFFLINE_AGENT_PORT", "20000"),
        ]))
        .unwrap_err();
        assert!(err.contains("asset") && err.contains("agent"), "{err}");
    }

    #[test]
    fn each_server_is_told_its_own_port_and_its_peer_s() {
        let p = Ports { asset: 13338, login: 16900, char: 16121, map: 15121, agent: 17490 };
        assert_eq!(p.login_conf(), "login_port: 16900\n");
        assert_eq!(p.char_conf(), "login_port: 16900\nchar_port: 16121\n");
        assert_eq!(p.map_conf(), "char_port: 16121\nmap_port: 15121\n");
        // And the defaults are rAthena's own, so writing them changes nothing.
        let d = Ports::DEFAULT;
        assert_eq!(d.char_conf(), "login_port: 6900\nchar_port: 6121\n");
        assert_eq!(d.map_conf(), "char_port: 6121\nmap_port: 5121\n");
    }
}
