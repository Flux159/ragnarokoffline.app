# randomizer

**This folder is not a mod.** Every other folder in `examples/mods/` is one you
copy into your mods directory; this one is a *program that writes* one.

```
ro-randomizer --seed 12345
```

That reads the monster table out of the server you are already running,
shuffles it, and writes a complete mod folder — `mod.json`, `db/mob_db.yml`,
`db/mob_avail.yml` and a README naming the seed. Copy that into your mods
directory and restart the server, and every monster in the game is something
else.

It ships with the app as `ro-randomizer`, next to the other binaries in the
runtime directory, so there is nothing to install and no Python:

| | |
|---|---|
| macOS | `~/Library/Application Support/Ragnarok Offline/runtime/bin/ro-randomizer` |
| Windows | `%APPDATA%\Ragnarok Offline\runtime\bin\ro-randomizer.exe` |
| Linux | `~/.local/share/Ragnarok Offline/runtime/bin/ro-randomizer` |

**Start the app first.** The tables are read out of the running server, so the
result always matches the rAthena build you are actually playing.

## What it does

```
$ ro-randomizer --seed 42
reading mob_db.yml (running server) …
seed 42  (pre-renewal)
941 of 1004 monsters changed, across 12 level bands
45 left alone (the emperium, barricades and crystals — they ignore
whole damage types, and anything given their block cannot be killed)
written to randomizer-42
```

Then, in game, asking the server what a Poring is:

```
@mobinfo poring
- <Apple> 10.00%  - <Santa Hat> [0] 1.00%  - <Apple> 0.07%
- <Santa Poring Card> 0.01%  - <Jellopy> 0.01%  - <Jellopy> 0.01% …
```

Poring now has Santa Poring's stats, drops, element and sprite. Every Poring in
the world, on every map, spawned by scripts written years before this existed.

## The idea worth stealing

**A mod cannot remove a stock monster spawn.** Adding is the whole vocabulary
of the `npc/` layer — the ~3,000 spawn lines that populate the world are loaded
before any mod and there is no way to unload them.

So the randomizer does not move a single spawn. Every spawn line names a
monster *ID*, and the ID is just a label on a block of numbers. **Move the
blocks between the IDs and the whole world reshuffles**, with the spawn scripts
untouched and none the wiser.

That is the entire trick, and it is why the tool never interprets a stat. It
lifts an entry's text wholesale, rewrites the two lines that identify it, and
writes it back. Levels, elements, sizes, AI, skills, drops — all of it moves as
one opaque block. `src/yaml.rs` is a 200-line reader for the exact shape
rAthena generates, and it is honest about being that rather than pretending to
be a YAML parser.

## Reading order

| file | what it explains |
|---|---|
| `src/mobs.rs` | The identity-shuffle idea, and the drop trap below. |
| `src/yaml.rs` | Why a shape-reader is the right tool here and a real YAML parser is not. |
| `src/source.rs` | Why the tables are read out of the running container rather than shipped. |
| `src/rng.rs` | Why a seed is a promise, and what that rules out. |

## Three things that were learned the hard way

**`Drops:` is additive.** `db/import` layers over rAthena's table, and a drop
entry without an `Index:` is *appended* to what the monster already dropped —
not swapped for it. Shuffle naively and every monster keeps its own drops plus
its new ones until it hits the cap of ten and the server says
`Maximum of 10 monster Drops met, skipping.` So every drop written here carries
an explicit `Index:`, which overwrites that slot instead.

**`Rate: 0` throws away the whole monster.** There is no way to *delete* a drop
slot from an import, so the obvious way to blank the leftovers is a zero rate.
rAthena refuses it — `Node "Rate" needs to be at least 1` — and because
`asUInt16Rate` failing makes `parseBodyNode` return early, that one zero
discards the entire monster and silently leaves it as it was. The lowest rate
the parser accepts is 1, which is 0.01%: the `<Jellopy> 0.01%` entries in the
output above are those blanked slots. One in ten thousand kills will drop one.
That is the honest cost of a table you may only layer over.

**Some of the table is not monsters.** The emperium, WoE barricades, guild
flags and the four elemental crystals set `Ignore…` modes that turn off whole
damage types. Give Poring the water crystal's block and every Poring in the
game becomes unkillable, which for a new character outside Prontera ends the
run before it starts. Those 45 entries keep their own slots and everything else
shuffles around them. `--include-props` if you want them in anyway.

## Options

```
--seed <seed>     any number or phrase. The same seed always gives the same
                  world; a seed you do not pass is generated, printed, and
                  written into the mod, because "random" and "not written
                  down" are different things.
--band <n>        only let monsters swap within <n> levels (default 10). This
                  keeps the difficulty curve roughly where the map designers
                  left it while changing everything about what you fight.
--chaos           no bands. A Poring outside Prontera can be anything.
--disguise        keep every monster's original name and sprite, so nothing
                  warns you what you just walked into.
--include-props   shuffle the unkillable props too. See above.
--era <era>       renewal | pre-renewal. Defaults to what the app is set to.
--rathena <dir>   read from a source checkout instead of the running server.
--out <dir>       where to write the mod.
```

## The era matters, and the manifest says so

The generated `mod.json` carries `"requires": { "era": "pre-renewal" }` or
`renewal`, whichever it was built from. That is load-bearing: the monster IDs
exist in both eras, so a pre-renewal table applied to a renewal server would
load happily and be quietly wrong. Switch era in Settings and the app refuses
the mod by name instead, with the reason in the mods list.

## Building it yourself

```
cd examples/mods/randomizer
cargo build --release          # target/release/ro-randomizer
cargo test
```

No dependencies, for the same reason `stack/` has none: this ships inside a
signed app bundle, the build has to stay quick on every runner, and there is no
dependency tree to audit.

Do **not** copy this folder into your mods directory — `target/` alone is
hundreds of megabytes, and there is nothing here for the server to read. Copy
the folder it *writes*.

## What it does not do yet

- **Items and skills.** `item_db.yml`, `skill_db.yml` and `skill_tree.yml` are
  all overridable the same way; nothing here shuffles them.
- **Warps.** Entrance shuffling is possible — stock warps are named NPCs
  (`prt01`, `prt001`), `disablenpc` works on them, and a mod warp on the same
  square takes over; this was tested. What it needs before shipping is
  reciprocal pairing, so that shuffling the way *in* to a dungeon also shuffles
  the way *out* and cannot strand you.
- **Any notion of completability.** This is chaos mode, not a seeded
  progression randomizer. RO has very little gating to shuffle in the first
  place, so a "logic" pass would have to invent its own.
