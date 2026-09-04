//! ro-randomizer -- turn a seed into a Ragnarok Offline mod.
//!
//!     ro-randomizer --seed 12345
//!
//! Writes a complete, installable mod folder. Drop it in the mods directory,
//! restart the server, and every monster in the world is something else.
//!
//! The interesting part is not this file; it is `mobs.rs`, which explains why
//! shuffling *identities* rather than *spawns* is the only thing that works
//! inside a mod, and `yaml.rs`, which explains why a 200-line reader is the
//! right tool for rewriting rAthena's tables and a real YAML parser is not.
//!
//! Zero dependencies, matching `stack/`: this ships as a binary inside a
//! signed app bundle.

mod mobs;
mod rng;
mod source;
mod yaml;

use std::fs;
use std::path::PathBuf;
use std::process::exit;

const USAGE: &str = "\
ro-randomizer -- generate a seeded randomizer mod for Ragnarok Offline

    ro-randomizer [--seed <seed>] [options]

  --seed <seed>     any number or phrase; the same seed always gives the same
                    world. Default: a number taken from the clock, printed so
                    you can play it again.
  --out <dir>       where to write the mod. Default: ./randomizer-<seed>
  --era <era>       renewal | pre-renewal. Default: whatever the app is set to.

  --band <n>        only let monsters swap with others within <n> levels.
                    Default 10, which keeps the difficulty curve roughly where
                    the map designers left it.
  --chaos           ignore level bands entirely. A Poring outside Prontera can
                    be anything in the game. You have been told.
  --disguise        keep every monster's original name and sprite, so nothing
                    warns you what you just walked into.
  --include-props   also shuffle the emperium, WoE barricades and the elemental
                    crystals. They ignore whole damage types, so whatever
                    receives one becomes unkillable. Left alone by default.

  --rathena <dir>   read the tables from a source checkout instead of from the
                    running server (a repository's vendor/rathena).
  --docker <path>   the docker client to use. Default: the app's bundled one.
  --container <n>   the map-server container. Default: ragnarok-map.

The tables are read out of the server that is already running, so **start the
app first**. Nothing is shipped or cached, which means the result always
matches the rAthena build you are actually playing.
";

struct Args {
    seed: Option<String>,
    out: Option<PathBuf>,
    era: Option<String>,
    band: u32,
    chaos: bool,
    disguise: bool,
    include_props: bool,
    rathena: Option<PathBuf>,
    docker: Option<PathBuf>,
    container: String,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        seed: None,
        out: None,
        era: None,
        band: 10,
        chaos: false,
        disguise: false,
        include_props: false,
        rathena: None,
        docker: None,
        container: "ragnarok-map".into(),
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();
        let value = |i: &mut usize| -> Result<String, String> {
            *i += 1;
            argv.get(*i).cloned().ok_or_else(|| format!("{arg} needs a value"))
        };
        match arg {
            "--seed" => a.seed = Some(value(&mut i)?),
            "--out" => a.out = Some(PathBuf::from(value(&mut i)?)),
            "--era" => a.era = Some(value(&mut i)?),
            "--band" => {
                a.band = value(&mut i)?.parse().map_err(|_| "--band needs a number".to_string())?
            }
            "--chaos" => a.chaos = true,
            "--disguise" => a.disguise = true,
            "--include-props" => a.include_props = true,
            "--rathena" => a.rathena = Some(PathBuf::from(value(&mut i)?)),
            "--docker" => a.docker = Some(PathBuf::from(value(&mut i)?)),
            "--container" => a.container = value(&mut i)?,
            "-h" | "--help" => {
                print!("{USAGE}");
                exit(0);
            }
            other => return Err(format!("unrecognised option {other}")),
        }
        i += 1;
    }
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_become_usable_folder_names() {
        assert_eq!(slugify("12345"), "12345");
        assert_eq!(slugify("tuesday night"), "tuesday-night");
        assert_eq!(slugify("  ///  "), "seed");
        assert_eq!(slugify("A -- B"), "a-b");
    }

    /// A seed is free text and the manifest is JSON. A quote in one must not
    /// produce a file the app then refuses to parse.
    #[test]
    fn a_quote_in_a_seed_does_not_break_the_manifest() {
        let opts = mobs::Options { disguise: false, include_props: false, chaos: false, band: 10 };
        let out = mobs::Outcome {
            mob_db: String::new(),
            mob_avail: String::new(),
            kept: 0,
            swapped: 3,
            total: 4,
            bands: 1,
        };
        let m = manifest("x", "say \"hi\"", "renewal", &opts, &out);
        assert!(m.contains("\\\"hi\\\""), "{m}");
        // Balanced quotes: every unescaped one opens or closes a string.
        let unescaped = m
            .chars()
            .zip(std::iter::once(' ').chain(m.chars()))
            .filter(|(c, prev)| *c == '"' && *prev != '\\')
            .count();
        assert_eq!(unescaped % 2, 0, "unbalanced quotes in {m}");
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("ro-randomizer: {e}");
        exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;

    // A seed the player did not choose still has to be reproducible, so it is
    // generated once, printed, and written into the mod. "Random" and "not
    // written down" are different things.
    let seed_text = args.seed.clone().unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| (d.as_nanos() as u64 % 1_000_000_000).to_string())
            .unwrap_or_else(|_| "1".into())
    });
    let seed = rng::parse_seed(&seed_text);
    // A seed is free text -- "tuesday night" is a perfectly good one -- but it
    // also becomes a directory name and a mod name, and a mod whose folder has
    // a space in it makes every instruction about it awkward to copy. The seed
    // is still printed and stored verbatim; only the name is flattened.
    let slug = slugify(&seed_text);

    let data_root = source::data_root();
    let state = data_root.join("state");
    let era = match args.era.as_deref() {
        Some("renewal") | Some("re") => "re",
        Some("pre-renewal") | Some("prerenewal") | Some("pre-re") => "pre-re",
        Some(other) => return Err(format!("unknown era {other:?}; use renewal or pre-renewal")),
        None => source::era_of(&state),
    };

    let src = source::Source {
        rathena: args.rathena.clone(),
        docker: match args.docker.clone().or_else(source::find_docker) {
            Some(d) => d,
            None if args.rathena.is_some() => PathBuf::new(),
            None => {
                return Err("could not find the app's docker client; pass --docker, \
                            or --rathena to read from a source checkout"
                    .into())
            }
        },
        nebula_home: std::env::var_os("NEBULA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_root.join("nebula")),
        container: args.container.clone(),
        scratch: std::env::temp_dir().join("ro-randomizer"),
    };

    eprintln!("reading mob_db.yml ({}) …", if args.rathena.is_some() { "checkout" } else { "running server" });
    let mob_db = src.db_file(era, "mob_db.yml").map_err(|e| {
        format!("{e}\n\nStart the app first -- the tables are read out of the running \
                 server. Or pass --rathena <dir> to read a source checkout.")
    })?;

    let opts = mobs::Options {
        disguise: args.disguise,
        include_props: args.include_props,
        chaos: args.chaos,
        band: args.band,
    };
    let mut r = rng::Rng::new(seed);
    let outcome = mobs::randomize(&mob_db, &mut r, &opts)?;

    let era_name = if era == "pre-re" { "pre-renewal" } else { "renewal" };
    let out = args
        .out
        .clone()
        .unwrap_or_else(|| PathBuf::from(format!("randomizer-{slug}")));
    fs::create_dir_all(out.join("db")).map_err(|e| format!("{}: {e}", out.display()))?;

    write(&out.join("db/mob_db.yml"), &outcome.mob_db)?;
    if outcome.mob_avail.is_empty() {
        let _ = fs::remove_file(out.join("db/mob_avail.yml"));
    } else {
        write(&out.join("db/mob_avail.yml"), &outcome.mob_avail)?;
    }
    write(&out.join("mod.json"), &manifest(&slug, &seed_text, era_name, &opts, &outcome))?;
    write(&out.join("README.md"), &readme(&slug, &seed_text, era_name, &opts, &outcome))?;

    println!("seed {seed_text}  ({era_name})");
    println!(
        "{} of {} monsters changed, across {} level band{}",
        outcome.swapped,
        outcome.total,
        outcome.bands,
        if outcome.bands == 1 { "" } else { "s" }
    );
    if outcome.kept > 0 {
        println!(
            "{} left alone (the emperium, barricades and crystals -- they ignore \n\
             whole damage types, and anything given their block cannot be killed)",
            outcome.kept
        );
    }
    println!("written to {}", out.display());
    // Quoted, because the app's data directory has a space in it on macOS and
    // an unquoted example is one somebody will paste and have fail.
    println!(
        "\nInstall it:\n  cp -R {:?} {:?}\nthen restart the server from Settings.",
        out.display().to_string(),
        state.join("mods").display().to_string()
    );
    Ok(())
}

fn write(path: &std::path::Path, body: &str) -> Result<(), String> {
    fs::write(path, body).map_err(|e| format!("writing {}: {e}", path.display()))
}

/// The generated mod's manifest.
///
/// `requires.era` is the load-bearing field. A table generated from
/// pre-renewal monsters is meaningless against a renewal server -- the IDs
/// exist in both, so it would load and be quietly wrong rather than fail. The
/// app refuses it by name instead, which is exactly what the manifest is for.
fn manifest(slug: &str, seed: &str, era: &str, opts: &mobs::Options, out: &mobs::Outcome) -> String {
    let how = describe(opts);
    // The description is JSON string data and the seed is free text, so the
    // two characters that would break the file are escaped. The app's reader
    // handles escapes correctly; emitting a broken manifest would get the mod
    // refused with a parse error, which is at least honest but not useful.
    let seed = seed.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "{{\n  \"name\": \"randomizer-{slug}\",\n  \"version\": \"1.0.0\",\n  \
         \"author\": \"ro-randomizer\",\n  \
         \"description\": \"Seed {seed}: {} monsters are something else. {how}\",\n  \
         \"requires\": {{ \"app\": \">=1.0.6\", \"era\": \"{era}\" }}\n}}\n",
        out.swapped
    )
}

/// A seed, flattened into something safe as a directory name.
///
/// `--seed "tuesday night"` is a good seed and a bad folder name: the install
/// instruction printed afterwards would need quoting, and the mod's name -- the
/// thing `disabled.txt` lists and merge order sorts on -- would carry a space.
fn slugify(seed: &str) -> String {
    let mut s: String = seed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "seed".into() } else { s }
}

fn describe(opts: &mobs::Options) -> String {
    let mut s = if opts.chaos {
        "Anything can be anything.".to_string()
    } else {
        format!("Swaps are kept within {} levels.", opts.band)
    };
    if opts.disguise {
        s.push_str(" Disguised: nothing looks different.");
    }
    s
}

fn readme(slug: &str, seed: &str, era: &str, opts: &mobs::Options, out: &mobs::Outcome) -> String {
    format!(
        "# randomizer-{slug}\n\n\
         Generated by `ro-randomizer`. **Seed `{seed}`, {era}.**\n\n\
         {} of the monsters in the game have another monster's stats, drops, \
         element, size and AI. {}\n\n\
         Regenerate this exact mod at any time:\n\n\
         ```\nro-randomizer --seed {seed:?}{}{}{}\n```\n\n\
         ## What it changes\n\n\
         - `db/mob_db.yml` — every monster's block, moved to another monster's ID.\n\
         {}\n\
         Spawns are untouched: the same monster IDs stand in the same places, \
         they are simply not the same monsters any more. That is the only way \
         a mod can do this — stock spawn scripts cannot be removed, only added \
         to.\n\n\
         ## Careful\n\n\
         This is generated for **{era}**, and its `mod.json` says so. Switch \
         era in Settings and the app will refuse it by name rather than apply \
         a pre-renewal table to a renewal server.\n",
        out.swapped,
        describe(opts),
        if opts.chaos { " --chaos" } else { "" },
        if opts.disguise { " --disguise" } else { "" },
        if !opts.chaos && opts.band != 10 { format!(" --band {}", opts.band) } else { String::new() },
        if out.mob_avail.is_empty() {
            "".to_string()
        } else {
            "- `db/mob_avail.yml` — and each one looks like what it now is.\n".to_string()
        },
    )
}
