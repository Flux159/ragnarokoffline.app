//! The stack commands themselves.

use crate::config::{lan_ip, Config, DB_CONTAINER, NET, SERVERS};
use crate::docker::{older_than, Docker, Mount};
use std::fs;
use std::io::Write;
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
/// Directory creation is the atomic primitive on every platform we ship to,
/// which advisory file locking is not.
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
        sleep(Duration::from_secs(2));
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
            nebula(cfg, &["install-image",
                "--kernel", &k.display().to_string(),
                "--rootfs", &r.display().to_string()])?;
            // Only after a successful install: a marker written first would
            // convince the next run that a failed upgrade had happened.
            let _ = fs::write(&marker, &shipped);
        }
    }
    // `nebula up` is a no-op when the engine is already healthy.
    let _ = nebula(cfg, &["up"]);
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
    Err("the nebula engine did not come up".into())
}

fn nebula(cfg: &Config, args: &[&str]) -> Result<(), String> {
    let st = Command::new(&cfg.nebula)
        .args(args)
        .env("NEBULA_HOME", &cfg.nebula_home)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("running nebula: {e}"))?;
    if st.success() { Ok(()) } else { Err(format!("nebula {} failed", args[0])) }
}

/// Load the bundled image tarball when the images are not already present.
///
/// This was `precache.sh ensure`. It is here because the app must be able to
/// start on a machine with no shell interpreter, and because the failure it
/// guards is unforgiving: with no images, `run` falls through to pulling
/// `ragnarokmac/mariadb` from a registry that has never heard of it, and the
/// error is about a network we should never have touched.
fn ensure_images(cfg: &Config, dk: &Docker) -> Result<(), String> {
    if dk.image_exists(&cfg.image) && dk.image_exists(&cfg.db_image) {
        return Ok(());
    }
    let bundle = cfg.root.join("dist/images.tar.gz");
    if !bundle.exists() {
        return Err(format!("no server images, and no bundle at {}", bundle.display()));
    }
    // Only announce it when there is one to do: a phase that says "first run
    // only" on every run trains people to ignore it.
    phase(cfg, "Loading the server images… (first run only)");
    // `docker load` reads gzip directly, so this needs no external gunzip —
    // which is the whole point of not shelling out here.
    let f = fs::File::open(&bundle).map_err(|e| format!("opening the image bundle: {e}"))?;
    let st = Command::new(&cfg.docker)
        .arg("load")
        .env("NEBULA_HOME", &cfg.nebula_home)
        .stdin(Stdio::from(f))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("running docker load: {e}"))?;
    if !st.success() {
        return Err("could not load the bundled server images".into());
    }
    // Verify rather than trust the exit status: a partial load leaves the
    // caller to run an image that is not there.
    if !dk.image_exists(&cfg.image) || !dk.image_exists(&cfg.db_image) {
        return Err(format!("image load did not produce {} and {}", cfg.image, cfg.db_image));
    }
    Ok(())
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

/// Poll for the thing actually depended on — the database answering queries —
/// rather than a container healthcheck.
fn wait_for_db(dk: &Docker) -> Result<(), String> {
    for _ in 0..90 {
        if dk.exec_sql("SELECT 1").is_ok() {
            return Ok(());
        }
        sleep(Duration::from_secs(2));
    }
    Err("timed out waiting for the database".into())
}

/// The map-server listens on 5121 long before it is usable: it then reads its
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
    // -t because rAthena writes with printf(3), which block-buffers when
    // stdout is not a tty; without it errors never reach `docker logs`.
    // Loopback by default: an offline single-player server has no business
    // listening on the network. LAN hosting is an explicit choice, and it is
    // the whole difference between "only this machine" and "anyone who can
    // reach this machine".
    let bind = if lan { "0.0.0.0" } else { "127.0.0.1" };
    let opts = vec![
        "-t".to_string(),
        "--network".into(), NET.into(),
        "-p".into(), format!("{bind}:{port}:{port}"),
    ];
    dk.run_container(name, &cfg.image, &[binary.to_string()], &mounts, &opts)
        .map_err(|e| format!("starting {name}: {e}"))
}

pub fn up(cfg: &Config, dk: &Docker, lan: bool, ram_mib: Option<u32>) -> Result<(), String> {
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

    ensure_images(cfg, dk)?;
    dk.quiet(["network", "create", NET]);

    if !dk.is_running(DB_CONTAINER) {
        dk.remove_container(DB_CONTAINER);
        let mounts = vec![
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
            Mount::Volume { name: "ragnarokmac-db".into(), container: "/var/lib/mysql".into() },
        ];
        let opts: Vec<String> = [
            "--network", NET,
            "-e", "MARIADB_ROOT_PASSWORD=ragnarok",
            "-e", "MARIADB_DATABASE=ragnarok",
            "-e", "MARIADB_USER=ragnarok",
            "-e", "MARIADB_PASSWORD=ragnarok",
        ].iter().map(|s| s.to_string()).collect();
        dk.run_container(DB_CONTAINER, &cfg.db_image, &[], &mounts, &opts)
            .map_err(|e| format!("starting the database: {e}"))?;
    }
    phase(cfg, "Starting the database…");
    wait_for_db(dk)?;

    // Applied here, not only in the seed SQL: the entrypoint imports
    // initdb.d exactly once, when it creates the data directory, so an install
    // predating this would never get the account.
    // NOT EXISTS rather than INSERT IGNORE: userid carries a plain KEY, not a
    // UNIQUE one, so IGNORE suppresses nothing and adds a duplicate account on
    // every start.
    let _ = dk.exec_sql(
        "INSERT INTO login (userid, user_pass, sex, email, group_id)
         SELECT 'ragnarok', 'ragnarok', 'M', 'ragnarok@localhost', 99 FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM login WHERE userid = 'ragnarok');",
    );

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

    // Every client arrives through the WebSocket proxy, so every connection has
    // the same source address; rAthena's per-IP flood protection trips on sight
    // and blocks for ten minutes, silently. And after character select the
    // client sits on the char socket parsing its databases, which can exceed
    // the default 60s stall_time on a modern client.
    write_conf(&conf, "packet_conf.txt", "stall_time: 300\nenable_ip_rules: no\n")?;
    write_conf(&conf, "inter_conf.txt", concat!(
        "login_server_ip: ragnarok-db\n", "ipban_db_ip: ragnarok-db\n",
        "char_server_ip: ragnarok-db\n", "map_server_ip: ragnarok-db\n",
        "web_server_ip: ragnarok-db\n", "log_db_ip: ragnarok-db\n"))?;
    // rAthena ships new_account: no, so roBrowser's simplified registration has
    // nothing to talk to. This is a single-player server on loopback.
    write_conf(&conf, "login_conf.txt",
        "new_account: yes\nacc_name_min_length: 4\npassword_min_length: 4\n")?;
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
    write_conf(&conf, "char_conf.txt",
        &format!("login_ip: ragnarok-login\nchar_ip: {advertise}\npincode_enabled: no\n\
                  start_point: iz_int,18,26\n"))?;

    let product = if cfg!(target_os = "macos") { "RagnarokMac" }
        else if cfg!(windows) { "RagnarokWindows" }
        else if cfg!(target_os = "linux") { "RagnarokLinux" }
        else { "Ragnarok" };
    write_conf(&conf, "motd.txt",
        &format!("Welcome to {product} Offline! Please report any bugs on Github\n"))?;
    write_conf(&conf, "map_conf.txt",
        &format!("char_ip: ragnarok-char\nmap_ip: {advertise}\nmotd_txt: conf/import/motd.txt\n"))?;

    let endpoint = format!(
        "{{\"host\":\"{advertise}\",\"login\":6900,\"char\":6121,\"map\":5121}}\n");
    fs::write(cfg.state.join("endpoint.json"), &endpoint)
        .map_err(|e| format!("writing endpoint.json: {e}"))?;
    // The game page reads this from the asset server's static root. It exists
    // so LAN mode can later advertise a different address.
    let web = cfg.root.join("vendor/roBrowserLegacy/dist/Web");
    if web.is_dir() {
        let _ = fs::write(web.join("endpoint.json"), &endpoint);
    }

    prepare_kafra_scripts(cfg, dk);
    phase(cfg, "Starting the login, character and map servers…");
    run_server(cfg, dk, "ragnarok-login", 6900, "/rathena/login-server", lan)?;
    run_server(cfg, dk, "ragnarok-char", 6121, "/rathena/char-server", lan)?;
    run_server(cfg, dk, "ragnarok-map", 5121, "/rathena/map-server", lan)?;
    phase(cfg, "Loading maps and NPCs…");
    wait_for_maps(dk)?;
    phase(cfg, "Ready");
    println!("stack up");
    // The one string a host pastes to a friend. Printed rather than only
    // written, so it is visible from a terminal too.
    if lan {
        println!("join address: http://{advertise}:3338/");
    }
    Ok(())
}

pub fn down(cfg: &Config, dk: &Docker) -> Result<(), String> {
    let _lock = Lock::acquire(cfg)?;
    // Game servers hold no state, so killing them is fine. The database does:
    // stop it gracefully so InnoDB closes cleanly rather than recovering.
    for c in SERVERS {
        dk.remove_container(c);
    }
    dk.quiet(["stop", "-t", "10", DB_CONTAINER]);
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
    let _ = nebula(cfg, &["down"]);

    phase(cfg, "Stopped");
    println!("stack down");
    Ok(())
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

pub fn backup(cfg: &Config, dk: &Docker, dest: &str) -> Result<(), String> {
    let backups = cfg.state.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let tmp = format!("ragnarokmac-{}.sql", std::process::id());

    // --single-transaction keeps the server writable during the dump, which
    // matters because the player may well be logged in while taking one.
    dk.output([
        "exec", DB_CONTAINER, "sh", "-c",
        &format!("mariadb-dump -uragnarok -pragnarok --single-transaction --routines \
                  --databases ragnarok > /backups/{tmp}"),
    ])
    .map_err(|_| "the database did not produce a dump (is the server running?)".to_string())?;

    let staged = backups.join(&tmp);
    if cfg!(windows) {
        // No bind mount there, so the dump is inside a named volume; fetch it.
        dk.copy_out(DB_CONTAINER, &format!("/backups/{tmp}"), &staged)?;
    }
    let size = fs::metadata(&staged).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = fs::remove_file(&staged);
        return Err("the dump came out empty".into());
    }
    fs::rename(&staged, dest)
        .or_else(|_| fs::copy(&staged, dest).map(|_| ()))
        .map_err(|e| format!("could not write {dest}: {e}"))?;
    let _ = fs::remove_file(&staged);
    dk.quiet(["exec", DB_CONTAINER, "rm", "-f", &format!("/backups/{tmp}")]);
    println!("wrote {dest} ({})", human(size));
    Ok(())
}

pub fn restore(cfg: &Config, dk: &Docker, src: &str) -> Result<(), String> {
    if !Path::new(src).is_file() {
        return Err(format!("no such backup: {src}"));
    }
    let backups = cfg.state.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let tmp = format!("restore-{}.sql", std::process::id());
    let staged = backups.join(&tmp);
    fs::copy(src, &staged).map_err(|e| format!("staging the backup: {e}"))?;
    if cfg!(windows) {
        dk.copy_into(DB_CONTAINER, &backups, "/backups")?;
    }
    // The dump carries CREATE DATABASE + USE, so this replaces the schema
    // wholesale rather than merging into whatever is there now.
    let r = dk.output([
        "exec", DB_CONTAINER, "sh", "-c",
        &format!("mariadb -uragnarok -pragnarok < /backups/{tmp}"),
    ]);
    let _ = fs::remove_file(&staged);
    dk.quiet(["exec", DB_CONTAINER, "rm", "-f", &format!("/backups/{tmp}")]);
    r.map_err(|_| "restore failed; the database is unchanged".to_string())?;
    println!("restored from {src}");
    Ok(())
}

/// The escape hatch for a shipped user with no terminal and no docker CLI.
///
/// Everything here is also done by `up`. This exists for the case automation
/// cannot reach: an engine that is itself wedged, where nothing
/// container-level can be cleaned because the daemon is not answering.
/// Player data is untouched — characters live in the ragnarokmac-db volume.
pub fn repair(cfg: &Config, dk: &Docker, lan: bool, ram_mib: Option<u32>) -> Result<(), String> {
    phase(cfg, "Repairing…");
    // Break the lock rather than wait: the usual reason to reach for repair is
    // a previous run that died holding one.
    let _ = fs::remove_dir_all(cfg.lock_dir());
    let _ = nebula(cfg, &["down"]);
    sleep(Duration::from_secs(2));
    let _ = nebula(cfg, &["up"]);
    up(cfg, dk, lan, ram_mib)
}

pub fn logs(dk: &Docker, service: &str, tail: &str) {
    let mut out = std::io::stdout();
    let _ = out.write_all(dk.logs(&format!("ragnarok-{service}"), tail).as_bytes());
}

fn human(bytes: u64) -> String {
    const U: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{} {}", bytes, U[0]) } else { format!("{v:.1} {}", U[i]) }
}
