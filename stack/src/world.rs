//! One-file backup and restore of a whole world: every era's database, the
//! settings, and the installed mods.
//!
//!   ragnarok-stack backup --full <file.tar.gz>
//!   ragnarok-stack restore --full <file.tar.gz>
//!
//! `backup <file>` saves the database of the era that is running and nothing
//! else; a player who reinstalls with only that gets their characters back
//! into a server with none of their mods, rates or switched-on options. This
//! is the whole thing, in one file they choose where to keep.
//!
//! The archive is an ordinary `.tar.gz`, so any archiver opens it:
//!
//! ```text
//! manifest.json                 always first, so a restore can refuse early
//! database/<era>.sql            one per era whose database exists
//! settings/settings.json        everything Settings writes, minus nothing:
//! settings/mod-settings.json      no secret lives in these files
//! settings/prerenewal           the era and Kafra markers, when present
//! settings/free_kafra_warp
//! settings/conf/battle_conf.txt what settings.json implies for the server
//! machine/client.json           where this machine's GRFs are; recorded, not restored
//! mods/...                      state/mods, byte for byte, including
//!                                 disabled.txt / enabled.txt
//! ```
//!
//! Mods are opaque folders here on purpose: their package format is being
//! redesigned, and a backup must not have opinions about it.
//!
//! What is left out is listed in `EXCLUDED` and written into every manifest.
//! The rule is an allowlist -- only the paths above are ever read -- so a
//! secret added somewhere else later is excluded without anyone remembering
//! to exclude it.
//!
//! The manifest is designed to be shared with the hand-off `.roworld` archive
//! planned for later (`kind: "world"`, scrubbed of passwords and logs). This
//! module writes and reads only `kind: "backup"`, which is private and
//! unscrubbed: it contains every account's password, as the database does.

use crate::archive::{self, GzipReader, GzipWriter, Sha256, TarReader, TarWriter};
use crate::config::Config;
use crate::docker::Docker;
use crate::json::{self, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FORMAT: &str = "ragnarok-offline-archive";
pub const FORMAT_VERSION: u64 = 1;
pub const ERAS: [&str; 2] = ["renewal", "prerenewal"];
const MANIFEST: &str = "manifest.json";
const MANIFEST_LIMIT: u64 = 64 * 1024 * 1024;
const AREAS: [&str; 4] = ["database", "settings", "machine", "mods"];

/// State files that are settings, and their names in the archive. Absence
/// means something for each of them (no marker is renewal; no settings.json
/// is every default), so a restore removes the ones the archive does not have.
const SETTINGS: [(&str, &str); 5] = [
    ("settings/settings.json", "settings.json"),
    ("settings/mod-settings.json", "mod-settings.json"),
    ("settings/prerenewal", "prerenewal"),
    ("settings/free_kafra_warp", "free_kafra_warp"),
    ("settings/conf/battle_conf.txt", "conf/battle_conf.txt"),
];

/// The keys of `client.json` that are recorded. It describes this machine --
/// where the GRFs are, how much memory the VM gets -- so a restore never
/// applies it; it is there so a player moving machines can see what they had.
const CLIENT_KEYS: [&str; 8] = ["mode", "lan", "data_grf", "rdata_grf", "official_grf", "bgm_dir", "vm_ram_mib", "hosting_scope"];
const MACHINE_CLIENT: &str = "machine/client.json";

/// What a backup never contains, and why. Written into every manifest.
pub const EXCLUDED: [&str; 6] = [
    "Cloudflare sharing credentials, the friends invitation and the sharing helpers (the sharing folder): secrets, and tied to this install",
    "the database's internal service passwords (state/private/service-credentials): secrets; a restore keeps this install's own",
    "the AI agent's access token (state/agent): a secret",
    "the address of a host you join (client.json join_host): it can carry a friends invitation",
    "your game client's GRF files: they are yours, large, and never copied; machine/client.json records where they were",
    "logs, crash reports, earlier backups, generated assets and the server's generated configuration: rebuilt on start",
];

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

pub struct Manifest {
    pub app_version: Option<String>,
    pub era: String,
    /// (era, archive path)
    pub databases: Vec<(String, String)>,
    /// archive path -> (size, sha256)
    pub files: BTreeMap<String, (u64, String)>,
}

/// "1.3.5" -> [1, 3, 5]; anything after a part's leading digits is ignored,
/// so "1.4.0-beta" compares as 1.4.0.
fn version_parts(v: &str) -> Vec<u64> {
    v.split('.')
        .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
        .collect()
}

pub fn newer(theirs: &str, ours: &str) -> bool {
    let (a, b) = (version_parts(theirs), version_parts(ours));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn number(v: Option<&Value>) -> Option<u64> {
    match v {
        Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 0.0 && *n < 9.0e15 => Some(*n as u64),
        _ => None,
    }
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Read a manifest and refuse anything this build cannot restore faithfully.
pub fn parse_manifest(body: &str, ours: Option<&str>) -> Result<Manifest, String> {
    const NOT_OURS: &str = "This is not a Ragnarok Offline backup (its manifest.json is not one this app writes).";
    let v = json::parse(body).map_err(|_| NOT_OURS)?;
    if v.str("format") != Some(FORMAT) {
        return Err(NOT_OURS.into());
    }
    let app_version = v.str("app_version").map(str::to_string);
    // The version check comes first, because it is the one with an answer:
    // which app to install.
    if let (Some(theirs), Some(ours)) = (app_version.as_deref(), ours) {
        if newer(theirs, ours) {
            return Err(format!(
                "This backup was made by Ragnarok Offline {theirs}, which is newer than this copy ({ours}). Install Ragnarok Offline {theirs} or later to restore it."
            ));
        }
    }
    let format_version = number(v.get("format_version")).ok_or(NOT_OURS)?;
    if format_version > FORMAT_VERSION {
        return Err("This backup was made by a newer version of Ragnarok Offline. Update the app to restore it.".into());
    }
    match v.str("kind") {
        Some("backup") => {}
        Some("world") => {
            return Err("This is a world hand-off archive, which this version of the app cannot import. Restore it with a version that supports world archives.".into())
        }
        _ => return Err(NOT_OURS.into()),
    }
    let era = v.str("era").filter(|e| ERAS.contains(e)).ok_or(NOT_OURS)?.to_string();

    let mut files = BTreeMap::new();
    let Some(Value::Array(list)) = v.get("files") else { return Err(NOT_OURS.into()) };
    for f in list {
        let path = f.str("path").ok_or(NOT_OURS)?;
        let size = number(f.get("size")).ok_or(NOT_OURS)?;
        let sha = f.str("sha256").filter(|s| is_sha256(s)).ok_or(NOT_OURS)?;
        let parts = archive::safe_path(path).ok_or_else(|| format!("The backup names an unsafe path ({path}); it was not restored."))?;
        if path == MANIFEST || !AREAS.contains(&parts[0]) || parts.len() < 2 {
            return Err(format!("The backup names an unexpected file ({path}); it was not restored."));
        }
        if files.insert(path.to_string(), (size, sha.to_string())).is_some() {
            return Err(format!("The backup lists {path} twice; it was not restored."));
        }
    }
    let mut databases = Vec::new();
    if let Some(Value::Array(list)) = v.get("databases") {
        for d in list {
            let era = d.str("era").filter(|e| ERAS.contains(e)).ok_or(NOT_OURS)?;
            let path = d.str("path").ok_or(NOT_OURS)?;
            if !files.contains_key(path) || !path.starts_with("database/") {
                return Err(NOT_OURS.into());
            }
            if databases.iter().any(|(e, _): &(String, String)| e == era) {
                return Err(NOT_OURS.into());
            }
            databases.push((era.to_string(), path.to_string()));
        }
    }
    Ok(Manifest { app_version, era, databases, files })
}

// ---------------------------------------------------------------------------
// Dates, without a crate
// ---------------------------------------------------------------------------

/// (year, month, day, hour, minute, second) in UTC.
fn utc(t: SystemTime) -> (i64, u32, u32, u32, u32, u32) {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32)
}

fn rfc3339(t: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = utc(t);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn stamp(t: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = utc(t);
    format!("{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// The rAthena commit this build's server was compiled from.
fn rathena_pin() -> Option<String> {
    const PINS: &str = include_str!("../../config/VENDOR_PINS");
    PINS.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>())
        .find(|f| f.first() == Some(&"rathena"))
        .and_then(|f| f.get(2).map(|s| s.to_string()))
}

// ---------------------------------------------------------------------------
// Collecting the files
// ---------------------------------------------------------------------------

struct Item {
    name: String,
    path: PathBuf,
    size: u64,
    sha256: String,
}

/// Every file under `dir`, as `prefix/relative/path`, in name order.
///
/// Links are followed, because the bytes are what a restore needs, and a mod
/// folder linked in from a checkout is an ordinary thing to have. A link back
/// up the tree is skipped rather than followed forever.
fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>, ancestors: &mut Vec<PathBuf>) -> Result<(), String> {
    let real = fs::canonicalize(dir).map_err(|e| format!("reading {}: {e}", dir.display()))?;
    if ancestors.contains(&real) {
        eprintln!("skipped {} in the backup: it links back into a folder that contains it", dir.display());
        return Ok(());
    }
    ancestors.push(real);
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("reading {}: {e}", dir.display()))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("reading {}: {e}", dir.display()))?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let os = entry.file_name();
        let name = os.to_str().ok_or_else(|| {
            format!("{} has a name that is not valid text, so it cannot be backed up. Rename it and try again.", entry.path().display())
        })?;
        let path = entry.path();
        let archived = format!("{prefix}/{name}");
        if archive::safe_path(&archived).is_none() {
            return Err(format!("{} has a name a backup cannot hold. Rename it and try again.", path.display()));
        }
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                eprintln!("skipped {} in the backup: it is a link to something that is not there", path.display());
                continue;
            }
        };
        if meta.is_dir() {
            walk(&path, &archived, out, ancestors)?;
        } else if meta.is_file() {
            out.push((archived, path));
        }
    }
    ancestors.pop();
    Ok(())
}

/// A copy of client.json holding only `CLIENT_KEYS`.
fn redacted_client(data_root: &Path, scratch: &Path) -> Result<Option<PathBuf>, String> {
    let Ok(body) = fs::read_to_string(data_root.join("client.json")) else { return Ok(None) };
    let Ok(Value::Object(all)) = json::parse(&body) else { return Ok(None) };
    let mut fields = Vec::new();
    for key in CLIENT_KEYS {
        let value = match all.get(key) {
            Some(Value::String(s)) => json::quote(s),
            Some(Value::Bool(b)) => b.to_string(),
            Some(Value::Number(n)) if n.is_finite() => {
                if n.fract() == 0.0 { format!("{}", *n as i64) } else { n.to_string() }
            }
            _ => continue,
        };
        fields.push(format!("  {}: {value}", json::quote(key)));
    }
    let path = scratch.join("client.json");
    fs::write(&path, format!("{{\n{}\n}}\n", fields.join(",\n"))).map_err(|e| format!("writing the machine record: {e}"))?;
    Ok(Some(path))
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    archive::sha256_reader(BufReader::with_capacity(256 * 1024, file)).map_err(|e| format!("reading {}: {e}", path.display()))
}

/// Everything that goes in the archive except the manifest, hashed.
fn collect(cfg: &Config, data_root: &Path, dumps: &[(&str, PathBuf)], scratch: &Path) -> Result<Vec<Item>, String> {
    let mut named: Vec<(String, PathBuf)> = Vec::new();
    for (era, path) in dumps {
        named.push((format!("database/{era}.sql"), path.clone()));
    }
    for (archived, local) in SETTINGS {
        let p = cfg.state.join(local);
        if p.is_file() {
            named.push((archived.to_string(), p));
        }
    }
    if let Some(p) = redacted_client(data_root, scratch)? {
        named.push((MACHINE_CLIENT.to_string(), p));
    }
    let mods = cfg.state.join("mods");
    if mods.is_dir() {
        walk(&mods, "mods", &mut named, &mut Vec::new())?;
    }
    named
        .into_iter()
        .map(|(name, path)| {
            let (sha256, size) = hash_file(&path)?;
            Ok(Item { name, path, size, sha256 })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

pub struct Summary {
    pub databases: Vec<String>,
    pub mods: usize,
    pub files: usize,
    pub bytes: u64,
}

fn manifest_json(cfg: &Config, items: &[Item], dumps: &[(&str, PathBuf)], created: SystemTime) -> String {
    let q = |s: &str| json::quote(s);
    let opt = |s: Option<&str>| s.map(q).unwrap_or_else(|| "null".into());
    let era = crate::service_credentials::era(cfg);
    let packetver = crate::packetver::chosen(cfg).ok();

    // Installed mods, with a hash over their files so a later reader can tell
    // whether a mod changed between two archives; bundled ones by name, since
    // the app carries them.
    let listed: BTreeMap<String, [String; 12]> = crate::mods::list(cfg).into_iter().map(|r| (r[1].clone(), r)).collect();
    let mut installed: BTreeMap<&str, (Sha256, u64, u64)> = BTreeMap::new();
    for item in items {
        let Some(rest) = item.name.strip_prefix("mods/") else { continue };
        let Some((folder, inner)) = rest.split_once('/') else { continue };
        let entry = installed.entry(folder).or_insert_with(|| (Sha256::new(), 0, 0));
        entry.0.update(format!("{}  {inner}\n", item.sha256).as_bytes());
        entry.1 += 1;
        entry.2 += item.size;
    }
    let mut mods = Vec::new();
    for (name, (hash, files, bytes)) in installed {
        let row = listed.get(name);
        mods.push(format!(
            "    {{\"name\": {}, \"source\": \"installed\", \"state\": {}, \"version\": {}, \"sha256\": {}, \"files\": {files}, \"bytes\": {bytes}}}",
            q(name),
            opt(row.map(|r| r[0].as_str())),
            opt(row.map(|r| r[5].as_str()).filter(|v| !v.is_empty())),
            q(&hash.hex()),
        ));
    }
    for (name, row) in &listed {
        if row[4] == "bundled" {
            mods.push(format!(
                "    {{\"name\": {}, \"source\": \"bundled\", \"state\": {}, \"version\": {}}}",
                q(name),
                q(&row[0]),
                opt(Some(row[5].as_str()).filter(|v| !v.is_empty())),
            ));
        }
    }
    let databases: Vec<String> = dumps
        .iter()
        .map(|(e, _)| format!("    {{\"era\": {}, \"path\": {}}}", q(e), q(&format!("database/{e}.sql"))))
        .collect();
    let files: Vec<String> = items
        .iter()
        .map(|i| format!("    {{\"path\": {}, \"size\": {}, \"sha256\": {}}}", q(&i.name), i.size, q(&i.sha256)))
        .collect();
    let excluded: Vec<String> = EXCLUDED.iter().map(|e| format!("    {}", q(e))).collect();
    format!(
        "{{\n  \"format\": {},\n  \"format_version\": {FORMAT_VERSION},\n  \"kind\": \"backup\",\n  \"created\": {},\n  \"app_version\": {},\n  \"rathena\": {},\n  \"era\": {},\n  \"packetver\": {},\n  \"databases\": [\n{}\n  ],\n  \"mods\": [\n{}\n  ],\n  \"excluded\": [\n{}\n  ],\n  \"files\": [\n{}\n  ]\n}}\n",
        q(FORMAT),
        q(&rfc3339(created)),
        opt(cfg.app_version.as_deref()),
        opt(rathena_pin().as_deref()),
        q(era),
        opt(packetver),
        databases.join(",\n"),
        mods.join(",\n"),
        excluded.join(",\n"),
        files.join(",\n"),
    )
}

/// Reads through to `inner`, hashing what passes.
struct Hashing<R> {
    inner: R,
    hash: Sha256,
}

impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hash.update(&buf[..n]);
        Ok(n)
    }
}

/// Write the archive for `dumps` plus the settings and mods to `dest`.
///
/// Two passes over the files: one to hash them for the manifest, which goes
/// first so a restore can refuse an archive before unpacking any of it, and
/// one to write them -- hashed again on the way, so a file that changed in
/// between fails the backup instead of producing an archive that would fail
/// its own restore.
pub fn write(cfg: &Config, data_root: &Path, dest: &Path, dumps: &[(&str, PathBuf)], scratch: &Path) -> Result<Summary, String> {
    let items = collect(cfg, data_root, dumps, scratch)?;
    let manifest = manifest_json(cfg, &items, dumps, SystemTime::now());
    let mods: BTreeSet<&str> = items
        .iter()
        .filter_map(|i| i.name.strip_prefix("mods/")?.split_once('/').map(|(f, _)| f))
        .collect();
    let summary = Summary {
        databases: dumps.iter().map(|(e, _)| e.to_string()).collect(),
        mods: mods.len(),
        files: items.len(),
        bytes: items.iter().map(|i| i.size).sum(),
    };
    let fail = |e: io::Error| format!("writing the backup: {e}");
    crate::private_fs::export_with(dest, |file| {
        let gz = GzipWriter::new(BufWriter::with_capacity(256 * 1024, file)).map_err(fail)?;
        let mut tar = TarWriter::new(gz);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        tar.file(MANIFEST, manifest.len() as u64, now, manifest.as_bytes()).map_err(fail)?;
        for item in &items {
            let file = File::open(&item.path).map_err(|e| format!("reading {}: {e}", item.path.display()))?;
            let mtime = file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(now);
            let mut reader = Hashing { inner: BufReader::with_capacity(256 * 1024, file), hash: Sha256::new() };
            tar.file(&item.name, item.size, mtime, &mut reader)
                .map_err(|e| format!("{} could not be backed up: {e}", item.path.display()))?;
            let mut rest = [0u8; 1];
            if reader.read(&mut rest).map(|n| n > 0).unwrap_or(true) || reader.hash.hex() != item.sha256 {
                return Err(format!("{} changed while it was being backed up. Try again.", item.path.display()));
            }
        }
        let gz = tar.finish().map_err(fail)?;
        let mut out = gz.finish().map_err(fail)?;
        out.flush().map_err(fail)?;
        Ok(())
    })?;
    Ok(summary)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

fn damaged(e: io::Error) -> String {
    if e.kind() == io::ErrorKind::InvalidData {
        format!("The backup is damaged ({e}). Nothing was restored.").replace("(damaged archive: ", "(")
    } else {
        format!("The backup could not be read: {e}. Nothing was restored.")
    }
}

/// Unpack `src` into `into`, checking every file against the manifest.
///
/// Nothing outside `into` is touched, so every way an archive can be wrong --
/// a newer app's, a damaged download, a file edited after the fact -- is
/// found here, before the restore has changed anything.
pub fn stage(src: &Path, into: &Path, ours: Option<&str>) -> Result<Manifest, String> {
    let file = File::open(src).map_err(|_| format!("no such backup: {}", src.display()))?;
    let gz = GzipReader::new(BufReader::with_capacity(256 * 1024, file))
        .map_err(|_| "This is not a Ragnarok Offline backup (it is not a .tar.gz file). Nothing was restored.".to_string())?;
    let mut tar = TarReader::new(gz);
    let first = tar.next_entry().map_err(damaged)?.ok_or("The backup is empty. Nothing was restored.")?;
    if first.path != MANIFEST || first.size > MANIFEST_LIMIT {
        return Err("This is not a Ragnarok Offline backup: it does not start with manifest.json. Nothing was restored.".into());
    }
    let mut body = String::new();
    (&mut tar).read_to_string(&mut body).map_err(damaged)?;
    let manifest = parse_manifest(&body, ours)?;

    crate::private_fs::directory(into)?;
    let mut seen = BTreeSet::new();
    while let Some(entry) = tar.next_entry().map_err(damaged)? {
        let Some((size, sha)) = manifest.files.get(&entry.path) else {
            return Err(format!("The backup contains {}, which its manifest does not list: it was changed after it was made. Nothing was restored.", entry.path));
        };
        if !seen.insert(entry.path.clone()) {
            return Err(format!("The backup contains {} twice. Nothing was restored.", entry.path));
        }
        let parts = archive::safe_path(&entry.path).ok_or("The backup names an unsafe path. Nothing was restored.")?;
        let dest: PathBuf = parts.iter().fold(into.to_path_buf(), |p, c| p.join(c));
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("unpacking the backup: {e}"))?;
        }
        let out = File::create(&dest).map_err(|e| format!("unpacking the backup: {e}"))?;
        let mut out = BufWriter::with_capacity(256 * 1024, out);
        let mut reader = Hashing { inner: &mut tar, hash: Sha256::new() };
        let n = io::copy(&mut reader, &mut out).map_err(damaged)?;
        let got = reader.hash.hex();
        out.flush().map_err(|e| format!("unpacking the backup: {e}"))?;
        if n != *size || got != *sha {
            return Err(format!("{} does not match its checksum in the manifest, so the backup is damaged or was changed. Nothing was restored.", entry.path));
        }
    }
    // The gzip trailer carries a checksum of everything; reading to the end
    // is what checks it.
    io::copy(&mut tar.into_inner(), &mut io::sink()).map_err(damaged)?;
    if let Some(missing) = manifest.files.keys().find(|k| !seen.contains(*k)) {
        return Err(format!("The backup is missing {missing}, which its manifest lists. Nothing was restored."));
    }
    Ok(manifest)
}

/// Put the staged settings and mods in place. The databases are the caller's.
pub fn apply(staged: &Path, manifest: &Manifest, state: &Path) -> Result<(), String> {
    for (archived, local) in SETTINGS {
        let target = state.join(local);
        if manifest.files.contains_key(archived) {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("restoring {local}: {e}"))?;
            }
            let temporary = target.with_extension("restoring");
            fs::copy(staged.join(archived), &temporary)
                .and_then(|_| fs::rename(&temporary, &target))
                .map_err(|e| format!("restoring {local}: {e}"))?;
        } else if fs::symlink_metadata(&target).is_ok() {
            fs::remove_file(&target).map_err(|e| format!("restoring {local}: {e}"))?;
        }
    }
    // The mods folder is swapped whole: the backup's state/mods, exactly,
    // rather than merged into what is there. The folder it replaces is in
    // the pre-restore backup.
    let mods = state.join("mods");
    let incoming = staged.join("mods");
    fs::create_dir_all(&incoming).map_err(|e| format!("restoring mods: {e}"))?;
    let previous = staged.join("previous-mods");
    let had = fs::symlink_metadata(&mods).is_ok();
    if had {
        fs::rename(&mods, &previous).map_err(|e| format!("restoring mods: {e}"))?;
    }
    if let Err(e) = fs::rename(&incoming, &mods) {
        if had {
            let _ = fs::rename(&previous, &mods);
        }
        return Err(format!("restoring mods: {e}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// A private working folder under state/private, removed however we leave.
struct Scratch(PathBuf);

impl Scratch {
    fn new(cfg: &Config) -> Result<Scratch, String> {
        crate::private_fs::directory(&cfg.state)?;
        let private = cfg.state.join("private");
        crate::private_fs::directory(&private)?;
        let dir = private.join(format!("world-{}", crate::private_fs::random_hex(8)?));
        crate::private_fs::directory(&dir)?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Dump every era's database that exists, the running one first.
fn dump_all(cfg: &Config, dk: &Docker, into: &Path, running: &'static str) -> Result<Vec<(&'static str, PathBuf)>, String> {
    let mut out = Vec::new();
    for era in std::iter::once(running).chain(ERAS.into_iter().filter(|e| *e != running)) {
        if era != running && !crate::cmds::era_volume_exists(dk, era) {
            continue;
        }
        let path = into.join(format!("{era}.sql"));
        crate::cmds::with_era_database(cfg, dk, era, || {
            crate::cmds::backup_snapshot(cfg, dk, &path.to_string_lossy(), false)
        })
        .map_err(|e| format!("Backing up the {era} database failed: {e}"))?;
        out.push((era, path));
    }
    Ok(out)
}

fn era_name(era: &str) -> &'static str {
    if era == "prerenewal" { "pre-renewal" } else { "renewal" }
}

fn describe(s: &Summary) -> String {
    let dbs: Vec<&str> = s.databases.iter().map(|e| era_name(e)).collect();
    format!(
        "{} database{}, {} installed mod{}, {} files, {} before compression",
        if dbs.is_empty() { "no".to_string() } else { dbs.join(" and ") },
        if dbs.len() == 1 { "" } else { "s" },
        s.mods,
        if s.mods == 1 { "" } else { "s" },
        s.files,
        crate::cmds::human(s.bytes),
    )
}

pub fn backup(cfg: &Config, dk: &Docker, dest: &str) -> Result<(), String> {
    let era = crate::service_credentials::era(cfg);
    crate::accounts::verify_era(cfg, dk, era)?;
    let scratch = Scratch::new(cfg)?;
    let data_root = crate::config::data_root();
    let summary = crate::accounts::with_servers_stopped(cfg, dk, "backup", || {
        let dumps = dump_all(cfg, dk, &scratch.0, era)?;
        write(cfg, &data_root, Path::new(dest), &dumps, &scratch.0)
    })?;
    println!("wrote {dest}: {}", describe(&summary));
    Ok(())
}

pub fn restore(cfg: &Config, dk: &Docker, src: &str) -> Result<(), String> {
    let scratch = Scratch::new(cfg)?;
    let staged = scratch.0.join("restore");
    let manifest = stage(Path::new(src), &staged, cfg.app_version.as_deref())?;

    let era = crate::service_credentials::era(cfg);
    crate::accounts::verify_era(cfg, dk, era)?;
    crate::cmds::stop_game(cfg, dk)?;

    // Everything as it is now, first, in the same format: the way back from
    // this restore is restoring that file.
    // Not state/backups: on Windows that whole folder is copied into the
    // database container for every dump that is loaded, and this file holds
    // every mod.
    let backups = cfg.state.join("world-backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    crate::private_fs::directory(&backups)?;
    let safety = backups.join(format!(
        "before-restore-everything-{}-{}.tar.gz",
        stamp(SystemTime::now()),
        crate::private_fs::random_hex(4)?
    ));
    let current = scratch.0.join("current");
    crate::private_fs::directory(&current)?;
    let dumps = dump_all(cfg, dk, &current, era)
        .and_then(|dumps| write(cfg, &crate::config::data_root(), &safety, &dumps, &current))
        .map_err(|e| format!("Could not save the current world before restoring, so nothing was restored: {e}. Game services are stopped; start the server to play on."))?;
    let _ = dumps;
    let safety_text = safety.display().to_string();
    println!("saved everything as it was before this restore: {safety_text}");
    let failed = |what: String| {
        format!("{what} Game services are stopped. Everything as it was before this restore is saved in {safety_text}; restore that file to go back.")
    };

    for (db_era, path) in &manifest.databases {
        crate::cmds::with_era_database(cfg, dk, db_era, || {
            crate::cmds::load_dump(cfg, dk, &staged.join(path))
                .map_err(|_| "the database did not accept the dump".to_string())?;
            crate::cmds::adopt_loaded_dump(cfg, dk, db_era)
        })
        .map_err(|e| failed(format!("Restoring the {} database failed: {e}.", era_name(db_era))))?;
    }
    apply(&staged, &manifest, &cfg.state).map_err(|e| failed(format!("The databases were restored, but {e}.")))?;

    for other in ERAS {
        if !manifest.databases.iter().any(|(e, _)| e == other) && crate::cmds::era_volume_exists(dk, other) {
            println!("The {} database was not in this backup and was left as it was.", era_name(other));
        }
    }
    println!(
        "restored {src} (made by Ragnarok Offline {}, playing {}); game services are stopped. Start the server to play the restored world -- the app rebuilds the client's assets as it starts. The pre-restore backup is {safety_text}.",
        manifest.app_version.as_deref().unwrap_or("of an unknown version"),
        era_name(&manifest.era),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ro-world-{name}-{}", crate::private_fs::random_hex(6).unwrap()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn config(root: &Path, state: &Path) -> Config {
        Config {
            root: root.to_path_buf(),
            state: state.to_path_buf(),
            nebula_home: root.join("nebula"),
            nebula: root.join("nebula"),
            docker: root.join("docker"),
            image: String::new(),
            db_image: String::new(),
            app_version: Some("1.3.5".into()),
        }
    }

    fn put(path: &Path, body: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    /// Every file under `dir`, relative, with its bytes.
    fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut out = Vec::new();
        if dir.exists() {
            walk(dir, "x", &mut out, &mut Vec::new()).unwrap();
        }
        out.into_iter().map(|(n, p)| (n[2..].to_string(), fs::read(p).unwrap())).collect()
    }

    /// A source install: two eras' dumps, settings, a client.json with
    /// secrets in it, sharing and agent secrets beside, and mods.
    fn source() -> (PathBuf, Config, Vec<(&'static str, PathBuf)>) {
        let home = scratch("source");
        let state = home.join("state");
        put(&state.join("settings.json"), b"{\n  \"base_exp_rate\": 500,\n  \"prerenewal\": true\n}\n");
        put(&state.join("mod-settings.json"), b"{\n  \"cursor\": {\n    \"size\": 2\n  }\n}\n");
        put(&state.join("prerenewal"), b"");
        put(&state.join("conf/battle_conf.txt"), b"base_exp_rate: 500\n");
        put(&state.join("conf/char_conf.txt"), b"passwd: SECRET-interserver\n");
        put(&state.join("private/service-credentials/renewal/credentials.json"), b"{\"root\":\"SECRET-root\"}");
        put(&state.join("agent/connection.json"), b"{\"token\":\"SECRET-agent\"}");
        put(&home.join("sharing/credentials.bin"), b"SECRET-cloudflare");
        put(
            &home.join("client.json"),
            b"{\"mode\":\"host\",\"data_grf\":\"/games/kRO/data.grf\",\"join_host\":\"https://x.example/#invite=SECRET-invite\",\"vm_ram_mib\":4096,\"lan\":false}",
        );
        put(&state.join("mods/disabled.txt"), b"# off\nbig-maps\n");
        put(&state.join("mods/enabled.txt"), b"cursor\n");
        put(&state.join("mods/cursor/mod.json"), b"{\"name\":\"cursor\",\"version\":\"1.2.0\"}");
        put(&state.join("mods/cursor/data/texture/cursors.act"), &(0..70_000u32).map(|i| (i % 251) as u8).collect::<Vec<_>>());
        put(&state.join("mods/big-maps/data/한글 맵/map.gat"), &vec![7u8; 300_000]);
        put(&state.join("mods/big-maps/empty"), b"");
        let deep = format!("mods/big-maps/{}/deep.txt", "long-folder-name".repeat(9));
        put(&state.join(deep), b"long paths survive");
        let dumps = vec![
            ("renewal", home.join("renewal.sql")),
            ("prerenewal", home.join("prerenewal.sql")),
        ];
        put(&dumps[0].1, b"CREATE DATABASE ragnarok; -- renewal characters\n");
        put(&dumps[1].1, b"CREATE DATABASE ragnarok; -- pre-renewal characters\n");
        let cfg = config(&home.join("runtime"), &state);
        (home, cfg, dumps)
    }

    fn backup_of(home: &Path, cfg: &Config, dumps: &[(&str, PathBuf)]) -> PathBuf {
        let dest = home.join("world.tar.gz");
        let work = home.join("work");
        fs::create_dir_all(&work).unwrap();
        write(cfg, home, &dest, dumps, &work).unwrap();
        dest
    }

    #[test]
    fn round_trip_restores_identical_files_into_an_empty_state() {
        let (home, cfg, dumps) = source();
        let dest = backup_of(&home, &cfg, &dumps);

        let target = scratch("target");
        let staged = target.join("staged");
        let manifest = stage(&dest, &staged, Some("1.3.5")).unwrap();
        assert_eq!(manifest.era, "prerenewal");
        assert_eq!(manifest.databases, vec![
            ("renewal".to_string(), "database/renewal.sql".to_string()),
            ("prerenewal".to_string(), "database/prerenewal.sql".to_string()),
        ]);
        let state = target.join("state");
        fs::create_dir_all(&state).unwrap();
        apply(&staged, &manifest, &state).unwrap();

        // The mods folder comes back byte for byte, lists included.
        assert_eq!(tree(&state.join("mods")), tree(&cfg.state.join("mods")));
        for (_, local) in SETTINGS.iter().filter(|(_, l)| *l != "free_kafra_warp") {
            assert_eq!(fs::read(state.join(local)).unwrap(), fs::read(cfg.state.join(local)).unwrap(), "{local}");
        }
        assert!(!state.join("free_kafra_warp").exists());
        // And the dumps are what the database step is handed.
        for (era, path) in &dumps {
            assert_eq!(fs::read(staged.join(format!("database/{era}.sql"))).unwrap(), fs::read(path).unwrap());
        }
        // Nothing but settings and mods lands in state.
        let names: BTreeSet<String> = fs::read_dir(&state).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        assert_eq!(names, ["conf", "mod-settings.json", "mods", "prerenewal", "settings.json"].iter().map(|s| s.to_string()).collect());
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn restoring_replaces_what_the_target_had() {
        let (home, cfg, dumps) = source();
        let dest = backup_of(&home, &cfg, &dumps);
        let target = scratch("replace");
        let state = target.join("state");
        put(&state.join("mods/stale-mod/npc/x.txt"), b"old");
        put(&state.join("free_kafra_warp"), b"");
        let staged = target.join("staged");
        let manifest = stage(&dest, &staged, None).unwrap();
        apply(&staged, &manifest, &state).unwrap();
        assert!(!state.join("mods/stale-mod").exists());
        assert!(!state.join("free_kafra_warp").exists(), "absence in the backup is restored too");
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn secrets_are_never_archived() {
        let (home, cfg, dumps) = source();
        let dest = backup_of(&home, &cfg, &dumps);
        let mut all = Vec::new();
        GzipReader::new(BufReader::new(File::open(&dest).unwrap())).unwrap().read_to_end(&mut all).unwrap();
        let text = String::from_utf8_lossy(&all);
        assert!(!text.contains("SECRET-"), "a secret reached the archive");
        // The machine record keeps what it should.
        assert!(text.contains("/games/kRO/data.grf"));
        let mut tar = TarReader::new(&all[..]);
        let mut names = Vec::new();
        while let Some(e) = tar.next_entry().unwrap() {
            names.push(e.path);
        }
        assert_eq!(names[0], "manifest.json");
        for n in &names[1..] {
            assert!(AREAS.contains(&n.split('/').next().unwrap()), "{n}");
            assert!(!n.contains("private") && !n.contains("agent") && !n.contains("sharing"), "{n}");
        }
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn the_manifest_describes_the_world() {
        let (home, cfg, dumps) = source();
        let dest = backup_of(&home, &cfg, &dumps);
        let mut tar = TarReader::new(GzipReader::new(BufReader::new(File::open(&dest).unwrap())).unwrap());
        tar.next_entry().unwrap().unwrap();
        let mut body = String::new();
        tar.read_to_string(&mut body).unwrap();
        let v = json::parse(&body).unwrap();
        assert_eq!(v.str("kind"), Some("backup"));
        assert_eq!(v.str("app_version"), Some("1.3.5"));
        assert_eq!(v.str("era"), Some("prerenewal"));
        assert_eq!(v.str("rathena").map(str::len), Some(40));
        assert!(v.str("created").unwrap().ends_with('Z'));
        let Some(Value::Array(mods)) = v.get("mods") else { panic!() };
        let names: Vec<_> = mods.iter().map(|m| m.str("name").unwrap()).collect();
        assert_eq!(names, ["big-maps", "cursor"]);
        assert!(mods.iter().all(|m| is_sha256(m.str("sha256").unwrap())));
        let Some(Value::Array(excluded)) = v.get("excluded") else { panic!() };
        assert_eq!(excluded.len(), EXCLUDED.len());
        fs::remove_dir_all(&home).unwrap();
    }

    fn rewrite(dest: &Path, change: impl Fn(&str, Vec<u8>) -> Vec<u8>) -> PathBuf {
        let mut tar = TarReader::new(GzipReader::new(BufReader::new(File::open(dest).unwrap())).unwrap());
        let mut entries = Vec::new();
        while let Some(e) = tar.next_entry().unwrap() {
            let mut b = Vec::new();
            (&mut tar).read_to_end(&mut b).unwrap();
            entries.push((e.path.clone(), change(&e.path, b)));
        }
        let out = dest.with_file_name("edited.tar.gz");
        let mut w = TarWriter::new(GzipWriter::new(File::create(&out).unwrap()).unwrap());
        for (n, b) in entries {
            w.file(&n, b.len() as u64, 0, &b[..]).unwrap();
        }
        w.finish().unwrap().finish().unwrap();
        out
    }

    #[test]
    fn a_newer_app_s_backup_is_refused_by_name() {
        let (home, cfg, dumps) = source();
        let dest = backup_of(&home, &cfg, &dumps);
        let newer_one = rewrite(&dest, |n, b| {
            if n == MANIFEST { String::from_utf8(b).unwrap().replace("\"1.3.5\"", "\"1.10.0\"").into_bytes() } else { b }
        });
        let target = scratch("newer");
        let error = stage(&newer_one, &target.join("s"), Some("1.3.5")).err().unwrap();
        assert!(error.contains("Install Ragnarok Offline 1.10.0 or later"), "{error}");
        assert!(!target.join("s").exists(), "nothing is unpacked from a refused archive");
        // The same version, and an older one, are fine.
        assert!(stage(&dest, &target.join("t"), Some("1.3.5")).is_ok());
        assert!(stage(&dest, &target.join("u"), Some("1.4.0")).is_ok());
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn a_changed_file_is_refused_by_checksum() {
        let (home, cfg, dumps) = source();
        let dest = backup_of(&home, &cfg, &dumps);
        let target = scratch("checksum");
        let edited = rewrite(&dest, |n, mut b| {
            if n == "database/renewal.sql" { b[0] ^= 1; }
            b
        });
        let error = stage(&edited, &target.join("s"), None).err().unwrap();
        assert!(error.contains("database/renewal.sql does not match its checksum"), "{error}");
        // Unchanged, the rewritten archive restores: the refusal above is
        // the checksum's doing, not the rewrite's.
        let same = rewrite(&dest, |_, b| b);
        assert!(stage(&same, &target.join("t"), None).is_ok());
        // A file the manifest does not list is refused too.
        let mut w = TarWriter::new(GzipWriter::new(File::create(target.join("extra.tar.gz")).unwrap()).unwrap());
        let mut tar = TarReader::new(GzipReader::new(BufReader::new(File::open(&dest).unwrap())).unwrap());
        while let Some(e) = tar.next_entry().unwrap() {
            let mut b = Vec::new();
            (&mut tar).read_to_end(&mut b).unwrap();
            w.file(&e.path, b.len() as u64, 0, &b[..]).unwrap();
        }
        w.file("mods/cursor/npc/sneaky.txt", 3, 0, &b"hi!"[..]).unwrap();
        w.finish().unwrap().finish().unwrap();
        let error = stage(&target.join("extra.tar.gz"), &target.join("v"), None).err().unwrap();
        assert!(error.contains("does not list"), "{error}");
        // A truncated download fails as damaged.
        let bytes = fs::read(&dest).unwrap();
        let cut = target.join("cut.tar.gz");
        fs::write(&cut, &bytes[..bytes.len() - 100]).unwrap();
        assert!(stage(&cut, &target.join("u"), None).err().unwrap().contains("damaged"));
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&target).unwrap();
    }

    #[test]
    fn manifests_that_are_not_ours_or_are_unsafe_are_refused() {
        let base = |files: &str| format!(
            "{{\"format\":\"{FORMAT}\",\"format_version\":1,\"kind\":\"backup\",\"era\":\"renewal\",\"app_version\":\"1.3.5\",\"files\":[{files}]}}"
        );
        let sha = "0".repeat(64);
        assert!(parse_manifest(&base(""), Some("1.3.5")).is_ok());
        for bad in ["../x", "/etc/passwd", "state/private/x", "mods", "manifest.json"] {
            let m = base(&format!("{{\"path\":\"{bad}\",\"size\":1,\"sha256\":\"{sha}\"}}"));
            assert!(parse_manifest(&m, None).is_err(), "{bad}");
        }
        let world = base("").replace("\"backup\"", "\"world\"");
        assert!(parse_manifest(&world, None).err().unwrap().contains("world hand-off"));
        let future = base("").replace("\"format_version\":1", "\"format_version\":2").replace("1.3.5", "1.3.4");
        assert!(parse_manifest(&future, Some("1.3.5")).err().unwrap().contains("newer version"));
        assert!(parse_manifest("{}", None).is_err());
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("1.10.0", "1.9.9"));
        assert!(newer("2.0", "1.99.99"));
        assert!(!newer("1.3.5", "1.3.5"));
        assert!(!newer("1.3", "1.3.0"));
        assert!(!newer("1.3.4", "1.3.5"));
    }

    #[test]
    fn dates_are_utc() {
        let t = UNIX_EPOCH + std::time::Duration::from_secs(1_790_000_000);
        assert_eq!(rfc3339(t), "2026-09-21T14:13:20Z");
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(stamp(UNIX_EPOCH + std::time::Duration::from_secs(951_782_400)), "20000229-000000");
    }
}
