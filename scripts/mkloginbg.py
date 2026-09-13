#!/usr/bin/env python3
"""Cut one picture into the twelve tiles the client draws as its login screen.

    scripts/mkloginbg.py my-art.png --out path/to/my-mod/data

The client does not use a single login background. For packet versions from
2018-11-14 up to 2022-12-07 -- which is the range this app ships in -- it draws
a **4 x 3 grid of twelve separate images**, each stretched to a quarter of the
window's width and a third of its height (`UI/Background.js`,
`getLoginBackgroundName`). Replacing "the login background" means replacing all
twelve, in the right order, under the client's own mojibake names:

    data/texture/<interface>/t_<bg>1-1.bmp   ... 1-4    top row, left to right
    data/texture/<interface>/t_<bg>2-1.bmp   ... 2-4    middle row
    data/texture/<interface>/t_<bg>3-1.bmp   ... 3-4    bottom row

Two things about those names are worth knowing before you type any of it by
hand:

- The directory is `유저인터페이스` and the prefix is `t_배경`, but they are
  stored as CP949 bytes that every tool in the chain treats as Latin-1. On disk
  and in a URL they look like `À¯ÀúÀÎÅÍÆäÀÌ½º` and `t_¹è°æ`. Copy them, do not
  retype them.
- The extension is `.bmp` and the contents do not have to be. The browser
  decodes by content, so these are written as JPEG, which is the difference
  between a 230 KB mod and a 2.4 MB one.

The login form sits low and centre, so leave the middle-bottom of your art
uncluttered and put a wordmark high.
"""

import argparse
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("this needs Pillow:  python3 -m pip install pillow")

# CP949 read as Latin-1, which is how these reach the filesystem. See above.
INTERFACE_DIR = "\xc0\xaf\xc0\xfa\xc0\xce\xc5\xcd\xc6\xe4\xc0\xcc\xbd\xba"
TILE_PREFIX = "t_\xb9\xe8\xb0\xe6"

COLS, ROWS, TILE = 4, 3, 256


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", help="any image Pillow can open; 4:3 art fits best")
    ap.add_argument("--out", default="data", help="the mod's data/ directory")
    ap.add_argument("--quality", type=int, default=88, help="JPEG quality (default 88)")
    ap.add_argument("--bmp", action="store_true",
                    help="write real BMPs instead of JPEG-in-.bmp (about ten times larger)")
    a = ap.parse_args(argv)

    out = os.path.join(a.out, "texture", INTERFACE_DIR)
    os.makedirs(out, exist_ok=True)

    # Resized rather than cropped: the client stretches each tile to its cell
    # regardless, so preserving the aspect ratio here would only move the
    # distortion somewhere less predictable.
    im = Image.open(a.image).convert("RGB").resize((COLS * TILE, ROWS * TILE), Image.LANCZOS)

    total = 0
    for row in range(ROWS):
        for col in range(COLS):
            tile = im.crop((col * TILE, row * TILE, (col + 1) * TILE, (row + 1) * TILE))
            path = os.path.join(out, f"{TILE_PREFIX}{row + 1}-{col + 1}.bmp")
            if a.bmp:
                tile.save(path, "BMP")
            else:
                tile.save(path, "JPEG", quality=a.quality)
            total += os.path.getsize(path)
    print(f"12 tiles written to {out}  ({total // 1024} KB total)")

    # The two other login backgrounds the same code path can ask for, so the
    # mod still works if the app's packet version ever moves either side of the
    # window that uses tiles.
    im.save(os.path.join(out, "t_login.jpg"), "JPEG", quality=a.quality)
    im.save(os.path.join(out, "bgi_temp.bmp"), "JPEG", quality=a.quality)
    print("also wrote t_login.jpg and bgi_temp.bmp for other packet versions")


if __name__ == "__main__":
    main()
