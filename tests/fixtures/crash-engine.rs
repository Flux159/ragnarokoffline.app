use std::{env, fs, io::{self, Write}, path::PathBuf};
fn main() {
    let root = PathBuf::from(env::var_os("RO_CRASH_FIXTURE").unwrap());
    let args: Vec<_> = env::args().skip(1).collect();
    let mut calls = fs::OpenOptions::new().create(true).append(true).open(root.join("calls")).unwrap();
    writeln!(calls, "{}", args.join(" ")).unwrap();
    match args.first().map(String::as_str) {
        Some("inspect") => {
            if args.last().map(String::as_str) != Some("ragnarok-map") { std::process::exit(1); }
            print!("{}", fs::read_to_string(root.join("inspect.json")).unwrap());
        },
        Some("logs") => {
            let data = fs::read(root.join("map.log")).unwrap();
            io::stdout().write_all(&data).unwrap();
            io::stderr().write_all(b"\nlast stderr context\n").unwrap();
        },
        _ => std::process::exit(2),
    }
}
