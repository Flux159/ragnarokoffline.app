//! Which packet version the server and the client speak.
//!
//! Packetver is compiled into rAthena, so the image carries one build per line
//! of config/PACKETVERS: the first under the plain names (`map-server`), the
//! rest with a `-<packetver>` suffix (`map-server-20250402`). Choosing one in
//! Settings picks which binaries start and rewrites roBrowser's `packetver` to
//! match. They are one setting, not two: a client a packet version away from
//! its server disagrees about packet lengths and is disconnected at login.
//!
//! Compiled in rather than read from the runtime tree, like the image tag it
//! also names: the list describes the image this build ships with, and a
//! runtime tree that disagreed with its own supervisor would be a broken
//! install, not a choice.

use std::fs;

use crate::config::Config;
use crate::docker::Docker;
use crate::json::Value;

const LIST: &str = include_str!("../../config/PACKETVERS");

/// Every packet version in the image, the default first.
pub fn all() -> Vec<&'static str> {
    LIST.lines()
        .map(|line| line.split('#').next().unwrap_or(""))
        .filter_map(|line| line.split_whitespace().next())
        .collect()
}

/// The one a fresh install plays, and the one the image is tagged with.
pub fn default() -> &'static str {
    all().first().copied().unwrap_or("20221005")
}

/// The chosen packet version, from settings.json.
///
/// A value that is not in the list is refused rather than read as the
/// default, for the same reason game_text refuses one: the only way to get it
/// is a hand edit, or a settings.json from a build that shipped a version this
/// one does not, and quietly starting the default would look exactly like the
/// setting being ignored.
pub fn chosen(cfg: &Config) -> Result<&'static str, String> {
    const ERROR: &str = "Cannot read the client version setting. Repair settings.json before starting the server.";
    let settings = crate::registration::settings(&cfg.state).map_err(|_| ERROR)?;
    let wanted = match settings.get("packetver") {
        None | Some(Value::Null) => return Ok(default()),
        Some(Value::String(value)) => value.clone(),
        // A hand edit that wrote it as a number means the same thing.
        Some(Value::Number(value)) if value.fract() == 0.0 && *value > 0.0 => format!("{value:.0}"),
        Some(_) => return Err(ERROR.into()),
    };
    all().into_iter().find(|v| *v == wanted).ok_or_else(|| {
        format!(
            "This version of the app has no server build for client version {wanted}. Choose one of {} in Settings.",
            all().join(", ")
        )
    })
}

/// What goes after a binary's name (and after its era's `-prere`).
pub fn suffix(packetver: &str) -> String {
    if packetver == default() { String::new() } else { format!("-{packetver}") }
}

/// Which packet version a server binary was built for, from its name.
pub fn of_binary(path: &str) -> &'static str {
    all()
        .into_iter()
        .skip(1)
        .find(|v| path.ends_with(&format!("-{v}")))
        .unwrap_or_else(default)
}

/// Fail with a sentence, not a dead container, when the image has no build
/// for this version.
///
/// That happens with a local image built with `PACKETVERS=<default>` for speed,
/// or one built before the version was added to the list. The container would
/// otherwise exit at once with "no such file", which reads as a crash.
/// Checked against login-server alone: every binary for a version comes from
/// the same build step, so one missing means all of them are.
pub fn require_in_image(cfg: &Config, dk: &Docker, packetver: &str) -> Result<(), String> {
    if packetver == default() {
        return Ok(());
    }
    let cid = dk
        .output(["create", &cfg.image, "true"])
        .map_err(|e| format!("could not inspect the server image: {e}"))?;
    let cid = cid.trim();
    let probe = cfg.state.join(".packetver-probe");
    let _ = fs::remove_file(&probe);
    let found = dk.copy_out(cid, &format!("/rathena/login-server-{packetver}"), &probe).is_ok();
    dk.quiet(["rm", cid]);
    let _ = fs::remove_file(&probe);
    if found {
        Ok(())
    } else {
        Err(format!(
            "The server image has no build for client version {packetver}. Choose {} in Settings, or rebuild the image with it (config/PACKETVERS).",
            default()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str, settings: Option<&str>) -> Config {
        let root = std::env::temp_dir().join(format!("ro-packetver-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("state")).unwrap();
        if let Some(body) = settings {
            fs::write(root.join("state/settings.json"), body).unwrap();
        }
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

    #[test]
    fn the_list_is_well_formed_and_the_default_comes_first() {
        let list = all();
        assert!(!list.is_empty());
        assert_eq!(list[0], default());
        for v in &list {
            assert!(v.len() == 8 && v.bytes().all(|c| c.is_ascii_digit()), "{v}");
        }
        let mut unique = list.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), list.len(), "a packet version is listed twice");
    }

    /// rAthena reads these ranges as RagexeRE (src/config/packets.hpp), and
    /// roBrowser has only the main client's packet tables. An RE build would
    /// log in and then misparse the first packet whose length differs.
    #[test]
    fn no_listed_version_is_one_rathena_builds_as_ragexere() {
        for v in all() {
            let n: u32 = v.parse().unwrap();
            let re = (n > 20151104 && n < 20180704) || (20200902..=20211118).contains(&n);
            assert!(!re, "{v} is a RagexeRE date to rAthena");
            // Obfuscation keys and shuffled packet ids stop after 2018-03-07.
            assert!(n > 20180307, "{v} needs packet keys roBrowser does not send");
        }
    }

    #[test]
    fn an_unset_setting_is_the_default_and_the_default_has_no_suffix() {
        let cfg = fixture("unset", None);
        assert_eq!(chosen(&cfg).unwrap(), default());
        assert_eq!(suffix(default()), "");
        let _ = fs::remove_dir_all(cfg.state.parent().unwrap());
    }

    #[test]
    fn a_listed_version_is_chosen_and_suffixed() {
        let Some(other) = all().get(1).copied() else { return };
        let cfg = fixture("listed", Some(&format!("{{\"packetver\":\"{other}\"}}")));
        assert_eq!(chosen(&cfg).unwrap(), other);
        assert_eq!(suffix(other), format!("-{other}"));
        let cfg = fixture("number", Some(&format!("{{\"packetver\":{other}}}")));
        assert_eq!(chosen(&cfg).unwrap(), other);
        let _ = fs::remove_dir_all(cfg.state.parent().unwrap());
    }

    #[test]
    fn a_binary_name_says_which_build_it_is() {
        assert_eq!(of_binary("/rathena/map-server"), default());
        assert_eq!(of_binary("/rathena/map-server-prere"), default());
        for v in all().into_iter().skip(1) {
            assert_eq!(of_binary(&format!("/rathena/map-server-prere{}", suffix(v))), v);
            assert_eq!(of_binary(&format!("/rathena/login-server{}", suffix(v))), v);
        }
    }

    #[test]
    fn an_unlisted_version_is_refused_not_read_as_the_default() {
        let cfg = fixture("unlisted", Some("{\"packetver\":\"20110101\"}"));
        assert!(chosen(&cfg).unwrap_err().contains("20110101"));
        let cfg = fixture("wrongtype", Some("{\"packetver\":true}"));
        assert!(chosen(&cfg).is_err());
        let _ = fs::remove_dir_all(cfg.state.parent().unwrap());
    }
}
