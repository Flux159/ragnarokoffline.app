//! The stack commands themselves.

use crate::config::{data_root, home, lan_ip, Config, DB_CONTAINER, NET, SERVERS};
use crate::docker::{older_than, Docker, Mount};
// Every use of it is Windows-only; the module itself is not.
#[cfg(windows)]
use crate::host;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

/// First launch spends minutes in half a dozen distinct steps. The boot window
/// used to show one unchanging line for all of it, so a hang was
/// indistinguishable from slow. Each step names itself here; the app polls this
/// file and shows the last line.
pub fn phase(cfg: &Config, msg: &str) {
    let _ = fs::create_dir_all(&cfg.state);
    let _ = fs::write(cfg.state.join("phase"), format!("{msg}\n"));
    println!("{msg}");
}

/// Only one up/down at a time. The app can start the stack from the boot page
/// and from Settings and tears it down on quit, so invocations overlap; when
/// they do, both remove the containers and then both try to create them, and
/// the loser fails with "container name is already in use".
///
/// Retained for compatibility with older supervisors. main.rs also takes a
/// kernel file lock covering accounts, lifecycle, backup and restore; Repair
/// may clear this legacy directory but cannot break that live operation lock.
pub struct Lock(PathBuf);

impl Lock {
    pub fn acquire(cfg: &Config) -> Result<Lock, String> {
        let dir = cfg.lock_dir();
        let _ = fs::create_dir_all(&cfg.state);
        for _ in 0..120 {
            match fs::create_dir(&dir) {
                Ok(_) => return Ok(Lock(dir)),
                Err(_) => {
                    // A lock older than two minutes is a crashed run, not a
                    // live one.
                    if older_than(&dir, 120) {
                        let _ = fs::remove_dir_all(&dir);
                        continue;
                    }
                    sleep(Duration::from_secs(1));
                }
            }
        }
        Err("timed out waiting for another start/stop to finish".into())
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_conf(dir: &Path, name: &str, body: &str) -> Result<(), String> {
    fs::write(dir.join(name), body).map_err(|e| format!("writing {name}: {e}"))
}

/// A cheap content fingerprint of the shipped guest images.
///
/// FNV-1a over the bytes: no dependency, and fast enough on ~25 MB that it is
/// not worth being cleverer. Size alone would miss a rebuild that kept the
/// same length, and mtime changes every time the payload is copied, which
/// would reinstall the images on every launch.
fn guest_fingerprint(paths: &[&Path]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for p in paths {
        if let Ok(bytes) = fs::read(p) {
            for b in bytes {
                hash ^= b as u64;
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
    }
    format!("{hash:016x}")
}

/// Set a top-level key in nebula's config.toml, reporting whether it changed.
///
/// Inserted before the first table header rather than appended: a key written
/// after a `[section]` line belongs to that section, and would be silently
/// ignored as a top-level setting. The file we ship has no tables today, which
/// is exactly the kind of assumption that stops being true quietly.
fn set_engine_flag(path: &Path, key: &str, value: bool) -> Result<bool, String> {
    set_engine_value(path, key, &value.to_string())
}

/// The same, for a value that is not a boolean. TOML wants bare numbers and
/// bare `true`/`false` alike, so the caller hands us the rendered literal.
fn set_engine_value(path: &Path, key: &str, value: &str) -> Result<bool, String> {
    let line = format!("{key} = {value}");
    let existing = fs::read_to_string(path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == line) {
        return Ok(false);
    }
    let mut out: Vec<String> = Vec::new();
    let mut placed = false;
    for l in existing.lines() {
        if l.trim_start().starts_with(&format!("{key} ")) || l.trim_start().starts_with(&format!("{key}=")) {
            out.push(line.clone());
            placed = true;
        } else {
            if !placed && l.trim_start().starts_with('[') {
                out.push(line.clone());
                placed = true;
            }
            out.push(l.to_string());
        }
    }
    if !placed {
        out.push(line);
    }
    fs::write(path, out.join("\n") + "\n").map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(true)
}

/// A fresh machine has no guest kernel or rootfs and no running engine. Both
/// ship with the app, so neither needs the network.
fn ensure_engine(cfg: &Config, dk: &Docker, lan: bool, ram_mib: Option<u32>) -> Result<(), String> {
    let _ = fs::create_dir_all(&cfg.nebula_home);
    // Must be in place before the first `up`: nebula reads it when it creates
    // the instance, and the ports in it are what keep this engine from
    // colliding with a standalone nebula install on the same machine.
    let cfg_toml = cfg.nebula_home.join("config.toml");
    let shipped = cfg.root.join("config/nebula.toml");
    if !cfg_toml.exists() && shipped.exists() {
        let _ = fs::copy(&shipped, &cfg_toml);
    }
    if !cfg.nebula.exists() {
        return Err(format!("nebula engine not found at {}", cfg.nebula.display()));
    }

    // nebula binds published ports to 127.0.0.1 unless this is on, so LAN
    // hosting needs it -- and it is off by default there for the same reason
    // it is off by default here: exposing a guest's ports to the network is a
    // decision, not a detail.
    //
    // nebulad reads it once, at startup. Changing it under a running engine
    // does nothing, and the symptom is a LAN switch that appears to work and
    // silently does not, so a change restarts the engine.
    let mut changed = set_engine_flag(&cfg_toml, "allow_public_publish", lan)?;

    // How much memory the VM may use. None means "whatever config.toml already
    // says", so a plain `up` from a terminal, and an install whose client.json
    // predates this setting, both keep the shipped default.
    //
    // Read at guest boot like allow_public_publish, so a change here restarts
    // the engine too -- otherwise the slider moves and nothing happens.
    if let Some(mib) = ram_mib {
        // Floor rather than trust: rAthena's map server alone sits around
        // 435 MiB before a single shell exists, and a guest that cannot start
        // is a worse outcome than ignoring a silly number.
        let mib = mib.clamp(2048, 65536);
        changed |= set_engine_value(&cfg_toml, "max_ram_mib", &mib.to_string())?;
    }

    if changed && dk.quiet(["ps"]) {
        phase(cfg, "Restarting the virtual machine to apply the change…");
        let _ = nebula(cfg, &["down"]);
        // Two seconds was a guess at how long the engine takes to leave, and
        // on Windows it was wrong by minutes (#119).
        wait_for_engine_exit(cfg, ENGINE_DEPART_BUDGET);
    }

    // Install the guest images when they are missing *or* when the ones we
    // ship differ from the ones installed.
    //
    // This used to install only when the files were absent, so an instance
    // created once was pinned to that engine forever: a new app version could
    // ship a newer kernel and rootfs and they would never be installed. The
    // guest rootfs contains slimd, so an engine bug fixed upstream stayed
    // broken on every machine that had already run the app once -- and the
    // symptom was that a release "fixing" something changed nothing at all.
    //
    // Upgrading the engine is the normal case for anyone embedding nebula, not
    // an edge case; being unable to is a defect.
    let kernel = cfg.nebula_home.join("kernel/Image");
    let rootfs = cfg.nebula_home.join("images/rootfs-pristine.img");
    let k = cfg.root.join("guest/Image.gz");
    let r = cfg.root.join("guest/rootfs.img.gz");
    if k.exists() && r.exists() {
        let shipped = guest_fingerprint(&[&k, &r]);
        let marker = cfg.nebula_home.join(".guest-images");
        let installed = fs::read_to_string(&marker).unwrap_or_default();
        let missing = !kernel.exists() || !rootfs.exists();
        if missing || installed.trim() != shipped {
            phase(cfg, if missing {
                "Installing the virtual machine image… (first run only)"
            } else {
                "Updating the virtual machine image…"
            });
            // Stop the engine first: nebula refuses to install an image while
            // it is running, and nebulad deliberately outlives the app so the
            // next launch is quick. Those two together mean an upgrade that
            // ships a new kernel or rootfs fails on the very machines that
            // have run the app before -- "Updating the virtual machine
            // image..." and then "the engine is running - stop it first",
            // which no amount of restarting the app can clear because the app
            // is what leaves it running.
            //
            // Only on the path that is about to install. A start that has
            // nothing to update leaves a healthy engine alone, which is the
            // whole point of it outliving us.
            let _ = nebula(cfg, &["down"]);
            // Until the daemon is gone, not until its VM stops saying
            // "running": install-image refuses while any daemon is there, and
            // a departing one says "failed" or "stopped" long before it exits.
            wait_for_engine_exit(cfg, ENGINE_DEPART_BUDGET);
            nebula(cfg, &["install-image",
                "--kernel", &k.display().to_string(),
                "--rootfs", &r.display().to_string()])
                .map_err(|e| {
                    #[cfg(windows)]
                    if is_app_control_block(&e) {
                        return host::app_control_help(&e);
                    }
                    e
                })?;
            // Only after a successful install: a marker written first would
            // convince the next run that a failed upgrade had happened.
            let _ = fs::write(&marker, &shipped);
        }
    }
    // `nebula up` is a no-op when the engine is already healthy, so a failure
    // here is a failure to start -- worth stopping for, and worth explaining.
    // Smart App Control refuses unsigned binaries at load, and the refusal looks
    // like a missing DLL -- so ask Windows what mode it is in rather than
    // waiting to misread the failure. Only when our own binary is genuinely
    // unsigned: once signing lands this goes quiet on its own.
    #[cfg(windows)]
    if host::app_control_blocks(&cfg.nebula) {
        return Err(host::app_control_help(
            "Smart App Control is enforcing, and this app is not signed yet",
        ));
    }
    // Same reasoning: check the condition rather than read it back out of a
    // failure that cannot be told apart from three other causes.
    #[cfg(windows)]
    if vc_runtime_missing() {
        return Err(vc_runtime_help(
            "The Microsoft Visual C++ runtime is missing",
        ));
    }
    // Same again: ask the condition rather than read it out of a failure that
    // arrives twenty seconds later as "agent did not become healthy", with the
    // real reason logged by libkrun and thrown away.
    #[cfg(windows)]
    if host::whp_capability() == Some(false) {
        return Err(host::blocked_help());
    }

    // Before starting it: an image that was damaged on the way in produces a
    // guest that boots to nothing, and every later message blames the wrong
    // thing -- the hypervisor, the timeout, the engine.
    //
    // Damage is usually a scanner that took the file mid-write, and writing it
    // again usually works -- so do that once rather than telling someone to
    // press Repair for a fault they did not cause. Once, not in a loop: if the
    // second write is damaged too, something is deleting it on purpose and
    // retrying forever would only hide that.
    if check_guest_images(cfg).is_err() && k.exists() && r.exists() {
        phase(cfg, "Repairing the virtual machine image…");
        let repair = nebula(cfg, &["install-image",
            "--kernel", &k.display().to_string(),
            "--rootfs", &r.display().to_string()]);
        #[cfg(windows)]
        if let Err(e) = &repair {
            if is_app_control_block(e) {
                return Err(host::app_control_help(e));
            }
        }
        let _ = repair;
        let _ = fs::write(cfg.nebula_home.join(".guest-images"), guest_fingerprint(&[&k, &r]));
    }
    check_guest_images(cfg)?;

    // An engine still on its way out -- a Stop moments ago, or one from before
    // `down` learned to wait -- is waited out rather than started into. An
    // older `nebula up` reports such an engine as already running and returns,
    // and the start then fails three minutes later saying the virtual machine
    // did not come up (#119).
    if engine_state(cfg) == EngineState::Departing {
        phase(cfg, "Waiting for the previous engine to stop…");
        wait_for_engine_exit(cfg, ENGINE_DEPART_BUDGET);
    }

    if let Err(e) = nebula(cfg, &["up"]) {
        #[cfg(windows)]
        if is_app_control_block(&e) {
            return Err(host::app_control_help(&e));
        }
        // Closing the game and opening it again is the ordinary way to hit
        // this, and the previous engine needs about a minute to finish
        // leaving. Waiting is the whole remedy, so wait rather than hand the
        // player a virtualisation error for a stack that is simply busy.
        let mut last = e;
        if engine_still_departing(&last) {
            phase(cfg, "Waiting for the previous engine to stop…");
            for _ in 0..40 {
                sleep(Duration::from_secs(2));
                match nebula(cfg, &["up"]) {
                    Ok(()) => {
                        last.clear();
                        break;
                    }
                    Err(again) => {
                        last = again;
                        // A different failure is a real one: stop retrying and
                        // report it now rather than after another 80 seconds.
                        if !engine_still_departing(&last) {
                            break;
                        }
                    }
                }
            }
        }
        if !last.is_empty() {
            return Err(engine_failure_help(&last));
        }
    }
    // Its own phase. Installing the image and waiting for the engine are
    // different steps with very different durations, and leaving the install
    // message up for the whole wait made a healthy engine that the client
    // could not reach look like an install stuck at 100 seconds.
    phase(cfg, "Waiting for the engine…");
    // The docker socket appears a moment after the VM reports healthy.
    for _ in 0..45 {
        if dk.quiet(["ps"]) {
            return Ok(());
        }
        sleep(Duration::from_secs(2));
    }
    // The guest is the likelier suspect than the hypervisor when the partition
    // started and then went quiet, so say so before offering BIOS advice.
    check_guest_images(cfg)?;
    Err(engine_failure_help("the virtual machine did not come up"))
}

fn nebula(cfg: &Config, args: &[&str]) -> Result<(), String> {
    // stderr to a file, not a pipe.
    //
    // It has to be captured at all because when the engine cannot start, what
    // it says is the whole diagnosis, and discarding it left players with a
    // stack that failed several steps later for no stated reason.
    //
    // But it must not be a pipe. `nebula up` spawns nebulad as a daemon that
    // deliberately outlives the command, and on Windows the daemon inherits
    // the pipe's write handle. Reading such a pipe to EOF -- which is exactly
    // what Command::output() does -- therefore blocks until *nebulad* exits,
    // not until nebula exits. The observable failure is the app sitting on
    // "Installing the virtual machine image..." forever while the images are
    // already complete on disk and the nebula process has long since gone:
    // the first Windows bug report was fifteen minutes of that before the
    // supervisor's own timeout killed it.
    //
    // A file has no EOF to wait for. Same diagnosis, no deadlock.
    let log = std::env::temp_dir().join(format!("nebula-{}-{}.err", args[0], std::process::id()));
    let sink = fs::File::create(&log).map_err(|e| format!("running nebula: {e}"))?;
    let status = Command::new(&cfg.nebula)
        .args(args)
        .env("NEBULA_HOME", &cfg.nebula_home)
        .stdout(Stdio::null())
        .stderr(Stdio::from(sink))
        .status()
        .map_err(|e| format!("running nebula: {e}"))?;
    let captured = fs::read_to_string(&log).unwrap_or_default();
    let _ = fs::remove_file(&log);
    if status.success() {
        return Ok(());
    }
    let why = captured.trim().to_string();
    Err(if why.is_empty() {
        format!("nebula {} failed", args[0])
    } else {
        format!("nebula {} failed: {why}", args[0])
    })
}

/// An engine already holding a port this one needs, as nebula's failure names
/// it.
struct Holder {
    pid: u32,
    home: PathBuf,
}

/// Pull `... by nebulad pid 48746 (NEBULA_HOME=/…/nebula)` out of a failed
/// `up`.
///
/// Reading another program's prose is a poor way to learn anything, and it is
/// still the cheapest way to learn this: the alternative is enumerating
/// listening sockets on three platforms to rediscover what nebula has already
/// told us, in a binary that deliberately has no dependencies. A line that does
/// not parse yields nothing and the failure is reported as it always was, so a
/// reworded message costs this repair and not correctness.
fn port_holders(err: &str) -> Vec<Holder> {
    const BY: &str = "by nebulad pid ";
    const HOME: &str = "(NEBULA_HOME=";
    let mut out: Vec<Holder> = Vec::new();
    for line in err.lines() {
        let Some((_, rest)) = line.split_once(BY) else { continue };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(pid) = digits.parse::<u32>() else { continue };
        let Some((_, tail)) = rest.split_once(HOME) else { continue };
        // A path may hold anything, so end at the last `)` on the line rather
        // than the first -- "Ragnarok Offline (old)/nebula" is a real folder
        // someone could have.
        let Some(end) = tail.rfind(')') else { continue };
        if out.iter().any(|h| h.pid == pid) {
            continue;
        }
        out.push(Holder { pid, home: PathBuf::from(&tail[..end]) });
    }
    out
}

/// Every NEBULA_HOME this app has ever started an engine from.
///
/// A leftover engine is ours to stop only if it is running out of one of
/// these. Anything else on those ports belongs to somebody else -- a
/// standalone nebula, another embedder -- and ending someone else's virtual
/// machine to make room for ours would be a worse bug than the one being
/// fixed here.
fn our_engine_homes(cfg: &Config) -> Vec<PathBuf> {
    let mut homes = vec![cfg.nebula_home.clone()];
    let root = data_root();
    // The macOS app has been renamed twice and each rename moved the data
    // root: com.ragnarokmac.app was the Tauri bundle id, RagnarokMac the
    // readable folder that replaced it, and both can still have an engine
    // running. Keep in step with migrateDataRoot() in electron/main.js.
    if cfg!(target_os = "macos") {
        let support = home().join("Library/Application Support");
        homes.push(support.join("com.ragnarokmac.app/nebula"));
        homes.push(support.join("RagnarokMac/nebula"));
    }
    // That migration parks an unconfigured data root beside the real one
    // instead of deleting it, and an engine can still be running out of what
    // it parked.
    let parked = root.file_name().and_then(|n| n.to_str()).map(|n| format!("{n}.orphaned-"));
    if let (Some(dir), Some(prefix)) = (root.parent(), parked) {
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries.flatten() {
                if e.file_name().to_str().is_some_and(|n| n.starts_with(&prefix)) {
                    homes.push(e.path().join("nebula"));
                }
            }
        }
    }
    homes
}

/// Stop the engines of ours that are squatting on our ports, turning a start
/// that cannot work into one that can.
///
/// Reports whether anything was actually stopped: the caller retries only when
/// something changed, so a conflict with a stranger's engine still fails, and
/// says why.
fn clear_stale_engines(cfg: &Config, err: &str) -> bool {
    let ours = our_engine_homes(cfg);
    let mut stopped = false;
    for h in port_holders(err) {
        if !ours.iter().any(|p| *p == h.home) {
            continue;
        }
        phase(cfg, "Stopping a leftover engine that is holding the ports…");
        stopped |= stop_engine(cfg, &h);
    }
    stopped
}

/// Stop one leftover engine: by asking, when it can still hear us, and
/// directly when it cannot.
fn stop_engine(cfg: &Config, h: &Holder) -> bool {
    // `down` is the right way to do this -- it stops the guest cleanly and
    // deregisters the service label, so the engine does not simply come back
    // at the next login -- and it needs the home to still be there to read.
    if h.home.is_dir() {
        let _ = Command::new(&cfg.nebula)
            .arg("down")
            .env("NEBULA_HOME", &h.home)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if wait_gone(h.pid) {
            return true;
        }
    }
    // Its home was renamed out from under it by an upgrade, so there is no
    // state left for `down` to read and the process can only be ended
    // directly. Confirm what it is first: pids are reused, and by now the
    // number nebula printed may name something else entirely.
    if !is_nebulad(h.pid) {
        return false;
    }
    end_process(h.pid, false);
    if wait_gone(h.pid) {
        return true;
    }
    end_process(h.pid, true);
    wait_gone(h.pid)
}

/// Wait out a stop. Ten seconds: an engine with a guest still running takes a
/// few to put it down, and reporting failure while it is on its way out would
/// send the caller to end it the hard way for no reason.
fn wait_gone(pid: u32) -> bool {
    for _ in 0..20 {
        if !alive(pid) {
            return true;
        }
        sleep(Duration::from_millis(500));
    }
    false
}

#[cfg(not(windows))]
fn alive(pid: u32) -> bool {
    // Signal 0 asks whether the process is there without touching it.
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_nebulad(pid: u32) -> bool {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("nebulad"))
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn end_process(pid: u32, hard: bool) {
    let _ = Command::new("kill")
        .args([if hard { "-KILL" } else { "-TERM" }, &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// One `tasklist` row for a pid, lowercased, or nothing when there is no such
/// process -- the filter matching nothing still exits 0, so the row itself is
/// the answer rather than the exit status.
#[cfg(windows)]
fn task_row(pid: u32) -> String {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
        .unwrap_or_default()
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    task_row(pid).contains(&format!("\"{pid}\""))
}

#[cfg(windows)]
fn is_nebulad(pid: u32) -> bool {
    task_row(pid).contains("nebulad")
}

#[cfg(windows)]
fn end_process(pid: u32, hard: bool) {
    // /T because the engine owns the guest process; without it the child keeps
    // the ports the parent was killed to release.
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pid.to_string(), "/T"]);
    if hard {
        c.arg("/F");
    }
    let _ = c.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Move characters off maps a mod used to provide and no longer does.
///
/// This is the one way a mod can lock a player out of their own save. A
/// character's position is stored as a map *name*: uninstall the mod that
/// provided `ro_isle` and everyone standing on it has nowhere to log in to.
/// rAthena does offer a list of major cities when that happens, but roBrowser
/// discards it and shows an untranslated error, so in this app the character
/// simply cannot be selected.
///
/// Rather than try to know every valid map -- the stock list lives inside the
/// container and is 1,265 long -- this remembers only what *mods* provided last
/// time. A map in the previous list and not the current one is a map a mod took
/// away, which is precisely the case worth acting on and cannot misfire on a
/// stock map.
///
/// `save_map` matters as much as `last_map`: it is where death returns you, and
/// a start-point mod sets it on every character it creates.
fn rescue_stranded_characters(cfg: &Config, dk: &Docker, current: &[String]) {
    let marker = cfg.state.join("modmaps.txt");
    let previous: Vec<String> = fs::read_to_string(&marker)
        .map(|b| b.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    let _ = fs::write(&marker, current.join("\n"));

    let gone: Vec<&String> = previous.iter().filter(|m| !current.contains(m)).collect();
    if gone.is_empty() {
        return;
    }

    // Prontera, because it exists in both eras and is where rAthena's own
    // fallback list starts. The coordinates are its default spawn.
    let list = gone
        .iter()
        .map(|m| format!("'{}'", m.replace('\'', "")))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "UPDATE `char` SET last_map='prontera', last_x=156, last_y=191 WHERE last_map IN ({list}); \
         UPDATE `char` SET save_map='prontera', save_x=156, save_y=191 WHERE save_map IN ({list}); \
         SELECT ROW_COUNT();"
    );
    match dk.exec_sql(&sql) {
        Ok(_) => eprintln!(
            "mods: no mod provides {} any more -- any character standing there \
             has been moved to Prontera",
            gone.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
        ),
        // Not fatal. A character on a removed map is a problem; failing to
        // start the server over it is a bigger one.
        Err(e) => eprintln!("mods: could not move characters off {list}: {e}"),
    }
}

/// Write the conf files mods supply whole, into the directory the server
/// imports.
///
/// `state/conf` is bound at `/rathena/conf/import`, and rAthena's own
/// `conf/groups.yml` ends with `Footer: Imports: conf/import/groups.yml` -- so
/// dropping the file here is the whole mechanism.
///
/// Files no mod provides are **removed**, for the same reason `modbuild` is
/// rebuilt from scratch: a stale `groups.yml` left behind by a mod that has
/// been uninstalled would go on granting commands, and would be indistinguish-
/// able from the mod still being installed.
fn write_mod_conf_files(cfg: &Config, mods: &crate::mods::Assembled) -> Result<(), String> {
    let conf = cfg.state.join("conf");
    for file in ["groups.yml", "atcommands.yml"] {
        let path = conf.join(file);
        // The AI agent's group is the app's own, and goes first: always
        // present, so an agent account can log in whether or not any mod
        // grants commands, and read before any mod's copy so a mod cannot
        // quietly widen it by listing the same group.
        let mut with_agent;
        let entries = if file == "groups.yml" {
            // The players' own grant (@companion) is the app's too, for the
            // same reasons.
            with_agent = vec![
                (crate::accounts::AGENT_GROUP_OWNER.to_string(), crate::accounts::AGENT_GROUP_YML.to_string()),
                (crate::accounts::PLAYER_GRANT_OWNER.to_string(), crate::accounts::PLAYER_GRANT_YML.to_string()),
            ];
            with_agent.extend(mods.conf.get("file:groups.yml").cloned().unwrap_or_default());
            Some(&with_agent)
        } else {
            mods.conf.get(&format!("file:{file}"))
        };
        match entries {
            None => {
                let _ = fs::remove_file(&path);
            }
            Some(entries) => {
                // Every copy is combined, in load order, the way db/ tables
                // are; what could not be combined is named, one line each.
                let atcommands = mods.conf.get("file:atcommands.yml").cloned().unwrap_or_default();
                let (body, notes) = crate::mods::combine_whole_conf(file, entries, &atcommands);
                for note in &notes {
                    eprintln!("mods: {note}");
                }
                let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
                let Some(body) = body else {
                    let _ = fs::remove_file(&path);
                    continue;
                };
                fs::write(&path, body)
                    .map_err(|e| format!("writing conf/{file} from {}: {e}", names.join(", ")))?;
                eprintln!("mods: {} supplies conf/{file}", names.join(", "));
            }
        }
    }
    Ok(())
}

/// The settings mods asked for in one conf file, ready to append.
///
/// Empty for every file no mod named, which is the usual case, and the reason
/// this returns a string rather than taking a writer: the caller can drop it
/// into a format! and the generated file is unchanged when no mod is
/// installed.
fn conf_lines(mods: &crate::mods::Assembled, file: &str) -> String {
    match mods.conf.get(file) {
        None => String::new(),
        Some(pairs) => pairs.iter().map(|(k, v)| format!("{k}: {v}\n")).collect(),
    }
}

/// Is the server running pre-renewal?
///
/// A marker file rather than a parsed setting, matching free_kafra_warp: the
/// supervisor only needs to know which way, and the app owns the setting.
///
/// This decides which binaries run, which start point new characters get, and
/// which database they are saved in -- all three have to agree, so they are
/// all derived from this one answer.
pub fn is_prerenewal(cfg: &Config) -> bool {
    cfg.state.join("prerenewal").exists()
}

/// Where a mode's characters live.
///
/// Separate volumes, not a shared database, and not a second schema inside
/// one. rAthena ships a single set of sql-files with no era variants, so the
/// schema is identical and a renewal character loads into a pre-renewal server
/// without complaint -- which is exactly the problem. The data means different
/// things either side of the flag:
///
///   - pre-renewal exp tables stop at level 99; renewal reaches 275
///   - third and fourth job classes do not exist pre-renewal
///   - MAX_WEAPON_LEVEL is 5 vs 4, MAX_ARMOR_LEVEL 2 vs 1, and enchant grades
///     only exist on one side (src/common/mmo.hpp)
///   - MAX_GUILDSKILL is 20 vs 15
///   - a character saved on a renewal-only map has nowhere to log in to
///
/// None of that is a schema error, so nothing would refuse it. A level 150
/// fourth-job character in a pre-renewal server is off the end of every table
/// that describes them. Giving each mode its own volume means switching is
/// reversible and neither save can corrupt the other; the cost is that the
/// first start in a new mode creates a fresh account and character.
fn db_volume(cfg: &Config) -> String {
    if is_prerenewal(cfg) { "ragnarokmac-db-prere".into() } else { "ragnarokmac-db".into() }
}

/// Create and start the database container on one era's volume.
///
/// Split out of `up` so a whole-world backup or restore can reach the era
/// that is not running (see `with_era_database`) through exactly the mounts,
/// credentials and image a normal start uses.
fn start_database(cfg: &Config, dk: &Docker, volume: &str, credentials: Option<&crate::service_credentials::Credentials>) -> Result<(), String> {
    dk.remove_container(DB_CONTAINER);
    let mut mounts = vec![
        Mount::Bind {
            host: cfg.state.join("sql"),
            container: "/docker-entrypoint-initdb.d".into(),
            ro: true,
        },
        // A named volume rather than a bind: backups have to survive on
        // Windows too, where a host directory cannot be mounted, and the
        // dump is fetched back out with `cp`.
        if cfg!(windows) {
            Mount::Volume { name: "ragnarokmac-backups".into(), container: "/backups".into() }
        } else {
            Mount::Bind { host: cfg.state.join("backups"), container: "/backups".into(), ro: false }
        },
        Mount::Volume { name: volume.to_string(), container: "/var/lib/mysql".into() },
    ];
    let mut opts: Vec<String> = ["--network", NET, "-e", "MARIADB_DATABASE=ragnarok", "-e", "MARIADB_USER=ragnarok"].iter().map(|s| s.to_string()).collect();
    if let Some(credentials) = credentials {
        mounts.push(Mount::Bind { host: credentials.directory.clone(), container: crate::service_credentials::CONTAINER_DIR.into(), ro: true });
        opts.extend(["-e", "MARIADB_ROOT_PASSWORD_FILE=/run/ragnarok-private/root.secret", "-e", "MARIADB_PASSWORD_FILE=/run/ragnarok-private/database.secret"].iter().map(|s| s.to_string()));
    } else {
        opts.extend(["-e", "MARIADB_ROOT_PASSWORD=ragnarok", "-e", "MARIADB_PASSWORD=ragnarok"].iter().map(|s| s.to_string()));
    }
    dk.run_container(DB_CONTAINER, &cfg.db_image, &[], &mounts, &opts)
        .map_err(|e| format!("starting the database: {e}"))?;
    Ok(())
}

/// The uncompressed size a gzip file claims, from its ISIZE trailer.
///
/// The last four bytes of a gzip stream are the uncompressed length. Reading
/// them costs one seek, so an installed image can be checked against what it
/// should be without decompressing a gigabyte to find out.
fn gzip_uncompressed_size(path: &Path) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len < 18 {
        return None;
    }
    f.seek(SeekFrom::Start(len - 4)).ok()?;
    let mut b = [0u8; 4];
    f.read_exact(&mut b).ok()?;
    Some(u32::from_le_bytes(b) as u64)
}

/// Check that the installed guest images are the size they should be.
///
/// A virtual machine whose partition starts and whose console stays completely
/// empty has almost always been handed a kernel or rootfs that is not what we
/// wrote. On Windows the usual cause is the antivirus: installing these means
/// writing about 3.2 GB, every byte of which Defender inspects, and a file it
/// quarantines or truncates mid-write leaves a guest that cannot boot and
/// cannot say so.
///
/// Sizes rather than hashes: the check runs on every start, and hashing a
/// gigabyte to find out is a cost paid by everyone to catch a rare fault.
fn check_guest_images(cfg: &Config) -> Result<(), String> {
    let pairs = [
        (cfg.root.join("guest/Image.gz"), cfg.nebula_home.join("kernel/Image"), "kernel"),
        (cfg.root.join("guest/rootfs.img.gz"),
         cfg.nebula_home.join("images/rootfs-pristine.img"), "root filesystem"),
    ];
    for (src, installed, what) in pairs {
        let (Some(want), Ok(meta)) = (gzip_uncompressed_size(&src), fs::metadata(&installed)) else {
            continue; // Nothing shipped, or nothing installed yet: not our business here.
        };
        let got = meta.len();
        if got != want {
            return Err(format!(
                "The virtual machine's {what} is damaged: it should be {want} bytes and is {got}.\n\n\
                 This usually means antivirus software altered or quarantined it \
                 while it was being written -- installing it writes over a \
                 gigabyte, and security software inspects every byte.\n\n\
                 Use Repair in Settings to install it again. If it keeps \
                 happening, allow the folder below in your antivirus and repair \
                 once more:\n\n\x20   {}",
                cfg.nebula_home.display()
            ));
        }
    }
    Ok(())
}

/// Windows refused to run one of our binaries under a code-integrity policy.
///
/// Smart App Control, and WDAC policies generally, block executables that are
/// unsigned or have no reputation. Ours are unsigned today, so on a machine
/// enforcing it the app is stopped before it does anything -- and the failure
/// arrives looking like a hypervisor problem, which sends people to their BIOS
/// for a code-signing fault. Error 4551 is ERROR_VIRUS_INFECTED's neighbour in
/// spirit but not in cause: nothing is wrong with the file except who signed it.
#[cfg(windows)]
fn is_app_control_block(msg: &str) -> bool {
    // 4551 is what the API reports when it names the cause. 0xC0000135 is what
    // a refused process exits with, and it also means a genuinely missing DLL,
    // so it only counts as a block when Smart App Control is actually
    // enforcing -- otherwise a broken install would be blamed on signing.
    msg.contains("os error 4551")
        || msg.contains("Application Control policy has blocked")
        || ((msg.contains("0xC0000135")
            || msg.contains("-1073741515")
            || msg.contains("os error 126"))
            && host::app_control_state() == host::AppControl::Enforcing)
}

/// Is the Microsoft Visual C++ runtime present?
///
/// Every binary we ship in payload/bin -- ragnarok-stack, nebula, nebulad,
/// docker-slim, robrowser-remoteclient -- imports VCRUNTIME140.dll. The
/// Electron shell does not, so the app opens perfectly and then fails the
/// instant it runs any of them. Windows refuses the load with 0xC0000135,
/// which is the same code Smart App Control produces, and without this check
/// the failure falls through to the hypervisor advice -- sending someone into
/// their BIOS over a missing DLL.
///
/// The api-ms-win-crt-* imports resolve from the UCRT that ships with Windows
/// 10 and later; VCRUNTIME140.dll is the one that needs the redistributable.
#[cfg(windows)]
fn vc_runtime_missing() -> bool {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    // System32 is the 64-bit system directory for a 64-bit process. A copy
    // beside the executable satisfies the loader too, so accept either.
    let system32 = Path::new(&root).join("System32").join("VCRUNTIME140.dll");
    if system32.exists() {
        return false;
    }
    !std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("VCRUNTIME140.dll").exists()))
        .unwrap_or(false)
}

/// A load failure that means a DLL could not be found.
#[cfg(windows)]
fn is_dll_not_found(msg: &str) -> bool {
    msg.contains("0xC0000135") || msg.contains("-1073741515") || msg.contains("os error 126")
}

#[cfg(windows)]
fn vc_runtime_help(reason: &str) -> String {
    format!(
        "{reason}\n\n\
         This app needs the Microsoft Visual C++ Redistributable (x64), and it \
         is not installed on this machine. It is a Microsoft component that a \
         lot of software relies on, so most Windows machines already have it -- \
         yours does not yet.\n\n\
         Install it, then start Ragnarok Offline again:\n\n\
         \x20   https://aka.ms/vs/17/release/vc_redist.x64.exe\n\n\
         Nothing is wrong with your computer or your install. The app window \
         opens without it because only the parts that run the game servers need \
         it, which is why the failure shows up a few seconds in."
    )
}

/// Why the virtual machine will not start, in steps a player can act on.
///
/// The installer script checks this and prints exactly this advice, but a
/// player never runs the installer -- nebula is embedded in the app -- so the
/// check has to live here too. Without it the failure surfaces as a timeout
/// several steps later with nothing to act on.
/// Has nebula already said what went wrong?
///
/// It explains a port collision itself now, naming the ports, the process
/// holding them and three ways out. Appending "check /dev/kvm and your BIOS" to
/// that is worse than saying nothing: it contradicts a correct diagnosis the
/// player is looking straight at, and sends them to reboot into firmware for a
/// problem that is a config line.
fn nebula_explained_itself(reason: &str) -> bool {
    reason.contains("already in use")
        || reason.contains("port_conflict")
        || reason.contains("Either:")
        || reason.contains("cannot share a port")
}

/// A previous engine that has not finished leaving yet.
///
/// Quitting stops the engine, but stopping it is not instant: the supervisor
/// asks the VM to shut down, waits, and only then does nebulad record its exit
/// and release the run directory. Reopening the app inside that window finds an
/// engine that is alive enough to refuse a second one ("nebulad already
/// running") or dying fast enough that the socket goes away mid-request
/// ("Connection reset by peer", "Broken pipe").
///
/// None of that is a fault to report. It is the previous run finishing, and the
/// only thing to do about it is wait -- which is why the start is retried
/// rather than explained. It matters that it is not explained: the Linux
/// fallback below sends the player to their BIOS for it, which is both wrong
/// and unfixable, and it is the message they actually see when they close the
/// game and open it straight away.
fn engine_still_departing(reason: &str) -> bool {
    reason.contains("already running")
        || reason.contains("Connection reset by peer")
        || reason.contains("Broken pipe")
}

fn engine_failure_help(reason: &str) -> String {
    // Before nebula_explained_itself, deliberately: that returns nebula's own
    // text unchanged for anything it has already diagnosed, and a port
    // conflict is one of the things it matches. Nebula's message is accurate
    // but its three remedies -- stop the holder, renumber the ports, set
    // port_conflict -- are all things a player cannot do. This one names the
    // button that does it for them, and still quotes nebula in full.
    //
    // Only reached once the engine holding the port has turned out not to be
    // ours; ours are stopped and the start retried before anyone sees this.
    if reason.contains("already in use") {
        return format!(
            "{reason}\n\n\
             Another Nebula engine is already using the ports this one needs. \
             If it is one this app left behind — an update renames the folder \
             an engine is running from without stopping it — then Repair, in \
             Settings, will stop it and start again. If you run Nebula \
             yourself, stop that instance or give one of the two its own ports."
        );
    }
    if nebula_explained_itself(reason) {
        return reason.to_string();
    }
    // Only reached after the retries in ensure_engine have run out, so the
    // previous engine is not merely slow -- it is stuck. Say that, rather than
    // blaming the hypervisor for it.
    if engine_still_departing(reason) {
        return format!(
            "{reason}\n\n\
             A previous engine is still running and did not stop on its own. \
             Repair, in Settings, will stop it and start again."
        );
    }
    // A missing DLL is not a virtualisation fault, and the hypervisor advice
    // below would send someone into their BIOS for one.
    #[cfg(windows)]
    if is_dll_not_found(reason) && vc_runtime_missing() {
        return vc_runtime_help(reason);
    }

    if cfg!(target_os = "macos") {
        return format!(
            "{reason}\n\n\
             The virtual machine could not start. This needs macOS 13 or \
             later on Apple silicon; if that is what you have, the Settings \
             window has a Report a problem button that collects the logs \
             needed to work out what stopped it."
        );
    }

    if !cfg!(windows) {
        return format!(
            "{reason}\n\n\
             The virtual machine could not start. On Linux this usually means \
             /dev/kvm is missing or not readable by you: check that \
             virtualisation is enabled in your BIOS, and that you are in the \
             `kvm` group."
        );
    }

    // Ask the machine what is actually wrong rather than reading it back out
    // of a failure that cannot be told from three others. Three unrelated
    // faults land here identically -- virtualisation off in firmware, the
    // Windows Hypervisor Platform feature off, and the hypervisor switched off
    // at boot -- and the old text named only the middle one, so anyone with
    // either of the other two was told to tick a box that was already ticked.
    //
    // Costs a couple of process spawns, on a path where the start has already
    // failed and the alternative is a wrong answer.
    #[cfg(windows)]
    return format!("{reason}\n\n{}", host::probe().advice());
    #[cfg(not(windows))]
    unreachable!("every non-Windows platform returned above");
}

/// Load the bundled image tarball when the images are not already present.
///
/// This was `precache.sh ensure`. It is here because the app must be able to
/// start on a machine with no shell interpreter, and because the failure it
/// guards is unforgiving: with no images, `run` falls through to pulling
/// `ragnarokmac/mariadb` from a registry that has never heard of it, and the
/// error is about a network we should never have touched.
// Cache identity, not a security signature. Release provenance/checksums
// authenticate the packaged archive; this detects changed bytes under fixed tags.
fn image_bundle_fingerprint(mut reader: impl Read) -> Result<String, String> {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut block = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut block).map_err(|_| "Cannot read the server image bundle")?;
        if count == 0 { break; }
        for byte in &block[..count] { hash ^= *byte as u64; hash = hash.wrapping_mul(0x0000_0100_0000_01b3); }
    }
    Ok(format!("{hash:016x}"))
}

/// The image ids a bundle carries, per tag: what `docker image inspect`
/// must say each tag points at once the bundle is really loaded.
///
/// Two ids are accepted per tag because Docker reports either, depending on
/// its image store: the classic store's id is the digest of the image config
/// (manifest.json's `Config`), the containerd store's is the manifest's
/// digest (index.json). Both are read from the bundle itself, so nothing
/// here trusts the engine to have done what it was asked.
fn bundle_image_ids(reader: impl Read) -> Result<Vec<(String, String)>, String> {
    let bad = || "Cannot read the server image bundle".to_string();
    let gz = crate::archive::GzipReader::new(std::io::BufReader::with_capacity(256 * 1024, reader)).map_err(|_| bad())?;
    let mut tar = crate::archive::TarReader::new(gz);
    let mut ids = Vec::new();
    let tag = |name: &str| name.strip_prefix("docker.io/").unwrap_or(name).to_string();
    while let Some(entry) = tar.next_entry().map_err(|_| bad())? {
        let path = entry.path.trim_start_matches("./");
        if (path != "manifest.json" && path != "index.json") || entry.size > 1024 * 1024 { continue; }
        let mut text = String::new();
        (&mut tar).take(entry.size).read_to_string(&mut text).map_err(|_| bad())?;
        let parsed = crate::json::parse(&text).map_err(|_| bad())?;
        let list = match (path, &parsed) {
            ("manifest.json", crate::json::Value::Array(images)) => images.clone(),
            ("index.json", _) => match parsed.get("manifests") { Some(crate::json::Value::Array(m)) => m.clone(), _ => Vec::new() },
            _ => Vec::new(),
        };
        for image in &list {
            if path == "manifest.json" {
                let Some(config) = image.str("Config") else { continue };
                let digest = config.rsplit('/').next().unwrap_or(config);
                let id = if digest.starts_with("sha256:") { digest.to_string() } else { format!("sha256:{digest}") };
                if let Some(crate::json::Value::Array(tags)) = image.get("RepoTags") {
                    for t in tags { if let crate::json::Value::String(t) = t { ids.push((tag(t), id.clone())); } }
                }
            } else if let (Some(digest), Some(name)) = (image.str("digest"), image.get("annotations").and_then(|a| a.str("io.containerd.image.name"))) {
                ids.push((tag(name), digest.to_string()));
            }
        }
    }
    Ok(ids)
}

/// What a tag points at now, or None when it is not there.
fn image_id(dk: &Docker, image: &str) -> Option<String> {
    dk.output(["image", "inspect", "-f", "{{.Id}}", image]).ok()
        .map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Whether every tag the server needs points at the image the bundle carries.
fn images_match(expected: &[(String, String)], actual: &[(&str, Option<String>)]) -> bool {
    actual.iter().all(|(tag, id)| match id {
        Some(id) => expected.iter().any(|(t, e)| t == tag && e == id),
        None => false,
    })
}

/// The marker recording a verified load: the bundle's bytes and the ids the
/// tags were seen to point at afterwards. Compared against the ids now, so a
/// tag that moved -- or a load that never replaced it -- is loaded again.
fn image_marker(fingerprint: &str, actual: &[(&str, Option<String>)]) -> String {
    let ids: Vec<String> = actual.iter().map(|(tag, id)| format!("{tag}={}", id.as_deref().unwrap_or("-"))).collect();
    format!("v2:{fingerprint}:{}\n", ids.join(":"))
}

/// Untagged images, from `images --format json` (one object per line).
///
/// Every update loads the new bundle and moves both tags onto it, which leaves
/// the previous release's images behind with no tag -- about 350 MB each time,
/// on a data disk of fixed size, until a load fails for want of space. Nothing
/// else in the engine is untagged: the server images and nebula's own pause
/// image all carry tags.
fn untagged_images(listing: &str) -> Vec<(String, u64)> {
    listing.lines().filter_map(|line| {
        let v = crate::json::parse(line.trim()).ok()?;
        let tags: Vec<&str> = match v.get("RepoTags") {
            Some(crate::json::Value::Array(a)) => a.iter().filter_map(|t| match t { crate::json::Value::String(s) => Some(s.as_str()), _ => None }).collect(),
            None | Some(crate::json::Value::Null) => Vec::new(),
            _ => return None,
        };
        if !tags.iter().all(|t| t.is_empty() || *t == "<none>:<none>") { return None; }
        let id = v.str("Id")?.to_string();
        let size = match v.get("Size") { Some(crate::json::Value::Number(n)) if *n > 0.0 => *n as u64, _ => 0 };
        Some((id, size))
    }).collect()
}

/// Remove the images earlier updates left behind. Never forced: the engine
/// refuses an image a container still uses, and that one is simply tried
/// again at the next start. Best effort, so a failure here never stops a start.
/// (`image prune` cannot do this: nebula's engine answers it without deleting.)
fn prune_old_images(dk: &Docker) {
    let Ok(listing) = dk.output(["images", "--format", "json"]) else { return };
    let (mut removed, mut freed) = (0, 0u64);
    for (id, size) in untagged_images(&listing) {
        if dk.quiet(["rmi", &id]) {
            removed += 1;
            freed += size;
        }
    }
    if removed > 0 {
        println!("Removed {removed} old server image(s), {} MB", freed / 1_000_000);
    }
}

fn ensure_images(cfg: &Config, dk: &Docker) -> Result<(), String> {
    let tags = [cfg.image.as_str(), cfg.db_image.as_str()];
    let current = |dk: &Docker| tags.iter().map(|t| (*t, image_id(dk, t))).collect::<Vec<_>>();
    let before = current(dk);
    let present = before.iter().all(|(_, id)| id.is_some());
    let bundle = cfg.root.join("dist/images.tar.gz");
    if !bundle.exists() {
        if present { return Ok(()); }
        return Err(format!("no server images, and no bundle at {}", bundle.display()));
    }
    let open = || fs::File::open(&bundle).map_err(|_| "Cannot open the server image bundle".to_string());
    let fingerprint = image_bundle_fingerprint(open()?)?;
    let marker = cfg.state.join("image-bundle.id");
    if present && fs::read_to_string(&marker).ok().as_deref() == Some(image_marker(&fingerprint, &before).as_str()) { return Ok(()); }
    let expected = bundle_image_ids(open()?)?;
    if let Some(tag) = tags.iter().find(|t| !expected.iter().any(|(e, _)| e == *t)) {
        return Err(format!("the server image bundle does not contain {tag}"));
    }
    // Skip the load when the tags already point at this bundle (a marker from an older release, say).
    if !images_match(&expected, &before) {
        // Before the load, not only after: an install whose disk is already
        // full of old releases would otherwise fail here forever.
        prune_old_images(dk);
        phase(cfg, "Loading the bundled server images…");
        // "Done" is the bundle's own images being in place -- not merely some
        // image under each tag. On an upgrade the previous release's images
        // already carry both tags, and treating that as done killed the
        // loader five seconds in, leaving every upgraded install on the image
        // it first installed while recording the new bundle as loaded.
        dk.load_bundle(&bundle, || images_match(&expected, &current(dk)))?;
    }
    let after = current(dk);
    if !images_match(&expected, &after) {
        let stale: Vec<&str> = after.iter().filter(|(t, id)| !expected.iter().any(|(e, x)| e == t && Some(x) == id.as_ref())).map(|(t, _)| *t).collect();
        return Err(format!("loading the bundled server images did not replace {}; start again to retry", stale.join(" and ")));
    }
    fs::write(marker, image_marker(&fingerprint, &after)).map_err(|_| "Cannot record the loaded server image bundle".to_string())
}

/// The Kafra teleport prices are hardcoded in the NPC script with no config
/// knob, so keep an editable copy in state and overlay it.
fn prepare_kafra_scripts(cfg: &Config, dk: &Docker) {
    let dir = cfg.state.join("npc/kafras");
    let orig = dir.join("functions_kafras.orig");
    let live = dir.join("functions_kafras.txt");

    if !live.exists() {
        let _ = fs::create_dir_all(cfg.state.join("npc"));
        let cid = match dk.output(["create", &cfg.image, "true"]) {
            Ok(s) => s.trim().to_string(),
            Err(_) => return,
        };
        let _ = fs::remove_dir_all(&dir);
        let _ = dk.copy_out(&cid, "/rathena/npc/kafras", &cfg.state.join("npc"));
        dk.quiet(["rm", &cid]);
        if !live.exists() {
            return;
        }
        let _ = fs::copy(&live, &orig);
    }
    if !orig.exists() {
        return;
    }
    let Ok(src) = fs::read_to_string(&orig) else { return };

    let out = if cfg.state.join("free_kafra_warp").exists() {
        // Two edits make every Kafra service free: zero the per-town warp price
        // arrays, and pin the storage fee assignment to 0.
        src.lines()
            .map(|l| {
                if l.contains("setarray @wrpP[0]") {
                    zero_numbers(l)
                } else if l.trim_start().starts_with(".@fee = getarg(1);") {
                    let indent: String = l.chars().take_while(|c| c.is_whitespace()).collect();
                    format!("{indent}.@fee = 0;")
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    } else {
        src
    };
    let _ = fs::write(&live, out);
}

/// Replace every run of digits with a single 0, leaving everything else alone.
fn zero_numbers(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_num = false;
    for c in line.chars() {
        if c.is_ascii_digit() {
            if !in_num {
                out.push('0');
                in_num = true;
            }
        } else {
            in_num = false;
            out.push(c);
        }
    }
    out
}

/// The population engine's companion table: `CREATE TABLE IF NOT EXISTS` from the one copy
/// of the schema, then the columns that table gained while the feature was developed, for a
/// database made before them -- `CREATE ... IF NOT EXISTS` leaves an existing table alone.
/// One round trip, safe on a fresh database, an old one, and every start after.
///
/// Only new objects: nothing of rAthena's is altered and no existing row is rewritten, so
/// there is nothing one-way here and no backup to take. An earlier release ignores the table.
const COMPANION_SCHEMA: &str =
    include_str!("../../third-party/population-engine/files/sql-files/population_engine/cp_companion_persistence.sql");

const COMPANION_COLUMNS: &[(&str, &str)] = &[
    ("garment_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("option_", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("name", "VARCHAR(24) NOT NULL DEFAULT ''"),
    ("acc_l_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("acc_r_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("costume_top_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("costume_mid_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("costume_low_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("costume_garment_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("shadow_armor_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("shadow_weapon_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("shadow_shield_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("shadow_shoes_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("shadow_acc_l_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    ("shadow_acc_r_nameid", "INT UNSIGNED NOT NULL DEFAULT 0"),
    // v5: 4th-job trait stats, grown by the companion growth system.
    ("pow_", "SMALLINT NOT NULL DEFAULT 0"),
    ("sta_", "SMALLINT NOT NULL DEFAULT 0"),
    ("wis_", "SMALLINT NOT NULL DEFAULT 0"),
    ("spl_", "SMALLINT NOT NULL DEFAULT 0"),
    ("con_", "SMALLINT NOT NULL DEFAULT 0"),
    ("crt_", "SMALLINT NOT NULL DEFAULT 0"),
    // v6: party orders -- stance, duty and the support healer thresholds.
    ("mode", "TINYINT NOT NULL DEFAULT 1"),
    ("duty", "TINYINT NOT NULL DEFAULT 0"),
    ("heal_at", "TINYINT NOT NULL DEFAULT 75"),
    ("emergency_at", "TINYINT NOT NULL DEFAULT 35"),
    // v7: the player's own skill selection for this companion. NULL means
    // "never chosen" so an upgrade keeps every existing companion on the
    // class preset list, which is the behaviour it had before the selector.
    ("skill_preset", "TEXT NULL DEFAULT NULL"),
    // v8: the companion's homunculus. hom_enabled NULL means "never chosen", which
    // is ON for the alchemist line because the pet is part of the class; 0 is an
    // explicit no, so an upgrade cannot re-enable a pet a player switched off.
    ("hom_enabled", "TINYINT NULL DEFAULT NULL"),
    ("hom_class", "INT NOT NULL DEFAULT 0"),
    ("hom_level", "SMALLINT NOT NULL DEFAULT 0"),
    ("hom_exp", "BIGINT NOT NULL DEFAULT 0"),
    // v9: which worn positions hold gear the owner gave. Only those come back through
    // @companion gear; 0 for an existing row, so its generated gear stays its own.
    ("given_mask", "INT UNSIGNED NOT NULL DEFAULT 0"),
    // v10: companions belong to a character, not an account. 0 on an existing row means
    // "saved before this"; the first character of that account to log in claims it.
    ("owner_char_id", "INT UNSIGNED NOT NULL DEFAULT 0"),
    // v11: every worn piece in full -- refine, cards, options -- where the *_nameid
    // columns keep only an id. NULL on an existing row, which recalls as it always did.
    ("gear_detail", "TEXT NULL DEFAULT NULL"),
    // v12: when the companion sits down to rest between fights, chosen in the Companions
    // window. An existing row gets the defaults every companion starts with.
    ("rest_below", "TINYINT NOT NULL DEFAULT 30"),
    ("rest_until", "TINYINT NOT NULL DEFAULT 95"),
    // v13: the companion's own bag beyond its worn gear. NULL on an existing row, which keeps
    // what the recall spawn gives it until the first save makes that its own.
    ("inventory_detail", "TEXT NULL DEFAULT NULL"),
    // v14: the companion roams its owner's map instead of following, chosen in the Companions
    // window. 0 on an existing row: every companion follows, as before.
    ("roam", "TINYINT NOT NULL DEFAULT 0"),
];

/// Indexes added after the table first shipped, as (name, columns).
const COMPANION_INDEXES: &[(&str, &str)] = &[
    ("idx_owner_char", "`owner_account_id`, `owner_char_id`"),
];

fn companion_table_sql() -> String {
    let added: Vec<String> = COMPANION_COLUMNS
        .iter()
        .map(|(column, definition)| format!("ADD COLUMN IF NOT EXISTS `{column}` {definition}"))
        .chain(COMPANION_INDEXES.iter().map(|(name, columns)| format!("ADD INDEX IF NOT EXISTS `{name}` ({columns})")))
        .collect();
    format!("{COMPANION_SCHEMA}\nALTER TABLE `cp_companion_persistence` {};\n", added.join(", "))
}

/// rAthena's web server: guild emblems, reached by the client only through
/// the asset server (WEB_SERVER_TARGET). Not one of `SERVERS`: those decide
/// whether a launch failed, and a world without emblems still plays.
const WEB_SERVER: &str = "ragnarok-web";

/// The web server keeps emblems here (rAthena sql-files/web.sql). main.sql
/// does not create it, and the app never imported web.sql; its other tables
/// (user, character and merchant configs) answer requests this client never
/// makes, so only this one is created.
const GUILD_EMBLEMS_TABLE: &str = "CREATE TABLE IF NOT EXISTS `guild_emblems` (
  `world_name` varchar(32) NOT NULL,
  `guild_id` int(11) unsigned NOT NULL,
  `file_type` varchar(255) NOT NULL,
  `file_data` blob,
  `version` int(11) unsigned NOT NULL default '0',
  PRIMARY KEY (`world_name`, `guild_id`)
) ENGINE=MyISAM";

fn ensure_guild_emblems_table(dk: &Docker) -> Result<(), String> {
    dk.private_sql(GUILD_EMBLEMS_TABLE)
        .map(|_| ())
        .map_err(|e| format!("preparing the guild emblem table: {e}"))
}

fn ensure_companion_table(dk: &Docker) -> Result<(), String> {
    dk.private_sql(&companion_table_sql())
        .map(|_| ())
        .map_err(|e| format!("preparing the companion table: {e}"))
}

/// Poll for the thing actually depended on — the database answering queries —
/// rather than a container healthcheck.
fn wait_for_db(dk: &Docker) -> Result<(), String> {
    for _ in 0..90 {
        // exec_sql uses loopback TCP: the entrypoint's temporary bootstrap
        // server has networking disabled. A Unix-socket connection can see the
        // login table before 03-account.sql has seeded the first-run GM. Wait
        // for the final server and the schema, without recreating credentials.
        if dk.exec_sql("SELECT 1 FROM login LIMIT 1").is_ok() {
            return Ok(());
        }
        sleep(Duration::from_secs(2));
    }
    Err("timed out waiting for the database schema".into())
}

/// The map-server listens on its port long before it is usable: it then reads its
/// maps and the whole npc tree, and only afterwards registers those maps with
/// the char-server. A character logging in during that window is told "Map is
/// not available" and bounced. The container being Up is not readiness; the
/// char-server saying it has the maps is.
fn wait_for_maps(dk: &Docker) -> Result<(), String> {
    for _ in 0..90 {
        if dk.logs("ragnarok-char", "400").contains("loading complete") {
            return Ok(());
        }
        // A server that has exited is not a slow server. Waiting three minutes
        // for one and then reporting success is how a stack with no game
        // servers at all still went on to start the asset server and present
        // itself as ready -- the launch looked slow, then looked fine, and
        // nothing worked.
        // Only a container that has actually stopped, not one that is merely
        // not running yet. `docker start` returns before the container reports
        // "running", so a server still coming up reads as "created" -- and
        // treating that as death aborted the launch of a perfectly healthy
        // stack, leaving three running servers, no asset server, and a phase
        // frozen mid-sentence.
        let dead: Vec<&str> = SERVERS
            .iter()
            .copied()
            .filter(|c| matches!(dk.state(c).as_deref(), Some("exited") | Some("dead")))
            .collect();
        if !dead.is_empty() {
            // The server's own last words are worth more than anything this
            // could say about them: rAthena reports what it could not reach.
            let tail = dk.logs(dead[0], "8");
            let reason = tail
                .lines()
                .filter(|l| l.contains("Error") || l.contains("error"))
                .last()
                .map(|l| strip_ansi(l))
                .unwrap_or_else(|| "no error was logged".into());
            return Err(format!(
                "{} stopped during startup: {reason}",
                dead.join(", ")
            ));
        }
        sleep(Duration::from_secs(2));
    }
    // Still running, just slow. That is worth saying rather than failing --
    // a first launch on a slow machine genuinely takes a while, and the maps
    // finish loading shortly after.
    eprintln!("map-server has not registered its maps yet; first login may need a retry");
    Ok(())
}

/// rAthena colours its output, and an escape sequence in an error message
/// makes it unreadable wherever it is shown.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

fn run_server(cfg: &Config, dk: &Docker, name: &str, port: u16, binary: &str, lan: bool) -> Result<(), String> {
    // Before the container goes, and with it its log.
    crate::crashes::capture_all(cfg, dk);
    dk.remove_container(name);

    // One directory mount, not five file mounts: a single-file bind whose host
    // path contains a space is mishandled, and the standard macOS location
    // always contains one. rAthena reads whichever of these files exist.
    let mut mounts = vec![Mount::Bind {
        host: cfg.state.join("conf"),
        container: "/rathena/conf/import".into(),
        ro: true,
    }];
    // Only the map server runs NPC scripts.
    if name == "ragnarok-map" && cfg.state.join("npc/kafras/functions_kafras.txt").exists() {
        mounts.push(Mount::Bind {
            host: cfg.state.join("npc/kafras"),
            container: "/rathena/npc/kafras".into(),
            ro: true,
        });
    }
    // Mods, assembled by mods::assemble before the servers start. Tables go to
    // every server that reads them; scripts only mean anything to the map
    // server, which is the only one that runs them.
    let modbuild = cfg.state.join("modbuild");
    if modbuild.join("db").is_dir() {
        mounts.push(Mount::Bind {
            host: modbuild.join("db"),
            container: "/rathena/db/import".into(),
            ro: true,
        });
    }
    if name == "ragnarok-map" && modbuild.join("npc").is_dir() {
        mounts.push(Mount::Bind {
            host: modbuild.join("npc"),
            container: "/rathena/npc/mods".into(),
            ro: true,
        });
    }
    // -t because rAthena writes with printf(3), which block-buffers when
    // stdout is not a tty; without it errors never reach `docker logs`.
    // Loopback by default: an offline single-player server has no business
    // listening on the network. LAN hosting is an explicit choice, and it is
    // the whole difference between "only this machine" and "anyone who can
    // reach this machine".
    let bind = if lan { "0.0.0.0" } else { "127.0.0.1" };
    // The clock rAthena's localtime() reads: WoE, OnClock events, daily
    // resets. See timezone.rs.
    let zone = crate::timezone::chosen(cfg)?;
    let opts = vec![
        "-t".to_string(),
        "--network".into(), NET.into(),
        "-p".into(), format!("{bind}:{port}:{port}"),
        "-e".into(), format!("TZ={zone}"),
    ];
    dk.run_container(name, &cfg.image, &[binary.to_string()], &mounts, &opts)
        .map_err(|e| format!("starting {name}: {e}"))
}

fn stop_game_services(cfg: &Config, dk: &Docker) -> Result<(), String> {
    crate::crashes::capture_all(cfg, dk);
    for service in [WEB_SERVER, "ragnarok-map", "ragnarok-char", "ragnarok-login"] {
        if dk.is_running(service) && (dk.output(["stop", "-t", "30", service]).is_err() || dk.is_running(service)) {
            return Err(format!("Could not stop {service} cleanly; database credentials were not changed."));
        }
    }
    Ok(())
}

fn require_private_database_image(cfg: &Config, dk: &Docker) -> Result<(), String> {
    let body = dk.output(["image", "inspect", &cfg.db_image]).map_err(|_| "Cannot inspect the database image")?;
    let parsed = crate::json::parse(&body).map_err(|_| "Cannot inspect the database image")?;
    let config = match &parsed { crate::json::Value::Array(images) => images.first(), _ => Some(&parsed) }
        .and_then(|image| image.get("Config")).and_then(|config| config.get("Labels"));
    if config.and_then(|labels| labels.str("app.ragnarokoffline.private-db-files")) != Some("v1") {
        return Err("Service credential protection needs an updated bundled database image with private-db-files v1. Update the runtime images before continuing.".into());
    }
    Ok(())
}

fn protect_game_config(cfg: &Config) -> Result<(), String> {
    crate::private_fs::directory(&cfg.state)?;
    let conf = cfg.state.join("conf");
    crate::private_fs::directory(&conf)?;
    for entry in fs::read_dir(&conf).map_err(|_| "Cannot protect game configuration")? {
        let entry = entry.map_err(|_| "Cannot protect game configuration")?;
        // Reject links before writing any secret: a config alias into the
        // asset root could otherwise expose its bytes through HTTP.
        crate::private_fs::protect(&entry.path(), false)?;
    }
    Ok(())
}

fn finish_game_config(cfg: &Config) -> Result<(), String> {
    let conf = cfg.state.join("conf");
    for entry in fs::read_dir(&conf).map_err(|_| "Cannot protect generated game configuration")? {
        let entry = entry.map_err(|_| "Cannot protect generated game configuration")?;
        crate::private_fs::protect(&entry.path(), false)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o644)).map_err(|_| "Cannot prepare container game configuration")?;
        }
    }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        // The host's state ancestor stays 0700, but this mount root must be
        // traversable by USER rathena inside the VM. Windows copies preserve
        // its private host DACL independently of the guest file mode.
        fs::set_permissions(&conf, fs::Permissions::from_mode(0o755)).map_err(|_| "Cannot prepare container game configuration")?;
    }
    Ok(())
}

fn audit_service_accounts(dk: &Docker, legacy: bool) -> Result<(), String> {
    let services = dk.root_sql("SELECT COUNT(*) FROM login WHERE sex='S' AND state=0; SELECT COUNT(*) FROM login WHERE account_id=1 AND BINARY userid='s1' AND sex='S' AND state=0;", legacy)?;
    if services.lines().collect::<Vec<_>>() != ["1", "1"] {
        return Err("This database has custom or disabled interserver accounts. Migrate those accounts explicitly before enabling managed service credentials; player accounts were not changed.".into());
    }
    let users = dk.root_sql("SELECT COUNT(*) FROM mysql.user WHERE User='root' AND Host='localhost'; SELECT COUNT(*) FROM mysql.user WHERE User='ragnarok' AND Host='%'; SELECT COUNT(*) FROM mysql.user WHERE (User='root' AND Host<>'localhost') OR (User='ragnarok' AND Host<>'%');", legacy)?;
    if users.lines().collect::<Vec<_>>() != ["1", "1", "0"] {
        return Err("This database has custom SQL service accounts. Migrate them explicitly before enabling managed credentials; player accounts were not changed.".into());
    }
    Ok(())
}

/// Tables the mod reader never sees: `login` holds every account's password
/// hash, e-mail and web token; `mod_store` holds every mod's own data, which
/// only that mod may read (through the store, not SQL).
const MOD_READER_HIDDEN: [&str; 2] = ["login", "mod_store"];

/// The mod store's limits (rathena's mod_store_* battle settings), set here per
/// release: raising one is a change to this table and nothing else, and a mod
/// that needs more says so with requires.app. See docs/MOD_STORE.md.
pub const MOD_STORE_LIMITS: [(&str, u64); 5] = [
    ("mod_store_global_bytes", 1024 * 1024),
    ("mod_store_account_bytes", 64 * 1024),
    ("mod_store_char_bytes", 64 * 1024),
    ("mod_store_value_bytes", 4096),
    ("mod_store_depth", 8),
];
const MOD_STORE_CONF: &str = "mod_store_conf.txt";

/// The store's table: the fork's own definition (sql-files/main.sql and
/// upgrade_20261005.sql), repeated here so a world made before it has it. The
/// map server only reads and writes it.
const MOD_STORE_TABLE_SQL: &str = "CREATE TABLE IF NOT EXISTS `mod_store` (
  `mod_name` varchar(64) CHARACTER SET ascii NOT NULL,
  `scope` tinyint unsigned NOT NULL,
  `owner` int unsigned NOT NULL DEFAULT '0',
  `path` varchar(255) CHARACTER SET ascii NOT NULL,
  `kind` char(1) CHARACTER SET ascii NOT NULL DEFAULT 'i',
  `num` bigint NOT NULL DEFAULT '0',
  `str` mediumblob NULL,
  PRIMARY KEY (`mod_name`, `scope`, `owner`, `path`)
) ENGINE=MyISAM;";

/// The limits file, and the battle config's `import:` of it. battle_conf.txt is
/// the shell's (it rewrites it from Settings before every start), so the line
/// is put back here each time rather than written once.
fn write_mod_store_limits(conf: &Path) -> Result<(), String> {
    let limits: String = MOD_STORE_LIMITS.iter().map(|(key, value)| format!("{key}: {value}\n")).collect();
    write_conf(conf, MOD_STORE_CONF, &limits)?;
    let battle = conf.join("battle_conf.txt");
    let existing = fs::read_to_string(&battle).unwrap_or_default();
    let import = format!("import: conf/import/{MOD_STORE_CONF}");
    if !existing.lines().any(|line| line.trim() == import) {
        let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        fs::write(&battle, format!("{existing}{sep}{import}\n")).map_err(|_| "Cannot write the battle configuration")?;
    }
    Ok(())
}

/// Statements that create the mod reader (or reset its password to the one on
/// disk) and take back whatever it was granted before.
fn mod_reader_setup_sql(password: &str) -> String {
    let user = format!("'{}'@'%'", crate::service_credentials::MOD_READER);
    format!(
        "CREATE USER IF NOT EXISTS {user} IDENTIFIED BY '{password}'; \
         ALTER USER {user} IDENTIFIED BY '{password}'; \
         REVOKE ALL PRIVILEGES, GRANT OPTION FROM {user};"
    )
}

/// One `GRANT SELECT` per table in `tables` (one name per line, as
/// information_schema lists them), skipping the hidden ones and any name that
/// isn't a plain identifier. Batched so a large schema stays under the SQL
/// input limit.
fn mod_reader_grant_sql(tables: &str) -> Vec<String> {
    let user = format!("'{}'@'%'", crate::service_credentials::MOD_READER);
    let grants: Vec<String> = tables
        .lines()
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .filter(|t| !MOD_READER_HIDDEN.contains(t))
        .map(|t| format!("GRANT SELECT ON `ragnarok`.`{t}` TO {user};"))
        .collect();
    grants.chunks(100).map(|c| c.join(" ")).collect()
}

/// The login mods' scripts query as (rathena's map_query_server_id and
/// log_query_db_id): SELECT on every table but the hidden ones, and nothing
/// else -- no writes, no DDL, no FILE. Redone on every start, so tables added
/// since the last one are readable and the grants never drift.
///
/// It only counts once the database confirms the grants. A reader with none
/// can log in but not open the database, and rathena stops the map server when
/// script SQL can't connect -- so a run that can't confirm them falls back to
/// the map server's own login instead (the caller drops the reader).
fn grant_mod_reader(dk: &Docker, password: &str, legacy_root: bool) -> Result<(), String> {
    dk.root_sql(&mod_reader_setup_sql(password), legacy_root)
        .map_err(|_| "could not create the read-only login")?;
    let tables = dk.root_sql(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE';",
        legacy_root,
    )?;
    let expected = mod_reader_grant_count(&tables)?;
    for batch in mod_reader_grant_sql(&tables) {
        dk.root_sql(&batch, legacy_root).map_err(|_| "could not grant it read access")?;
    }
    let granted = dk.root_sql(MOD_READER_GRANTS_SQL, legacy_root)
        .map_err(|_| "could not confirm its read access")?;
    mod_reader_grants_confirmed(expected, &granted)
}

/// How many SELECT grants the reader holds on the game's database.
const MOD_READER_GRANTS_SQL: &str = "SELECT COUNT(*) FROM information_schema.table_privileges \
     WHERE grantee = CONCAT(QUOTE('ragnarok_mods'), '@', QUOTE('%')) \
     AND table_schema = 'ragnarok' AND privilege_type = 'SELECT';";

/// The number of tables the reader is about to be granted. None is an error,
/// never "nothing to do": the schema always has tables, so an empty list means
/// the answer was lost on the way back, and granting nothing leaves a
/// login the map server can't use.
fn mod_reader_grant_count(tables: &str) -> Result<usize, String> {
    let n: usize = mod_reader_grant_sql(tables).iter().map(|b| b.matches("GRANT SELECT").count()).sum();
    if n == 0 { return Err("could not list the tables to grant it".into()); }
    Ok(n)
}

/// Whether the database's count of the reader's grants (`answer`) covers every
/// table granted. Anything else -- fewer, nothing, an unreadable answer -- is
/// not a confirmation.
fn mod_reader_grants_confirmed(expected: usize, answer: &str) -> Result<(), String> {
    match answer.trim().parse::<usize>() {
        Ok(n) if n >= expected => Ok(()),
        Ok(n) => Err(format!("only {n} of its {expected} grants took effect")),
        Err(_) => Err("could not confirm its read access".into()),
    }
}

fn migrate_service_credentials(dk: &Docker, credentials: &crate::service_credentials::Credentials) -> Result<(), String> {
    // Pending journals may be retried after any individual ALTER succeeds.
    // Ready journals never fall back to the published legacy root password.
    let mut legacy = false;
    let mut connected = false;
    for _ in 0..90 {
        if dk.root_sql("SELECT 1 FROM login LIMIT 1;", false).is_ok() { connected = true; break; }
        if !credentials.ready && dk.root_sql("SELECT 1 FROM login LIMIT 1;", true).is_ok() { legacy = true; connected = true; break; }
        sleep(Duration::from_secs(2));
    }
    if !connected { return Err("Cannot authenticate the era's database using its credential journal. Preserve the journal and database; restore a matching backup to recover.".into()); }
    audit_service_accounts(dk, legacy)?;
    // All inserted values are generated/validated ASCII tokens, never player
    // input. DDL commits individually, which is why the journal precedes this.
    dk.root_sql(&format!("ALTER USER 'ragnarok'@'%' IDENTIFIED BY '{}'; UPDATE login SET user_pass='{}' WHERE account_id=1 AND BINARY userid='s1' AND sex='S'; ALTER USER 'root'@'localhost' IDENTIFIED BY '{}';", credentials.database, credentials.interserver, credentials.root), legacy)?;
    if dk.root_sql("SELECT 1;", false)?.trim() != "1" || dk.private_sql("SELECT 1;")?.trim() != "1" {
        return Err("New service credentials did not verify. Keep the journal and retry startup; no game service was started.".into());
    }
    let verified = dk.private_sql(&format!("SELECT COUNT(*) FROM login WHERE account_id=1 AND BINARY userid='s1' AND sex='S' AND state=0 AND BINARY user_pass='{}';", credentials.interserver))?;
    if verified.trim() != "1" { return Err("Interserver credentials did not verify; game services remain stopped.".into()); }
    credentials.mark_ready()
}

pub fn secure_services(cfg: &Config, dk: &Docker, lan: bool, ram_mib: Option<u32>) -> Result<(), String> {
    crate::registration::enabled(&cfg.state)?;
    dk.require_private_sql()?;
    crate::accounts::verify_era(cfg, dk, crate::service_credentials::era(cfg))?;
    ensure_images(cfg, dk)?;
    require_private_database_image(cfg, dk)?;
    if crate::service_credentials::load(&cfg.state, crate::service_credentials::era(cfg))?.is_none() {
        audit_service_accounts(dk, true)?;
        // The backup must complete before publishing a migration journal. It
        // includes all player data; secure its host directory before writing.
        crate::private_fs::directory(&cfg.state)?;
        let backups = cfg.state.join("backups"); crate::private_fs::directory(&backups)?;
        stop_game_services(cfg, dk)?;
        let destination = backups.join(format!("before-service-credentials-{}-{}.sql", crate::service_credentials::era(cfg), crate::private_fs::random_hex(8)?));
        if let Err(error) = backup_snapshot(cfg, dk, &destination.to_string_lossy(), true) {
            return Err(format!("Service credentials were not changed: {error}. Start the server to reconnect."));
        }
        crate::private_fs::protect(&destination, false)?;
    }
    crate::service_credentials::prepare(cfg)?;
    up(cfg, dk, lan, ram_mib)?;
    println!("Internal service credentials secured for {}. Player accounts and characters were preserved.", crate::service_credentials::era(cfg));
    Ok(())
}

pub fn up(cfg: &Config, dk: &Docker, lan: bool, ram_mib: Option<u32>) -> Result<(), String> {
    // Validate before touching the engine or replacing any running service.
    let open_registration = crate::registration::enabled(&cfg.state)?;
    let packetver = crate::packetver::chosen(cfg)?;
    // Era-aware: a scope saved against an era that was never prepared for
    // internet hosting starts Local rather than refusing to start at all.
    let (scope, hosting_notice) = crate::hosting::effective_for_start(cfg, lan)?;
    crate::hosting::before_start(cfg, scope)?;
    if let Some(notice) = &hosting_notice {
        println!("{notice}");
    }
    let lan = scope.lan();
    let credentials = crate::service_credentials::load(&cfg.state, crate::service_credentials::era(cfg))?;
    // Every install's mods query as the read-only mod reader, managed
    // credentials or not. A password that can't be made is logged, not fatal.
    let mut mod_reader = crate::service_credentials::mod_reader_password(&cfg.state, crate::service_credentials::era(cfg))
        .map_err(|error| eprintln!("warning: mods' database access is not read-only this time: {error}"))
        .ok();
    let conf = cfg.state.join("conf");
    for d in ["conf", "sql", "backups"] {
        fs::create_dir_all(cfg.state.join(d)).map_err(|e| format!("creating {d}: {e}"))?;
    }
    // Clear the previous run's result immediately: leaving "Ready" in place
    // while this run is still starting makes anything polling the file believe
    // in a stack that is not there yet.
    phase(cfg, "Starting…");
    let _lock = Lock::acquire(cfg)?;
    phase(cfg, "Starting the virtual machine…");
    ensure_engine(cfg, dk, lan, ram_mib)?;
    if let Some(credentials) = &credentials {
        credentials.write_files()?;
        protect_game_config(cfg)?;
        // Recreate the database with the private bind/copy, including after a
        // failed migration or a runtime update. Flush players first.
        stop_game_services(cfg, dk)?;
        if dk.is_running(DB_CONTAINER) && (dk.output(["stop", "-t", "30", DB_CONTAINER]).is_err() || dk.is_running(DB_CONTAINER)) {
            return Err("Could not stop the database cleanly; credentials were not changed".into());
        }
        dk.remove_container(DB_CONTAINER);
    }

    // A failed single-file bind leaves a directory behind at the source path.
    // Clear anything in conf/ that is not a regular file so a stale one cannot
    // shadow the config about to be written.
    if let Ok(rd) = fs::read_dir(&conf) {
        for e in rd.flatten() {
            if !e.path().is_file() {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    // The schema ships with the app; seed it on first run so MariaDB's
    // entrypoint imports it instead of coming up empty.
    if let Ok(rd) = fs::read_dir(cfg.root.join("sql")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "sql").unwrap_or(false) {
                let dest = cfg.state.join("sql").join(e.file_name());
                if !dest.exists() {
                    let _ = fs::copy(&p, &dest);
                }
            }
        }
    }
    // Create if absent, never truncate: settings are written here and the stack
    // restarted, so clobbering would discard every setting as it was applied.
    let battle = conf.join("battle_conf.txt");
    if !battle.exists() {
        let _ = fs::write(&battle, "");
    }
    write_mod_store_limits(&conf)?;

    ensure_images(cfg, dk)?;
    if credentials.is_some() { require_private_database_image(cfg, dk)?; }
    crate::packetver::require_in_image(cfg, dk, packetver)?;
    dk.quiet(["network", "create", NET]);

    // The era decides which volume holds the characters, and a running database
    // is otherwise left alone -- so without this, switching era keeps the
    // database that is already up and the player stays on the wrong save with
    // nothing to say why. Recorded rather than inspected: the container may not
    // exist yet, and the answer has to survive a restart.
    let want_volume = db_volume(cfg);
    let volume_marker = cfg.state.join(".db-volume");
    let had_volume = fs::read_to_string(&volume_marker).ok().map(|s| s.trim().to_string());
    if had_volume.as_deref() != Some(want_volume.as_str()) {
        // Flush the old era while its database is still available. Replacing
        // MariaDB first leaves live game services with stale connections and
        // kills their chance to save when run_server later removes them.
        // Stop MariaDB cleanly too; rm -f would make every era switch a crash
        // recovery (including MyISAM tables such as loginlog).
        for service in [WEB_SERVER, "ragnarok-map", "ragnarok-char", "ragnarok-login", DB_CONTAINER] {
            if dk.is_running(service)
                && (dk.output(["stop", "-t", "30", service]).is_err() || dk.is_running(service))
            {
                return Err(format!("Could not stop {service}; the era database was not switched. Start again to retry."));
            }
        }
        dk.remove_container(DB_CONTAINER);
    }

    if !dk.is_running(DB_CONTAINER) {
        start_database(cfg, dk, &want_volume, credentials.as_ref())?;
    }
    // After a successful start, so a failed one does not record a database
    // that is not running.
    let _ = fs::write(&volume_marker, &want_volume);
    phase(cfg, "Starting the database…");
    if let Some(credentials) = &credentials { migrate_service_credentials(dk, credentials)?; }
    wait_for_db(dk)?;
    // Before the reader's grants, which list the tables. Without it the map
    // server starts with the store off and says so; the game is unaffected.
    if let Err(e) = dk.private_sql(MOD_STORE_TABLE_SQL) {
        eprintln!("warning: mods can't keep data this time: preparing the mod store's table: {e}");
    }
    if let Some(password) = mod_reader.as_deref() {
        // Root's login: the managed one once migrated, else the install's
        // default. Never a reason not to start: without the reader, scripts'
        // SQL keeps the map server's own login, as before, and the log says so.
        let legacy_root = credentials.is_none();
        match grant_mod_reader(dk, password, legacy_root) {
            Ok(()) => println!("Mods read the database as {}: SELECT only, never `login`.", crate::service_credentials::MOD_READER),
            Err(error) => {
                eprintln!("warning: mods' database access is not read-only this time: {error}");
                mod_reader = None;
            }
        }
    }
    // The login server turns plain-text passwords into salted hashes the
    // first time it starts on a world from before 1.4.0, and that can't be
    // undone: an earlier release can no longer log those accounts in. Keep a
    // copy of the database as it was, first. The game servers are not up yet.
    //
    // If that backup can't be taken, the world still starts: hashing waits
    // (`hash_passwords: no` below), passwords stay exactly as they were, and
    // both are tried again on the next start. Refusing to start would lock
    // the player out of their world over a backup they never asked for.
    let backups = cfg.state.join("backups");
    let mut defer_hashing = false;
    if !hashing_backup_exists(&backups) && crate::accounts::plaintext_passwords(dk)? {
        crate::private_fs::directory(&backups)?;
        let copy = backups.join(format!("before-password-hashing-{}.sql", crate::private_fs::random_hex(8)?));
        match backup_snapshot(cfg, dk, &copy.to_string_lossy(), false) {
            Ok(()) => phase(cfg, "Saved a backup of the accounts before securing their passwords…"),
            Err(e) => {
                eprintln!("password hashing postponed: backing up the database first failed: {e}");
                phase(cfg, &format!("Couldn't back up the accounts before securing their passwords, so they stay as they are for now. It will try again next start. ({e})"));
                defer_hashing = true;
            }
        }
    }
    crate::accounts::ensure_password_columns(dk)?;
    // Sign in with Google or Apple: the login server's one-time token table and
    // our identity table. Before the game servers, so the login server never
    // starts without the table it checks tokens against.
    crate::sign_in::ensure_sign_in_tables(dk)?;
    // Remembered logins for the autologin mod (remember.rs): exchanged for
    // the login tokens of the table above, so made after it.
    crate::remember::ensure_remember_table(dk)?;

    // Only sql/03-account.sql seeds the GM, during first database creation.
    // An existing database may intentionally have renamed, disabled or deleted
    // it. Startup, Repair and era switches must never recreate known credentials.

    // The population engine writes its live shell count here on every autosummon
    // tick. Created here rather than in sql/ for the same reason as the account
    // above: initdb.d runs once, and an install predating the engine would log a
    // failed INSERT every ten seconds instead.
    let _ = dk.exec_sql(
        "CREATE TABLE IF NOT EXISTS `cp_population_stats` (
           `id`           INT UNSIGNED NOT NULL DEFAULT 1,
           `active_count` INT UNSIGNED NOT NULL DEFAULT 0,
           `last_updated` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
           PRIMARY KEY (`id`)
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
    );

    // Companion persistence, after the database is up and before any game server
    // can read it. An error stops the start: a map server without this table logs a
    // failed query on every recall and snapshot, and nothing on screen says why.
    ensure_companion_table(dk)?;
    ensure_guild_emblems_table(dk)?;

    // Every client arrives through the WebSocket proxy, so every connection has
    // the same source address; rAthena's per-IP flood protection trips on sight
    // and blocks for ten minutes, silently. And after character select the
    // client sits on the char socket parsing its databases, which can exceed
    // the default 60s stall_time on a modern client.
    write_conf(&conf, "packet_conf.txt", "stall_time: 300\nenable_ip_rules: no\n")?;
    write_conf(&conf, "web_conf.txt", &cfg.ports.web_conf())?;
    write_conf(&conf, "inter_conf.txt", concat!(
        "login_server_ip: ragnarok-db\n", "ipban_db_ip: ragnarok-db\n",
        "char_server_ip: ragnarok-db\n", "map_server_ip: ragnarok-db\n",
        "web_server_ip: ragnarok-db\n", "log_db_ip: ragnarok-db\n"))?;
    if let Some(credentials) = &credentials {
        let file = conf.join("inter_conf.txt");
        let existing = fs::read_to_string(&file).map_err(|_| "Cannot read generated SQL configuration")?;
        write_conf(&conf, "inter_conf.txt", &format!("{existing}{}", credentials.inter_config()))?;
    }
    if let Some(password) = &mod_reader {
        let file = conf.join("inter_conf.txt");
        let existing = fs::read_to_string(&file).map_err(|_| "Cannot read generated SQL configuration")?;
        write_conf(&conf, "inter_conf.txt", &format!("{existing}{}", crate::service_credentials::mod_reader_config(password)))?;
    }
    // The address char and map hand the client to reconnect to. This is the
    // one that actually decides whether a LAN player can play: everything can
    // be bound wide and reachable, and the client will still be told to go to
    // 127.0.0.1 -- its own machine -- and fail with nothing in any log to say
    // why.
    let advertise = if lan {
        lan_ip().map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into())
    } else {
        "127.0.0.1".into()
    };
    if lan && advertise == "127.0.0.1" {
        eprintln!("LAN hosting was requested but no network address was found; \
                   falling back to loopback, which only this machine can reach");
    }
    // PIN codes are a live-service anti-theft feature; offline they are just a
    // second password screen.
    // One start point, not the five rAthena ships.
    //
    // Renewal's default is a colon-separated list -- iz_int through iz_int04 --
    // and a new character is assigned one at random. Each tutorial room exits
    // into its own copy of Izlude (izlude, izlude_a .. izlude_d), which are
    // separate maps that look nearly identical. Two friends who join the same
    // server and walk to "the same place in Izlude" can end up on different
    // maps, unable to see each other, with nothing to suggest why: same town,
    // same coordinates, no one there.
    //
    // Those duplicates exist to spread load across a live server's population.
    // This is a handful of friends, so the split costs everything and buys
    // nothing.
    // iz_int is a renewal map and MAP_NOVICE is "new_1-1" pre-renewal
    // (src/common/mapindex.hpp). A pre-renewal char-server reads
    // start_point_pre and ignores start_point entirely, so writing the wrong
    // key leaves new characters with no start point at all.
    let start_point = if is_prerenewal(cfg) {
        "start_point_pre: new_1-1,53,111"
    } else {
        "start_point: iz_int,18,26"
    };

    // Mods are assembled here, before the map server is started and before
    // map_conf names their scripts: the mount and the config have to agree, and
    // both are derived from the same pass over state/mods. It also has to
    // happen before char_conf is written, because a mod may set the start
    // point and that line has to be in the file rather than after it.
    let mods = crate::mods::assemble(cfg)?;
    if !mods.names.is_empty() {
        println!("mods: {}", mods.names.join(", "));
    }
    if !mods.maps.is_empty() {
        println!("mod maps: {}", mods.maps.join(", "));
    }
    // Named, one per line, so the reason reaches the log as well as Settings.
    for (name, why) in &mods.refused {
        eprintln!("mods: {name} was not applied -- {why}");
    }
    // Before the servers start, and after the database is up: a character left
    // on a map that a removed mod used to provide cannot be selected at all.
    rescue_stranded_characters(cfg, dk, &mods.maps);
    write_mod_conf_files(cfg, &mods)?;
    // Owner account policy is final, after mod assembly, and regenerated for
    // startup, Repair and each era. Mods cannot reopen suffix registration.
    let mut login_config = crate::registration::login_config(open_registration);
    // Browser clients share the proxy's source IP. Friends mode replaces
    // automatic IP-wide password bans with the gateway's account/session
    // attempt limits. Local/LAN mode and explicit IP bans retain defaults.
    if scope == crate::hosting::Scope::Friends {
        login_config.push_str("ipban_dynamic_pass_failure_ban: no\n");
    }
    // The listen ports go last in each file: rAthena keeps the last assignment,
    // so nothing earlier -- a mod's allowlisted settings included -- can move
    // a server off the port the client will be sent to (ports.rs).
    if defer_hashing {
        login_config.push_str("hash_passwords: no\n");
    }
    let ports = cfg.ports;
    login_config.push_str(&ports.login_conf());
    write_conf(&conf, "login_conf.txt", &login_config)?;
    if scope.internet() { crate::hosting::require_game_policy(cfg, dk)?; }

    // A mod's allowlisted settings go after ours, because rAthena's config
    // reader takes the last assignment of a key: start_point in particular is
    // parsed by char_config_split_startpoint, which clears the array before
    // filling it, so the last line is the whole answer rather than an addition.
    let instant_deletion = crate::registration::instant_character_deletion(&cfg.state)?;
    write_conf(&conf, "char_conf.txt",
        &format!("login_ip: ragnarok-login\nchar_ip: {advertise}\npincode_enabled: no\n{}\
                  {start_point}\n{}{}{}", crate::registration::character_config(instant_deletion),
                  conf_lines(&mods, "char_conf.txt"),
                  credentials.as_ref().map(|c| format!("userid: s1\npasswd: {}\n", c.interserver)).unwrap_or_default(),
                  ports.char_conf()))?;

    let product = if cfg!(target_os = "macos") { "RagnarokMac" }
        else if cfg!(windows) { "RagnarokWindows" }
        else if cfg!(target_os = "linux") { "RagnarokLinux" }
        else { "Ragnarok" };
    write_conf(&conf, "motd.txt",
        &format!("Welcome to {product} Offline! Please report any bugs on Github\n"))?;
    write_conf(&conf, "map_conf.txt",
        &format!("char_ip: ragnarok-char\nmap_ip: {advertise}\nmotd_txt: conf/import/motd.txt\n{}{}{}{}{}",
                 conf_lines(&mods, "map_conf.txt"), mods.map_lines, mods.npc_lines,
                 credentials.as_ref().map(|c| format!("userid: s1\npasswd: {}\n", c.interserver)).unwrap_or_default(),
                 ports.map_conf()))?;

    let endpoint = endpoint_json(&advertise, &ports);
    fs::write(cfg.state.join("endpoint.json"), &endpoint)
        .map_err(|e| format!("writing endpoint.json: {e}"))?;
    // The game page reads this from the asset server's static root. It exists
    // so LAN mode can later advertise a different address.
    let web = cfg.root.join("vendor/roBrowserLegacy/dist/Web");
    if web.is_dir() {
        let _ = fs::write(web.join("endpoint.json"), &endpoint);
    }

    if credentials.is_some() { finish_game_config(cfg)?; }
    prepare_kafra_scripts(cfg, dk);
    phase(cfg, "Starting the login, character and map servers…");
    // login and web are era-independent -- neither src/login nor src/web
    // mentions RENEWAL -- so only char and map come in two builds. They must
    // match each other: src/common/mmo.hpp changes shape under RENEWAL and the
    // two talk over those structures.
    // A suffix, not a subdirectory: rAthena chdirs to the directory of argv[0]
    // and then reads conf/, db/ and npc/ relative to it, so both eras have to
    // live in /rathena itself.
    //
    // The packet version is a second suffix after the era's, and applies to
    // all three: packets.hpp is compiled into login and char as well as map.
    let era = if is_prerenewal(cfg) { "-prere" } else { "" };
    let ver = crate::packetver::suffix(packetver);
    // Published one to one: each server listens inside its container on the
    // very port it is reached on, because that is the number it hands the
    // client (login names char's, char names map's).
    run_server(cfg, dk, "ragnarok-login", ports.login, &format!("/rathena/login-server{ver}"), lan)?;
    run_server(cfg, dk, "ragnarok-char", ports.char, &format!("/rathena/char-server{era}{ver}"), lan)?;
    run_server(cfg, dk, "ragnarok-map", ports.map, &format!("/rathena/map-server{era}{ver}"), lan)?;
    // Loopback even when hosting: players reach it through the asset server,
    // which forwards only the two emblem paths. Its build is era-independent.
    if let Err(e) = run_server(cfg, dk, WEB_SERVER, ports.web, &format!("/rathena/web-server{ver}"), false) {
        eprintln!("warning: guild emblems are unavailable: {e}");
    }
    phase(cfg, "Loading maps and NPCs…");
    wait_for_maps(dk)?;
    // After the map server has read its tables and before anyone is told the
    // world is ready: this is the only moment rAthena's verdict on the mods'
    // own tables exists, and it exists in its log and nowhere else.
    crate::mods::record_load_report(cfg, dk);
    // Every container is now on the current images, so whatever an update
    // left behind is free to go.
    prune_old_images(dk);
    phase(cfg, "Ready");
    println!("stack up");
    // The one string a host pastes to a friend. Printed rather than only
    // written, so it is visible from a terminal too.
    if lan {
        println!("join address: http://{advertise}:{}/", ports.asset);
    }
    Ok(())
}

/// What `up` tells the shell about where the game servers are.
fn endpoint_json(advertise: &str, ports: &crate::ports::Ports) -> String {
    format!(
        "{{\"host\":\"{advertise}\",\"login\":{},\"char\":{},\"map\":{},\"asset\":{}}}\n",
        ports.login, ports.char, ports.map, ports.asset
    )
}

pub fn down(cfg: &Config, dk: &Docker) -> Result<(), String> {
    let _lock = Lock::acquire(cfg)?;
    stop_game_services(cfg, dk)?;
    for c in SERVERS {
        dk.remove_container(c);
    }
    dk.remove_container(WEB_SERVER);
    if dk.is_running(DB_CONTAINER) && (dk.output(["stop", "-t", "30", DB_CONTAINER]).is_err() || dk.is_running(DB_CONTAINER)) {
        return Err("Could not stop the database cleanly; the VM was left running to protect the save.".into());
    }
    dk.remove_container(DB_CONTAINER);

    // And the microVM itself, last -- after the database has closed cleanly,
    // never before.
    //
    // This used to be left running on the theory that the next start would be
    // quicker for it. The cost is worse than the saving: a VM holding a 4 GiB
    // ceiling stays resident after the player has quit the app, which on a
    // laptop is simply battery burned for nothing. On Windows it is worse
    // still -- the engine runs out of the runtime directory, and Windows locks
    // a running executable, so the next version could not replace the tree and
    // the app refused to start with "EBUSY: resource busy or locked". They
    // also accumulated, one per version installed.
    //
    // Booting the VM again costs a couple of seconds, which is the right side
    // of that trade.
    phase(cfg, "Stopping the virtual machine…");
    let _ = nebula(cfg, &["down"]);
    // "Stopped" only once it is. `nebula down` used to return as soon as the
    // daemon had been asked, and on Windows the engine then took another two
    // and a half minutes to leave -- with "Stopped" on screen the whole time,
    // so the next Start ran into it and failed after three minutes blaming
    // the hypervisor (#119). Newer engines wait themselves; this covers the
    // ones that do not.
    if !wait_for_engine_exit(cfg, ENGINE_DEPART_BUDGET) {
        return Err("The virtual machine is still shutting down. Wait a minute, then start again.".into());
    }

    phase(cfg, "Stopped");
    println!("stack down");
    Ok(())
}

/// Long enough for the slowest stop measured: about 150 s, on Windows, from an
/// engine that has to time out twice before it forces the VM off.
const ENGINE_DEPART_BUDGET: Duration = Duration::from_secs(180);

/// What the engine is doing, by its own account.
#[derive(Debug, PartialEq, Eq)]
enum EngineState {
    /// No daemon: nothing to wait for and nothing in the way.
    Gone,
    Running,
    /// A daemon that answers but has no running VM. The watchdog ends one of
    /// those within seconds, so it is always on its way out.
    Departing,
}

/// Read `nebula status` output.
///
/// Anything short of the two definite answers counts as departing, including
/// no output at all: an engine too busy stopping to answer is the case this
/// exists for.
fn engine_state_from_status(out: &str) -> EngineState {
    if out.contains("daemon not running") {
        EngineState::Gone
    } else if out.contains("nebula: running") {
        EngineState::Running
    } else {
        EngineState::Departing
    }
}

/// Ask the engine, with a deadline.
///
/// A deadline because the question can hang: an older daemon answers `status`
/// by asking a guest that may already have halted, and never gives up. Output
/// goes to a file for the reason given in `nebula`.
fn engine_state(cfg: &Config) -> EngineState {
    let log = std::env::temp_dir().join(format!("nebula-status-{}.out", std::process::id()));
    let Ok(sink) = fs::File::create(&log) else {
        return EngineState::Departing;
    };
    let child = Command::new(&cfg.nebula)
        .arg("status")
        .env("NEBULA_HOME", &cfg.nebula_home)
        .stdout(Stdio::from(sink))
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        // No engine binary is no engine.
        let _ = fs::remove_file(&log);
        return EngineState::Gone;
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(None) if std::time::Instant::now() < deadline => sleep(Duration::from_millis(100)),
            Ok(Some(_)) => break,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let out = fs::read_to_string(&log).unwrap_or_default();
    let _ = fs::remove_file(&log);
    engine_state_from_status(&out)
}

/// Wait until no engine daemon is left. False if one still is after `budget`.
///
/// For an engine that has been asked to stop. That includes one still saying
/// "running": an older daemon reports its VM as running for the whole graceful
/// timeout, because the guest has halted and the worker has not.
fn wait_for_engine_exit(cfg: &Config, budget: Duration) -> bool {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if engine_state(cfg) == EngineState::Gone {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        sleep(Duration::from_secs(1));
    }
}

/// Emitted as "<name>\tUp|<state>" rather than raw `ps` output: the name is the
/// last column there, so anything matching "<name> ... Up" never matches.
pub fn status(dk: &Docker) {
    let mut all = vec![DB_CONTAINER];
    all.extend(SERVERS);
    let mut out = String::new();
    for c in all {
        let st = dk.state(c).unwrap_or_else(|| "absent".into());
        let shown = if st == "running" { "Up" } else { &st };
        out.push_str(&format!("{c}\t{shown}\n"));
    }
    print!("{out}");
}

/// Run SQL against the running era's game database.
///
/// The app never calls this. It exists because questions like "is that
/// homunculus still attached to my character?" have no answer anywhere in the
/// UI, and the database is three layers down -- a container, inside a microVM,
/// on a network that publishes no port -- so before this there was no way to
/// look that did not involve rebuilding this path by hand.
///
/// Reads run against the live server. Writes do not: `--write` stops the game
/// first, because rAthena holds characters, homunculi and pets in memory and
/// writes them back on save, so an edit made underneath a running map server
/// is either ignored or overwritten within the minute. That is the single
/// most expensive thing to get wrong here, and it is invisible when it
/// happens -- the UPDATE reports a row changed and the game changes nothing.
pub fn sql(cfg: &Config, dk: &Docker, args: &[String]) -> Result<(), String> {
    let mut write = false;
    let mut from_file: Option<String> = None;
    let mut words: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--write" => write = true,
            "--file" => {
                let path = args.get(i + 1).ok_or("--file needs a path")?;
                from_file = Some(fs::read_to_string(path).map_err(|e| format!("reading {path}: {e}"))?);
                i += 1;
            }
            other if other.starts_with("--") => return Err(format!("unknown option {other}")),
            other => words.push(other),
        }
        i += 1;
    }

    let script = match from_file {
        Some(body) if !words.is_empty() => {
            let _ = body;
            return Err("Give either --file or a statement, not both".into());
        }
        Some(body) => body,
        // argv, or stdin when there is nothing in argv: a heredoc is the only
        // comfortable way to type a statement carrying quotes.
        None if words.is_empty() => {
            let mut body = String::new();
            std::io::stdin()
                .take(crate::docker::SQL_INPUT_LIMIT as u64 + 1)
                .read_to_string(&mut body)
                .map_err(|e| format!("reading the statement: {e}"))?;
            body
        }
        None => words.join(" "),
    };
    if script.trim().is_empty() {
        return Err("No statement given. Pass one as an argument, with --file, or on stdin.".into());
    }

    // Before anything is started or stopped: this is a check on what was
    // typed, and it should answer without a server running.
    if !write {
        read_only(&script)?;
    }

    // Which era's database is actually mounted, not which one settings prefer:
    // the two disagree after a failed era switch, and the wrong answer here
    // means editing the characters of a world the player is not in.
    crate::accounts::verify_era(cfg, dk, crate::service_credentials::era(cfg))?;

    let output = if write {
        crate::accounts::with_servers_stopped(cfg, dk, "SQL", || {
            // The same safety copy `restore` takes, and for the same reason:
            // whatever is about to run was typed by hand, and MyISAM -- which
            // is what `char` and `homunculus` are -- has no transaction to
            // roll back.
            let safety = cfg.state.join("backups").join(format!(
                "before-sql-{}-{}.sql",
                crate::service_credentials::era(cfg),
                crate::private_fs::random_hex(8)?
            ));
            backup_snapshot(cfg, dk, &safety.to_string_lossy(), false)?;
            eprintln!("saved {} first", safety.display());
            dk.console_sql(&script)
        })?
    } else {
        dk.console_sql(&script)?
    };

    // Rows to stdout, everything else to stderr, so the output stays a
    // pipeable TSV table for whoever or whatever is reading it.
    print!("{output}");
    if write {
        eprintln!("applied; game services are back as they were");
    }
    Ok(())
}

/// A mod name as the store keys it: the mod's folder name (lowercase letters,
/// digits, `-`, `_`), so it can go into SQL as a literal.
fn mod_store_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if ok { Ok(name) } else { Err(format!("{name:?} is not a mod name")) }
}

/// `mod-data-reset <mod>`: delete everything `mod` keeps in the store, in every
/// scope and for every player. The map server keeps documents in memory and
/// would write them back, so the game is stopped around it, and a backup is
/// saved first, as for `sql --write`.
pub fn mod_data_reset(cfg: &Config, dk: &Docker, name: &str) -> Result<(), String> {
    let name = mod_store_name(name)?;
    crate::accounts::verify_era(cfg, dk, crate::service_credentials::era(cfg))?;
    let exists = dk.console_sql("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'mod_store';")?;
    if exists.trim() != "1" {
        println!("{name} has no data: the mod store has not been used in this world yet.");
        return Ok(());
    }
    let removed = crate::accounts::with_servers_stopped(cfg, dk, "mod data", || {
        let safety = cfg.state.join("backups").join(format!(
            "before-mod-data-reset-{name}-{}-{}.sql",
            crate::service_credentials::era(cfg),
            crate::private_fs::random_hex(8)?
        ));
        backup_snapshot(cfg, dk, &safety.to_string_lossy(), false)?;
        eprintln!("saved {} first", safety.display());
        dk.console_sql(&format!("DELETE FROM mod_store WHERE mod_name = '{name}'; SELECT ROW_COUNT();"))
    })?;
    println!("{name}: {} stored value(s) deleted.", removed.trim());
    Ok(())
}

/// Statements a read may begin with.
///
/// `WITH` is absent on purpose: MariaDB lets a common table expression lead
/// into UPDATE and DELETE, so it is not the read-only keyword it looks like.
const READS: [&str; 5] = ["select", "show", "describe", "desc", "explain"];

fn read_only(script: &str) -> Result<(), String> {
    for word in leading_words(script) {
        if !READS.contains(&word.to_ascii_lowercase().as_str()) {
            let named = if word.is_empty() { "That".into() } else { format!("`{word}`") };
            return Err(format!(
                "{named} is not a read, and sql reads by default. Run it again with --write, \
                 which saves a backup, stops the game, applies the statements and starts it again."
            ));
        }
    }
    Ok(())
}

/// The first word of every statement in a script.
///
/// Not a SQL parser and not a sandbox: it is here so that a mistyped UPDATE is
/// refused instead of run, which is the failure that actually happens. All it
/// has to know is where one statement ends and the next begins, and that means
/// recognising the `;` that does not count -- inside a string, inside an
/// identifier, inside a comment.
///
/// A statement that starts with anything but a bare word yields an empty
/// string, which no keyword matches, so the guard refuses it rather than
/// guessing.
pub(crate) fn leading_words(script: &str) -> Vec<String> {
    let chars: Vec<char> = script.chars().collect();
    let mut out = Vec::new();
    let mut word = String::new();
    let mut captured = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];

        if ch == '/' && chars.get(i + 1) == Some(&'*') {
            // `/*!` is MySQL's executable comment: the body runs, so it is read
            // as code and only the marker is skipped.
            if chars.get(i + 2) == Some(&'!') {
                i += 3;
                while chars.get(i).is_some_and(char::is_ascii_digit) {
                    i += 1;
                }
                continue;
            }
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            continue;
        }
        // `--` opens a comment only when whitespace follows it; `a--b` is a
        // subtraction.
        if ch == '#'
            || (ch == '-' && chars.get(i + 1) == Some(&'-')
                && chars.get(i + 2).is_none_or(|c| c.is_whitespace()))
        {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if ch == '\'' || ch == '"' || ch == '`' {
            i += 1;
            while i < chars.len() {
                if chars[i] == '\\' && ch != '`' {
                    i += 2;
                    continue;
                }
                if chars[i] == ch {
                    // A doubled quote is a literal one, not the end.
                    if chars.get(i + 1) == Some(&ch) {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            captured = true;
            continue;
        }
        if ch == ';' {
            out.push(std::mem::take(&mut word));
            captured = false;
            i += 1;
            continue;
        }
        if !captured {
            if ch.is_alphanumeric() || ch == '_' || ch == '$' {
                word.push(ch);
            } else if !word.is_empty() || !ch.is_whitespace() {
                captured = true;
            }
        }
        i += 1;
    }
    if captured || !word.is_empty() {
        out.push(word);
    }
    out
}

/// `announce` is off for the safety copies taken on someone else's behalf, so
/// their line cannot land in the middle of output a caller is parsing.
/// Whether a backup taken before the first password hashing is already kept:
/// a non-empty `before-password-hashing-*.sql` in the backups folder. Once
/// there is one, accounts the app writes later (plain text until the login
/// server hashes them) don't each set off another full dump.
fn hashing_backup_exists(backups: &Path) -> bool {
    fs::read_dir(backups)
        .map(|entries| entries.flatten().any(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("before-password-hashing-") && name.ends_with(".sql")
                && e.metadata().map(|m| m.len() > 0).unwrap_or(false)
        }))
        .unwrap_or(false)
}

pub(crate) fn backup_snapshot(cfg: &Config, dk: &Docker, dest: &str, announce: bool) -> Result<(), String> {
    let backups = cfg.state.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let tmp = format!("ragnarokmac-{}-{}.sql", std::process::id(), crate::private_fs::random_hex(12)?);
    crate::private_fs::directory(&backups)?;

    // The dump is written inside the container, in its own /tmp, and copied
    // out with `docker cp` -- on every platform, not only Windows. Writing it
    // into the bind-mounted /backups made the host's shared folder (its
    // owner, its mode, the hypervisor's file sharing) part of whether a
    // backup could be taken at all, and split the code by OS.
    let inside = format!("/tmp/{tmp}");
    let staged = backups.join(&tmp);
    let result = dump_database(dk, &inside).and_then(|()| {
        dk.copy_out(DB_CONTAINER, &inside, &staged)
            .map_err(|e| { eprintln!("database backup: {e}"); format!("the dump was made but could not be copied out of the database container: {e}") })
    });
    dk.quiet(["exec", DB_CONTAINER, "rm", "-f", &inside]);
    if let Err(e) = result {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }

    let size = fs::metadata(&staged).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = fs::remove_file(&staged);
        return Err("the dump came out empty".into());
    }
    // Which app made it, for a later restore to know what to migrate.
    crate::dump_migrations::stamp_file(&staged, &crate::dump_migrations::stamp_line(cfg))?;
    crate::private_fs::protect(&staged, false)?;
    if fs::canonicalize(&staged).ok() == fs::canonicalize(dest).ok() {
        return Err("Choose a backup destination outside the internal staging file".into());
    }
    crate::private_fs::export_file(&staged, Path::new(dest))?;
    let _ = fs::remove_file(&staged);
    if announce {
        println!("wrote {dest} ({})", human(size));
    }
    Ok(())
}

/// Run mariadb-dump into `inside` (a path in the database container). On
/// failure, everything needed to tell why goes to the log: the exit code,
/// mariadb-dump's own words, which credentials it used (never the password),
/// the server's version, and any table that CHECK TABLE says is damaged.
/// The error returned is one short line for the loading screen.
fn dump_database(dk: &Docker, inside: &str) -> Result<(), String> {
    // Players have been saved and game services stopped. This also makes the
    // mixed-engine rAthena tables consistent; --single-transaction alone would
    // only protect InnoDB, not all of the schema.
    let command = format!("umask 077; {} --single-transaction --routines --databases ragnarok > {inside}", dk.database_client("mariadb-dump")?);
    let out = dk.capture(["exec", DB_CONTAINER, "sh", "-c", &command])
        .map_err(|e| format!("the database did not produce a dump: could not run docker: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "none".into());
    let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let version = dk.private_sql("SELECT VERSION();").map(|v| v.trim().to_string()).unwrap_or_else(|_| "unknown (the server did not answer)".into());
    eprintln!("database backup failed: mariadb-dump exited {code}");
    eprintln!("database backup: credentials: {}; server version: {version}", dk.sql_auth_kind());
    eprintln!("database backup: mariadb-dump said: {}", if said.is_empty() { "(nothing)" } else { &said });
    if let Some(table) = dump_error_table(&said) {
        eprintln!("database backup: the error names table `{table}`");
    }
    match check_tables(dk) {
        Ok(problems) if problems.is_empty() => eprintln!("database backup: CHECK TABLE found no damaged table"),
        Ok(problems) => for line in problems { eprintln!("database backup: CHECK TABLE: {line}") },
        Err(e) => eprintln!("database backup: CHECK TABLE could not run: {e}"),
    }
    Err(dump_failure_summary(&code, &said))
}

/// The loading-screen line: the exit code and mariadb-dump's last word, cut
/// short. The rest is in the log.
fn dump_failure_summary(code: &str, said: &str) -> String {
    let line = said.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("Warning")).last().unwrap_or("");
    let line: String = line.chars().take(200).collect();
    if code == "127" && said.contains("not found") {
        return "the database did not produce a dump: mariadb-dump is missing from the database image".into();
    }
    if line.is_empty() {
        format!("the database did not produce a dump (mariadb-dump exited {code}; the log has details)")
    } else {
        format!("the database did not produce a dump (exit {code}): {line}")
    }
}

/// The table a mariadb-dump error is about, if it names one: "when dumping
/// table `x`", "Table 'x'", or "Table './ragnarok/x'".
fn dump_error_table(said: &str) -> Option<String> {
    let valid = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    for (open, close) in [("table `", '`'), ("Table '", '\''), ("table '", '\'')] {
        if let Some(start) = said.find(open) {
            let rest = &said[start + open.len()..];
            let name = rest.split(close).next().unwrap_or("");
            let name = name.rsplit('/').next().unwrap_or(name);
            let name = name.rsplit('.').next().unwrap_or(name);
            if valid(name) { return Some(name.to_string()); }
        }
    }
    None
}

/// CHECK TABLE over every table in the game database; returns only the rows
/// that are not a plain OK, so a crashed or corrupt table shows up by name.
/// Filtered inside the container to keep the answer small (docker exec's
/// stdout loses data past 8 KiB under docker-slim).
fn check_tables(dk: &Docker) -> Result<Vec<String>, String> {
    let names = dk.private_sql("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE';")?;
    let names: Vec<&str> = names.lines().map(str::trim)
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .collect();
    if names.is_empty() { return Ok(Vec::new()); }
    let list = names.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(",");
    let command = format!(
        "{} --batch --skip-column-names ragnarok -e 'CHECK TABLE {list}' | awk -F '\\t' '$4 != \"OK\" {{ print }}'",
        dk.database_client("mariadb")?
    );
    let out = dk.capture(["exec", DB_CONTAINER, "sh", "-c", &command])?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    Ok(text.lines().map(|l| l.trim().replace('\t', " ")).filter(|l| !l.is_empty()).collect())
}

/// What `check_dump` found out about a file before anything was stopped.
#[derive(Debug)]
pub(crate) struct DumpInfo {
    pub size: u64,
    /// The tables the dump creates, in order.
    pub tables: Vec<String>,
    /// Something worth saying that is not a reason to refuse.
    pub note: Option<String>,
}

/// Look at a backup before the game is stopped for it: a file that is not a
/// database dump is refused with what it looks like instead, rather than fed
/// to the database to fail halfway.
pub(crate) fn check_dump(src: &Path) -> Result<DumpInfo, String> {
    let bytes = fs::read(src).map_err(|e| format!("Could not read {}: {e}", src.display()))?;
    let size = bytes.len() as u64;
    if size == 0 {
        return Err(format!("{} is empty.", src.display()));
    }
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return Err("That is a \"Back up everything\" archive, not a database backup. Use Restore everything for it.".into());
    }
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"Rar!") {
        return Err("That file is a .zip or .rar archive. Unpack it and choose the .sql file inside.".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    let tables: Vec<String> = text
        .lines()
        .filter_map(|l| l.strip_prefix("CREATE TABLE `"))
        .filter_map(|rest| rest.split('`').next())
        .map(str::to_string)
        .collect();
    if tables.is_empty() {
        return Err(format!(
            "{} is not a database backup: it creates no tables. Choose a .sql file made by Back up.",
            src.display()
        ));
    }
    if !tables.iter().any(|t| t == "char") || !tables.iter().any(|t| t == "login") {
        return Err(format!(
            "{} is a database dump, but not of a game database: it has no `char` or `login` table.",
            src.display()
        ));
    }
    let note = (!text.lines().any(|l| l.trim_end().ends_with("Dump completed on") || l.starts_with("-- Dump completed")))
        .then(|| "the backup has no \"Dump completed\" line at its end, so it may have been cut short".to_string());
    Ok(DumpInfo { size, tables, note })
}

/// A step-by-step account of a long operation: each line is printed as it
/// happens -- the app shows the supervisor's output alongside any error -- and
/// kept twice under `state/logs`: in `<what>-<time>.log`, this run alone, which
/// an error message points to; and appended to `backup-restore.log`, one file
/// with every backup and restore in it, timestamped, which Settings -> Tools ->
/// Log viewer shows as "Backup & restore".
pub(crate) struct StepLog {
    pub path: Option<PathBuf>,
    what: String,
    file: Option<fs::File>,
    shared: Option<fs::File>,
    started: std::time::Instant,
}

/// The one file the Log viewer follows; see `StepLog`.
pub(crate) const STEP_LOG_SHARED: &str = "backup-restore.log";

impl StepLog {
    pub fn open(cfg: &Config, what: &str) -> StepLog {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let dir = cfg.state.join("logs");
        let path = dir.join(format!("{what}-{secs}.log"));
        let made = fs::create_dir_all(&dir).is_ok();
        let file = made.then(|| fs::File::create(&path).ok()).flatten();
        let shared = made
            .then(|| fs::OpenOptions::new().create(true).append(true).open(dir.join(STEP_LOG_SHARED)).ok())
            .flatten();
        StepLog { path: file.as_ref().map(|_| path), what: what.to_string(), file, shared, started: std::time::Instant::now() }
    }

    pub fn say(&mut self, line: &str) {
        println!("{line}");
        self.record(line);
    }

    /// Into the files only: for the failure, which the caller reports itself.
    pub fn record(&mut self, line: &str) {
        use std::io::Write;
        let at = self.started.elapsed().as_secs_f64();
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "[{at:7.1}s] {line}");
        }
        if let Some(f) = self.shared.as_mut() {
            let now = crate::world::rfc3339(std::time::SystemTime::now());
            // One line per line, so a multi-line database error stays readable
            // in a viewer that lists lines.
            // A failure is tagged the way the viewer recognises one.
            let tag = if line.starts_with("failed:") { "[error] " } else { "" };
            for part in line.lines().filter(|l| !l.trim().is_empty()) {
                let _ = writeln!(f, "{now} [{}] {tag}{part}", self.what);
            }
        }
    }
}

/// Feed a dump to the running database. Game services must be stopped.
///
/// The dump is streamed into the database container's own /tmp and read from
/// there, on every platform, the way `backup_snapshot` dumps into /tmp. It
/// used to be read through /backups: on macOS and Linux a folder shared with
/// the host, so the hypervisor's file sharing was part of whether a restore
/// worked; on Windows a volume that this filled by copying the *whole* backups
/// folder in first -- every earlier backup, each time -- to read one file.
///
/// `ragnarok` is named as the default database, so a dump made without
/// `--databases` (no `USE`) loads too; one that has `USE` is unaffected. What
/// the client prints on failure is returned as it is.
pub(crate) fn load_dump(_cfg: &Config, dk: &Docker, src: &Path) -> Result<(), String> {
    let inside = format!("/tmp/restore-{}-{}.sql", std::process::id(), crate::private_fs::random_hex(12)?);
    let result = dk
        .write_into(DB_CONTAINER, src, &inside)
        .map_err(|e| format!("copying the backup into the database container: {e}"))
        .and_then(|()| {
            let client = dk.database_client("mariadb")?;
            dk.output(["exec", DB_CONTAINER, "sh", "-c", &format!("{client} ragnarok < {inside}")])
                .map(|_| ())
                .map_err(|e| if e.is_empty() { "the database client failed and printed nothing".into() } else { format!("the database said: {e}") })
        });
    dk.quiet(["exec", DB_CONTAINER, "rm", "-f", &inside]);
    result
}

/// The volume an era's characters live in. See `db_volume`.
pub(crate) fn era_volume(era: &str) -> &'static str {
    if era == "prerenewal" { "ragnarokmac-db-prere" } else { "ragnarokmac-db" }
}

/// Whether an era has a database at all: one that was never started has no
/// volume, and nothing to back up.
pub(crate) fn era_volume_exists(dk: &Docker, era: &str) -> bool {
    dk.quiet(["volume", "inspect", era_volume(era)])
}

fn stop_database(dk: &Docker) -> Result<(), String> {
    if dk.is_running(DB_CONTAINER)
        && (dk.output(["stop", "-t", "30", DB_CONTAINER]).is_err() || dk.is_running(DB_CONTAINER))
    {
        return Err("Could not stop the database cleanly".into());
    }
    dk.remove_container(DB_CONTAINER);
    Ok(())
}

/// Bring `ragnarok-db` up on one era's volume, the way `up` does, and wait
/// until it answers.
fn open_era_database(cfg: &Config, dk: &Docker, era: &str) -> Result<(), String> {
    let volume = era_volume(era);
    // sql_auth reads the marker to choose the era's credentials, so it names
    // what is about to run before anything connects.
    fs::write(cfg.state.join(".db-volume"), volume).map_err(|e| format!("recording the database volume: {e}"))?;
    let credentials = crate::service_credentials::load(&cfg.state, era)?;
    if let Some(credentials) = &credentials {
        credentials.write_files()?;
    }
    fs::create_dir_all(cfg.state.join("backups")).map_err(|e| e.to_string())?;
    start_database(cfg, dk, volume, credentials.as_ref())?;
    if let Some(credentials) = &credentials {
        migrate_service_credentials(dk, credentials)?;
    }
    wait_for_db(dk)
}

/// Run `operation` against `era`'s database, whichever era is running.
///
/// Only one database container runs at a time, and every database call in
/// this file talks to it by name. So reaching the other era means stopping
/// the running database, starting the same container on the other volume,
/// and afterwards putting the original back -- including when `operation`
/// failed. Game services must already be stopped: they would otherwise be
/// talking to the wrong era's characters in between.
pub(crate) fn with_era_database<T>(
    cfg: &Config,
    dk: &Docker,
    era: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let marker = cfg.state.join(".db-volume");
    let running = fs::read_to_string(&marker).map(|s| s.trim().to_string()).unwrap_or_default();
    if running == era_volume(era) && dk.is_running(DB_CONTAINER) {
        return operation();
    }
    let original = if running == era_volume("prerenewal") { "prerenewal" } else { "renewal" };
    let result = stop_database(dk)
        .and_then(|_| open_era_database(cfg, dk, era))
        .and_then(|_| operation());
    let back = stop_database(dk).and_then(|_| open_era_database(cfg, dk, original));
    match (result, back) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(format!(
            "The {era} database was handled, but the {original} database did not start again: {error}. Start the server to recover."
        )),
        (Err(first), Err(error)) => Err(format!(
            "{first}. The {original} database also did not start again: {error}. Start the server to recover."
        )),
    }
}

/// After a dump has been loaded, make its interserver login the one this
/// install's servers use. A dump carries the `s1` row of the install it came
/// from, and that is somebody else's password.
pub(crate) fn adopt_loaded_dump(cfg: &Config, dk: &Docker, era: &str) -> Result<(), String> {
    match crate::service_credentials::load(&cfg.state, era)? {
        Some(credentials) => migrate_service_credentials(dk, &credentials),
        // An era without managed credentials runs rAthena's stock s1/p1.
        None => dk
            .root_sql("UPDATE login SET user_pass='p1' WHERE account_id=1 AND BINARY userid='s1' AND sex='S';", true)
            .map(|_| ()),
    }
}

/// Stop the game servers without restarting them: a restore leaves them
/// stopped, for the shell (or the player) to start once everything is back.
pub(crate) fn stop_game(cfg: &Config, dk: &Docker) -> Result<(), String> {
    stop_game_services(cfg, dk).map_err(|_| "Could not stop the game servers cleanly; nothing was restored.".to_string())
}

/// The escape hatch for a shipped user with no terminal and no docker CLI.
///
/// Everything here is also done by `up`. This exists for the case automation
/// cannot reach: an engine that is itself wedged, where nothing
/// container-level can be cleaned because the daemon is not answering.
/// Player data is untouched — characters live in the ragnarokmac-db volume.
pub fn repair(cfg: &Config, dk: &Docker, lan: bool, ram_mib: Option<u32>) -> Result<(), String> {
    crate::registration::enabled(&cfg.state)?;
    // Repair is the escape hatch, so it must not be the thing that is stuck:
    // see effective_for_start.
    let (repair_scope, hosting_notice) = crate::hosting::effective_for_start(cfg, lan)?;
    crate::hosting::before_start(cfg, repair_scope)?;
    if let Some(notice) = &hosting_notice {
        println!("{notice}");
    }
    crate::crashes::capture_all(cfg, dk);
    phase(cfg, "Repairing…");
    // Break the lock rather than wait: the usual reason to reach for repair is
    // a previous run that died holding one.
    let _ = fs::remove_dir_all(cfg.lock_dir());
    let _ = nebula(cfg, &["down"]);
    // Bounded like everywhere else, but not optional: repair's own `up` below
    // must not land on the engine it just stopped (#119).
    wait_for_engine_exit(cfg, ENGINE_DEPART_BUDGET);
    // The one place that will end another process to get the engine started.
    //
    // An update renames the folder an engine is running from without stopping
    // it, and the orphan goes on holding all three ports with a NEBULA_HOME
    // that no longer exists -- so every later start fails on a conflict naming
    // a pid its owner has no way to place, and the only cure was a terminal.
    // A normal start still leaves it alone: taking a port by killing whatever
    // holds it is not a thing to do behind someone's back. Repair is them
    // asking, which is what makes it allowed here and nowhere else.
    if let Err(e) = nebula(cfg, &["up"]) {
        clear_stale_engines(cfg, &e);
    }
    up(cfg, dk, lan, ram_mib)
}

pub fn logs(dk: &Docker, service: &str, tail: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(dk.logs(&format!("ragnarok-{service}"), tail).as_bytes());
}

/// Services `logs --follow` will follow: names, not container names, so
/// nothing but the game's own containers can be asked for.
pub const FOLLOWED: [&str; 4] = ["map", "char", "login", "db"];

/// Why a follow ended, as the exit status, for a caller that restarts it: the
/// log viewer (#202) marks a stopped server, and only reconnects when the
/// stream broke with the server still up.
pub const FOLLOW_STOPPED: i32 = 0;
pub const FOLLOW_BROKEN: i32 = 3;
pub const FOLLOW_ABSENT: i32 = 4;

/// The container and tail length `logs --follow` was asked for.
fn follow_args(args: &[String]) -> Result<(String, String), String> {
    let mut service = None;
    let mut tail = "100".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--follow" => {}
            "--tail" => {
                let n = args.get(i + 1).ok_or("--tail needs a number")?;
                if n != "all" && n.parse::<u32>().is_err() {
                    return Err(format!("--tail needs a number, not {n}"));
                }
                tail = n.clone();
                i += 1;
            }
            other if service.is_none() && FOLLOWED.contains(&other) => service = Some(other.to_string()),
            other => return Err(format!("logs --follow takes one of {}, not {other}", FOLLOWED.join(", "))),
        }
        i += 1;
    }
    Ok((format!("ragnarok-{}", service.unwrap_or_else(|| "map".into())), tail))
}

/// `logs --follow <service> [--tail N]`: stream a game service's log until
/// it stops. Returns the exit status to end with.
pub fn logs_follow(dk: &Docker, args: &[String]) -> Result<i32, String> {
    let (name, tail) = follow_args(args)?;
    if dk.state(&name).is_none() {
        return Ok(FOLLOW_ABSENT);
    }
    let followed = dk.follow_logs(&name, &tail);
    Ok(if dk.is_running(&name) {
        FOLLOW_BROKEN
    } else if followed.is_ok() || dk.state(&name).is_some() {
        FOLLOW_STOPPED
    } else {
        FOLLOW_ABSENT
    })
}

pub(crate) fn human(bytes: u64) -> String {
    const U: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{} {}", bytes, U[0]) } else { format!("{v:.1} {}", U[i]) }
}

#[cfg(test)]
mod tests {

    #[test]
    fn untagged_images_are_the_ones_updates_leave_behind() {
        // Lines as nebula's docker-slim prints them (trimmed of fields not read).
        let listing = concat!(
            r#"{"Containers":-1,"Id":"sha256:069718ce","Labels":{"app.ragnarokoffline.private-db-files":"v1"},"RepoDigests":[],"RepoTags":["ragnarokmac/mariadb:11.4"],"Size":81655296}"#, "\n",
            r#"{"Containers":-1,"Id":"sha256:4ebf8add","Labels":{},"RepoDigests":[],"RepoTags":["<none>:<none>"],"Size":266510848}"#, "\n",
            r#"{"Containers":-1,"Id":"sha256:9c5431bd","Labels":{},"RepoDigests":[],"RepoTags":["ragnarokmac/rathena:20221005"],"Size":270085120}"#, "\n",
            r#"{"Containers":-1,"Id":"sha256:7dcc8385","Labels":{},"RepoDigests":[],"RepoTags":[],"Size":81655296}"#, "\n",
            r#"{"Containers":-1,"Id":"sha256:f363fabf","Labels":{},"RepoDigests":[],"RepoTags":["nebula/pause:slim"],"Size":363904}"#, "\n",
            "not json\n",
        );
        assert_eq!(super::untagged_images(listing), vec![
            ("sha256:4ebf8add".to_string(), 266510848),
            ("sha256:7dcc8385".to_string(), 81655296),
        ]);
        assert!(super::untagged_images("").is_empty());
    }

    fn dump_file(tag: &str, body: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ro-dump-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("backup.sql");
        std::fs::write(&path, body).unwrap();
        path
    }

    const DUMP: &str = "/*M!999999\\- enable the sandbox mode */\n-- MariaDB dump 10.19-11.4.12-MariaDB\n\
        CREATE DATABASE IF NOT EXISTS `ragnarok`;\nUSE `ragnarok`;\n\
        CREATE TABLE `char` (\n  `char_id` int\n);\nCREATE TABLE `login` (\n  `account_id` int\n);\n\
        CREATE TABLE `login_tokens` (\n  `token` int\n);\n-- Dump completed on 2026-10-02  9:59:03\n";

    /// A file is looked at before the game is stopped for it, and anything that
    /// is not a game database dump is refused with what it is instead.
    #[test]
    fn a_backup_is_checked_before_anything_stops() {
        let ok = super::check_dump(&dump_file("ok", DUMP.as_bytes())).unwrap();
        assert_eq!(ok.tables, ["char", "login", "login_tokens"]);
        assert!(ok.note.is_none());

        let cut = DUMP.replace("-- Dump completed on 2026-10-02  9:59:03\n", "");
        let cut = super::check_dump(&dump_file("cut", cut.as_bytes())).unwrap();
        assert!(cut.note.unwrap().contains("cut short"));

        for (tag, body, says) in [
            ("empty", &b""[..], "is empty"),
            ("gzip", &[0x1f, 0x8b, 8, 0][..], "Restore everything"),
            ("zip", &b"PK\x03\x04rest"[..], ".zip or .rar"),
            ("rar", &b"Rar!\x1a\x07\x01\x00"[..], ".zip or .rar"),
            ("text", &b"hello, this is not sql\n"[..], "creates no tables"),
            ("other", &b"CREATE TABLE `posts` (\n `id` int\n);\n"[..], "not of a game database"),
        ] {
            let e = super::check_dump(&dump_file(tag, body)).unwrap_err();
            assert!(e.contains(says), "{tag}: {e}");
        }
    }

    /// Each step is written to state/logs as it happens, with its time; the
    /// failure goes only to the file, since the caller reports it itself.
    #[test]
    fn a_step_log_keeps_every_line() {
        let root = std::env::temp_dir().join(format!("ro-steplog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cfg = crate::config::Config {
            root: root.join("app"),
            state: root.join("state"),
            nebula_home: root.join("nebula"),
            nebula: root.join("unused"),
            docker: root.join("unused"),
            image: String::new(),
            db_image: String::new(),
            ports: crate::ports::Ports::DEFAULT,
            app_version: None,
        };
        let mut log = super::StepLog::open(&cfg, "restore");
        log.say("stopping the game services");
        log.record("failed: the database said: ERROR 1064");
        let path = log.path.clone().unwrap();
        assert!(path.starts_with(cfg.state.join("logs")));
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("] stopping the game services\n"), "{body}");
        assert!(body.contains("] failed: the database said: ERROR 1064\n"), "{body}");
        let shared = std::fs::read_to_string(cfg.state.join("logs").join(super::STEP_LOG_SHARED)).unwrap();
        assert!(shared.lines().any(|l| l.ends_with("Z [restore] stopping the game services")), "{shared}");
        assert!(shared.lines().any(|l| l.ends_with("Z [restore] [error] failed: the database said: ERROR 1064")), "{shared}");
        assert_eq!(shared.lines().count(), 2, "{shared}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// What the shell reads to learn where this world's servers are. The
    /// default install's file keeps its keys and values, with the asset port
    /// added.
    #[test]
    fn the_endpoint_names_the_configured_ports() {
        let moved = crate::ports::Ports { asset: 13338, login: 16900, char: 16121, map: 15121, web: 18888, agent: 17490 };
        assert_eq!(
            super::endpoint_json("127.0.0.1", &moved),
            "{\"host\":\"127.0.0.1\",\"login\":16900,\"char\":16121,\"map\":15121,\"asset\":13338}\n"
        );
        let parsed = crate::json::parse(&super::endpoint_json("192.168.1.20", &crate::ports::Ports::DEFAULT)).unwrap();
        assert_eq!(parsed.str("host"), Some("192.168.1.20"));
        for (key, port) in [("login", 6900.0), ("char", 6121.0), ("map", 5121.0), ("asset", 3338.0)] {
            assert!(matches!(parsed.get(key), Some(crate::json::Value::Number(n)) if *n == port), "{key}");
        }
    }

    #[test]
    fn logs_follow_names_only_game_services() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(super::follow_args(&args(&["--follow", "char", "--tail", "50"])).unwrap(), ("ragnarok-char".to_string(), "50".to_string()));
        assert_eq!(super::follow_args(&args(&["--follow"])).unwrap().0, "ragnarok-map");
        for bad in [&["--follow", "db2"][..], &["--follow", "../x"], &["--follow", "map", "--tail", "1;x"], &["--follow", "map", "char"]] {
            assert!(super::follow_args(&args(bad)).is_err(), "{bad:?}");
        }
    }
    #[test]
    fn changed_image_bytes_invalidate_the_same_tag_cache() {
        let first = super::image_bundle_fingerprint(&b"same-size-old"[..]).unwrap();
        let second = super::image_bundle_fingerprint(&b"same-size-new"[..]).unwrap();
        assert_ne!(first, second);
        assert_eq!(first, super::image_bundle_fingerprint(&b"same-size-old"[..]).unwrap());
    }

    /// A bundle laid out as `docker save` writes one: blobs, then the two
    /// indexes. Both kinds of id are read, under the tag Docker reports.
    #[test]
    fn bundle_image_ids_come_from_both_indexes() {
        let manifest = br#"[{"Config":"blobs/sha256/aaa","RepoTags":["ragnarokmac/mariadb:11.4"],"Layers":[]},{"Config":"blobs/sha256/bbb","RepoTags":["ragnarokmac/rathena:20221005"]}]"#;
        let index = br#"{"schemaVersion":2,"manifests":[{"digest":"sha256:ccc","annotations":{"io.containerd.image.name":"docker.io/ragnarokmac/mariadb:11.4"}}]}"#;
        let mut tar = crate::archive::TarWriter::new(crate::archive::GzipWriter::new(Vec::new()).unwrap());
        tar.file("blobs/sha256/aaa", 3, 0, &b"xyz"[..]).unwrap();
        tar.file("manifest.json", manifest.len() as u64, 0, &manifest[..]).unwrap();
        tar.file("index.json", index.len() as u64, 0, &index[..]).unwrap();
        let bytes = tar.finish().unwrap().finish().unwrap();
        let ids = super::bundle_image_ids(&bytes[..]).unwrap();
        let has = |t: &str, id: &str| ids.iter().any(|(a, b)| a == t && b == id);
        assert!(has("ragnarokmac/mariadb:11.4", "sha256:aaa"));
        assert!(has("ragnarokmac/mariadb:11.4", "sha256:ccc"));
        assert!(has("ragnarokmac/rathena:20221005", "sha256:bbb"));

        // The bug: the old images still answer to both tags. That is not done.
        let old = [("ragnarokmac/mariadb:11.4", Some("sha256:old".to_string())), ("ragnarokmac/rathena:20221005", Some("sha256:bbb".to_string()))];
        assert!(!super::images_match(&ids, &old));
        let new = [("ragnarokmac/mariadb:11.4", Some("sha256:ccc".to_string())), ("ragnarokmac/rathena:20221005", Some("sha256:bbb".to_string()))];
        assert!(super::images_match(&ids, &new));
        assert!(!super::images_match(&ids, &[("ragnarokmac/mariadb:11.4", None)]));
        // A marker from before ids were recorded never matches, so an install
        // the old check left on stale images is verified on its next start.
        assert_ne!(super::image_marker("f", &new), "v1:f:ragnarokmac/rathena:20221005:ragnarokmac/mariadb:11.4\n");
        assert_ne!(super::image_marker("f", &new), super::image_marker("f", &old));
    }

    use super::*;

    #[test]
    fn a_dump_error_names_its_table() {
        assert_eq!(dump_error_table("mariadb-dump: Error 1194: Table 'loginlog' is marked as crashed and should be repaired when dumping table `loginlog` at row: 0").as_deref(), Some("loginlog"));
        assert_eq!(dump_error_table("mariadb-dump: Got error: 145: \"Table './ragnarok/char' is marked as crashed and should be repaired\" when using LOCK TABLES").as_deref(), Some("char"));
        assert_eq!(dump_error_table("mariadb-dump: Got error: 1045: \"Access denied for user 'ragnarok'@'127.0.0.1' (using password: YES)\" when trying to connect"), None);
        assert_eq!(dump_error_table(""), None);
    }

    #[test]
    fn a_failed_dump_says_what_mariadb_dump_said() {
        let said = "mariadb-dump: Error 1194: Table 'loginlog' is marked as crashed";
        assert_eq!(dump_failure_summary("2", said), format!("the database did not produce a dump (exit 2): {said}"));
        assert!(dump_failure_summary("127", "sh: mariadb-dump: not found").contains("missing"));
        assert!(dump_failure_summary("1", "").contains("exited 1"));
        assert!(dump_failure_summary("2", &"x".repeat(1000)).len() < 300);
    }

    #[test]
    fn a_kept_pre_hashing_backup_stops_another_one() {
        let dir = std::env::temp_dir().join(format!("ro-hashbackup-{}", crate::private_fs::random_hex(6).unwrap()));
        fs::create_dir_all(&dir).unwrap();
        assert!(!hashing_backup_exists(&dir), "an empty folder has none");
        fs::write(dir.join("before-password-hashing-abc.sql"), b"").unwrap();
        assert!(!hashing_backup_exists(&dir), "an empty file is a failed dump, not a backup");
        fs::write(dir.join("before-restore-renewal-x.sql"), b"-- dump").unwrap();
        assert!(!hashing_backup_exists(&dir), "other backups don't count");
        fs::write(dir.join("before-password-hashing-def.sql"), b"-- dump").unwrap();
        assert!(hashing_backup_exists(&dir));
        assert!(!hashing_backup_exists(&dir.join("missing")), "no folder yet");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Also a contract with nebula's prose, and the cost of misreading it is
    /// the whole of #119: a departing engine read as gone lets a start run into
    /// it, and a gone one read as departing holds every start for three
    /// minutes.
    #[test]
    fn reads_the_engine_s_state_from_its_status() {
        assert_eq!(
            engine_state_from_status("nebula: stopped (daemon not running)\n  start it:          nebula up\n"),
            EngineState::Gone
        );
        assert_eq!(
            engine_state_from_status("nebula: running\n  backend:  krun | cpus 4 | max ram 4096 MiB\n"),
            EngineState::Running
        );
        // A newer engine that has begun to stop says so.
        assert_eq!(engine_state_from_status("nebula: stopping (daemon shutting down)\n"), EngineState::Departing);
        // An older one answers with its VM's state: halted, or killed.
        assert_eq!(engine_state_from_status("nebula: failed\n  agent:    UNREACHABLE\n"), EngineState::Departing);
        assert_eq!(engine_state_from_status("nebula: stopped\n  agent:    UNREACHABLE\n"), EngineState::Departing);
        // Or does not answer before the deadline at all.
        assert_eq!(engine_state_from_status(""), EngineState::Departing);
    }

    /// The one contract this file has with another program's prose.
    ///
    /// Pinned because a reworded nebula message turns the automatic recovery
    /// off silently, and the symptom is the thing it exists to prevent: an
    /// upgrade that will not start until someone finds a pid by hand.
    #[test]
    fn reads_a_port_conflict() {
        let err = "nebulad failed to start:\n\n\
            tcp 7462 (api_port) is already in use by nebulad pid 48746 (NEBULA_HOME=/Users/p/Library/Application Support/com.ragnarokmac.app/nebula)\n\
            udp 42062 (dns_port) is already in use by nebulad pid 48746 (NEBULA_HOME=/Users/p/Library/Application Support/com.ragnarokmac.app/nebula)\n\
            tcp 6462 (k8s_port) is already in use by nebulad pid 48746 (NEBULA_HOME=/Users/p/Library/Application Support/com.ragnarokmac.app/nebula)\n";
        let held = port_holders(err);
        // One process, not three: the same engine holds all three ports, and
        // stopping it twice more would be two pointless kills.
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].pid, 48746);
        assert_eq!(
            held[0].home,
            PathBuf::from("/Users/p/Library/Application Support/com.ragnarokmac.app/nebula"),
        );
    }

    /// The three ways a departing engine shows up, and the one case that must
    /// not be mistaken for one.
    ///
    /// Pinned because getting this wrong is expensive in both directions: too
    /// narrow and the player is sent to their BIOS for a stack that is merely
    /// busy, too wide and a genuine failure is retried for eighty seconds
    /// before it is reported.
    #[test]
    fn reads_an_engine_that_is_still_leaving() {
        assert!(engine_still_departing("nebulad failed to start:\n\nnebulad already running (pid 3093)"));
        assert!(engine_still_departing("Error: Connection reset by peer (os error 104)"));
        assert!(engine_still_departing("Error: Broken pipe (os error 32)"));
        // A hypervisor that is genuinely unavailable is not a wait: retrying
        // it changes nothing, and the KVM advice is the right answer.
        assert!(!engine_still_departing("failed to open /dev/kvm: Permission denied"));
    }

    /// A path may contain a bracket, so the home ends at the last one on the
    /// line rather than the first.
    #[test]
    fn reads_a_home_with_brackets_in_it() {
        let err = "tcp 7462 (api_port) is already in use by nebulad pid 91 \
                   (NEBULA_HOME=/Users/p/Ragnarok Offline (old)/nebula)";
        assert_eq!(
            port_holders(err)[0].home,
            PathBuf::from("/Users/p/Ragnarok Offline (old)/nebula"),
        );
    }

    /// The guard's whole job: an edit typed where a read was meant.
    #[test]
    fn a_read_is_a_read_and_a_write_is_not() {
        assert!(read_only("SELECT * FROM homunculus WHERE char_id = 150000").is_ok());
        assert!(read_only("  show tables ").is_ok());
        assert!(read_only("EXPLAIN DELETE FROM `char`").is_ok());
        assert!(read_only("UPDATE `char` SET homun_id = 0").is_err());
        assert!(read_only("DELETE FROM homunculus").is_err());
        // WITH is deliberately not a read keyword: MariaDB accepts a CTE in
        // front of DELETE.
        assert!(read_only("WITH x AS (SELECT 1) SELECT * FROM x").is_err());
    }

    /// The second statement is the one that gets you, and it is the one a
    /// single-statement check would miss.
    #[test]
    fn every_statement_is_checked_not_just_the_first() {
        assert!(read_only("SELECT 1; DELETE FROM homunculus").is_err());
        assert!(read_only("SELECT 1;\nSELECT 2;\n").is_ok());
    }

    /// A semicolon that does not end a statement, in each of the three places
    /// one can hide.
    #[test]
    fn punctuation_inside_quotes_and_comments_does_not_split() {
        assert!(read_only("SELECT 'a; DROP'").is_ok());
        assert!(read_only("SELECT \"a; DROP\"").is_ok());
        assert!(read_only("SELECT `odd;name` FROM t").is_ok());
        assert!(read_only("SELECT 'it\\'s; fine'").is_ok());
        assert!(read_only("SELECT 'two''quotes; here'").is_ok());
        assert!(read_only("SELECT 1 -- ; DELETE FROM t\n").is_ok());
        assert!(read_only("SELECT 1 # ; DELETE FROM t\n").is_ok());
        assert!(read_only("/* ; DELETE FROM t */ SELECT 1").is_ok());
        assert!(read_only("-- a note\nSELECT 1").is_ok());
    }

    /// `/*! ... */` is run by the server, so it is read as code here too.
    #[test]
    fn an_executable_comment_is_not_a_comment() {
        assert!(read_only("/*!40000 DELETE FROM `char` */").is_err());
        assert!(read_only("/*! SELECT 1 */").is_ok());
    }

    /// Anything that is not a plain keyword is refused rather than guessed at.
    #[test]
    fn a_statement_that_starts_with_no_keyword_is_refused() {
        assert!(read_only("(SELECT 1)").is_err());
        assert!(read_only("`char`").is_err());
        assert!(leading_words("   \n -- nothing but a comment\n  ").is_empty());
        assert!(leading_words("SELECT 1;  ").len() == 1);
    }

    /// Every other failure yields nothing, so the caller reports it as it
    /// always did instead of retrying a start that cannot work.
    #[test]
    fn ignores_a_failure_that_names_no_holder() {
        assert!(port_holders("nebula up failed: the virtual machine did not come up").is_empty());
        assert!(port_holders("tcp 7462 is already in use by nebulad pid (NEBULA_HOME=/x)").is_empty());
    }

    #[test]
    fn a_fresh_companion_table_and_an_upgraded_one_agree() {
        // Every column the upgrade adds is declared by the CREATE, with the same definition,
        // so a fresh install and an upgraded one end up with the same table.
        let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let schema = squash(COMPANION_SCHEMA);
        for (column, definition) in COMPANION_COLUMNS {
            let declared = format!("`{column}` {}", squash(definition));
            assert!(schema.contains(&declared), "the CREATE must declare {declared}");
        }
        for (name, columns) in COMPANION_INDEXES {
            let declared = format!("KEY `{name}` ({})", squash(columns));
            assert!(schema.contains(&declared), "the CREATE must declare {declared}");
        }
        let sql = companion_table_sql();
        assert!(sql.len() <= crate::docker::SQL_INPUT_LIMIT, "the migration must fit one call");
        assert_eq!(sql.matches("ADD INDEX IF NOT EXISTS").count(), COMPANION_INDEXES.len());
        assert_eq!(sql.matches("ALTER TABLE").count(), 1, "one ALTER, not one call per column");
        assert_eq!(sql.matches("ADD COLUMN IF NOT EXISTS").count(), COMPANION_COLUMNS.len());
        assert!(!sql.contains("REPLACE") && !sql.contains("DROP"), "only new objects, nothing one-way");
    }

    #[test]
    fn a_mod_reader_is_only_used_once_its_grants_are_confirmed() {
        // An empty table list (an answer lost on the way back) grants nothing:
        // that must fail, not succeed with a login the map server can't use.
        assert!(mod_reader_grant_count("").is_err());
        assert!(mod_reader_grant_count("\n\n").is_err());
        assert!(mod_reader_grant_count("login\nmod_store\n").is_err(), "only hidden tables is nothing to grant");
        assert_eq!(mod_reader_grant_count("char\ninventory\nlogin\n").unwrap(), 2);
        let many: String = (0..250).map(|i| format!("t{i}\n")).collect();
        assert_eq!(mod_reader_grant_count(&many).unwrap(), 250, "counted across batches");

        assert!(mod_reader_grants_confirmed(2, "2\n").is_ok());
        assert!(mod_reader_grants_confirmed(2, "3").is_ok(), "a table added meanwhile is still confirmed");
        assert!(mod_reader_grants_confirmed(2, "1").is_err());
        assert!(mod_reader_grants_confirmed(2, "0").is_err());
        assert!(mod_reader_grants_confirmed(2, "").is_err(), "no answer is not a confirmation");
        assert!(mod_reader_grants_confirmed(2, "Error").is_err());
        assert!(MOD_READER_GRANTS_SQL.contains(crate::service_credentials::MOD_READER));
    }

    #[test]
    fn the_mod_reader_reads_every_table_but_login_and_nothing_more() {
        let setup = mod_reader_setup_sql(&"a".repeat(64));
        assert!(setup.contains("CREATE USER IF NOT EXISTS 'ragnarok_mods'@'%'"));
        assert!(setup.contains("ALTER USER 'ragnarok_mods'@'%' IDENTIFIED BY"), "an existing login gets the password on disk");
        assert!(setup.contains("REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'ragnarok_mods'@'%'"), "grants are rebuilt, never accumulated");
        assert!(!setup.contains("GRANT ALL") && !setup.contains("WITH GRANT OPTION"));

        let tables = "char\nlogin\npicklog\nmapreg\n\nweird`name\nbad name\n";
        let batches = mod_reader_grant_sql(tables);
        assert_eq!(batches.len(), 1);
        let sql = &batches[0];
        for table in ["char", "picklog", "mapreg"] {
            assert!(sql.contains(&format!("GRANT SELECT ON `ragnarok`.`{table}` TO 'ragnarok_mods'@'%';")), "{table}");
        }
        assert!(!sql.contains("`login`"), "account passwords stay hidden");
        assert!(!sql.contains("weird") && !sql.contains("bad name"), "only plain identifiers");
        assert_eq!(sql.matches("GRANT ").count(), 3);
        assert!(!sql.contains("INSERT") && !sql.contains("UPDATE") && !sql.contains("ALL"));

        let many: String = (0..250).map(|i| format!("t{i}\n")).collect();
        let batches = mod_reader_grant_sql(&many);
        assert_eq!(batches.len(), 3, "batched under the SQL input limit");
        assert!(batches.iter().all(|b| b.len() < crate::docker::SQL_INPUT_LIMIT));
    }

    #[test]
    fn mod_store_table_only_adds() {
        assert_eq!(MOD_STORE_TABLE_SQL.matches("CREATE TABLE IF NOT EXISTS `mod_store`").count(), 1);
        for word in ["DROP", "ALTER", "DELETE", "TRUNCATE"] {
            assert!(!MOD_STORE_TABLE_SQL.to_ascii_uppercase().contains(word), "{word}");
        }
        for column in ["`mod_name`", "`scope`", "`owner`", "`path`", "`kind`", "`num`", "`str`"] {
            assert!(MOD_STORE_TABLE_SQL.contains(column), "{column}");
        }
    }

    #[test]
    fn mod_store_limits_are_written_and_imported_once() {
        let conf = std::env::temp_dir().join(format!("ro-modstore-conf-{}", crate::private_fs::random_hex(8).unwrap()));
        fs::create_dir_all(&conf).unwrap();
        fs::write(conf.join("battle_conf.txt"), "base_exp_rate: 200").unwrap();
        write_mod_store_limits(&conf).unwrap();
        write_mod_store_limits(&conf).unwrap();
        let battle = fs::read_to_string(conf.join("battle_conf.txt")).unwrap();
        assert_eq!(battle, "base_exp_rate: 200\nimport: conf/import/mod_store_conf.txt\n", "the shell's settings kept, imported once");
        let limits = fs::read_to_string(conf.join(MOD_STORE_CONF)).unwrap();
        assert!(limits.contains("mod_store_global_bytes: 1048576\n"));
        assert!(limits.contains("mod_store_char_bytes: 65536\n"));
        assert_eq!(limits.lines().count(), MOD_STORE_LIMITS.len());
        assert!(mod_reader_grant_sql("char\nmod_store\nlogin\n")[0].matches("GRANT").count() == 1, "mod_store is hidden from SQL");
        fs::remove_dir_all(conf).unwrap();
    }

    #[test]
    fn mod_data_reset_takes_only_a_mod_folder_name() {
        assert_eq!(mod_store_name("prontera-vendors").unwrap(), "prontera-vendors");
        assert_eq!(mod_store_name("bounty_hunt2").unwrap(), "bounty_hunt2");
        for bad in ["", "Bad", "a'b", "x; DROP TABLE login", "../x", &"a".repeat(65)] {
            assert!(mod_store_name(bad).is_err(), "{bad}");
        }
    }
}
