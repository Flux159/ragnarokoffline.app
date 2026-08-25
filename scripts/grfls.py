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
    ("msgstringtable", ("msgstringtable",)),
]


def read_table(path):
    """Return {lowercased path: uncompressed size} for a GRF's file table."""
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

    entries, i = {}, 0
    while i < len(table):
        end = table.index(b"\0", i)
        name = table[i:end]
        i = end + 1
        # 17-byte entry: packed size, aligned size, real size, flags, offset
        _, _, real_size, _, _ = struct.unpack("<IIIBI", table[i:i + 17])
        i += 17
        key = name.decode("cp949", "replace").replace("\\", "/").lower()
        entries[key] = real_size
    return entries, version


def report(path):
    entries, version = read_table(path)
    paths = entries

    print(f"\n{path}")
    print(f"  version {version:#x}, {len(entries):,} entries")

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

    # kRO ships only the Korean msgstring_kr.lub; roBrowser wants msgstringtable.txt.
    if not any("msgstringtable" in p for p in paths) and \
            any("msgstring" in p for p in paths):
        print("    note: has msgstring_kr.lub (Korean) but no msgstringtable.txt")

    maps = sum(1 for p in paths if p.endswith(".rsw"))
    if maps:
        print(f"    {maps:,} playable maps")

    if "maps" in missing:
        print("  -> OVERLAY GRF: no map files. Cannot be used as a base client.")
    elif missing:
        print(f"  -> INCOMPLETE: missing {', '.join(missing)}. "
              "Needs a base GRF beneath it in DATA.INI.")
    else:
        print("  -> looks like a complete base client")
    return entries


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

    # Sharing a path is not the same as being redundant: a renewal or translation
    # GRF deliberately reuses paths to *override* them. Split the two apart so the
    # DATA.INI load order can be chosen on real numbers.
    files = list(seen.items())
    if len(files) > 1:
        print("\npairwise overlap (a shadows b when a is listed first in DATA.INI):")
    for i, (a, ea) in enumerate(files):
        for b, eb in files[i + 1:]:
            shared = set(ea) & set(eb)
            if not shared:
                continue
            overrides = sum(1 for k in shared if ea[k] != eb[k])
            identical = len(shared) - overrides
            print(f"  {a}\n  {b}")
            print(f"    {identical:,} identical, {overrides:,} differing, "
                  f"{len(set(ea) - set(eb)):,} only in the first, "
                  f"{len(set(eb) - set(ea)):,} only in the second")
            if not overrides and len(set(eb) - set(ea)) == 0:
                print("    -> the second adds nothing; it can be dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
