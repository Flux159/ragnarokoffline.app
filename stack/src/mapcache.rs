//! Build `db/import/map_cache.dat` from a mod's own map geometry.
//!
//! # Why this exists
//!
//! rAthena's map server never reads a `.gat` at runtime. It reads a prebuilt
//! `map_cache.dat` and refuses any map that is not in one, however correctly
//! the map is registered everywhere else. Upstream builds that file with a
//! separate `mapcache` tool that links against the whole server and reads the
//! geometry out of a GRF.
//!
//! That tool is not in the shipped image, and putting it there would mean a
//! modder's custom map needed a Docker rebuild -- which is the one thing the
//! mod system is designed to avoid. So the supervisor does it, from the loose
//! `.gat`/`.rsw` files the mod already has to ship for the *client* to draw
//! the map. One copy of the geometry, two consumers.
//!
//! # What the server actually reads
//!
//! `map_readallmaps` (src/map/map.cpp) opens three caches in order and keeps
//! all of them:
//!
//! ```text
//! db/import/map_cache.dat     <- this file
//! db/<re|pre-re>/map_cache.dat
//! db/map_cache.dat
//! ```
//!
//! and for each map takes the first cache that has it. So the import cache is
//! additive *and* wins, which is exactly the layering the rest of `db/import`
//! already has. Nothing here has to reproduce the 1,265 stock maps.
//!
//! # The format
//!
//! ```text
//! header  u32 file_size, u16 map_count           (8 bytes, padded)
//! entry   char name[12], i16 xs, i16 ys, i32 len (20 bytes)
//!         <len bytes of zlib-compressed cells>
//! ```
//!
//! One cell per byte, row-major, and `file_size` counts the header too.
//!
//! # On compression
//!
//! The server decompresses with zlib's `uncompress()`, and zlib is happy to
//! decompress a *stored* deflate stream -- one that is framed but never
//! actually compressed. That lets this module emit a valid zlib stream in
//! forty lines instead of taking a compression dependency into a binary that
//! deliberately has none. The cost is file size: a 400x400 map is 160 KB
//! either way rather than the ~8 KB a real deflate would manage, and a mod
//! ships one or two maps, not twelve hundred.

use std::fs;
use std::path::Path;

/// One map's walkability, ready to be written into a cache.
pub struct Map {
    pub name: String,
    pub xs: i16,
    pub ys: i16,
    /// `xs * ys` cell types, row-major, in rAthena's `.gat` numbering.
    pub cells: Vec<u8>,
}

/// rAthena's sentinel for "this map has no water" (`src/common/grfio.hpp`).
const RSW_NO_WATER: i32 = 1_000_000;

const MAP_NAME_LENGTH: usize = 12;

fn u32le(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn f32le(b: &[u8], at: usize) -> Option<f32> {
    Some(f32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// The water level from a `.rsw`, in the same integer form rAthena uses.
///
/// A missing or unreadable `.rsw` is not an error: it means "no water", which
/// is what the map server assumes for a map it cannot read one for. The offset
/// moves with the file version, exactly as in `grfio_read_rsw_water_level`.
pub fn rsw_water_level(rsw: &[u8]) -> i32 {
    if rsw.len() < 6 || &rsw[..4] != b"GRSW" {
        return RSW_NO_WATER;
    }
    let version = ((rsw[4] as u16) << 8) | rsw[5] as u16;
    if !(0x104..=0x205).contains(&version) {
        return RSW_NO_WATER;
    }
    let at = if version >= 0x205 {
        171
    } else if version >= 0x202 {
        167
    } else {
        166
    };
    match f32le(rsw, at) {
        // Truncation toward zero, matching the C cast.
        Some(v) if v.is_finite() => v as i32,
        _ => RSW_NO_WATER,
    }
}

/// Read one map's cells out of a `.gat`, applying the water rule.
///
/// The rule is the same one `mapcache.cpp` applies and it is not cosmetic: a
/// walkable cell that sits below the map's water level becomes type 3,
/// "walkable water". A cache built without it puts dry land where a mod author
/// drew a lake, and the mistake only shows up as a player walking on water.
pub fn read_gat(name: &str, gat: &[u8], water_height: i32) -> Result<Map, String> {
    if gat.len() < 14 || &gat[..4] != b"GRAT" {
        return Err(format!("{name}.gat is not a GAT file (bad signature)"));
    }
    let xs = u32le(gat, 6).unwrap_or(0);
    let ys = u32le(gat, 10).unwrap_or(0);
    if xs == 0 || ys == 0 || xs > i16::MAX as u32 || ys > i16::MAX as u32 {
        return Err(format!("{name}.gat has an impossible size {xs}x{ys}"));
    }
    let num = xs as usize * ys as usize;
    let need = 14 + num * 20;
    if gat.len() < need {
        return Err(format!(
            "{name}.gat says it is {xs}x{ys} but is {} bytes, not the {need} that needs",
            gat.len()
        ));
    }
    let mut cells = Vec::with_capacity(num);
    for i in 0..num {
        let off = 14 + i * 20;
        // Four corner heights then the cell type; only the first height and
        // the type matter here, as in mapcache.cpp.
        let height = f32le(gat, off).unwrap_or(0.0);
        let mut ty = u32le(gat, off + 16).unwrap_or(1);
        if ty == 0 && water_height != RSW_NO_WATER && height > water_height as f32 {
            ty = 3;
        }
        cells.push(ty as u8);
    }
    Ok(Map { name: name.to_string(), xs: xs as i16, ys: ys as i16, cells })
}

/// Serialise a set of maps as a `map_cache.dat`.
pub fn write_cache(maps: &[Map]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&0u32.to_le_bytes()); // file_size, filled in below
    out.extend_from_slice(&0u16.to_le_bytes()); // map_count
    out.extend_from_slice(&[0, 0]); // the struct's tail padding
    for m in maps {
        let body = zlib_stored(&m.cells);
        let mut name = [0u8; MAP_NAME_LENGTH];
        // Truncated rather than refused: the server truncates too, and a name
        // this long has already been rejected by add_map_names.
        let bytes = m.name.as_bytes();
        let n = bytes.len().min(MAP_NAME_LENGTH - 1);
        name[..n].copy_from_slice(&bytes[..n]);
        out.extend_from_slice(&name);
        out.extend_from_slice(&m.xs.to_le_bytes());
        out.extend_from_slice(&m.ys.to_le_bytes());
        out.extend_from_slice(&(body.len() as i32).to_le_bytes());
        out.extend_from_slice(&body);
    }
    let size = out.len() as u32;
    out[0..4].copy_from_slice(&size.to_le_bytes());
    out[4..6].copy_from_slice(&(maps.len() as u16).to_le_bytes());
    out
}

/// A zlib stream that carries `data` in uncompressed deflate blocks.
///
/// Valid input to `uncompress()`, which is all the server does with it.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    // CMF 0x78 (deflate, 32K window), FLG 0x01: no preset dictionary, and
    // 0x7801 is divisible by 31 as the header check requires.
    let mut out = vec![0x78, 0x01];
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    } else {
        for (i, chunk) in data.chunks(0xffff).enumerate() {
            let last = (i + 1) * 0xffff >= data.len();
            out.push(if last { 0x01 } else { 0x00 });
            let len = chunk.len() as u16;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&(!len).to_le_bytes());
            out.extend_from_slice(chunk);
        }
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    // 5552 is the most bytes that can be summed before b can overflow.
    for chunk in data.chunks(5552) {
        for byte in chunk {
            a += *byte as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

/// Read `<dir>/<name>.gat` and its `.rsw`, wherever the mod put them.
///
/// The client wants these under `data/`, so that is where they are looked for;
/// the extension is matched case-insensitively because GRF paths are and mod
/// authors copy names out of a GRF viewer.
pub fn read_map_from_dir(data: &Path, name: &str) -> Result<Map, String> {
    let gat = find_file(data, name, "gat")
        .ok_or_else(|| format!("no {name}.gat under data/ -- the map has no geometry"))?;
    let bytes = fs::read(&gat).map_err(|e| format!("reading {}: {e}", gat.display()))?;
    let water = match find_file(data, name, "rsw") {
        Some(p) => fs::read(&p).map(|b| rsw_water_level(&b)).unwrap_or(RSW_NO_WATER),
        None => RSW_NO_WATER,
    };
    read_gat(name, &bytes, water)
}

/// The first file under `dir` called `<name>.<ext>`, matched without regard to
/// case, searching subdirectories.
fn find_file(dir: &Path, name: &str, ext: &str) -> Option<std::path::PathBuf> {
    let want = format!("{}.{}", name.to_lowercase(), ext.to_lowercase());
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let rd = fs::read_dir(&d).ok()?;
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase() == want)
                .unwrap_or(false)
            {
                return Some(p);
            }
        }
    }
    None
}

/// Every map name a directory of geometry offers, from the `.gat` files in it.
pub fn map_names(data: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![data.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let is_gat = p
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase() == "gat")
                .unwrap_or(false);
            if is_gat {
                if let Some(stem) = p.file_stem() {
                    out.push(stem.to_string_lossy().to_string());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gat(xs: u32, ys: u32, cells: &[(f32, u32)]) -> Vec<u8> {
        let mut b = Vec::from(&b"GRAT"[..]);
        b.extend_from_slice(&[1, 2]);
        b.extend_from_slice(&xs.to_le_bytes());
        b.extend_from_slice(&ys.to_le_bytes());
        for (h, t) in cells {
            for _ in 0..4 {
                b.extend_from_slice(&h.to_le_bytes());
            }
            b.extend_from_slice(&t.to_le_bytes());
        }
        b
    }

    #[test]
    fn reads_size_and_cell_types() {
        let m = read_gat("t", &gat(2, 1, &[(0.0, 1), (0.0, 0)]), RSW_NO_WATER).unwrap();
        assert_eq!((m.xs, m.ys), (2, 1));
        assert_eq!(m.cells, vec![1, 0]);
    }

    /// The rule a cache is silently wrong without: walkable ground above the
    /// water line is water, not land.
    #[test]
    fn walkable_cells_above_the_water_line_become_water() {
        let cells = [(5.0, 0), (-5.0, 0), (5.0, 1)];
        let m = read_gat("t", &gat(3, 1, &cells), 0).unwrap();
        assert_eq!(m.cells, vec![3, 0, 1]);
    }

    #[test]
    fn a_truncated_or_unsigned_gat_is_refused() {
        assert!(read_gat("t", b"nope", RSW_NO_WATER).is_err());
        let mut short = gat(4, 4, &[(0.0, 0)]);
        short.truncate(20);
        assert!(read_gat("t", &short, RSW_NO_WATER).is_err());
    }

    #[test]
    fn rsw_versions_pick_the_right_offset() {
        let mut rsw = vec![0u8; 200];
        rsw[..4].copy_from_slice(b"GRSW");
        rsw[4] = 0x02;
        rsw[5] = 0x05;
        rsw[171..175].copy_from_slice(&42.0f32.to_le_bytes());
        assert_eq!(rsw_water_level(&rsw), 42);
        rsw[5] = 0x02;
        rsw[167..171].copy_from_slice(&7.0f32.to_le_bytes());
        assert_eq!(rsw_water_level(&rsw), 7);
        assert_eq!(rsw_water_level(b"not a map"), RSW_NO_WATER);
    }

    /// The header the map server indexes by. `file_size` counting the header
    /// is the part that is easy to get wrong and impossible to see.
    #[test]
    fn cache_header_counts_itself() {
        let m = Map { name: "mymap".into(), xs: 2, ys: 2, cells: vec![0, 1, 0, 1] };
        let out = write_cache(&[m]);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), out.len() as u32);
        assert_eq!(u16::from_le_bytes(out[4..6].try_into().unwrap()), 1);
        assert_eq!(&out[8..13], b"mymap");
        let len = i32::from_le_bytes(out[24..28].try_into().unwrap()) as usize;
        assert_eq!(out.len(), 8 + 20 + len);
    }

    /// A stored deflate stream is still a deflate stream. Checked by hand
    /// because nothing in this binary can decompress it back.
    #[test]
    fn stored_blocks_are_well_formed() {
        let data: Vec<u8> = (0..70000u32).map(|i| (i % 251) as u8).collect();
        let z = zlib_stored(&data);
        assert_eq!(&z[..2], &[0x78, 0x01]);
        let mut i = 2;
        let mut seen = Vec::new();
        loop {
            let final_block = z[i] & 1 == 1;
            assert_eq!(z[i] & 0b110, 0, "not a stored block");
            let len = u16::from_le_bytes(z[i + 1..i + 3].try_into().unwrap());
            let nlen = u16::from_le_bytes(z[i + 3..i + 5].try_into().unwrap());
            assert_eq!(len, !nlen);
            seen.extend_from_slice(&z[i + 5..i + 5 + len as usize]);
            i += 5 + len as usize;
            if final_block {
                break;
            }
        }
        assert_eq!(seen, data);
        assert_eq!(z.len(), i + 4);
        assert_eq!(u32::from_be_bytes(z[i..i + 4].try_into().unwrap()), adler32(&data));
    }

    #[test]
    fn adler32_matches_the_known_answer() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E60398);
        assert_eq!(adler32(b""), 1);
    }
}
