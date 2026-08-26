# Optimised assets — re-encoding textures and baked lightmaps

An idea, not a plan. The premise: RO's assets are encoded the way 2002 encoded
things, and both halves of changing that — an offline transform and the client
that reads it — are things this project already controls. We build
roBrowserLegacy from source with patches, and `link-assets.sh` is already an
asset pipeline.

Everything below is measured from `data.grf` itself, not estimated. Where a
number is a guess it says so.

## Where the bytes actually are

Uncompressed → as stored in the GRF, whole archive:

```
     ext     files   uncompressed       in-GRF    ratio
     bmp    46,583       3,151 MB     1,408 MB     2.2x   <- the target
     gnd       987       3,266 MB       488 MB     6.7x
     spr    39,505       2,006 MB       480 MB     4.2x
     gat       988       1,629 MB       220 MB     7.4x
     act    54,845       2,183 MB       199 MB    11.0x
     tga     7,565         581 MB       185 MB     3.1x

  whole archive: 13.4 GB uncompressed -> 3.4 GB stored (3.9x)
```

**Always reason about the in-GRF column.** The uncompressed figures are what
things cost in memory, not on disk, and quoting them makes every idea here look
about 3× better than it is.

`.bmp` is the biggest thing on disk *and* the worst-compressing — 2.2× against
the archive's 3.9× average. That is the whole reason this document is about
textures first.

---

# Part 1 — textures (the real target)

## What is in there

Sampled 402 of 46,583 `.bmp` files:

- **bit depth**: 185 palettised (8-bit), 217 truecolour (24-bit) — a near-even split
- **common sizes**: 24×24 (item icons), 256×256 (map textures), 75×100 (item
  previews), 128×128, 512×512
- average 67 KB, ~44,000 pixels

## What re-encoding actually buys

Measured on 251 real textures: decode each, re-encode, compare against the
zlib-compressed size the GRF stores today. Positive = smaller than today.

```
=== palette (8-bit) — 105 files ===
  zlib in GRF       3,343 KB   <- today
  PNG               3,348 KB     -0.1%
  WebP lossless     3,114 KB     +6.9%
  BC1               2,548 KB    +23.8%

=== truecolour (24-bit) — 146 files ===
  zlib in GRF       2,217 KB   <- today
  PNG               1,920 KB    +13.4%
  WebP lossless     1,416 KB    +36.1%
  BC1               1,263 KB    +43.0%

=== all 251 ===
  PNG +5.3%   WebP +18.5%   BC1 +31.4%
```

Three things fall out of that, and the split is the important part:

**The palettised half is already near-optimal.** An 8-bit BMP is a palette plus
indices, and zlib on indices is genuinely hard to beat — PNG ties it exactly
(−0.1%), WebP wins 6.9%. There is no meaningful win hiding in half the corpus.
Any estimate that assumes uniform gains across all 46,583 files is wrong.

**PNG is not worth it.** +5.3% overall. It is the obvious first thought and the
measurement kills it.

**WebP lossless is the honest answer**: +18.5% overall, and it is *lossless*, so
the art is bit-identical. Against 1,408 MB that is roughly **260 MB**.

## BC1 is a trap here, and this is the important caveat

BC1 shows the best number (+31.4%) and it is the wrong choice for this content.

It is lossy 4×4 block compression: two RGB565 endpoints per block plus two
interpolated colours, so any block containing more than four distinct colours
gets approximated. RO's textures are *dithered pixel art* and UI chrome with
text — the two things that break block compression worst. Expect visible banding
on gradients and mush on lettering.

BC1's real advantage is elsewhere: it stays compressed **in VRAM**, where zlib
and WebP cannot help, because both decode to full RGBA at load. So the trade is
"smaller memory and fewer bytes uploaded, at a visible quality cost". For this
art style that is a bad trade — but see the lightmaps below, where it is a good
one, because smooth gradients are exactly what BC1 handles well.

**Nothing here should be adopted on these numbers alone.** Encode a
representative set, put it side by side with the original at 1× and 2× zoom, and
look at it. If the art is worse, the bytes do not matter.

## Sketch

1. Offline: walk the user's GRFs, decode each `.bmp`, emit WebP lossless,
   write a sidecar archive next to the linked assets. Never touch their client.
2. Client: teach roBrowser's texture loader to try the sidecar first and fall
   back to the GRF. Same patch workflow as
   `patches/0001-renderer-dedupe-callbacks.patch`, and the fallback means an
   unmodified client still works.
3. Only convert truecolour images. Palettised ones gain 6.9% and cost the same
   transform time — skip them, and the whole job gets faster and safer.

---

# Part 2 — lightmaps

The original version of this document was about these. They are the smaller
prize, but the technique is more interesting.

## The measurement

Sampling 124 of 987 maps, evenly spread rather than the largest:

| section | size | share |
|---|---|---|
| lightmaps | 231 MB | **58.6%** |
| surfaces (UVs, texture + lightmap ids) | 93 MB | 23.6% |
| cubes (the actual terrain mesh) | 70 MB | 17.7% |

The geometry is a sixth of the file. A 200×200 map at 28 bytes per cell is
1.1 MB of mesh. Interiors skew far harder — `schg_dun01.gnd` is 76% lightmap —
because walls and stairs create many more vertical surfaces per cell than open
ground does.

## What is wrong with the encoding

1. **Every surface gets an identical 8×8 lightmap**, whatever its size or
   whether anything happens on it. A blank dungeon floor tile gets exactly as
   much lighting data as an ornate staircase. Modern bakers size charts by area
   and importance.
2. **32 bits per texel, uncompressed** — 1 byte shadow + 3 bytes RGB, and it
   stays that way in memory and on the GPU.
3. **Weak dedup.** 63,854 distinct lightmaps for 98,198 surfaces on
   `schg_dun01` — about a third of the obvious redundancy caught, and only for
   byte-identical tiles.

Baking is not the mistake. Unity and Unreal still bake; precomputed lighting is
still the cheapest good-looking lighting there is. What dates RO is the
encoding — and that is the mechanical part.

## What it would save

Maps cost **488 MB stored**, not 3.3 GB: lightmaps are smooth gradients with
heavy repetition, so zlib already gets 6.7× on them. Much of the theoretical win
has therefore already been taken.

- dedup + flat-tile elision: **guessing** 20–40%, unmeasured
- BC1 on what remains: up to 8× on the lightmap portion, but overlapping heavily
  with what zlib already achieves, so the marginal disk win is much smaller than
  the raw ratio suggests

Call it **150–250 MB**, with wide error bars.

BC1 *is* appropriate here, unlike for textures: lightmaps are smooth low-contrast
gradients, the content block compression was designed for, and they are
multiplied into the scene rather than viewed directly, so small errors are far
less visible.

The runtime win is the more interesting half: less to decompress at load, much
less VRAM, and a per-map atlas instead of thousands of 8×8 tiles means far fewer
texture binds. Faster map loads are something a player notices.

---

# Together

| | stored today | plausible saving |
|---|---|---|
| textures (WebP lossless, truecolour only) | 1,408 MB | ~260 MB (measured) |
| lightmaps (dedup + BC1 + atlas) | 488 MB | ~150–250 MB (estimated) |

Roughly **400–500 MB off a 4.8 GB asset set — about 10%**, for a substantial
amount of work and a permanent divergence from stock roBrowser.

That is the honest headline. It is not a size breakthrough. The better arguments
are the runtime ones (load time, VRAM, texture binds) and the fact that owning
the pipeline opens doors beyond compression.

## Reasons not to

- **It forks the assets.** Today the user brings their own kRO client and we
  link to it read-only, which is what keeps the copyright story clean: we ship
  no Gravity data. A transform produces derived files from their client.
  Probably still fine — it stays on their machine, derived from their own copy —
  but it deserves a real think before any code.
- Transform time and disk on first run, on top of an already slow first launch.
- Every divergence from stock roBrowser is a rebase cost forever.

## If it gets picked up

1. **Textures first.** Bigger, measured, and lossless — no quality argument to
   have. Convert truecolour only.
2. **Look at it before believing any of this.** Especially anything lossy.
3. Then the lightmap dedup-only variant: no format change, no client change, so
   it answers "is there anything here" cheaply.
4. Only then BC1 and atlasing for lightmaps, which need the client patched.

## Reference

- GRF: file table is zlib-compressed, entries are CP949-named, offsets relative
  to the end of the 46-byte header.
- GND: header → texture names → lightmaps (count × w × h × 4B) → surfaces
  (40B each) → cubes (w × h × 28B).
- `.gat` (220 MB stored) is collision and height at double the GND resolution.
  Leave it alone — the map-server reads it too, so touching it is a server
  change as well.
- `.spr`/`.act` (480 + 199 MB) are sprites and animations, already compressing
  4.2× and 11×. Not worth attacking.
