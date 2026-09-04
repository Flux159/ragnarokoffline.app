//! Wire a user-supplied Ragnarok client into the asset server.
//!
//! Builds a server root under state: `resources/` with the GRFs and a
//! generated DATA.INI, plus the loose directories the client reads. Nothing is
//! copied — the GRFs stay where the user keeps them, so a 3.5 GB client is not
//! duplicated. That constraint is what makes linking, rather than copying, the
//! whole design.

use crate::config::Config;
use std::fs;
use std::path::{Path, PathBuf};

/// Link a directory, by whatever mechanism the platform offers unprivileged.
///
/// Unix has symlinks. Windows reserves symlink creation for Developer Mode or
/// an elevated process, which we cannot assume of a player double-clicking an
/// installer — but directory *junctions* need no privilege at all and behave
/// the same for reading. `mklink` is a cmd builtin, so it cannot be spawned
/// directly.
fn link_dir(src: &Path, dst: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(dst);
    let _ = fs::remove_file(dst);
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(src, dst).is_ok() {
            return Ok(());
        }
        let st = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(dst)
            .arg(src)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(format!("could not junction {}", dst.display())) }
    }
}

/// Link a file. On Windows a hard link needs no privilege but requires the same
/// volume; falling back to a copy would duplicate gigabytes, so a failure here
/// is reported rather than papered over.
/// The drive a path lives on, on Windows. `None` anywhere else, and for a UNC
/// path, where "same drive" is not the question being asked.
#[cfg(windows)]
fn drive_of(p: &Path) -> Option<String> {
    use std::path::{Component, Prefix};
    match p.components().next() {
        Some(Component::Prefix(pre)) => match pre.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                Some((d as char).to_ascii_uppercase().to_string())
            }
            _ => None,
        },
        _ => None,
    }
}

fn link_file(src: &Path, dst: &Path) -> Result<(), String> {
    let _ = fs::remove_file(dst);
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        // A hard link cannot cross volumes and a symlink needs Developer Mode,
        // so a client folder on a second drive can have neither.
        if fs::hard_link(src, dst).is_ok() {
            return Ok(());
        }
        if std::os::windows::fs::symlink_file(src, dst).is_ok() {
            return Ok(());
        }

        // Not a copy. The GRFs are gigabytes, and quietly duplicating them onto
        // a drive the player did not choose is a worse surprise than an error
        // -- it can fill the disk, and it doubles what they are storing without
        // asking. Say which drive is which and let them decide.
        let (from, to) = (drive_of(src), drive_of(dst));
        if let (Some(from), Some(to)) = (&from, &to) {
            if from != to {
                return Err(format!(
                    "Your game client is on the {from}: drive and this app keeps its \
                     data on {to}:, and Windows cannot link files between drives.\n\n\
                     Move or copy the client folder to the {to}: drive, then choose it \
                     again:\n\n\x20   {}\n\n\
                     Alternatively, turn on Developer Mode (Settings, System, For \
                     developers) and choose the folder again -- that lets Windows \
                     link across drives without moving anything.",
                    src.display()
                ));
            }
        }

        Err(format!(
            "could not link {} into the asset root. Turn on Developer Mode \
             (Settings, System, For developers) and choose the client folder \
             again, or move it beside the app's data directory.",
            src.display()
        ))
    }
}

/// The first of `cands` that is a directory.
fn first_dir(cands: &[PathBuf]) -> Option<PathBuf> {
    cands.iter().find(|p| p.is_dir()).cloned()
}

pub fn link(cfg: &Config, args: &[String]) -> Result<(), String> {
    let data = args.first().ok_or("data.grf path required")?;
    // Optional, like official_data.grf.
    //
    // rdata.grf was a renewal overlay on an older base client, and clients have
    // not been packaged that way for years: recent ones ship a single data.grf
    // with everything merged in. Players downloading a 2026 client from the
    // rAthena forums -- renewal, fourth jobs and all -- have no rdata.grf to
    // give us, and requiring one turned them away from a client that would
    // have worked.
    //
    // What it uniquely carried, measured against a client that has both, is
    // 3,540 files: 2,751 garment sprites, 713 textures, 56 job sprites and six
    // maps. Everything else it holds is already in data.grf. So its absence
    // costs garments on a client old enough to have needed it, and costs
    // nothing at all on one new enough not to.
    let rdata = args.get(1).filter(|s| !s.is_empty());
    let official = args.get(2).filter(|s| !s.is_empty());
    let bgm = args.get(3).filter(|s| !s.is_empty());

    if !Path::new(data).is_file() {
        return Err(format!("not a file: {data}"));
    }
    if let Some(r) = rdata {
        if !Path::new(r).is_file() {
            return Err(format!("not a file: {r}"));
        }
    }

    let server_root = cfg.state.join("assets");
    let en = translation_root(cfg);
    let _ = fs::remove_dir_all(&server_root);
    fs::create_dir_all(server_root.join("resources")).map_err(|e| e.to_string())?;
    fs::create_dir_all(server_root.join("data")).map_err(|e| e.to_string())?;

    // Lower index wins, so overlays sit above the base client.
    let res = server_root.join("resources");
    let mut ini = String::from("[Data]\n");
    let mut i = 0;
    if let Some(o) = official {
        if Path::new(o).is_file() {
            link_file(Path::new(o), &res.join("official_data.grf"))?;
            ini.push_str(&format!("{i}=official_data.grf\n"));
            i += 1;
        }
    }
    if let Some(r) = rdata {
        link_file(Path::new(r), &res.join("rdata.grf"))?;
        ini.push_str(&format!("{i}=rdata.grf\n"));
        i += 1;
    }
    link_file(Path::new(data), &res.join("data.grf"))?;
    ini.push_str(&format!("{i}=data.grf\n"));
    fs::write(res.join("DATA.INI"), &ini).map_err(|e| e.to_string())?;

    // Loose client files usually sit beside the GRFs. BGM can be given
    // explicitly, because it is the one whose absence is noticed — the game is
    // simply silent.
    let client_dir = Path::new(data).parent().map(Path::to_path_buf).unwrap_or_default();
    let bgm_src = bgm
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| first_dir(&[client_dir.join("BGM"), client_dir.join("dll_exe/BGM")]));
    // A merged directory, not a link. Linking the player's BGM folder straight
    // in leaves a mod nowhere to put a track: the destination is somebody
    // else's directory, and writing into it would edit the player's own files.
    // Linked file by file instead, exactly like System/, so a mod can overlay.
    if let Some(b) = &bgm_src {
        let dst = server_root.join("BGM");
        fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        overlay_tree(b, &dst)?;
    }
    if let Some(a) = first_dir(&[client_dir.join("AI"), client_dir.join("dll_exe/AI")]) {
        link_dir(&a, &server_root.join("AI"))?;
    }

    // System/ is a merge: the English tables win, the client backfills fonts
    // and quest data. Two names are excluded from the backfill because
    // roBrowser reaches for them first and would otherwise get the Korean copy:
    //   itemInfo*              — .lub resolves before .lua
    //   OngoingQuestInfoList*  — the translation calls the same table
    //                            OngoingQuests
    let merged = cfg.state.join("System");
    let _ = fs::remove_dir_all(&merged);
    fs::create_dir_all(&merged).map_err(|e| e.to_string())?;
    if let Ok(rd) = fs::read_dir(en.join("SystemEN")) {
        for e in rd.flatten() {
            let dst = merged.join(e.file_name());
            let _ = if e.path().is_dir() { link_dir(&e.path(), &dst) } else { link_file(&e.path(), &dst) };
        }
    }
    if let Some(sys) = first_dir(&[client_dir.join("System"), client_dir.join("dll_exe/System")]) {
        if let Ok(rd) = fs::read_dir(&sys) {
            for e in rd.flatten() {
                let name = e.file_name();
                let n = name.to_string_lossy();
                if n.starts_with("itemInfo") || n.starts_with("OngoingQuestInfoList") {
                    continue;
                }
                let dst = merged.join(&name);
                if dst.exists() {
                    continue;
                }
                let _ = if e.path().is_dir() { link_dir(&e.path(), &dst) } else { link_file(&e.path(), &dst) };
            }
        }
    }
    // The translation's itemInfo.lua is a require()/dofile() stub; point at the
    // table itself, which defines the global roBrowser's loader iterates.
    let _ = link_file(&en.join("SystemEN/LuaFiles514/itemInfo.lua"), &merged.join("itemInfo.lua"));
    let _ = link_file(&en.join("SystemEN/OngoingQuests.lub"), &merged.join("OngoingQuestInfoList.lub"));
    // Mods, laid over everything the client ships with.
    //
    // Order is the point. The asset server resolves loose files under its root
    // before DATA_OVERRIDE_PATH and before the archives, so a sprite or a Lua
    // table a mod puts here beats both the English translation and the client's
    // own GRFs -- without repacking a 2.4 GB file. System/ is overlaid after
    // the translation's links are in place, for the same reason: last writer
    // wins, and a mod should be able to replace itemInfo.lua if it is adding
    // items.
    //
    // Mods live in state/mods, not in the asset root, so rebuilding this tree
    // on every link cannot destroy them.
    let (plugins, item_tables) = overlay_mods(cfg, &server_root, &merged);

    link_dir(&merged, &server_root.join("System"))?;
    // Several loaders fall back to a SystemEN/ path when the System/ one is absent.
    link_dir(&en.join("SystemEN"), &server_root.join("SystemEN"))?;

    // roBrowser reads this over its baked-in defaults.
    let web = cfg.root.join("vendor/roBrowserLegacy/dist/Web");
    if web.is_dir() {
        write_client_config(cfg, &web, &plugins, &item_tables)?;
        // And the root of the server becomes the game rather than roBrowser's
        // developer launcher, so the address a host copies out of Settings is a
        // link that works pasted into a browser as well as into the app.
        let _ = fs::copy(cfg.root.join("config/index.html"), web.join("index.html"));
    }

    let grfs = ini.lines().filter(|l| l.starts_with(char::is_numeric)).count();
    println!(
        "linked: {grfs} GRFs, BGM {}",
        if bgm_src.is_some() { "yes" } else { "missing" }
    );
    Ok(())
}

/// Copy a mod's client files over the assembled asset root.
///
/// Returns the mods that ship a roBrowser plugin, in the order they are loaded.
/// The list comes from `mods::enabled`, in merge order, rather than from a
/// second pass over the folder. It used to be the latter, and the two
/// disagreed: a mod switched off in Settings stopped reaching the server and
/// went on overlaying its sprites and loading its plugin, so half of it stayed
/// on with nothing in the interface to say so.
fn overlay_mods(cfg: &Config, server_root: &Path, merged: &Path) -> (Vec<String>, Vec<String>) {
    let mut plugins = Vec::new();
    let mut item_tables = Vec::new();
    for m in crate::mods::enabled(cfg) {
        // Served ahead of the GRFs: sprites, .act/.spr, map geometry, Lua.
        // Aliased, so a mod can be written in ASCII rather than in CP949 bytes.
        let _ = copy_data_aliased(&m.dir.join("data"), &server_root.join("data"));
        // Music. The client asks for `BGM/<file>`, a root outside data/, so
        // this is its own layer rather than part of the one above.
        let _ = copy_over(&m.dir.join("BGM"), &server_root.join("BGM"));
        // Client tables. itemInfo is merged rather than replaced; see
        // copy_system_layer.
        if let Some(table) = copy_system_layer(&m.dir.join("System"), merged, &m.name) {
            item_tables.push(table);
        }
        // A roBrowser plugin: styling, UI, anything the client can be told to
        // load. Served from the root, so the path in the config is
        // server-relative -- which is the one thing that will confuse people.
        let client = m.dir.join("client");
        if client.join("index.js").is_file() {
            let _ = copy_over(&client, &server_root.join("plugins").join(&m.name));
            plugins.push(m.name.clone());
        }
    }
    (plugins, item_tables)
}

/// ASCII names a mod may use in place of the client's own directory names.
///
/// The client asks for its assets under Korean directory names encoded as
/// CP949 and read by every tool in the chain as Latin-1, so on disk they look
/// like `À¯ÀúÀÎÅÍÆäÀÌ½º`. Those names are hard-coded in the client, so they
/// cannot simply be renamed -- but nothing stops a mod from *writing* ASCII and
/// this translating on the way in.
///
/// It matters more than tidiness: a zip containing those bytes unpacks
/// differently depending on the machine, so a mod that ships them is a mod that
/// arrives corrupted for some people. A mod written entirely in ASCII travels.
///
/// Longest first, because `sprite/human/body` has to match before `sprite/human`.
/// Each right-hand side was taken from a real GRF, not typed.
const PATH_ALIASES: &[(&str, &str)] = &[
    // data/texture
    ("texture/ui",             "texture/\u{c0}\u{af}\u{c0}\u{fa}\u{c0}\u{ce}\u{c5}\u{cd}\u{c6}\u{e4}\u{c0}\u{cc}\u{bd}\u{ba}"), // 유저인터페이스
    ("texture/field-ground",   "texture/\u{c7}\u{ca}\u{b5}\u{e5}\u{b9}\u{d9}\u{b4}\u{da}"),                                     // 필드바닥
    ("texture/town",           "texture/\u{b1}\u{e2}\u{c5}\u{b8}\u{b8}\u{b6}\u{c0}\u{bb}"),                                     // 기타마을
    ("texture/indoor-props",   "texture/\u{b3}\u{bb}\u{ba}\u{ce}\u{bc}\u{d2}\u{c7}\u{b0}"),                                     // 내부소품
    ("texture/outdoor-props",  "texture/\u{bf}\u{dc}\u{ba}\u{ce}\u{bc}\u{d2}\u{c7}\u{b0}"),                                     // 외부소품
    // data/sprite
    ("sprite/human/body",      "sprite/\u{c0}\u{ce}\u{b0}\u{a3}\u{c1}\u{b7}/\u{b8}\u{f6}\u{c5}\u{eb}"),                         // 인간족/몸통
    ("sprite/human",           "sprite/\u{c0}\u{ce}\u{b0}\u{a3}\u{c1}\u{b7}"),                                                  // 인간족
    ("sprite/monster",         "sprite/\u{b8}\u{f3}\u{bd}\u{ba}\u{c5}\u{cd}"),                                                  // 몬스터
    ("sprite/item",            "sprite/\u{be}\u{c6}\u{c0}\u{cc}\u{c5}\u{db}"),                                                  // 아이템
    ("sprite/accessory",       "sprite/\u{be}\u{c7}\u{bc}\u{bc}\u{bb}\u{e7}\u{b8}\u{ae}"),                                      // 악세사리
    ("sprite/robe",            "sprite/\u{b7}\u{ce}\u{ba}\u{ea}"),                                                              // 로브
    ("sprite/shield",          "sprite/\u{b9}\u{e6}\u{c6}\u{d0}"),                                                              // 방패
    ("sprite/effect",          "sprite/\u{c0}\u{cc}\u{c6}\u{d1}\u{c6}\u{ae}"),                                                  // 이팩트
];

/// Rewrite a mod-relative asset path through `PATH_ALIASES`.
///
/// Only the leading segments are translated, and only on an exact segment
/// boundary, so a mod folder that happens to be called `sprite/monsters` is
/// left alone.
fn apply_aliases(rel: &str) -> String {
    for (ascii, native) in PATH_ALIASES {
        if let Some(rest) = rel.strip_prefix(ascii) {
            if rest.is_empty() || rest.starts_with('/') {
                return format!("{native}{rest}");
            }
        }
    }
    rel.to_string()
}

/// Copy a mod's `data/` tree, translating ASCII directory aliases as it goes.
fn copy_data_aliased(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    let mut stack = vec![(src.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let from = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if from.is_dir() {
                stack.push((from, child));
            } else {
                let to = dst.join(apply_aliases(&child));
                if let Some(parent) = to.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::remove_file(&to);
                let _ = fs::copy(&from, &to);
            }
        }
    }
    Ok(())
}

/// Copy a mod's `System/` layer, keeping item tables as *additions*.
///
/// Everything in `System/` replaces the client's copy, which is right for a
/// font or a quest table -- but wrong for `itemInfo`, the table that names every
/// item in the game. Replacing it to add one item means shipping the
/// translation's five-megabyte copy inside your mod, which nobody will do.
///
/// roBrowser has the way out: `customItemInfo` is a *list* of tables, loaded
/// with `loadAll`, and `loadItemInfo` assigns `ItemTable[ItemID]` per entry --
/// so several files merge by item id and the last one wins. This copies a mod's
/// item table aside under its own name and returns it, so the caller can name
/// it in that list after the base table.
///
/// Nothing is lost by making this additive: a mod that really wants to replace
/// the whole table can still ship a complete one, and defining every id is
/// indistinguishable from replacing.
fn copy_system_layer(src: &Path, merged: &Path, mod_name: &str) -> Option<String> {
    if !src.is_dir() {
        return None;
    }
    let mut added = None;
    let Ok(rd) = fs::read_dir(src) else { return None };
    for e in rd.flatten() {
        let from = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let is_item_table = lower.starts_with("iteminfo")
            && (lower.ends_with(".lua") || lower.ends_with(".lub"));
        if from.is_file() && is_item_table {
            // Named for the mod so two mods can each ship one, and so the file
            // cannot collide with the translation's own copy.
            let safe: String = mod_name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
                .collect();
            let dst_name = format!("itemInfo-{safe}.lua");
            let to = merged.join(&dst_name);
            let _ = fs::remove_file(&to);
            if fs::copy(&from, &to).is_ok() {
                added = Some(dst_name);
            }
        } else if from.is_dir() {
            let _ = copy_over(&from, &merged.join(&name));
        } else {
            // Removed first: the destination is usually a symlink into the
            // translation, and writing through one would edit the file it
            // points at rather than replacing the link.
            let to = merged.join(&name);
            let _ = fs::remove_file(&to);
            let _ = fs::copy(&from, &to);
        }
    }
    added
}

/// Copy every file under `src` into `dst`, creating directories as needed.
/// Missing `src` is not an error: most mods use one or two of the layers.
fn copy_over(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for e in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            copy_over(&from, &to)?;
        } else {
            // Remove first: the destination is often a symlink into the
            // translation or the client, and writing through one would edit
            // the file it points at rather than replacing the link.
            let _ = fs::remove_file(&to);
            let _ = fs::copy(&from, &to);
        }
    }
    Ok(())
}

/// Link every file under `src` into `dst`, recursing into subdirectories.
///
/// Directories are recursed rather than linked whole, because the point is to
/// let a second call land on top of a first: linking a directory would make
/// the whole subtree a single entry and the later layer could only replace it,
/// not overlay into it.
fn overlay_tree(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let rd = match fs::read_dir(src) {
        Ok(rd) => rd,
        Err(_) => return Ok(()),
    };
    for e in rd.flatten() {
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            overlay_tree(&from, &to)?;
        } else {
            let _ = fs::remove_file(&to);
            let _ = link_file(&from, &to);
        }
    }
    Ok(())
}

/// The English translation tree for the era we are starting.
///
/// Pre-Renewal is an *overlay* on Renewal, not a replacement. Upstream says so
/// -- "supports pre-renewal by overwriting the content of the Renewal folder
/// with the Pre-Renewal one" -- and the trees bear it out: Renewal carries 613
/// files of item, quest and interface text, Pre-Renewal 67. Serving
/// Pre-Renewal alone would drop the other 546 and leave the player with
/// untranslated text.
///
/// What it does carry is era-specific geometry: prontera, izlude, morocc,
/// alberta, prt_in, prt_church and prt_fild05/08 as .gat/.gnd/.rsw, plus the
/// worldmap textures. Those are the towns Renewal redrew, which is why they
/// are the ones shipped.
///
/// So for pre-renewal the two are merged into the state directory, Renewal
/// first and Pre-Renewal over the top. Renewal alone needs no merge and is
/// used from the payload directly. Falls back to Renewal if a payload predates
/// both eras being packaged.
fn translation_root(cfg: &Config) -> PathBuf {
    let base = cfg.root.join("vendor/ROenglishRE/Translation");
    let renewal = base.join("Renewal");
    if !crate::cmds::is_prerenewal(cfg) {
        return renewal;
    }
    let pre = base.join("Pre-Renewal");
    if !pre.is_dir() {
        return renewal;
    }
    let merged = cfg.state.join("translation");
    let _ = fs::remove_dir_all(&merged);
    for sub in ["data", "SystemEN"] {
        let _ = overlay_tree(&renewal.join(sub), &merged.join(sub));
        let _ = overlay_tree(&pre.join(sub), &merged.join(sub));
    }
    merged
}

/// Write the client config, naming any plugins the mods provide.
///
/// Generated rather than copied so the plugin list can be part of it. roBrowser
/// resolves these from the server root, which is where overlay_mods puts them.
/// Insert a property block before the closing brace of Config.local.js.
///
/// The file ends `\n};`, and each block is added just before it. The comma is
/// the fiddly part: two blocks in a row used to produce `],,` -- the first
/// block ended with a comma and the second inserter added another -- which is a
/// syntax error, and a config that does not parse is a game that does not
/// start. So the separator is added only when what comes before needs one.
fn insert_before_close(body: String, block: &str) -> String {
    let Some(i) = body.rfind("\n};") else { return body };
    let head = &body[..i];
    let sep = if head.trim_end().ends_with(',') || head.trim_end().ends_with('{') { "" } else { "," };
    format!("{head}{sep}\n{block}{}", &body[i + 1..])
}

fn write_client_config(
    cfg: &Config,
    web: &Path,
    plugins: &[String],
    item_tables: &[String],
) -> Result<(), String> {
    let src = cfg.root.join("config/Config.local.js");
    let body = fs::read_to_string(&src).map_err(|e| format!("reading {}: {e}", src.display()))?;
    // The client's own renewal flag has to follow the server's era: it selects
    // renewal formulas and UI on the browser side, and a renewal client against
    // a pre-renewal server disagrees about damage and stat display while both
    // believe they are right.
    let body = if crate::cmds::is_prerenewal(cfg) {
        body.replace("renewal: true,", "renewal: false,")
    } else {
        body
    };
    // `customItemInfo` replaces the client's default list rather than adding to
    // it, so the base table has to be named first or every stock item loses its
    // name. Written only when a mod actually ships a table, so an install with
    // no item mods keeps the untouched default path.
    let body = if item_tables.is_empty() {
        body
    } else {
        let mut names = vec!["System/itemInfo.lub".to_string(), "System/itemInfo.lua".to_string()];
        names.extend(item_tables.iter().map(|n| format!("System/{n}")));
        let list = names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ");
        insert_before_close(body, &format!("\tcustomItemInfo: [{list}],\n"))
    };
    let out = if plugins.is_empty() {
        body
    } else {
        let entries: Vec<String> = plugins
            .iter()
            .map(|n| format!("\t\t'{n}': 'plugins/{n}/index'"))
            .collect();
        // Inserted before the closing brace of the config object rather than
        // appended: this is the last thing in the file and has to stay inside it.
        let plugin_map = format!("\tplugins: {{\n{}\n\t}},\n", entries.join(",\n"));
        insert_before_close(body, &plugin_map)
    };
    fs::write(web.join("Config.local.js"), out)
        .map_err(|e| format!("writing Config.local.js: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, body: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    /// The names in PATH_ALIASES were copied out of a real GRF. If one of them
    /// is ever retyped by hand this catches it, because the bytes are the whole
    /// point -- a directory named in Korean is one the client never looks in.
    #[test]
    fn aliases_expand_to_the_client_s_own_names() {
        // 유저인터페이스, as CP949 read back as Latin-1.
        assert_eq!(
            apply_aliases("texture/ui/login/bg.bmp"),
            "texture/\u{c0}\u{af}\u{c0}\u{fa}\u{c0}\u{ce}\u{c5}\u{cd}\u{c6}\u{e4}\u{c0}\u{cc}\u{bd}\u{ba}/login/bg.bmp"
        );
        // 인간족/몸통 -- and the longer prefix has to win over `sprite/human`.
        assert!(apply_aliases("sprite/human/body/x.spr").ends_with("/\u{b8}\u{f6}\u{c5}\u{eb}/x.spr"));
    }

    /// Only whole segments are translated, so a mod with its own folder called
    /// `sprite/monsters` is left alone.
    #[test]
    fn aliases_match_on_segment_boundaries_only() {
        assert_eq!(apply_aliases("sprite/monsters/x.spr"), "sprite/monsters/x.spr");
        assert_eq!(apply_aliases("texture/uix/y.bmp"), "texture/uix/y.bmp");
        // Anything unrecognised is passed through untouched, so a mod that
        // writes the real names still works.
        assert_eq!(apply_aliases("texture/effect/z.bmp"), "texture/effect/z.bmp");
    }

    /// The whole point of the layer: a mod written in ASCII lands where the
    /// client looks.
    #[test]
    fn a_mod_written_in_ascii_lands_on_the_client_s_path() {
        let tmp = std::env::temp_dir().join(format!("ro-alias-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (src, dst) = (tmp.join("mod/data"), tmp.join("assets/data"));
        write(&src.join("texture/ui/login_interface/x.bmp"), "art");
        copy_data_aliased(&src, &dst).unwrap();
        let landed = dst
            .join("texture/\u{c0}\u{af}\u{c0}\u{fa}\u{c0}\u{ce}\u{c5}\u{cd}\u{c6}\u{e4}\u{c0}\u{cc}\u{bd}\u{ba}/login_interface/x.bmp");
        assert!(landed.is_file(), "not at {}", landed.display());
        let _ = fs::remove_dir_all(&tmp);
    }

/// A mod that adds one item must not have to ship the whole table.
    #[test]
    fn an_item_table_is_kept_aside_rather_than_replacing_the_base() {
        let tmp = std::env::temp_dir().join(format!("ro-sys-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        // The base table, as link() leaves it.
        write(&merged.join("itemInfo.lua"), "BASE");
        write(&src.join("itemInfo.lua"), "MOD ADDITIONS");
        write(&src.join("OngoingQuests.lub"), "other table");

        let added = copy_system_layer(&src, &merged, "my-mod");

        assert_eq!(added.as_deref(), Some("itemInfo-my-mod.lua"));
        // The base is untouched...
        assert_eq!(fs::read_to_string(merged.join("itemInfo.lua")).unwrap(), "BASE");
        // ...the mod's copy is beside it...
        assert_eq!(
            fs::read_to_string(merged.join("itemInfo-my-mod.lua")).unwrap(),
            "MOD ADDITIONS"
        );
        // ...and everything else in System/ still replaces as before.
        assert_eq!(fs::read_to_string(merged.join("OngoingQuests.lub")).unwrap(), "other table");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// A mod name that is not a safe filename must not become one.
    #[test]
    fn the_item_table_filename_is_sanitised() {
        let tmp = std::env::temp_dir().join(format!("ro-sys2-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (src, merged) = (tmp.join("mod/System"), tmp.join("merged"));
        fs::create_dir_all(&merged).unwrap();
        write(&src.join("itemInfo.lub"), "x");
        assert_eq!(
            copy_system_layer(&src, &merged, "../evil name").as_deref(),
            Some("itemInfo----evil-name.lua")
        );
        let _ = fs::remove_dir_all(&tmp);
    }

/// Two blocks in a row must not produce `],,` -- a syntax error, and a
    /// config that does not parse is a game that does not start.
    #[test]
    fn two_inserted_blocks_do_not_double_the_comma() {
        let base = "window.ROConfigLocal = {\n\tskipIntro: true\n};\n".to_string();
        let one = insert_before_close(base, "\tcustomItemInfo: ['a'],\n");
        let two = insert_before_close(one, "\tplugins: {\n\t\t'p': 'x'\n\t},\n");
        assert!(!two.contains(",,"), "{two}");
        assert!(two.contains("skipIntro: true,"), "{two}");
        assert!(two.contains("customItemInfo: ['a'],"), "{two}");
        assert!(two.contains("plugins: {"), "{two}");
        assert!(two.trim_end().ends_with("};"), "{two}");
    }

    /// The property the era merge depends on.


    ///
    /// Pre-Renewal is an overlay: it replaces the files it carries and leaves
    /// the rest of Renewal standing. Linking a directory whole would satisfy
    /// neither half -- the base would vanish under the overlay -- so this
    /// pins that a second layer overwrites into subdirectories rather than
    /// over them.
    #[test]
    fn a_later_layer_overwrites_and_leaves_the_rest() {
        let tmp = std::env::temp_dir().join(format!("ro-overlay-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let (base, over, dst) = (tmp.join("base"), tmp.join("over"), tmp.join("dst"));

        write(&base.join("shared.txt"), "renewal");
        write(&base.join("only-base.txt"), "kept");
        write(&base.join("sub/deep.txt"), "renewal-deep");
        write(&base.join("sub/only-base-deep.txt"), "kept-deep");
        write(&over.join("shared.txt"), "prerenewal");
        write(&over.join("sub/deep.txt"), "prerenewal-deep");
        write(&over.join("only-over.txt"), "added");

        overlay_tree(&base, &dst).unwrap();
        overlay_tree(&over, &dst).unwrap();

        let read = |r: &str| fs::read_to_string(dst.join(r)).unwrap();
        // The overlay wins, at the top level and inside a subdirectory.
        assert_eq!(read("shared.txt"), "prerenewal");
        assert_eq!(read("sub/deep.txt"), "prerenewal-deep");
        // And everything it does not carry survives -- the 546 files of
        // translation that a straight swap would have dropped.
        assert_eq!(read("only-base.txt"), "kept");
        assert_eq!(read("sub/only-base-deep.txt"), "kept-deep");
        assert_eq!(read("only-over.txt"), "added");

        let _ = fs::remove_dir_all(&tmp);
    }
}
