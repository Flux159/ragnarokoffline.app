# Optimised lightmaps — a smaller, faster map format

An idea, not a plan. The premise: RO's map files spend most of their bytes on
baked lighting stored in a 2002-shaped way, and both halves of that — the
offline transform and the client that reads it — are things this project already
controls.

## The measurement that started it

Parsed from `data.grf`'s own file table and GND headers, not estimated. Sampling
124 of 987 maps, evenly spread rather than the largest:

| section | size | share |
|---|---|---|
| lightmaps | 231 MB | **58.6%** |
| surfaces (UVs, texture + lightmap ids) | 93 MB | 23.6% |
| cubes (the actual terrain mesh) | 70 MB | 17.7% |

The geometry is a sixth of the file. A typical map is 200×200 cells; at 28 bytes
per cell that is 1.1 MB of mesh. Interiors skew much harder — `schg_dun01.gnd`
is 76% lightmap — because walls and stairs create far more vertical surfaces per
cell than open ground does.

Whole-archive context, uncompressed → as stored in the GRF:

```
     ext     files   uncompressed       in-GRF    ratio
     bmp    46,583       3,151 MB     1,408 MB     2.2x
     gnd       987       3,266 MB       488 MB     6.7x
     spr    39,505       2,006 MB       480 MB     4.2x
     gat       988       1,629 MB       220 MB     7.4x

  whole archive: 13.4 GB uncompressed -> 3.4 GB stored (3.9x)
```

**Read that ratio column before getting excited.** Lightmaps are smooth
gradients with heavy repetition, so zlib already recovers most of the waste:
maps cost 488 MB on disk, not 3.3 GB. Any honest accounting of this idea is
against 488 MB, not against the uncompressed figure.

## What is actually wrong with the format

Three things, in descending order of how much they cost:

1. **Every surface gets an identical 8×8 lightmap**, whatever its size or
   whether anything interesting happens on it. A blank dungeon floor tile gets
   exactly as much lighting data as an ornate staircase. Modern bakers size
   charts by area and importance.
2. **32 bits per texel, uncompressed** — 1 byte shadow + 3 bytes RGB. It stays
   that way in memory and on the GPU, where zlib cannot help. BC1 is 4 bits per
   texel: 8× smaller, and it stays compressed in VRAM.
3. **Weak dedup.** 63,854 distinct lightmaps for 98,198 surfaces on
   `schg_dun01` — only about a third of the obvious redundancy is caught, and
   only for byte-identical tiles.

Baking itself is not the mistake. Unity and Unreal still bake, and precomputed
lighting is still the cheapest good-looking lighting there is. What dates RO is
the encoding, and the encoding is exactly the part that is mechanical to change.

## The shape of the thing

Two halves, and they are independent enough to do in either order:

**Offline transform** — read `.gnd`, rewrite it. The GND parser already exists in
roBrowserLegacy (`src/Loaders/Ground.js`), so the reader is a port, not a design
problem. Candidates, cheapest first:

- **Stronger dedup.** Hash lightmaps and share by content, including a
  near-match pass with a small error tolerance. No format change on the client
  at all if the id table stays the same shape — this one is pure win and could
  ship alone.
- **Drop constant tiles.** A lightmap that is a single flat colour needs 4
  bytes, not 256. Give the surface record a "flat" flag and a colour.
- **BC1/BC4 the rest.** WebGL2 has `EXT_texture_compression_rgtc` and
  `WEBGL_compressed_texture_s3tc`; WebGPU has BC natively. Falls back to
  decompressing on load where unsupported, which is still a smaller download.
- **Per-map atlas** instead of thousands of 8×8 tiles, which is also a real
  runtime win — fewer texture binds and better cache behaviour.

**Client side** — teach roBrowserLegacy to read the new form. It is GPL-3.0 and
we already build it from source with patches, so this is the same workflow as
`patches/0001-renderer-dedupe-callbacks.patch`, just bigger. Keep the loader
version-tagged and fall back to stock GND, so an unmodified client still works
and we are never locked to our own assets.

## What it would actually save

Against the 488 MB the maps really occupy:

- dedup + flat-tile elision: guessing 20–40%, and it is a *guess* until measured
- BC1 on what remains: up to 8× on the lightmap portion, but much of that
  overlaps with what zlib was already getting, so the marginal disk win is
  smaller than the raw ratio suggests

Best case is maybe 150–250 MB off a 4.8 GB asset set — **about 4%.** That is the
honest headline, and it is not compelling on its own.

The runtime win is more interesting than the disk win: less to decompress at
load, far less VRAM (compressed textures stay compressed on the GPU), fewer
binds per frame. Faster map loads are a thing a player actually notices; 200 MB
off a 4.8 GB download is not.

## Why it might still be worth doing

- **`.bmp` is the bigger target.** 1,408 MB stored, compressing only 2.2×
  because it is already-dithered pixel art. Converting textures to a modern
  format is a larger win than anything in this document, and the same
  offline-transform + patched-loader machinery serves both. If this idea gets
  built, build that machinery first and point it at textures.
- It is the natural next step after "our own client": we already patch
  roBrowser and ship our own asset pipeline in `link-assets.sh`.
- Custom assets open the door to things beyond size — higher-density lighting
  where it matters, or per-map ambient tweaks.

## Why it might not

- **It forks the assets.** Today a user brings their own kRO client and we link
  to it read-only, which is what keeps the copyright story clean: we ship no
  Gravity data. A transform step means generating derived files from their
  client. Probably still fine — it stays on their machine, derived from their
  own copy — but it deserves a real think before any code.
- Transform time and disk on first run, on top of an already slow first launch.
- Every divergence from stock roBrowser is a rebase cost forever.

## If it gets picked up

1. Measure first: dump per-map lightmap dedup potential across all 987 maps.
   The 124-map sample says 58.6% lightmap; get the real number and the real
   near-duplicate rate before writing a transform.
2. Prototype the dedup-only variant. It needs no format change and no client
   change, so it answers "is there anything here" for a day's work.
3. Only then decide about BC1 and atlasing, which need the client patched.

## Related

- `data.grf` parsing: the GRF file table is zlib-compressed, entries are
  CP949-named, offsets are relative to the end of the 46-byte header.
- GND layout: header → texture names → lightmaps (count × w × h × 4B) →
  surfaces (40B each) → cubes (w × h × 28B).
- `.gat` (1.6 GB uncompressed, 220 MB stored) is collision and height at double
  the GND resolution. Untouchable — the map-server reads it too, so any change
  there is a server change as well.
