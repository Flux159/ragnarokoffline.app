# Example: a high-resolution ground texture set

Prontera's field paths at 1024x1024, three textures under the client's own
paths (Korean and all):

| File | What it is |
|---|---|
| `data/texture/필드바닥/prt_흙02.bmp` | the dirt itself |
| `data/texture/필드바닥/prt_초원02.bmp` | grass with a dirt strip down each side: the path's edges |
| `data/texture/필드바닥/prt_초원04.bmp` | grass with a patch of dirt: where a path widens |

A path is more than its dirt tile: the cells along it use "meadow" textures
painted half grass, half dirt. Replacing only the dirt gives a sharp strip
between blurry edges, so the edge textures are part of the set.

The client squeezes every ground texture to 256x256 when it builds a map's
texture atlas. Graphics+ ("High-resolution ground") rebuilds the atlas at
up to four times that when a map has larger textures, capped at
4096x4096 -- so a map with many textures gets 512.

## How the edges were made

Each edge texture keeps its original's shape. A mask of where the
original is dirt (red at least as strong as green, measured on a blurred
copy so specks of yellow in the grass don't count), cleaned and feathered at
256 pixels, then scaled to 1024; the new dirt fills the mask, the
original's grass (scaled up) the rest, with a soft shadow where grass
overhangs the dirt. The grass half is not sharper than before; only the
dirt is.

## Credits

The dirt is [Ground104](https://ambientcg.com/view?id=Ground104) from
ambientCG, CC0 1.0 (public domain), resized to 1024x1024 and tinted to the
original's average colour.
