#!/usr/bin/env python3
"""Inspect a GRF archive and report whether it is a playable client or an overlay.

    scripts/grfls.py /path/to/data.grf [more.grf ...]

Reads only the compressed file table (a few MB), never the file bodies, so it is
fast even on multi-gigabyte archives. The same checks run on first launch so the
app can explain a missing-asset failure instead of hanging on a black screen.
"""
import collections
import struct
import sys
import zlib

# Directories/extensions a client needs to render a world at all.
ESSENTIAL = [
    ("maps", (".rsw", ".gnd", ".gat")),
    ("models", (".rsm",)),
    ("sprites", (".spr", ".act")),
    ("palettes", ("data/palette",)),
    ("lua tables", ("luafiles", "iteminfo")),
    ("strings", ("msgstringtable",)),
]


def read_table(path):
    """Return the list of raw (cp949) entry names in a GRF's file table."""
    with open(path, "rb") as f:
        header = f.read(46)
        if header[:15] != b"Master of Magic":
            raise ValueError(f"{path}: not a GRF (bad signature)")
        table_offset, seed, count, version = struct.unpack("<IIII", header[30:46])
        if version not in (0x200, 0x300):
            raise ValueError(f"{path}: GRF version {version:#x} unsupported "
                             "(RemoteClient-JS needs 0x200 or 0x300, undecrypted)")
        f.seek(table_offset + 46)
        packed, unpacked = struct.unpack("<II", f.read(8))
        table = zlib.decompress(f.read(packed))
    if len(table) != unpacked:
        raise ValueError(f"{path}: file table truncated")

    names, i = [], 0
    while i < len(table):
        end = table.index(b"\0", i)
        names.append(table[i:end])
        i = end + 1 + 17  # 17-byte entry struct follows each name
    return names, version


def report(path):
    names, version = read_table(path)
    paths = [n.decode("cp949", "replace").replace("\\", "/").lower() for n in names]

    print(f"\n{path}")
    print(f"  version {version:#x}, {len(names):,} entries")

    dirs = collections.Counter("/".join(p.split("/")[:2]) for p in paths)
    print("  top directories:")
    for name, n in dirs.most_common(8):
        print(f"    {n:9,}  {name}")

    print("  essential content:")
    missing = []
    for label, patterns in ESSENTIAL:
        n = sum(1 for p in paths if any(pat in p for pat in patterns))
        print(f"    {'ok ' if n else 'MISSING'} {label:<12} {n:>9,}")
        if not n:
            missing.append(label)

    if "maps" in missing:
        print("  -> OVERLAY GRF: no map files. Cannot be used as a base client.")
    elif missing:
        print(f"  -> INCOMPLETE: missing {', '.join(missing)}. "
              "Needs a base GRF beneath it in DATA.INI.")
    else:
        print("  -> looks like a complete base client")
    return set(paths)


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    seen = {}
    for path in argv:
        try:
            seen[path] = report(path)
        except (OSError, ValueError) as exc:
            print(f"\n{path}\n  error: {exc}")

    # Overlapping archives waste cache and index space for nothing.
    files = list(seen.items())
    for i, (a, pa) in enumerate(files):
        for b, pb in files[i + 1:]:
            shared = len(pa & pb)
            if shared and shared >= 0.9 * min(len(pa), len(pb)):
                smaller = a if len(pa) < len(pb) else b
                print(f"\nnote: {a} and {b} share {shared:,} paths "
                      f"({shared / min(len(pa), len(pb)):.0%} of the smaller); "
                      f"{smaller} is nearly redundant")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
