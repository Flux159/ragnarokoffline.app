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
                "--rootfs", &r.display().to_string()])
                .map_err(|e| {
                    #[cfg(windows)]
                    if is_app_control_block(&e) {
                        return app_control_help(&e);
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
    if sac_enforcing() && !pe_is_signed(&cfg.nebula) {
        return Err(app_control_help(
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
                return Err(app_control_help(e));
            }
        }
        let _ = repair;
        let _ = fs::write(cfg.nebula_home.join(".guest-images"), guest_fingerprint(&[&k, &r]));
    }
    check_guest_images(cfg)?;

    if let Err(e) = nebula(cfg, &["up"]) {
        #[cfg(windows)]
        if is_app_control_block(&e) {
            return Err(app_control_help(&e));
        }
        return Err(engine_failure_help(&e));
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
    // stderr captured rather than discarded: when the engine cannot start, what
    // it says is the whole diagnosis, and throwing it away left the player with
    // a stack that failed several steps later for no stated reason.
    let out = Command::new(&cfg.nebula)
        .args(args)
        .env("NEBULA_HOME", &cfg.nebula_home)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("running nebula: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if why.is_empty() {
        format!("nebula {} failed", args[0])
    } else {
        format!("nebula {} failed: {why}", args[0])
    })
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
            && sac_enforcing())
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

/// Is Smart App Control enforcing right now?
///
/// Read rather than inferred from a failure. Under enforcement an unsigned
/// binary is refused at load with 0xC0000135, which is indistinguishable from
/// a genuinely missing DLL -- so the state has to be checked, not guessed from
/// the corpse. Values: 0 off, 1 enforcement, 2 evaluation.
#[cfg(windows)]
fn sac_enforcing() -> bool {
    let out = Command::new("reg")
        .args([
            "query",
            r"HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy",
            "/v",
            "VerifiedAndReputablePolicyState",
        ])
        .output();
    match out {
        Ok(o) => {
            let t = String::from_utf8_lossy(&o.stdout);
            // "VerifiedAndReputablePolicyState    REG_DWORD    0x1"
            t.split_whitespace()
                .last()
                .map(|v| v.eq_ignore_ascii_case("0x1"))
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// Does this PE carry an Authenticode signature?
///
/// The certificate table is data directory 4 in the optional header; a size of
/// zero means nothing signed it. Parsed here rather than shelling out to
/// PowerShell, because this runs on every start and a process spawn to answer
/// "did we sign our own binary" is a poor trade.
#[cfg(windows)]
fn pe_is_signed(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else { return false };
    let mut buf = [0u8; 4];
    // e_lfanew at 0x3C points at the PE header.
    if f.seek(SeekFrom::Start(0x3C)).is_err() || f.read_exact(&mut buf).is_err() {
        return false;
    }
    let pe = u32::from_le_bytes(buf) as u64;
    let mut magic = [0u8; 2];
    if f.seek(SeekFrom::Start(pe + 24)).is_err() || f.read_exact(&mut magic).is_err() {
        return false;
    }
    // PE32 puts the data directories at +96, PE32+ at +112.
    let dir_off = match u16::from_le_bytes(magic) {
        0x10b => pe + 24 + 96,
        0x20b => pe + 24 + 112,
        _ => return false,
    };
    // Directory 4 is the certificate table: 8 bytes in, size is the second u32.
    let mut entry = [0u8; 8];
    if f.seek(SeekFrom::Start(dir_off + 4 * 8)).is_err() || f.read_exact(&mut entry).is_err() {
        return false;
    }
    u32::from_le_bytes([entry[4], entry[5], entry[6], entry[7]]) != 0
}

#[cfg(windows)]
fn app_control_help(reason: &str) -> String {
    format!(
        "{reason}\n\n\
         Windows blocked this app from running. Its files are not code-signed \
         yet, and Smart App Control refuses programs it does not recognise.\n\n\
         This is not a problem with your computer, and it is not a virus -- it \
         is a signature we have not bought yet. It affects people on newer \
         Windows 11 installs, because Smart App Control is on by default there \
         and switches itself off on older machines.\n\n\
         To play now, turn Smart App Control off:\n\n\
         \x20   Windows Security -> App & browser control -> \
         Smart App Control settings -> Off\n\n\
         Read this part before you do: turning it off is PERMANENT. Windows \
         will not let it be switched back on without reinstalling Windows. If \
         you would rather not, waiting for a signed release costs you nothing \
         but time.\n\n\
         We are working on signing, which fixes this properly and needs no \
         change on your side. It takes a few weeks -- the certificate authority \
         has to verify our identity first. Progress:\n\n\
         \x20   https://github.com/Flux159/ragnarokoffline.app/issues/8"
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

fn engine_failure_help(reason: &str) -> String {
    if nebula_explained_itself(reason) {
        return reason.to_string();
    }
    // A missing DLL is not a virtualisation fault, and the hypervisor advice
    // below would send someone into their BIOS for one.
    #[cfg(windows)]
    if is_dll_not_found(reason) && vc_runtime_missing() {
        return vc_runtime_help(reason);
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

    // Ask Windows whether a hypervisor is running at all. Cheap, and it splits
    // the two failures that look identical: firmware virtualisation off (fixed
    // in the BIOS) versus the Windows feature off (fixed with a checkbox).
    let present = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "(Get-CimInstance Win32_ComputerSystem).HypervisorPresent",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if present {
        format!(
            "{reason}\n\n\
             Windows reports a hypervisor is running, so virtualisation itself \
             is fine and something else stopped the virtual machine. The \
             Settings window has a Report a problem button that collects the \
             logs needed to work out what."
        )
    } else {
        format!(
            "{reason}\n\n\
             The virtual machine could not start: Windows reports no hypervisor \
             running. Two things have to be on, and they are fixed differently.\n\n\
             1. Virtualisation in your BIOS/UEFI. Open Task Manager \
             (Ctrl+Shift+Esc), go to Performance then CPU, and look for \
             \"Virtualization\". If it says Disabled, turn on Intel VT-x, AMD-V \
             or SVM Mode in your BIOS. Windows cannot enable this for you.\n\n\
             2. The Windows Hypervisor Platform. Press Windows+R, run \
             \"optionalfeatures\", tick \"Windows Hypervisor Platform\", and \
             restart. Or, in a Command Prompt opened as Administrator:\n\n\
             \x20   dism.exe /Online /Enable-Feature /FeatureName:HypervisorPlatform /All\n\n\
             Windows 11 Home is fine for this -- it is not the Hyper-V role, \
             which is Pro only, but the same feature WSL2 and Docker Desktop use."
        )
    }
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
        // Not `SELECT 1`. mariadb's entrypoint starts a temporary server on the
        // same socket we exec against, and only then imports the schema from
        // docker-entrypoint-initdb.d -- so a bare connection succeeds long
        // before `login` exists. The account insert that follows was landing on
        // a missing table, its error discarded, and the player was left with a
        // server that had no ragnarok/ragnarok account until the next launch
        // ran the insert again. Waiting for the table, not the socket.
        if dk.exec_sql("SELECT 1 FROM login LIMIT 1").is_ok() {
            return Ok(());
        }
        sleep(Duration::from_secs(2));
    }
    Err("timed out waiting for the database schema".into())
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
    // Checked, not discarded: this is the only account a player has, and a
    // silent failure here is indistinguishable from the game being broken.
    if let Err(e) = dk.exec_sql(
        "INSERT INTO login (userid, user_pass, sex, email, group_id)
         SELECT 'ragnarok', 'ragnarok', 'M', 'ragnarok@localhost', 99 FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM login WHERE userid = 'ragnarok');",
    ) {
        return Err(format!("could not create the ragnarok account: {e}"));
    }
    // And confirm it is actually there. The insert can succeed against a schema
    // that is still being replaced underneath it.
    match dk.exec_sql("SELECT COUNT(*) FROM login WHERE userid = 'ragnarok';") {
        Ok(out) if out.contains('1') => {}
        Ok(_) => return Err("the ragnarok account was not created; try Repair".into()),
        Err(e) => return Err(format!("could not verify the ragnarok account: {e}")),
    }

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
    // Mods are assembled here, before the map server is started and before
    // map_conf names their scripts: the mount and the config have to agree, and
    // both are derived from the same pass over state/mods.
    let mods = crate::mods::assemble(cfg)?;
    if !mods.names.is_empty() {
        println!("mods: {}", mods.names.join(", "));
    }
    write_conf(&conf, "map_conf.txt",
        &format!("char_ip: ragnarok-char\nmap_ip: {advertise}\nmotd_txt: conf/import/motd.txt\n{}",
                 mods.npc_lines))?;

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
