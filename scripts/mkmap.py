#!/usr/bin/env python3
"""Generate a playable Ragnarok map from nothing: .gat, .gnd, .rsw and a texture.

    scripts/mkmap.py my_island --out path/to/my-mod/data

A map is three files and the client and the server read different ones:

    .gat   walkability, one cell per tile          -- server and client
    .gnd   the ground mesh, half the .gat's size   -- client only
    .rsw   the world: which .gnd and .gat, water, light, objects -- both
           (the server reads only the water level out of it)

Nothing here is copied out of a GRF, which is the point: the output is yours,
it can ship in a public repository, and it is a floor you can stand on rather
than a finished landscape. Real maps are built in Gravity's browser edit tools
or in one of the community map editors; this is for the case where you want a
map to exist so you can put something on it.

The geometry is flat, walkable, and walled at the border. What varies is size.

    --cells N        the map is N x N ground cells; the walkable grid is 2N x 2N
    --texture FILE   use this .bmp instead of generating one
    --water LEVEL    water height; the default, 1e6, means no water at all
    --no-wall        do not make the outermost ring unwalkable

Written against the parsers that actually read these files: rAthena's
src/tool/mapcache.cpp and src/common/grfio.cpp, and roBrowser's
src/Loaders/Ground.js and src/Loaders/World.js.
"""

import argparse
import os
import struct
import sys

# rAthena's "this map has no water" sentinel (src/common/grfio.hpp).
NO_WATER = 1000000.0

# Cell types, as the server reads them (src/map/map.cpp, map_gat2cell).
WALKABLE = 0
WALL = 1


def write_gat(path, cells_w, cells_h, wall_border):
    """Walkability. One 20-byte record per cell: four corner heights, then type."""
    out = bytearray(b"GRAT" + bytes([1, 2]) + struct.pack("<II", cells_w, cells_h))
    flat = struct.pack("<ffff", 0.0, 0.0, 0.0, 0.0)
    walkable = flat + struct.pack("<I", WALKABLE)
    wall = flat + struct.pack("<I", WALL)
    for y in range(cells_h):
        for x in range(cells_w):
            edge = x == 0 or y == 0 or x == cells_w - 1 or y == cells_h - 1
            out += wall if (edge and wall_border) else walkable
    _write(path, out)


def write_gnd(path, width, height, texture_name):
    """The ground mesh: one square per cell, all flat, all the same texture.

    Version 1.7, which is what the stock maps are and which has no water block
    of its own -- the water in a 1.7 map comes from the .rsw.
    """
    out = bytearray(b"GRGN" + bytes([1, 7]))
    # zoom 10.0 is the stock value; it scales the mesh, not the coordinates.
    out += struct.pack("<IIf", width, height, 10.0)

    # Textures: a count, a fixed record length, then that many padded names.
    # Paths are relative to data/texture/ and use backslashes, because that is
    # what the client prepends and how the GRF spells a directory.
    name = texture_name.encode("latin-1")
    if len(name) >= 80:
        sys.exit(f"texture path is too long for the .gnd format: {texture_name}")
    out += struct.pack("<II", 1, 80)
    out += name + b"\0" * (80 - len(name))

    # Lightmaps: one 8x8 cell, reused by every tile. The map has no objects, so
    # it has nothing to cast a shadow and nothing to tint the ground.
    #
    # A cell is 256 bytes in two halves, and they are not the same thing:
    # 64 bytes of shadow first, then 64 RGB triples of *coloured light* that
    # the ground shader adds on top of the texture. Filling the whole cell with
    # 0xff -- the obvious thing -- adds full white light to every pixel and
    # renders the map as a flat white sheet with the texture washed out of it.
    # No shadow is 0xff; no extra light is 0x00.
    out += struct.pack("<iiii", 1, 8, 8, 1)
    out += b"\xff" * 64 + b"\x00" * 192

    # One tile, reused by every cell: the texture's four corners, in the order
    # Ground.js reads them (u1v1 is the cell's near corner, u4v4 the far one).
    out += struct.pack("<I", 1)
    out += struct.pack("<8f", 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0)
    out += struct.pack("<HH", 0, 0)  # texture index, lightmap index
    out += bytes([255, 255, 255, 255])  # colour, unshaded

    # Surfaces: four corner heights, then the tile used by the top, the front
    # face and the right face. -1 means "no face here", which is what a flat
    # map wants -- a front or right face on level ground is a wall standing on
    # nothing.
    surface = struct.pack("<ffffiii", 0.0, 0.0, 0.0, 0.0, 0, -1, -1)
    out += surface * (width * height)
    _write(path, out)


def write_rsw(path, name, water_level):
    """The world file. Version 2.1: the version the stock maps use, and the one
    whose water level sits where rAthena expects to find it.

    rAthena reads exactly one thing out of this file -- the water level, at a
    byte offset that moves with the version (src/common/grfio.cpp). 2.1 puts it
    at 166, which is what `grfio_read_rsw_water_level` reads for anything below
    2.02. Bump the version without moving the field and every walkable cell
    below the water line silently stays dry land.
    """
    out = bytearray(b"GRSW" + bytes([2, 1]))
    for f in ("", f"{name}.gnd", f"{name}.gat", ""):
        b = f.encode("latin-1")
        out += b + b"\0" * (40 - len(b))
    # Water. The loaders divide the stored level by 5, so multiply going in.
    out += struct.pack("<f", water_level * 5)
    out += struct.pack("<i", 0)  # type
    out += struct.pack("<fff", 1.0 * 5, 2.0, 50.0)  # wave height, speed, pitch
    out += struct.pack("<i", 3)  # animation speed
    # Light: a sun 45 degrees up, warm-white, with enough ambient that a map
    # with no lightmaps is not black.
    out += struct.pack("<ii", 45, 45)
    out += struct.pack("<fff", 1.0, 1.0, 1.0)  # diffuse
    out += struct.pack("<fff", 0.3, 0.3, 0.3)  # ambient
    out += struct.pack("<f", 1.0)  # opacity
    # Frustum-culling bounds, in the units the stock maps use.
    out += struct.pack("<iiii", -500, 500, -500, 500)
    # No models, lights, sounds or effects. The quadtree that would follow is
    # never read.
    out += struct.pack("<i", 0)
    _write(path, out)


# The client's interface directory, as it is actually spelled on disk.
#
# These are the CP949 bytes of 유저인터페이스 ("user interface"), which every
# tool in the chain passes around as Latin-1 and which therefore reach the
# filesystem as this. Do not "fix" it to the Korean: the client asks for these
# bytes, and a directory named in Korean is a directory it never looks in.
INTERFACE_DIR = "\xc0\xaf\xc0\xfa\xc0\xce\xc5\xcd\xc6\xe4\xc0\xcc\xbd\xba"


def write_minimap(path, cells, size=128):
    """The picture the minimap window draws.

    Without it the client asks for it once, gets a 404, and shows an empty
    frame -- harmless, and the first thing anyone notices about a new map.
    A plain outline is enough to say "this map is square and you are on it".
    """
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            edge = x < 3 or y < 3 or x >= size - 3 or y >= size - 3
            row += bytes([90, 70, 45] if edge else [70, 130, 70])  # BGR
        row += b"\0" * ((-len(row)) % 4)
        rows.append(bytes(row))
    pixels = b"".join(reversed(rows))
    header = b"BM" + struct.pack("<IHHI", 14 + 40 + len(pixels), 0, 0, 14 + 40)
    info = struct.pack("<IiiHHIIiiII", 40, size, size, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    _write(path, header + info + pixels)


def write_bmp(path, size=256):
    """A 24-bit BMP: grass, near enough, with enough variation that the tiling
    reads as ground rather than as one flat colour."""
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Cheap deterministic noise -- no dependency, and the same picture
            # on every machine.
            n = ((x * 73856093) ^ (y * 19349663) ^ ((x >> 3) * (y >> 3) * 83492791)) & 0x1F
            g = 96 + n * 2
            r = 46 + n
            b = 40 + (n >> 1)
            row += bytes([b, g, r])  # BMP stores BGR
        # Rows are padded to a multiple of four bytes.
        row += b"\0" * ((-len(row)) % 4)
        rows.append(bytes(row))
    pixels = b"".join(reversed(rows))  # bottom-up
    header = b"BM" + struct.pack("<IHHI", 14 + 40 + len(pixels), 0, 0, 14 + 40)
    info = struct.pack("<IiiHHIIiiII", 40, size, size, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    _write(path, header + info + pixels)


def _write(path, data):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    print(f"  {path}  ({len(data):,} bytes)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="map name; at most 11 characters, as rAthena stores it")
    ap.add_argument("--out", default="data", help="the mod's data/ directory")
    ap.add_argument("--cells", type=int, default=40,
                    help="ground cells per side; the walkable grid is twice this (default 40)")
    ap.add_argument("--texture", help="a .bmp to use instead of the generated one")
    ap.add_argument("--water", type=float, default=NO_WATER, help="water level (default: none)")
    ap.add_argument("--no-wall", action="store_true", help="leave the border walkable")
    a = ap.parse_args(argv)

    # 11 characters plus a terminator is all rAthena stores (MAP_NAME_LENGTH),
    # and a name that is too long is truncated silently at three different
    # layers before anything complains.
    if len(a.name) > 11:
        sys.exit(f"'{a.name}' is {len(a.name)} characters; rAthena map names are at most 11")
    if a.cells < 2:
        sys.exit("--cells must be at least 2")

    data = a.out
    if a.texture:
        texture_name = a.texture
    else:
        texture_name = f"{a.name}\\ground.bmp"
        write_bmp(os.path.join(data, "texture", a.name, "ground.bmp"))

    write_minimap(os.path.join(data, "texture", INTERFACE_DIR, "map", f"{a.name}.bmp"), a.cells)

    print(f"{a.name}: {a.cells * 2}x{a.cells * 2} walkable cells")
    write_gat(os.path.join(data, f"{a.name}.gat"), a.cells * 2, a.cells * 2, not a.no_wall)
    write_gnd(os.path.join(data, f"{a.name}.gnd"), a.cells, a.cells, texture_name)
    write_rsw(os.path.join(data, f"{a.name}.rsw"), a.name, a.water)
    mid = a.cells  # the centre, in walkable cells
    print(f"\nWalk in with:  warp  <from>,x,y,0\tTo {a.name}\t2,2,{a.name},{mid},{mid}")


if __name__ == "__main__":
    main()
