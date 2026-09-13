//! What about this host stops the app from running, asked rather than inferred.
//!
//! Two Windows conditions account for nearly every "it will not start" report,
//! they are invisible from inside the app, and both used to be read backwards
//! out of whatever failure they eventually caused.
//!
//! **Virtualisation.** Three unrelated faults produce one symptom: it off in
//! firmware, the Windows Hypervisor Platform feature off, and the hypervisor
//! switched off at boot by `bcdedit`. They are fixed in three different places
//! and only one of them is the checkbox the old message named, so a player who
//! had already ticked it was told to tick it again, restarted, and got the same
//! error -- with nothing in the diagnostics bundle to tell the three apart.
//!
//! **Smart App Control.** On Windows 11 it refuses unsigned binaries at load,
//! and the refusal arrives as 0xC0000135, which is indistinguishable from a
//! genuinely missing DLL. Until the release is signed this is a real cause of a
//! guest that never boots, so the state is read directly.
//!
//! Everything here is readable without elevation except the hypervisor's boot
//! setting, which is the one that most needs reading; where that is refused
//! this says so instead of guessing.

#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::process::Command;

// ---------------------------------------------------------------------------
// Windows: virtualisation
// ---------------------------------------------------------------------------

/// Which BIOS setting to name. The two vendors call the same feature different
/// things, and "enable virtualisation in your BIOS" sends someone hunting
/// through menus for a word that is not in any of them.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(PartialEq)]
pub enum Vendor {
    Amd,
    Intel,
    Unknown,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Vendor {
    /// What the firmware setting is called, and where it usually lives.
    fn bios_setting(&self) -> &'static str {
        match self {
            // Named first because it is what the boards say. Most AM4 and AM5
            // boards ship with it off, which is why this is the common case on
            // a Ryzen and nearly unheard of on a prebuilt Intel desktop.
            Vendor::Amd => "\"SVM Mode\" (sometimes \"SVM\" or \"AMD-V\"), usually under \
                            Advanced, in CPU Configuration. Most AMD motherboards ship \
                            with it switched off",
            Vendor::Intel => "\"Intel Virtualization Technology\" (sometimes \"VT-x\"), \
                              usually under Advanced, in CPU Configuration",
            Vendor::Unknown => "Intel VT-x, AMD-V or SVM Mode, depending on the \
                                processor, usually under Advanced, in CPU Configuration",
        }
    }
}

/// What is wrong, as far as can be told without elevation.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(PartialEq, Clone, Copy, Debug)]
pub enum Diagnosis {
    /// The firmware switch is off. Windows cannot fix this and neither can we.
    FirmwareOff,
    /// The processor itself does not report the virtualisation extensions.
    /// Rare, and unfixable, so it must never be said on a guess.
    NoCpuSupport,
    /// Firmware is on, no hypervisor is running: the feature is off, waiting
    /// for a restart, or `hypervisorlaunchtype` is off.
    NotLaunching,
    /// A hypervisor is running but will not lend us the platform API.
    Occupied,
    /// Nothing to say.
    Unknown,
}

/// Which fault this is, from readings alone.
///
/// Pure, and compiled on every platform, so the tests below run on the machine
/// this is developed on. That is the whole point of it being separate: this
/// decides what a stuck player is told, it only ever executes on a Windows
/// machine that is already broken, and `cargo test` on a Mac would otherwise
/// never touch it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn classify(
    whp: Option<bool>,
    firmware: Option<bool>,
    vm_monitor_mode: Option<bool>,
    hypervisor_running: Option<bool>,
) -> Diagnosis {
    if whp == Some(true) {
        return Diagnosis::Unknown;
    }
    // Firmware first: it is the only one of these the others cannot mask, and
    // acting on it means a trip into the BIOS that nobody should make on a
    // maybe.
    if firmware == Some(false) {
        return Diagnosis::FirmwareOff;
    }
    // VMMonitorModeExtensions is NOT the same reading seen from the other side,
    // which is what this code first assumed. It is what the silicon can do, and
    // it stays true with the BIOS switch off: a player whose firmware was
    // disabled reported it as Yes in the same breath as Windows refusing to
    // install Hyper-V for want of firmware support. So it only answers a
    // different and much rarer question -- a processor that cannot do this at
    // all -- and it must not be allowed to stand in for the switch.
    if vm_monitor_mode == Some(false) {
        return Diagnosis::NoCpuSupport;
    }
    match hypervisor_running {
        // Something holds the CPU but will not lend us the platform API.
        Some(true) => Diagnosis::Occupied,
        // Nothing is running. Either the feature is off or it has been told not
        // to start; unelevated reads cannot split those two, so the advice
        // covers both rather than picking one.
        //
        // Reached with `firmware` either true or unreadable, and those are not
        // the same thing to say out loud -- see `advice`.
        Some(false) => Diagnosis::NotLaunching,
        None => Diagnosis::Unknown,
    }
}

/// What to tell the player, in the order they should act.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn advice(diagnosis: Diagnosis, vendor: &Vendor, firmware_confirmed: bool) -> String {
    match diagnosis {
        Diagnosis::FirmwareOff => format!(
            "Virtualisation is switched off in your computer's firmware, and no \
             setting in Windows can switch it on -- it has to be done in the \
             BIOS.\n\n\
             Restart the computer and press the setup key as it starts. It is \
             shown briefly on the first screen, and is usually Del or F2. Then \
             look for {}.\n\n\
             Save, let Windows start, and open Ragnarok Offline again. To check \
             it took: Task Manager (Ctrl+Shift+Esc), Performance, CPU, and \
             \"Virtualization\" on the right should read Enabled.",
            vendor.bios_setting()
        ),
        Diagnosis::NotLaunching => {
            // Only where Windows actually said so. This reassurance is the most
            // load-bearing sentence here -- it is the one that stops an AMD
            // owner going back into a BIOS that is already right -- and for
            // exactly that reason it must never be said on a missing reading.
            // VirtualizationFirmwareEnabled comes back empty on some machines,
            // and telling someone whose SVM really is off that their BIOS is
            // fine is worse than telling them nothing.
            let opener = if firmware_confirmed {
                "Virtualisation is on in your firmware, so this is not your BIOS. What \
                 is not happening is the hypervisor starting, and two separate things \
                 stop that."
            } else {
                "Windows would not tell us whether virtualisation is on in your \
                 firmware, so check that first: Task Manager (Ctrl+Shift+Esc), \
                 Performance, CPU, and \"Virtualization\" on the right. On a Windows \
                 that is not in English the label is translated, but it sits in the \
                 same place. If it reads Disabled, that is the whole problem and it is \
                 fixed in the BIOS, not here.\n\n\
                 If it reads Enabled, then what is not happening is the hypervisor \
                 starting, and two separate things stop that."
            };
            let amd = if firmware_confirmed && vendor == &Vendor::Amd {
                "\n\nWorth knowing on an AMD machine: Windows reports your firmware \
                 virtualisation as on, so SVM Mode is already enabled and the BIOS is \
                 not what to change here."
            } else {
                ""
            };
            format!(
                "{opener}{amd}\n\n\
                 1. The Windows feature. Press Windows+R, run `optionalfeatures`, and \
                 tick BOTH \"Windows Hypervisor Platform\" and \"Virtual Machine \
                 Platform\". Then restart -- properly restart, because the hypervisor \
                 only starts at boot and shutting down with fast startup on does not \
                 count as one.\n\n\
                 2. The boot setting, which is invisible and survives everything \
                 above. If you have ever followed a guide for an emulator, VirtualBox \
                 or an anti-cheat problem that had you run `bcdedit /set \
                 hypervisorlaunchtype off`, that is still in force: the feature stays \
                 ticked, every restart looks fine, and the hypervisor never starts. \
                 Open a Command Prompt as Administrator and run:\n\n\
                 \x20   bcdedit /set hypervisorlaunchtype auto\n\n\
                 then restart.\n\n\
                 If you have already done the first and it changed nothing, it is the \
                 second one. To see which, in that same Administrator Command \
                 Prompt:\n\n\
                 \x20   bcdedit /enum {{current}} | findstr -i hypervisorlaunchtype"
            )
        }
        Diagnosis::NoCpuSupport => format!(
            "Windows reports that this processor does not offer the virtualisation \
             extensions the virtual machine needs.\n\n\
             Check the BIOS before believing that, because some machines report it \
             this way when the setting is merely switched off: look for {}. If it is \
             there and already on, then the processor is genuinely too old for this \
             and no setting will change it.",
            vendor.bios_setting()
        ),
        Diagnosis::Occupied =>
            "A hypervisor is already running on this machine, but it will not give \
             this app the Windows Hypervisor Platform, which is what runs the virtual \
             machine. Two things do that.\n\n\
             1. The feature is off. Press Windows+R, run `optionalfeatures`, tick \
             \"Windows Hypervisor Platform\", and restart. Something else -- Memory \
             Integrity, Credential Guard, WSL or Docker Desktop -- can be running a \
             hypervisor while this one particular feature is off.\n\n\
             2. Kernel-level anti-cheat. Riot Vanguard (Valorant, League of Legends) \
             and a few others take the hypervisor exclusively for as long as their \
             driver is loaded, and nothing else can start a virtual machine until the \
             computer is restarted without it running."
                .to_string(),
        Diagnosis::Unknown =>
            "The virtual machine could not start, and the usual causes all check out \
             on this machine: virtualisation is on and a hypervisor is available. \
             Settings has a Report a problem button, and the logs it collects now \
             include the virtual machine's own startup error and what Windows says \
             about virtualisation."
                .to_string(),
    }
}

/// How a diagnosis reads in the bundle, for whoever triages it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn reading(diagnosis: Diagnosis) -> &'static str {
    match diagnosis {
        Diagnosis::FirmwareOff =>
            "virtualisation is off in firmware; the BIOS setting has to be changed",
        Diagnosis::NoCpuSupport =>
            "the processor does not report the virtualisation extensions; check the \
             BIOS anyway, some machines read this way when it is only switched off",
        Diagnosis::NotLaunching =>
            "no hypervisor is running and the firmware switch is not the cause: the \
             feature is off, waiting for a restart, or hypervisorlaunchtype is off",
        Diagnosis::Occupied =>
            "a hypervisor is running but will not lend us the platform API: the \
             feature is off, or anti-cheat holds it exclusively",
        Diagnosis::Unknown => "nothing wrong that this can see",
    }
}

#[cfg(windows)]
pub struct Probe {
    /// WHvGetCapability(HypervisorPresent) -- the same question libkrun asks.
    pub whp: Option<bool>,
    /// Win32_ComputerSystem.HypervisorPresent: is *any* hypervisor running.
    pub hypervisor_running: Option<bool>,
    /// Win32_Processor.VirtualizationFirmwareEnabled: the BIOS switch.
    pub firmware: Option<bool>,
    pub vm_monitor_mode: Option<bool>,
    pub slat: Option<bool>,
    pub vendor: Vendor,
    pub vendor_text: String,
    /// `bcdedit`'s hypervisorlaunchtype, when it can be read at all.
    pub launch_type: Result<String, String>,
    /// Is the hypervisor itself installed on disk. An observation, not proof:
    /// see `hypervisor_image`.
    pub image: Option<&'static str>,
}

/// Is the Windows Hypervisor Platform actually usable?
///
/// `Some(false)` means no hypervisor is available to it; `None` means we could
/// not tell and the caller should say nothing.
///
/// This asks the same question libkrun asks, in the same way, rather than
/// inferring it. Win32_ComputerSystem.HypervisorPresent is not the same thing:
/// it is true whenever any hypervisor is running -- Hyper-V for Credential
/// Guard or Memory Integrity sets it -- and we told a player their
/// virtualisation was fine on that basis while WHP was off and the guest could
/// not boot. Get-WindowsOptionalFeature would answer correctly but needs
/// elevation, and WinHvPlatform.dll is present either way, so its existence
/// proves nothing (checked on Windows 10 19045 and Windows 11 26200: present
/// with the feature both enabled and disabled).
///
/// Loaded dynamically. Linking WinHvPlatform.dll at load time would mean a
/// Windows without it could not start this binary at all -- 0xC0000135, the
/// failure we spent an evening on already.
#[cfg(windows)]
pub fn whp_capability() -> Option<bool> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryA(name: *const u8) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }
    // WHvCapabilityCodeHypervisorPresent
    const HYPERVISOR_PRESENT: u32 = 0x0000_0000;
    unsafe {
        let module = LoadLibraryA(b"WinHvPlatform.dll\0".as_ptr());
        if module.is_null() {
            return None;
        }
        let proc = GetProcAddress(module, b"WHvGetCapability\0".as_ptr());
        if proc.is_null() {
            return None;
        }
        let get_capability: unsafe extern "system" fn(u32, *mut c_void, u32, *mut u32) -> i32 =
            std::mem::transmute(proc);
        let mut present: u32 = 0;
        let mut written: u32 = 0;
        let hr = get_capability(
            HYPERVISOR_PRESENT,
            &mut present as *mut u32 as *mut c_void,
            4,
            &mut written,
        );
        if hr != 0 || written != 4 {
            return None;
        }
        Some(present != 0)
    }
}

/// The processor and hypervisor facts Windows will hand over unelevated.
///
/// One spawn for all of them: this runs on a failure path, but it also runs
/// whenever anyone collects diagnostics, and five PowerShell starts to answer
/// five one-word questions is most of a second each time.
///
/// VirtualizationFirmwareEnabled is only meaningful while no hypervisor is
/// running -- Windows reports it empty once one has taken the CPU -- which is
/// exactly the case we are in when any of this is being asked.
#[cfg(windows)]
fn cim_facts() -> Vec<(String, String)> {
    let script = "\
        $ErrorActionPreference='SilentlyContinue';\
        $cs = Get-CimInstance Win32_ComputerSystem;\
        $p = Get-CimInstance Win32_Processor | Select-Object -First 1;\
        \"hypervisor_running=$($cs.HypervisorPresent)\";\
        \"firmware=$($p.VirtualizationFirmwareEnabled)\";\
        \"vm_monitor_mode=$($p.VMMonitorModeExtensions)\";\
        \"slat=$($p.SecondLevelAddressTranslationExtensions)\";\
        \"vendor=$($p.Manufacturer)\"";
    let out = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once('=')?;
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

/// PowerShell prints booleans as True/False and a null property as nothing.
#[cfg(windows)]
fn tri_state(value: Option<&String>) -> Option<bool> {
    match value.map(|v| v.as_str()) {
        Some("True") => Some(true),
        Some("False") => Some(false),
        _ => None,
    }
}

/// Has the hypervisor been switched off at boot?
///
/// This is the single most useful fact here and the only one Windows will not
/// give up without elevation, which is the whole shape of the problem: a
/// machine with `hypervisorlaunchtype off` has the feature ticked, restarts
/// cleanly, and fails identically forever. `bcdedit` refuses a non-elevated
/// read of the store, so record the refusal rather than reporting a guess as a
/// reading -- a bundle that says "unreadable" prompts one question, and a
/// bundle that quietly says "auto" sends everyone down the wrong path.
#[cfg(windows)]
fn launch_type() -> Result<String, String> {
    let out = Command::new("bcdedit")
        .args(["/enum", "{current}"])
        .output()
        .map_err(|e| format!("could not run bcdedit: {e}"))?;
    if !out.status.success() {
        return Err("unreadable without an administrator".into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("hypervisorlaunchtype") {
            return Ok(rest.trim().to_string());
        }
    }
    // The value is absent from the store until something sets it, and the
    // default when absent is Auto. Say both, because "not set" reads as a
    // fault and it is not one.
    Ok("not set (the default, which means Auto)".into())
}

/// Is the hypervisor image on disk at all.
///
/// hvax64.exe is the AMD build and hvix64.exe the Intel one, and they arrive
/// with the hypervisor component rather than with a stock Windows. Treated as
/// an observation and never as the answer: it is undocumented, it has moved
/// between builds before, and the conclusions here do not rest on it. It earns
/// its place by correlating across reports -- absent on a machine whose owner
/// swears the feature is ticked is worth knowing.
#[cfg(windows)]
fn hypervisor_image() -> Option<&'static str> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    for name in ["hvax64.exe", "hvix64.exe"] {
        if std::path::Path::new(&root).join("System32").join(name).exists() {
            return Some(name);
        }
    }
    None
}

#[cfg(windows)]
pub fn probe() -> Probe {
    let facts = cim_facts();
    let get = |key: &str| facts.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let vendor_text = get("vendor").cloned().unwrap_or_default();
    let vendor = match vendor_text.as_str() {
        "AuthenticAMD" => Vendor::Amd,
        "GenuineIntel" => Vendor::Intel,
        _ => Vendor::Unknown,
    };
    Probe {
        whp: whp_capability(),
        hypervisor_running: tri_state(get("hypervisor_running")),
        firmware: tri_state(get("firmware")),
        vm_monitor_mode: tri_state(get("vm_monitor_mode")),
        slat: tri_state(get("slat")),
        vendor,
        vendor_text,
        launch_type: launch_type(),
        image: hypervisor_image(),
    }
}

#[cfg(windows)]
impl Probe {
    /// Which of the three faults this is, as far as unelevated reads can tell.
    pub fn diagnosis(&self) -> Diagnosis {
        classify(self.whp, self.firmware, self.vm_monitor_mode, self.hypervisor_running)
    }

    /// The diagnostics block. Written for whoever reads the report, not for
    /// the player, so it states the readings and then states the reading of
    /// them separately -- a bundle that only carried a conclusion would be
    /// impossible to second-guess when the conclusion is wrong.
    pub fn describe(&self) -> String {
        let yes_no = |v: Option<bool>| match v {
            Some(true) => "yes".to_string(),
            Some(false) => "no".to_string(),
            None => "unknown".to_string(),
        };
        let mut lines = vec![
            format!("cpu vendor          {}", if self.vendor_text.is_empty() {
                "unknown"
            } else {
                &self.vendor_text
            }),
            format!("whp usable          {}", match self.whp {
                Some(true) => "yes",
                Some(false) => "no (WHvGetCapability reports no hypervisor)",
                None => "unknown (WinHvPlatform.dll would not answer)",
            }),
            format!("hypervisor running  {}", yes_no(self.hypervisor_running)),
            format!("firmware virt       {}", yes_no(self.firmware)),
            format!("vm monitor mode     {}", yes_no(self.vm_monitor_mode)),
            format!("slat                {}", yes_no(self.slat)),
            format!("hypervisor image    {}", match self.image {
                Some(name) => name,
                None => "absent from System32",
            }),
            format!("launch type         {}", match &self.launch_type {
                Ok(value) => value.clone(),
                Err(why) => why.clone(),
            }),
        ];
        lines.push(format!("reading             {}", reading(self.diagnosis())));
        if matches!(self.launch_type, Err(_)) && self.diagnosis() == Diagnosis::NotLaunching {
            // The one reading that would split NotLaunching in two, and the
            // one we cannot take. Put the command in the bundle so whoever
            // reads it can ask for it in a single message.
            lines.push(
                "to split it         ask them to run, as Administrator:\n\
                 \x20                   bcdedit /enum {current} | findstr -i hypervisorlaunchtype"
                    .into(),
            );
        }
        lines.join("\n")
    }

    /// What to tell the player, in the order they should act.
    pub fn advice(&self) -> String {
        advice(self.diagnosis(), &self.vendor, self.firmware == Some(true))
    }
}

/// The precheck's message: probe, then say the one thing that is true here.
///
/// Only ever reached once `whp_capability()` has already said no, so the extra
/// spawns this costs are on a path that was about to fail anyway.
#[cfg(windows)]
pub fn blocked_help() -> String {
    format!(
        "The virtual machine cannot start: Windows is not offering the hypervisor \
         this app runs it on.\n\n{}",
        probe().advice()
    )
}

// ---------------------------------------------------------------------------
// Windows: Smart App Control
// ---------------------------------------------------------------------------

/// Smart App Control's three states, as Windows records them.
///
/// Read rather than inferred from a failure. Under enforcement an unsigned
/// binary is refused at load with 0xC0000135, which is indistinguishable from
/// a genuinely missing DLL -- so the state has to be checked, not guessed from
/// the corpse.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(PartialEq, Clone, Copy, Debug)]
pub enum AppControl {
    /// Off, and on Windows 11 it cannot be turned back on. Nothing to do.
    Off,
    /// Refusing unsigned binaries right now.
    Enforcing,
    /// Watching, and it promotes itself to enforcement on its own. A machine
    /// that works today and stops working next week with no change from us
    /// looks like our bug, so this is worth carrying in a report even though
    /// nothing is failing yet.
    Evaluating,
    /// No such policy value: every Windows 10, and a Windows 11 that has never
    /// had the feature.
    Absent,
}

#[cfg(windows)]
pub fn app_control_state() -> AppControl {
    let out = Command::new("reg")
        .args([
            "query",
            r"HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy",
            "/v",
            "VerifiedAndReputablePolicyState",
        ])
        .output();
    let Ok(out) = out else { return AppControl::Absent };
    if !out.status.success() {
        return AppControl::Absent;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // "VerifiedAndReputablePolicyState    REG_DWORD    0x1"
    match text.split_whitespace().last() {
        Some(v) if v.eq_ignore_ascii_case("0x1") => AppControl::Enforcing,
        Some(v) if v.eq_ignore_ascii_case("0x2") => AppControl::Evaluating,
        Some(v) if v.eq_ignore_ascii_case("0x0") => AppControl::Off,
        _ => AppControl::Absent,
    }
}

/// Does this PE carry an Authenticode signature?
///
/// The certificate table is data directory 4 in the optional header; a size of
/// zero means nothing signed it. Parsed here rather than shelling out to
/// PowerShell, because this runs on every start and a process spawn to answer
/// "did we sign our own binary" is a poor trade.
#[cfg(windows)]
pub fn pe_is_signed(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return false };
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

/// Will Smart App Control stop this binary from loading?
#[cfg(windows)]
pub fn app_control_blocks(binary: &Path) -> bool {
    app_control_state() == AppControl::Enforcing && !pe_is_signed(binary)
}

/// What to tell someone whose machine refuses to load an unsigned engine.
///
/// This deliberately does not lead with the workaround. Switching Smart App
/// Control off is irreversible without reinstalling Windows and it lowers the
/// protection on every program on the machine, not just ours -- recommending
/// that to fix a game is a bad trade, and the honest answer is that the defect
/// is ours and we are fixing it. The instructions are here because a player who
/// has weighed that and still wants to play should not have to go and find
/// them, not because they are the advice.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn app_control_help(reason: &str) -> String {
    format!(
        "{reason}\n\n\
         Windows blocked this app from running. Its files are not code-signed \
         yet, and Smart App Control refuses programs it does not recognise. \
         This is not a problem with your computer and it is not a virus -- it \
         is a signature we have not got yet. It affects newer Windows 11 \
         installs, where Smart App Control is on by default; it switches itself \
         off on machines upgraded from older Windows, which is why most people \
         never see this.\n\n\
         What we would rather you did: wait for the signed release. It needs \
         nothing from you, it is the actual fix, and it is in progress -- the \
         binaries are with Microsoft for signing approval now. Progress is \
         tracked here:\n\n\
         \x20   https://github.com/Flux159/ragnarokoffline.app/issues/8\n\n\
         We do NOT recommend turning Smart App Control off. It is not a setting \
         you can put back: Windows will not let it be switched on again without \
         reinstalling Windows, and until you do it stops protecting every other \
         program on the machine as well, not only this one.\n\n\
         If you have read that and still want to play now, it is under Windows \
         Security -> App & browser control -> Smart App Control settings -> Off."
    )
}

/// How an app-control state reads in the bundle.
///
/// Evaluation mode gets its own line rather than being folded into "off": it
/// promotes itself to enforcement without anyone doing anything, so a machine
/// that works today and refuses to start next week is a report that will look
/// like our regression and will not be one.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn app_control_reading(state: AppControl, signed: bool) -> &'static str {
    match (state, signed) {
        (AppControl::Enforcing, false) =>
            "this is the fault: Windows will refuse to load the engine, as 0xC0000135",
        (AppControl::Evaluating, false) =>
            "not failing yet, but it will the moment Windows promotes this to enforcement",
        (_, false) => "unsigned, but nothing on this machine is blocking it",
        (_, true) => "signed, so Smart App Control is not involved",
    }
}

#[cfg(windows)]
fn app_control_describe(binary: &Path) -> String {
    let state = app_control_state();
    let signed = pe_is_signed(binary);
    let mut lines = vec![
        format!("smart app control   {}", match state {
            AppControl::Enforcing => "enforcement (refuses unsigned binaries)",
            AppControl::Evaluating => "evaluation (can promote itself to enforcement)",
            AppControl::Off => "off",
            AppControl::Absent => "not present (every Windows 10, and Windows 11 without it)",
        }),
        format!("engine signed       {}", if signed { "yes" } else { "no" }),
        format!("engine binary       {}", binary.display()),
    ];
    lines.push(format!("reading             {}", app_control_reading(state, signed)));
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// The diagnostics block
// ---------------------------------------------------------------------------

/// Both host conditions, as sections for the report the app collects.
///
/// The `=====` headers are written here rather than by the caller so that one
/// process spawn yields both sections. That couples this to the bundle's
/// formatting, which is a small price for not paying a second PowerShell start
/// every time someone reports a problem.
#[cfg(windows)]
pub fn report(engine: &Path) -> String {
    format!(
        "===== virtualisation =====\n{}\n\n===== app control =====\n{}\n",
        probe().describe(),
        app_control_describe(engine)
    )
}

#[cfg(not(windows))]
pub fn report(_engine: &std::path::Path) -> String {
    format!("===== virtualisation =====\n{}\n", describe())
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

/// /dev/kvm and whether this user can open it, which is the whole of the
/// question here and matches the advice the failure path already gives.
#[cfg(target_os = "linux")]
pub fn describe() -> String {
    use std::path::Path;
    let dev = Path::new("/dev/kvm");
    if !dev.exists() {
        return "kvm                 /dev/kvm is absent (virtualisation off in \
                firmware, or no kvm module loaded)"
            .into();
    }
    let writable = std::fs::OpenOptions::new().read(true).write(true).open(dev);
    format!(
        "kvm                 /dev/kvm present, {}",
        match writable {
            Ok(_) => "openable by this user".to_string(),
            Err(e) => format!("not openable by this user: {e} (usually the `kvm` group)"),
        }
    )
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/// Nothing to switch on and nothing to get wrong: the framework is part of the
/// OS and the only requirement is the OS version, which the `app` block above
/// already carries.
#[cfg(target_os = "macos")]
pub fn describe() -> String {
    "virtualisation      Virtualization.framework, no host configuration required".into()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// These cover the decision, not the probing: what a reading means, and which of
// three quite different instructions a stuck player is handed. The probing
// itself is Windows-only and cannot run here, but the part that is easy to get
// wrong and expensive to get wrong is pure, so it runs everywhere.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firmware_off_outranks_everything_else() {
        // The one fault Windows cannot fix for you, so it must not be masked.
        assert_eq!(
            classify(Some(false), Some(false), Some(false), Some(false)),
            Diagnosis::FirmwareOff
        );
        // A missing monitor-mode reading must not stop the firmware switch
        // being reported, and does not.
        assert_eq!(
            classify(Some(false), Some(false), None, Some(false)),
            Diagnosis::FirmwareOff
        );
    }

    /// The report this was written for: Windows 10, Ryzen 5800X, the feature
    /// ticked and restarted, and the same error every time.
    #[test]
    fn firmware_on_and_nothing_running_is_the_boot_setting() {
        let d = classify(Some(false), Some(true), Some(true), Some(false));
        assert_eq!(d, Diagnosis::NotLaunching);
        let text = advice(d, &Vendor::Amd, true);
        // Both remedies, because unelevated reads cannot tell them apart.
        assert!(text.contains("optionalfeatures"));
        assert!(text.contains("bcdedit /set hypervisorlaunchtype auto"));
        // And it must not send an AMD owner to a BIOS setting already correct.
        assert!(text.contains("SVM Mode is already enabled"));
        assert!(!text.contains("has to be done in the BIOS"));
    }

    #[test]
    fn a_running_hypervisor_that_will_not_share_names_anti_cheat() {
        let d = classify(Some(false), Some(true), Some(true), Some(true));
        assert_eq!(d, Diagnosis::Occupied);
        assert!(advice(d, &Vendor::Unknown, true).contains("Vanguard"));
    }

    #[test]
    fn a_working_platform_diagnoses_nothing() {
        assert_eq!(
            classify(Some(true), Some(false), Some(false), Some(false)),
            Diagnosis::Unknown
        );
    }

    /// Nothing readable must not become a confident answer.
    #[test]
    fn unknown_readings_stay_unknown() {
        assert_eq!(classify(None, None, None, None), Diagnosis::Unknown);
        assert_eq!(classify(Some(false), None, None, None), Diagnosis::Unknown);
    }

    /// Each vendor is told the name its own firmware uses. Getting this wrong
    /// sends someone hunting a menu for a word that is not in it.
    #[test]
    fn the_bios_setting_is_named_per_vendor() {
        let amd = advice(Diagnosis::FirmwareOff, &Vendor::Amd, false);
        assert!(amd.contains("SVM Mode"));
        assert!(!amd.contains("Intel"));

        let intel = advice(Diagnosis::FirmwareOff, &Vendor::Intel, false);
        assert!(intel.contains("Intel Virtualization Technology"));
        assert!(!intel.contains("SVM Mode"));

        // Unknown silicon gets every name rather than a guess.
        let other = advice(Diagnosis::FirmwareOff, &Vendor::Unknown, false);
        assert!(other.contains("VT-x") && other.contains("SVM Mode"));
    }

    #[test]
    fn evaluation_mode_is_reported_before_it_breaks_anything() {
        assert!(app_control_reading(AppControl::Evaluating, false).contains("not failing yet"));
        assert!(app_control_reading(AppControl::Enforcing, false).contains("0xC0000135"));
        // Signed binaries clear it whatever the machine's setting is.
        for state in [AppControl::Enforcing, AppControl::Evaluating, AppControl::Off] {
            assert!(app_control_reading(state, true).contains("not involved"));
        }
    }

    /// Turning Smart App Control off is irreversible and lowers protection for
    /// every other program on the machine. The message may explain how, but it
    /// must recommend waiting for the signed build first.
    /// The report this came from: an AMD machine with SVM off in the BIOS.
    /// Windows had it right all along -- the Hyper-V checkbox refused to
    /// install for want of firmware support -- and this is the reading that
    /// has to land on the BIOS rather than on optionalfeatures.
    #[test]
    fn svm_off_in_the_bios_is_diagnosed_as_the_bios() {
        // VM Monitor Mode Extensions stays true with the switch off: that
        // machine reported "Sim" for it in the same breath as Windows
        // refusing Hyper-V for want of firmware virtualisation.
        let d = classify(Some(false), Some(false), Some(true), Some(false));
        assert_eq!(d, Diagnosis::FirmwareOff);
        let text = advice(d, &Vendor::Amd, false);
        assert!(text.contains("SVM Mode"));
        assert!(!text.contains("optionalfeatures"));
    }

    /// The failure that would have made this worse than saying nothing.
    /// VirtualizationFirmwareEnabled comes back empty on some machines; if it
    /// had on that player's, the old code would have told them their BIOS was
    /// already correct while SVM was switched off.
    #[test]
    fn an_unread_firmware_switch_is_never_reported_as_fine() {
        let d = classify(Some(false), None, Some(true), Some(false));
        assert_eq!(d, Diagnosis::NotLaunching);
        let text = advice(d, &Vendor::Amd, false);
        assert!(!text.contains("SVM Mode is already enabled"));
        assert!(!text.contains("this is not your BIOS"));
        // It sends them to look, and says the label is translated elsewhere.
        assert!(text.contains("Task Manager"));
        assert!(text.contains("translated"));
        // Still carries both real remedies underneath.
        assert!(text.contains("bcdedit /set hypervisorlaunchtype auto"));
    }

    /// Only a positive reading earns the reassurance.
    #[test]
    fn a_confirmed_firmware_switch_still_says_the_bios_is_fine() {
        let text = advice(Diagnosis::NotLaunching, &Vendor::Amd, true);
        assert!(text.contains("SVM Mode is already enabled"));
        assert!(text.contains("this is not your BIOS"));
    }

    /// A processor that genuinely cannot do it is not a BIOS instruction, but
    /// it hedges, because some machines report it this way when it is merely
    /// switched off.
    #[test]
    fn no_processor_support_is_hedged_rather_than_asserted() {
        let d = classify(Some(false), None, Some(false), Some(false));
        assert_eq!(d, Diagnosis::NoCpuSupport);
        let text = advice(d, &Vendor::Intel, false);
        assert!(text.contains("Check the BIOS before believing that"));
        assert!(text.contains("Intel Virtualization Technology"));
    }

    #[test]
    fn app_control_help_does_not_recommend_switching_it_off() {
        let text = app_control_help("blocked");
        let recommends_waiting = text.find("wait for the signed release").expect("offers the wait");
        let explains_how = text.find("Smart App Control settings -> Off").expect("explains how");
        assert!(recommends_waiting < explains_how, "the workaround must not come first");
        assert!(text.contains("We do NOT recommend"));
        assert!(text.contains("reinstalling Windows"));
        assert!(text.contains("issues/8"));
    }
}


